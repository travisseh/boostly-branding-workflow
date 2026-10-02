# Link automation: Codex to Claude port (2026-09-21)

Decision record for moving the Boostly in-store link automation from the Codex Chrome
extension runtime to Claude Code. `~/.claude/skills` is canonical; `~/.codex/skills` is the daily
additive mirror, so the same files land there and the Codex heartbeat keeps working.

| Component | Decision | Where |
|---|---|---|
| `boostly-link-discovery` scripts (discover, validate, evals, helpers) | already file-identical in both roots; hardcoded `~/.codex` sibling paths replaced by skills-root-relative paths | `~/.claude/skills/boostly-link-discovery/scripts/` |
| `boostly-link-verifier/lib/verify-core.mjs` | same; v2-db path relative, Playwright loaded lazily, in-page extractor exported | `~/.claude/skills/boostly-link-verifier/lib/` |
| `v2-database` CLI | already in both roots, identical; credentials resolve from `product2/.local/v2-db.env` (unchanged) | `~/.claude/skills/v2-database/bin/v2-db` |
| `boostly-instore-link-settings` CLI | v2-db path relative; badge receipt ledger stays shared state | `~/.claude/skills/boostly-instore-link-settings/scripts/` |
| `boostly-box-fulfillment` scripts | all sibling paths through `scripts/paths.ts` | `~/.claude/skills/boostly-box-fulfillment/scripts/paths.ts` |
| Heartbeat state, audit, write locks, badge receipts | reference in place at `~/.claude/skills/boostly-link-discovery/runs/` (the Codex heartbeat cron still writes there; the `~/.claude` `runs/` copy is a stale mirror) | one constant, `HEARTBEAT_RUNS_ROOT` in `paths.ts` (and the settings CLI's `DEFAULT_BADGE_RECEIPT_FILE`) |
| Branding feedback ledger | unchanged (`~/.codex/.../boostly-brand-design/feedback/`), out of scope for this port | `brand-design/scripts/branding-feedback.ts` |
| Browser provider | new `claude-chrome` provider beside `codex-extension`; both accepted by the validator and the plan builder | `discover-links.mjs`, `validate-discovery-report.mjs`, `prepare-fulfillment-plan.ts` |
| Chrome profile picker, Codex `browser-client.mjs`, `dev-browser` helper | not needed on the Claude path; left as they are for Codex | `~/.claude/skills/chrome-profile-picker`, `dev-browser` |

## claude-chrome flow

Node cannot call the claude-in-chrome MCP tools, so discovery is a manifest/resume loop:
manifest-only pass writes `browser-needed.json` (URLs plus the in-page extractor), the session
visits each URL with the MCP tools, records results with `claude-chrome-browser.mjs`, and reruns
with `--browser-results`. Gates: results file must declare the required Chrome profile, the report
is fulfillable only when `runtime.browser_needed` is empty and `browser_provider_preflighted` is
true, and a report crawled with the diagnostics `--website-url-override` is refused.

Measured constraints of the claude-in-chrome `javascript_tool` (2026-09-21): output capped at
1000 characters per call; a result containing raw query strings or a verification meta is
refused. Hence the compact extractor (allow-listed meta, query-stripped links, bounded text),
chunked reads of 900 characters, and the char/checksum verification on `results add`.

Cost: one browser-escalated URL is roughly 2 + ceil(chars/900) tool calls plus the chunk files.
The Dogwood homepage was 10 chunks. A location with 20+ manifest URLs is a long session; run
the static pass first and decide which held categories are worth the browser.
