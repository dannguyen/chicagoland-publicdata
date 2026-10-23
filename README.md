# Chicago-area Public Data Explorer

A filterable list of Socrata datasets from data.cityofchicago.org,
datacatalog.cookcountyil.gov, and data.illinois.gov. A static page (`index.html`,
`app.js`, `style.css`) loads one file, `data/datasets.json`.

## Refreshing the data

```sh
npm run refresh   # fetch:catalogs, fetch:metadata (incremental), build
npm test
```

`fetch:metadata` reads `SOCRATA_APP_TOKEN` from the environment or `.env`. Fetched
responses are cached in `data/cached/` (not committed); `build` merges them into
`data/datasets.json` (committed).

`build` refuses to overwrite `datasets.json` when a portal loses more than 10% of its
datasets since the previous build. If the drop is real, run
`npm run build -- --allow-shrink`.

## Deployment

`.github/workflows/refresh.yml` runs daily, on push to `main`, and on demand (Actions →
refresh → Run workflow). It restores `data/cached/` from the Actions cache, fetches,
builds, runs the tests, commits `data/datasets.json` if it changed, and deploys to
GitHub Pages. To accept a real drop in a portal's dataset count, run it manually with
"allow_shrink" checked.

Requires the `SOCRATA_APP_TOKEN` repository secret and Settings → Pages → Source set
to "GitHub Actions".

## Ad hoc catalog queries

```sh
curl -o \
    data.cityofchicago.org.most_viewed_last_month.json \
    'https://api.us.socrata.com/api/catalog/v1?domains=data.cityofchicago.org&order=page_views_last_month+DESC'
```
