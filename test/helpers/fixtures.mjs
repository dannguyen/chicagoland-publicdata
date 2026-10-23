// Temp working directories and builders for Socrata-shaped fixtures. Every script
// resolves its paths relative to cwd, so each test runs them inside its own temp dir
// and the repo's data/ is never touched.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOCK = pathToFileURL(path.join(ROOT, "test", "helpers", "fetch-mock.mjs")).href;

export const CHICAGO = "data.cityofchicago.org";
export const COOK = "datacatalog.cookcountyil.gov";
export const ILLINOIS = "data.illinois.gov";

// Whole-second timestamps, since fetch-metadata compares catalog data_updated_at
// (ISO) against cached rowsUpdatedAt (epoch seconds).
export const T1 = "2026-01-02T03:04:05.000Z";
export const T2 = "2026-02-03T04:05:06.000Z";
export const epoch = (iso) => Date.parse(iso) / 1000;

// A temp dir laid out like the repo's data/ directory, removed after the test.
export function workdir(t, { catalogs = {}, metadata = {}, datasets } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "socrata-meta-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (rel, value) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  };
  mkdirSync(path.join(dir, "data", "cached", "catalogs"), { recursive: true });
  mkdirSync(path.join(dir, "data", "cached", "metadata"), { recursive: true });
  for (const [domain, catalog] of Object.entries(catalogs)) {
    write(`data/cached/catalogs/${domain}.json`, catalog);
  }
  for (const [domain, byId] of Object.entries(metadata)) {
    for (const [id, meta] of Object.entries(byId)) {
      write(`data/cached/metadata/${domain}/${id}.json`, meta);
    }
  }
  if (datasets !== undefined) write("data/datasets.json", datasets);

  return {
    dir,
    write,
    path: (rel) => path.join(dir, rel),
    exists: (rel) => existsSync(path.join(dir, rel)),
    read: (rel) => readFileSync(path.join(dir, rel), "utf8"),
    json: (rel) => JSON.parse(readFileSync(path.join(dir, rel), "utf8")),
  };
}

// Runs scripts/<name> with cwd = w.dir and fetch mocked by `routes`. Returns the exit
// code, output, and every request the script made.
export function run(w, name, { args = [], env = {}, routes = [] } = {}) {
  const mockDir = mkdtempSync(path.join(tmpdir(), "socrata-meta-mock-"));
  try {
    const routesFile = path.join(mockDir, "routes.json");
    const logFile = path.join(mockDir, "requests.jsonl");
    writeFileSync(routesFile, JSON.stringify(routes));
    writeFileSync(logFile, "");
    const childEnv = { ...process.env, MOCK_ROUTES: routesFile, MOCK_LOG: logFile, ...env };
    if (!("SOCRATA_APP_TOKEN" in env)) delete childEnv.SOCRATA_APP_TOKEN;
    const res = spawnSync(
      process.execPath,
      ["--import", MOCK, path.join(ROOT, "scripts", name), ...args],
      { cwd: w.dir, env: childEnv, encoding: "utf8", timeout: 30_000 },
    );
    const requests = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { code: res.status, stdout: res.stdout, stderr: res.stderr, requests };
  } finally {
    rmSync(mockDir, { recursive: true, force: true });
  }
}

// One Discovery API catalog result.
export function catalogResult(id, overrides = {}) {
  const { resource = {}, classification = {}, ...rest } = overrides;
  return {
    resource: {
      id,
      name: `Dataset ${id}`,
      type: "dataset",
      description: `About ${id}`,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: T1,
      data_updated_at: T1,
      page_views: { page_views_last_month: 10, page_views_total: 100 },
      download_count: 5,
      columns_field_name: ["a", "b"],
      attribution: null,
      ...resource,
    },
    classification: {
      domain_category: "Test",
      domain_tags: [],
      domain_metadata: [],
      ...classification,
    },
    link: `https://example.test/d/${id}`,
    permalink: `https://example.test/p/${id}`,
    ...rest,
  };
}

export const catalog = (domain, results, resultSetSize = results.length) =>
  ({ domain, fetched_at: T1, resultSetSize, results });

// A cached (already trimmed) metadata file, as fetch-metadata writes it.
export const cachedMeta = (id, overrides = {}) => ({
  id,
  rowCount: 10,
  rowCountSource: "cached",
  rowLabel: null,
  rowsUpdatedAt: epoch(T1),
  fetchedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

// A raw /api/views/<id>.json response.
export const view = (id, overrides = {}) => ({
  id,
  name: `Dataset ${id}`,
  assetType: "dataset",
  viewType: "tabular",
  displayType: "table",
  rowsUpdatedAt: epoch(T1),
  columns: [
    { name: "A", fieldName: "a", dataTypeName: "text", description: "",
      cachedContents: { count: "10", null: "1", cardinality: "4", top: [{ item: "x" }] } },
  ],
  metadata: { rowLabel: "Row", custom_fields: {} },
  ...overrides,
});

export const viewRoute = (domain, id, ...responses) =>
  ({ host: domain, path: `/api/views/${id}.json`, responses });

export const unmatched = (requests) => requests.filter((r) => r.unmatched);
