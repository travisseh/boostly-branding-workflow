---
name: boostly-fulfillment-qa
description: Build and publish a weekly Boosted Box and Tap Cards QA document from fulfillment audit records, fresh production readback, and exact Slack proof screenshots. Use when Travisse asks for a weekly fulfillment QA page, link audit, branding review document, or a follow-on page that excludes locations already covered by an earlier QA document.
---

# Boostly Fulfillment QA

Create one Boostly Notion QA page for a date window. The durable result is a live-production review surface, not a summary of what automation intended to write.

## Required inputs

- Inclusive start and end dates in `America/Denver`.
- Shared audit: `~/.claude/skills/boostly-link-discovery/runs/boosted-box-heartbeat-audit.jsonl`.
- Shared state: `~/.claude/skills/boostly-link-discovery/runs/boosted-box-heartbeat-state.json`.
- Optional prior `qa-data.json` or prior Notion page. Exclude every location/request already represented there.

## Selection contract

1. Group audit rows by canonical Slack request timestamp and request key.
2. Include concluded requests whose canonical request falls in the date window.
3. Also include requests explicitly excluded from the prior QA page when they concluded after that page was generated.
4. Exclude General locations always.
5. Do not duplicate any location/request represented in the prior QA page.
6. Include blocked or held fulfillments as clearly labeled QA exceptions. Never present them as completed.

## Live evidence contract

For each selected non-General location:

1. Resolve account/location identity through `v2-database` read-only queries.
2. Read fresh production values with `boostly-instore-link-settings`:
   - `location get`
   - `branding get`
   - `events list`
   - `badges list --full`
3. Reconcile those values with the fulfillment audit, including held links and reasons.
4. Use the exact `proof.png` or `link-tree.png` uploaded to the fulfillment Slack thread. Prefer effective branding proof, then validated live link-tree proof. Never substitute a locally regenerated approximation.
5. Send every selected screenshot through an independent `gpt-5.6-luna` visual review. Ask Luna to report the visible branding identity and every visible link/event title, description, button label, and social/app icon. Reconcile the visual findings with fresh production readback. Scraped or API data alone is not sufficient event-presence evidence.
6. Treat screenshot/readback mismatches as explicit QA exceptions. A screenshot that predates a later production change may still be attached as the exact Slack artifact, but it must not be presented as current-state proof.
7. If no valid screenshot exists, or Luna cannot inspect it, state that inside the location toggle.

## Page shape

Create `Weekly Boosted Box / Tap Cards QA - <date range>` in Boostly Travisse AI Output, category `research`.

- Use one Notion toggle per location.
- Inside each toggle include account/admin/Slack/public URLs, core links, social/app links, standard sections, every custom link with title/description/button/destination, branding colors/logo/scope, badge counts, holds, the Luna visual-verification result, and disposition checkboxes.
- Put the exact fulfillment screenshot inside its matching toggle. Do not use HTML previews.
- Use `scripts/build-weekly-qa.mjs --input <qa-data.json> --output <page.md>` to render deterministic Markdown.
- Create the page only with `~/.config/notion-tools/notion-ai-ntn.sh --workspace boostly create`.
- Append local screenshots with `node ~/.config/notion-tools/notion-image-upload.js --workspace boostly <toggle-block-id> <path> <caption>`.
- Use `scripts/list-notion-toggles.mjs <page-id>` to map toggle headings to block IDs without printing credentials.
- Run `scripts/verify-notion-qa.mjs <page-id>`, then read the final page back. Verify location count, every toggle heading, and every image block before reporting completion.

## Safety

- Read-only workflow. Never mutate production fulfillment settings.
- Never print cookies, Notion tokens, database URLs, or API keys.
- Preserve source gaps and conflicting evidence explicitly.
- Temporary staging belongs under `/tmp`; the Notion page is the durable deliverable.
