---
name: boostly-box-fulfillment
description: End-to-end Boosted Box / Tap Cards link and branding fulfillment for the open V2 fulfillment requests in the Branding (digital fulfillment) lane, pulled from the production database through v2-db (Slack is no longer an intake source), verify the pre-resolved V2 location, discover+verify links using the live Chrome session, write the safe ones, run the brand-design pipeline, publish the review checklist, optionally reply in the request's Slack thread, and audit everything. Badge creation is owned by the fulfillment request system and is forbidden here. Use when Travisse says "run fulfillment", "process the fulfillment requests", "what's in branding", or on the scheduled heartbeat.
---

# Boostly Box Fulfillment (deterministic fast path, model exceptions)

For each new Boosted Box / Tap Cards request, run the typed deterministic pipeline below.
Models may resolve only declared exceptions; model prose never directly drives a production
write, Slack reply, Notion checklist, audit row, or state update.

The orchestrator (the Claude Code session, usually through the `fulfill-location` and
`closeout-location` agents in `~/.claude/agents/`) owns the v2-db intake, V2 verification, link
discovery/verification, production writes, state, audit, the Notion review queue, and the one
close-out Slack post. Keep context lean and summaries short. The Fable judgment is an in-session
subagent launched with the Agent tool and `references/subagent-prompt-template.md` from the
brand-design skill; never an API call, never a `claude -p` shell-out, never GPT (see "Branding").

**Intake source (since 2026-09-16):** work is pulled from the production `fulfillment_requests`
table through the read-only `v2-db` CLI, filtered to the admin **Branding** lane. Slack is not an
intake source anymore. The DB pull (`list-branding-requests.ts`) replaced the Slack parser
(`parse-boosted-box-requests.mjs`), which was deleted on 2026-09-16; nothing in the pipeline may
depend on Slack for intake.

## The five components (already built, do not reinvent)

| Step | Tool | Notes |
|---|---|---|
| Pull requests | `scripts/list-branding-requests.ts` | read-only `v2-db`; Branding lane; emits canonical requests with `location_id`/`account_id` resolved |
| Verify location | `~/.claude/skills/v2-database/bin/v2-db query` | read-only replica; exact-match verification of the pre-resolved row, see references/location-resolve.sql |
| Optional Slack thread reply | `~/.config/slack-tools/slack.js` | channel `C09MSM8MA9Y` (`boosted-box-requests`) in workspace `boostly`, only when the request has `slack_thread_ts` |
| Discover + verify links | `/boostly-link-discovery` + shared verifier | static fetch first; the live Chrome session (Claude in Chrome, Boostly.com profile) only when required |
| Write links / branding | `/boostly-instore-link-settings` | dry-run → apply → readback, always |
| Generate branding | `/boostly-brand-design` | Fable in-session subagent, medium effort |

## Canonical deterministic pipeline

Read `references/deterministic-fast-path-architecture.md` before changing the pipeline.
Every boundary is validated JSON and every stage records a duration plus counters.

### One run file per location: `run.json`

`<run_dir>/run.json` is the single source for a location run. Every stage reads it and writes
exactly one block; Notion, Slack, Figma, proofs, and the review ledger render from it. Nothing is
retyped from prose. The block list, each block's owner, and when it is written are the
`description` fields of `references/run-schema.json` (the only copy); the CLI is
`scripts/run-file.ts` (`init`, `set`, `get`, `validate`, `migrate`, `select`, `override`).

Rules the CLI enforces: a block is validated before it lands; a block that later blocks already
depend on (`request` -> everything, `evidence` -> `decision` -> `variants` -> `gates` -> `write`
-> `proofs`, `plan` -> `links`/`write`/`proofs`) is not overwritten without
`--force --reason "<why>"`, and the force is recorded under `state.forces`; `overrides` only
grows; `decision` is only ever the parsed decision file. Overrides are recorded data, never
auto-applied, and no rule or gate is edited to make a run pass. Every `--run` flag is additive:
the old `--input`/`--out`/`--plan` file arguments keep working unchanged.

Runs older than run.json: `run-file migrate <run_dir>` builds it from `manifest.json`, the
receipts under `fix/live-*/`, `variants*/variant-sheet.json`, `evidence/`, `fable-decision.json`,
`ledger.json`, and `STATE.md`; the manifest is kept verbatim under `legacy.manifest`, so
`ledger-from-manifest.mjs` renders a migrated run byte-identically to before.

1. Pull open requests from the production database with `list-branding-requests.ts` (add
   `--run-root <dir>` to create `<dir>/<location-slug>/run.json` per request with the `request`
   block; an existing run.json is never overwritten). It queries
   `fulfillment_requests` joined to `locations`, `accounts`, `users` (CSM and requester), and
   `fulfillment_items` through the read-only `v2-db` CLI, derives the admin lane exactly like
   `src/lib/fulfillment/status.ts` (Branding = `digital_fulfillment` = not canceled, no tracking
   number, `digital_fulfilled_at IS NULL`), excludes `ad_hoc` orders and General locations, and
   emits the canonical request shape with `request_key = v2:<fulfillment_request_id>`,
   `fulfillment_request_id`, `expected_location_id`, `expected_account_id`, the resolved row as
   the single `location_candidates` entry, and `account_locations` for scope. Slack is never read
   for intake; the DB pull replaced the deleted Slack parser (`parse-boosted-box-requests.mjs`).
2. Call `prepare-fulfillment-plan.ts` on that output (`--run <dir>` reads the request and
   decision blocks and writes the `plan` block). Exact normalized account + location +
   full-address matching now **verifies** the pre-resolved row (a mismatch with
   `expected_location_id` is a hard error), excludes General, selects branding scope, applies
   dedupe on `processed_fulfillment_request_ids` (and legacy `processed_request_keys`), holds
   unresolved candidate ties, and emits a validated plan. A `needs_model_review` result stops
   before writes.
3. Run discovery once for the official site. Read current V2 + GBP first; search externally
   only for missing Order, Menu, Events, Careers, Catering, and Social categories.
4. Build `branding-evidence.json` with `build-branding-evidence.ts`. Reuse prior Fable judgment
   only when its complete evidence fingerprint is unchanged. Otherwise send only this packet to
   Fable, which writes its six-key answer to `<run_dir>/decision.json`, and run
   `validate-fable-decision.ts --run <dir>`: it validates that file and stores it verbatim as
   the `decision` block with its SHA-256 (never retype the decision from Fable's reply). With
   `--run`, `prepare-fulfillment-plan.ts` carries that path and hash into the plan itself.
   Fable's six fields are immutable after
   validation: no orchestrator, deterministic runner, plan builder, manifest generator, proof
   renderer, or production writer may reinterpret or override them. Any byte/hash or parsed JSON
   mismatch fails the run before proof generation or writes.
5. Review the plan JSON. Run `notify-fulfillment-review.ts` first as a dry run and then with
   `--notify`. It sends one idempotent self-iMessage whenever a security challenge or retrieval
   timeout holds a link; the affected link remains unwritten. Keep its receipt in the request run
   directory. Then run `execute-fulfillment-plan.ts` without `--apply`, followed by
   `--apply` only for an authorized live run. It keeps writes sequential, fill-only, read back,
   and locked at account scope. Badge operations are forbidden. With `--run <dir>` it reads the
   plan block and writes the `links` block.
6. Run `generate-fulfillment-artifacts.ts --run <dir>`: the Slack text, Notion checklist, audit
   rows, and state patch are rendered from run.json (plan, links, notion, write, proofs,
   evidence blocks); post and populate them without model rewriting. `--input` still works.
7. Run `persist-fulfillment-state.ts --run <dir>` dry-run, then `--apply` only after all
   required readbacks and proof receipts exist. It records the audit row ids in the `state`
   block. Audit is append-only and state changes are additive/atomic.

The legacy `process-boosted-box-request.mjs` direct-SQL script was deleted on 2026-09-16; the DB
pull (`list-branding-requests.ts`) plus the typed plan/execute scripts replaced it. Never write V2
outside `execute-fulfillment-plan.ts`.

Model routing is narrow: Sol for ambiguous business/location identity; Luna for a verified
candidate tie with conflicting deterministic evidence or a live first-party Events page whose
visible future dates are not machine-structured; and Fable for logo choice, palette/composition,
or branding-gate diagnosis. Event Luna output must pass the strict JSON schema, evidence-hash,
grounding, date, and confidence gates before a new deterministic plan can use it. Fable is the
final branding model; never substitute GPT.

## State & dedupe (shared with the Codex heartbeat, do not diverge)

- State file: `~/.claude/skills/boostly-link-discovery/runs/boosted-box-heartbeat-state.json`
- Audit log (append-only): `~/.claude/skills/boostly-link-discovery/runs/boosted-box-heartbeat-audit.jsonl`
- These two (plus `account-write-locks/` and the badge receipt ledger) are the ONE shared
  location: the Codex heartbeat cron still reads and writes them there, and the `runs/` copy
  under `~/.claude` is only a stale mirror. Every script takes them from
  `scripts/paths.ts` (`HEARTBEAT_RUNS_ROOT`); never point a run at the `~/.claude` copy.
  Code paths (v2-db, the settings CLI, discovery, the validator) resolve relative to the
  skills root in the same file, so the scripts run unchanged from either root.
- **Dedupe key going forward = the `fulfillment_requests.id`.** Primary dedupe truth is
  `processed_fulfillment_request_ids` (completed requests) plus `fulfillment_request_outcomes`
  (last outcome per request id: `completed`, `needs_review`, or `blocked` with `checked_at`).
  `persist-fulfillment-state.ts` already writes both. Only a `completed` outcome adds the id to
  `processed_fulfillment_request_ids`; `needs_review`/`blocked` requests stay eligible and show
  their `prior_outcome` in the next pull so the run loop can apply backoff instead of re-crawling.
- Request key = `v2:<fulfillment_request_id>`. It is also appended to `processed_request_keys`
  for compatibility. `list-branding-requests.ts --exclude-processed` drops a request when its id
  is in `processed_fulfillment_request_ids` or its key is in `processed_request_keys`.
- Legacy fields stay untouched and readable: `processed_request_keys` (normalized Slack
  `account | location | street | city | state | zip` keys), `last_processed_ts`,
  `processed_message_ts`, and every badge field. They never drive work anymore; do not delete,
  rewrite, or reseed them.
- Never backfill: a request that is no longer in the Branding lane (digital fulfillment completed,
  shipped, or canceled) is out of scope even if it was never processed here.

## Run loop

Scheduled heartbeat runs are silent in the session. Do not emit progress, commentary,
status, or no-op messages. Only return the required final heartbeat summary when at least one
real request was processed.

1. **Read state.** Load the state file. Note `processed_fulfillment_request_ids` and
   `fulfillment_request_outcomes` (legacy `last_processed_ts` is informational only).
2. **Fetch requests from v2-db.** Pull the Branding lane from the production read replica; the
   Slack channel is not read. Quantities (tap cards, tables, bathroom stalls, signage, to-go
   rolls) come from `fulfillment_items`; they are metadata only and this automation never creates
   badges:

   ```bash
   node --experimental-strip-types \
     ~/.claude/skills/boostly-box-fulfillment/scripts/list-branding-requests.ts \
     --exclude-processed --out <run_root>/branding-requests.json
   # add --json for the full payload on stdout; --status open|store_details|... for other lanes;
   # --after <iso> and --limit <n> to bound a run
   ```

   Each emitted request already carries `fulfillment_request_id`, `request_key`
   (`v2:<id>`), `expected_location_id`, `expected_account_id`, `location_candidates` (the
   request's own location row), `account_locations`, `fields` (account/location/street/city/
   state/zip parsed from the V2 `locations.address`, offer, ship-to recipient and address from
   `locations.shipping_*`, requester, quantities), `csm`, `slack_thread_ts`, `status`,
   `created_at`, `already_processed`, and `prior_outcome`. `badge_quantity` is always `null` /
   `missing`: the database has no employee count and badges are out of scope here.

   `ad_hoc` orders (`order_type = 'ad_hoc'`, the old `In-store ad hoc request` Slack post) are
   excluded by the script and remain outside this automation's scope. They must not produce a
   plan, production write, proof, Notion page, audit row, state entry, or Slack reply.

   `canonical_thread_ts` is the request's `slack_thread_ts` (the app's "request created" post in
   `C09MSM8MA9Y`) when the app stored one, otherwise the empty string. Never search Slack to
   invent one. Requests with a `prior_outcome` of `blocked` or `needs_review` are still listed;
   apply the run loop's 24-hour backoff to `blocked` outcomes and only re-run `needs_review`
   requests when their discovery cache has expired or a human resolved the hold.
   If nothing is eligible → update `last_checked_at`, write a one-line `last_run`, and exit with
   no commentary and no final response.
3. **Preflight the whole batch before processing any request.** The intake file from step 2 is
   already a valid preflight input (`requests[]` with `fields`, `location_candidates`, and
   `expected_location_id`); run:

   ```bash
   node --experimental-strip-types \
     ~/.claude/skills/boostly-box-fulfillment/scripts/preflight-fulfillment-batch.ts \
     --input <run_root>/branding-requests.json --out <run_root>/batch-preflight-result.json --notify
   ```

   A `foreign_key_mismatch` in `unresolved_requests` means the parsed identity fields did not
   exact-match the request's own location row; treat it like any other unresolved identity.

   If any confidently matched non-General location has an empty `google_place_id`, this exits 2,
   texts Travisse through `/message-me`, and stops the **entire run** before discovery, branding,
   production reads/writes, badges, Slack, Notion, or state advancement. Audit the blocker without
   marking any request processed. Do not process the remaining locations. Location ambiguity still
   follows the existing location-review path and does not substitute a General location.
4. **Verify the pre-resolved V2 location.** The request row's `location_id` is authoritative and
   already included as the single candidate; `prepare-fulfillment-plan.ts` exact-matches name +
   full address against it and fails on an `expected_location_id` mismatch. Use
   `references/location-resolve.sql` (query B, existing branding) only for the branding
   fill-only decision, through the read-only `v2-db query --json` CLI, and never to search for a
   different location. Always exclude General locations (`is_general = true`) from sibling
   counts and write-scope decisions. Unverifiable identity → no writes, audit a skip with reason,
   record the outcome under the request id, move on.
   After batch preflight succeeds, process each request oldest to newest. One later request-level
   failure does not block the remaining preflighted locations.
   **Call preflight (every new request, right after the location resolves):** run

   ```bash
   node ~/.claude/skills/boostly-signage-sheets/scripts/preflight.mjs \
     --location-id <v2-location-id> --run-dir <run_dir>
   ```

   What it reads, writes (`<run_dir>/call/call-facts.md`, `<run_dir>/preflight/preflight.md`),
   and every flag it can raise (OFFER_MISMATCH, BIRTHDAY_PROMO_MISSING, QUANTITIES_UNCONFIRMED,
   TRANSCRIPT_PENDING) are documented once, in `boostly-signage-sheets/SKILL.md` PREFLIGHT. Read
   the flags before discovery or branding; never run an offer command unattended. OFFER RULE
   (Travisse 2026-09-16): an agreed offer that differs from the keyword is fixed by creating a
   NEW promotion (`promotions create`) and repointing the keyword, never by editing an existing
   promotion, unless that exact promotion already exists; every offer change needs explicit
   approval first and is recorded as an `offer_mismatch` override. ORDERING URL RULE (The Place
   Pizza 2026-09-17): the ordering link is the one the customer's own website publishes; a stored
   `ordering_url` that cannot be verified live loses to it (recorded as `ordering_link_source`).
5. **Website bootstrap.** If `website_url` is empty, get the
   Places `websiteUri` and write it via `boostly-instore-link-settings location set`
   (dry-run → apply → readback) before discovery. The successful batch preflight guarantees a
   Place ID; never bypass it or guess.
6. **Discover + verify links (static-first, browser on exception).** See "Discovery".
   After the validated plan is written, run:

   ```bash
   node --experimental-strip-types scripts/notify-fulfillment-review.ts \
     --plan <fulfillment-plan.json> --receipt <run_dir>/review-notification-receipt.json
   node --experimental-strip-types scripts/notify-fulfillment-review.ts \
     --plan <fulfillment-plan.json> --receipt <run_dir>/review-notification-receipt.json --notify
   ```

   A notification failure is a run blocker. Do not silently omit the requested text.
7. **Write the safe links** (write gate below) via `boostly-instore-link-settings`.
8. **Branding** (see "Branding"): build the evidence packet, launch the Fable in-session
   subagent, validate, build the variant sheet and the review canvas, then STOP for Travisse's
   letter (the `fulfill-location` agent ends here; `closeout-location` starts at the letter).
   As soon as the review canvas exists, refresh the Apple Notes quick view (see "Apple Notes
   quick view") so the location shows up with its Review page link; this is the default, not
   an extra.
9. **Notion review checklist** (see "Review checklist"): create or reuse one populated
    Boostly Notion review page and append the proof plus GBP source photos.
10. **Record the result.** Audit each write/skip, update state under the request id, and publish
    the Notion review checklist. Reply once in the request's Slack thread with the text-only link
    summary **only if** the request carries a `slack_thread_ts`; otherwise the completion note
    lives in the Notion review queue alone.
11. **Close out automatically (Travisse, 2026-09-17).** Who runs it (2026-09-29): the
    `closeout-location` agent stops after the Figma build and writes `slack-note.txt` and
    `closeout-handoff.md`; after Travisse approves the signage, the lead launches a fresh
    `closeout-finish` agent (Sonnet) with the run dir, which writes the V2 secondary logo
    (light backgrounds: the on-white sticker asset recorded in run.json `write.sticker_logo_file`,
    uploaded with `branding set --secondary-logo-file` at the primary logo's scope, after Figma
    approval and before branding complete; Travisse 2026-10-02), then does the Slack post, branding
    complete, the store-details confirmation when the ship-to is complete (Travisse
    2026-10-01: "if in-store details are there just mark that complete, stop stopping and
    requiring me to specifically say that"; `fulfillment store-details <requestId> --confirm`,
    dry run then `--apply`; an empty or partial ship-to is reported, never invented), the
    Notion spot update, and the final `run-file validate` from the run dir and
    run.json alone. It honors `HOLD.md` (no branding complete when the file says so) and
    never wakes the large closeout agent. The rule itself is unchanged: once the applied branding is Travisse's
    approved pick and the Figma signage section is built and QR-verified, do not wait for a
    separate "go": post the final branding result in the request's Slack thread (when it has
    one) with `post-review.mjs --apply`, then run `boostly-links fulfillment branding
    <requestId> --complete` (dry run, then `--apply`), and refresh the Notion entry (spot
    update, never delete and rebuild). The Figma file, template section, and grid come from
    `boostly-signage-sheets/references/figma-target.json`; the slot is the next free one from a
    LIVE scan of that file at build time, never a number typed into a prompt. Branding complete is correct even when links are
    still held; the held items go in the Slack text. The Slack ping into physical fulfillment
    that follows when store details are already confirmed is wanted. Explicit approval is still
    required before the pick itself, before any offer change, and before any Slack post that is
    not the final branding result.

## Discovery (crawl once, static first, live Chrome on exception)

Fetch the official site statically first and extract all available page links in one pass.
Create a browser only for JS-rendered pages, challenges, logged-in platform verification, or
ambiguous evidence. When a browser is needed, use Travisse's authenticated live Chrome session
(the Codex Chrome extension by default, the Claude in Chrome MCP tools as the fallback, profile
`Boostly.com` either way; see "Transport" below). Do not launch local debug Chrome unless the
live session is unavailable; it steals desktop focus. A session that cannot bind the live Chrome
profile runs the manifest-only pass, holds every browser-dependent candidate, and says so; it never
fakes `fulfillmentMode`, the provider flag, or a results file.

### Transport: Codex by default, Claude Chrome as the fallback (2026-09-29)

Reading pages is transport, not judgment, and it never runs inside a large agent's context.
The top Claude model keeps every judgment: ready, hold, or reject verdicts, the write gate,
and the link writes at closeout.

**Default: Codex handoff (`codex-extension`).** From a Claude session, through Bash with
`run_in_background: true`:

```bash
node ~/.claude/skills/boostly-link-discovery/scripts/codex-discovery-handoff.mjs \
  --run-dir <run_dir> --location-id <location_id>
# --out <file> (default <run_dir>/link-discovery-report.json), --overwrite (keeps a backup),
# --no-cache, --effort medium (default), --print-prompt (shows the Codex prompt, runs nothing)
```

It starts one `codex exec` session (model from `~/.codex/config.toml`, reasoning effort
medium) that runs the Codex-runtime pattern in the Chrome plugin Node runtime with
`requiredBrowserProvider: "codex-extension"` and the Boostly.com profile, writes the report,
and then runs the validator. Exit 0: written and valid. Exit 2: written, validator failed.
Exit 3: no report (extension not attached, Boostly.com profile missing, Codex error); the
error text is in the output and in `<report stem>.codex-status.json`. Verified 2026-09-29 on
Zarape West Hollywood: 192 seconds, 8 pages read in the browser, validator exit 0. If a Codex
session cannot attach the extension when started from Claude, Travisse runs the same one-line
command from his own terminal and the Claude lead picks up from the report file.

**Fallback: the `discovery-transport` agent (`claude-chrome`, Sonnet, fresh context).** Only
when the Codex handoff exits 3. Launch it with the run dir and the location id; it runs the
two-pass loop below in its own tab, reruns discovery, runs the validator, and reports the exit
code and errors. It makes no verdicts. The fulfill agent and the lead never run the chunk loop
in their own context.

Both providers are accepted by every gate, always with the Boostly.com profile and preflight
true. Playwright and static reports fail. A page neither transport could read (a blocked read,
a refused extractor, a login wall) stays unread and its candidates are held with the reason.

The fallback loop (`claude-chrome`), as the `discovery-transport` agent runs it.
`discover-links.mjs` cannot call the MCP tools from Node, so the crawl is a two-pass loop with
a results file:

1. Confirm the connected Chrome profile with `tabs_context_mcp` / `list_connected_browsers` and
   initialize the results file with that exact name (never guess it):
   `node ~/.claude/skills/boostly-link-discovery/scripts/claude-chrome-browser.mjs results init
   --out <run_dir>/browser-results.json --profile Boostly.com`. Discovery refuses a results file
   captured in any other profile.
2. Run discovery (the crawler extracts navigation, footer, JSON-LD, sitemap, known high-signal
   paths, titles, and H1s; canonicalizes and deduplicates URLs; caches evidence 3–7 days by
   content hash plus resolved URL; DataForSEO only for still-missing Order, Menu, Events,
   Careers, Catering, or Social categories):

   ```bash
   node ~/.claude/skills/boostly-link-discovery/scripts/discover-links.mjs \
     --location-id <location_id> --mode discovery+verify --fulfillment-mode \
     --browser-provider claude-chrome --chrome-profile boostly \
     --browser-results <run_dir>/browser-results.json \
     --out <run_dir>/link-discovery-report.json   # also writes <run_dir>/browser-needed.json
   ```

   Every static fetch that needs a browser (Cloudflare "Just a moment", thin JS shells, social
   profiles) lands in `browser-needed.json` with the in-page extractor script, and in the report
   under `runtime.browser_needed`.
3. For each pending URL (`claude-chrome-browser.mjs manifest pending --manifest ... --results ...`):
   `navigate` to it in your own tab, run the manifest's `extractor_js` through `javascript_tool`
   (it parks compact JSON on the page and returns `chars`, `sum`, `chunks`; the tool returns at
   most 1000 characters per call and refuses raw query strings or verification metas, which is
   why the extractor strips them), read every chunk with `chunk_read_js` (INDEX 0..chunks-1,
   several per `browser_batch`), write them verbatim as `01.txt`, `02.txt`, ... under one
   directory, and record: `claude-chrome-browser.mjs results add --file <results> --url <url>
   --final-url <landed url> --page-parts <dir> --expect-chars <chars> --expect-sum <sum>` (a
   char or checksum mismatch refuses the page). Then rerun the step 2 command unchanged. The report is final when
   `runtime.browser_needed` is empty and `browser_provider_preflighted` is true. Persist it to
   `<run_dir>/link-discovery-report.json` before any link write; it is the canonical category
   ledger. Do not replace it with a hand list.
4. **Enforce category completeness before writes.** Reconcile every requested discovery category
   against `category_results`; each must have an explicit status even when no candidate exists.
   In particular, inspect the `careers_jobs` result and the footer/high-signal paths
   (`/careers`, `/jobs`, `/employment`, `/join-our-team`, `/join-the-team`, `/work-with-us`).
   A missing category result, missing persisted report, or a manual summary that cannot be traced
   to a selected candidate is a run error, not evidence that the link does not exist. Rerun the
   full discovery before continuing. Enforce this mechanically before reading production state
   or attempting any link write; exit code 0 is required:

   ```bash
   node ~/.claude/skills/boostly-link-discovery/scripts/validate-discovery-report.mjs \
     --report <run_dir>/link-discovery-report.json --location-id <location_id> \
     --require-browser-provider fulfillment --require-chrome-profile Boostly.com
   ```

   `--require-browser-provider fulfillment` (2026-09-29) accepts either live-session provider
   (`codex-extension` or `claude-chrome`) and always requires fulfillment mode, preflight true,
   and the Boostly.com profile. A comma list (`codex-extension,claude-chrome`) or one provider
   name still works. The validator rejects missing or duplicate categories, a mismatched location, absent statuses,
   any report produced by Playwright, a static-only run, or a non-Boostly Chrome profile during live fulfillment, a
   claude-chrome report with browser results still pending, a report crawled through the
   diagnostics `--website-url-override` (the website was never written to V2), and any
   create/update proposal that is not verified, live, location-relevant, HTTP(S), and free of
   challenge, timeout, HTTP-error, or soft-not-found evidence. `prepare-fulfillment-plan.ts`
   re-checks the same runtime rules. Never bypass either.
5. **Cross-check the Google Business Profile** (search the name + city) for the ordering link
   and socials the site might omit.
6. **Verify candidates by loading them in the browser**, a page that renders as the right
   brand's page is verified. A bot-challenge/login wall (DataDome, Cloudflare "Just a moment",
   captcha) is NOT proof of invalid: mark it `needs_manual_review`, never `broken`. Because
   you're a real logged-in browser, you'll rarely hit these.
7. Canonicalize socials to the brand's own profile URL (not a share/login redirect). When a
   category has several candidates, keep the one on the official domain / official profile.
   An official-site link is candidate evidence, not sufficient identity proof by itself: before
   writing a social, require destination-side confirmation through a matching business/location
   name, geo/phone/address evidence, or a backlink to the verified official domain. Hold login-walled
   profiles without that second signal, and hold any visible title, logo, identity, or location mismatch.
   A readable profile with NO business signal (no name/geo/phone match, no website link, no bio, no
   business category, follower count under the verifier's floor, default or missing avatar, personal
   content) is REJECTED as `identity_mismatch`, not held; the verifier encodes the thresholds in
   `SOCIAL_BUSINESS_SIGNAL_THRESHOLDS`. Likewise a 200 whose body says the page does not exist
   ("Oops. This page does not exist!", "we can't find that page", "no longer available") is `broken`,
   never `needs_manual_review`. Held is only for login walls and same-name/different-city ambiguity.

If the live session is unavailable, retain static evidence and hold browser-dependent candidates
for review. An explicit Playwright/local-Chrome fallback may be used only when the live session
is unavailable or insufficient; never make focus-stealing debug Chrome the default.

## Link write gate (conservative, unattended-safe)

- **Auto-write when high-confidence verified:** online-ordering / order, menu, events,
  reservations, careers/jobs, catering, and socials (facebook/instagram/tiktok/youtube/x) that resolve to
  the brand's own profile and satisfy the independent destination-identity gate above.
  Socials go through `branding set` (not a touchpoint event, not a DB write).
- A verified existing `locations.ordering_url` does not by itself complete the customer-facing
  link tree. Reconcile an active `Order Online` custom event to the same verified URL even when
  discovery reports ordering as `existing_verified`; the settings CLI's fill-only canonical-URL
  dedupe makes an already-correct event an idempotent no-op.
- Every supported custom link uses the compact deterministic presentation template that lives
  once, as a constant in `scripts/fulfillment-plan.ts` (title / description / button text per
  category). Pass the category to `events add-custom`; the settings CLI enforces the copy even
  when source pages use all caps or omit it.
- Never save a custom Link/Product event without a description. Keep descriptions to 40 characters
  or fewer. Supported categories use the deterministic descriptions above; any other explicitly
  approved custom link must supply a useful compact description rather than relying on blank copy.
- Never create Specials as a custom Link/Product event. Preserve unrelated existing events, but
  flag a pre-existing Specials custom event for explicit cleanup rather than describing it as a
  fulfillment-added link.
- An events page is not enough to activate an Events link. Auto-create or enable Events when the
  verified destination exposes at least one future structured Event `startDate` or
  `time[datetime]`, or when the bounded `gpt-5.6-luna` exception review independently confirms a
  visible future event and passes the strict schema, evidence-hash, confidence >= 0.90, grounded
  event-copy, and normalized-date gates. Any model failure or insufficient decision remains held.
- A high-confidence first-party page must be live, relevant to the exact business/location,
  destination-specific for its category, and free of challenge, timeout, HTTP 4xx/5xx, or
  soft-error evidence such as `404`, `page not found`, `not found`, or an error-page title/H1.
- Classify the verified destination by what it actually does, not by its source anchor text or
  historical category. Promote a candidate to Order Online only when the rendered destination
  exposes a functional ordering action or resolves to a known provider checkout/menu. Relabel a
  booking destination as Reservations. A plain menu page remains Menu.
- When multiple candidates independently clear that gate and tie on deterministic score, choose
  the exact-location destination first, then the category-specific root, then the shorter
  canonical stable URL. A score tie alone is not a hold; hold only for conflicting identity or
  location evidence, or when no candidate is safely preferable.
- **Hold for review** (reply lists them, no write): gift cards, loyalty, apps,
  and any candidate that does not clear the high-confidence gate, unless Travisse is actively
  supervising and says otherwise.
- **Never** overwrite a different existing URL, and never write an unverified URL.
- Strip the complete query string from first-party content links while retaining path and
  fragment. For ordering providers and socials, preserve only identity-critical parameters and
  strip all tracking/campaign parameters. Enforce this again in the fulfillment plan so a
  discovery report cannot reintroduce disposable query parameters at the production-write
  boundary or remove a parameter required for the destination to function.
- Touchpoint/custom-event saves are full read-modify-write, apply sequentially, preserve all
  existing events. Never run a location-field write concurrently with a branding write (both
  hit the location action; stale payloads clobber). Order: branding → core location fields.
- Every write and every skip → one audit row (schema: references/audit-row.md).
- After link and social writes, run `events enforce-linktree-defaults <locationId>
  --ensure-location-scope` as a dry run, repeat with `--apply`, and inspect readback. Reviews
  must always be active. Socials must be active whenever effective branding has at least one
  verified social URL. If an active Menu event and Order Online event have the same canonical
  URL, keep the URL only as Order Online and remove Menu. Missing default Reviews/Socials events
  are a hold/error; never fabricate replacement custom events.

## Branding

The pipeline, gates, variant sheet, review canvas, write rails, and every design rule live in
`~/.claude/skills/boostly-brand-design/SKILL.md`; this section only says what the orchestrator
does around them.

- Existing-branding invariant: existing production branding changes only the write decision,
  never the proposal. Every request gets the full evidence packet, a fresh Fable decision, the
  variant sheet, and the review canvas; the write is held (`hold_existing`) until Travisse picks.
  Existing values never bypass the gate battery or the effective proof (brand SKILL rules 0, 2).
- Fable invocation (the ONE contract, 2026-09-21): launch the judgment as an in-session subagent
  with the Agent tool, `model: "fable"`, medium effort, and the body of
  `boostly-brand-design/references/subagent-prompt-template.md` with the placeholders filled;
  it writes `<run_dir>/decision.json` and replies `decision written`; then run
  `validate-fable-decision.ts --run <dir>`. Never `claude -p`, never an API call, never GPT, and
  never "produce the decision yourself" in the orchestrator's own context: the packet stays out
  of the orchestrator. A missing or invalid decision is a run error, not a reviewer hold.
- Unattended auto-write is retired: since 2026-09-17 every branding write waits for Travisse's
  letter (step 11). The write stage (`execute-fulfillment-plan.ts`, or `branding set` with
  `--expect-from-readback`) still runs `gates.ts check` on the exact upload and refuses HOLD.
- After readback: `branding-feedback.ts apply` with actor `automation` (never `approve`), the
  effective proof, and one badge PDF inspected at print size (brand SKILL write rails).

## Auth

- Boostly cookie: `BOOSTLY_COOKIE_FILE` if set; else mint one:
  `node ~/.claude/skills/boostly-brand-design/scripts/decrypt-boostly-cookie.mjs --out <path>`
  (Chrome "Profile 10", new.boostly.com; output 0600). Re-mint if `auth check` fails.
- DataForSEO uses `boostly-link-discovery/scripts/dataforseo-credentials.mjs`, which
  reads the `boostly-link-discovery.dataforseo` macOS Keychain entry for
  `travisse@boostly.com`. Do not source old environment files or use another
  account as a fallback. DataForSEO supplies candidates, never verification.
- Never print, log, or post cookie/credential values, anywhere. Names + lengths only.

## Badge ownership boundary

- Never list, create, retry, hold, audit, or report badges from this skill or heartbeat.
- Never emit a `badges` write operation or call `badges bulk-create`. Badge creation is already
  handled by the fulfillment request system.
- Keep historical badge fields in old state and artifacts untouched for compatibility. Do not
  add new `processed_badge_request_ids` entries or badge receipt rows.

## Customer-facing link-tree proof

- Capture the live customer-facing link tree after all production writes finish. This is internal
  fulfillment evidence, not an input to branding generation and never a Slack attachment.
- When an existing exact-location badge with a non-null `short_id` is already available from a
  read-only source, prefer the unassigned active badge with the lowest `issue_id`, otherwise the
  active badge with the lowest `issue_id`. Do not create a badge to obtain a preview URL.
  Its canonical shared public URL is
  `https://tp.boostly.com/<short_id>`. Never use a badge from another location and never guess a
  short ID. If the account has a custom touchpoint domain, the shared URL is still the canonical
  screenshot source unless production readback returns a verified account-owned public URL.
- Open that URL in the live Chrome session (Boostly.com profile). Capture a full-page screenshot
  at a mobile-sized viewport (390 x 844 when viewport control is available) and save it as
  `<run_dir>/link-tree.png`. Wait for the restaurant identity, branding, and Link/Product controls
  to finish rendering before capture.
- Validate that the page is nonblank, names the exact restaurant/location, and displays the current
  post-write links. A wrong identity, unresolved page, security challenge, render failure, or missing
  active badge makes the screenshot unavailable. Never reuse an old screenshot or one from another
  request. Record the source URL and concise failure reason when unavailable.
- Audit this step as `link_tree_proof` with the public URL, screenshot path, capture timestamp, and
  `verified` or `held` outcome.

## Finish

### Apple Notes quick view (default, Travisse 2026-09-29)
Every location with link candidates gets a `Links` jump in the note (`review-canvas.html#links`). A review page that has link data but no Links section is stale: `review-checklist.py` rebuilds it once (`review-canvas.mjs --run <dir> --skip-google`, backup kept as `review-canvas.before-links-rebuild.html`). After any link re-check, rebuild that location's review page so the verdicts on it are current.

Travisse reviews from one Apple Note, "Fulfillment reviews: pre-physical checklist". Keep it
current by default; do not wait to be asked.

### Public review site (default, Travisse 2026-10-09)
The shareable review page is `https://fulfillment-reviews.vercel.app/<run dir name>/` (index at
the root: search by name or city, status filter, sort by last updated or request date). Repo
`Boostly/fulfillment-reviews`, clone `~/Programming/repos/fulfillment-reviews`, Vercel team `boostly`,
project `fulfillment-reviews`; a push to main deploys. Images go to the Vercel Blob store
`fulfillment-reviews-assets` keyed by content hash (cache committed at `data/blob-index.json`),
so a rebuild uploads only new assets. The build reads `BLOB_READ_WRITE_TOKEN` from the clone's
git-ignored `.env.local` (`vercel env pull .env.local --scope boostly` after `vercel link`). As
soon as `review/review-canvas.html` exists and the Apple Note is refreshed, publish the page:

```bash
cd ~/Programming/repos/fulfillment-reviews && git pull --ff-only && \
  npm run build -- --run-root "$BOOSTLY_RUN_ROOT" --limit 25 --slug <run dir name> && \
  git add public data && git commit -m "Add <location> review page" && git push
```

Rerun the same command after a closeout (closeout-finish does it) so the page's status flips
to "Closed out". Pushing to this repo is part of publishing and needs no separate go. The
build strips Boostly admin anchors and internal json/md links from each page; never add
ship-to data to `data/sites.json`. The build merges into the committed `data/sites.json`: only
runs found in the given run root are rebuilt, every other page is kept, so pages from another
machine survive; `--prune` wipes and regenerates from this run root only and is how a page is
removed. The site page is what Cam, Karissa,
and customstickers.com look at; the local review server (`127.0.0.1:3917`) and the Apple Note
are the operator's own quick view, and Claude artifacts are no longer used for review pages.

```bash
python3 ~/.claude/skills/boostly-box-fulfillment/scripts/review-checklist.py \
  --run-root <run root, the folder holding one run dir per location>
```

- What it does: a read-only query of open requests (branding, digital fulfillment, store
  details), a join to each `run.json`, then a rich-text rewrite of the note (bold headings,
  bullets, real links) through `apple-notes-decision-brief/scripts/write_decision_brief.py`.
  No production writes. `--no-live` skips the query and reuses the last list; `--no-note`
  prints the markdown instead of writing.
- Every location carries its links: **Review page** (`review/review-canvas.html`), **Compare**
  (the newest `review/compare-*.html`), and **Figma** (the run.json `figma.section_url`). A
  location that has a variant sheet but no canvas yet shows a "Variant sheet" link marked as
  still building; that is a gap to close, so build the canvas. A sibling location that
  inherits account-level branding (`write.branding_source_run`) links to the source run's pages.
- Review links are served by a local static server on `127.0.0.1:3917` that the script starts
  when it is not running. They open on this Mac only. Never `open` them for Travisse. The
  link to share with Cam, Karissa, or the vendor is the site page (above), never this local
  URL and never a Claude artifact.
- The note is view only and rebuilt from state; edits made in Notes are overwritten. Put a
  one-line human note per location in `<run root>/checklist/notes.json` (keyed by run dir
  name): the lead's recommendation, an open decision the run.json does not track, a closeout
  that is running. Keep a note line true; rewrite it when the state moves past it.
- When to run it: after the review canvas is built (fulfill-location), after a pick is
  marked, after the Figma section is built (closeout-location), and after the finish steps
  (closeout-finish). Pass `--no-live` from an agent; the scheduled job does the live query.
- Agents own their line: when an agent finishes a step it rewrites its own key in
  `<run root>/checklist/notes.json` (keyed by run dir name, one true sentence, only its own
  key). No model rewrites stale lines any more; the lead reconciles on request.
- The 5 minute refresh is a launchd job with no model (2026-09-29), not a session cron:
  `~/Library/LaunchAgents/com.boostly.fulfillment-checklist.plist` runs
  `<run root>/checklist/launchd-refresh.sh` every 300 seconds (and once at load). It runs
  `build-checklist.py` with the live query, never opens or activates an app, and logs to
  `<run root>/checklist/launchd.log`. A good run ends with `result=ok` and shows
  `writer exit 0` and `stale=False`. The run root is fixed in the plist and the wrapper's
  location; a new run root needs a new wrapper copy and an edited plist.

  ```bash
  # check: last result, and whether launchd has it loaded
  tail -n 3 "<run root>/checklist/launchd.log"
  launchctl print gui/$(id -u)/com.boostly.fulfillment-checklist | grep -E 'state|runs|last exit'
  # stop (unload)
  launchctl bootout gui/$(id -u)/com.boostly.fulfillment-checklist
  # start (load)
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.boostly.fulfillment-checklist.plist
  # run once now
  launchctl kickstart gui/$(id -u)/com.boostly.fulfillment-checklist
  ```

### Review checklist

- Read `~/.claude/skills/notion-boostly/SKILL.md`. Use only the Boostly
  `notion-ai-ntn.sh` wrapper and native image uploader documented there; never use the Notion
  MCP or the personal Life Backlog CLI.
- Populate `references/review-checklist-template.md` with the resolved request, production
  readbacks, applied and held links, branding outcome/flags/case ID, artifact
  paths, the admin request URL (`https://new.boostly.com/admin/fulfillment/<fulfillment_request_id>`),
  and the Slack thread URL when the request has one. Every held link must retain its category, direct
  candidate URL, and concise reason it needs human review. When no stable URL was verified,
  retain the category plus the unresolved reason instead of dropping it. Write it to
  `<run_dir>/fulfillment-review-checklist.md`.
- Use the deterministic title
  `Boosted Box Fulfillment Review - <location_name> - <fulfillment_request_id>` (the artifact
  generator falls back to `canonical_thread_ts` only for legacy Slack-keyed requests). The request
  id is part of the title and identity so retries cannot silently create a second review for the
  same request.
- Before creating anything, look in the append-only audit for a successful
  `notion_review_page` row with the same `request_key`. Reuse its page ID
  and URL. If none exists, search Boostly Notion for the deterministic title. Reuse one exact
  title match; create when there are none; if there are multiple exact matches, hold the Notion
  step for review rather than choosing one.
- Create new pages in the Boostly **Travisse AI Output** database with category `research`:

  ```bash
  ~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create \
    "$TITLE" "research" @<run_dir>/fulfillment-review-checklist.md
  ```

- For a newly created page, append `proof.png` first, `<run_dir>/link-tree.png` second when its
  validation succeeded, and then every exact GBP source photo used for branding (up to 10), in
  manifest order, with clear captions:

  ```bash
  node ~/.config/notion-tools/notion-image-upload.js --workspace boostly \
    <page_id> <proof.png> "Generated branding proof"
  node ~/.config/notion-tools/notion-image-upload.js --workspace boostly \
    <page_id> <run_dir>/link-tree.png "Live customer-facing link tree after fulfillment"
  node ~/.config/notion-tools/notion-image-upload.js --workspace boostly \
    <page_id> <gbp-photo-file> "Google Business Profile source photo 1"
  ```

  Never upload stale images or photos from another request. On a reused page, do not append the
  same images again unless the page is intentionally regenerated after a recorded revision.
- Audit the title, page ID, URL, image count, and outcome as `notion_review_page`. Notion is a
  collaboration artifact, not a production-write gate: if creation or image upload fails, keep
  the production fulfillment result and audit the reason. Do not mention the checklist in Slack.

- Update state through `persist-fulfillment-state.ts`: a completed request adds its id to
  `processed_fulfillment_request_ids` and its `v2:<id>` key to `processed_request_keys`; every
  request records its outcome in `fulfillment_request_outcomes`; set `last_checked_at`; write a
  concise `last_run` containing only link counts. Leave `last_processed_ts` and badge dedupe
  state untouched.
- Slack (the ONE contract, matching step 11): exactly one post per location, in the request's
  thread, only when it has a `slack_thread_ts`, made at automatic close-out by
  `boostly-signage-sheets/scripts/post-review.mjs --apply` (dry run first). It carries the final
  branding result: the proof, the applied card and sticker logo files, the three reviewer links
  (website, GBP place, logo image search), the Figma section, the link summary (`Added X links,
  held Y for review, unresolved Z`, every written category + URL, every held category + candidate
  URL + reason), the preflight flags and the "Call facts" block. When the request has no thread,
  nothing is posted anywhere; the Notion review queue is the completion note. Never search Slack
  for a thread, never post a new top-level message, no placeholder or progress posts, and no
  other post without Travisse's explicit approval. The old text-only link summary and the
  brand-skill upload rules are retired.
- Runner report (every request, fixed format, no em dashes): the six lines (Applied, Held, Open
  decisions, Links, Flags, Next) followed by the "Call facts" block pasted verbatim from
  `<run_dir>/call/call-facts.md`; the block's fixed shape is defined once in
  `boostly-signage-sheets/SKILL.md` PREFLIGHT. When preflight did not run, the block reads
  `Call facts: preflight not run (<reason>)`; a transcript-pending call is named on the Calls line
  and in Next.
- Final response (real requests only): `processed, links added, links held/skipped, blockers`.
  No raw payloads, no credentials.
