# In-store fulfillment automation: architecture map

Written 2026-09-16 for Travisse and Mikey. One page. The typed scripts below are the target
path; today a Claude Code session steers several stages by hand. The stage table says which.

## 1. What this automation does

It pulls every open Boosted Box / Tap Cards request in the admin Branding lane from the V2
production database, verifies the location, and discovers and verifies the location's public
links. It builds a branding evidence packet, asks Fable for one bounded logo/palette/composition
judgment, renders a variant sheet that Travisse reviews, and runs mechanical quality gates. It then
writes links and branding to production through a guarded CLI, proves the result with a real badge
PDF, and publishes the review surfaces (Notion queue, Figma signage, optional Slack thread reply)
while recording state and an append-only audit.

## 2. Flow

```
 v2-db read replica
        |
  [intake] list-branding-requests.ts  -> branding-requests.json
        |
  [preflight/plan] preflight-fulfillment-batch.ts, prepare-fulfillment-plan.ts -> fulfillment-plan.json
        |
  [links] discover-links.mjs + verify-core.mjs -> link-discovery-report.json
        |
  [evidence] fetch-google-place-photos.mjs, build-branding-evidence.ts -> evidence/branding-evidence.json
        |
  [Fable judgment]  interactive subagent (Agent tool, model fable) -> fable-decision.json (six keys)
        |             validate-fable-decision.ts; variant-sheet.mjs -> variants/variant-sheet.png
        |             Travisse reviews the sheet, may pick a different letter  <== person
        |
  [gates] iterate-logo-rules.mjs, logo-quality-gates.ts, logo-crop.ts, tinypng-compress.mjs
        |
  [write] boostly-links branding set / events set: dry run -> --apply -> readback
        |         render-badge-pdf.sh -> badge-proof.png ; screenshot.mjs -> proof.png
        |
  [render] review-queue.mjs (Notion) | plan.mjs + Figma MCP (signage) | post-review.mjs (Slack, thread ts only)
        |
  [state/audit] persist-fulfillment-state.ts -> heartbeat state + audit.jsonl; branding-feedback.ts -> feedback ledger
```

## 3. Stages

| Stage | Script | In -> out | Today |
|---|---|---|---|
| Intake | `boostly-box-fulfillment/scripts/list-branding-requests.ts` | v2-db -> `branding-requests.json` | scripted |
| Preflight and plan | `preflight-fulfillment-batch.ts`, `prepare-fulfillment-plan.ts`, `location-match.ts` | requests + state -> `fulfillment-plan.json` | scripted |
| Call preflight (offer, quantities) | `boostly-signage-sheets/scripts/preflight.mjs` | AskElephant -> `preflight/preflight.md` | scripted, person reads it |
| Link discovery and verification | `boostly-link-discovery/scripts/discover-links.mjs`, `boostly-link-verifier/lib/verify-core.mjs` | site + V2 + GBP -> `link-discovery-report.json` | scripted |
| Evidence build | `boostly-brand-design/scripts/build-branding-evidence.ts`, `fetch-google-place-photos.mjs`, `fetch-searchapi-brand-environment.ts` | input json -> `evidence/branding-evidence.json` | scripted |
| Fable judgment | `references/subagent-prompt-template.md` via the Agent tool; `validate-fable-decision.ts` | evidence -> `fable-decision.json` | person-steered |
| Variant sheet review | `scripts/variant-sheet.mjs` | decision -> `variants/variant-sheet.png` and `.json` | person-steered (Travisse picks the letter) |
| Treatment and gates | `harness/iterate-logo-rules.mjs`, `scripts/logo-quality-gates.ts`, `logo-crop.ts`, `cut-words.mjs`, `tinypng-compress.mjs` | chosen asset -> `fix/*`, gate json, `gates` block | scripted from `boostly-brand-design/references/gates.json`; overrides are `run-file override` records, combined by `gates.ts verdict` |
| Production write | `boostly-instore-link-settings/scripts/boostly-links.ts` (`execute-fulfillment-plan.ts` for the typed path) | plan -> dry, apply, `production-readback.json` | scripted |
| Proof | `scripts/render-badge-pdf.sh`, `harness/screenshot.mjs`, `render-effective-proof.ts`, `validate-effective-proof.ts` | readback -> `badge-proof.png`, `proof.png` | scripted |
| Notion review queue | `boostly-review-queue/scripts/ledger-from-manifest.mjs`, `review-queue.mjs upsert` | manifest -> ledger -> page blocks | scripted, ledger fields set by hand |
| Figma signage | `boostly-signage-sheets/scripts/plan.mjs`, then `use_figma` | branding -> `signage/plan.json` -> Figma section | person-steered (column and section bookkeeping) |
| Slack thread reply | `post-review.mjs`, `generate-fulfillment-artifacts.ts` | run dir -> one thread message | scripted, fires on explicit go |
| State and audit | `persist-fulfillment-state.ts`, `branding-feedback.ts` | result json -> state, audit, feedback ledger | scripted |

## 4. Keys (names only)

Boostly admin cookie (minted from the Chrome Boostly profile by `decrypt-boostly-cookie.mjs`,
or `BOOSTLY_COOKIE_FILE`), v2-db read replica credentials, `GOOGLE_PLACES_API_KEY`, Notion
Boostly token (`BOOSTLY_TOKEN` in the notion-tools wrapper, `NOTION_API_TOKEN` override), Slack
token (slack-tools), `TINYPNG_API_KEY`, DataForSEO (macOS Keychain item), `SEARCHAPI_API_KEY`,
OpenAI key for image knockouts, Figma through the MCP plugin session. All of these live in
`~/.config`, the Keychain, or the shell profile. None live in the skill folders, run directories,
or git. Never print values; names and lengths only.

## 5. Invariants

- Every production write is read, dry run, `--apply`, readback, in that order, one operation at a time.
- `branding set` replays the whole row. Pass `--expect-from-readback <run>/production-readback.json` on every write after the first apply.
- No writes for a location whose account has a pending onboarding session (objectives duplicate).
- A badge PDF proof is rendered after every `branding set --apply`.
- Generated or AI-assisted marks are never applied without Travisse or Cam approval.
- Overrides of Fable or a gate are recorded as data with a reason. Rules and gates are never edited to make a run pass.
- Fable stays an in-session subagent that Travisse can steer. It is never replaced by an API call.
- Notion pages are patched in place. Never delete and rebuild.
- Slack posts only into an existing `slack_thread_ts`, and only on an explicit go.

## 6. What changed on 2026-09-16

- Intake now reads `fulfillment_requests` through v2-db. The Slack parser was deleted.
- The image harness moved into `boostly-brand-design/harness/` (seven live scripts plus `mockups/`); dead scripts were removed.
- Server action ids live in `boostly-instore-link-settings/scripts/action-ids.json` and self-heal on a 404 rotation; `derive-actions.ts --check` audits them.
- Baseline commits exist locally: `~/.claude/skills` at `8df8fc2`, the spike project at `19ea7c5`.

## 7. Planned next

One run file per location (`run.json`, schema `references/run-schema.json`, CLI
`scripts/run-file.ts`) landed 2026-09-16: every stage takes `--run <dir>` and writes its block;
the ledger, artifacts, and state render from it; old runs migrate with `run-file migrate`. Next:
gates as data, with a recorded override and a replay check. The variant sheet patched in place instead of re-rendered. Later, a
single entry command and a merge of the three link skills.

## 8. Where things are

- Skills: `~/.claude/skills/boostly-{box-fulfillment, brand-design, instore-link-settings, link-discovery, link-verifier, review-queue, signage-sheets}`. `~/.codex/skills` is a daily mirror and the git remote; edit only the Claude copy.
- Runs: `$BOOSTLY_RUN_ROOT/runs-prod-YYYY-MM-DD/<location-slug>/` with `run.json` (single source; `manifest.json` on pre-2026-09-16 runs until migrated), `decision.json`, `evidence/`, `variants/`, `fix/`, `production-readback.json`, `proof.png`.
- State and audit: `~/.claude/skills/boostly-link-discovery/runs/boosted-box-heartbeat-state.json` and `boosted-box-heartbeat-audit.jsonl` (settled 2026-09-21: the one shared location the Codex heartbeat still writes; `scripts/paths.ts` is the only place it is spelled out, and the `runs/` copy under `~/.claude` is a stale mirror). Code paths between skills resolve relative to the skills root.
- Browser providers: `codex-extension` (Codex heartbeat, in-process) and `claude-chrome` (Claude session: manifest -> claude-in-chrome MCP visits -> `browser-results.json` -> rerun; helper `boostly-link-discovery/scripts/claude-chrome-browser.mjs`). The validator and plan builder accept both.
- Feedback ledger: `boostly-brand-design/feedback/branding-feedback.jsonl`.
- Notion review queue page: `3d5c831c-671e-81f2-9521-ca351ff56f52`.
- Figma: current file, template section, and slot grid in `boostly-signage-sheets/references/figma-target.json` (In-Store-Fulfillment-8 as of 2026-09-22; File 7 retired, read-only, listed under `previous_files`; old runs keep their own run.json figma block).
