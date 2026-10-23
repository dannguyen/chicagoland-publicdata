// Preloaded into script subprocesses with `node --import`. Replaces globalThis.fetch
// with canned responses so tests never reach Socrata.
//
// MOCK_ROUTES: path to a JSON array of { host, path, query?, responses: [...] }. A route
//   matches when host and path are equal and every `query` entry equals the request's
//   search param. Each match consumes the next response; the last one repeats.
//   A response is { status?, body?, headers? }.
// MOCK_LOG: path to a JSONL file; every request is appended as { url, headers } (or
//   { url, unmatched: true }), and unmatched requests throw.

import { appendFileSync, readFileSync } from "node:fs";

const routes = JSON.parse(readFileSync(process.env.MOCK_ROUTES, "utf8"));
const calls = new Map();
const log = (entry) => appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(entry)}\n`);

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const i = routes.findIndex((r) =>
    r.host === url.host && r.path === url.pathname &&
    Object.entries(r.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v));
  if (i < 0) {
    log({ url: url.href, unmatched: true });
    throw new Error(`fetch-mock: no route for ${url.href}`);
  }
  log({ url: url.href, headers: Object.fromEntries(new Headers(init.headers)) });
  const n = calls.get(i) ?? 0;
  calls.set(i, n + 1);
  const { responses } = routes[i];
  const { status = 200, body = null, headers = {} } = responses[Math.min(n, responses.length - 1)];
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
};
