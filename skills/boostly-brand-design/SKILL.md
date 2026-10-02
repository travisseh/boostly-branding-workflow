---
name: boostly-brand-design
description: Build deterministic branding evidence and mechanical QA for a Boostly V2 location, use Fable only for logo/palette/composition judgment, render a production-parity proof, optionally write through guarded V2 actions, and capture reviewer feedback. Use when Travisse asks to brand a location, digitize a tapcard/boosted-box request, fix a shipped logo, review Cam's branding feedback, or run the brand pipeline on new locations.
---

# Boostly Brand Design Pipeline

Given a V2 `location_id`, deterministically gather and rank branding evidence, run mechanical
asset/contrast/edge gates, and render proofs. Fable chooses among the evidence and judges
palette/composition; it does not fetch assets, edit pixels, run QA, write production, or draft
Slack/Notion output. Built and battle-tested across ~60 gold-case eval runs; the brief and tool
harness encode every failure a human flagged.

## Bundled files (this skill directory)

- `references/tapcard-design-examples.pdf`: the 16-card quality bar (see QUALITY BAR rule).

- `references/subagent-prompt-template.md`: the launch prompt for the Fable judgment.
  Substitute the placeholders and don't rewrite the body: the brief, the evidence packet's
  `fable_contract`, and `validate-fable-decision.ts` are tuned to it.
- `references/case-studies.md`: real failures with pixel-level diagnoses and the gate/rule
  each became. Read before diagnosing any new flaw; the answer pattern is here. The cases are
  records; where a case's "rule" line and this file differ, this file is current.
- `references/example-manifest-river-grille.json`, `references/example-manifest-paolos.json`: real production manifests showing the expected shape (proposed colors, logo_files,
  sources, rationale, production block with confidence/flags/notes).
- `references/location-context.sql`: the read queries (via boostly-admin `run_read_query`)
  that resolve a location's context and write scope before a run.
- `scripts/decrypt-boostly-cookie.mjs`: mint a raw Cookie header file from Travisse's
  Chrome profile for V2 writes (`node scripts/decrypt-boostly-cookie.mjs --out <file>`;
  defaults: Profile 10, new.boostly.com; output 0600; never prints values).
- `scripts/branding-feedback.ts`: append-only feedback lifecycle CLI. Both Codex and
  Claude copies default to the same canonical ledger; see `references/feedback-schema.md`.
- `scripts/fetch-google-place-photos.mjs`: fetch up to 10 Google-selected Place photos
  from the location's existing `google_place_id`, download stable run inputs, and record
  dimensions, hashes, and required author attribution without printing the API key.
- `scripts/build-branding-evidence.ts`: copy/download and hash logo candidates, record
  provenance/dimensions/measured colors, package desktop/mobile website screenshots plus
  computed semantic surface styles, extract authored website tokens, build GBP evidence, run
  mechanical QA, and emit the strict evidence/reuse fingerprint plus Fable contract.
- `scripts/validate-fable-decision.ts`: require Fable's exact six-key judgment and recognized
  production palette roles; reject unknown keys, unknown assets, incomplete web colors, a white or
  near-white primary (`primary_too_light`), a lighter synthetic tint of a brand ink as the band
  (`band_lighter_synthetic`), a collapsed emblem knockout with no words-only default
  (`emblem_knockout_needs_words_default`), and a traced/upscaled `logo_choice` whose source ladder
  was never exhausted (`source_ladder_incomplete`). Writes `marks` next to the six keys in the
  decision block: `traced_from_small_source`, `band_over_brand_ink`, and `band_synthetic_step` (the
  sheet reads them).
- `references/logo-source-ladder.json` + `scripts/logo-sources.ts`: the SOURCE LADDER as data (18
  rungs, each with a fetch hint, minimum useful px, provenance; floor 700px for any trace). The
  evidence input's `logo_sources[]` records which rungs were tried and what px they returned;
  the packet stores `logo_sources.ladder`. `logo-sources.ts infer --run <dir>` names the native
  source of an older run from candidate prose and raw files.
- `scripts/render-effective-proof.ts`: after a production write, rerender the Slack/Notion
  tap-card proof from the latest resolved `effective_branding`, using the effective production
  logo and the same web/print color mapping as the live app. See
  `references/proof-color-parity.md`.
- `scripts/validate-effective-proof.ts`: fail closed unless the proof receipt still matches
  the latest production readback, effective logo, location, selected color mode, and proof hash.
- `scripts/validate-logo-surface.ts`: fail closed when an opaque, mostly light logo asset would
  render as a pasted rectangular panel on a materially darker production card color.
- `references/feedback-schema.md`: event schema, ownership boundary, and CLI examples.
- `scripts/variant-sheet.mjs`: the mandatory pre-post VARIANT SHEET: one lettered montage
  (rows = logo treatment, columns = secondary candidates plus depth ladder, cell = harness card +
  sticker mock + POP tile with badge digit contrast) and a manifest mapping letters to exact
  hexes and logo paths. Incremental: `build`, then `add-row` / `add-column` / `add-cell` /
  `mark` / `restitch` patch the one sheet in `<run_dir>/variants/` in place from a fingerprint
  render cache; no `variants-v2/`. See Core operating rule 2b.
- `scripts/review-canvas.mjs`: the REVIEW CANVAS that closes the sheet stage: one tall 2x PNG
  plus a self-contained HTML page per location with the website, GBP photos plus live Maps view,
  Google Images logo search (live Chrome session), logo candidates, gate summary, and the variant
  sheet with Fable's default framed. `--run <run_dir> --open`. See Core operating rule 2c.
- `scripts/cut-words.mjs`: deterministic business-name-words-only cut of a knockout by
  connected components (two-pass union-find, line clustering, emblem/descriptor drop), with a
  JSON of kept and dropped components and `--band`, `--keep-ids`, `--drop-ids` hints.
- `scripts/imagegen-knockout.mjs`: eligibility-gated gpt-image-2.5-sunburst knockout or
  words-only candidate that sits NEXT TO the deterministic knockout, alpha-snapped and run
  through the full battery plus `source-overlay`. See IMAGEGEN KNOCKOUT CANDIDATE.

## Quick start (typical request: "brand these N locations and write them to V2")

Every location run has one `run.json` (schema and owners:
`~/.claude/skills/boostly-box-fulfillment/references/run-schema.json`, CLI
`boostly-box-fulfillment/scripts/run-file.ts`). The scripts below take `--run <run_dir>` and
write their own block: `build-branding-evidence.ts` -> `evidence`, `validate-fable-decision.ts`
-> `decision` (Fable's six keys verbatim from `<run_dir>/decision.json` plus the file hash),
`variant-sheet.mjs` -> `variants` (`run-file select <run> <letter> --by Travisse` records the
chosen letter and, when it differs from Fable's, an override record), `render-effective-proof.ts`
and `validate-effective-proof.ts` -> `proofs`. Gates are data: `references/gates.json` is the
registry (thresholds, severity, override_allowed, motivating case), `scripts/gates.ts run` writes
the `gates` block, and `scripts/gates.ts verdict` combines it with the `overrides` block into one
SHIP / SHIP-WITH-OVERRIDE / HOLD answer that the write stage obeys. A gate override is
`run-file override <run> --gate <id> --asset <file> --reason "<why>" --decided-by travisse`:
recorded data, never a rule edit (see "Gate registry, overrides, verdict, replay"). The old file
arguments keep working; `--run` only adds the run.json write.

1. Read `STATE.md` in the project root; start the badge harness if down.
2. Resolve context per location with `references/location-context.sql`, including
   `google_place_id`. Then, before any evidence collection or Fable call, run the call
   preflight so the offer, copy, and quantities come from the customer call, not the wizard:

   ```bash
   node ~/.claude/skills/boostly-signage-sheets/scripts/preflight.mjs \
     --location-id <v2-location-id> --run-dir <run-dir>
   ```

   It finds the location's AskElephant calls (find-calls.mjs: CSM/rep windows matched by contact
   email, domain, contact names, business name, city), saves transcripts under `<run-dir>/call/`,
   extracts the agreed invite offer, birthday promo, table/stall/tap-card counts, sign wording,
   and "combine lists" (call-facts.mjs), compares them with the live keyword, promotions, and
   fulfillment_items, and writes `<run-dir>/call/call-facts.md` (the fixed "Call facts" block
   that every runner report and Slack proposal carries) plus `<run-dir>/preflight/preflight.md`.
   Read-only; it applies nothing. OFFER_MISMATCH carries the exact `boostly-links offer set`
   command to run (or hold) before print; QUANTITIES_UNCONFIRMED is the one line that says the
   request sits at wizard defaults with no call confirming them; TRANSCRIPT_PENDING means a
   call exists but AskElephant has no transcript yet (not NO_CALL: keep the hold, rerun preflight
   later and it re-checks for the landed transcript). Details and every flag: the PREFLIGHT
   section of `boostly-signage-sheets/SKILL.md`. Plain text, no em dashes, in anything quoted
   from it.
3. Fetch Google Places photos and collect first-party/human logo candidates and authored site
   files into the immutable run directory. When an official website exists, capture full-page
   desktop and mobile screenshots and a computed-style manifest for visible semantic surfaces.
   When a first-party Instagram exists, review its grid too (workflow step 3b, INSTAGRAM
   EVIDENCE): keep only logo, in-store, and recurring branded-template posts, write
   `evidence/instagram/instagram.md`, and add its recurring colors to the packet.
4. Run `build-branding-evidence.ts --run <run_dir> --input <json>`. It fails closed when a
   website exists but the visual receipt is missing. If `reuse.eligible=true`, reuse the prior
   validated judgment. Otherwise launch one Fable judgment using
   `references/subagent-prompt-template.md`; Fable writes `<run_dir>/decision.json` and the
   orchestrator runs `validate-fable-decision.ts --run <run_dir>`. Never transcribe the decision
   from Fable's reply by hand.
5. Apply the chosen treatment through deterministic harness commands, run every mechanical
   gate, render `proposal-proof.png`, then render the VARIANT SHEET (rule 2b) before anything is
   posted; surface every flag and hold address/identity flags.
6. Create the feedback case as soon as the deterministic manifest/proof is final; retain its
   `branding_case_id`.
7. On Travisse's go: mint a cookie with `scripts/decrypt-boostly-cookie.mjs`, then dry-run → apply
   → readback per the write workflow below. After an apply, render `proof.png` from that exact
   readback with `scripts/render-effective-proof.ts`; never reuse the proposal proof as live proof.
8. Append outcomes to `STATE.md`. If he flags a flaw, record his raw feedback first, then
   follow the case-studies loop: diagnose
   → new gate/rule → validate both directions → rerun only the flagged location.

## Engine room (canonical paths)

Everything lives in the spike project, this skill orchestrates it, it does not duplicate it:

- **Project root:** `$BOOSTLY_RUN_ROOT/`
- **The brief:** `SUBAGENT_BRIEF.md`: the single living document. Subagents read it
  directly; every new rule goes straight into it (no freeze step). `briefs/` holds
  historical snapshots (v1.0-v1.4) for reference only, pin a copy there just before an
  eval-regression run if you need run-to-run reproducibility, otherwise ignore it.
- **Tool harness:** lives inside this skill at `~/.claude/skills/boostly-brand-design/harness/`
  (moved from the spike project on 2026-09-16; every `harness/...` path in this document is
  relative to the skill folder, not the project root). `harness/iterate-logo-rules.mjs`
  (sharp-based deterministic gates/transforms), `harness/screenshot.mjs` (real-app proof render),
  `harness/sticker-mock.mjs`, `harness/capture-dom-lockup.mjs`, `harness/colors.mjs`,
  `harness/taste-check.mjs`; signage mockup helpers in `harness/mockups/` (including
  `harness/mockups/ai-mockup.mjs`: AI product mockups per cell, see rule 2d). Run `npm ci` in
  `harness/` once so `sharp` and `playwright` resolve; the scripts in `scripts/` resolve them from
  there via their own location.
- **Session memory:** `STATE.md`: read it first, append outcomes after. Every run's learnings
  go here; it is the cross-session brain of the pipeline.
- **Production runs:** `runs-prod-<date>/<location-slug>/` with `run.json` (the single source
  for the run; `manifest.json` on runs older than 2026-09-16, migrated with `run-file migrate`),
  `decision.json`, `proof.png`.

## Core operating rules

0. **A fresh Fable proposal is mandatory, even when production branding already exists.** Existing
   production branding is comparison-only evidence: it may show what is live today and it may block
   an unattended overwrite, but it must never short-circuit first-party evidence collection, the
   Fable judgment, deterministic treatment/QA, or `proposal-proof.png`. Do not treat the live logo
   as a candidate merely because it is live. It is eligible only when the same asset is independently
   rediscovered from a verified first-party source and entered with that source provenance. When
   existing values would be replaced, finish the full proposal and hold only the write so Travisse
   can choose whether to override production.
   For fulfillment runs, `hold only the write` is literal: still fetch and retain the exact GBP
   packet, finish deterministic treatment/QA, render `proposal-proof.png`, create or revise the
   feedback case, and include the proposal plus every downloaded GBP source photo in the single
   canonical Slack upload. Existing branding must never produce a proof-only result or a later
   GBP-photo follow-up. Before posting, require the upload GBP path count to equal the materialized
   photo count in `gbp-photos.json`, and require the flattened Slack response/audit to contain the
   same number of GBP file IDs. Label the proposal as not live and leave production unchanged.
1. **Fable makes only the bounded visual judgment.** Build `branding-evidence.json` first,
   then give one fresh Fable context only that packet plus the brief's judgment rules. Pass
   `model: "fable"` in the Agent call so the subagent doesn't inherit a different model (the
   brief is tuned and evaluated on Fable; see Eval mode). Use medium effort where the launcher
   exposes an effort control. Its output is exactly `logo_choice`, `palette`, `composition`,
   `confidence`, `flags`, and `rationale`. The deterministic runner owns asset transfer,
   preservation or background-removal commands, resizing, color extraction, contrast, edge QA,
   proof rendering, write/readback, and artifacts.
   Logo choice includes an explicit visual-integrity pass: Fable must open every viable candidate
   and reject malformed glyphs, filled counters, fused strokes, broken negative space, invented
   spelling, or damaged letter anatomy even when OCR passes. If all candidates are defective,
   Fable returns `logo_choice: null` with `malformed_glyph_topology`; it must not choose the least
   broken option. Deterministic counter topology and other final-asset gates still run afterward.
   Once `validate-fable-decision.ts` passes, Fable's exact six-key JSON is immutable. The
   deterministic runner may execute asset operations required by that judgment, but it must not
   reinterpret, rewrite, append to, remove from, or replace `logo_choice`, `palette`,
   `composition`, `confidence`, `flags`, or `rationale`. Persist the validated decision path and
   SHA-256 with every fulfillment input. Any downstream mismatch is a run error that stops proof
   generation, production writes, Slack, and Notion. A human-requested revision requires a fresh
   Fable decision and validation; it is never a model or orchestrator override.
2. **Proofs render through the real app, no exceptions.** Dev harness page
   `http://localhost:3457/public/badge-preview-harness` (uncommitted page in the boostly repo;
   start with `PORT=3457 npm run dev` in `$BOOSTLY_REPO_DIR` if down; NEVER
   commit that page). Render via `node harness/screenshot.mjs --url-base http://localhost:3457
   --logo <png> --primary <hex> --secondary <hex> --text <hex> --text-secondary <hex> --out <png>`.
   Mocking the card some other way is a contract violation. Fable's pre-write artifact is
   `proposal-proof.png`. After any applied write or reviewer color revision, the orchestration
   layer MUST save a fresh resolved production readback and run `scripts/render-effective-proof.ts`
   to create the final `proof.png`. The helper defaults to the same digital/web colors visible in
   the production preview and downloads the effective production logo. A root proposal proof,
   stale manifest, account row, or unresolved location override is never valid applied-run proof.
   Existing production branding is not exempt. Before it may be described as preserved, reusable,
   or acceptable, download its resolved effective logo, render a fresh effective proof, validate
   the receipt, and run `validate-logo-surface.ts` against the actual web primary. Existing values
   block unattended replacement; they never waive visual QA. A failed existing asset becomes an
   explicit branding hold with its failed proof attached, not a successful preserve outcome.
2b. **A variant sheet ships with every first post; the reviewer answers with one letter.**
   Before the first Slack post for a location (and before any revision post that changes a
   color or the card logo), run
   `node scripts/variant-sheet.mjs build --run-dir <run_dir> --run <run_dir> --offer "<sign copy>"`
   (the bare `--run-dir` form without a subcommand is the same `build`). It fails loudly
   when the harness at `http://localhost:3457` is down; never substitute another renderer.
   Rows are the logo treatments (chosen card knockout, full color, and the words-only cut from
   `scripts/cut-words.mjs` when it differs from the knockout; the full lockup and any wordmark-only
   variant appear here as rows, nobody has to ask for them). Columns are the secondary/band
   candidates in provenance order: Fable's chosen secondary, the chosen mark's own inks (at least
   3% ink share; a gradient ink enters as its family CENTER, never the dark pole), theme-authored
   site tokens, then the DARKER depth ladder of the chosen secondary (-10%, -20% lightness; Q3 = A
   2026-09-22: a darker step is pick-eligible when the real ink fails band or digit contrast, the
   +10% lighter column is never a pick and only renders behind `--allow-lighter`). Every column
   header and cell label carries the provenance in plain words ("Fable's pick", "logo ink 5%",
   "site theme token", "darker step, synthetic (allowed when real ink fails contrast)",
   "in-store dominant, sampled from photos"); a color with no such words is not on the sheet.
   DEFAULT LETTER (2026-09-21): `build` marks Fable's default itself: the card-knockout row at
   Fable's column, MOVED to the mark-ink column when the decision carries `band_over_brand_ink`
   (Fable's secondary is a neutral or is not an ink of the mark while the mark has a saturated
   ink >= 3% that reads on the primary: Toscano's cream, Skyboxx tan) and that cell's print digit
   passes or has a brand-owned fix. When the decision carries `traced_from_small_source`, the
   cell is marked `HOLD: traced from small source` with the native px on its label instead of a
   default, and `fable_default_letter` stays empty until a human accepts it.
   IN-STORE PRIMARY ROW (Chuy's 2026-09-18): the dominant saturated hue sampled across the
   brand-environment photos becomes its own primary row automatically (row label says
   "sampled") when it is 40 degrees or more from the site primary or the primary is a neutral;
   `--no-instore` skips it. Each cell is the real harness card plus the sticker
   mock and a solid POP tile, and its label prints the badge digit contrast (secondary vs text
   color) with the brand-owned fix (white or black digit) when it fails 3:1. Every cell carries a
   letter; `variant-sheet.json` maps each letter to the exact logo path, primary, secondary, text,
   and the print digit color, so "apply B" is mechanical: that cell's logo becomes the card asset,
   its secondary becomes `web_secondary_color` and `print_secondary_color`, primary and text stay,
   and `badge_digit_print.fix` (when set) becomes `print_text_secondary_color`. Fable still names
   its default letter in the post. Reviewer contract: Travisse replies with a letter (or "A as is");
   anything else is a new request, not a variant pick. "Preview" and "variant" always mean render
   only, never write. Attach `variant-sheet.png` to the proposal reply next to
   `proposal-proof.png`; do not describe options in prose that the sheet already shows.
   ONE SHEET PER RUN, PATCHED IN PLACE. The sheet lives at `<run_dir>/variants/` only
   (`variant-sheet.png` + `variant-sheet.json` + the `cells/` render cache). There is no
   `variants-v2/`, no per-row sub-sheets, and no stitched `variant-sheet-all.png`: when Travisse
   overrules Fable's letter, asks to keep a word the gate stripped, wants the full logo on a
   different primary, or wants one more color, EXTEND the existing sheet and re-open the same
   `variant-sheet.png` in Preview (`open -a Preview <run_dir>/variants/variant-sheet.png`):
   - `variant-sheet.mjs add-row --run-dir <run> --run <run> --logo <png> --label "<treatment>"
     [--key <row_key>] [--primary <hex>] [--text <hex>] [--secondaries #hex,#hex] [--knockout]
     [--sticker-logo <png>]`: a new logo treatment across the existing columns (or the listed
     subset). `--primary` gives the row its own card ground (the "full logo on black" case), so a
     second primary is a row, not a second sheet. `--knockout` declares a white-knockout treatment
     so the LIGHT PRIMARY tint applies on a light row primary.
   - `variant-sheet.mjs add-column --run-dir <run> --run <run> --secondary <hex> [--label "<why>"]`:
     a new band candidate rendered for every row.
   - `variant-sheet.mjs add-cell --run-dir <run> --run <run> --logo <png> --primary <hex>
     --secondary <hex> [--digit <hex>] --label "<treatment>"`: one off-grid option (the Toscano's
     name-only case after the in-store photos) appended as its own row; a secondary that is not a
     column becomes a one-off column that later `add-row` calls skip unless listed.
   - `variant-sheet.mjs mark --run-dir <run> --run <run> --cell <letter> --status
     <fable_pick|travisse_pick|rejected|none> [--note "<why>"]`: annotates the json and draws a
     corner tag plus a colored frame on the sheet without rerendering the cell. `travisse_pick`
     calls `run-file select <run> <letter> --by Travisse` itself, so the applied letter is recorded
     once, in `run.json` (with the override record when it differs from `fable_pick`); never call
     `run-file select` by hand after a mark, and never retype the letter into a manifest.
   - `variant-sheet.mjs restitch --run-dir <run>`: rebuilds the png from the cached cells only.
   Letters are assigned once in creation order (A..Z, AA, AB, ...) and never renumbered; new
   cells get the next letters, so a letter Travisse already quoted stays valid. A cell takes a
   letter only when it is created: a (row, column) the builder refuses on the card (below) is never
   a cell, so it consumes no letter and the rendered cells stay contiguous. A cell a human marks
   `rejected` afterwards (`mark --status rejected`) is the opposite case: it KEEPS its letter
   (letters already quoted in Slack or Notion must not shift) and is drawn greyed, with REJECTED in
   its header strip and across the card, so the sheet still shows what was turned down. Every render is
   cached in `cells/` by an input fingerprint (logo sha256, primary, secondary, text, treatment,
   offer, band); a subcommand renders only what its fingerprint says is new, and the output JSON
   reports `rendered` versus `cached` counts. `variant-sheet.json` is the source of truth and the
   png is derived from it; `build` refuses to overwrite a sheet that has additions or marks
   (pass `--force` only to start over from the decision inputs). With `--run <run_dir>` every
   subcommand rewrites the `variants` block of `run.json` (sheet path, cells with ids,
   fingerprints, statuses, `fable_default_letter`; `applied_letter` stays unset until the
   `travisse_pick` mark). The run manifest's `variant_sheet: { png, json, applied_letter }`
   points at that one sheet because the review-queue skill embeds it in the Notion review page.
   SHEET VIABILITY (Dogwood Pizza 2026-09-21): every logo asset passes the `sheet-viability` gate
   (`references/gates.json`, run by `logo-quality-gates.ts sheet-viability`) BEFORE `build`, `add-row`,
   `add-cell`, or `add-column` renders a cell with it: an opaque-ground asset (the sticker-ground
   measurement: a panel that prints as a white square on the card), a words-only cut that no longer
   reads what its source reads (OCR against the business name, letter-component count as the
   fallback; `add-row --source <wordmark>` names the source, the cut-words sidecar is found
   automatically), or a label/note that already says "rejected" is NOT added. The CLI prints one
   `sheet-viability: skipped ...` line per refused asset and records it under `variants.skipped` in
   run.json; the sheet never carries a cell you would mark rejected. `--force-viability` renders the
   asset anyway with a purple NOT VIABLE badge for the cases Travisse wants to see.
   CELL ON CARD (Travisse 2026-10-01, "drop rejected cells from the rendered sheet entirely so they
   do not consume letters"): before any (row, column) pair becomes a cell, the row logo is measured
   against the row primary with the component-contrast rule (one measurement per logo and primary);
   when at least `card_vanish_min_ink_share` (0.5) of the ink sits in components that vanish on the
   card (Spinachio: the green two-ink lockup on the green card at 1.03:1; Oogie's: green words on the
   orange card at 1.64:1), the cell is NOT created. It takes no letter and no render, the CLI prints
   `sheet-viability: skipped cell <row> x <hex> on <primary> (ink_vanishes_on_card), no letter taken`,
   and the refusal is recorded under `variants.skipped` with `kind: cell` (row, column, primary, logo,
   `vanished_ink_share`). A row with no cell left is not added; a build that refuses every cell fails.
   Kept cells record the measurement as `ink_on_card`. `--force-viability` creates the cell anyway
   with a NOT VIABLE badge. Never mark a builder refusal `rejected` by hand: there is no cell to mark.
   STICKER GROUND (Toscana Gourmet Pizza 2026-09-22): the same opaque_ground check runs on the
   STICKER logo of every row (`--sticker-logo`, the sheet's `--logo-sticker`, or the decision logo
   the build falls back to), because that asset sits on a white sticker. An opaque sticker asset is
   never rendered and never swapped for the card logo: the row's sticker tile reads "sticker: needs
   panel or strip", the skip is recorded (`kind: sticker`) and printed. Fix it with
   `scripts/sticker-panel.mjs --logo <png> --out <png> --mode circle|strip`, gate the output with
   `gates.ts check --asset <out> --color #FFFFFF --surface sticker`, then `add-row --sticker-logo`.
   LIGHT PRIMARY: when the card primary fails 3:1 against white (cream, yellow, pastel), the script recolors the knockout and words-only rows to the card text ink (black when the text ink is light too), labels the rows with that ink, records `light_primary` and `knockout_ink` in the sheet json, and renders the POP tile on the sticker band instead of the primary. A white knockout on a light card is invisible and the sheet is not reviewable (206 Burger 2026-09-09). The knockout applied from such a row is the tinted file, not the white one.
2c. **Review canvas: the sheet stage ends by generating and opening it.** After the variant
   sheet is built (or patched) and Fable has marked its default letter, run
   `node scripts/review-canvas.mjs --run <run_dir> --open`. It writes two outputs under
   `<run_dir>/review/` and opens both: `review-canvas.png` (one tall PNG, 3200px wide at the
   default `--scale 2`, photos embedded large, never smaller than a 3-column grid; opens in
   Preview) and `review-canvas.html` (the same sections as a self-contained page with inline CSS
   and relative paths into the run dir, no CDN; every image at native resolution, click any image
   to open the file, click the sheet to toggle native size; a fixed left sidebar lists every
   section with the one in view highlighted and collapses to a hamburger below 1000px; opens in
   the default browser; `--no-html` skips it). This replaces Travisse's manual ritual of opening the website, the GBP
   photos, and a Google image search for the logo. Sections: header (business, request id,
   Fable's default letter with its one-line rationale, the default cell cropped from the sheet at
   native pixels as `review/default-cell.png`, and, mandatory since 2026-09-21, LOGO AT 3x (WHAT
   PRINTS): a crop of the exact final upload rendered at 3x native with nearest-neighbour on the
   card primary (`review/logo-3x.png`) under an effective-resolution line: final px, source px
   and derivation, upscale factor, and the `edge-quality` verdict with its reason; a held
   small-source trace is framed red and the header says HOLD instead of naming a default; gates
   per sheet row in plain words), website
   (cached `evidence/website-visual/desktop.png`, else a fresh Playwright capture, else a gray
   box with the reason), Google Business Profile (the downloaded Place photos with the ones Fable
   cited framed, the SearchAPI "Vibe" in-store photos, and a live Google Maps photo view), logo
   image search (Google Images through the live Chrome session's Boostly profile: the tab is
   opened, the thumbnail URLs read, the tab closed, the gstatic thumbnails re-fetched into
   `review/logo-search/` with a manifest; Google serves its "sorry" page to every headless or
   automated browser, so the fallbacks are Bing then DuckDuckGo, and a gray box says so when all
   fail), logo candidates from the evidence packet with their source in plain words and Fable's
   pick framed, the variant sheet at native size with the default cell framed
   (`review/variant-sheet-marked.png`), and PREVIEWS (2026-09-21): per letter, the harness
   signage preview (`review/signage-preview-<L>.png`) and the AI mockups
   (`review/mockups/<scene>-<L>[-suffix].png`, scene and letter read from the file name) with
   the pick status and hexes in the group header and the verdict/drift line parsed loosely from
   `review/mockups/prompts.md` (a link to that file when no line exists). The section renders
   only when preview files exist; previews are a post-pick step (closeout-location renders
   them for the chosen letter, then rebuilds the canvas), so the canvas never suggests
   generating them. In the PNG the previews are reduced and skipped when they would push the
   file over `--png-budget-mb` (default 25; the HTML says so and keeps them at native size).
   LINKS (2026-09-21): a "Links" section folds the link automation into the same doc, one row
   per category from the run.json `links` block (website bootstrap, existing ordering match,
   candidates, execution records), the discovery report's `category_results`
   (`link-discovery-report*.json` in the run dir or `links-port/`, newest by `checked_at`), and
   the `links-port/` artifacts (`browser-needed*.json` pending URLs, `validate-pass*.json`):
   category, chosen URL, status in plain words (written / verified live / already live / held
   with reason / pending browser / rejected / none found), and the evidence line (title or H1
   match, website backlink, slug or geo match); held rows amber, written and live rows green,
   pending and none rows grey; the sidebar label carries the held-for-review count.
   Earlier captures under `review/` are reused, so a rerun
   after a sheet patch is fast; `--skip-google` takes no new Google captures but still reuses the
   cached Maps view and logo results. `review/review-canvas.json` is the sidecar record and the
   same record is written to `run.json` under `variants.review_canvas` through `run-file` (the
   schema has no top-level review block; the variants rewrite is forced with a recorded reason,
   sheet and cells untouched, and skipped when nothing changed). Other flags: `--no-live-chrome`,
   `--chrome-profile <key>`, `--scale <1-4>`, `--record-only` (re-record the sidecar only).
   COMPARE VIEW (Chuy's, asked three times): `node scripts/review-canvas.mjs compare --run
   <run_dir> --cells K,M,L,N,R [--open]` writes `review/compare-K-M-L-N-R.png` and `.html`: the
   shortlisted cells side by side, each with its card, sticker, and POP tile and every color
   labeled with its provenance words. Use it whenever Travisse names more than one cell.
   Google Maps and the logo search are capped at about 90 seconds per location; a failure there
   never blocks the canvas, it becomes a labeled gray box. Place photos are already fetched at up
   to 4800px by the evidence build, so the canvas never needs to refetch them.
2d. **AI product mockups (box and scan scenes) are a post-pick output, rendered for the chosen
   letter during close-out (not at the review stage).** After the harness signage preview exists
   for the chosen cell, run
   `node harness/mockups/ai-mockup.mjs --run-dir <run_dir> --letter <L> --scene box` and
   `--scene scan` (also `table`, `badges`). It builds a single reference sheet from the cell's
   POP, sticker, card and the to-go crop of `review/signage-preview-<L>.png`, fills the Anna's
   Pizza Joint prompt shapes with the run's offer and hexes, calls the image-generator skill
   (gpt-image-2.5-sunburst, 2K, `--ref`, portrait 1600x2400 for box/scan, 2048x1536 for table),
   writes `review/mockups/<scene>-<L>.png` plus a `.log` with elapsed and usage, and appends
   the prompt to `review/mockups/prompts.md`. Dogwood Pizza 2026-09-21: about 35 s and roughly
   $0.08 per image; the model keeps layout, colors, copy and the script wordmark intact when
   the prompt says "reproduce EXACTLY as attached"; QR modules track the source closely at 3x
   but individual modules drift and scannability is not verified (cv2 cannot decode the dotted
   source style either), and the scan scene invents phone-screen content (a fake domain and
   menu rows) unless a real link-page screenshot is passed with `--phone <png>`. To get one:
   read the location's touchpoints (`v2-db query --json --sql "select short_id, issue_id, type,
   name from touchpoints where location_id='<id>' and deleted_at is null"`), open
   `https://tp.boostly.com/<short_id>` of the table-sticker signage row (or the lowest-issue
   active badge) in the live Chrome tab at a mobile width, save the screenshot as
   `review/link-tree-<short_id>.png`, and pass it as `--phone`. With the phone ref the model
   reproduces the real page (Bunker Grille 2026-09-21: logo, Welcome, Text Club reward row,
   Feedback, Follow, Join Our Team, Menu, all faithful); note the live page shows production
   branding, which may differ from the cell under review. `--setting "<text>"` overrides the
   table scene (default is a pizzeria table).
   Scale and corners (Travisse feedback 2026-09-21: table stickers came out too big and square):
   the reference sheet lays the pieces out at true physical scale at 300 ppi (POP 5x7 in, table
   sticker 3x3 in, tap card 2.125x3.375 in, to-go 2 in wide, phone 2.8 in wide) bottom-aligned on
   a light grey ground, with corners pre-rounded by sharp (sticker 8% of the side, card ~1/8 in,
   POP 2%, to-go 6%), and the prompt states the inch sizes plus "the table sticker is about the
   size of the tap card's long side and clearly smaller than the sign; keep the rounded corners".
   The model copies the ratio it sees, so never feed it equal-height pieces. The to-go strip is
   2.5 in wide (real print sheet 1538x612 px, 2.5:1; the harness crop keeps its own ~1.75:1),
   pre-rotated -8 degrees on the sheet, and the prompt says all four float in one shared
   three-quarter perspective with one vanishing point and lighting, none flat or head-on
   (Travisse feedback 2026-09-21: a flat, undersized to-go strip looked pasted on).
   Box layout is deterministic: the `LAYOUT` object at the top of `ai-mockup.mjs` (4:5 canvas,
   headline band 12%, shared 8-degree yaw, POP left two-thirds from 12% to ~70%, sticker upper
   right overlapping the POP edge 15% at 30%, card lower-center at 60% tilted 6 degrees ccw,
   to-go lower-right at 66% tilted 10 degrees cw, draw order pop/sticker/togo/card) drives both
   the reference sheet (pieces pre-placed on that grid at true scale, output 1600x2000) and the
   prompt's composition paragraph. Two same-prompt Bunker runs on 2026-09-21 matched each other
   and the spec to within a few percent; tune positions in `LAYOUT`, not in the prompt text. Treat mockups as marketing previews, never as print or scan
   proofs; check at 3x that the wordmark has no invented letters before sharing. `--ground #hex`
   overrides the background (default: the cell's sticker band), `--dry-run` prints the prompt.

3. **Every human-flagged flaw becomes a deterministic harness tool or brief rule.** When
   Travisse flags a bad result: diagnose the pixel-level root cause, add/extend a gate or rule,
   validate it fails the bad case and passes known-good cases, record in STATE.md, then rerun
   only the flagged locations with fresh subagents.
4. **An explicit human-supplied replacement is authoritative.** After validating that it is a
   supported, non-empty image for the exact business/location, preserve its authored pixels
   exactly. The mandatory crop gate may remove only uniform outer canvas while leaving every
   retained pixel unchanged. Do not remove a background, recolor, reconstruct, AI-upscale, or
   perform any content crop unless the reviewer explicitly asks. Record dimensions and hashes for
   both source and normalized upload, use the normalized file as the revision proof, and verify the
   production download hash after applying it.
5. **A clean first-party transparent logo takes the preservation path.** Classify the source
   before choosing any treatment. If a verified first-party PNG/SVG already has functional
   transparency and the complete authored mark, preserve its pixels, silhouette, white
   keylines/borders, counters, and canvas semantics. Do not run background removal, deglow,
   component surgery, recoloring, reconstruction, or AI upscaling. The only permitted changes
   are trimming fully transparent outer rows/columns, transparent padding when required, and
   one alpha-safe deterministic resample to the final target size. If a transformation changes
   authored ink or removes any border-ring keyline, reject it and use the source-preserving path.
   The upload asset is a content crop, not a layout canvas. Before resizing, run
   `scripts/logo-crop.ts` on every selected logo. For transparent or uniform-color outer canvas,
   crop to the complete authored mark with at most 1.5% safety padding per side. This crop may
   remove only the uniform outer canvas; it must not remove a border, keyline, glyph, icon,
   tagline, shadow, or any other authored ink. Do not add square padding merely to center a wide
   or tall mark; the product renderer owns centering. A nonuniform edge is not permission to
   guess a crop: preserve it and inspect the badge-size proof.
   Preservation does not permit shipping an unreadable lockup. The exact final upload must pass
   the 126x56 product-box render-legibility gate. If it fails, choose only a corroborated authored
   simplified/knockout variant. If none exists, ImageGen may create one or more faithful simplified
   candidates from the verified first-party mark plus exact-location GBP storefront/signage
   evidence. ImageGen is a bounded candidate generator, not the branding judge: it must preserve
   the business name and corroborated distinctive elements, must not invent a new identity, and
   its outputs must be added back into the deterministic evidence packet with provenance before
   Fable runs. Fable selects or rejects those candidates alongside the authored candidates.
   Deterministic tooling still owns alpha cleanup, resizing, OCR, all mechanical gates, proof
   rendering, upload, and readback. If no generated candidate passes or the physical identity is
   ambiguous, emit a `wordmark_rebuild_proposal`, flag `mark_substitution`, and hold for human
   approval.
6. **Flags are never silent, but they are not fill-only write gates.** Preserve and surface
   `manual_review` flags in the manifest, Slack result, and review checklist. When fulfillment
   has resolved the exact business and the selected production branding scope has no existing
   logo or color values, a validated Fable result is applied fill-only even when flags are
   present. Hold for branding review only to avoid replacing existing live branding. Missing or
   invalid output and unresolved identity are blockers, not permission to write or reviewer holds.
   This does not weaken mechanical gates: any failed final-asset gate blocks the write regardless
   of Fable confidence, flags, source authority, or whether production branding is empty.
7. **Exact-place environment photos are required visual context when a Place ID exists.** Keep
   the Google-selected Places packet as the baseline, then run the SearchAPI Maps Photos adapter
   for Vibe, By owner, All, and conditional pagination. The adapter must first verify the exact
   `google_place_id` plus name/address/domain consistency, preserve source/author metadata, reject
   identity conflicts, SHA/perceptually dedupe, and pass only the selected contact sheet plus at
   most ten detail images to Fable. SearchAPI is fail-open for outages, empty categories, missing
   dynamic categories, and panorama download limitations; record `searchapi_environment_unavailable`
   and continue with the official site, Places baseline, and narrow DataForSEO fallback. It is not
   fail-open for an identity conflict. Photos supplement physical-brand context and never override
   a verified first-party or human-supplied logo. The fulfillment Slack evidence set must include
   the selected SearchAPI contact sheet and up to ten selected detail images in manifest order,
   after the Google Places packet. Attach only exact-match, materialized selected files; exclude
   raw receipts, unselected candidates, and cross-source duplicates. Corroborated deliberate
   exact-location usage may guide a faithful simplified, knockout, or one-color treatment of the
   verified first-party mark and may establish which color family leads in-store. Require either
   two perceptually unique exact-place images showing the same deliberate brand usage, or one
   exceptionally clear permanent sign plus an independent human-supplied, first-party, or
   screenshot-visible theme-authored signal. Exclude food, lighting/camera casts, general decor,
   uniforms, seasonal items, one-off objects, vendor signage, and neighboring brands. Read
   `references/brand-environment-evidence.md`.
7b. **A first-party Instagram is a required evidence source for colors and logo treatment when it
   exists.** Park Avenue BBQ Grille (2026-09-08) shipped black/yellow from a near-black computed nav
   (#222222) while its Instagram grid showed a dark green band on yellow on nearly every branded post
   plus green in-store menus and flyers; Travisse switched the card to green/yellow. Review roughly
   the first 24 to 36 grid posts, keep only posts that carry the logo, in-store branding, or a
   repeated branded template, and ignore the Canva slop. A color that recurs on 3+ kept posts or in
   in-store photos gets evidence class `instagram_recurring`, ranked above website computed styles
   and below an authored logo ink or an explicit brand guideline. When Instagram and the website
   disagree on the primary, the variant sheet carries the Instagram primary as its own rows
   (`add-row --primary <hex>`) on the one sheet and Fable names both. Full procedure, provenance, logo, Fable, skip, and manifest rules: workflow
   step 3b (INSTAGRAM EVIDENCE).
8. **Visible website surfaces choose palette roles; computed styles provide exact values.** When
   an official website exists, capture full-page desktop and mobile screenshots before Fable.
   Record computed styles from visible semantic surfaces such as header, footer, page background,
   primary CTA, secondary CTA, borders, and navigation. Fable uses the screenshots to decide which
   surfaces are visually prominent and which colors belong in primary/secondary roles; use the
   corresponding computed six-digit value rather than sampling antialiased screenshot pixels.
   A repeated screenshot-visible theme-authored website system remains authoritative. Corroborated
   deliberate exact-place signage or collateral may outrank only generic website CSS: framework
   defaults, off-screen tokens, generic template chrome, or a single low-salience CTA without
   independent brand corroboration. Physical photos choose treatment and color family or role;
   prefer an agreeing authored token, logo pixel, or first-party collateral value for the exact
   hex. Never sample a whole-scene photo as an exact brand color. A Cloudflare challenge is a
   retrieval limitation, not evidence that the site lacks brand colors; record
   `visual_evidence.status=unavailable` with a reason and hold website-backed palette auto-apply
   for review rather than guessing.
   Raw rendered-HTML frequency is not authorship. The evidence packet labels explicit theme-role
   values as `theme_authored` and common bundled UI-library colors as `framework_default_risk`.
   Never promote a framework default such as Material UI blue solely because it occurs often;
   require an explicit site theme role or independent visual/first-party corroboration.

## Gate registry, overrides, verdict, replay

Every mechanical gate below is an entry in `references/gates.json`: id, what it measures, its
thresholds (the code reads them from the file; nothing is hardcoded), `severity`
(`block` holds the write, `warn` is listed in the verdict, `info` is a measurement), the case
study that motivated it, and `override_allowed`. The registry is the only place a rule lives.

- Run the battery on the exact final upload:
  `node --experimental-strip-types scripts/gates.ts run --run <run_dir> --asset <final.png>
  --color <web_primary_hex> [--expected "<words on the asset>"] [--source <verified-source>]
  [--laddered]`. It writes `fix/gates/<asset>/gate-<id>.json` and the `gates` block
  (`results[]` with `gate`, `asset`, `asset_sha256`, `pass`, `verdict`, `severity`,
  `thresholds`, `registry_sha256`). `--expected` defaults to the run's location name; pass the
  words actually on the asset (a name-only cut is not the full name). Gates that need inputs you
  did not give (`ink-retention` without `--source`) are listed under `skipped`, not silently passed.
- Read the answer: `node --experimental-strip-types scripts/gates.ts verdict --run <run_dir>
  --asset <final.png>`. Semantics: HOLD when any block-severity gate fails, is unassessable, or
  is missing from the battery, or when an override exists on a gate that does not allow one;
  SHIP-WITH-OVERRIDE when every failing block gate has an override record (`decided_by`,
  `reason`, `at`) that matches its gate id (aliases such as `ocr` and `tiny_text` resolve) and
  asset; SHIP otherwise. Warn gates (`holes`, `whiteblob`, `stroke`) appear in `reasons` and
  never hold. Exit code 2 on HOLD. `--partial` evaluates only recorded results (migrated runs).
- Record an override (a human decision, as data):
  `node --experimental-strip-types ../boostly-box-fulfillment/scripts/run-file.ts override
  <run_dir> --gate <id> --asset <final.png> --reason "<why, with the evidence>" --decided-by travisse`.
  Overrides are append-only and never change a rule: no threshold, severity, or code moves
  because of an override, ever, and nothing auto-tunes from override history. The record is
  refused when the registry marks the gate `override_allowed: false` (`png-color-type`,
  `ship-gate`, `ladder-floor`, `component-contrast`, `source-overlay`,
  `verify-erase`, `authored-color-retention`) or the verdict is outside
  `override_allowed_verdicts` (`text-legibility` allows only the OCR miss, never
  `glyph_counters_filled`; `logo-crop` allows only `crop_unassessed_nonuniform_border`;
  `ink-retention` allows only `authored_white_dropped`, `authored_dark_dropped`, and
  `rebuilt_from_low_res_source`, never `authored_ink_lost`). A
  refused override means the asset must change or the rule must be changed deliberately.
  Shipped-asset exception (2026-09-17): gates marked `override_allowed_for_shipped`
  (`png-color-type`, `logo-crop`, `component-contrast`) accept an override on an asset that is
  ALREADY LIVE, recorded with `run-file override ... --shipped`; the record is refused unless the
  run proves the asset is live (applied write block or an apply receipt under fix/), and a new
  upload is still hard-blocked. It exists so a replay BLOCK on a live logo is a human decision,
  not a rule edit.
- Severity by verdict (2026-09-17): `text-legibility`'s OCR read
  (`business_name_unreadable_at_product_size`) is a WARN; `glyph_counters_filled` stays BLOCK
  and runs only on single-ink knockout assets (alpha-keyed, one ink within the registry
  tolerance, or `--treatment knockout` / the applied variant cell naming a knockout). Full-color
  art reports `counter_topology.verdict: not_applicable_fullcolor`. `render-legibility` tiny
  text stays BLOCK.
- Change a rule: edit the entry in `references/gates.json` (a deliberate human edit, in the
  file) AND append a `changelog` entry (`date`, `gate`, `change`, `reason`, `decided_by`); the
  registry validator rejects malformed entries and a review without one is incomplete. Then run
  `node --experimental-strip-types scripts/gates.ts replay`. The replay reruns the current definitions against every shipped logo under
  `runs-prod-*/` (read-only; migrated runs are cloned to scratch) and prints run, asset,
  resolution_source, sha, gate, then-result, now-result, override. The replayed asset is the logo
  that actually shipped, resolved in priority order: run.json write block, the apply receipt's
  readback logo_filename (with production-readback.json as the authority for the live attachment
  and primary), manifest logo_filename, manifest applied logo_file prose, applied_logo_download,
  and only then logo_files; the file's sha is checked against any recorded sha and a mismatch is
  reported instead of replayed. It exits 3 and prints BLOCK when a logo that shipped would
  now fail a block gate without an override record covering it. Resolve a BLOCK by recording an
  explicit override on that run or by reverting the edit; never by editing the gate again to
  pass and never automatically. When it is clean, `gates replay --baseline` writes
  `references/gates-baseline.json` so later replays diff against it.
- EDGE QUALITY (Skyboxx 2026-09-21, the battery passed a logo that printed jagged): `edge-quality`
  runs in every battery on the exact final upload and measures what prints: `soft_edge_share`
  (binary alpha under 1000px is `binary_alpha`, a hard block; FINALIZE's binary snap is fine at
  1000px and above), `stair_step_score` (nearest-neighbour block stepping is `stair_stepped`,
  hard), and the effective resolution (source native px, derivation, upscale factor; a trace or
  upscale from a source under 700px is `traced_from_small_source`, the only overridable verdict,
  for a human who ships a small-source trace knowingly). The source comes from the recorded
  ladder, the candidate's `source_native_px`/`derivation`, or `--source-native-px`/`--derivation`
  on `gates run`; unknown sources are recorded as unknown, never failed.
- STICKER / POP ON WHITE (The Place Pizza, Arnold's 2026-09-17/18): before the Figma build, run
  `gates.ts check --asset <sticker_logo> --color #FFFFFF --surface sticker`: the battery against
  white plus `sticker-ground` (an authored opaque panel is `opaque_panel_ground`, hard) and
  `component-contrast` vs white (text components 3.0). A HOLD means cut the mark from its ground
  or take the authored dark variant of the same mark; never recolor to pass.
- PRIMARY TOO LIGHT (That's a Wrap 2026-09-17, Q8 = A 2026-09-22): `primary-too-light` blocks any
  `web_primary_color` under 1.3:1 against white (white and near-white only; That's a Wrap C white
  card rejected, K black card picked); the validator rejects the decision first. A brand's own
  authored cream or tan is allowed as the card when text reads black on it (Chubby's tan #D2B48C
  at 1.94:1 passes; #F5F5F5 fails).
- The write stage calls the verdict: `execute-fulfillment-plan.ts` runs `gates.ts check` on the
  exact logo and primary before any dry-run or apply and refuses the branding operation on
  HOLD; the verdict is recorded on the execution record. The prose `gate_override` note in a
  manifest is legacy; `run-file migrate` turns it into override records.

## Key deterministic gates (harness commands)

Run on the FINAL shipped asset unless noted. Thresholds quoted here are the shipped values in
`references/gates.json`; the file wins if they ever differ.

- `ship-gate <logo>`: shipped file must be >= 700px longest side. For a clean first-party
  transparent source, use one alpha-safe deterministic resample directly to the final target
  (normally <=800px). AI upscale is allowed only when the required scale is >=2.5x or the source
  is genuinely degraded, and only after an A/B matte comparison shows it beats deterministic
  resizing without changing authored ink. Never AI-upscale and then downscale again.
- `node --experimental-strip-types scripts/logo-crop.ts --logo <logo>`: mandatory on the
  exact final upload. For a transparent or uniform-color outer canvas, each side must contain no
  more than 1.5% removable padding. `excess_canvas_padding` blocks the write. Correct it before
  resizing with `--out <tight-logo.png>`; the helper performs a lossless rectangular extraction,
  retains 1% safety padding by default, and refuses to guess when the border is nonuniform. Run
  the gate again after every resize or format conversion. A
  `crop_unassessed_nonuniform_border` verdict also blocks unattended writes until the badge-size
  proof is explicitly reviewed; it is not an automatic pass. Leo's Superfood and Southlands Cafe
  are the regression fixtures: their former uploads must fail, while known-tight assets must pass.
- `soft-fringe <img>`: KNOCKOUT-INPUT gate: softShare > 0.30 = baked-in glow/drop-shadow that
  knockout would smear into a halo; run `deglow <in> <out>` (dark-ink marks) until it passes,
  and re-run on the knockout OUTPUT. Do not deglow color marks that are not being knocked out.
- `holes <img>`: after any knockout containing letterforms: 0 holes under counter letters =
  filled counters = fail (run `counter-punch` before knockout).
- `component-contrast <logo> <primaryHex>`: mandatory alongside `interior`, on the exact
  final upload against the actual web primary (Hooligan's, 2026-08-11). Any component with
  >= 0.5% of ink whose pixels are >= 90% low-contrast (< 3.0) against the primary fails
  (exit 2): a subordinate element (descriptor, tagline, accent) can be 100% invisible while
  the aggregate interior share passes, Hooligan's black descriptor read 1.79:1 on navy with a
  passing 2.8% aggregate. Fix by stripping the free-standing component or a full knockout;
  never waive.
- `interior <logo> <primaryHex>`: run against the actual web primary on the exact final upload.
  Interior low-contrast share > 0.35 blocks all unattended writes. For a text-dominant mark it
  mandates a full white knockout (full means full; never partial/outline-only), followed by every
  gate again. If a full knockout would destroy an emblem or illustration, hold for human review;
  do not waive the gate because the original colors are brand-accurate.
- `node --experimental-strip-types scripts/validate-logo-surface.ts --logo <logo> --primary
  <primaryHex>`, mandatory for both proposed uploads and resolved existing production logos.
  An opaque, mostly light raster on a contrasting colored card fails as
  `opaque_light_panel_on_colored_surface`; route text-dominant marks through the transparent
  knockout path or hold for a reviewed revision. Never call the opaque rectangle "preserved" and
  move on merely because it predated the run.
- `stroke <logo>`: run at native resolution only (upscale blur inflates measurement).
- `node --experimental-strip-types scripts/logo-quality-gates.ts render-legibility --logo
  <logo> --background <primaryHex> --crop-out <run>/fix/render-4x.png`, mandatory on the exact
  final upload at the real 126x56 product logo box. It is a conservative component-height/edge-energy
  proxy, not OCR, and cannot identify which words are essential. Two failure classes, decided
  mechanically (2026-09-08 recalibration, four of four holds that window were cleared by a 4x look):
  (1) TINY TEXT, hard gate: `tiny_text_ink_share` > 0.08, measured at native resolution as ink in
  components that would land under 7px in the box AND sit in a horizontal line of three or more
  comparable-height components at least four times wider than tall (EST. lines, "since" lines,
  city lines, ring text arcs, taglines). Verdict `illegible_at_product_size`, exit 2, blocks the
  write; fix with the CARD LOCKUP LADDER (descriptor-free or words-only cut).
  (2) STYLIZED SCRIPT, informational: tiny text is under the floor but
  `small_component_ink_share` > 0.08 because thin strokes fragment on downsampling. Verdict
  `stylized_script_informational`, exit 0, `attach_4x_crop_required: true`: the proposal MUST
  attach the 504x224 crop written by `--crop-out` (the box at 4x on the primary) and say so in
  one line; it is not a hold. Edge-energy and no-ink failures stay hard. `Luna Pizza full-lockup
  bad` must fail; `Gold simple-wordmark good` must pass; the thin-script fixture must be
  informational; the EST.-line fixture must fail.
- `node --experimental-strip-types scripts/logo-quality-gates.ts source-overlay --candidate
  <png> --reference <deterministic-knockout-or-source> --overlay-out <png>`, mandatory on every
  generated (imagegen) candidate before Fable sees it. Bbox-aligned ink-mask IoU at 800px wide
  must be >= 0.75 and the 8-connected component count must be within 10% of the reference
  (dropped apostrophes, dots, and invented outlines fail it). The overlay PNG (white = both,
  red = candidate only, blue = reference only) is attached with the candidate. A failure means
  the candidate is never applied, whatever Fable or the other gates say.
- For a text-dominant logo, also run `node --experimental-strip-types scripts/logo-quality-gates.ts
  text-legibility --logo <logo> --expected <business-name> --background <primary-hex>`.
  Pass `--source <verified-source>` so counter topology is source-relative: open-by-design
  counters (negative space channeled to the exterior, e.g. graffiti faces) pass only when the
  verified source shows the same topology; a decrease from source to final still fails. OCR must recover the normalized business name within the bounded edit-distance threshold at the
  true 126x56 product size. The same command also enforces counter topology on the native final
  asset: OCR-recognized A/B/D/O/P/Q/R/0/6/8/9 glyphs must retain a conservative minimum number of
  enclosed negative-space regions. `glyph_counters_filled` is a hard failure. Edge energy and OCR
  spelling alone do not prove that a detailed lockup is intact.
- A human-requested preservation revision may use a narrow stylized-mark exception only when OCR
  is blank for both the verified first-party source treatment and the rejected treatment. It still
  requires Fable's explicit native/product-size visual-integrity pass, `render-legibility`, counter
  topology, `ink-retention`, and `authored-color-retention --source <verified-source> --final
  <logo>` to pass. The color gate must fail the rejected treatment and pass the final treatment.
  This exception never applies to generated/rebuilt wordmarks or to an OCR result that returns the
  wrong spelling.
- `node --experimental-strip-types scripts/logo-quality-gates.ts ink-retention --source
  <verified-source> --final <logo>`, mandatory after alignment on every final upload. Coverage
  recall must be >=0.97 and no source component containing >2% of source ink may vanish, else fail.
  The failing verdict is `authored_white_dropped` (block, overridable) when the result reports
  `dropped_ink_white_share` >= 0.95, i.e. everything the final dropped (beyond one source pixel
  of edge drift) was authored NEAR-WHITE ink (channels >= 225) that became negative space on a
  colored card, and no component vanished; it is `authored_ink_lost` (block, never overridable)
  for anything else: a vanished keyline, ring, word, or any colored ink. `Smoke missing-center bad` must fail; recolored-knockout
  and <=2% border-dust-cleanup fixtures must pass; the Coloradough snow-cap fixture must be
  `authored_white_dropped`. `rebuilt_from_low_res_source` (block, overridable, Toscana 2026-09-29)
  is the verdict when the final is a larger rebuild (ink box at least 2x wider) of a source whose
  ink box is at most 300 px, no component vanished, and recall is short but at least 0.90: the
  shortfall is letter weight against a blurry original, so Travisse may override it after looking
  at the proof at product size; under 0.90 or with a vanished part it stays `authored_ink_lost`.
  Also compare dark/light mattes; this silhouette gate does not prove
  semantic completeness or authorize background removal from a functional transparent source.
- `border-dust <logo>`: run on the cleaned native asset before upscale, the final shipped
  asset after upscale, and the production upload copy. Small, thin,
  near-white regions touching the canvas border are usually background-removal crumbs that
  become bright ticks on dark cards. A failure must be inspected on the target card color and
  removed with `remove-border-dust`; do not dismiss it because it disappears on white.
  Cleanup is allowed only while the total removal remains <=2% of opaque ink and every flagged
  component touches the border. Above that cap, hold `manual_review: tooling_gap` instead of
  deleting authored pixels.
- **Opaque negative-space check**, `border-dust` is necessary but not sufficient for raster
  logos extracted from JPGs or opaque white grounds. At native size, inspect every letter
  counter, descriptor gap, and outer edge on both a dark and a light matte. Opaque white,
  pink-tinted JPEG residue, full-width light rows outside an authored panel, or counter fill is
  a hard stop even when `border-dust` and `soft-fringe` pass. These defects are opaque and may
  be fused to a legitimate keyline, so alpha-only and pure-white component gates cannot see them.
  Do not globally key white or run an unscoped `counter-punch` on a full-color lockup. If the
  residue is isolated to a descriptor band, rebuild that band at native resolution from its
  verified ink mask: preserve the authored glyphs, generate keyline only into exterior-connected
  negative space, keep enclosed counters transparent, and add at most 1.5% transparent safety
  padding to prevent antialias clipping. Then rerun `holes`, `whiteblob`, `border-dust`, and the
  dark/light matte review before any upscale.
- Transparent upscale recipe: `border-dust` → `remove-border-dust` if needed → `upscale` →
  `restore-alpha <clean-source> <upscaled-candidate> <out>` → `border-dust` again → dark-matte
  proof. AI upscalers
  may invent color/alpha outside the source silhouette, so their alpha is never trusted.
- Production resize: `resize-alpha <in> <out> 800`, then rerun `border-dust` and inspect the
  final proof on the actual primary. Never use macOS `sips` on a transparent logo; it has
  amplified fringe pixels in production upload copies.
- Background removal: `restore-blocks` (flood-fill from border, restores interior blocks), but
  never treat its output as proof that opaque negative space is clean; descriptor counters and
  tinted JPG residue require the matte check above;
  component surgery via `components` / `remove-components` (mask-strip, never row-crop).

- **Final battery is unconditional:** `gates.ts run` executes every `battery: true` gate in the
  registry (`ship-gate`, `logo-crop`, `border-dust`, `soft-fringe`, `holes`, `interior`,
  `component-contrast`, `validate-logo-surface`, `png-color-type`, `render-legibility`,
  `text-legibility`, `upload-size`, plus the measurements) and `ink-retention` when a verified
  source is given, plus `source-overlay` for any generated candidate. A failed or unassessable
  block result HOLDs the logo write unless a recorded override covers it; a
  `stylized_script_informational` render-legibility verdict does not block but requires the 4x
  crop in the proposal.

Knockout recipe: `restore-blocks` → `soft-fringe` (deglow if FAIL) → `counter-punch` →
`knockout` → `soft-fringe` + `holes` on the output.

## Workflow: brand N locations

1. Read `STATE.md`. Confirm the badge harness responds
   (`curl -s -o /dev/null -w "%{http_code}" http://localhost:3457/public/badge-preview-harness`).
2. Resolve each location via the read-only V2 database skill: name, address, website,
   google_place_id, existing branding (`branding` table: account-base row has
   `location_id IS NULL`), and the account's non-General enabled/paused location count (decides write scope). Always exclude `is_general = true` rows from matching and counts.
3. When `google_place_id` exists, fetch up to 10 photos before Fable starts:

   ```bash
   node scripts/fetch-google-place-photos.mjs \
     --place-id <google_place_id> \
     --out-dir <run_dir>/gbp-photos \
     --limit 10 --max-width 1600
   ```

   The helper loads `GOOGLE_PLACES_API_KEY` from the environment or standard Boostly env
   files. Never print the key. Keep `<run_dir>/gbp-photos/gbp-photos.json` with the proposal.
3b. INSTAGRAM EVIDENCE (Travisse, 2026-09-08, Park Avenue BBQ Grille). Runs beside the GBP and
   SearchAPI photo steps, before the packet is built, whenever a first-party Instagram URL exists
   (site footer or header social link, the GBP profile, or the V2 branding `instagram_url`).
   1. Open the profile with the Chrome extension in the logged-in Boostly.com profile: select the
      browser by deviceId `82f89fc7-1beb-407a-836a-66b4c38cc2ec`, never ask which browser; Travisse's
      personal profile is also logged in and is the fallback. Review roughly the first 24 to 36 grid
      posts plus the profile picture and the highlights covers.
   2. Classify, in priority order, and KEEP only: (a) posts showing the actual logo (the profile
      picture counts); (b) storefront and in-store photos showing signage, walls, menus, uniforms,
      packaging; (c) clearly branded flyers, menus, and templated posts that repeat one consistent
      color system across 3+ posts. IGNORE: food-only photos, reposts, stock-style Canva graphics
      that carry neither the logo nor the recurring color system, holiday one-offs, and employee
      spotlights unless they use the recurring template. Most grids are mostly slop; look for the
      logo and the color system first and skip everything else.
   3. Save 3 to 6 screenshots to `<run_dir>/evidence/instagram/` and write
      `<run_dir>/evidence/instagram/instagram.md` with: the URL, the post count reviewed, kept vs
      ignored counts, the recurring colors with sampled hexes and the number of posts each appears
      in, any logo variants seen (stacked, horizontal, one-ink, on-dark), and a one-line verdict on
      whether Instagram agrees with the website palette.
   4. PROVENANCE: a color that recurs on 3+ kept posts or appears in in-store photos gets the
      evidence class `instagram_recurring`, ranked ABOVE a website computed style (nav or footer
      computed backgrounds) but BELOW an authored logo ink and BELOW an explicit brand guideline. If
      Instagram and the website disagree on the primary field color, the variant sheet MUST include
      the Instagram primary on the same sheet: after `build`, run `variant-sheet.mjs add-row
      --primary <instagram_hex> --logo <png> --label "<treatment> on Instagram primary"` for each
      treatment (one sheet, new letters; never a second sheet or a stitched
      `variant-sheet-all.png`), and the Fable decision must name both primaries and explain the choice. Never record a hex sampled from a
      photo of a printed piece as authored: mark it `sampled` and snap it to the nearest authored
      token (logo ink, SVG fill, theme token) when one sits within a small distance.
   5. LOGO: if Instagram shows a logo variant the site does not (a one-ink mark, a stacked lockup,
      a version without the descriptor), record it as a candidate with provenance
      `instagram_profile` or `instagram_post`, subject to the same ship-gate and source-overlay rules
      as every other candidate. It is a lead for finding the real authored file (SOURCE LADDER), not
      a print-ready asset.
   6. FABLE INPUTS: the branding-evidence packet the Fable prompt receives includes the
      `instagram.md` summary and the kept screenshots. Output contract: when `instagram_recurring`
      colors exist, Fable's `rationale` must say whether they were used and why.
   7. SKIP: no Instagram link anywhere, a private account, or a login wall in the extension. Record
      `instagram: not available (<reason>)` in the manifest; never fabricate.
   8. MANIFEST: add an `instagram` block `{url, posts_reviewed, kept, recurring_colors: [{hex,
      posts, where}], logo_variants, verdict, screenshots}` so the review-queue ledger can surface it.
4. Build the deterministic packet:

   ```bash
   node --experimental-strip-types scripts/build-branding-evidence.ts \
     --input <branding-evidence-input.json> --out-dir <run_dir>/evidence
   ```

   When `location.website_url` exists, the input must include `website_visual_evidence` with
   `status: captured`, full-page `desktop_screenshot`, full-page `mobile_screenshot`, and a
   `computed_styles_manifest`. The manifest must contain non-empty `surfaces` with `role`, stable
   `selector`, `viewport`, `visible`, and exact computed `background_color`, `text_color`, and/or
   `border_color`. If capture is genuinely blocked, use `status: unavailable` plus a concise
   reason; never fabricate a receipt. The packet must contain ranked/deduped logo candidates with
   hashes/dimensions/provenance/measured colors/sharpness, visual website evidence, authored site tokens,
   GBP contact sheet + key details, the Instagram summary and kept screenshots (step 3b) when
   available, current production branding, feedback case, mechanical QA,
   and the complete reuse fingerprint.
5. Reuse a prior validated judgment only when `reuse.eligible=true` for the same complete
   first-party evidence fingerprint and a prior Fable-generated proposal. Current production
   branding, a production proof, or a prior preserve/hold decision is never a reusable Fable
   proposal. Otherwise run the Fable
   prompt and validate the returned JSON:

   ```bash
   node --experimental-strip-types scripts/validate-fable-decision.ts \
     --packet <run_dir>/evidence/branding-evidence.json --decision <fable-decision.json>
   ```

   Fable chooses an existing packet logo (including a provenance-labeled ImageGen candidate when
   the source-size failure path above was required) or null, recognized palette roles, and composition;
   it must add `mark_element_omitted` when a distinctive non-text element is absent and
   `low_sharpness_candidate` when it chooses a materially blurrier equal/adjacent-provenance
   candidate. The validator mechanically enforces the sharpness case; omitted-element detection
   remains Fable's bounded visual judgment. Fable never creates or edits an asset. When the packet
   carries `instagram_recurring` colors, the rationale must say whether they were used and why.
6. Deterministically apply the selected treatment, tightly crop only the removable outer canvas,
   run the crop gate and all other gates below, render
   `proposal-proof.png` through the real harness, and write the immutable manifest. Review each
   proof; surface all flags to Travisse. Hold anything
   flagged `location_address_unverified` or `mark_substitution` unless he clears it.
7. Create one feedback case from each final manifest and `proposal-proof.png`. Put its `branding_case_id` in
   the fulfillment audit and Slack reply metadata. See `references/feedback-schema.md`.
8. Append results to `STATE.md`.

If a location has no Place ID, stop the run before Fable or any write and text Travisse through
`/message-me`; do not continue using only first-party sources. If Places returns no photos or
the request fails, continue only when identity is otherwise confident, add a concise
`gbp_photos_unavailable` flag, and retain the error category without credential values.

## Workflow: reviewer feedback and learning data

The skill owns branding feedback. Fulfillment automation only detects/routes feedback and
calls this skill's CLI. Link discovery and heartbeat state never own branding feedback.

- Canonical ledger:
  `~/.claude/skills/boostly-brand-design/feedback/branding-feedback.jsonl`
- Generated manifests/proofs are immutable evidence. `create` snapshots the manifest content
  and hashes the artifacts; later actions append events and never edit prior rows.
- Preserve Cam's raw words verbatim, then add normalized tags. Record feedback before changing
  the brief, asset, colors, or production data.
- A revised proposal is a new manifest/proof appended with `revise`; do not replace the
  original run artifact.
- After an unattended production write, append `apply` with the production readback. This does
  not imply human approval. Append `approve` only after Cam or another human approves it; use
  `reject` when the generated direction is abandoned.
- Export reviewed cases for Fable evaluation with `export --reviewed-only`. Never train from
  an unreviewed proposal as if it were accepted.

Run the CLI with Node's TypeScript stripping:

```bash
node --experimental-strip-types scripts/branding-feedback.ts create --manifest <manifest.json> --proof <proof.png> --request-ts <slack_ts> --run-id <run_id>
node --experimental-strip-types scripts/branding-feedback.ts record --case-id <id> --reviewer Cam --feedback "<verbatim feedback>" --tags wrong_color,logo_crop
node --experimental-strip-types scripts/branding-feedback.ts revise --case-id <id> --manifest <revised-manifest.json> --proof <revised-proof.png> --actor <name>
node --experimental-strip-types scripts/branding-feedback.ts apply --case-id <id> --actor automation --production-readback <readback.json>
node --experimental-strip-types scripts/branding-feedback.ts approve --case-id <id> --reviewer Cam --notes "<approval note>"
node --experimental-strip-types scripts/branding-feedback.ts export --reviewed-only --output <training-set.jsonl>
```

Read `references/feedback-schema.md` before recording or consuming feedback.

## Workflow: write to V2 (only when asked)

Use `/boostly-instore-link-settings` (CLI wraps the production server actions):

- Auth: raw cookie header file (mode 0600, never printed). If stale, mint a fresh one with
  `node scripts/decrypt-boostly-cookie.mjs --out <file>` (Chrome Profile 10, new.boostly.com).
- Scope is auto but VERIFY it: ignore General locations; use account scope when the account has exactly one non-General enabled/paused
  location; use a location override when it has several non-General locations (never bleed onto sibling brands, River
  Grille shares an account with Daddy Matty's BBQ).
- Always: `branding get` → dry-run `branding set` (inspect before/after + selected scope) →
  `--apply` → readback verify. Report exactly what changed.
- WIZARD OVERWRITE RISK (mandatory before every `branding set --apply`, added 2026-09-10): the
  onboarding wizard's brand step is hidden, but `createOnboardingSession` still seeds a guessed
  `branding` object (website color extraction + logo_url) into `onboarding_sessions.account_settings_payload`,
  and completion/submit still replay it onto the account base row as a FULL replace (all seven colors +
  logo, nulls included). A CSM completing the wizard after our apply silently wipes it (Falafel etc.
  and Faith Hope & Charity, both 2026-09-10; both restored). Until the fix PR ships: query
  `select id, status, account_settings_payload ? 'branding' from onboarding_sessions where account_id = <acct>`
  and, when a non-completed session carries a branding key, record `wizard_overwrite_risk: true` in the
  manifest, list the session id in the run's OPEN items and the Notion entry, and re-check the account row
  (`branding get`) before marking anything ready to print. After a completion, re-verify the row against
  production-readback.json before trusting proofs.
- SECONDARY LOGO (light backgrounds, V2 2026-10): the branding row carries a second logo,
  `secondary_logo_attachment_id`, for light surfaces. It is the on-white sticker asset (authored
  inks on transparent or white, the file the sheets' stickers use), never the knockout card asset.
  It is written at finish, by the `closeout-finish` agent after Travisse approves the Figma
  signage, with `branding set --secondary-logo-file <sticker> --scope <write.scope>
  --expect-from-readback production-readback.json`, never at fulfill and never in the first
  branding apply. The closeout records the file in run.json `write.sticker_logo_file`; the finish
  records the receipt in `write.secondary_logo`. `branding get` shows it as
  `secondary_logo_attachment_id` / `secondary_logo_url` / `secondary_logo_filename`.
- Every `branding set` after the first apply must carry `--expect-from-readback <run-dir>/production-readback.json`
  so the CLI refuses (exit 6) to replay a logo someone else uploaded since our last write (2026-09-09 Swine Dining
  phone-photo incident: a two-color follow-up write carried a foreign JPG forward with a clean before/after diff).
- FINALIZE CARD ASSET (one step, every card upload; consolidates BYTE BUDGET, KNOCKOUT EDGE
  SHARPNESS, and TINY-SOURCE RESCUE, 2026-09-08). Run in this order on the chosen card cut and
  record every intermediate byte count and path in the manifest:
  1. SOURCE RESCUE: walk `references/logo-source-ladder.json` in order and record every rung
     tried in the evidence input's `logo_sources[]` before any trace; a trace is allowed only
     when every rung at or above the 700px floor was tried (the validator refuses it otherwise).
     For solid single-ink display type prefer a vector trace of the NATIVE source (potrace on a
     clean 128-threshold binarization; `-a 1.2 -O 0.3 -t 6`, pgm backend at 2x) over AI raster
     upscale, verified by a full-mark overlay diff (mismatch confined to 1px edge antialias;
     counters, apostrophes, punctuation, serifs intact), rendered at the final size directly.
  2. EDGE CHECK: zoom a 300px letter crop at 3x nearest on the card color. Soft or haloed edges
     mean re-cut (trace as in step 1: bicubic-upsample alpha 2x, binarize at 128, potrace, LANCZOS
     down, alpha snap), not ship. Compare the full mark side by side (counters, dots, ring intact).
  3. BINARY ALPHA for flat knockouts and traced marks (snap >=128 to 255, else 0, zero RGB under
     alpha 0) ONLY at 1000px and above; under 1000px a binary-alpha file prints hard stair-steps
     and `edge-quality` blocks it (Skyboxx 2026-09-21, 800px): render from the vector at 2x and
     LANCZOS down with the anti-aliased alpha kept (quantized to about 9 levels is fine). For
     marks with a genuine soft gradient or shadow the reviewer wants kept, snap only >=240 to 255
     and <=12 to 0 and zoom-compare an edge crop against the pre-snap file.
  4. ENCODE with max-effort lossless truecolor PNG (sharp `png({palette:false, compressionLevel:9,
     adaptiveFiltering:true, effort:10})`).
  5. TINYPNG, always: `node scripts/tinypng-compress.mjs --in <final.png> --out <final.tinified.png>`
     (key `TINYPNG_API_KEY` in `/Users/travisse/Programming/product2/shared/apps/brand-extractor-figma/.env`,
     never printed; re-encodes indexed output back to truecolor; fails closed on changed dimensions
     or lost transparency; keep the smaller file on a no-gain result). The tinified file is the upload.
  6. BYTE LADDER: still over 70,000 bytes, step the longest side down in 100px decrements,
     re-tinifying each step, never below 1000px and never below the 700px ship-gate. At the floor
     and still over, write an explicit textured-art exception in-thread with the before and after
     edge crops; never ship over the max silently.
  7. EDGE CROP PROOF: save a 3x edge crop of the final file on the card color next to the proof
     (`fix/edge-crop-3x.png`) and rerun the full final battery on the exact final file.
  Targets, from Cam's Friday walkthrough: shipped logos run 160 to 300px on the long side and under
  40KB, white knockouts 6 to 7KB; treat those as the goal, 70,000 bytes and 700px as the hard rails.
  Palette quantization is banned at every step (React-PDF corrupts indexed PNG transparency); never
  meet the budget with indexed PNG or JPEG.
- WHOLE-ROW REPLAY TRAP (2026-09-01, Tony & Tina's null-palette incident): `branding set`, including a logo-only `--logo-file` write, reads the current row and resubmits EVERY
  branding field from that read (CLI `mutateBranding` spreads the fresh read and applies only
  the supplied flags). It preserves colors/socials only as faithfully as its own read:
  pre-existing nulls or corruption get re-written, and a concurrent writer's changes landing
  between the read and the apply are silently reverted. Therefore: (1) before any logo-only
  write, verify the palette in that same readback against the run manifest, a before/after
  drift check alone cannot catch damage that predates the write; (2) never run concurrent
  branding writers against one account; (3) after apply, confirm palette values EQUAL the
  manifest, not merely "unchanged".
- Logo upload: `--logo-file <png>` (create the 1600px upload copy with the harness
  `resize-alpha` command, then rerun `border-dust`; never use `sips`). If an upload returns
  success=true with a null `logo_attachment_id`, check the CLI's multipart part ordering first:
  the file part must precede the root "0" model, because decodeReplyFromBusboy resolves $B refs
  only against parts already streamed.
- Existing logo to keep? Omit logo flags entirely, colors-only writes preserve it.
- Existing branding to keep still requires a fresh resolved effective proof, proof receipt
  validation, and `validate-logo-surface.ts`. Persist those results as `effective_branding_qa` in
  the fulfillment plan. Only `status: reuse` with all three passes may be treated as accepted
  existing branding; a failure must use `status: hold` and name the visual defect.
- Before any logo write, persist final-asset QA in the fulfillment plan: final file path,
  `ship-gate`, `logo-crop`, `border-dust`, `soft-fringe`, source-preservation verdict,
  `render-legibility`, `ink-retention`, `interiorLowContrastShare`, and upload bytes. The exact
  final file must be <=70,000 bytes.
  A PNG must be truecolor RGB/RGBA (PNG color type 2 or 6), never indexed/palette (color type 3).
  Run `node --experimental-strip-types scripts/logo-quality-gates.ts png-color-type --logo
  <logo>` against the exact final upload and require `pass=true`; file-size and visual gates do
  not substitute for this transport check.
  React-PDF (pdfkit) garbles palette PNGs whose bit depth is under 8 (a 16-colour Pillow/pngquant
  file is 4-bit): the badge prints a gray smear or doubled glyphs (Swine Dining + Wok the Line,
  2026-09-10). An 8-bit palette happens to survive, but the truecolor rule stands; do not rely on it.
- BADGE PDF PROOF (mandatory after every `branding set --apply`, colors or logo): run
  `scripts/render-badge-pdf.sh --readback <readback.json> --out <run>/fix/<step>/badge-proof.png
  --short-id <badge short id>` (pass `--logo-url <cdn url>` when the readback lacks logo_url;
  zsh script, invoke directly, ABSOLUTE readback and out paths since it cds into the worktree). It
  renders the front of one badge through the app's real react-pdf document and rasterizes it at
  300 dpi; look at the PNG. The QR modules and the "Scan for Options" label are drawn in
  print_text_color on print_primary_color, so a print palette whose text ink matches or nearly
  matches the card (Tony and Tina's 2026-09-10: print primary and print text both #000000 after
  the 9/3 black recolor) prints a card with NO QR. Require print text vs print primary >= 3.0
  (the script prints the ratio), the logo visibly intact, and record the proof path in the manifest.
  The web proof (`render-effective-proof.ts`) does not exercise the print palette or react-pdf.
  Do not meet the byte limit through palette quantization: React PDF 4.3.x corrupts indexed PNG
  transparency in downloaded badge files even when the HTML preview looks correct.
- After production readback, download and render one real badge PDF for the exact location. Compare
  its logo with the final upload and HTML preview. Fragmentation, missing pixels, unexpected scale,
  or an opaque panel is a hard failure; a web-only proof cannot approve the asset.
  The plan must reject missing QA or any failed verdict. Immediately before dry-run/apply, the
  fulfillment executor independently runs `gates.ts check` (the full registry battery plus the
  run's override records) on that same file and primary color and refuses the write on HOLD.
  Model confidence and an outer aggregate pass boolean can never override an inner gate failure;
  only a recorded override on an override-allowed gate can, and it is data, not a rule change.
- After `--apply`, persist the fresh `branding get` output and generate the final digital proof:

  ```bash
  node --experimental-strip-types scripts/render-effective-proof.ts \
    --readback <run_dir>/production-readback.json \
    --location-id <location_id> \
    --out <run_dir>/proof.png
  node --experimental-strip-types scripts/validate-effective-proof.ts \
    --readback <run_dir>/production-readback.json \
    --metadata <run_dir>/proof-branding.json \
    --proof <run_dir>/proof.png \
    --plan <fulfillment-plan.json> \
    --location-id <location_id>
  ```

  `proof-branding.json` is the deterministic parity receipt. When the plan writes a logo, the
  validator requires a non-null readback attachment ID and visible non-background ink in the
  proof logo region; otherwise it fails `proof_missing_logo`. The validator must exit 0 before an
  applied run sends `proof.png` to Slack or Notion.
  Use `--mode print` only for an additional explicitly labeled print proof; the default digital
  proof uses resolved web colors because that is what the production preview shows first.

## Eval mode (regression against gold)

Gold cases in `gold-batch*/` + success CSV; blind protocol: subagents run steps 1-5 without
gold access; the CIEDE2000-per-color-role grader (`eval-grade.mjs`) was retired with the harness
move on 2026-09-16, so grade against gold by hand or restore it from the spike project git history.
Fable + the brief is the production path (last tally 40/42 correct logos; other models were
benchmarked lower and are not used for the judgment).

## Known open items

- Still-open taste rulings for v1.4: text-color rule (white vs highest-contrast), D'Al's
  two-color dark-ground rule, Shenanigans fused-lockup isolation.
- Cam's review doc (Notion, one HTML block per location) may carry comments to fold in.

## Rules from review incidents (August-September 2026)

These are current operating rules, each written against a reviewer-caught failure on a recent
production run; the incident is kept as the reason. The source-finding rules share one
principle, the SOURCE LADDER, which lives as data in `references/logo-source-ladder.json`
(rungs in order with fetch hints and minimum useful px, floor 700px for any trace; record every
rung tried in the evidence input's `logo_sources[]`). An invented recomposition or a generated
mark is never a rung and is never applied without approval; image search is a locator, never a
source to ship from.

- DOM-RENDERED IDENTITY (Travisse, 2026-08-21, Skyvibe): when the site's dominant on-screen
  identity is live HTML text (a webfont hero/header wordmark) rather than an image asset, the
  candidate pool MUST include a DOM capture of that rendered lockup, use
  harness/capture-dom-lockup.mjs (in-place capture: hides off-path nodes, strips
  backgrounds/box-shadows/text-shadow/filter, 4x device scale, transparent PNG; provenance
  first_party_other). Uploaded logo files can lag or contradict the rendered identity; the
  Skyvibe script-vs-sans miss shipped the wrong mark until reviewer-caught. Also: ink-retention
  on tight-cropped art must run on 8px-padded copies of BOTH source and final (the gate's
  border-dust eraser silently deletes border-touching glyphs <=2% of ink).
- REVIEWER TRIAGE LINKS (Travisse, 2026-09-02, Cam's three-tab triage): the three links Cam opens
  to confirm the mark currently in use, the website URL, the GBP place link
  `https://www.google.com/maps/place/?q=place_id:<google_place_id>`, and a Google Images logo
  search, live on the review canvas (rule 2c) and in the one close-out Slack post
  (boostly-box-fulfillment step 11); there is no separate triage reply anymore. The image search
  is a LOCATOR for the currently used mark and larger authored variants (Mara's wordmark, David's
  newer mark), never a source to ship from directly; provenance must still resolve to an authored
  first-party or aggregator asset. If the newest GBP photos / site header show a different mark
  than the candidate, the newer mark wins and the post gets a one-line note.
- CUSTOM MARK CREATION (Travisse, 2026-09-02): when no usable authored source exists after the
  TINY-SOURCE RESCUE ladder, do NOT stop at a flag, generate a custom simplified mark with the
  `image-generator` skill (OpenAI gpt-image-2 primary; pass the best authored source via `--ref`
  and describe the wordmark/colors exactly), run it through the full gate battery like any
  candidate, and post it in-thread labeled GENERATED, NEEDS REVIEWER APPROVAL. Never apply a
  generated mark to production without Travisse/Cam approval in the thread.
- STARTED PLACEHOLDER (Travisse, 2026-08-24) is RETIRED (2026-09-21): Slack gets exactly one post
  per location, the automatic close-out result of boostly-box-fulfillment step 11
  (`boostly-signage-sheets/scripts/post-review.mjs --apply`); no placeholder, no progress edits.
- CARD LOCKUP LADDER (Travisse, 2026-09-08, from Falafel coins, Piazza descriptor, Tillie's
  "since 1984", Mario's phone, Denise's tagline, Bunker and Cleveland descriptors): the reviewer's
  card edit was the same move every time, so it is now the default, not a request. For the chosen
  mark the runner always produces three labeled variants: FULL (the authored lockup),
  DESCRIPTOR-FREE (taglines, "est." and "since" lines, phone numbers, city lines, slogans, and drop
  shadows removed), and WORDS-ONLY (business-name words only, emblem and illustration dropped).
  The card asset DEFAULTS to the descriptor-free cut when a descriptor exists, and to words-only
  when the descriptor-free cut still fails the tiny-text gate; the sticker always keeps the FULL
  lockup (STICKER SCALE COMPOSITION). All three appear as rows on the variant sheet (rule 2b), so
  the reviewer picks a letter instead of asking. Cut deterministically with
  `node scripts/cut-words.mjs --in <knockout.png> --out <words.png> --json <components.json>
  --white --width 1600 --binary-alpha [--band y0,y1] [--keep-ids ..] [--drop-ids ..]`: it labels
  8-connected components, clusters them into text lines, drops arcs/rings/frames (wide giants that
  wrap a word line, or that border enclosed space), drops lines under half the name line's
  ink-weighted height, and mask-strips the rest with its antialias fringe (never a row/column
  crop; BAND-CROP BAN still applies). Read the JSON: every component has a decision and a reason;
  a nested swash initial or an attached illustration that stays in the name band is refined with
  `--drop-ids` or `--band`, never by hand-painting. Astoria's pinned-tab badge reproduces the
  shipped 19-letter cut with no hints; Denise's script yields the descriptor-free lockup (cupcake
  kept, tagline gone), and a true words-only cut there comes from the imagegen words-only path
  below. Ghost-clean and `verify-erase` rules still apply to any rect repaint done on top of a cut.
- IMAGEGEN KNOCKOUT CANDIDATE (experiments/imagegen-2.5/REPORT.md, 2026-09-08, 24 paid calls): at
  candidate prep, after the source hunt picks the authored mark and before the gate battery, add an
  `imagegen-knockout` candidate NEXT TO the deterministic knockout, never instead of it:
  `node scripts/imagegen-knockout.mjs --source <first-party.png> --reference <deterministic-knockout.png>
  --out-dir <run>/candidates --expected "<Business Name>" --primary <hex> --provenance <first_party_*>
  [--remove "the tagline '<text>'"] [--mode words-only]`. The script measures eligibility itself and
  exits 2 without spending when any test fails: first-party provenance, longest side >= 800px, flat
  ink (under 8% of interior ink outside the six main colors), not textured or distressed, not a fine
  emblem with no dominant component. NO-GO cases, do not force with `--skip-eligibility`: photographed
  or painted lettering (Midnight Munchie: the model typesets a substitute face and every gate passes
  anyway), illustrated emblems from tiny sources (Fox's 177px), textured or distressed marks (David's),
  any mark with small punctuation from a low-res source (Mara's lost apostrophe), and color upscales
  of illustration (Astoria: sunburst invented keylines). Call: gpt-image-2.5-sunburst, quality high,
  1536x1024, transparent, the prompt template from the report (flare drifts letterforms; `max` and
  `xhigh` bought nothing; `low` re-kerns). Cost about USD 0.05 and 20 to 30 s per candidate; the
  receipt JSON next to the candidate records model, prompt, usage, and every gate. Post-processing is
  not optional: 2.5 never returns alpha 255, so the script snaps alpha at 128, forces RGB white,
  zeroes RGB under alpha 0, and tight-crops at 2% pad before `ship-gate`, `border-dust`,
  `png-color-type`, `render-legibility`, `text-legibility --expected`, and `source-overlay` against
  the deterministic knockout (IoU >= 0.75, component count within 10%). The candidate enters the
  evidence packet with provenance `imagegen_sunburst` and its overlay PNG; Fable compares it with the
  deterministic knockout at zoom and picks like any candidate, the deterministic one wins ties, and
  a candidate whose `source-overlay` failed is never applied even if Fable prefers it. WORDS-ONLY VIA
  IMAGEGEN: when `cut-words.mjs` cannot isolate the name (nested swash, illustration fused into the
  name band), run the same script with `--mode words-only` (part extraction, which the report rated
  strong) and feed the result into the CARD LOCKUP LADDER as the words-only row, same gates, same
  overlay against the deterministic cut or source ink. The Rule-5 "simplified lockup" path and CUSTOM
  MARK CREATION stay unchanged for marks with no usable authored source.
- MINIATURE ILLUSTRATION RULE (Cam, 2026-09-01, Mara's): when the leading candidate carries
  miniature illustrations or fine line-art that renders illegible or noisy at the tapcard product
  size, do NOT ship it on the card even when the gates numerically pass. Hunt for an authored
  simplified variant (wordmark-only lockup) across first-party surfaces AND wider authored
  placements, packaging/cup stickers, gift-card platforms (eGifter served Mara's exact stacked
  wordmark from squarecdn), GBP photos, image search as a locator only, and ship that on the
  card; the ~3in sticker may keep the fuller lockup. The simplified variant usually also resolves
  byte-cap violations (Mara's badge 295KB -> wordmark 33KB). The descriptor-free and words-only
  cuts themselves are produced by the CARD LOCKUP LADDER; this rule is about hunting an AUTHORED
  simplified variant first.
  TINY-SOURCE RESCUE (same incident, r3): Mara's r2 shipped staircase edges from an AI upscale of a
  sub-300px source ("insanely pixelated"). The rescue order is `references/logo-source-ladder.json`
  (step 1 of FINALIZE CARD ASSET); `edge-quality` now measures the result.
- SECONDARY COLOR PROVENANCE (Travisse, 2026-09-02, Kabob Connection): the secondary role is
  printed as the tap-card band and the issue-badge fill, so it must be an ink that lives in the
  mark or on in-store materials (menu boards, storefront, packaging) before a website theme
  accent. Kabob shipped the site's decorative tan (#E4C590, subtitle/CTA/frames) while the logo
  flame and every menu board are orange; the fix was the flame ink (#F5A411). Provenance order:
  (1) a non-text ink in the chosen mark, (2) a color dominant on in-store photos, (3) the site
  accent. Sample photo colors as a locator only (warm lighting shifts them; the menu-board photo
  read #C8864B) and take the exact value from the mark or computed styles. When (3) is the only
  candidate, render the card with the (1)/(2) alternative alongside and present both.
  MECHANICAL FORM (Toscano's cream, Skyboxx tan, 2026-09-16/17): `validate-fable-decision.ts`
  marks `band_over_brand_ink` when Fable's secondary is a neutral (chroma under 0.15) or is not
  an ink of the chosen mark while the mark carries a saturated ink of at least 3% share that
  reads on the primary; the sheet then makes that ink's cell the default and Fable's cell is
  just another column. A site accent never outranks a mark ink, however small the ink.
  CORRECTION (Travisse, 2026-09-02, Mario's): "in-store material" means the reviewer LOOKED at the
  whole photo set and judged what dominates, not a pixel sample from one element. A numpy sample
  found green trim on one storefront photo and proposed a green band for a shop that is red and
  black everywhere else; rejected. Before proposing any palette change from photos, build a
  contact sheet, view it, and state what dominates in words. A single sign element never
  outweighs the mark's own inks plus the rest of the photos.
- BADGE DIGIT CONTRAST (Travisse, 2026-09-02, MezeHub): the tap-card issue badge is filled with
  the secondary color and its digit uses the text color, and the digital preview uses
  web_text_color for both text roles. Any palette where secondary and text are within 3:1
  (black band + black text, white band + white text) prints an empty badge. Check
  secondary-vs-text contrast >= 3:1 on every proposal and every variant render; a black band
  forces white text.
  LIMIT (Travisse, 2026-09-02, David's; amended Q3 = A, 2026-09-22): the fix must use a color the
  brand already uses (a mark ink, or a value visible in-store), and never a lighter tint of one;
  darker steps of a real brand hue are allowed when the real ink fails the band or digit contrast
  (Fresho C: sage #93AD98 -20% carries a white digit; That's a Wrap K: #1A1A1A band over black).
  A lighter synthetic step is never a pick (Coloradough AA, "from nowhere real"); the validator
  rejects it as `band_lighter_synthetic`. If no brand color or darker step fixes it, keep the
  palette and report the failing surface as informational: the app preview badge is low-stakes,
  the printed card uses print_text_secondary and is usually fine. Do not ship a worse-looking
  card to satisfy a number.
- KNOCKOUT EDGE SHARPNESS (MezeHub, 2026-09-02): a knockout that meets the size floor can still
  carry upsample blur from its extraction (MezeHub went 800px soft -> 800px crisp at 44KB via a
  trace). The check and the re-cut recipe are steps 2 and 3 of FINALIZE CARD ASSET in the write
  workflow; never ship a knockout without that zoom.
- VARIANT RENDERS FOR A COLOR CALL (Travisse, 2026-09-02): when the reviewer says a card looks
  washed out or asks "what about X color", do not describe options; render them through the
  harness renderer with the exact field values (`harness/screenshot.mjs --primary --secondary
  --text --text-secondary --logo`) and a one-row montage with the live card first. The renderer
  exposes production behavior (badge fill, band, text roles) that a description misses.
- ADDING A LOCATION TO AN EXISTING ACCOUNT (Travisse, 2026-09-03, FH Pizza Franklin): before
  building evidence or launching Fable, check whether the account already has shipped branding.
  Steps: (1) `run_read_query` fulfillment_requests for every location on the account; any row
  with digital_fulfilled_at or a tracking_number means a prior fulfillment exists. (2) `branding get`
  on the account base AND every sibling location; compare palette + logo_attachment_id.
  (3) If the account base branding is real first-party (not template/wizard defaults) and a sibling
  shipped with it, the new location INHERITS it: do not run Fable, do not propose a new palette or
  mark. The only permitted write is clearing or correcting the new location's own override row
  when it points at a worse asset (Franklin's override was a cropped opaque JPG of the same lockup).
  Still run the full mechanical battery + proof on the effective (inherited) branding, still pull
  the new store's GBP photos, and still note quality-bar failures as informational.
  (4) If siblings diverge from each other (Bowling Green had its own near-white/red override while
  Morgantown used the account base), inherit the account base, report the divergence, and let
  Travisse decide whether to unify. Never edit a sibling's branding as part of the new location's run.
  (5) Only fall back to the fresh-evidence + Fable path when the account has no shipped branding,
  the base branding fails gates, or the new location is a genuinely different brand on a shared
  account (River Grille / Daddy Matty's case).
- SIBLING-LOCATION PHOTOS (Travisse, 2026-09-03, Vito's): when the location's own GBP photos are
  thin or food-only (no interior, signage, or storefront) and the brand has other locations,
  pull the siblings' photos before judging in-store color or vibe. Recipe: Places text search
  `POST https://places.googleapis.com/v1/places:searchText` with `{"textQuery":"<brand> <city/state>"}`
  and field mask `places.id,places.displayName,places.formattedAddress,places.websiteUri`
  (GOOGLE_PLACES_API_KEY, same key as fetch-google-place-photos.mjs); then run
  fetch-google-place-photos.mjs per sibling place_id into `sibling-photos/<place_id>/` and
  build one contact sheet per store. SearchAPI is the fallback. Record which siblings were used;
  a franchise's shared decor counts as in-store evidence for the target, a one-off store's does
  not. Skip the franchisor listing (e.g. "Vitos Franchising LLC").
- QUALITY BAR: REFERENCE TAPCARDS (Travisse, 2026-09-03). `references/tapcard-design-examples.pdf`
  (16 cards) is the standard every proposal is checked against before it is posted. What the
  reference set does, as checks:
  (1) Primary is a saturated brand color or the brand's own cream/tan/black. Never a neutral or
      a muted site-theme value. Sonic red, Yoo yellow, Garage Grill blue, Chubby's tan. NEVER
      white or near-white (That's a Wrap 2026-09-17: the primary is also the touchpoint page
      background and a white one makes the link tree look broken): a neutral-ink mark takes a
      BLACK card with a white knockout, and `primary-too-light` blocks anything under 1.3:1
      against white. Only white and near-white are banned (Q8 = A, 2026-09-22): a brand's own
      authored cream or tan is allowed as the card when text reads black on it (Chubby's tan;
      That's a Wrap C white rejected).
  (2) Band is a SECOND brand ink, usually the mark's complementary color (blue under yellow,
      pink under orange, dark red under red, red under blue). A dark band is only right when
      black/charcoal is genuinely the brand's ink (Buffalo Wild Wings, Beehive), never as a
      default neutral. This is the mechanical form of Cam's "use a logo color" call.
  (3) Text and NFC icon take black on light cards, white on dark/saturated cards, or the band
      ink when it clears contrast (Yoo blue on yellow, Wingnutz red on yellow, Little India navy).
      Prefer the band ink when it passes; it ties the card together.
  (4) Badge is band-filled with a readable digit (white or the text color); check it in the render.
  (5) Logo treatment follows the card, not a fixed rule: full-color emblem on a light card
      (Yoo, Sonic, Dough Factory, Chubby's, Aunty's); white knockout on a saturated or dark card
      (Chick-fil-A, Peach Cobbler, Garage Grill, Armada); or a SINGLE-INK knockout in a brand
      color on a light card (Wingnutz red, Onoh's dark red, Beehive black). White is not the
      only knockout; a brand-ink knockout is often the better card. NEVER default to a
      solid-silhouette knockout that fills authored negative space (snow caps, gaps between
      elements, letter counters) just to keep 100% of the source ink: it turns the mark into a
      blob nobody recognizes (Coloradough Pizza 2026-09-18, Travisse: "makes the logo hard to
      even tell what it is"). Prefer the OPEN knockout that matches the in-store mark, let the
      card ground read through the authored white, and when `ink-retention` reports
      `authored_white_dropped` record that decision as an override (it is a human
      recognizability call); a solid silhouette is only a candidate when the authored white is
      itself the ground, never the default. EMBLEM DEFAULT (Q7 = A, 2026-09-22): when an
      illustrated emblem loses its interior detail in a knockout, the default card is WORDS-ONLY
      (business-name words, `mark_element_omitted` flagged) and the full emblem lives on the
      sticker and POP (Katy Q). An open or outline knockout may be offered as a second row, never
      as the default (Coloradough AD was a human pick); the validator refuses a collapsed emblem
      knockout without one of those two paths (`emblem_knockout_needs_words_default`).
  (6) Logo sits centered in the top third at roughly 45-55% of card width with air around it;
      small or busy marks are not enlarged to fill.
  (7) Two or three colors total, all from the brand. If a proposal needs a color the brand
      does not own, it is wrong.
  Before posting any card, render it and compare it against the sheet: would it sit in that
  grid without looking like the odd one out? Say which reference card it is closest to.
- AUTHORED COMPOSITION FIRST (Travisse, 2026-08-24, Mad Claw): when a mark needs recomposition,
  find an AUTHORED alternative composition first, physical signage (GBP/storefront photos), site
  responsive variants, sibling-location assets, before inventing a re-wrap. An invented re-set
  (single-line re-wraps included) is a last resort and needs the reviewer shown the proof. The Mad
  Claw one-line re-wrap shipped misaligned words while the storefront sign showed the authored
  claw + stacked-name lockup all along.
- BAND-CROP BAN (same incident): NEVER extract word/glyph pieces by luma-threshold row/column bands , 
  threshold crops shave antialiased edges asymmetrically ("Claw" lost 33px vs siblings) and crop-box
  alignment is not baseline alignment. If recomposition is truly required, cut whole CONNECTED
  COMPONENTS (alpha>32) with padded exact bboxes, align by per-piece ink baselines, and zoom-inspect
  every piece at 2x before compose. Also verify the assembled words' cap heights match within 3%.
- REVIEWER OCR OVERRIDE (same incident): the product-size OCR gate is a proxy for human readability;
  an explicit reviewer composition directive backed by physical signage supersedes it. Record it as
  `run-file override <run> --gate text-legibility --asset <final.png> --reason "<directive + signage
  evidence>" --decided-by travisse` (the registry allows the OCR-miss verdict only; filled counters
  stay hard); never self-grant it, and never edit the gate to make it pass.
- REPAINT-REGION PROOF (Travisse, 2026-08-24, Mad Claw r4, the clip survived TWO reviews): when
  repainting/filling any region inside a mark (handle strips, descriptor boxes), NEVER locate the
  region by "first matching pixel from a guessed boundary", neighboring glyph ink gets eaten (the
  Claw bottoms were the first white below the guessed y and lost 43 rows). Locate target elements by
  their STRUCTURAL signature (e.g. per-row max run length: a box frame runs full-width, glyph rows
  don't), leave a measured blank-gap margin on every side, and AFTER the repaint zoom-render the
  adjacent glyph edges at 2x and visually confirm every letter silhouette is intact before any
  downstream step. A defect introduced here propagates into every later variant. MANDATORY MECHANICAL GATE: after every region repaint, run
  `harness/iterate-logo-rules.mjs verify-erase <original> <edited> <x0> <y0> <x1> <y1>`: it proves
  pixels outside the rect are byte-identical AND that no glyph ink crossed the rect boundary in the
  original (a crossing means the fill amputated a neighboring glyph; the Mad Claw bad rect fails it
  with a 175px top-edge crossing run, the corrected rect passes). Hard gate, never skipped.
- GHOST-CLEAN STRIP PROBES (Falafel etc r2->r3, 2026-08-28): when gating a stripped-variant probe,
  the removed element's soft SHADOW/GLOW GHOSTS must be rect-cleared (verify-erase PASS) BEFORE the
  gate runs, or the gate indicts the wrong element, Falafel's coins were stripped because a
  descriptor-ghost-polluted probe failed render-legibility (0.433); the properly ghost-cleaned
  coins-restored variant passes at 0.0565. Never conclude "element X must go" from a probe that
  still carries element Y's residue. A reviewer caught the wrongly-stripped coins; the gate math
  was innocent, the probe hygiene wasn't.
- LOGO FINALISTS AS FILES (Travisse, 2026-08-28): the ACTUAL production logo files (the applied
  card PNG and the sticker PNG) travel with the one close-out post of boostly-box-fulfillment step
  11, labeled chosen / sticker; rejected finalists stay in the run dir and on the variant sheet.
- STICKER LOGO / ON-WHITE VARIANT (Travisse, 2026-08-25): every fulfillment run also produces a
  STICKER LOGO that reads on WHITE. Physical signage stickers (Figma plugin in product2) place the
  logo on a white field below a band in the tapcard's web_primary_color, so the card asset is often
  unusable there (validated: the shipped Mad Claw, 1916, and Ohio Grille finals are all white-ink and
  fail `component-contrast vs #FFFFFF`). Rules:
  1. Prefer the authored mark as-is when it passes on white; when the card asset is a knockout or
     card-locked variant, cut the sticker variant from the SAME verified source with its authored
     dark inks. Fable directs the choice (composition text or revision); the runner executes.
  2. Hard gates vs #FFFFFF on the sticker asset: `iterate-logo-rules.mjs component-contrast`,
     `interior`, plus the standard soft-fringe / border-dust / ship-gate / png-color-type battery
     and render-legibility.
  3. Context proof: `harness/sticker-mock.mjs --logo <sticker> --primary <web_primary_color>
     --out <run>/fix/sticker-mock.png` renders the sticker form factor (band + copy + logo + QR).
     Its QR is a seeded MOCK for color/composition proof only. The script hard-fails (exit 3) when
     contrast(primary, white) < 3.0, that endangers the band copy and a primary-ink QR; the band
     color is fixed to the tapcard primary, so surface the failure to the reviewer, never self-waive.
  4. Slack: append sticker-mock.png to the proof reply. Manifest: record sticker_logo and
     sticker_mock paths. The Fable decision stays six keys; the sticker asset is directed in
     composition text and recorded in the manifest.
  5. Storage: production has no account-level alternate (on-white) logo field yet, so the
     sticker asset ships in the run dir + Slack only. When `branding get` exposes an alternate
     logo field, apply the sticker asset the same way the main logo applies.
  6. STICKER BAND COLOR (Travisse-ratified 2026-08-27, from the 5-way Figma comparison): the band is
     the HIGHEST-CONTRAST-ON-WHITE authored brand role (WCAG >= 3.0 vs white), preferring
     web_primary_color only when it passes. Shipped Figma practice picks the strongest dark role
     (Sexton green over gold, Zo navy over pale, Rebel navy over white), so a light primary means
     the band moves to the darkest authored role, no reviewer round-trip needed; flag only when NO
     authored role clears 3.0. The mock QR renders in the band color.
  7. STICKER SCALE COMPOSITION (same ratification): stickers print at ~3in, not 126x56, card-size
     simplifications MUST NOT cascade into the sticker asset. Prefer the fullest authored lockup
     that passes on white (ring text, descriptors, and decorative elements stay). Card OCR gates do
     not apply at sticker scale. Component-contrast vs white: text components keep the 3.0 floor;
     non-text decorative components relax to 1.8 (visible in print), below 1.8 still strips, with
     the omission flagged. Validated: Figma shipped Manjay's teal star and Random Arts' ring text on
     stickers; our card-driven strips were over-conservative there.
  8. ENFORCED BEFORE FIGMA (The Place Pizza, Arnold's, 2026-09-17/18): the sticker and POP-on-white
     asset must be transparent-ground and pass on white BEFORE the signage build: run
     `gates.ts check --asset <sticker_logo> --color #FFFFFF --surface sticker` (battery against
     white plus `sticker-ground`, an authored panel is still a panel on a white sticker, plus
     `component-contrast` vs white). `boostly-signage-sheets/scripts/plan.mjs` runs the same check
     on its `--logo` input and refuses a HOLD. When it fails, prefer the authored DARK variant of
     the same mark (Arnold's navy badge) over any recolor.
  9. OPAQUE PANEL, TWO STANDARD FIXES (Toscana Gourmet Pizza 2026-09-22, Travisse: "either in a
     circle of black like we did with the one yesterday or strip the black background"): an
     opaque-ground sticker asset is never rendered on the sheet or in signage. Run
     `scripts/sticker-panel.mjs --logo <src> --out <png> --mode circle` (art centered by its ink
     bbox in a circular panel of `--bg`, default #000000, `--pad 0.12`; the Coconut Thyme
     panel-circle recipe) or `--mode strip` (ground keyed out by color distance with a soft edge,
     truecolor RGBA), both >= 1000px, then gate the output with
     `gates.ts check --asset <png> --color #FFFFFF --surface sticker` before it goes on the sheet
     (`add-row --sticker-logo <png>`) or into Figma. Which of the two is a Fable/Travisse call.

## Downstream: signage print sheets

Physical signage generation (batched print sheets in Figma, Cam's production
format) is a SEPARATE skill: `boostly-signage-sheets`
(~/.claude/skills/boostly-signage-sheets/). It consumes this pipeline's
outputs (applied branding, the color sticker logo, the band color) plus the
fulfillment request's table/stall counts. Run it at fulfillment time, after
branding is applied, never as part of the branding run itself.
