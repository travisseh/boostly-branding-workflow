# Boostly review site (next)

The fulfillment review site as a small Next.js app. Every page is rendered live from the Vercel Blob store. The skill only emits data (`site-data.mjs`, `run-progress.mjs`). This app owns all HTML. There is no git commit per publish.

Stack: Next.js 16 App Router, strict TypeScript, Tailwind 4, shadcn/ui (table, badge, button, card, input, collapsible, tooltip), Geist. Light and dark mode follow the system setting through the shadcn theme tokens.

## Routes

| Route | What it shows |
| --- | --- |
| `/` | One row per location from `site/index.json`: Location, Requested, Updated, What's next, Rec / Pick, links. Search, a Show filter and "needs you first" sort. Table from 768 px up, cards below. |
| `/l/[slug]` | One location from its bundle: status strip, Overview, Print files, Website, Google Business Profile, Logo image search (only with results), Logo candidates, Variant sheet, Links, Previews. |
| `/l/[slug]` without site data | The live status strip plus a link to the current static page (`old_url`), until the location is republished with `--site-mode next`. |
| unknown slug | 404 |

Both routes revalidate every 30 seconds. Location pages render on first request and are then cached (`generateStaticParams` returns nothing).

## Data reads (server only)

All reads are plain GETs of public Blob URLs. The store origin comes from `BLOB_PUBLIC_ORIGIN`, or is derived from `BLOB_READ_WRITE_TOKEN`. The site never writes.

| Blob path | Writer | Used for |
| --- | --- | --- |
| `site/index.json` | `site-data.mjs index` / `rebuild-index` / `seed-index` | the list |
| `status/checklist.json` | the 5-minute board job | live what's-next overlay, "live" time |
| `status/<slug>.json` | `run-progress.mjs publish` | newest progress and editing claim |
| `bundles/<slug>/manifest.json` | `run-progress.mjs publish` | finds `review/site-data.json` for a location |
| `review/site-data.json` (via the manifest) | `site-data.mjs build` | everything on a location page |
| `site/assets/<slug>/<sha12>-<name>` | `site-data.mjs build` | images, immutable, cached one year |

## Contract

Three documents carry a schema version, and this app validates each one (`lib/contract.ts`). It refuses versions it does not know and shows the reason on the page instead of guessing.

**Bundle manifest** (`bundles/<slug>/manifest.json`): `schema_version: 1`, `slug`, `files: { "<run-relative path>": { url, bytes, sha256 } }`. The version is stamped by `run-progress.mjs` (`BUNDLE_SCHEMA_VERSION`).

**Site data** (`review/site-data.json` inside the bundle): `schema_version: 1`, `kind: "boostly-review-site-data"`, `slug`, `generated_at`, `generator`, and these blocks:

- `entry`: the list row (see index entry below).
- `location`: name, account and location names, city, state, request id, order type, website, website swap, place id, Slack, Figma, print folder.
- `canvas_usage`: what the canvas recorded for website, vibe photos and the maps view.
- `branding`: kept, inherited or written, plus the colors (standalone pages).
- `website`, `gbp`, `logo_search`, `candidates`: the evidence, with run-relative image paths.
- `sheet`: JSON path, revision, default and applied letters, marks, cell facts, and `view`. The view is the exact input of `sheet-templates.js` `sheetHtml`. Its label headers follow the current `variant-sheet.mjs` rule at publish time.
- `links`: the run's links block, the newest discovery report trimmed, pending URLs, browser manifest and validator.
- `previews`: prompts, verdicts, and per-letter signage spec, signage PNG and mockups.
- `assets`: `{ "<run-relative path>": { url, bytes, width, height } }`. Every image the page shows is in this map.
- `notes`.

The page applies the same rules as `review-canvas.mjs`, ported in `lib/canvas.ts` and `lib/links.ts`. `tests/links.test.ts` runs the skill's own link functions against the port on every local run.

**Index** (`site/index.json`): `schema_version: 1`, `generated_at`, `count`, and `entries: { <slug>: entry }`. An entry holds:

- slug, name, account, city, state, requested and updated times;
- status and status label;
- recommended and picked letters;
- Figma URL, signage-direct flag and print URL;
- board fields: steps, needs_you, gaps, hold, done, note, review_status;
- progress and editing;
- `has_canvas`, `has_site_data`, `old_url`, `published_at`.

The index is rebuilt from the per-location files `site/entries/<slug>.json` on every publish. The index itself is never read back and modified, because its public copy can be up to a minute stale.

Ship-to data is never published. `site-data.mjs` refuses `ship_to`, `street_address` and `postal_code` keys. It also scrubs street-address-like strings outside URLs and token-like strings before upload.

## Publishing

`publish-location.mjs` (skill scripts, live and package copies) has `--site-mode old|next|both`. The default is `BOOSTLY_SITE_MODE`, else `old`. The default stays `old` until Travisse flips it.

```
node publish-location.mjs --run RUN_DIR --site-mode next [--no-canvas] [--by <agent>]
```

`next` runs these steps:

1. `site-data.mjs build`: writes `review/site-data.json` and uploads downsized images to `site/assets/<slug>/`. Images whose content hash is already there are skipped.
2. `run-progress.mjs publish`: status plus the bundle, which now carries `site-data.json`.
3. `site-data.mjs index`: the entry plus the rebuilt index.

`both` also runs the old static build and push.

Images are downsized with the old build's tiers. Design files (variants, candidates, signage, fix, review, mockups) go to 3200 px PNG. Evidence goes to 1200 px JPEG at quality 78. Everything else goes to 1600 px at quality 82. When a re-encode would be larger and is not resized, the source bytes are kept.

Measured on 2026-10-21:

| | Il Capo | Five Star Clearwater |
| --- | --- | --- |
| first publish, images uploaded | 11.60 MB (10 images, 12.14 MB at source) | 3.61 MB (32 images, 25.79 MB at source) |
| repeat publish, total upload | about 0.3 MB (site-data 91 KB, bundle manifest 15 KB, status, entry, index 101 KB twice) | about 0.35 MB (site-data 125 KB) |
| Blob footprint, site assets | 11.60 MB | 3.61 MB |
| Blob footprint, bundle | 5.40 MB | 2.86 MB |
| Blob footprint, old static assets | 37.54 MB | 11.38 MB |
| location page HTML (gzip) | 177 KB (22 KB); the static page was 8.3 MB (694 KB) | 268 KB (23 KB); the static page was 10.2 MB |

Other commands:

```
node site-data.mjs footprint [--slug SLUG]       # MB per slug: site assets, bundle, old static assets
node site-data.mjs rebuild-index                 # index from site/entries
node site-data.mjs seed-index --sites-json ~/Programming/repos/fulfillment-reviews/data/sites.json
```

The seed command lists every location on the static site, so the list is complete before cutover. Seeded entries have `has_site_data: false` and an `old_url`.

## Template islands

The variant sheet, the compare panel and the signage preview are drawn in the browser by the shared `skills/boostly-brand-design/templates/sheet-templates.js`. That file is imported, never copied. These elements carry the class `tpl`.

A CSS layer above Tailwind's preflight reverts every property inside `.tpl` to the browser default, SVG excepted. The templates' own CSS and inline styles still win, so the islands render with the same cascade as the static pages and stay pixel-close to Figma. Do not put Tailwind classes on or inside `.tpl`.

The sheet is drawn after hydration, not on the server. The expanded markup carries two inline QR SVGs per cell, about 200 KB each.

## Environment

| Variable | Where | Notes |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | Vercel project env (production, preview); locally `.env.local` (gitignored) | used only to derive the public store origin; never printed or committed |
| `BLOB_PUBLIC_ORIGIN` | optional | overrides the derived origin |
| `BOOSTLY_SITE_NEXT_URL` | where `publish-location.mjs` runs | printed after a publish as `<url>/l/<slug>` |

## Local

```
npm install
npm run dev          # http://127.0.0.1:3412
npm run typecheck
npm test             # contract, status priority, links port against review-canvas.mjs on every local run
npm run build && npm start
```

### Parity

Serve the static pages on port 3411 and this app on 3412, then run:

```
(cd ~/Programming/repos/fulfillment-reviews/public && python3 -m http.server 3411 --bind 127.0.0.1)
node scripts/parity.mjs il-capo five-star-pizza-clearwater
node scripts/shots.mjs / /l/il-capo              # light and dark viewport shots
```

`parity/report.json` records the following for each page:

- section text facts, compared old against new;
- horizontal overflow at 1440, 1100 and 400 px;
- per-cell markup equality;
- per-cell pixel mismatch, raw and best-aligned within 2 px.

## Deploy

This app is a separate Vercel project, `boostly-review-site`, in the boostly team. Its Root Directory is `site`. The project was created on 2026-10-21 and is live at https://boostly-review-site.vercel.app.

Deploys upload the repo root, because the app imports `skills/boostly-brand-design/templates/sheet-templates.js`. The root `.vercelignore` limits the upload to `site/` and `skills/`. The root `.vercel/project.json` links the repo and is gitignored.

```
cd ~/Programming/projects/boostly-branding-workflow
vercel deploy            # preview
vercel deploy --prod     # boostly-review-site.vercel.app
```

`BLOB_READ_WRITE_TOKEN` is set on the project for production, preview and development. Per-deployment URLs sit behind Vercel SSO. The project domain is public and marked noindex, like the static site.

The `fulfillment-reviews` project and its domain are untouched. Cutting `fulfillment-reviews.vercel.app` over to this app is Travisse's call.
