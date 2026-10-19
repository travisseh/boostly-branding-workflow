---
name: boostly-link-verifier
description: Verify configured Boostly tapcard/linktree links for a V2 location using database context plus fetched/browser page evidence. Use when checking whether social, menu, ordering, app, or custom touchpoint links are live and belong to the right restaurant location or parent brand.
enabled: true
tags: [boostly, v2, tapcards, link-verification, browser, playwright]
---

# Boostly Link Verifier

## Purpose

Verify configured links for a Boostly V2 location. The skill takes a `location_id`, reads location context and configured links from V2 in read-only mode, loads each destination, and returns a structured JSON report with:

- liveness: `live`, `broken`, `challenge`, or `unknown`
- relevance: `match`, `mismatch`, or `uncertain`
- status: `verified`, `rejected`, `needs_manual_review`, or `broken`
- destination state: `functional`, `hard_rejection`, `configured_but_disabled`, `security_or_bot_challenge`, or `unknown`
- URL canonicalization evidence, including removable tracking parameters and retained destination selectors
- concrete evidence used for the decision

The verifier is conservative. Wrong links going live are worse than missing links, so plausible but incomplete evidence should route to `needs_manual_review`.

For Events, deterministic structured dates remain the fast path. The discovery pipeline may use
the declared `gpt-5.6-luna` exception reviewer when a live, first-party, location-matched page has
visible event cards but no Event JSON-LD or `time[datetime]`. Luna receives only the bounded page
evidence packet and must return schema-valid JSON whose URL and SHA-256 evidence hash match. Low
confidence, hallucinated/unmatched event copy, model failure, or an unavailable review fails closed.

`liveness = challenge` means the destination answered with a bot/anti-automation block (DataDome/Cloudflare 403/429/503, a challenge-prone host like yelp.com or doordash.com, a contentless 403/429) or the fetch timed out. A challenge is not evidence the page is dead, so it always maps to `needs_manual_review` (never `broken` or `rejected`), with evidence flags `security_or_bot_challenge_detected=true` + `challenge_signal=...` or `fetch_timeout_soft=true`.

The CLI imports shared verification logic from `lib/verify-core.mjs`. Any change to that shared core affects both this standalone verifier and the link-discovery skill, so rerun the verifier gold eval after core changes.

## Main Command

```bash
/Users/travisse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  ~/.claude/skills/boostly-link-verifier/scripts/verify-links.mjs \
  --location-id <location_id> \
  --out /tmp/link-verification-report.json
```

Evaluate a CSV of success cases:

```bash
/Users/travisse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  ~/.claude/skills/boostly-link-verifier/scripts/verify-links.mjs \
  --csv /path/to/tapcard_link_extraction_success_cases.csv \
  --out-dir /path/to/eval-output
```

The CSV evaluator treats each CSV URL as an expected known-good link and fails when an expected row is missing from V2 lookup or is not marked `verified`.

## Data Sources

- Use `~/.claude/skills/v2-database/bin/v2-db query --json` for read-only V2 lookup.
- Location context comes from `locations` joined to `accounts`.
- Configured links come from location fields (`website_url`, `ordering_url`, social URLs, app URLs) plus active, non-deleted `touchpoint_events.link`.
- Do not write to V2 or mutate configured links.

## Verification Rules

Every configured URL must be fetched or browser-loaded before judgment.

Status precedence:

1. `broken` when `liveness = broken`
2. `needs_manual_review` when `liveness = challenge` (bot block or timeout: relevance is unknowable, never hard-negative)
3. `rejected` when destination state is `hard_rejection` or `configured_but_disabled`
4. `rejected` when `liveness = live` and `relevance = mismatch`
5. `needs_manual_review` when `liveness = unknown` or `relevance = uncertain`
6. `verified` only when the destination is functional, live, and relevant

`status_basis: evidence | verified_by_anchor`: an official-site-anchored social whose page is a
login wall or empty shell is `verified` by the anchor (evidence line `verified_by_anchor=true`);
a readable page is never overridden by the anchor.

Destination-state checks inspect rendered copy and actionable controls, not only HTTP status.
They reject soft 404/error pages and removed social content, mark temporarily unavailable
ordering, careers pages with no openings, and dormant social profiles as
`configured_but_disabled`, and keep security challenges separate for human review. An ordering
URL must expose an ordering-specific route, provider destination, or actionable order control;
a matching restaurant homepage alone is not a functional ordering destination.

`url_canonicalization.has_removable_tracking_params` tells upstream callers whether tracking
parameters can be removed. Canonical comparison strips only known tracking parameters and keeps
all other query parameters because they may select the restaurant, location, menu, or storefront.

Strong relevance evidence includes:

- exact or near-exact restaurant/location name plus a geographic disambiguator such as city, state, ZIP, street, or phone
- official website links to the candidate URL (strong candidate evidence; for social profiles this is not sufficient by itself)
- candidate URL links back to the official website
- app store/profile/page metadata clearly names the business
- shared parent-brand pages when the account/location context supports a multi-location brand

Name match alone is not sufficient for location-specific verification.
For social profiles, an official-site link must be corroborated by destination-side evidence:
a matching business/account/location name, matching geo/phone/address data, or a backlink to
the verified official domain. Without that second signal, use `needs_manual_review`. A visible
title, logo, business identity, or location mismatch also requires review even when the official
website links to the profile, because official-site social links can be stale.

## Browser Evidence

The script uses static fetch first and creates a browser only for JS-rendered/thin pages,
challenges, logged-in platform checks, or uncertain evidence. In fulfillment, the browser must
be the `Boostly.com` Codex Chrome extension first; Playwright/local Chrome is a fallback, not the
default. Evidence captured includes canonical/final URL, redirect chain, provider, HTTP status,
title, meta tags, visible text, H1/H2 text, outbound links, challenge signals, and soft-404
signals. Dead or removed Facebook pages fail verification; challenge pages hold for review.

General locations are never valid verification targets. Effective branding/social/app values
resolve per field from location override to account base after General rows are excluded from
scope/count decisions.

Instagram may use public metadata (`og:title`, `og:description`, `description`, `og:url`) as
destination-side evidence even if the browser later reaches a login page. If that metadata does
not independently match the business/location and no official-domain backlink is visible, the
profile remains `needs_manual_review`.

## Outputs

The JSON report schema is documented in `schema/report.schema.json`.

For CSV evaluation, the output directory contains:

- `evaluation-summary.json`
- `evaluation-summary.csv`
- one report per location in `locations/<location_id>.json`
