---
name: closeout-finish
description: Finish ONE Boostly location closeout after Travisse approved the Figma signage. Runs closeout steps 4b and 5 to 8 only, in a fresh small context, from the run dir and run.json alone. Writes the V2 secondary logo (light backgrounds, the sticker asset), posts the single Slack result, marks branding complete (unless HOLD.md forbids it), spot-updates the Notion review queue entry in place, validates run.json, and updates its line in checklist/notes.json. Use when the lead says "finish the closeout for <location>" with a run dir, after approval. It makes no branding, logo, link, or Figma decisions.
model: sonnet
tools: Bash, Read, Write, Edit, Glob, Grep
---

You finish ONE location closeout. Travisse has already approved the Figma signage; the lead
tells you so in the launching prompt. If the prompt does not say the signage was approved,
stop and ask the lead. You do steps 4b and 5 to 8 only. You make no judgments about branding,
logos, links, or Figma, and you change none of them. The one logo write you make (step 4b, the
secondary logo for light backgrounds) uploads the sticker asset the closeout already shipped;
it is not a logo decision.

Parameter: RUN_DIR (absolute path). Everything else comes from files in RUN_DIR. Never retype
an id, a thread ts, or a URL from the prompt; read it from `run.json`.

Working directory for every command: `$BOOSTLY_RUN_ROOT` (from `~/.config/boostly-branding/.env`).
Only `~/.claude/skills` matters; never touch `~/.codex/skills`. Never edit skill scripts.
Never use em dashes in anything you write.

## Read first (in this order, nothing else)
1. `RUN_DIR/HOLD.md` if it exists. It overrides everything below. Follow it exactly. When it
   says not to mark branding complete, skip step 6 and say so in your report. When it says not
   to post sticker sheets as production, follow that in the Slack files and note.
2. `RUN_DIR/closeout-handoff.md` and `RUN_DIR/slack-note.txt` (written by the closeout agent).
   If either is missing, stop and report it to the lead. Do not write them yourself.
3. `run.json` through `run-file.ts get RUN_DIR <block>` for `request`, `write`, `links`,
   `figma`, `slack`, `notion`. Never read `preflight/ae-dump.json` (it is about 25 MB).
4. The command sections you need, not the whole skill files:
   `~/.claude/skills/boostly-signage-sheets/SKILL.md` section "POST REVIEW",
   `~/.claude/skills/boostly-instore-link-settings/SKILL.md` sections "fulfillment" and
   "branding set" (the `--secondary-logo-file` lines),
   `~/.claude/skills/boostly-review-queue/SKILL.md` (upsert and status).

## Preconditions (stop and report if any fails; write nothing)
- `run.json` `figma.section_url` exists and `write.status` is `applied`.
- `run-file validate RUN_DIR` exits 0 before you start.
- Auth and scope. Mint your own cookie; never reuse a path from a prompt and never print,
  echo, cat, log, or paste a cookie or token, anywhere, in any form:
  ```bash
  mkdir -p RUN_DIR/finish
  CK=$(mktemp -d) && chmod 700 "$CK"
  node ~/.claude/skills/boostly-brand-design/scripts/decrypt-boostly-cookie.mjs --out "$CK/admin.cookie"
  L=~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links
  $L auth check --cookie-file "$CK/admin.cookie" --json
  $L auth ensure-location <location_id> --cookie-file "$CK/admin.cookie" --cookie-out "$CK/scoped.cookie" --json
  $L branding get <location_id> --cookie-file "$CK/scoped.cookie" --ensure-location-scope --json > RUN_DIR/finish/branding-readback.json
  $L fulfillment get <request_id> --cookie-file "$CK/admin.cookie" --json > RUN_DIR/finish/fulfillment-before.json
  ```
  Shell variables do not persist between commands, so write the `CK` path to
  `RUN_DIR/finish/.cookie-dir` (the path only) and read it back each time.
  Read back the account id and location id from the ensure-location output and from both
  readbacks. They must equal `request.account_id` and `request.location_id` in run.json, and the
  fulfillment request must carry the same location. Any mismatch: stop, write nothing, report.
  The scoped cookie is for location reads. The admin commands (`fulfillment get`,
  `fulfillment branding`) use the unscoped `admin.cookie`; a scoped cookie redirects them.
- Already done is not an error. If `run.json` `slack.message_ts` exists, the Slack post was
  made: do not post again. If the request already reads branding complete, do not apply again.

## Steps
4b. Secondary logo (light backgrounds). V2 keeps a second logo on the branding row
   (`secondary_logo_attachment_id`, next to `logo_attachment_id`) for light surfaces. It is the
   on-white sticker asset the closeout already built: authored inks on a transparent or white
   background, never the white knockout card asset. Travisse 2026-10-02: save it in V2 once the
   Figma signage is approved, so it is written here, after approval and before branding complete,
   never at fulfill.
   - Source file, first match wins, path relative to RUN_DIR: `write.sticker_logo_file` in
     run.json (with `write.sticker_logo_sha256`); else the sticker file named in
     `figma.logo_hashes` or on the "Sticker asset" line of `closeout-handoff.md`; else
     `fix/sticker-logo-color.png` when it exists. Verify the sha256 when run.json gives one. No
     file: skip with "secondary logo skipped: no sticker asset" and go on. HOLD.md forbidding
     writes or branding changes: skip with "secondary logo skipped: HOLD.md".
   - Scope: the same scope the primary logo was written at (`write.scope`): pass
     `--scope account` or `--scope location` explicitly. Dry run, read it, apply, read back:
     ```bash
     $L branding set <location_id> --secondary-logo-file <sticker> --scope <write.scope> \
       --expect-from-readback RUN_DIR/production-readback.json \
       --cookie-file "$CK/scoped.cookie" --json > RUN_DIR/finish/secondary-logo-dry.json
     ```
     Check `selected_scope` equals `write.scope`, `logo_guard` says matched (the primary logo is
     replayed unchanged; a guard refusal, exit 6, means stop and report, never override),
     `secondary_logo_upload` names the sticker file, and `after.logo_attachment_id` equals
     `write.logo_attachment_id`. Then the same command with `--apply` into
     `RUN_DIR/finish/secondary-logo-apply.json`, then `branding get` into
     `RUN_DIR/finish/secondary-logo-readback.json`. The readback row at `write.scope` must carry a
     non-null `secondary_logo_attachment_id` and the unchanged primary id. Already done is not an
     error: when the readback already carries a secondary logo whose `secondary_logo_filename`
     equals the sticker file name, record it and do not upload again.
   - Record it: `run-file get RUN_DIR write`, add `secondary_logo` `{status, file, sha256,
     attachment_id, url, filename, scope, at, receipts}`, and `run-file set RUN_DIR write --from
     <file> --force --reason "record secondary logo at finish" --by closeout-finish` (the force is
     required because proofs depend on the write block; it changes nothing else in the block).
   - Slack: when `slack-note.txt` has not been posted yet (no `slack.message_ts` in run.json and
     no `slack-post.json`), append one line to it, "Secondary logo (light backgrounds):
     <sticker file> written at <scope> scope, attachment <id>" or the skip reason. Never edit a
     note that was already posted.
5. Slack, the ONE post, only when `request.slack_thread_ts` exists (no thread means no post
   anywhere):
   `node ~/.claude/skills/boostly-signage-sheets/scripts/post-review.mjs --run-dir RUN_DIR`
   (dry run). Read the dry run: bot user, channel, thread ts and its source, verified parent,
   files and sizes, note. The thread ts must equal `request.slack_thread_ts`. Then run it once
   with `--apply`. Exactly one Slack message. If `slack-post.json` already exists, do not run
   `--apply` (it overwrites the receipt); report the existing post. Never retry an `--apply`
   that may have posted: read `slack-post.json` and the thread first. Record the `slack`
   block in run.json with `run-file.ts set` and report the permalink.
5b. Print hand-off to customstickers.com (skill `~/.claude/skills/boostly-print-handoff`, read its
   SKILL.md "Commands" and "Hard rules"). Right after the Slack post, run
   `node ~/.claude/skills/boostly-print-handoff/scripts/print-handoff.mjs --run-dir RUN_DIR`
   (tee to `RUN_DIR/finish/print-handoff.log`). It exports the section's Print Sheet frames as
   vector PDFs, uploads them to the location's Drive folder under the vendor master folder,
   upserts the summary row, and creates a Gmail DRAFT to ckbrandsmktg@gmail.com with Colin Dunn
   (colin@printiverse.com) and Maren Dunn (maren@customstickers.com) on cc. It never
   sends; Travisse sends the draft. Read `RUN_DIR/print-handoff/handoff.json`: every kind must
   say `vector: true` with pages equal to expected_pages, and `draft.id` must exist. A failed
   export or a sheet_ids MISMATCH warning is reported, not worked around. Already done is not
   an error: a recorded draft id is reused. Put the folder link, the page counts, and the draft
   id in your report.
6. Branding complete (skip when HOLD.md forbids it):
   `$L fulfillment branding <request_id> --complete --cookie-file "$CK/admin.cookie" --json`
   (dry run). Read `state_before`, `state_after`, `enters_physical_fulfillment`, and
   `slack_ping.expected`, and put them in your report. Then `--apply`, then
   `fulfillment get` again as the readback. Branding complete is right even when links are
   still held. The ops ping that production sends when the request enters physical
   fulfillment is expected and is not your Slack post.
6b. Store details confirm (Travisse 2026-10-01: "if in-store details are there just mark that
   complete, stop stopping and requiring me to specifically say that"). Right after branding
   complete, read `fulfillment get <request_id> --json`. When the ship-to is COMPLETE on the
   request (recipient, line1, city, state, zip all present) and `store_details_confirmed_at` is
   null, run `$L fulfillment store-details <request_id> --confirm --cookie-file "$CK/admin.cookie"
   --json` (dry run), read `state_before`, `state_after`, `enters_physical_fulfillment`, then
   `--apply`, then `fulfillment get` as the readback. Save `store-details-dry.json` and
   `store-details-apply.json` under `RUN_DIR/finish/`. This is a production write Travisse has
   pre-authorized for every finish; do not ask. When the ship-to is incomplete or empty, do NOT
   confirm and do NOT invent an address: report "store details not confirmed: ship-to missing
   <fields>" so the lead can route it. Skip this step when HOLD.md forbids branding complete
   or when branding complete did not apply.
7. Notion review queue page (page id from `run.json` `notion.page_id`, or the one named in
   `closeout-handoff.md`). SPOT UPDATE ONLY. Never delete and rebuild a page, never delete
   blocks to re-append them. Use `~/.claude/skills/boostly-review-queue/scripts/review-queue.mjs
   upsert --page <pageId> --ledger <ledger> --run RUN_DIR` with a ledger from
   `ledger-from-manifest.mjs RUN_DIR`, with `status`, `waiting_on`, and `ease` set from the
   Notion line in `closeout-handoff.md` (when the handoff gives none and the location already
   has an entry, keep that entry's values; when it has no entry either, stop this step and
   ask the lead, since ease and status are review judgments). On a page Travisse has edited by
   hand, prefer the narrowest update the skill offers. Re-read the page immediately before the write
   (`status --page <pageId>`): when the location already has an entry, update that entry in
   place; when it has none, append at the next free entry number at that moment (other agents
   append concurrently). Read the page back after the write and confirm exactly one entry for
   this location. The entry carries the applied letter, the Figma link, links written, links
   held, and the ship-to gap, all taken from `closeout-handoff.md` and run.json.
8. `run-file validate RUN_DIR`. Then set your line in `<parent of RUN_DIR>/checklist/notes.json`
   (key: the run dir name, one true sentence such as "Done: <letter> is live, signage
   approved, Slack posted, branding complete; 2 links held for your call"; edit only your key
   with a small JSON read, set, write; keep the file mode 0600) and refresh the note:
   `python3 ~/.claude/skills/boostly-box-fulfillment/scripts/review-checklist.py --run-root <parent of RUN_DIR> --no-live`.
   Then rebuild and push the public review site so the location's page shows "Closed out"
   (box-fulfillment SKILL.md "Public review site"; this push needs no separate go):
   `cd ~/Programming/repos/fulfillment-reviews && git pull --ff-only && npm run build -- --run-root "$BOOSTLY_RUN_ROOT" --limit 0 --slug <RUN_DIR name>` (limit 0: only this page is rebuilt, every other entry is kept from data/sites.json; a larger limit rewrites every page and a concurrent build then drops pages from the manifest, seen 2026-10-12)
   `git add public data && git commit -m "Close out <location> review page"`
   `git push`
   (`--slug` keeps the page in the index even when the run is older than the newest 25). A
   failed build or push is reported, not retried blindly.
   Finally delete your cookie directory (`rm -rf` on the exact `mktemp` path only).

Every step: dry run, read it, apply, read back. Save each output under `RUN_DIR/finish/`
(`secondary-logo-dry.json`, `secondary-logo-apply.json`, `secondary-logo-readback.json`,
`slack-dry.log`, `slack-apply.log`, `print-handoff.log`, `branding-complete-dry.json`, `branding-complete-apply.json`,
`fulfillment-after.json`, `store-details-dry.json`, `store-details-apply.json`, `notion-before.txt`, `notion-after.txt`, `run-validate.log`).

## Hard rules
- No branding apply, no primary logo or color change, no link writes, no offer or promotion
  change, no ship-to change (confirming an existing complete ship-to in step 6b is allowed;
  editing it is not), no Figma edit, no change to any other location. The only branding write
  is the secondary logo upload in step 4b, with the primary logo pinned by
  `--expect-from-readback`.
- Exactly one Slack message, in the request's thread. No top-level post, no second post, no
  correction post. If the posted text turns out wrong, report it to the lead.
- State accurately what was and was not written. Links written are the ones with a receipt in
  run.json or `closeout-handoff.md`. Links held are held. A dry run is never described as
  applied. A skipped step is reported as skipped with the reason.
- A failed step is reported as failed with its output. Do not work around a refusal, a gate,
  or an auth failure. Do not weaken or bypass any check.
- Never print secrets. Never commit anything except the review-site publish in step 8. Never open a browser or any app, never run
  `open`, AppleScript, or osascript yourself.
- If something needs a judgment call, stop and report it to the lead. That is the correct
  outcome, not a failure.

## Final report (all Travisse sees), under 150 words
Secondary logo: sticker file, scope, attachment id from the readback (or the skip reason, or
"failed" with the output); Slack permalink (or "no thread, nothing posted", or "already posted");
print hand-off Drive folder link, PDF page counts, and Gmail draft id (not sent), or what failed;
branding complete status readback with state before and after (or "skipped: HOLD.md"); Notion entry number and
whether it was updated in place or appended; `run-file validate` result; the review site URL
(`https://fulfillment-reviews.vercel.app/<run dir name>/`) after the rebuild, or what failed; links written, links
held, open flags, skipped steps; anything that failed.
