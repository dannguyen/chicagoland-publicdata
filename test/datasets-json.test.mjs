// Invariants on the real, committed data/datasets.json. Read-only; skipped when the
// file is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../data/datasets.json", import.meta.url));
const DOMAINS = ["Chicago", "Cook County", "Illinois"];

test("data/datasets.json is well-formed", { skip: !existsSync(FILE) && "no data/datasets.json" }, () => {
  const { builtAt, datasets } = JSON.parse(readFileSync(FILE, "utf8"));
  assert.ok(!Number.isNaN(Date.parse(builtAt)), `builtAt ${builtAt}`);
  assert.ok(Array.isArray(datasets));

  for (const domain of DOMAINS) {
    assert.ok(datasets.some((d) => d.domain === domain), `no ${domain} datasets`);
  }

  const seen = new Set();
  for (const d of datasets) {
    const where = `${d.domain}/${d.id}`;
    assert.ok(DOMAINS.includes(d.domain), `${where}: unknown domain`);
    assert.match(d.id, /^[a-z0-9]{4}-[a-z0-9]{4}$/, `${where}: id`);
    assert.ok(!seen.has(where), `${where}: duplicate`);
    seen.add(where);
    assert.equal(typeof d.name, "string", `${where}: name`);
    assert.match(d.link, /^https:\/\//, `${where}: link`);
    assert.equal(typeof d.description, "string", `${where}: description`);
    for (const k of ["viewsLastMonth", "viewsTotal", "downloads", "numColumns"]) {
      assert.ok(Number.isFinite(d[k]) && d[k] >= 0, `${where}: ${k}`);
    }
    assert.ok(d.numRows === null || (Number.isFinite(d.numRows) && d.numRows >= 0), `${where}: numRows`);
    for (const k of ["owner", "frequencyRaw", "category"]) {
      assert.equal(typeof d[k], "string", `${where}: ${k}`);
    }
    assert.ok(Array.isArray(d.tags), `${where}: tags`);
  }
});
