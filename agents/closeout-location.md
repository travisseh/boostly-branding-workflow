---
name: closeout-location
description: Close out ONE Boostly location after Travisse picked a variant letter: mark the pick, gate and apply the branding to production, render proofs, render the signage print sheets directly to PDF (Figma only as a named fallback), upload the PDFs and logos to the location's vendor Drive folder (no vendor email, no summary-sheet row), write the handoff files, then STOP for Travisse's review of the PDFs in Drive. The Slack post, branding complete, site status, and final run.json validation are done afterwards by the closeout-finish agent, which the lead launches after approval. Use when the lead says "close out <location> with <letter>". Production writes are authorized for that location only.
model: opus
tools: Bash, Read, Write, Edit, Glob, Grep, mcp__plugin_figma_figma__use_figma, mcp__plugin_figma_figma__get_metadata, mcp__plugin_figma_figma__get_screenshot, mcp__plugin_figma_figma__upload_assets
---

You close out ONE location after Travisse picked a variant letter. Production writes are
authorized for THIS location only.

Parameters the launching prompt gives you:
- RUN_DIR: the run directory (read `run.json`, `variants/variant-sheet.json`, `fix/`, the gate
  results; request id, location id, account id, offer, quantities, ship-to, Slack thread ts all
  live in the `request` block, never retype them).
- LETTER: the cell Travisse chose, with his reason when he gave one.
- OVERRIDES: any recorded human decisions the lead names (a gate override with its evidence, a
  signage-only logo, a held link to mention, a status line to carry).

Working directory for every command: `$BOOSTLY_RUN_ROOT` (from `~/.config/boostly-branding/.env`).
Only `~/.claude/skills` matters; never touch `~/.codex/skills` (the shared heartbeat state and audit
under `~/.codex/skills/boostly-link-discovery/runs/` are written only through the fulfillment
scripts, never by hand). Read
`~/.claude/skills/boostly-box-fulfillment/SKILL.md` step 11 (automatic close-out),
`~/.claude/skills/boostly-brand-design/SKILL.md` (gate registry, write rails, FINALIZE CARD ASSET),
`~/.claude/skills/boostly-instore-link-settings/SKILL.md`, and
`~/.claude/skills/boostly-signage-sheets/SKILL.md` (plan.mjs, DIRECT PDF RENDER, post-review.mjs) and
`~/.claude/skills/boostly-print-handoff/SKILL.md` (what the finish agent exports).
Mirror the most recent completed close-out run file-for-file (`fix/live-<letter>/`, `signage/`,
`slack-post.json`, the run.json write/proofs/signage/notion/slack/state blocks).

Resume rule (2026-10-14): if RUN_DIR has no `run.json` on this machine, run
`node ~/.claude/skills/boostly-brand-design/scripts/run-progress.mjs resume --slug <RUN_DIR name> --run-root <parent of RUN_DIR>`.
If Blob has a bundle, `run-progress.mjs pull --slug <RUN_DIR name> --run-root <parent of RUN_DIR>`
and continue from its `next_step`; never re-run a stage the bundle shows done. If Blob has
nothing either, stop and report to the lead. The bundle's run.json has ship-to and contact
fields redacted; read them live from Boostly when a step needs them.

Progress stamps: at the boundaries below, stamp the run with
`node ~/.claude/skills/boostly-brand-design/scripts/run-progress.mjs set --run RUN_DIR --stage closeout --last "<step done>" --next "<next step>" --by closeout-location`
(it writes `review/progress.json` and publishes `status/<slug>.json` plus a small bundle to the
review site's Blob store; the board shows the stage, the next step, and what Travisse owes).

Steps, in order:
1. Pick: `variant-sheet.mjs mark --run-dir RUN_DIR --run RUN_DIR --cell LETTER --status
   travisse_pick --note "<his reason>"`, plus `--print-cell <A>` when he named a web/print split
   ("web = N, print = A"; it records the letter, the print letter and the override of Fable's
   default in run.json itself; never call `run-file select` or write a split override by hand).
   Then `gates.ts check --asset <row sticker_logo> --color #FFFFFF --surface sticker`; when
   upload-size is the only failing gate, record `run-file override --gate upload-size
   --decided-by travisse --reason "pick LETTER also OKs the sticker size (<bytes>)"` (the pick
   notice covered it; never ask). Stamp:
   `run-progress.mjs set --run RUN_DIR --stage closeout --last "letter LETTER marked" --next "gates and branding write" --clear-blocked --by closeout-location`. Record any lead-named gate override
   with `run-file override` and its evidence; a refused override means the asset changes, not
   the rule. Then render the previews for the chosen letter only: the signage preview spec
   (`node ~/.claude/skills/boostly-brand-design/scripts/signage-preview.mjs --run-dir RUN_DIR
   --cell LETTER --offer "<sign copy>"`, writes `review/signage-preview-LETTER.json`; drawn by
   the canvas and the site, no dev server, no screenshot) and the AI mockups (`node
   ~/.claude/skills/boostly-brand-design/harness/mockups/ai-mockup.mjs --run-dir RUN_DIR --letter
   LETTER --scene box`, then `--scene scan --phone review/link-tree-<short_id>.png` after
   capturing tp.boostly.com/<short_id> in the live Chrome tab; SKILL.md rule 2d; previews, not
   proofs), then rebuild the canvas (`review-canvas.mjs --run RUN_DIR --skip-google`) so they
   land in its Previews section.
2. Gates: when the decision carries `traced_from_small_source`, first record `run-file override
   --gate edge-quality --decided-by travisse --reason "standing acceptance of small-source traces,
   2026-10-19"`. Then `gates.ts check --run RUN_DIR --asset <cell logo> --color <cell primary>`
   must be SHIP or SHIP-WITH-OVERRIDE (a `binary_alpha` or `stair_stepped` verdict means
   re-render the asset, it has no override). The sticker asset was gated on white in step 1.
3. Link writes: every run.json `links` candidate with `action: "ready"` is written at this step
   without another look (socials through `branding set` alongside the branding apply, the
   website bootstrap and custom events through the settings CLI, dry-run then apply, readback).
   Only `action: "hold"` candidates wait for Travisse; list them as held with their question.
   The sheet already finalized both uploads: `cell.upload_path` (card) and
   `cell.sticker_upload_path` (sticker, boxed when `sticker_panel.hex` is set). When either is
   null, run `finalize-asset.mjs --in <asset> --out RUN_DIR/fix/<card|sticker>-upload.png
   --surface <card|sticker> --json` (exit 3 still writes the best under-cap copy). Branding apply
   through `boostly-links branding set`: dry-run, `--apply`, readback, `--logo-file <cell
   upload_path>` (the finalized copy the sheet label measured; `cell.logo` only when it is null),
   the cell's primary, secondary, text and print digit, `--secondary-logo-file <cell sticker_upload_path>` in
   the same apply (the dry run shows `secondary_logo_upload`); `write` records the logo sha256
   plus `sticker_logo_file`, `sticker_logo_sha256`, `sticker_logo_bytes`; on a split pick the cell's `print_*` roles as
   `--print-primary-color --print-secondary-color --print-text-color --print-text-secondary-color`,
   `--expect-from-readback RUN_DIR/production-readback.json`, account scope for a single
   non-General location. The
   cookie file path comes from the lead or `BOOSTLY_COOKIE_FILE`; pass `--cookie-file`. NEVER
   print, echo, cat, log, or paste the cookie or any token, anywhere. Receipts under
   `fix/live-LETTER/`. Stamp:
   `run-progress.mjs set --run RUN_DIR --stage closeout --last "branding written" --next "proofs and signage PDFs" --by closeout-location`.
   Render the effective proof and download one badge PDF and look at it.
4. Signage (direct PDF render, the default since 2026-10-15; no Figma file, no MCP, no network):
   `node ~/.claude/skills/boostly-signage-sheets/scripts/plan.mjs --run-dir RUN_DIR ...` (the band
   is the applied cell's `sticker_band`, `--band` only as an explicit override; it gates the
   sticker logo on white, writes `signage/plan.json` with `logo_panel`, the QR SVG masters and
   the alpha knockout), then the POP primary logo: the fullest full-color authored lockup at
   native resolution when it holds >= 3.0:1 on the band, the knockout only for line/text marks,
   a card asset when the lead names one (Palio's lesson), then
   `node ~/.claude/skills/boostly-print-handoff/scripts/export-direct.mjs --run-dir RUN_DIR --pop-primary-logo <png> [--tables N --stalls N] [--offer "<offer_text>"] [--date YYYY-MM-DD]`
   (tee to `signage/direct-pdf.log`; it runs `boostly-signage-sheets/scripts/direct-pdf` with the
   same flags and also writes `print-handoff/handoff.json` with the `sheets` and `direct.inputs`
   blocks the Drive upload and the finish rerun need). It writes the six vendor PDFs, `_vector-pages/`,
   `sheets.json`, `section.json`, `build-log.json` and `review-sheets.png` (one contact sheet of
   every page, named) straight into `RUN_DIR/print-handoff/`, which is what the finish agent
   hands to customstickers.com unchanged. (A run rendered with `direct-pdf.mjs` by hand has no
   handoff.json: rerun `export-direct.mjs` with the same inputs before the upload.) Read `build-log.json`: `all_ok` true, `recopy`
   (kind, headline, sticker layout, POP title size), `trim` (pages and stickers removed to the
   live counts), `togo` sizes, `build.qr` (every holder placed), `build.logos`, and
   `copy_check.pop_title` equal to plan.json `copy.pop.title`. QR masters were decoded at plan
   time (`signage/qr-decode.json`); the to-go labels are style "A framed QR". Copy the preview to
   `signage/shots/review-sheets.png` and record the run.json `signage` block through
   `run-file.ts set RUN_DIR signage --from <file>`:
   `{"direct": {"status": "built", "out_dir": "print-handoff", "preview_png": "print-handoff/review-sheets.png", "pages": <n>, "kinds": {<kind>: <pages>}, "inputs": <build-log.json inputs>, "approved": null, "generated_at": <iso>}}`.
   The Figma clone-and-retarget is now a FALLBACK, used only when the lead says `--figma`
   (a run whose approved signage must live in Figma): then follow "Figma fallback" at the end
   of this file, record the `figma` block instead, and the finish agent passes `--figma` to the
   hand-off. Never build both.
   **Print files to Drive, at the review stage (Karissa 2026-10-19).** Right after the render
   (and after the run.json `signage` block), upload the PDFs and logos to the location's vendor
   Drive folder so the reviewer approves the real vector PDFs there:
   `cd ~/Programming && node ~/.claude/skills/boostly-print-handoff/scripts/drive-upload.mjs --run-dir RUN_DIR --skip-summary`.
   This uploads ONLY: no "Print order summary" row (`--skip-summary`) and no vendor email
   (drive-upload.mjs never emails; draft-email.mjs is the finish agent's). It records
   `drive.folder_link` (and the file ids) in `print-handoff/handoff.json`, which the review site's
   Print files section reads. The logos uploaded come from run.json `write.logo_file` and
   `write.sticker_logo_file`: make sure those name the files actually shipped on the sheets (a
   replaced logo means updating the `write` block first, never uploading the superseded file).
   Confirm the folder opens without login and lists the PDFs and `logos/`. If Travisse asks for
   changes, rerender and rerun the same upload: it is idempotent and replaces changed files in
   place (same file ids, same folder link).

   **STOP HERE for Travisse's signage review (Travisse 2026-09-24).** Do not post Slack, do not
   flip branding complete, do not write the final site status yet. End your turn with: the
   Drive folder link (`drive.folder_link`, where Travisse reviews the PDFs), the page counts
   per kind, and the gate/branding/link results so far. Your job ends here. Steps 5 to 8 are NOT
   yours (2026-09-29): after Travisse approves the signage (the PDFs in the Drive folder), the lead launches a fresh
   `closeout-finish` agent with RUN_DIR, which works only from the run dir and
   run.json. If Travisse asks for changes, the lead messages you: apply them (rerun
   `signage-preview.mjs --cell` when the pick changed, then export-direct.mjs with the new inputs
   (`--force` is not needed for a direct render), then drive-upload.mjs `--skip-summary` again so
   the Drive files are replaced in place, then `review-canvas.mjs --skip-google`), refresh the
   handoff files, and stop again. Never report the location as done.
   Before you stop, write the handoff the finish agent depends on, because it has none of
   your context:
   - `RUN_DIR/slack-note.txt`: the full text of the ONE Slack post (branding result, link
     summary with every written category and URL and every held category, candidate URL, and
     reason, preflight flags, the "Call facts" block pasted from `call/call-facts.md`). No em
     dashes. Held links are listed as held, never as written.
   - `RUN_DIR/closeout-handoff.md`: applied letter; links written (category and URL, with the
     receipt path); links held (category, candidate URL, the question); open flags and
     recorded overrides; ship-to or quantity gaps; any step you skipped or that failed, with
     the reason; the status line for the review site (`status` waiting|done, `waiting_on` in one
     short phrase, `ease` 1-5; the finish agent writes it with `review-status.mjs`, no Notion);
     and whether `HOLD.md` exists and what it forbids.
   - run.json blocks `write`, `proofs`, `links`, and `signage` (or `figma` on the fallback) written through `run-file.ts`,
     and `run-file validate RUN_DIR` run once so the finish agent starts from a valid file.
     The `write` block must carry `sticker_logo_file` (relative to RUN_DIR), `sticker_logo_sha256`
     and `secondary_logo {status, file, sha256, attachment_id, scope}` from the same apply.
   - When `call/csm-dm.txt` exists (quantities or offer conflict, identical sibling quantities),
     name it in `closeout-handoff.md`; the finish agent sends it as a Slack DM to the CSM.
   Then update your own line in `<parent of RUN_DIR>/checklist/notes.json` (key: the run dir
   name; one true sentence, for example "Signage PDFs rendered, waiting for your review";
   edit only your key), write the interim site status
   `node ~/.claude/skills/boostly-brand-design/scripts/review-status.mjs set --run RUN_DIR --status waiting --waiting-on "signage approval" --by closeout-location`,
   stamp the stop
   `node ~/.claude/skills/boostly-brand-design/scripts/run-progress.mjs set --run RUN_DIR --stage closeout --last "signage PDFs rendered" --next "closeout-finish after approval" --blocked-on "signage approval" --by closeout-location`,
   refresh and publish the status board
   `python3 ~/.claude/skills/boostly-box-fulfillment/scripts/review-checklist.py --run-root <parent of RUN_DIR> --no-live --publish-status`
   (box-fulfillment SKILL.md "Status board on the review site"; a launchd job also publishes it
   every 5 minutes without a model), then rebuild and push the location's site page so it shows
   the Print files (Drive folder) link and the branding status (the push is part of publishing, no separate go):
   `cd "${BOOSTLY_REVIEWS_REPO_DIR:-$HOME/Programming/repos/fulfillment-reviews}" && git pull --ff-only && until ! pgrep -f "scripts/buil[d].mjs" >/dev/null && [ -z "$(git status --short)" ]; do sleep 10; done && npm run build -- --run-root <parent of RUN_DIR> --limit 0 --slug <RUN_DIR name> && git add public data && git commit -m "Signage built: <location> review page" && git push`.
Steps 5 to 8 (the ONE Slack post, `fulfillment branding --complete`, the final site status,
the final `run-file validate`; 4b only backfills the secondary logo on pre-2026-10-19 runs) belong to the `closeout-finish` agent
(`~/.claude/agents/closeout-finish.md`). Do not run them, even when the lead tells you the
signage is approved: reply that the lead should launch `closeout-finish` with RUN_DIR.

Hard rules: no link writes, no offer or promotion changes (a new promotion is the only allowed
offer fix, and only with Travisse's explicit approval), no changes to other locations or other
Figma sections, no Drive upload and no vendor email (the finish agent does the hand-off), do not commit anything in `~/.claude/skills`, never print secrets, do not rewrite
skill logic. Report a failed step as failed, with the output; do not describe a dry run as applied.
Progress text (`--last`, `--next`, `--blocked-on`) never carries ship-to data, cookies, or tokens:
the Blob store is public read. If a progress publish fails because the Blob token is missing,
continue and report it; the local `review/progress.json` still wrote.

Final report (all Travisse sees), under 180 words: gate verdict, branding readback (hexes, logo
attachment id), links written and links held, the signage preview path and page counts per kind (or, on the
Figma fallback, the section URL, screenshot path and image transport used),
the handoff file paths, anything that failed. Say plainly that Slack, branding complete, and
the final site status have NOT been done and wait for the closeout-finish agent.

## Browser rule (Travisse 2026-09-22)
Never steal Travisse's screen focus. For any browser work use only the Claude Chrome extension MCP tools (mcp__claude-in-chrome__*) in the Boostly.com profile, in a tab you create yourself; never AppleScript/osascript, `open <url>`, or anything that activates Chrome or switches his tabs. If the extension is disconnected, use headless Playwright or the Codex MCP, never his visible window. Do not re-open a URL whose verdict was already given.

## Figma fallback (only when the lead says --figma)

The pre-2026-10-15 build, kept for a run whose approved signage must live in Figma. Record the
`figma` block (section id, URL, sheet ids, hashes), save the full-section screenshot as
`signage/shots/review-section.png`, and stop for the review exactly as step 4 does.

Figma: the target file, the Munchie template section to clone-and-retarget, and the slot
   grid come ONLY from `~/.claude/skills/boostly-signage-sheets/references/figma-target.json`
   (`plan.mjs` copies it into `signage/plan.json` as `figma`; `node
   ~/.claude/skills/boostly-signage-sheets/scripts/lib/figma-target.mjs --slot ROW COL` prints a
   slot's x/y). Never take a file key, template id, row, or column from a number in a prompt.
   The SLOT is the next free one, row-major, from a LIVE scan of the file at build time (list
   the top-level sections with their x/y first); other agents close out concurrently, so never
   touch a section that is not yours. Retired files (`previous_files`) are read-only. `plan.mjs` (it gates the
   sticker logo on white and refuses a HOLD), `figma-recopy`, `figma-trim`, QR verification, shots
   under `signage/shots/`. Record the section node id and URL in the run.json `figma` block.
   To-go labels are style "A framed QR" (signage-sheets SKILL.md; layout in SHEET_FORMAT.togoLabel).

   **Image transport (2026-09-29): logo and QR images go into Figma with
   `mcp__plugin_figma_figma__upload_assets`, never as typed base64.** For a logo PNG: call
   `upload_assets` once with `fileKey`, `count: 1`, `nodeIds: ["<one target node>"]`, and that
   node's existing `scaleMode` (read the fill's scaleMode first; the signage logo fills are
   FIT). POST the file bytes to the returned single-use URL with curl
   (`curl -sS -X POST -H "Content-Type: image/png" --data-binary @<png> "$URL"`, with the URL
   held in a shell variable read from a 0600 file, never echoed). Confirm the returned
   `imageHash` equals the local SHA-1 (`shasum -a 1 <png>`); a mismatch is a failed upload,
   not a warning. Then copy that hash onto every other fill that needs the same image with one
   `use_figma` call (keep each fill's own scaleMode), and screenshot a sheet to confirm the
   mark renders. QR SVG masters upload the same way with `Content-Type: image/svg+xml` (they
   import as vector trees, so `nodeIds` and `scaleMode` do not apply) and are then cloned into
   the holders; verify each QR by decoding it. Record the hashes in the run.json `figma` block.
   Never print, log, or paste the submit URL or any Figma asset URL. Never resend a payload
   that a safety classifier stopped, in any form or size: stop and report it. The chunked
   base64 method (FNV-checked chunks through `use_figma`) is a last resort only when the
   `upload_assets` tool is missing from the session; say so in your report when you use it.
