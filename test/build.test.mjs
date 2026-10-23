import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHICAGO, COOK, ILLINOIS, T1, cachedMeta, catalog, catalogResult, run, workdir,
} from "./helpers/fixtures.mjs";

const byId = (out) => Object.fromEntries(out.datasets.map((d) => [d.id, d]));

test("merges catalog and cached metadata into the rows the page renders", (t) => {
  const w = workdir(t, {
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, [catalogResult("aaaa-0001", {
        resource: {
          name: "Crimes",
          description: "<p>Reported   <b>crimes</b>\n since 2001</p>",
          columns_field_name: ["id", "date", ":@computed_region_abcd", ":id"],
        },
        classification: {
          domain_category: "Public Safety",
          domain_tags: ["Crime", " crime ", "police", ""],
          domain_metadata: [
            { key: "Metadata_Data-Owner", value: "  Police  " },
            { key: "Metadata_Frequency", value: "Daily" },
          ],
        },
      })]),
    },
    metadata: {
      [CHICAGO]: { "aaaa-0001": cachedMeta("aaaa-0001", { rowCount: 8_000_000, rowLabel: "Crime" }) },
    },
  });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 0, res.stderr);
  const out = w.json("data/datasets.json");
  assert.ok(!Number.isNaN(Date.parse(out.builtAt)));
  assert.deepEqual(out.datasets, [{
    id: "aaaa-0001",
    domain: "Chicago",
    name: "Crimes",
    link: "https://example.test/d/aaaa-0001",
    description: "Reported crimes since 2001",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: T1,
    viewsLastMonth: 10,
    viewsTotal: 100,
    downloads: 5,
    numColumns: 2,
    numRows: 8_000_000,
    rowLabel: "Crime",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    owner: "Police",
    frequencyRaw: "Daily",
    category: "Public Safety",
    tags: ["crime", "police"],
  }]);
});

test("uses each domain's owner/frequency keys, first non-empty wins", (t) => {
  const w = workdir(t, {
    catalogs: {
      [COOK]: catalog(COOK, [
        catalogResult("cook-0001", {
          resource: { attribution: "Assessor (attribution)" },
          classification: { domain_metadata: [
            { key: "Department_Publishing-Department", value: "Clerk" },
            { key: "Metadata_Update-Frequency", value: "" },
            { key: "Publishing-Details_Publishing-frequency", value: "Monthly" },
          ] },
        }),
        catalogResult("cook-0002", {
          resource: { attribution: "Assessor (attribution)" },
          classification: { domain_metadata: [
            { key: "Department_Publishing-Department", value: "   " },
          ] },
        }),
      ]),
      [ILLINOIS]: catalog(ILLINOIS, [catalogResult("ill0-0001", {
        classification: { domain_metadata: [
          { key: "Organizations_Organization", value: "IDOT" },
          { key: "Metadata_Frequency", value: "Daily" },
        ] },
      })]),
    },
  });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 0, res.stderr);
  const rows = byId(w.json("data/datasets.json"));
  assert.equal(rows["cook-0001"].owner, "Clerk");
  assert.equal(rows["cook-0001"].frequencyRaw, "Monthly");
  assert.equal(rows["cook-0002"].owner, "Assessor (attribution)", "falls back to resource.attribution");
  assert.equal(rows["cook-0002"].frequencyRaw, "");
  assert.equal(rows["ill0-0001"].domain, "Illinois");
  assert.equal(rows["ill0-0001"].owner, "IDOT");
  assert.equal(rows["ill0-0001"].frequencyRaw, "", "Illinois has no frequency keys");
});

test("missing or corrupt metadata leaves numRows null without failing", (t) => {
  const w = workdir(t, {
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, [
        catalogResult("aaaa-0001"),
        catalogResult("aaaa-0002"),
        catalogResult("aaaa-0003"),
      ]),
    },
    metadata: { [CHICAGO]: { "aaaa-0001": cachedMeta("aaaa-0001") } },
  });
  w.write(`data/cached/metadata/${CHICAGO}/aaaa-0003.json`, '{"id": "aaaa-0003", "rowCo');

  const res = run(w, "build.mjs");
  assert.equal(res.code, 0, res.stderr);
  const rows = byId(w.json("data/datasets.json"));
  assert.equal(rows["aaaa-0001"].numRows, 10);
  for (const id of ["aaaa-0002", "aaaa-0003"]) {
    assert.equal(rows[id].numRows, null);
    assert.equal(rows[id].rowLabel, null);
    assert.equal(rows[id].fetchedAt, null);
  }
  assert.match(res.stderr, /3 datasets, 1 with cached metadata, 2 without a row count/);
});

test("defaults for sparse catalog entries", (t) => {
  const sparse = catalogResult("aaaa-0001", {
    resource: { description: null, page_views: undefined, download_count: undefined,
      columns_field_name: undefined },
    classification: { domain_category: undefined, domain_tags: undefined,
      domain_metadata: undefined },
    link: undefined,
  });
  const w = workdir(t, { catalogs: { [CHICAGO]: catalog(CHICAGO, [sparse]) } });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 0, res.stderr);
  const [row] = w.json("data/datasets.json").datasets;
  assert.equal(row.link, "https://example.test/p/aaaa-0001", "falls back to permalink");
  assert.equal(row.description, "");
  assert.equal(row.viewsLastMonth, 0);
  assert.equal(row.viewsTotal, 0);
  assert.equal(row.downloads, 0);
  assert.equal(row.numColumns, 0);
  assert.equal(row.category, "");
  assert.deepEqual(row.tags, []);
  assert.equal(row.owner, "");
});

test("skips non-dataset resources and domains not in DOMAINS", (t) => {
  const w = workdir(t, {
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, [
        catalogResult("aaaa-0001"),
        catalogResult("map0-0001", { resource: { type: "map" } }),
      ]),
      "data.example.gov": catalog("data.example.gov", [catalogResult("exam-0001")]),
    },
  });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(w.json("data/datasets.json").datasets.map((d) => d.id), ["aaaa-0001"]);
  assert.match(res.stderr, /skipping data\.example\.gov/);
});

test("a corrupt catalog fails the build and leaves datasets.json untouched", (t) => {
  const previous = JSON.stringify({ builtAt: T1, datasets: [{ id: "keep-0001" }] });
  const w = workdir(t, { datasets: previous });
  w.write(`data/cached/catalogs/${CHICAGO}.json`, '{"domain": "data.cityofchicago.org", "resu');

  const res = run(w, "build.mjs");
  assert.notEqual(res.code, 0);
  assert.equal(w.read("data/datasets.json"), previous);
});

// Previous build: 10 Chicago and 10 Cook County datasets.
const previousBuild = {
  builtAt: T1,
  datasets: [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `chi0-000${i}`, domain: "Chicago" })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `cook-000${i}`, domain: "Cook County" })),
  ],
};
const results = (prefix, n) =>
  Array.from({ length: n }, (_, i) => catalogResult(`${prefix}-000${i}`));

test("fails without writing when a portal's dataset count drops more than 10%", (t) => {
  const w = workdir(t, {
    datasets: previousBuild,
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, results("chi0", 10)),
      [COOK]: catalog(COOK, results("cook", 8)),
    },
  });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Cook County dropped from 10 to 8 datasets/);
  assert.doesNotMatch(res.stderr, /Chicago dropped/);
  assert.deepEqual(w.json("data/datasets.json"), previousBuild);
});

test("fails when a portal disappears entirely", (t) => {
  const w = workdir(t, {
    datasets: previousBuild,
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, results("chi0", 10)),
      [COOK]: catalog(COOK, []),
    },
  });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Cook County dropped from 10 to 0 datasets/);
  assert.deepEqual(w.json("data/datasets.json"), previousBuild);
});

test("allows drops up to 10%, growth, and new portals", (t) => {
  const w = workdir(t, {
    datasets: previousBuild,
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, results("chi0", 9)),
      [COOK]: catalog(COOK, results("cook", 12)),
      [ILLINOIS]: catalog(ILLINOIS, results("ill0", 3)),
    },
  });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 0, res.stderr);
  assert.equal(w.json("data/datasets.json").datasets.length, 24);
});

test("--allow-shrink accepts a large drop", (t) => {
  const w = workdir(t, {
    datasets: previousBuild,
    catalogs: {
      [CHICAGO]: catalog(CHICAGO, results("chi0", 10)),
      [COOK]: catalog(COOK, results("cook", 1)),
    },
  });

  const res = run(w, "build.mjs", { args: ["--allow-shrink"] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(w.json("data/datasets.json").datasets.length, 11);
});

test("a corrupt previous datasets.json does not block the build", (t) => {
  const w = workdir(t, {
    datasets: '{"builtAt": "2026-01-0',
    catalogs: { [CHICAGO]: catalog(CHICAGO, results("chi0", 1)) },
  });

  const res = run(w, "build.mjs");
  assert.equal(res.code, 0, res.stderr);
  assert.equal(w.json("data/datasets.json").datasets.length, 1);
});
