# boostly-branding-workflow

Self-contained bootstrap package for the Boostly in-store branding and fulfillment workflow (tap
cards, stickers, signage): the Claude Code skills, agents, scripts, standing rules, and a macOS
installer, so a second operator's Mac can run the same pipeline without depending on Travisse's
machine. Point Claude Code at `docs/BOOTSTRAP.md` on a fresh Mac and it installs everything, then
walks the operator through storing their own credentials one at a time (never in chat).

Contents: `skills/` (copies of the pipeline skills with hardcoded paths replaced by config, see
`PATCHES.md`; resynced from the live copies on 2026-10-12), `agents/` (fulfill-location, closeout-location, closeout-finish, discovery-transport),
`memory/RULES.md` (the operating rules), `setup/` (idempotent installer, `.env` template, Notion
wrapper shim, launchd job, review server), `tools/` (Apple Notes writer). The shareable review
pages are published to https://fulfillment-reviews.vercel.app from the separate repo
`Boostly/fulfillment-reviews` (BOOTSTRAP step 9); the local review server and Apple Note are the
operator's own quick view. Plan this package
implements: Boostly Notion "Karissa branding workflow handoff plan"
(https://www.notion.so/3edc831c671e817b8d1bca491532e031). Secrets never live in this repo.

Start here: [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).

## What changed since the 2026-10-02 snapshot

- **Sticker and POP previews match the Figma templates (2026-10-13, evening).** The sheet and canvas
  sticker and POP tiles are the measured In-Store-Fulfillment-8 signage template geometry (Figtree
  500/600 at the template sizes, 7px divider from inside the band, rounded-module QR), the copy is the
  closeout's (`signageCopy`), and the QR encodes the location's real Tables - Subscribe and Point of
  Purchase links with the same generator as the uploaded SVG masters (`styledQrSvg`). Links come from
  `signage/plan.json` or a read-only V2 `touchpoints/signage` GET (needs `BOOSTLY_V2_API_KEY` in the
  env file; without it the tile draws a seeded mock in the same style). Pages load Figtree from Google
  Fonts.
- **Client-side card, sticker and signage previews (2026-10-13).** The variant sheet, the review canvas
  and the signage previews no longer screenshot the Boostly app. `templates/sheet-templates.js` (in
  `skills/boostly-brand-design`) holds the vendored HTML/CSS: the production badge markup
  (boostly `generate-badge-html.ts` at 8bf7a2e), the sticker mock, the POP tile and the onboarding
  signage row. `variant-sheet.json` (schema 3) carries a `view` block per cell and the browser draws
  the cells; `review-canvas.html` embeds the sheet, lets the reviewer select cells and compare them on
  the page, and draws signage previews from `review/signage-preview-<L>.json`
  (`scripts/signage-preview.mjs`, replaces `harness/mockups/_signage-shot.mjs`). Rasters are opt-in
  (`--raster`, `--png`, `render --cell`) through one in-memory Playwright path
  (`scripts/render-preview.mjs`). The Boostly repo and the :3457 dev server are now needed only for
  the close-out proof render; BOOTSTRAP step 8 is optional until the first close-out and `setup.sh
  --check` reports it as WARN. Gate verdicts are unchanged (no gate ever read an app screenshot).

- **Signage PDFs without Figma (2026-10-15, default).** `closeout-location` renders the six vendor print
  files straight to vector PDF (`skills/boostly-signage-sheets/scripts/direct-pdf`, parity-proven against
  Figma's export on three runs) into `RUN_DIR/print-handoff/` and uploads them to the location's Google Drive folder (no vendor email, no
  summary row) before the stop; the reviewer approves the high-res PDFs in Drive via the review page's Print
  files link (2026-10-19). `closeout-finish` runs `print-handoff.mjs --run-dir RUN_DIR --live`, which adds the
  summary row and emails the vendor (its upload re-run replaces changed files in place). `--figma` keeps the old Figma-section export for runs approved in Figma. The Figma
  MCP plugin (BOOTSTRAP step 7) is now optional. Dry flags (`--offline`, `--dry-run`, `--scratch`) never
  touch Drive or email.

- **Print hand-off (2026-10-06).** customstickers.com prints all signage and stickers. `closeout-finish`
  runs `skills/boostly-print-handoff` right after the Slack post: vector PDF export of the Figma print
  sheets through the REST API, upload to the location's folder under the vendor master Drive folder, a
  row in the "Print order summary" sheet, and a Gmail DRAFT to ckbrandsmktg@gmail.com with Colin Dunn
  and Maren Dunn on cc. Drafts are never sent; Travisse sends them. Needs `FIGMA_TOKEN` and the
  gmail-tools CLI (with `--cc`) plus google-tools authorized for the operator's Boostly identity; both
  CLIs are shared by Travisse outside this repo (`GMAIL_TOOLS_DIR`, `GOOGLE_TOOLS_DIR` in the env file).
- **Public review site (2026-10-09).** `fulfill-location` publishes each location's review page to
  https://fulfillment-reviews.vercel.app and `closeout-finish` rebuilds it after the close-out
  (BOOTSTRAP step 9). The local review server and Apple Note are the operator's own view.
- **To-go labels (2026-10-05).** Text only, no logo, "A framed QR" layout; the subscribe headline is the
  offer, the review headline is "Let us know how we did" (`boostly-signage-sheets`).
- **Review canvas.** Logo candidate captions show where each candidate came from and the overview carries link verdict chips
  (`boostly-brand-design/scripts/review-canvas.mjs`).
- **Resync 2026-10-12 (afternoon).** Review canvas: the variant sheet loads eagerly and is cache-busted, rejected
  links from run.json show as rejected, an approved website swap shows as the website row. Print hand-off: short
  vendor email body; stale drafts are listed and deleted with the gmail-tools `drafts list` / `drafts delete` commands
  (the CLI build of 2026-10-12 or later). See the last section of `PATCHES.md`.
- **Resync 2026-10-12 (evening).** Print hand-off accepts zero-table orders (only the sheet kinds found in Figma are
  required). Review-site rebuilds use `--limit 0 --slug <run dir>` so only that page is rebuilt.
- **Google CLIs in the repo (2026-10-12).** `tools/google-cli/` holds gmail-tools, google-tools and
  google-calendar-tools (code only) plus `install.sh`; the OAuth client keys file and the operator's token stay out of band.
