// app.js is a browser script with DOM wiring at the top level, so it runs here in a
// vm context with a stub DOM. Function declarations (loadData, normalizeFrequency)
// are reachable on the context; top-level consts are not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  CHICAGO, catalog, catalogResult, cachedMeta, run, workdir,
} from "./helpers/fixtures.mjs";

const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");

// Every property is the stub itself and every call returns it, so DOM wiring at load
// time is a no-op. `then` is undefined so nothing mistakes it for a promise.
const stub = new Proxy(function () {}, {
  get: (_, key) => (key === "then" || typeof key === "symbol" ? undefined : stub),
  set: () => true,
  apply: () => stub,
  construct: () => stub,
});

function loadApp() {
  // The default fetch never settles, so the load-time loadData().then(render) never runs.
  const context = vm.createContext({ document: stub, fetch: () => new Promise(() => {}) });
  vm.runInContext(APP, context, { filename: "app.js" });
  return context;
}

// Objects from the vm realm have different prototypes; normalize before deepEqual.
const plain = (v) => JSON.parse(JSON.stringify(v));

test("normalizeFrequency collapses free text into Daily/Weekly/Monthly/Other", () => {
  const { normalizeFrequency } = loadApp();
  const cases = {
    "Daily": "Daily",
    "Updated daily": "Daily",
    "Hourly": "Daily",
    "Several times per day": "Daily",
    "Updated daily. Lobbyist reporting is quarterly.": "Daily",
    "Weekly": "Weekly",
    "Bi-weekly": "Weekly",
    "Monthly": "Monthly",
    "Updated each month": "Monthly",
    "Quarterly": "Other",
    "Annually": "Other",
    "No longer updated daily": "Other",
    "Historical data, updated monthly": "Other",
    "": "Other",
  };
  for (const [raw, expected] of Object.entries(cases)) {
    assert.equal(normalizeFrequency(raw), expected, JSON.stringify(raw));
  }
  assert.equal(normalizeFrequency(undefined), "Other");
  assert.equal(normalizeFrequency(null), "Other");
});

test("loadData accepts what build.mjs produces", async (t) => {
  const w = workdir(t, {
    catalogs: { [CHICAGO]: catalog(CHICAGO, [
      catalogResult("aaaa-0001", {
        resource: { name: "Crimes - 2001 to Present", description: "Reported CRIMES" },
        classification: {
          domain_category: "Public Safety",
          domain_metadata: [
            { key: "Metadata_Data-Owner", value: "Police" },
            { key: "Metadata_Frequency", value: "Updated daily" },
          ],
        },
      }),
      catalogResult("aaaa-0002", { classification: { domain_category: "" } }),
    ]) },
    metadata: { [CHICAGO]: { "aaaa-0001": cachedMeta("aaaa-0001") } },
  });
  const built = run(w, "build.mjs");
  assert.equal(built.code, 0, built.stderr);
  const data = w.json("data/datasets.json");

  const app = loadApp();
  app.fetch = async (url) => {
    assert.equal(url, "data/datasets.json");
    return { ok: true, json: async () => data };
  };
  const [crimes, bare] = plain(await app.loadData());

  assert.equal(crimes.searchText, "crimes - 2001 to present reported crimes");
  assert.equal(crimes.owner, "Police");
  assert.equal(crimes.frequency, "Daily");
  assert.equal(crimes.frequencyRaw, "Updated daily");
  assert.equal(crimes.category, "Public Safety");
  assert.equal(crimes.numRows, 10);

  assert.equal(bare.owner, "(none)");
  assert.equal(bare.category, "(none)");
  assert.equal(bare.frequency, "Other");
  assert.equal(bare.numRows, null);
});

test("loadData rejects on an HTTP error", async () => {
  const app = loadApp();
  app.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(app.loadData(), /data\/datasets\.json: HTTP 404/);
});
