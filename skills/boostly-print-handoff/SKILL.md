---
name: boostly-print-handoff
description: Hand a closed-out Boostly location's signage and sticker print files to customstickers.com (CK Brands). Renders the six print units as VECTOR PDF with the direct renderer (boostly-signage-sheets/scripts/direct-pdf, the default since 2026-10-15; `--figma` exports the location's Figma section through the REST API instead), uploads the six PDFs plus logos to a per-location Google Drive folder under the vendor master folder (at the closeout's signage-review stop since 2026-10-19, upload only), upserts the location's row in the "Print order summary" sheet, emails the vendor (a Gmail draft that is sent in the same step since 2026-10-14), and stamps the row's "Order placed (email sent)" date. Use at closeout-finish, right after the Slack post, or when Travisse says "send the print files to customstickers" or "print hand-off for <location>".
---

# Boostly Print Hand-off (customstickers.com)

customstickers.com (CK Brands Marketing, contact Gracie, ckbrandsmktg@gmail.com, cc Colin Dunn
<colin@printiverse.com> and Maren Dunn <maren@customstickers.com>) prints all
Boostly signage and stickers from 2026-10. Every location close-out ends with this hand-off:
vector PDFs in Drive, a summary row, and the vendor email, sent (Travisse 2026-10-14: no draft waiting on him).

## When it runs

Two stages (Karissa 2026-10-19: reviewers approve the real PDFs in Drive, not a contact sheet):

1. **Closeout, signage-review stop (`closeout-location`).** Right after the direct render
   (`export-direct.mjs`, which writes handoff.json), BEFORE the STOP for signage review:
   `node $S/drive-upload.mjs --run-dir <RUN_DIR> --skip-summary`. Upload only: the six PDFs and
   `logos/` go to the location's Drive folder and `drive.folder_link` lands in handoff.json (the
   review site's Print files section links it). No summary row (`--skip-summary`), no vendor
   email (drive-upload.mjs never emails). Review edits: rerender and rerun the same command; the
   files are replaced in place (same ids, same folder link). The vendor does not act on a folder
   until the email arrives.
2. **`closeout-finish`, after approval**, right after the single Slack post (step 5), before or
   alongside branding complete: `print-handoff.mjs --run-dir <RUN_DIR> --live`. Its drive-upload
   rerun is idempotent (md5 skip, in-place update for changed files), so this stage adds the
   "Print order summary" row and the vendor email. The finish agent records the draft id in its
   report. The summary row and the email never happen before signage approval.

It can also be run by hand for any run dir whose run.json `signage.direct` (or `figma`) block
is `built`.

## Commands

Working directory: `/Users/travisse/Programming`. Scripts read `FIGMA_TOKEN` from
`/Users/travisse/Programming/.env` and the boostly Google OAuth token from
`~/.config/google-tools/auth.js` inside the scripts only. Never print, echo, cat, or log either.

```bash
S=~/.claude/skills/boostly-print-handoff/scripts
# Whole hand-off (export, logos, Drive, summary row, email), idempotent. --live is required for
# Drive and email; without it (or with --offline/--dry-run/--scratch) it stops after the export:
node $S/print-handoff.mjs --run-dir <RUN_DIR> --live
node $S/print-handoff.mjs --run-dir <RUN_DIR> --live --figma   # a run approved as a Figma section
# Review stage (closeout, before approval): upload only, no summary row, no email:
node $S/drive-upload.mjs  --run-dir <RUN_DIR> --skip-summary
# Steps on their own:
node $S/export-sheets.mjs --run-dir <RUN_DIR> [--section <id[,id]>] [--file-key <key>] [--force] [--kinds <kind[,kind]>]
node $S/drive-upload.mjs  --run-dir <RUN_DIR> [--offline] [--skip-summary]
node $S/draft-email.mjs   --run-dir <RUN_DIR> [--redraft] [--print-only] [--no-send]
```

Flags: `--kinds <kind[,kind]>` (2026-10-14) exports only the listed kinds (`table-stickers`,
`review-stickers`, `bathroom-stickers`, `bathroom-review-stickers`, `pop-sign`, `togo-label`); the
ad hoc path passes the ordered kinds so a POP-only order ships the POP PDF alone and the others
read "not included". `--section` / `--file-key` override run.json `figma.section_node_id` / `figma.file_key`
(comma-separate several sections when a location spans more than one, in grid order);
`--force` re-exports pages that already exist; `--offline`, `--dry-run` or `--scratch` on print-handoff.mjs STOP AFTER THE EXPORT: no Drive
upload, no summary row, no email (2026-10-15 safety rule; when v2-db is down run `drive-upload.mjs --offline`
by hand, which only swaps live facts for run.json ones); `--redraft` makes a new
draft even though one is recorded; `--print-only` prints the email body without drafting; `--no-send` creates the draft but leaves it unsent (the pre-2026-10-14 behaviour, only when Travisse asks for a draft).

Default export since 2026-10-15 ("flip it", Travisse): `export-direct.mjs` renders the six
PDFs from `signage/plan.json` through `boostly-signage-sheets/scripts/direct-pdf` (no Figma, no
network) into `print-handoff/` with the same files and handoff.json blocks (`source: "direct"`,
`direct.inputs`), then drive-upload and the email run unchanged. The closeout already rendered
there for Travisse's review, so the finish rerun REUSES the recorded `direct.inputs` (logos,
counts, offer, band, date) unless a flag overrides them. It REFUSES a run dir whose
print-handoff holds a Figma export (drive-upload updates the vendor's files in place; `--force`
only when that hand-off is to be replaced). `--figma` selects export-sheets.mjs instead, for a
run whose approved signage is a Figma section. Build overrides pass through: `--tables --stalls
--offer --band --logo --pop-primary-logo --date`. Drive and email run only with an explicit
`--live`. `node --test scripts/print-handoff.test.mjs` proves the dry flags make zero Drive calls. Travisse flips the default after reviewing the parity proof.

Prerequisites: poppler (`pdfinfo`, `pdffonts`, `pdfimages`, `pdfunite` on PATH), the
`v2-db` CLI, `~/.config/gmail-tools/gmail.js` with the `boostly` account.

## What each step does

1. **export-direct.mjs** (default) renders the sheets, see the flag text above. **export-sheets.mjs** (`--figma`): reads the section(s) through `GET /v1/files/<key>/nodes?ids=<section>&depth=2`,
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
   `logos/` with md5 skip (same bytes) or in-place update (changed bytes); only the kinds the
   section actually has are required (a zero-table location ships four PDFs, and the absent
   kinds are recorded as `drive.not_included_kinds` and read "not included" in the draft), reports stray files
   in the vendor folder but never deletes, then upserts the location's row in the
   "Print order summary" Google Sheet (keyed on the Drive folder name) through the Sheets
   API with `valueInputOption=RAW`. The existing Boostly Drive OAuth scope authorizes this
   API too; no separate Sheets scope or CSV conversion is needed. Only the matching row
   in columns A:M is written (or appended); other rows, extra columns, tabs, and formatting
   remain untouched. New sheets receive the header and first row through the same typed
   writer. Quantities stay numeric; ZIP/postal codes stay literal strings, including leading
   zeroes, ZIP+4, and international codes. The writer validates headers and unique row keys,
   then verifies unformatted stored values and types in the response before continuing.
   Facts are LIVE: ship-to from `locations.shipping_*`, quantities from `fulfillment_items`
   (tables = max(table subscribe, table review), stalls likewise, to-go rolls = sum of to_go
   rows, POP sets = signage quantity), offer from `fulfillment_requests.offer_text`.
3. **draft-email.mjs**: writes `print-handoff/draft-body.txt` and creates a Gmail DRAFT via
   `node ~/.config/gmail-tools/gmail.js draft boostly ckbrandsmktg@gmail.com "<subject>" "<body>" --cc "<VENDOR_CC>"`,
   where `VENDOR_CC` (exported from the script) is Colin Dunn <colin@printiverse.com> and
   Maren Dunn <maren@customstickers.com>. The `Cc:` line is also written under `To:` in draft-body.txt.
   Subject `Boostly print order: <Location name>`. Body (short, since 2026-10-12): one-line intro,
   location folder link, quantities, offer, ship-to, master folder link, the summary-sheet line,
   signed "Travisse". No file list, no vector-PDF explanation, no "let me know" closer. Plain
   text, no em dashes, no corporate filler.
   Right after a successful `drafts send` it stamps the summary row's column N, "Order placed
   (email sent)", with the send date as `YYYY-MM-DD` in Mountain time (Gracie asked for this on
   2026-10-14 so no order is missed). The stamp is keyed on the Drive folder name like the row,
   writes the N1 header once when blank, refuses any other N1 text, and verifies the readback.
   A stamp failure never loses the send: it is recorded as `draft.order_placed_error` and the
   next run retries (a sent draft with no `draft.order_placed` is stamped on rerun). A
   `--redraft` resend overwrites the date with the new send date and reports the previous one.
   An existing `draft.id` in handoff.json means no second draft unless `--redraft` (the old id
   is kept under `draft.previous`). To inspect or remove a stale draft by id:
   `node ~/.config/gmail-tools/gmail.js drafts list boostly` and `drafts delete boostly <id>`
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
State, Zip, Order placed (email sent)), and one folder per location holding the six PDFs and `logos/`.
The row writer fills A:M; column N is filled only by draft-email.mjs after the send, so a blank
N means the vendor email has not gone out. The 15 rows that predate the column were backfilled
from sent mail on 2026-10-14 (12 sent by hand on 2026-10-13, 3 by the script on 2026-10-14).
If `references/drive-master.json` is lost, the script finds the folder by name at the boostly
Drive root before creating a new one.

## Idempotency and receipts

`<RUN_DIR>/print-handoff/handoff.json` holds the Figma target, per-kind page counts and vector
checks, logo hashes, the live facts used, Drive ids and links for the folder and every file,
the summary row action, the draft id, the send receipt, the `order_placed` stamp (date, row,
range), and timestamps. `sheets.json` and `raw-frames.json`
hold the discovery. Reruns re-export only missing pages, keep the merged PDF when its pages
are unchanged (so Drive md5 skip works), update the summary row in place, and never create a
second draft. A changed Figma section after approval: rerun with `--force`, the PDFs are
updated in place on Drive (same file ids), and the draft stays valid because it links
folders, not files.

## Postal-code regression checks

Run `node --test ~/.claude/skills/boostly-print-handoff/scripts/lib/drive.test.mjs`.
These tests mock every API call and forbid network access. They cover initial creation,
updates, append/retry, `07940`, `00501`, `84043`, ZIP+4, international postal codes, numeric
quantities, preservation of unrelated cells, and the column N order-date stamp (header once,
keyed row only, A:M untouched, refusals, Mountain-time date).

Never restore CSV-to-Sheet conversion or use display-only ZIP formatting. Store the postal
code as text with RAW writes. Numeric postal input or a mismatched readback must stop the
handoff, not silently guess or pad missing digits. This prevents future loss; existing
incorrect postal values require comparison with the source address and a separate correction.

## Hard rules

- The vendor email is sent by draft-email.mjs itself (Gmail draft, then `drafts send`) since 2026-10-14.
  Before that, drafts waited for Travisse; `--no-send` restores that only when he asks for it. A recorded
  draft that is still unsent is sent on the next run; a sent one is never sent twice (`draft.sent`).
- Vector PDFs only, from the REST export. No PNG round trips.
- Never delete anything in Drive. Strays are reported.
- No production writes: the skill reads V2 and writes only Drive, Gmail (one draft, sent), and the run dir.
- Never print a token or cookie. Never commit.
- A failed verification (page count, fonts, full-page image, sheet_ids mismatch you cannot
  explain) stops the hand-off; report it, do not upload a bad PDF.

## Report line for closeout-finish

"Print hand-off: folder <link>, <n> PDFs vector OK (<kind> p/p ...), summary row
<appended|updated>, vendor email sent (draft <id>, message <id>) to ckbrandsmktg@gmail.com, cc Colin and Maren,
order placed <YYYY-MM-DD> stamped in column N."
