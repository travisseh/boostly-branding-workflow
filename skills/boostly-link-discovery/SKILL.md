---
name: boostly-link-discovery
description: Bootstrap a missing Boostly location website from Google Places, then discover, verify, and propose enrichment for tapcard/linktree social, app, menu, order, and custom touchpoint links for one V2 location. Use when filling missing link settings or testing link extraction automation.
---

# Boostly Link Discovery

## Purpose

Given one non-General Boostly V2 `location_id`, crawl its official site once and produce a
read-only enrichment report with:

- existing configured links
- discovered candidate links
- verifier-compatible link decisions
- one category result per category
- proposed location/branding updates
- proposed touchpoint events
- manual review items

This skill is read-only after its website bootstrap. When the location has no
`website_url`, it first fetches `websiteUri` from Google Places using the
location's `google_place_id`, then uses `boostly-instore-link-settings` to dry
run, apply, and read back the core location update. Discovery and verification
do not start until that write succeeds. All later enrichment remains proposal-only.

It imports the shared verifier core from:

`~/.claude/skills/boostly-link-verifier/lib/verify-core.mjs` (resolved relative to the skills root, so the same code runs from the `~/.codex/skills` mirror)

The standalone `boostly-link-verifier` skill remains the verify-only tool for configured-link audits and backfills.

## Main Command

```bash
node ~/.claude/skills/boostly-link-discovery/scripts/discover-links.mjs \
  --location-id <location_id> \
  --out /tmp/link-discovery-enrichment-report.json \
  --mode discovery+verify
```

(From Codex, the same script under `~/.codex/skills` with the Codex runtime node also works;
sibling skills and v2-db resolve relative to whichever skills root the script runs from.)

Search defaults to DataForSEO SERP Live using the `travisse@boostly.com` account.
The password is loaded from macOS Keychain service
`boostly-link-discovery.dataforseo`, not shell environment variables or source
files in other projects. Different credential overrides are rejected. If the
Keychain item is unavailable, stop rather than falling back to another account.
Replay runs do not load credentials. For Places:

```bash
export GOOGLE_PLACES_API_KEY="..."
```

The Places key may also be loaded from the standard Boostly env files. The
authenticated location update uses `BOOSTLY_COOKIE`, `BOOSTLY_COOKIE_FILE`, or
`--cookie-file <raw-cookie-file>`. The preflight uses `--ensure-location-scope`,
performs a dry run, applies only when the dry-run value matches Places, and
requires a matching readback before continuing.

If `website_url` is empty and the location has no `google_place_id`, Places has
no usable `websiteUri`, authentication is unavailable, or the write/readback
fails, stop the run before other verification. Replay mode never calls Places
or writes. `--skip-website-bootstrap` exists only for supervised diagnostics;
do not use it for normal live discovery or Boosted Box fulfillment.

## Browser providers

**Fulfillment default (2026-09-29): Codex is the transport, Claude keeps the judgment.** A
Claude session hands page reading to Codex and gets a report file back. The Claude Chrome
chunk loop is the fallback and runs only in the `discovery-transport` agent (Sonnet, fresh
context), never inside a large fulfill or lead context. Ready, hold, or reject verdicts, the
write gate, and link writes stay with the top Claude model.

Handoff recipe (run through Bash with `run_in_background: true`; 3 to 15 minutes):

```bash
node ~/.claude/skills/boostly-link-discovery/scripts/codex-discovery-handoff.mjs \
  --run-dir <run_dir> --location-id <location_id>
#   --out <file>      default <run_dir>/link-discovery-report.json; refuses to overwrite
#   --overwrite       replace an existing --out (a timestamped backup copy is kept)
#   --no-cache        read every page live instead of using the shared evidence cache
#   --effort medium   Codex reasoning effort (default medium)
#   --print-prompt    print the exact Codex prompt and exit; nothing runs
```

What it does: builds a fixed prompt, runs `codex exec --skip-git-repo-check -C <run_dir>
-c model_reasoning_effort="medium" -o <last message file> -` with the prompt on stdin (no
`-m`, so the model is the one named in `~/.codex/config.toml`), and the Codex session runs
the "Codex-runtime pattern" below in ONE `node_repl` call with `fulfillmentMode: true`,
`requiredBrowserProvider: "codex-extension"`, and `chromeProfile: "boostly"`. Discovery must
finish inside that single call: a background promise loses the browser with
`node_repl exec context not found`. The cell writes the report (mode 0600, no overwrite) and
`<report stem>.codex-status.json`; the launcher then runs
`validate-discovery-report.mjs --require-browser-provider fulfillment --require-chrome-profile
Boostly.com`. Exit 0: written and valid. Exit 2: written, validator failed. Exit 3: no report;
read `discovery_error`. Session output is kept in `<report stem>.codex-session.log`.

The Codex prompt forbids production writes, Boostly app pages, a visible or activated
browser, AppleScript, `open`, chrome-devtools, computer use, and any fallback browser. When
the extension or the Boostly.com profile is missing it stops and reports the error text.

Use the launcher (the `codex exec` CLI), not the `mcp__codex__codex` MCP tool. Tested
2026-09-29: a session started through the MCP tool has no `node_repl` tool ("the node_repl
tool is not available in this session"), so it cannot reach the Chrome extension. If a Codex
session cannot attach the extension when started from a Claude session, Travisse runs the
same one-line launcher command from his own terminal and the Claude lead picks up from the
report file.

Verified 2026-09-29 (Zarape West Hollywood, read-only, `--no-cache`): extension attached,
profiles listed Boostly.com, GMR, Travisse, Enablement, resolved Boostly.com, 192 seconds, 8
distinct pages read in the browser with no browser failure (the Claude Chrome run read 6 and
failed 2), same 38 candidates, validator exit 0. The report still selected the Long Beach
reservations page and a promo events link with tracking parameters, the same as the Claude
Chrome report: the transport does not fix selection, so the verdict step stays with the top
model.

**Claude Code (`claude-chrome`), the fallback.** Discovery cannot call the claude-in-chrome MCP tools from
Node, so the crawl is a manifest/resume loop driven by the `discovery-transport` agent:

```bash
H=~/.claude/skills/boostly-link-discovery/scripts
# 1. profile name from tabs_context_mcp / list_connected_browsers, never guessed
node $H/claude-chrome-browser.mjs results init --out <dir>/browser-results.json --profile Boostly.com
# 2. static-first crawl; every browser escalation lands in <dir>/browser-needed.json
node $H/discover-links.mjs --location-id <id> --mode discovery+verify --fulfillment-mode \
  --browser-provider claude-chrome --chrome-profile boostly \
  --browser-results <dir>/browser-results.json --out <dir>/link-discovery-report.json
# 3. for each url in the manifest: navigate in the live tab, run the manifest's extractor_js via
#    javascript_tool (parks compact JSON on window.__boostlyPage; returns chars, sum, chunks),
#    read chunk i with `chunk --index i` (the tool returns <= 1000 chars per call and refuses
#    raw query strings / verification metas, so the extractor strips them), write the chunks
#    verbatim as 01.txt, 02.txt, ... under one directory, then
node $H/claude-chrome-browser.mjs results add --file <dir>/browser-results.json \
  --url <url> --final-url <landed url> --page-parts <dir/pages/<slug>> \
  --expect-chars <chars> --expect-sum <sum>   # mismatch refuses the page
# 4. rerun step 2 unchanged until runtime.browser_needed is empty
node $H/claude-chrome-browser.mjs manifest pending --manifest <dir>/browser-needed.json --results <dir>/browser-results.json
```

The report is fulfillable only when `runtime.browser_provider_preflighted` is true (a results
file in the required profile was loaded) and `runtime.browser_needed` is empty; the validator
(`--require-browser-provider fulfillment`, which accepts `codex-extension` or `claude-chrome`
and always requires fulfillment mode, preflight true, and the Boostly.com profile; a comma
list or a single provider name also works) and `prepare-fulfillment-plan.ts` both enforce it.
A results file captured in another Chrome profile is refused at preflight. `--browser-manifest
<path>` overrides the manifest location (default: `browser-needed.json` beside `--out`).
`--website-url-override <url>` crawls a known site without the Places bootstrap write; it is
diagnostics only and the validator refuses such a report for fulfillment.

**Codex (`codex-extension`).** When running from Codex, live discovery should use the Codex Chrome extension
provider (`browser-provider=codex-extension`) so Cloudflare and other
bot-challenge pages can be verified without launching the separate debug Chrome
helper that steals desktop focus. The provider is selected automatically when
`discoverLocation()` is called from the Chrome plugin Node runtime with
`codexAgent: globalThis.agent`. Fulfillment runs must also set
`fulfillmentMode: true`; this preflights the exact extension profile and fails
before discovery if the provider would fall back to Playwright. Plain terminal
runs default to Playwright unless `--browser-provider local-chrome` is explicitly
passed.

Use `local-chrome` only as an explicit last-resort fallback:

```bash
CHROME_INFO=$(~/.claude/skills/dev-browser/scripts/launch-profile-debug-chrome.sh personal about:blank)
CHROME_ENDPOINT=$(printf '%s\n' "$CHROME_INFO" | jq -r '.endpoint')

node ~/.claude/skills/boostly-link-discovery/scripts/discover-links.mjs \
  --location-id <location_id> \
  --out /tmp/link-discovery-enrichment-report.json \
  --mode discovery+verify \
  --browser-provider local-chrome \
  --chrome-cdp-url "$CHROME_ENDPOINT"
```

When `browser-provider=codex-extension`, `chromeProfile: "boostly"` or
`--chrome-profile boostly` selects the `Boostly.com` extension session by default.
Supported profile keys are
`personal`, `boostly`, `gmr`, and `denada`. Replay mode remains fixture-only and
does not fetch live pages. This does not loosen blind-write gates, and Vercel/Eve
will still need an explicit browser/runtime strategy later.

Codex-runtime pattern:

```js
if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } = await import("/Users/travisse/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs");
  globalThis.agent = await setupBrowserRuntime();
}
// Codex runs the mirror copy; the code is identical to ~/.claude/skills.
const { discoverLocation } = await import("~/.claude/skills/boostly-link-discovery/scripts/discover-links.mjs");
const report = await discoverLocation("<location_id>", {
  mode: "discovery+verify",
  codexAgent: globalThis.agent,
  chromeProfile: "boostly",
  fulfillmentMode: true,
  requiredBrowserProvider: "codex-extension"
});
```

Every new report includes `runtime.browser_provider`, provider preflight status,
and requested/resolved Chrome profile identity. Live fulfillment accepts only
`codex-extension` or `claude-chrome` with the resolved `Boostly.com` profile. Playwright remains
available for replay and terminal diagnostics only.

## Boosted Box integration

Intake is no longer Slack. Since 2026-09-16 the fulfillment pipeline pulls open requests in the
Branding lane from the V2 database with
`~/.claude/skills/boostly-box-fulfillment/scripts/list-branding-requests.ts`.
The DB pull (`list-branding-requests.ts`) replaced the Slack Block Kit/attachment parser
(`parse-boosted-box-requests.mjs`) and the direct-SQL replay script
(`process-boosted-box-request.mjs`); both were deleted from this skill on 2026-09-16 along with
their tests. Nothing in the pipeline reads Slack for intake or writes V2 outside the typed
fulfillment scripts.

For fulfillment, pass the persisted discovery report into the typed pipeline in
`~/.claude/skills/boostly-box-fulfillment/scripts/`:

```bash
node --experimental-strip-types \
  ~/.claude/skills/boostly-box-fulfillment/scripts/prepare-fulfillment-plan.ts \
  --input <preparation-input.json> --out <preparation-result.json>
jq '.plan' <preparation-result.json> > <fulfillment-plan.json>
node --experimental-strip-types \
  ~/.claude/skills/boostly-box-fulfillment/scripts/execute-fulfillment-plan.ts \
  --plan <fulfillment-plan.json> --cookie-file <raw-cookie-file> --out <execution.json>
```

The executor is dry-run by default. An authorized live run repeats it with `--apply`; all writes
go through `boostly-instore-link-settings` with fill-only, sequential save, readback,
idempotency, and account-lock gates.

Deterministic discovery policy:

- Read current V2 + GBP first. General locations are forbidden as targets and are excluded from
  account/location counts and scope.
- Fetch the official site statically before creating a browser. Create the Boostly.com extension
  browser only for JS rendering, challenges, logged-in verification, or ambiguity.
- Extract navigation, footer, JSON-LD, sitemap, known high-signal paths, title, and H1 in the
  same crawl. Canonicalize and deduplicate before classification.
- Cache crawl/verification evidence for 3–7 days by content hash plus resolved URL.
- Search externally only for still-missing Order, Menu, Events, Reservations, Careers, Catering,
  and Socials; batch DataForSEO requests. Do not broadly search gift cards, loyalty, or apps unless
  the official site exposed them.
- Location-field auto-write proposals: ordering URL and official social links. Apps remain
  review-only.
- Touchpoint auto-writes: high-confidence `order`, `menu`, `events`, `reservations`,
  `careers_jobs`, and `catering`. Menu/events/reservations/careers/catering must be live destination-specific first-party pages
  for the exact business/location, with no challenge, timeout, HTTP 4xx/5xx, or soft-error
  evidence such as a 404/not-found title or H1.
- Events additionally require concrete evidence of at least one upcoming event. Prefer a future
  structured Event `startDate` or `time[datetime]` value from the verified destination. When a
  live, first-party Events page is location-matched but lacks structured dates, route its rendered
  event evidence through the bounded `gpt-5.6-luna` exception reviewer. Only a schema-valid,
  evidence-hash-matched, confidence >= 0.90 Luna decision with at least one grounded future date
  clears the write gate. Generic events/private-events marketing, an unavailable Luna run, or an
  invalid/insufficient decision remains held.
- Careers proposals must emit display title exactly `Join Our Team` and primary button text
  exactly `Apply Now`.
- Classify the verified destination by its rendered function. Promote a candidate to Order only
  when it exposes a functional ordering action or resolves to a known provider checkout/menu;
  relabel a booking destination as Reservations; keep a plain menu page as Menu.
- A deterministic score tie is not itself a review reason when every tied candidate independently
  clears the high-confidence gate for the same exact business and category. Choose in this order:
  exact-location destination, then category-specific root, then the shorter canonical stable URL.
  Hold only when identity/location evidence conflicts or no candidate is safely preferable.
- Verdict defaults (gift cards, apps, events, website bootstrap, the two held cases): box-fulfillment "Link write gate".
- Every proposal enters the structured plan/audit, including holds, existing-value skips,
  dedupe skips, and errors.
- After verified socials and touchpoints are written, fulfillment must run
  `boostly-instore-link-settings events enforce-linktree-defaults`: Reviews are always active,
  and Socials are active whenever at least one verified social URL exists.
- Slack and Notion artifacts are rendered from the final structured fulfillment result, never
  from processor/model prose.

Useful flags:

- `--hide-existing`: hide configured social/app/ordering/touchpoint links from discovery input and keep them only for grading.
- `--fixtures-dir <dir>`: fixture root.
- `--record`: supervised live recording mode.
- `--replay`: fixture-only replay mode. Missing fixtures fail rows; replay does not silently fetch live URLs.
- `--skip-schema-check`: bypass V2 schema assertion for fixture-only development.
- `--search-provider dataforseo`: default. Uses DataForSEO Google organic SERP API for search candidates.
- `--search-provider browser-google`: legacy Playwright-driven Google SERP path for comparison only.
- `--allow-updates`: include proposed updates to existing configured values. Omit this for blind-write planning; the default write plan is fill-only-empty.

Replay mode reads search fixtures and does not require DataForSEO credentials.

Eval reports include `locations_requested`, `locations_skipped`, and `order_challenge_carveout_count`. Requested locations with no gold rows for the requested category set count as failures so eval coverage cannot silently shrink.

## Eval Commands

```bash
EVAL_ROOT="/Users/travisse/Documents/Codex/2026-06-26/do-y/outputs/link-discovery-eval-$(date +%Y%m%d-%H%M%S)"

node ~/.claude/skills/boostly-link-discovery/scripts/evaluate-success-cases.mjs \
  --success-csv /Users/travisse/Documents/Codex/2026-06-26/do-y/outputs/tapcard_link_extraction_success_cases.csv \
  --link-settings-csv /Users/travisse/Documents/Codex/2026-06-26/do-y/outputs/tapcard_link_settings_success_cases.csv \
  --verifier-gold-csv /Users/travisse/Documents/Codex/2026-06-26/do-y/outputs/link_verification_gold_cases.csv \
  --fixtures-dir ~/.claude/skills/boostly-link-discovery/fixtures \
  --replay \
  --hide-existing \
  --suite extraction-accuracy \
  --out-dir "$EVAL_ROOT/extraction-accuracy"

node ~/.claude/skills/boostly-link-discovery/scripts/evaluate-success-cases.mjs \
  --success-csv /Users/travisse/Documents/Codex/2026-06-26/do-y/outputs/tapcard_link_extraction_success_cases.csv \
  --link-settings-csv /Users/travisse/Documents/Codex/2026-06-26/do-y/outputs/tapcard_link_settings_success_cases.csv \
  --verifier-gold-csv /Users/travisse/Documents/Codex/2026-06-26/do-y/outputs/link_verification_gold_cases.csv \
  --fixtures-dir ~/.claude/skills/boostly-link-discovery/fixtures \
  --replay \
  --suite idempotence \
  --out-dir "$EVAL_ROOT/idempotence"
```

## Safety Rules

- The only direct mutation allowed in discovery is the missing-website preflight through `boostly-instore-link-settings`; never overwrite an existing `website_url`.
- Fetch the website by the location's exact `google_place_id`; do not use a name/address search result for an automatic write.
- Dry-run, apply, and read back the website update before crawling or verifying any other link.
- Never propose a write for a non-verified URL.
- Default write plans are fill-only-empty. Use `--allow-updates` only for supervised cleanup work.
- Strip tracking, popup, and campaign query params from proposed permanent URLs while preserving provider identity params.
- Keep verifier status semantics shared with `boostly-link-verifier`.
- Use `--hide-existing` for extraction-accuracy grading so success-case configured values do not create false-green evals.
- Use normal mode for idempotence/configured-link safety.
- In replay mode, missing fixtures should surface as `missing_fixture`, not live-web fallback.

## Online Ordering Discovery Contract

Ordering URLs are stricter than other link categories because stale provider/search results can create bad customer-facing links.

- Discover new `order` / `ordering` candidates from the official restaurant website only.
- Do not use DataForSEO or Google search candidates for automatic ordering writes.
- Crawl the official website with a browser, plus high-signal same-domain paths such as `/order`, `/online-order`, `/ordering`, `/menu`, `/locations`, and location-specific path guesses.
- Extract anchors, rendered button-like elements, `onclick`, `data-url`, `data-href`, and script URLs.
- Follow redirects during verification, but save the human-facing input URL when a provider like SkyTab redirects to an internal `/order-settings` URL.
- Prefer known direct ordering providers and official ordering subdomains, then use location-specific evidence as a tie-breaker: street number/name, location modifier, city/state, and provider URL slug.
- Do not propose plain menu pages as ordering URLs. The ordering proposal must be an actual ordering/provider/order-path URL.
- Reject ordering candidates whose provider slug clearly points at a sibling location, such as a different city or street number.
- Known provider URLs that are linked from the official website may still be proposed when the provider blocks browser verification with a bot/security challenge, but the proposal must be tagged with `write_gate.order_challenge_carveout=true` for reporting.
- Hard reject gift cards, marketing/newsletter signup, unavailable/closed ordering pages, settings/admin/login/account URLs, locators, item-level menu/product URLs, app-download CTAs, and static assets.
- Hard reject FAQ/help/support pages as ordering destinations even when their chrome contains a
  global Start Order control. Prefer the functional `/order` or provider route.
- For Menu, prefer a verified navigation-linked menu root over product/category leaves extracted
  from script data. A location-specific menu still wins when its URL carries exact location evidence.

## Careers Discovery Contract

Careers links are less transactional than ordering links, but wrong-brand or stale job-posting links are still bad customer-facing links.

- Discover careers candidates from the official website, search, and existing link settings.
- Auto-propose a new careers touchpoint only when the verified candidate has official-site evidence: it was found during the official website crawl or the official website links to it.
- Keep search-sourced careers candidates for manual review unless the verifier confirms the official website links to the same candidate.
- Crawl high-signal careers paths such as `/careers`, `/jobs`, `/employment`, `/hiring`, `/now-hiring`, `/join-our-team`, `/join-the-team`, and `/work-with-us`.
- Allow ATS/provider links when the official website links to them.
- Prefer page-level careers URLs over individual job-posting URLs. Individual postings are not automatically rejected, but they should lose to a generic careers/jobs/employment page when both verify.

## Socials Discovery Contract

Social links (Instagram, Facebook, TikTok, YouTube, X) published on the location's own official website are the highest-confidence candidates and must win over search candidates; a readable page must still confirm identity (below), and only an unreadable page is written on the anchor alone.

- The official website crawl extracts social anchors (header/footer/body) as `source_type=website` candidates. A social is eligible for automatic writing only when the destination also independently confirms the business through a matching account/location name, matching geo/phone/address evidence, or a backlink to the verified official domain.
- An official-site-anchored social whose page is login-walled or unreadable is `verified_by_anchor` (writable; verdict defaults: box-fulfillment "Link write gate"). A materially different visible profile title, logo, business identity, or location is a mandatory hold even when the official website links to it; website social links can be stale or incorrect.
- Search-sourced socials without official-site backing are never auto-written, no matter how well they verify; a candidate page merely linking back to the official domain (`candidate_links_to_official_domain`) is NOT sufficient - sibling locations cross-link the same brand domain.
- When candidates for a social category tie on verifier status, selection prefers `website` source, then verified official-site cross-links, then `external_link_in_bio`, then search.
- The official-site crawl is rate-limit resilient: same-domain page fetches are paced (~1s apart), and total fetch failures or HTTP 429s on a crawl page are retried with backoff before conceding. Shared hosting (e.g. GoDaddy DPS) serves many sibling-location domains from one server and blocks bursts.
- If every crawled official-site page fails (timeout/429/5xx with zero links), the run must degrade LOUDLY: `summary.website_crawl_status=failed` plus a `website` manual-review item. A search-only social result in that state means "unknown", not "no social exists" - re-run discovery before trusting missing socials.
