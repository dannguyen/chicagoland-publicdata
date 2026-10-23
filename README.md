# Chicago-area Public Data Explorer

A compilation of the data set catalogs from data.cityofchicago.org,
datacatalog.cookcountyil.gov, and data.illinois.gov. A static page (`index.html`,
`app.js`, `style.css`) loads one file, `data/datasets.json`, which is updated daily via Github Actions.

View it at [https://dannguyen.github.io/chicagoland-publicdata/](https://dannguyen.github.io/chicagoland-publicdata/).

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

`.github/workflows/refresh.yml` runs daily at 7:10 AM Chicago time and on demand
(Actions → refresh → Run workflow); pushes don't trigger it. Pushing a change to
`index.html`, `app.js`, or `style.css` runs `.github/workflows/deploy.yml` instead,
which redeploys the page with the committed `data/datasets.json`. It restores `data/cached/` from the Actions cache, fetches,
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
