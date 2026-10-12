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
