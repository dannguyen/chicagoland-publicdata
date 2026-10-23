import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHICAGO, COOK, ILLINOIS, catalog, catalogResult, run, unmatched, workdir,
} from "./helpers/fixtures.mjs";

const API_HOST = "api.us.socrata.com";
const API_PATH = "/api/catalog/v1";

const page = (domain, offset, results, resultSetSize) => ({
  host: API_HOST,
  path: API_PATH,
  query: { domains: domain, offset: String(offset) },
  responses: [{ body: { resultSetSize, results } }],
});

const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);

test("pages through the Discovery API and dedups results by id", (t) => {
  const w = workdir(t);
  const first = ids("aaaa", 1000).map((id) => catalogResult(id));
  // Second page repeats one id from the first, as Discovery paging sometimes does.
  const second = [catalogResult("aaaa-0999"), catalogResult("bbbb-0000")];

  const res = run(w, "fetch-catalogs.mjs", {
    args: [CHICAGO],
    routes: [page(CHICAGO, 0, first, 1001), page(CHICAGO, 1000, second, 1001)],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);

  const urls = res.requests.map((r) => new URL(r.url));
  assert.deepEqual(urls.map((u) => u.searchParams.get("offset")), ["0", "1000"]);
  for (const u of urls) {
    assert.equal(u.searchParams.get("search_context"), CHICAGO);
    assert.equal(u.searchParams.get("only"), "dataset");
    assert.equal(u.searchParams.get("limit"), "1000");
  }

  const out = w.json(`data/cached/catalogs/${CHICAGO}.json`);
  assert.equal(out.domain, CHICAGO);
  assert.equal(out.resultSetSize, 1001);
  assert.equal(out.results.length, 1001);
  assert.equal(new Set(out.results.map((r) => r.resource.id)).size, 1001);
  assert.ok(!Number.isNaN(Date.parse(out.fetched_at)));
});

test("fetches all three portals when no domain is given", (t) => {
  const w = workdir(t);
  const res = run(w, "fetch-catalogs.mjs", {
    routes: [CHICAGO, COOK, ILLINOIS].map((d) => page(d, 0, [catalogResult(`${d.slice(0, 4)}-0001`)], 1)),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);
  for (const d of [CHICAGO, COOK, ILLINOIS]) {
    assert.equal(w.json(`data/cached/catalogs/${d}.json`).results.length, 1);
  }
});

test("an HTTP error exits non-zero and keeps the previous catalog", (t) => {
  const previous = JSON.stringify(catalog(CHICAGO, [catalogResult("keep-0001")]));
  const w = workdir(t, { catalogs: { [CHICAGO]: previous } });

  const res = run(w, "fetch-catalogs.mjs", {
    args: [CHICAGO],
    routes: [{ host: API_HOST, path: API_PATH, responses: [{ status: 500 }] }],
  });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /HTTP 500/);
  assert.equal(w.read(`data/cached/catalogs/${CHICAGO}.json`), previous);
});

// The API reporting zero datasets is self-consistent, so it's written; build.mjs's
// shrink guard is what keeps it from reaching datasets.json.
test("an empty catalog that reports resultSetSize 0 is written", (t) => {
  const w = workdir(t);
  const res = run(w, "fetch-catalogs.mjs", { args: [CHICAGO], routes: [page(CHICAGO, 0, [], 0)] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(w.json(`data/cached/catalogs/${CHICAGO}.json`).results, []);
});

test("fails and keeps the previous catalog when results fall short of resultSetSize", (t) => {
  const previous = JSON.stringify(catalog(CHICAGO, [catalogResult("keep-0001")]));
  const w = workdir(t, { catalogs: { [CHICAGO]: previous } });
  const res = run(w, "fetch-catalogs.mjs", {
    args: [CHICAGO],
    routes: [page(CHICAGO, 0, [catalogResult("aaaa-0001")], 900)],
  });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /got 1 unique datasets, expected resultSetSize 900/);
  assert.equal(w.read(`data/cached/catalogs/${CHICAGO}.json`), previous);
});

test("an empty page partway through paging fails the fetch", (t) => {
  const w = workdir(t);
  const first = ids("aaaa", 1000).map((id) => catalogResult(id));
  const res = run(w, "fetch-catalogs.mjs", {
    args: [CHICAGO],
    routes: [page(CHICAGO, 0, first, 1500), page(CHICAGO, 1000, [], 1500)],
  });
  assert.notEqual(res.code, 0);
  assert.equal(w.exists(`data/cached/catalogs/${CHICAGO}.json`), false);
});
