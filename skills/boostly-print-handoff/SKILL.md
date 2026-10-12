---
name: boostly-print-handoff
description: Hand a closed-out Boostly location's signage and sticker print files to customstickers.com (CK Brands). Exports every "Print Sheet - " frame in the location's Figma section as VECTOR PDF through the Figma REST API, uploads the six PDFs plus logos to a per-location Google Drive folder under the vendor master folder, upserts the location's row in the "Print order summary" sheet, and creates a Gmail DRAFT to the vendor. Use at closeout-finish, right after the Slack post, or when Travisse says "send the print files to customstickers" or "print hand-off for <location>". Never sends email.
---

# Boostly Print Hand-off (customstickers.com)

customstickers.com (CK Brands Marketing, contact Gracie, ckbrandsmktg@gmail.com, cc Colin Dunn
<colin@printiverse.com> and Maren Dunn <maren@customstickers.com>) prints all
Boostly signage and stickers from 2026-10. Every location close-out ends with this hand-off:
vector PDFs in Drive, a summary row, and a draft email Travisse sends himself.

## When it runs

At `closeout-finish`, after Travisse approved the Figma signage and right after the single
Slack post (step 5), before or alongside branding complete. The `closeout-finish` agent runs
it and records the draft id in its report. It can also be run by hand for any run dir whose
run.json `figma` block is `built`. It never runs before signage approval: the Figma section
is the print master, and whatever is in it at export time is what the vendor prints.

## Commands

Working directory: `$BOOSTLY_RUN_ROOT`. Scripts read `FIGMA_TOKEN` from the environment or
`~/.config/boostly-branding/.env` and the boostly Google OAuth token from
`$GOOGLE_TOOLS_DIR/auth.js` (default `~/.config/google-tools`) inside the scripts only. Never print, echo, cat, or log either.

```bash
S=~/.claude/skills/boostly-print-handoff/scripts
# Whole hand-off (export, logos, Drive, summary row, draft), idempotent:
node $S/print-handoff.mjs --run-dir <RUN_DIR>
# Steps on their own:
node $S/export-sheets.mjs --run-dir <RUN_DIR> [--section <id[,id]>] [--file-key <key>] [--force]
node $S/drive-upload.mjs  --run-dir <RUN_DIR> [--offline] [--skip-summary]
node $S/draft-email.mjs   --run-dir <RUN_DIR> [--redraft] [--print-only]
```

Flags: `--section` / `--file-key` override run.json `figma.section_node_id` / `figma.file_key`
(comma-separate several sections when a location spans more than one, in grid order);
`--force` re-exports pages that already exist; `--offline` uses run.json request facts instead
of live v2-db reads (only when v2-db is down; say so in the report); `--redraft` makes a new
draft even though one is recorded; `--print-only` prints the email body without drafting.

Prerequisites: poppler (`pdfinfo`, `pdffonts`, `pdfimages`, `pdfunite` on PATH), the
`v2-db` CLI, the gmail-tools CLI at `$GMAIL_TOOLS_DIR/gmail.js` (default `~/.config/gmail-tools`) with the `boostly`
account authorized (its `draft` command needs the `--cc` flag and its `drafts list` / `drafts delete` commands, present since 2026-10-12).

## What each step does

1. **export-sheets.mjs**: reads the section(s) through `GET /v1/files/<key>/nodes?ids=<section>&depth=2`,
   collects every frame named `Print Sheet - ...`, classifies it into one of six kinds
   (`table-stickers`, `review-stickers`, `bathroom-stickers`, `bathroom-review-stickers`,
   `pop-sign` with Primary then Light, `togo-label` with promo then review) and a page number,
   cross-checks the node ids against run.json `figma.sheet_ids` (a mismatch is printed as a
   WARNING and recorded; read it), exports each frame with
   `GET /v1/images/<key>?ids=...&format=pdf` (chunks of 50, 429 backoff), merges per kind with
   `pdfunite` into `<RUN_DIR>/print-handoff/<kind>.pdf`, and verifies: page count equals frame
   count, `pdffonts` lists embedded fonts, and `pdfimages -list` shows no full-page image
   (only logo images). Exit 2 when any kind fails. Tap cards are never exported; they are made
   elsewhere. Per-page PDFs stay in `print-handoff/_vector-pages/` and are reused on rerun.
2. **drive-upload.mjs**: copies `write.logo_file` to `print-handoff/logos/card-sign-logo.<ext>`
   and `write.sticker_logo_file` (fallbacks: `write.secondary_logo.file`,
   `fix/sticker-logo-color.png`) to `logos/sticker-logo.<ext>`; ensures the master folder,
   shares it anyone-with-link reader, ensures the Boostly logos folder (copied once from the
   one-off batch's folder `1YXmKPvzzCDCcH1uVdqe4pNMOgElpt57w`), ensures
   `<Location name> - <request id first 8>` under the master, uploads the six PDFs and
   `logos/` with md5 skip (same bytes) or in-place update (changed bytes), reports stray files
   in the vendor folder but never deletes, then upserts the location's row in the
   "Print order summary" Google Sheet (keyed on the Drive folder name) by exporting it as CSV,
   merging, and re-uploading with spreadsheet conversion. The boostly token has the Drive
   scope only, no Sheets API scope, so the CSV round-trip is the mechanism; it rewrites the
   first sheet, so nobody should add extra tabs or formulas to that file.
   Facts are LIVE: ship-to from `locations.shipping_*`, quantities from `fulfillment_items`
   (tables = max(table subscribe, table review), stalls likewise, to-go rolls = sum of to_go
   rows, POP sets = signage quantity), offer from `fulfillment_requests.offer_text`.
3. **draft-email.mjs**: writes `print-handoff/draft-body.txt` and creates a Gmail DRAFT via
   `node $GMAIL_TOOLS_DIR/gmail.js draft boostly ckbrandsmktg@gmail.com "<subject>" "<body>" --cc "<VENDOR_CC>"`,
   where `VENDOR_CC` (exported from the script) is Colin Dunn <colin@printiverse.com> and
   Maren Dunn <maren@customstickers.com>. The `Cc:` line is also written under `To:` in draft-body.txt.
   Subject `Boostly print order: <Location name>`. Body (short, since 2026-10-12): one-line intro,
   location folder link, quantities, offer, ship-to, master folder link, the summary-sheet line,
   signed "Travisse". No file list, no vector-PDF explanation, no "let me know" closer. Plain
   text, no em dashes, no corporate filler.
   An existing `draft.id` in handoff.json means no second draft unless `--redraft` (the old id
   is kept under `draft.previous`). To inspect or remove a stale draft by id:
   `node $GMAIL_TOOLS_DIR/gmail.js drafts list boostly` and `drafts delete boostly <id>`
   (confirm the subject first; delete only ids recorded in handoff.json).

## Vector requirement (why)

The vendor rejected the first batch: PNG-flattened PDFs are rasterized, so their cutter and
RIP cannot read the sticker outlines and the text goes soft. Figma's `format=pdf` REST export
keeps text and QR modules as vectors with embedded fonts; only the logo fills are images.
`export-sheets.mjs` refuses a kind whose merged PDF has no embedded font or carries a
page-sized image. Never regenerate these PDFs from PNGs, screenshots, or the MCP screenshot
tool. If an export comes back without fonts, the text in Figma was outlined or the frame
contains a flattened image; fix the section, do not override.

## Drive layout

Master folder (created once by the skill, pinned in `references/drive-master.json`; never
reuse the one-off batch folder `16jFs9GiCJQNklwXUFhMSeZNPLL3AYto8`):
`Boostly print orders (customstickers.com)`, id `1hSrRZc-ZFTztR8OqQXhcPQBbURaINnIS`,
https://drive.google.com/drive/folders/1hSrRZc-ZFTztR8OqQXhcPQBbURaINnIS, shared
anyone-with-link reader. Inside: `Boostly logos (roll binding stickers)` (six Boostly logo
files), `Print order summary` (Google Sheet, columns Location, Drive folder, Offer, Tables,
Bathroom stalls, To-go label rolls, POP sign sets, Ship to name, Address 1, Address 2, City,
State, Zip), and one folder per location holding the six PDFs and `logos/`.
If `references/drive-master.json` is lost, the script finds the folder by name at the boostly
Drive root before creating a new one.

## Idempotency and receipts

`<RUN_DIR>/print-handoff/handoff.json` holds the Figma target, per-kind page counts and vector
checks, logo hashes, the live facts used, Drive ids and links for the folder and every file,
the summary row action, the draft id, and timestamps. `sheets.json` and `raw-frames.json`
hold the discovery. Reruns re-export only missing pages, keep the merged PDF when its pages
are unchanged (so Drive md5 skip works), update the summary row in place, and never create a
second draft. A changed Figma section after approval: rerun with `--force`, the PDFs are
updated in place on Drive (same file ids), and the draft stays valid because it links
folders, not files.

## Hard rules

- Drafts are never sent by the skill or any agent. Travisse reads and sends them. There is no
  send path in these scripts; do not add one.
- Vector PDFs only, from the REST export. No PNG round trips.
- Never delete anything in Drive. Strays are reported.
- No production writes: the skill reads V2 and writes only Drive, Gmail drafts, and the run dir.
- Never print a token or cookie. Never commit.
- A failed verification (page count, fonts, full-page image, sheet_ids mismatch you cannot
  explain) stops the hand-off; report it, do not upload a bad PDF.

## Report line for closeout-finish

"Print hand-off: folder <link>, <n> PDFs vector OK (<kind> p/p ...), summary row
<appended|updated>, Gmail draft <id> to ckbrandsmktg@gmail.com, cc Colin and Maren (not sent)."
