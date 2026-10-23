#!/usr/bin/env node
// Merges data/cached/catalogs/*.json with data/cached/metadata/<domain>/<4x4>.json
// into data/datasets.json, the single file index.html loads. Each entry is already
// in the shape the page renders, so the page does no per-domain normalization.
//
// Refuses to overwrite data/datasets.json when any portal's dataset count drops by more
// than MAX_DROP from the previous build, which usually means a truncated or empty
// catalog fetch. Pass --allow-shrink to accept the drop.
//
// Usage: node scripts/build.mjs [--allow-shrink]

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CATALOG_DIR = path.join("data", "cached", "catalogs");
const METADATA_DIR = path.join("data", "cached", "metadata");
const OUT = path.join("data", "datasets.json");
const MAX_DROP = 0.1;

// Each portal stores owner/frequency under its own custom metadata keys; the first
// non-empty key wins. ATTRIBUTION is the standard Socrata resource.attribution field.
const ATTRIBUTION = "(attribution)";
const DOMAINS = {
  "data.cityofchicago.org": {
    label: "Chicago",
    owner: ["Metadata_Data-Owner"],
    frequency: ["Metadata_Frequency"],
  },
  "datacatalog.cookcountyil.gov": {
    label: "Cook County",
    owner: ["Department_Publishing-Department", ATTRIBUTION],
    frequency: ["Metadata_Update-Frequency", "Publishing-Details_Publishing-frequency"],
  },
  "data.illinois.gov": {
    label: "Illinois",
    owner: ["Organizations_Organization"],
    frequency: [],
  },
};

const stripHtml = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const log = (msg) => process.stderr.write(`${msg}\n`);
const rows = [];
const builtAt = new Date().toISOString();
log(`build: reading ${CATALOG_DIR} and ${METADATA_DIR}`);
const catalogFiles = (await readdir(CATALOG_DIR)).filter((f) => f.endsWith(".json"));

for (const f of catalogFiles) {
  const domain = f.replace(/\.json$/, "");
  const config = DOMAINS[domain];
  if (!config) {
    console.warn(`skipping ${domain}: no entry in DOMAINS`);
    continue;
  }
  const catalog = await readJson(path.join(CATALOG_DIR, f));
  let withMeta = 0;
  let withoutRows = 0;

  for (const r of catalog.results) {
    if (r.resource.type !== "dataset") continue;
    const meta = await readJson(path.join(METADATA_DIR, domain, `${r.resource.id}.json`));
    if (meta) withMeta++;
    if (meta?.rowCount == null) withoutRows++;

    const custom = Object.fromEntries(
      (r.classification?.domain_metadata || []).map((m) => [m.key, m.value]));
    custom[ATTRIBUTION] = r.resource.attribution;
    const firstOf = (keys) => keys.map((k) => (custom[k] || "").trim()).find(Boolean) || "";

    rows.push({
      id: r.resource.id,
      domain: config.label,
      name: r.resource.name,
      link: r.link || r.permalink,
      description: stripHtml(r.resource.description || ""),
      createdAt: r.resource.createdAt,
      updatedAt: r.resource.updatedAt,
      viewsLastMonth: r.resource.page_views?.page_views_last_month ?? 0,
      viewsTotal: r.resource.page_views?.page_views_total ?? 0,
      downloads: r.resource.download_count ?? 0,
      // Exclude hidden auto-generated geo columns (:@computed_region_*).
      numColumns: (r.resource.columns_field_name || []).filter((c) => !c.startsWith(":")).length,
      numRows: meta?.rowCount ?? null,
      rowLabel: meta?.rowLabel || null,
      fetchedAt: meta?.fetchedAt ?? null,
      owner: firstOf(config.owner),
      frequencyRaw: firstOf(config.frequency),
      category: r.classification?.domain_category || "",
      tags: [...new Set((r.classification?.domain_tags || [])
        .map((t) => t.trim().toLowerCase()).filter(Boolean))],
    });
  }
  const n = rows.filter((x) => x.domain === config.label).length;
  log(`${domain}: ${n} datasets, ${withMeta} with cached metadata, ${withoutRows} without a row count`);
}

const countByDomain = (list) => {
  const counts = {};
  for (const d of list) counts[d.domain] = (counts[d.domain] ?? 0) + 1;
  return counts;
};
const previous = await readJson(OUT);
if (previous?.datasets && !process.argv.includes("--allow-shrink")) {
  const before = countByDomain(previous.datasets);
  const after = countByDomain(rows);
  const shrunk = Object.entries(before).filter(([d, n]) => (after[d] ?? 0) < n * (1 - MAX_DROP));
  if (shrunk.length) {
    for (const [d, n] of shrunk) log(`build: ${d} dropped from ${n} to ${after[d] ?? 0} datasets`);
    log(`build: not writing ${OUT}; rerun with --allow-shrink if the drop is real`);
    process.exit(1);
  }
}

await writeFile(OUT, JSON.stringify({ builtAt, datasets: rows }, null, 2));
log(`wrote ${OUT}: ${rows.length} datasets, builtAt ${builtAt}`);
