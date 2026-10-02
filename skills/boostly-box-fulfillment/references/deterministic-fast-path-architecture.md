# Boosted Box deterministic fast path

## Contract

The fulfillment runtime is a deterministic pipeline with explicit model exceptions. Every stage exchanges validated JSON. No stage may infer a production write from model prose, and no model may write V2, Slack, Notion, audit, or state.

1. `list-branding-requests.ts` (intake, since 2026-09-16) reads open `fulfillment_requests` from the V2 read replica through the `v2-db` CLI, derives the admin lane exactly like `src/lib/fulfillment/status.ts` (Branding = `digital_fulfillment`: not canceled, no tracking number, `digital_fulfilled_at IS NULL`), excludes `ad_hoc` orders and General locations, and emits canonical requests keyed `v2:<fulfillment_request_id>` with `expected_location_id`, `expected_account_id`, the request's own location row as the sole candidate, `account_locations`, quantities from `fulfillment_items`, CSM/requester, ship-to, and `slack_thread_ts`. Badge quantity is always `null`/`missing`. The DB pull replaced the former step, `parse-boosted-box-requests.mjs` (Slack Block Kit/attachment parsing, pairing, request keys), which was deleted on 2026-09-16; no stage may depend on Slack for intake.
2. `preflight-fulfillment-batch.ts` exact-matches every new request before any per-location
   processing and, for v2-db intake, verifies the match against `expected_location_id`
   (`foreign_key_mismatch` is an unresolved identity). One matched non-General location without
   `google_place_id` blocks the whole batch, sends Travisse a self-iMessage, and forbids discovery,
   writes, artifacts, and state advancement.
3. `prepare-fulfillment-plan.ts` performs exact normalized account + location + full-address matching as a verification of the pre-resolved row (an `expected_location_id` mismatch throws), excludes General, rejects a missing Place ID defensively, selects branding scope from non-General enabled/paused locations, checks state dedupe on `processed_fulfillment_request_ids` and legacy `processed_request_keys`, validates the discovery location, and emits a `FulfillmentPlan`.
4. `discover-links.mjs` reads current effective V2 state, crawls the official site, extracts navigation/footer/JSON-LD/sitemap/known-path evidence, verifies candidates, and searches externally only for missing Order, Menu, Events, Careers, Catering, or Social categories. Search, crawl, verification, and planning expose stage metrics and counters.
5. The extension captures full-page desktop/mobile website screenshots plus computed styles for
   visible semantic surfaces. `build-branding-evidence.ts` packages and hashes those artifacts,
   downloads/copies exact assets, ranks unique logo candidates, records dimensions and measured
   colors, classifies authored site tokens, creates GBP evidence/contact-sheet inputs, runs
   mechanical QA, and computes the strict reuse fingerprint. Screenshot-visible surfaces choose
   palette roles; computed styles provide exact values. Raw CSS frequency is never sufficient.
6. A model is invoked only for a declared exception below. An unresolved candidate tie is
   mechanically changed to a hold and removed from the write plan. Fable receives the branding
   evidence packet and may return only `logo_choice`, `palette`, `composition`, `confidence`,
   `flags`, and `rationale`; `validate-fable-decision.ts` also rejects unknown assets, unknown
   palette roles, or missing web colors.
7. `execute-fulfillment-plan.ts` runs the supported settings CLI in sequence: production read, dry-run, apply, and readback for every operation. All data writes are fill-only; badges are last; custom events dedupe by canonical URL; account-scope branding acquires a per-account lock. Link query strings are removed again at plan construction. Indexed/palette PNG logos are rejected before branding writes.
8. `generate-fulfillment-artifacts.ts` renders Slack text, Notion checklist Markdown, audit rows, and the state patch from the validated result JSON. The Slack text is posted only into the request's stored `slack_thread_ts` (the app's "request created" post); a request without one gets the Notion review checklist as its only completion note. `persist-fulfillment-state.ts` uses a lock, append-only audit rows, additive/atomic state updates keyed by `fulfillment_request_id` (`processed_fulfillment_request_ids`, `fulfillment_request_outcomes`, plus the legacy `processed_request_keys` entry `v2:<id>`), and retry-safe audit keys.
9. Applied branding proof is rerendered from resolved production readback. The proof validator requires exact location, effective colors, current logo bytes, readback hash, and proof hash. A real downloaded badge PDF is also rendered and inspected because the HTML preview does not exercise React PDF.

The old `process-boosted-box-request.mjs --apply` direct-SQL route was deleted on 2026-09-16 (the DB pull `list-branding-requests.ts` plus the typed plan/execute scripts replaced it), so nothing can bypass the plan, settings CLI, fill-only gates, account lock, or readback.

## Deterministic/model boundary

Deterministic:

- v2-db intake, lane derivation, request/state keys (`fulfillment_request_id`), item quantities
- exact normalized identity matching and General exclusion
- production reads, effective per-field inheritance, and scope
- canonicalization, redirects, HTTP/challenge/soft-404 detection, provider recognition
- nav/footer/JSON-LD/sitemap/known-path extraction and obvious classification
- candidate ranking and high-confidence write/hold rules
- dry-run/apply/readback, sequential event saves, badge receipts, locks, audit/state
- asset transfer, hashes, dimensions, color extraction, background/edge/resize/contrast gates, proof rendering
- Slack/Notion output from result JSON

Model exceptions only:

- Sol: no exact identity match or more than one exact identity match
- Luna: equal-score candidates with distinct verified destinations and conflicting deterministic
  evidence, plus live first-party Events pages whose visible dates cannot be normalized by the
  structured-date extractor. Event reviews are accepted only through schema-valid JSON with an
  exact URL/evidence-hash match, grounded page text, a normalized future date, and confidence >=
  0.90; the category stays held until a validated resolution is incorporated into a new plan
- Fable: multiple plausible current marks, palette/composition choice, or diagnosis of a failed branding quality gate

Fable remains the final branding-judgment model. GPT is not a substitute.

## Search, cache, and concurrency

- Static fetch happens before browser creation. The Boostly.com Codex Chrome extension is selected exactly when JS rendering, a challenge, platform verification, or ambiguous evidence requires a browser; a random/last-used profile is never accepted.
- Crawl/verification cache TTL defaults to five days and is bounded to 3–7 days. Aliases retain the source content hash, while cached evidence is context-keyed by content hash plus resolved URL so identical HTML at two paths cannot cross-contaminate relative links.
- Independent evidence reads can run concurrently. Production writes stay sequential per location. Account-scope branding takes an account lock; badge creation retains its separate receipt lock and ambiguous-retry refusal.

## Rollout and rollback

The heartbeat remains paused. Before enabling it, run the fixed corpus and all component tests, then perform one supervised dry-run whose structured plan, proof receipt, and generated artifacts are reviewed. Rollback is to pause/leave paused, stop before `--apply`, and revert the deterministic-path code; existing run artifacts and append-only ledgers are never rewritten or deleted.
