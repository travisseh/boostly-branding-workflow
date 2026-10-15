---
name: boostly-signage-sheets
description: Generate a Boostly location's full in-store signage set as batched print sheets (Cam's production format) straight to vector PDF with scripts/direct-pdf (the default since 2026-10-15; the Figma section build stays as a fallback). Use at fulfillment time, after branding exists.
---

# Boostly Signage Sheets

Headless replacement for the manual Figma signage workflow Cam runs for each
fulfillment. Given a location, it produces the complete print-sheet set in the
current In-Store Fulfillment Figma file, matching Cam's production format
exactly. This is a DOWNSTREAM step from branding: the location must already
have applied branding (logo + colors); see the `boostly-brand-design` skill
for that pipeline.

## Deliverable contract (Travisse, 2026-08-31)

The output is BATCHED PRINT SHEETS, one Figma frame = one PDF print unit,
inside one account section per location. Ground truth: Cam's Davenport Diner
section, node 2054:699 in the retired In-Store Fulfillment 7
(https://www.figma.com/design/mvSzxcTjVVba0adI4ge06a/In-Store-Fulfillment-7?node-id=2054-699).

## FIGMA TARGET (configuration, not code)

WHICH file new sections go into, the Munchie template section to clone, and
the slot grid live in ONE place: `references/figma-target.json`
(`file_key`, `file_name`, `file_url`, `template_section_id`, `grid
{origin_x, origin_y, col_step, row_step, cols_per_row}`, `previous_files`).
`scripts/lib/figma-target.mjs` loads and validates it; `plan.mjs` copies it
into plan.json as `figma` and prints it; `node scripts/lib/figma-target.mjs
[--slot ROW COL]` prints the resolved target or a slot's x/y. Never type a
file key or template id into a prompt, agent file, or script: read the
config. Existing runs are untouched: their run.json `figma` block carries
the file they were built in, and retired files stay readable (listed under
`previous_files`).

Rotation (a file is "full" when its rows run out or Figma bogs down; File 7
retired 2026-09-22 after six rows): `create_new_file` "In-Store-
Fulfillment-<n+1>", copy the page guides and background, rebuild the Munchie
template section at row 0 col 0 with the SAME node structure (names, sizes,
fonts, qr holders, image fills; 2026-09-22 recipe: serialize the unique
units from the old template, rebuild them with use_figma, upload the logo
PNGs + 8 QR SVG masters with `upload_assets`, clone the masters into the
holders, then prove parity by running one normalized structural hash over
both sections: File 8 template 2:2670 hashed identical to File 7 2320:2,
12354 nodes), run the STROKE GATE on it, move the old entry into
`previous_files`, update the fields, and run `node --test
scripts/lib/figma-target.test.mjs`.

Per location:
- Table sticker sheets (2x2 grid of 900x900 "Join the club!" stickers) and
  review sheets (2x2 of "Let Us Know How We Did!"): 1 promo + 1 review
  sticker PER TABLE, 4 per sheet, pages = ceil(tables/4) each.
- Bathroom sheets: 4 stacked 1300x612 strips per sheet on SOLID band-color
  background ("Your phone's already out…" and "Enjoyed your meal?"), strips =
  bathroom stalls, pages = ceil(stalls/4) per variant.
- 2 POP signs (2550x3300 Letter@300, sign 1500x2100 centered): one solid
  band-color bg with white ink + white QR modules + WHITE-KNOCKOUT logo, one
  white bg with band-color ink + color logo.
- 2 to-go labels (1538x612, white): ALWAYS #000000 text and black QR modules
  (B&W printer, never band color). Layout "A framed QR" (Travisse 2026-10-05):
  TEXT ONLY, NO LOGO. Headline Figtree Bold, left aligned, vertically
  centered in a fixed 860x500 box at x72 y56, letter spacing -2px, line height
  96%, auto-fit from 150 down in steps of 2 (max 3 lines, longest word <= 860,
  floor 56), no trailing arrow. QR in a rounded white tile, 3px inside black
  stroke, r28, 500x500 at x982 y56, QR 468 inside (16px padding). SUBSCRIBE
  headline = the table promo title (plan.json copy.togoPromo, "Get 20% Off",
  "Get $10 Off $20+", phrase offers verbatim); REVIEW headline is exactly
  "Let us know how we did". Geometry in SHEET_FORMAT.togoLabel.
- Header above the section contents: "<Location> (<City>)" Inter Black 132,
  green Inter Bold 150 status label, 1500-wide logo. Generated sets say
  "GENERATED - REVIEW BEFORE PRINT"; flip to "PRODUCTION - DON'T DELETE"
  only after Travisse/Cam blesses the set.
- Section fill #EAEAEA. Copy is Cam's production set ("Join the club!"
  family), NOT the digital-design schema defaults.
- CUT STROKE (Karissa, 2026-09-03: unoutlined stickers are hard to cut):
  every 900x900 table AND review sticker frame, and the 1500x2100 POP sign
  frame on BOTH variants, MUST carry a 1px solid #000000 stroke, strokeAlign
  INSIDE, no dash, set on the OUTER frame itself (not a child rect). This
  matches File 6 reference 2102:218439 and 100% of Cam's production sheets.
  Bathroom strips and to-go labels are NEVER outlined. plan.json carries it
  as tableSticker.stroke/strokeWeight/strokeAlign and popSign.*; the 8/31
  batch (Mario's, Fahrenheit Charlotte, Tony and Tina's, Vito's) shipped
  without it because the Figma build step dropped the stroke, so it is a
  hard gate, not a nicety.
- OFFER COPY (Travisse, 2026-09-03: specific offers on signage get ~2x the
  scans of the generic "Join the club!"; always pass `--offer "<offer_text>"`):
  - Discount offer ("$10 OFF", "20% Off", "Free Dessert"): table promo
    stickers AND both POP signs get the headline `Get <offer>` with OFF
    normalized to Off ("Get $10 Off", "Get 20% Off"), and the POP body becomes
    "Scan to join our text club / for ongoing offers!" (no "VIP"). Sticker body
    stays "Be the first to know. / Receive exclusive deals."
  - Phrase offer that is not a discount ("Unlock the V.I.P Experience",
    "Tillie's Special Offers"): POP title verbatim AND table promo stickers get
    the phrase layout, body = the POP body line. Two sizes, chosen by whether
    the title fits one line at 788px: one-line phrase ("Tillie's Special
    Offers") = title Medium 82 / auto, body SemiBold 50 / 60px at y=216;
    two-line phrase ("Unlock the V.I.P Experience") = title 74 / auto, body
    42 / 60px at y=274 (plan.json `copy.tablePromo.layout: 'phrase'`, geometry in
    SHEET_FORMAT.tableSticker.phraseTitle/phraseBodyPromo, from Travisse's
    hand-tuned Fahrenheit sticker 2154:42413). Review-style phrases ("Had a
    good time? Let us know!") are POP-only; stickers keep the default.
  - Empty or "Join the Club!": Cam's default copy everywhere. This is the
    fallback, not the preference; if the call transcript shows an agreed
    invite/signup offer and the request still says Join the Club, ask
    Travisse whether to use the specific number before building.
  - Review stickers and bathroom strips never change. The to-go SUBSCRIBE
    label headline is the table promo title (no arrow, no logo); the REVIEW
    label keeps Cam's copy. "Get 20% Off!" typed as the offer is normalized to
    the discount form "Get 20% Off".
  `specificOfferCopy()` in plan.mjs is the single implementation.

All exact geometry (sheet dims, sticker anatomy, diagonal band path, QR tile
sizes, fonts) lives in SHEET_FORMAT inside `scripts/plan.mjs`; that is the
single source of truth; do not re-measure unless the format visibly changed.

## Section placement (Cam's 3x10 grid)

Each fulfillment file is a grid of account sections, 10 columns per row
(File 7 grew to six rows before it was retired; start a NEW file when Figma
bogs down). The grid comes from `references/figma-target.json` (`grid`:
origin_x/origin_y, col_step/row_step 16243, cols_per_row 10; row 0 col 0 is
the template; `plan.json.figma.grid` and `SHEET_FORMAT.sectionGrid` mirror
it). Place each new section at the next free slot, row-major:
x = origin_x + col*col_step, y = origin_y + row*row_step. The nominal slot
is a starting estimate only: Cam reorganizes files between runs, sections
get deleted, and other agents close out concurrently. Measure the live
canvas first: list the top-level sections with their x/y, derive the
occupied slots, and take the next genuinely unoccupied one. Placing at
stored coordinates unverified has nearly overwritten a sibling section. After generating, put the section
canvas URL into the fulfillment request's internal notes (Cam's lookup
convention) with `boostly-links fulfillment note <requestId> --append
'Figma signage: <section url>' --apply` (boostly-instore-link-settings).

## PREFLIGHT (mandatory: at branding start, and before plan.mjs)

Every discrepancy found by hand between 2026-09-03 and 2026-09-05 (wrong offer
on the sign, copy the customer rejected, table/stall counts the customer never
asked for, missed calls, a 20% keyword after the customer agreed 25%) came
from comparing three sources: the fulfillment request, what the account's
signup actually pays, and the call transcripts. `preflight.mjs` does that
comparison in one run. Run it FIRST: `boostly-brand-design` Quick start step 2
runs it at branding start (before Fable), `boostly-box-fulfillment` runs it for
every new request, and it runs again here before plan.mjs.

```bash
node ~/.claude/skills/boostly-signage-sheets/scripts/preflight.mjs \
  --location-id <v2-location-id> --run-dir <run-dir> [--since YYYY-MM-DD] [--days 45] [--llm] [--json]
```

It writes `<run-dir>/preflight/preflight.json` + `preflight.md` and, through
the two scripts it calls, `<run-dir>/call/find-calls.json`, one
`<run-dir>/call/<date>-<meeting-id>.txt` per matched transcript, and
`<run-dir>/call/call-facts.json` + `call-facts.md`. The summary prints the
request (offer_text, quantities from fulfillment_items, thread ts, session),
the signup offer (SUBSCRIBE_ keyword -> promotion), all account promotions,
the invite template, every matched call with verbatim topic lines, FLAGS, the
fixed "Call facts" block, "Questions for the CSM", and "Suggested build
inputs" (`--offer/--tables/--stalls` plus the copy plan.mjs will produce).

The two pieces can also run alone:

- `scripts/find-calls.mjs --location-id <id> --out <run-dir>` (or `--name
  "<business>" --city <city> --contact "<name>" --email <e> --domain <d>` with no
  DB): fetches the last 45 days of AskElephant once (`--all`; the script's own
  `--person` filter is local, so this equals one query per rep in
  `KNOWN_REPS`: Jonathan Watkins, James Lowder, Sterling Evans, Ella Van Horn,
  Kole Minnoch, Cooper Bucalo, Evan Fuller as the AE owner on Sterling demos;
  `--mode per-person` runs it literally), then matches by contact email,
  website/email domain, contact names from account users + enrollment
  tfv_first_name/last_name + contract_signed_by + shipping recipient (as AE
  contacts, transcript speakers, or in the title), the normalized business
  name in the title/company/transcript, and city. Every match reports id,
  title, date, duration, has_transcript, reps on the call, and a
  classification (sales demo / launch prep / scheduling / other). Calls of the
  same brand at another store ("Fox's Pizza Den (Robinson)") and webinars are
  listed separately and never used. A last name alone ("Davis") or a
  possessive first name ("Denise") never matches by itself.
- `scripts/call-facts.mjs --run-dir <run-dir> [--llm] [--llm-model fable]`:
  reads the saved transcripts and extracts, deterministically with regex,
  the agreed invite offer (the LAST confirmation wins: Fox's 20 -> 25, Munchie
  20 -> 30), the birthday offer (free item, or declined), tables / stalls /
  tap-card counts (launch-prep calls only; sales demos pitch the box
  generically), "Join the club" pushback or sign wording, "combine the lists",
  and a "not discussed" list. `--llm` adds one bounded Claude pass (topic lines
  only, at most about 14k chars) for fields regex left empty; it may return
  null, never invent, and its answers are labeled `llm:<model>`. Then it
  compares with the live DB and emits the flags below plus drafted CSM
  questions (plain text, no em dashes). Nothing is auto-applied.

Flags and what to do:
- NO_CALL: nothing matched. Say "checked/empty" in the note; build from the
  request; ask the CSM the drafted question.
- TRANSCRIPT_PENDING: a call matched but AskElephant has no transcript yet
  (Astoria 9/4 launch prep the day after). This is NOT NO_CALL: quantities
  and offer stay unconfirmed, the note says "call exists, transcript pending",
  and a rerun of preflight re-checks for the landed transcript (the AE window
  is cached in `preflight/ae-dump.json`; pass `--no-cache` to refetch).
- OFFER_MISMATCH: the call agreed an offer (or the sign names one) the signup
  keyword does not pay. The flag carries the exact command, e.g.
  `boostly-links offer set <loc> --title "25% OFF" --code SAVE25 --value 25
  --cookie-file <cookie-file> --apply`. Run it BEFORE print; never print a sign
  that promises a coupon the page will not give. Preflight does not apply it;
  the orchestrator (or Travisse) does. Hold when the transcript is ambiguous
  (Vito's 40% was a question about the invite text, not a decision).
- BIRTHDAY_PROMO_MISSING: the call agreed a free item for birthdays and no
  birthday promotion exists; the flag carries a `promotions create` proposal.
  Ask the CSM; the birthday rotation wiring is app-side.
- QUANTITIES_UNCONFIRMED: one line. Request quantities are the wizard
  defaults (10 tables / 6 stalls / 10 tap cards) and no transcript confirms
  them. Put that line in the note verbatim; do not present defaults as chosen.
- QUANTITIES_CONFLICT / TABLES_MISMATCH / BATHROOM_CONCERN: CALL QUANTITIES
  BEAT WIZARD QUANTITIES. Build (or trim) to the transcript count and say so in
  the note. "Don't want stickers on the tables" / shared bathroom / "start
  with the tables" are judgment calls for the CSM, not a reason to guess: list
  them as questions.
- COPY_REJECTED: customer pushed back on "Join the club"; use their wording
  (phrase layout) or the specific offer. Never ship the generic default.
- GENERIC_DEFAULT: request says Join the Club (or is empty) but a call agreed
  an offer; ask Travisse whether to use "Get <offer>" once the keyword pays it.
- COMBINE_LISTS: multi-store customer wants one list; check text-club scope.
- INVITE_NOT_LOADED: a call offer (often a rotation item like "free
  breadsticks") has no promotion; informational unless it is the signup offer.
- MULTI_LOCATION: sibling shipped before; inherit account branding per the
  boostly-brand-design "ADDING A LOCATION" rule.

Paste the "Call facts" block and the CSM questions into the review note that
post-review posts and into the runner report (fixed format, see
boostly-box-fulfillment Finish). Validation sets: 2026-09-03
<project>/preflight-validation/{aunt-tillies,butt-hutt,bunker-grille,fh-pizza-franklin};
2026-09-08 `exp/call-preflight/` under the Fox's Chicora, Astoria, Denise's,
and Midnight Munchie run dirs (Fox's: 9/3 Sterling demo + 9/4 Jonathan launch
prep, 25% + free dessert; Astoria: 8/31 Cooper call + 9/4 launch prep
transcript pending; Denise's: 9/3 Ella + Sterling demo only; Munchie: 9/2
launch prep, 30% + free cookie; zero false matches after the sibling-brand,
surname, and possessive guards).

## How to run

0. PREREQUISITE CHECK: touchpoints and offers must exist first. If the v2
   signage endpoint returns an empty signage list (wizard-created locations
   whose onboarding never completed do this), do NOT skip or fabricate:
   provision them via the `boostly-instore-link-settings` skill's
   `instore-init` command group (documented in that SKILL.md), in this order:
   `instore-init status <location-id>` (diff), then `provision-events`,
   `provision-promotions <account-id>` (skip if the account already has
   promotions; without one the Join-the-Club QR pages have no offer),
   `provision-signage`, `provision-objectives`. Dry-run first, `--apply`,
   `auth ensure-location` before every write. Re-hit the signage endpoint to
   confirm the 7 touchpoints resolve before building sheets.
1. Emit the plan:
   ```bash
   node ~/.claude/skills/boostly-signage-sheets/scripts/plan.mjs \
     --location-id <v2-location-id> --account-id <v2-account-id> \
     --logo <color-sticker-logo.png> [--band #RRGGBB] \
     [--tables N] [--stalls N] --out-dir <run-dir>
   ```
   Defaults: tables=32, stalls=4 (Davenport-observed), but NEVER trust the
   defaults when the request exists: read the real counts from the
   fulfillment_items rows (tables = table-placement sticker quantity, stalls =
   bathroom-placement sticker quantity per variant; the Block Kit message only
   surfaces Tables, not stalls; the 2026-09-01 batch shipped 4-stall sheets
   against 6-stall requests this way).
   Auth: reads BOOSTLY_V2_API_BASE + BOOSTLY_V2_API_KEY from the
   brand-extractor-figma .env (path hardcoded in the script). The endpoint
   needs BOTH `Authorization: Bearer` AND `x-api-key`; never print secrets.
2. Execute the plan in Figma via the Figma MCP (`use_figma` +
   `upload_assets`) in the file named by `plan.json.figma.file_key`, by
   cloning `plan.json.figma.template_section_id` (the Munchie template) and
   retargeting it (rename, band recolor, logo fills, QR holders, copy, trim).
   MANDATORY: read skill://figma/figma-use/SKILL.md via
   ReadMcpResourceTool first and pass skillNames "resource:figma-use".
   plan.json carries the sheet list (names, positions, sizes, per-sheet
   sticker placements), copy, QR SVG file references, format constants, and
   the `figma` target block.
   IMAGE TRANSPORT (2026-09-29): logo and QR images go into Figma with
   `upload_assets`, never as typed base64. Logo PNG: one `upload_assets` call
   with `fileKey`, `count: 1`, `nodeIds: ["<one target node>"]`, and that
   node's existing `scaleMode` (the signage logo fills are FIT); POST the file
   bytes to the returned single-use URL with curl
   (`curl -sS -X POST -H "Content-Type: image/png" --data-binary @<png> "$URL"`,
   URL kept in a shell variable read from a 0600 file, never echoed); confirm
   the returned `imageHash` equals the local SHA-1 (`shasum -a 1 <png>`), a
   mismatch is a failed upload; then copy that hash onto the other fills with
   one `use_figma` call, keeping each fill's scaleMode, and screenshot a sheet.
   QR SVG masters upload the same way with `Content-Type: image/svg+xml`; they
   import as vector trees (`nodeIds` and `scaleMode` do not apply) and are
   cloned into the holders, then decoded to verify. Never print, log, or paste
   the submit URL or any Figma asset URL. Never resend a payload that a safety
   classifier stopped, in any form or size: stop and report. The chunked
   base64 method (FNV-checked chunks through `use_figma`) is a last resort
   only when the `upload_assets` tool is missing from the session, and the
   report must say it was used. The `closeout-location` agent has the tool.
3. Verify with get_screenshot against the Davenport reference composition
   before reporting done.
4. STROKE GATE (mandatory, run before flipping anything to PRODUCTION):
   inventory the new section with use_figma and fail the run if any outlined
   type lacks the stroke. Structural match, not name match (sticker names
   vary by run):
   ```js
   const sec = await figma.getNodeByIdAsync('<section-id>');
   const bad = [];
   for (const f of sec.findAll(n => n.type === 'FRAME' && ((n.width === 900 && n.height === 900) || (n.width === 1500 && n.height === 2100)) && /Print Sheet/i.test(n.parent && n.parent.name || ''))) { // outer frames only: the sticker's inner band frame is also 900x900
     const s = f.strokes.find(p => p.type === 'SOLID');
     const ok = s && s.color.r === 0 && s.color.g === 0 && s.color.b === 0 && f.strokeWeight === 1 && f.strokeAlign === 'INSIDE';
     if (!ok) { f.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; f.strokeWeight = 1; f.strokeAlign = 'INSIDE'; bad.push(f.id); }
   }
   return { fixed: bad };
   ```
   Only OUTER frames (direct children of a Print Sheet) count; the inner band
   frame inside each sticker is also 900x900 and must not be stroked.
   Report `fixed` (should be empty on a correct build); a non-empty list
   means the build step is dropping the stroke and needs fixing at source.

## DIRECT PDF RENDER (no Figma; THE DEFAULT since 2026-10-15, parity-proven)

`scripts/direct-pdf/` builds the same section as the clone-and-retarget above as a node tree
from `references/template-spec.json` (the File 9 Munchie template recipe, struct-hash identical
to File 8 2:2670) and renders every "Print Sheet - " frame straight to vector PDF with pdf-lib:
no Figma file, no MCP, no network. Output drops into print-handoff unchanged (same six kind
files, `_vector-pages/`, `sheets.json`). Travisse asked for it 2026-10-15 ("removes figma from
the default pipeline and just generates the signage pdfs directly") and flipped the default the
same day after reviewing the Scoops, Pig & Parrot and Slice parity sheets: the `closeout-location`
agent renders into `RUN_DIR/print-handoff/` and Travisse approves `review-sheets.png` (one
contact sheet of every page, `--preview`, on by default) instead of a Figma screenshot; the
hand-off re-renders from the recorded inputs. The Figma clone-and-retarget above stays as the
named fallback (`print-handoff.mjs --figma`, agent "Figma fallback" section).

```bash
D=~/.claude/skills/boostly-signage-sheets/scripts/direct-pdf
node $D/direct-pdf.mjs --run-dir <RUN_DIR> [--out <dir>] [--tables N] [--stalls N] [--offer "<text>"] \
  [--band #RRGGBB] [--logo <png>] [--pop-primary-logo <png>] [--name "<Location (City)>"] [--date YYYY-MM-DD]
# proof against a Figma export of the same section (read-only on Figma):
node $D/parity.mjs --run-dir <RUN_DIR> --figma-pages <dir of per-page Figma PDFs> \
  [--live-tree <REST nodes.json> --section <id>] [--dpi 300] [--threshold 32]
node --test $D/direct-pdf.test.mjs
```

Defaults: name from run.json `figma.header_title`, tables/stalls from `figma.quantities`, offer
from `request.offer_text`, band/copy/QR svgs/logo from `signage/plan.json`. The POP primary
logo defaults to plan.mjs's white knockout; pass `--pop-primary-logo` when the closeout chose
the card asset instead (Scoops). Writes `<out>/section.json` (the tree), `build-log.json`,
`sheets.json`, the kind PDFs and `_vector-pages/`. Default `--out` is `<RUN_DIR>/signage/pdf-direct`.

What it reproduces (lib/): `retarget.mjs` = clone-head + figma-trim + figma-recopy + fills +
stroke gate as pure JSON transforms; `text-layout.mjs` = Figma's text engine for the production
styles (hhea metrics, baseline = round(half-leading + ascent), space wrapping, centered lines,
letter spacing, GPOS kerning via fontkit, auto-width boxes rounded up, Apple Color Emoji bitmap
for the bathroom arrow); `qr-nodes.mjs` = Figma's SVG import of the styled QR (GROUP of
module VECTORs + three evenodd finder pairs, quadratics to cubics, scaled to the holder);
`pdf-render.mjs` = one page per sheet at frame size in pt, ICCBased sRGB fills like Figma's
export, INSIDE strokes as even-odd rings, the dashed cut-guide as a dashed stroke, real text in
embedded Figtree subsets (Figma exports glyph outlines plus an invisible Type 3 layer), logo
PNGs embedded lossless at full source resolution (Figma re-encodes them as JPEG).
Fonts ship in `references/fonts/` (Figtree Medium/SemiBold/Bold, OFL); the emoji needs
macOS Apple Color Emoji.

Parity proof 2026-10-15 (`<RUN_DIR>/signage/pdf-direct/parity/parity.md`): Scoops Ice Cream
(3:2, 10 pages) and The Pig & Parrot Hoboken (5:2, 14 pages): same page set and sizes, 0
geometry mismatches against the live REST tree (max 0.004 pt over every node incl. QR
modules), text identical, every QR decodes to the plan link (22/22, 36/36), raster diff at
300 dpi 0.06 to 0.28% of pixels (antialiased edges only; max 1 to 2 px ink-box drift on text,
0.14 pt on the 105-glyph POP legal line). Known differences, all intentional: real embedded
TrueType text instead of outlines, PNG logos instead of JPEG, no invisible text layer.

run.json records it in the `signage` block (`signage.direct`: status, out_dir, preview_png,
pages, kinds, inputs, approved); the checklist, the review canvas, the status board and the
public site read that block next to `figma`. Runs approved in Figma before the flip (Shawarma
Inn 14:2, Surfin Betty's Downtown 12:3/12:2) finish with `print-handoff.mjs --figma`.

## RECOPY / TRIM existing sections

Two use_figma templates retrofit an ALREADY BUILT section without re-deriving
the code. Print the filled-in code with the CLI, paste it as the `code` of a
single use_figma call (skillNames "figma-use"), read the returned summary, and
screenshot one sticker + one POP to confirm.

- Recopy (offer copy on table promo stickers + both POP signs):
  `node scripts/figma-recopy.mjs --section <id> --offer '<offer_text>' [--mode auto|discount|phrase|generic]`
  MODE auto = the plan.mjs specificOfferCopy() rules: discount -> "Get <offer>"
  (OFF -> Off) in the default 90/100 + 50/60 layout with the no-VIP POP body;
  phrase -> verbatim title, one-line 82/50 at y=216 if it fits 788px, else
  two-line 74/42 at y=274, POP title auto-shrinks from 140 in steps of 10 to
  fit one line, and a phrase that still wraps at 80 becomes a two-line POP
  title (largest of 130..80 holding two lines, lh 1.15em) with the body
  pushed 40px under it (Coriander "Buy One Get One Chicken Tikka Masala",
  2026-09-18: stickers two-line 74 at 178px tall, POP 130/150 two lines,
  body at y=520, QR untouched at 802); review-style phrases go on the POP
  only; generic restores Cam's defaults. Idempotent: every run re-lays out title and body, so you can
  go discount -> phrase -> generic without stale geometry. Review stickers,
  bathroom, and the to-go REVIEW label never change; figma-recopy does not yet
  touch the to-go SUBSCRIBE headline, set it in-plugin from plan.json
  copy.togoPromo (style A auto-fit: Figtree Bold 150 down to 56 in steps
  of 2, max 3 lines, 860x500 box, no arrow, no logo).
- Trim (sheet counts):
  `node scripts/figma-trim.mjs --section <id> --tables N --stalls N [--allow-zero]`
  Deletes table/review pages beyond ceil(N/4), removes extra stickers from the
  last page, same for bathroom pages by stalls, and re-tidies rows. Only
  removes; it errors instead of fabricating if N needs more than exists.
  Refuses tables=0 without --allow-zero.
- Both end with the STROKE GATE and return `strokeGateFixed` (must be empty).
- Order: trim first, then recopy. CALL QUANTITIES BEAT WIZARD QUANTITIES: when
  preflight shows a table/stall count from the transcript, trim to it and say
  so in the review note (Fahrenheit "let's keep four", Tillie's 10 tables not
  incl. the bar vs a wizard 20).
- Test evidence: <project>/figma-ops-validation/ (six scratch runs, 2026-09-03).

## POST REVIEW (default handoff)

Who posts (2026-09-29): in the fulfillment close-out the post is made by the
`closeout-finish` agent, after Travisse approves the Figma signage, from the
`slack-note.txt` the closeout agent wrote. Exactly one post per location.

Every fulfillment subagent posts its own preview to the request's Slack thread
as its LAST step, unless the lead says otherwise. Do not hand review text back
to the lead; the thread is the handoff (Travisse, 2026-09-03: "why aren't the
previews in Slack?").

```bash
node ~/.claude/skills/boostly-signage-sheets/scripts/post-review.mjs --run-dir <run-dir>          # dry-run
node ~/.claude/skills/boostly-signage-sheets/scripts/post-review.mjs --run-dir <run-dir> --apply  # post
```

- Thread ts resolution: `--thread-ts`, else `--permalink`, else the location's
  `fulfillment_requests.slack_thread_ts` (via `--location-id` or manifest.json).
  It verifies the parent message exists with conversations.replies and refuses
  to post otherwise. NEVER guess a ts; a guessed ts posts top-level (happened
  once, had to be deleted).
- Posts, in order, skipping missing with a warning: proof.png, signage/shots/
  table-p1.png, pop-primary.png, pop-light.png, bathroom-p1.png. `--files`
  overrides. Note = `--note` file or `<run-dir>/slack-note.txt`; em dashes are
  rewritten; empty note refuses.
- Run dry-run first and read it (bot user, channel, thread ts + source,
  verified parent, files + sizes, note), then `--apply`. Writes
  `<run-dir>/slack-post.json` with message ts and file ids.
- The note should include the preflight flags, the fixed "Call facts" block
  from `<run-dir>/call/call-facts.md`, and the CSM questions (see PREFLIGHT).
  No em dashes anywhere in the note or in files this skill writes.

## Gotchas (all learned the hard way)

- LOGO INPUT is the branding run's COLOR sticker logo (the on-white variant
  from the boostly-brand-design sticker rule, recorded as `sticker_logo` in
  the run manifest). A run dir can also hold an earlier one-color
  sticker-logo.png; use the color variant the manifest names.
  ON-WHITE GATE (2026-09-21, The Place Pizza panel, Arnold's cream badge):
  plan.mjs runs `gates.ts check --asset <logo> --color #FFFFFF --surface
  sticker` on its `--logo` input before writing the plan and refuses a HOLD
  (`opaque_panel_ground`, `component-contrast` under 3.0 on text). Fix the
  asset (cut it from its ground, or take the authored dark variant of the same
  mark); `--skip-logo-gate` exists only for a recorded shipped-asset override.
- plan.mjs auto-generates a white-knockout logo from the color logo's alpha
  for the solid-bg POP sign (a color logo vanishes on the band color). BUT
  judge it before using it (Palio's lesson 2026-08-31): for a solid-disc or
  filled-shape mark the alpha knockout is an identity-less white blob: use
  the color logo on the solid sign when it holds >= 3.0:1 against the band,
  and only fall back to the knockout for line/text marks that vanish.
- QR VARIANT CROSSING TRAP (Palio's 2026-08-31): qr-pop-primary.svg (band-
  color modules) belongs on the WHITE/light POP sign; qr-pop-white.svg (white
  modules) belongs on the SOLID band-color sign. The names describe the ink,
  not the sign. Zoom-verify both POP signs after placement; this was crossed
  once and only caught in screenshot review.
- QRs are the product2 plugin's own styled generator (generateStyledSvgQR
  port: rounded modules, styled finders, ECC M) uploaded as SVG vector
  trees, never plain square-module QRs. Layout QR boxes are OUTER boxes
  including the 2-module quiet zone (ink = box * modules/(modules+4)).
- Fonts: Figtree Medium/SemiBold (production print faces). loadFontAsync
  before any text write. Set no-wrap with explicit line breaks.
- Band color follows the sticker band rule from boostly-brand-design:
  highest-contrast-on-white authored role >= 3.0:1, web primary preferred.
- Do not label a generated set "PRODUCTION" before it is reviewed.
- When writing the Figma build code, set `strokes`, `strokeWeight`, and
  `strokeAlign` on the sticker/POP frame in the same call that creates it.
  The 8/31 batch lost the outline because the builder only applied `fills`.

## Relationship to other skills

- `boostly-brand-design` produces the inputs (applied branding, sticker
  logo, band color) and its watcher may invoke this skill as the fulfillment
  step after branding applies. Its Quick start step 2 runs this skill's
  `preflight.mjs` at branding start, so by signage time `<run-dir>/call/` and
  `<run-dir>/preflight/` usually exist; rerun preflight anyway (transcripts
  land late, keywords get repointed) before plan.mjs.
- `boostly-box-fulfillment` runs `preflight.mjs` for every new request and
  carries the "Call facts" block in its runner report.
- `scripts/measure-refs.mjs` is the calibration tool used to measure Cam's
  shipped output; only needed if the production format drifts.
