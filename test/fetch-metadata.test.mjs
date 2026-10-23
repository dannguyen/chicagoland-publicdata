import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHICAGO, COOK, T1, T2, cachedMeta, catalog, catalogResult, epoch, run, unmatched, view,
  viewRoute, workdir,
} from "./helpers/fixtures.mjs";

const metaFile = (domain, id) => `data/cached/metadata/${domain}/${id}.json`;
const fetchedIds = (res) =>
  res.requests.map((r) => new URL(r.url).pathname.match(/\/api\/views\/(.+)\.json$/)?.[1]).filter(Boolean).sort();
// Retry quickly: fetch-metadata sleeps for Retry-After seconds between attempts.
const retryAfter = { "retry-after": "0.001" };

test("fetches uncached datasets and writes trimmed metadata", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001")]) } });
  const res = run(w, "fetch-metadata.mjs", {
    routes: [viewRoute(CHICAGO, "aaaa-0001", {
      body: view("aaaa-0001", {
        rowIdentifierColumnId: 123,
        tags: ["crime"],
        category: "Public Safety",
        license: { name: "Public Domain" },
        metadata: { rowLabel: "Crime", custom_fields: { Metadata: { Frequency: "Daily" } } },
      }),
    })],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);

  const { fetchedAt, ...meta } = w.json(metaFile(CHICAGO, "aaaa-0001"));
  assert.ok(!Number.isNaN(Date.parse(fetchedAt)));
  assert.deepEqual(meta, {
    id: "aaaa-0001",
    name: "Dataset aaaa-0001",
    assetType: "dataset",
    viewType: "tabular",
    displayType: "table",
    rowCount: 10,
    rowCountSource: "cached",
    rowLabel: "Crime",
    hasRowIdentifier: true,
    createdAt: null,
    publicationDate: null,
    rowsUpdatedAt: epoch(T1),
    viewLastModified: null,
    viewCount: null,
    downloadCount: null,
    category: "Public Safety",
    tags: ["crime"],
    attribution: null,
    attributionLink: null,
    licenseId: null,
    license: "Public Domain",
    provenance: null,
    publicationStage: null,
    newBackend: null,
    customFields: { Metadata: { Frequency: "Daily" } },
    columns: [{
      name: "A", fieldName: "a", dataTypeName: "text", description: null, nullCount: 1, cardinality: 4,
    }],
  });
});

test("skips datasets whose cached rowsUpdatedAt matches the catalog", (t) => {
  const w = workdir(t, {
    catalogs: { [CHICAGO]: catalog(CHICAGO, [
      catalogResult("same-0001"),
      catalogResult("chng-0001", { resource: { data_updated_at: T2 } }),
      catalogResult("nrow-0001"),
    ]) },
    metadata: { [CHICAGO]: {
      "same-0001": cachedMeta("same-0001"),
      "chng-0001": cachedMeta("chng-0001"),
      // Same timestamp but no row count: refetched in case the count is now available.
      "nrow-0001": cachedMeta("nrow-0001", { rowCount: null }),
    } },
  });
  const unchanged = w.read(metaFile(CHICAGO, "same-0001"));

  const res = run(w, "fetch-metadata.mjs", {
    routes: [
      viewRoute(CHICAGO, "chng-0001", { body: view("chng-0001", { rowsUpdatedAt: epoch(T2) }) }),
      viewRoute(CHICAGO, "nrow-0001", { body: view("nrow-0001") }),
    ],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);
  assert.deepEqual(fetchedIds(res), ["chng-0001", "nrow-0001"]);
  assert.match(res.stderr, /fetched=2 skipped=1 missing=0 failed=0/);
  assert.equal(w.read(metaFile(CHICAGO, "same-0001")), unchanged);
  assert.equal(w.json(metaFile(CHICAGO, "chng-0001")).rowsUpdatedAt, epoch(T2));
});

test("refetches a corrupt cache file", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001")]) } });
  w.write(metaFile(CHICAGO, "aaaa-0001"), '{"id": "aaaa-0001", "rowCo');

  const res = run(w, "fetch-metadata.mjs", {
    routes: [viewRoute(CHICAGO, "aaaa-0001", { body: view("aaaa-0001") })],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(w.json(metaFile(CHICAGO, "aaaa-0001")).rowCount, 10);
});

test("falls back to a count(*) query when the view has no cached counts", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("big0-0001")]) } });
  const res = run(w, "fetch-metadata.mjs", {
    routes: [
      viewRoute(CHICAGO, "big0-0001", {
        body: view("big0-0001", { columns: [{ name: "A", fieldName: "a", dataTypeName: "text" }] }),
      }),
      { host: CHICAGO, path: "/resource/big0-0001.json", query: { $select: "count(*)" },
        responses: [{ body: [{ count: "123456789" }] }] },
    ],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);
  const meta = w.json(metaFile(CHICAGO, "big0-0001"));
  assert.equal(meta.rowCount, 123456789);
  assert.equal(meta.rowCountSource, "query");
  assert.deepEqual(meta.columns, [{
    name: "A", fieldName: "a", dataTypeName: "text", description: null, nullCount: null, cardinality: null,
  }]);
});

test("a 404 or 403 is counted as missing and writes no file", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [
    catalogResult("gone-0404"), catalogResult("priv-0403"),
  ]) } });
  const res = run(w, "fetch-metadata.mjs", {
    routes: [
      viewRoute(CHICAGO, "gone-0404", { status: 404 }),
      viewRoute(CHICAGO, "priv-0403", { status: 403 }),
    ],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /fetched=0 skipped=0 missing=2 failed=0/);
  assert.equal(w.exists(metaFile(CHICAGO, "gone-0404")), false);
  assert.equal(w.exists(metaFile(CHICAGO, "priv-0403")), false);
});

test("retries 429 and 5xx responses, then succeeds", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001")]) } });
  const res = run(w, "fetch-metadata.mjs", {
    routes: [viewRoute(CHICAGO, "aaaa-0001",
      { status: 429, headers: retryAfter },
      { status: 503, headers: retryAfter },
      { body: view("aaaa-0001") },
    )],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.requests.length, 3);
  assert.match(res.stderr, /fetched=1 skipped=0 missing=0 failed=0/);
});

test("exhausted retries count as failed but still exit 0 (current behavior)", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001")]) } });
  const res = run(w, "fetch-metadata.mjs", {
    routes: [viewRoute(CHICAGO, "aaaa-0001", { status: 500, headers: retryAfter })],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.requests.length, 5, "first attempt plus 4 retries");
  assert.match(res.stderr, /FAILED data\.cityofchicago\.org\/aaaa-0001: HTTP 500/);
  assert.match(res.stderr, /fetched=0 skipped=0 missing=0 failed=1/);
  assert.equal(w.exists(metaFile(CHICAGO, "aaaa-0001")), false);
});

test("a non-retryable 4xx fails immediately", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001")]) } });
  const res = run(w, "fetch-metadata.mjs", {
    routes: [viewRoute(CHICAGO, "aaaa-0001", { status: 400 })],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.requests.length, 1);
  assert.match(res.stderr, /failed=1/);
});

test("sends X-App-Token only when SOCRATA_APP_TOKEN is set", (t) => {
  const routes = [viewRoute(CHICAGO, "aaaa-0001", { body: view("aaaa-0001") })];
  const fixture = { catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001")]) } };

  const withToken = run(workdir(t, fixture), "fetch-metadata.mjs",
    { routes, env: { SOCRATA_APP_TOKEN: "test-token" } });
  assert.equal(withToken.code, 0, withToken.stderr);
  assert.equal(withToken.requests[0].headers["x-app-token"], "test-token");
  assert.match(withToken.stderr, /app-token=yes/);

  const without = run(workdir(t, fixture), "fetch-metadata.mjs", { routes });
  assert.equal(without.code, 0, without.stderr);
  assert.equal(without.requests[0].headers["x-app-token"], undefined);
  assert.match(without.stderr, /app-token=no/);
});

test("only processes dataset resources", (t) => {
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [
    catalogResult("aaaa-0001"),
    catalogResult("map0-0001", { resource: { type: "map" } }),
  ]) } });
  const res = run(w, "fetch-metadata.mjs", {
    routes: [viewRoute(CHICAGO, "aaaa-0001", { body: view("aaaa-0001") })],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);
  assert.deepEqual(fetchedIds(res), ["aaaa-0001"]);
});

test("--force refetches everything, even when the cache is current", (t) => {
  const w = workdir(t, {
    catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001"), catalogResult("aaaa-0002")]) },
    metadata: { [CHICAGO]: { "aaaa-0001": cachedMeta("aaaa-0001"), "aaaa-0002": cachedMeta("aaaa-0002") } },
  });
  const res = run(w, "fetch-metadata.mjs", {
    args: ["--force"],
    routes: ["aaaa-0001", "aaaa-0002"].map((id) => viewRoute(CHICAGO, id, { body: view(id) })),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(fetchedIds(res), ["aaaa-0001", "aaaa-0002"]);
});

test("--discover fetches only datasets not yet in datasets.json", (t) => {
  const w = workdir(t, {
    catalogs: { [CHICAGO]: catalog(CHICAGO, [catalogResult("old0-0001"), catalogResult("new0-0001")]) },
    datasets: { builtAt: T1, datasets: [{ id: "old0-0001" }] },
  });
  const res = run(w, "fetch-metadata.mjs", {
    args: ["--discover"],
    routes: [viewRoute(CHICAGO, "new0-0001", { body: view("new0-0001") })],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);
  assert.deepEqual(fetchedIds(res), ["new0-0001"]);
  assert.match(res.stderr, /new: new0-0001/);
});

test("--oldest N refetches the N cached files with the oldest fetchedAt", (t) => {
  const w = workdir(t, {
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, [catalogResult("chi0-0001"), catalogResult("chi0-0002")]),
      [COOK]: catalog(COOK, [catalogResult("cook-0001")]),
    },
    metadata: {
      [CHICAGO]: {
        "chi0-0001": cachedMeta("chi0-0001", { fetchedAt: "2026-03-01T00:00:00.000Z" }),
        "chi0-0002": cachedMeta("chi0-0002", { fetchedAt: "2026-01-01T00:00:00.000Z" }),
      },
      [COOK]: { "cook-0001": cachedMeta("cook-0001", { fetchedAt: "2026-02-01T00:00:00.000Z" }) },
    },
  });
  const res = run(w, "fetch-metadata.mjs", {
    args: ["--oldest", "2"],
    routes: [
      viewRoute(CHICAGO, "chi0-0002", { body: view("chi0-0002") }),
      viewRoute(COOK, "cook-0001", { body: view("cook-0001") }),
    ],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);
  assert.deepEqual(fetchedIds(res), ["chi0-0002", "cook-0001"]);
});

test("--oldest without a positive number exits with an error", (t) => {
  const res = run(workdir(t), "fetch-metadata.mjs", { args: ["--oldest", "zero"] });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--oldest requires a positive number/);
});

test("domain arguments limit which portals are processed", (t) => {
  const w = workdir(t, { catalogs: {
    [CHICAGO]: catalog(CHICAGO, [catalogResult("chi0-0001")]),
    [COOK]: catalog(COOK, [catalogResult("cook-0001")]),
  } });
  const res = run(w, "fetch-metadata.mjs", {
    args: [COOK],
    routes: [viewRoute(COOK, "cook-0001", { body: view("cook-0001") })],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(unmatched(res.requests), []);
  assert.deepEqual(fetchedIds(res), ["cook-0001"]);
});
