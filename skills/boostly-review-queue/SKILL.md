---
name: boostly-review-queue
description: Build and spot-edit the Boostly Notion "Fulfillment Review Queue" pages Travisse uses to review tap-card and signage fulfillments. Use when asked to create a review queue page for a batch of branding runs, add or update a location on an existing queue, mark an entry done, or answer "what's left on the review queue". Never rebuilds pages; patches blocks in place through the raw Notion API.
---

# Boostly Fulfillment Review Queue

Builds and maintains the "Fulfillment Review Queue" pages in the Boostly Notion workspace (Travisse AI Output database). Each page lists one toggle per location with a details table and review links. Travisse opens the toggles, reviews Figma signage, and flips sets to PRODUCTION.

Live examples of the format: page `3cfc831c671e8127bd24c5b1c82a987e` (9/01-02 queue) and `3d5c831c-671e-81f2-9521-ca351ff56f52` (9/04-08 queue). Read them with the raw API when in doubt; never use the Notion MCP for this workspace.

## When to use

- A batch of branding runs finished and Travisse wants a review page.
- A run changed (branding applied, reviewer decision made, Jonathan answered) and one entry's cells need updating.
- Travisse asks what is left, what is waiting on whom, or what is done.
- A new location must be added to an existing queue page.

Do not use it to write PRDs or general docs (that is `notion-boostly`), and do not use it to edit pages that are not review queues.

## Commands

All scripts live in `scripts/` next to this file. Node 20+ and plain `fetch`; no npm install.

```bash
SK=~/.claude/skills/boostly-review-queue/scripts

# 1. Derive a ledger from a run directory (reads run.json when present, else manifest.json; plus production-readback.json, link-discovery-report.json)
node $SK/ledger-from-manifest.mjs runs-prod-2026-09-08/denises-delicacies-philadelphia \
  --set ease=2 --set "waiting_on=Jonathan: Order Online choice, quantities" --out /tmp/denise.json

# 2. Build a new page (returns id + URL, verifies block counts by reading back)
node $SK/review-queue.mjs build --title "Fulfillment Review Queue 2026-09-08 (Denise's, Astoria)" \
  --ledgers /tmp/denise.json /tmp/astoria.json [--intro "custom intro paragraph"] [--dry-run]

# 3. Update one location in place, or append it if absent (--run records page/block ids in run.json's notion block)
node $SK/review-queue.mjs upsert --page <pageId> --ledger /tmp/denise.json [--links 1] [--run <run-dir>]

# 3b. Only the Variant row + variant sheet image(s); leaves headings, narrative and link cells alone
#     (use this on a page Travisse has edited by hand)
node $SK/review-queue.mjs upsert --page <pageId> --ledger /tmp/denise.json --variants-only 1

# 4. Print the queue as text ("what's left")
node $SK/review-queue.mjs status --page <pageId> [--brief 1]
```

`ledger-from-manifest.mjs` accepts a run dir, a `run.json` path, or a manifest path. A run dir with `run.json` (one run file per location, schema in `boostly-box-fulfillment/references/run-schema.json`) renders from it: a migrated run keeps its manifest verbatim under `legacy.manifest` and renders byte-identically to before; a run born as run.json renders from its typed blocks (`request`, `write`, `variants`, `figma`, `links`). Passing the manifest path explicitly still renders from the manifest. Without run.json it handles both manifest shapes seen so far (the nested `location`/`request` shape and the flat Fox's shape), and exits 2 when there is no manifest. In that case write the ledger by hand from STATE.md; only `business`, `city`, and `account_id` are required. `--set key=value` and `--overrides file.json` override any derived field. Always set `ease` and `status` yourself; the derivation defaults to ease 3 and status waiting, and the derived verdict/open text is a starting point, not a review.

It also derives `variant_sheets`: from `manifest.variant_sheet` (`{png, json, applied_letter}`, paths relative to the run dir, trailing "(...)" notes stripped; a bare basename is searched for under the run dir), from a string like `shared: ../other-run/variants/variant-sheet.png`, or by searching `exp/variant-sheet/variant-sheet.png`, `exp/variants*/variant-sheet-all.png` (preferred over `variant-sheet.png` in the same dir), then `variants/variant-sheet.png`. When the manifest gives no letter it matches the applied colors (readback effective branding first, then `applied_colors`, then `production_write.after`) against every `variant-sheet*.json` next to the sheet: same `web_secondary_color` and the same logo basename, primary as a tiebreak. It prints each sheet and letter to stderr; "(letter not derivable)" means pass `--set applied_letter=X` or set `applied_variant`.

## Ledger schema

`request-ledger.schema.json` is the contract the branding runners should emit (one file per location). Fields:

- `location_id`, `account_id`, `business`, `city`
- `status`: `waiting` or `done` (which H1 the toggle sits under)
- `waiting_on`: who or what it waits on; becomes the heading label `waiting on <x>`
- `label`: optional explicit heading label that overrides the default
- `ease`: 1 (quickest review) to 5; orders the queue and renders as `[ease x/5]`
- `verdict`, `applied`, `signage`, `open`: the four narrative rows
- `slack_ts` (plus optional `slack_channel`, default `C09MSM8MA9Y`), `figma_url`, `website`, `ordering_url`, `place_id`, `address`
- `variant_sheets`: array of `{ png, json?, label?, applied_letter? }` (absolute paths). One image block per sheet; several sheets are allowed, but when a run stitched them into one `variant-sheet-all.png` list that file once. `json` is the `variant-sheet.json` whose `cells[applied_letter]` carries the exact hexes and logo.
- `applied_variant`: free-text override for the Variant row, e.g. `Q (#8D4CED / #6416D7, white digit)`. Use it when there is no sheet json to derive from.

## Format contract

The page body, top to bottom:

1. One intro paragraph.
2. H2 `Ordered review queue (easiest first)`.
3. H1 `Waiting`, then one toggleable H3 per waiting location.
4. H1 `Done`, then one toggleable H3 per done location.

Numbers are global ease rank across the whole page (1 = easiest), so a section can show non-contiguous numbers. Each H3 reads:

```
<n>. <Business> (<City>) <em dash> <status label>  [ease x/5]
```

The separator is a literal em dash (U+2014, shown above as a placeholder); the script emits it because the existing pages use it. Status label is `waiting on <waiting_on>`, `DONE`, or the ledger's `label`. The H3's only child is a 2-column table with a bold `Field` / `Detail` header and these rows in order:

- Verdict, Applied, Signage, Open (narrative)
- Variant: `Applied: <letter> (<row label>, primary <hex> / secondary <hex>, digit <hex>)`, derived from the sheet json's `cells[letter]` (digit = the print badge digit, i.e. `badge_digit_print.fix` when that check fails, else its text color); several sheets join with `; `. Falls back to `Applied: <applied_variant>`, then `(no variant sheet)`.
- V2 account: `https://new.boostly.com/admin/accounts/<accountId>`
- Slack: text `slackMessage://boostlyinc.slack.com/C09MSM8MA9Y/<ts>/<ts>` linked to the `archives/.../p<ts>` web URL
- Figma: the section URL in the In-Store Fulfillment file
- Website: the site, falling back to the ordering URL
- GBP: `https://www.google.com/maps/place/?q=place_id:<placeId>`, or "Manual place ID, no GBP link." plus a Google search link when the id is manual
- Logo search: Google Images query `<Business> <City> logo`

After the table, one image block per variant sheet (nested under the same H3), captioned `Variant sheet <label or png basename>. ` plus bold `Applied: <letter>.` The PNG is uploaded through the Notion file-upload API (`uploadFile` in `notion-client.mjs`, same two-step flow as `~/.config/notion-tools/notion-image-upload.js`). `build` sends the images nested in the create request and falls back to appending them per toggle if Notion rejects nested file uploads.

## The no-delete rule

Never delete blocks and re-append a body to change a few cells. Travisse edits these pages by hand between runs, and a rebuild destroyed his edits on 2026-09-02. `upsert` only ever:

- PATCHes the H3 heading text.
- PATCHes the specific `table_row` blocks for Verdict, Applied, Signage, Open (only fields present in the ledger; link rows too if `--links 1`).
- PATCHes the Variant row when it differs, or APPENDs it to the table right after Open (`PATCH /blocks/<tableId>/children` with `after`) when the row is missing.
- For each variant sheet: if an image block whose caption starts with `Variant sheet <label>` already exists, PATCHes its caption only when the applied letter changed; otherwise uploads the PNG and appends the image after the toggle's last child. Images are never deleted or replaced; a re-rendered sheet with the same label keeps the old image.
- Appends a new toggle after the last block of the right section (`after` parameter on the children endpoint) when the location is missing.

`--variants-only 1` restricts all of this to the Variant row and the images (no heading, narrative, or link patches). Use it whenever Travisse has edited the page by hand.

If a toggle has no table or a row is missing, the script says so and skips instead of guessing. Full-body rewrites are only for a page Travisse explicitly asks to have rewritten, and even then prefer building a new page.

## Limitations

- The API cannot move or reorder blocks. When a ledger says `done` but the toggle sits under Waiting, `upsert` prefixes the heading with `DONE ` and reports it; drag it under Done by hand if needed. Same for the reverse direction (heading updated, not moved).
- Appended toggles take the next number after the page max and land at the end of their section, so ease order within a section is only exact on `build`.
- `build` creates a fresh page every time. To keep an existing URL, use `upsert` per location.
- Matching is by `<Business> (<City>)` substring on the heading, case-insensitive. Keep business and city spelling stable between runs.

## Notion quirks (why the raw API)

- Token: `BOOSTLY_TOKEN` inside `~/.config/notion-tools/notion-ai-ntn.sh`, read at runtime by `notion-client.mjs`. Never print it. `NOTION_API_TOKEN` in the environment overrides it.
- The wrapper's `create` hangs on its final property PATCH, so pages are created with `POST /v1/pages` into data source `33bc831c-671e-8101-a3ca-000bab91f27a` (database `33bc831c-671e-8137-a524-f62347485d71`) with `Name` and `Category = research`, API version `2025-09-03`.
- `ntn api` hangs inside `$(...)` and with `--data @file`; the scripts use Node `fetch` instead.
- Children append in chunks of at most 100 blocks. Toggleable `heading_3` blocks carry the table as a nested child; tables need `table_width` and `has_column_header`, and their rows are nested `table_row` children (two levels of nesting, which one request allows).
- `rich_text` items cap at 2000 characters; the client splits longer strings into multiple items.
- File uploads: `POST /v1/file_uploads` then multipart `POST` to the returned `upload_url` (field `file`). Works on API version `2025-09-03`; the client retries those two calls on `2022-06-28` if a version error comes back. An `image` block with `type: file_upload` is accepted nested under a toggleable `heading_3`.
- 429 and 5xx responses are retried with backoff.
- If a read returns "object not found", the page is not shared with the "Claude Code - Travisse" integration; connect it from the page menu.
