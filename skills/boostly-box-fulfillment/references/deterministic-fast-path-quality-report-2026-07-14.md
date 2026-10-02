# Deterministic fast path quality and timing report

Date: 2026-07-14

## Result

The offline regression gate passes without reducing the known-good auto-write set. Across the six pinned discovery reports, the deterministic planner retains 15 high-confidence writes and 8 existing verified links, while holding six intentionally unsafe/review-only decisions. The seventh case, Small Town Tavern, pins exact 10-badge creation/readback and branding edge-cleanup evidence.

No live V2, Slack, Notion, or fulfillment mutation was run. The heartbeat remains paused.

## Fixed corpus

- River Grille: five safe writes retained; challenge semantics and official logo/palette pinned.
- Taste of Beauty: Instagram, Facebook, and Menu retained; challenged Ordering/Order, undated Events, and Gift Cards held.
- Paolo's: zero new writes; offline/low-resolution/descriptor branding flags pinned.
- Small Town Tavern: requested/created/after badge counts remain exactly 10; original border dust fails and cleaned assets pass.
- The Goldfinch: Menu and Careers retained; undated Events held; authored orange `#c05700` pinned.
- Piloni's Brazil: existing Facebook, Order, and Menu retained; Gift Cards held; 15-badge historical contract pinned.
- Piloni's Terre Haute: Instagram, Ordering, Order, Menu, and Careers retained; exact human-supplied logo SHA-256 and Restaurant identity pinned.

Every source report/manifest is SHA-256 pinned in `fixtures/deterministic-fast-path-corpus.json`. Fixture drift fails before semantic assertions run.

## Timing

Historical live baseline from the Notion brief: approximately 25–30 minutes per typical location. There was no trustworthy per-stage historical telemetry, so no stage-level speedup is claimed.

Pre-change offline baseline:

- discovery: 3 tests, about 193 ms
- verifier: 1 test, about 206 ms
- settings: 1 test, about 77 ms
- branding: 4 tests, about 93 ms

Current deterministic-plan microbenchmark (1,000 in-memory Small Town Tavern preparations):

- exact location match: median 0.005 ms, p95 0.013 ms, max 0.826 ms
- plan build/dedupe: median 0.002 ms, p95 0.008 ms, max 1.312 ms

New production-shaped reports expose timers/counters for Slack parse, production read, official-site crawl, external search, candidate verification, branding evidence, plan build, production apply/readback, and artifact generation. A meaningful end-to-end after number requires a supervised non-mutating run with real network/browser/cache conditions; this engineering task intentionally did not manufacture one from live production.

## Verification performed

- 7-case immutable regression corpus: pass
- validator outcomes/errors: exact match for all six discovery reports
- safe write/preserve/hold decisions: pass
- branding palette, flags, exact-logo hash, and mechanical-QA evidence: pass
- unit/replay/idempotency/golden-output suites across fulfillment, discovery, verifier, settings, and branding: pass
- 37 total tests after the final safety review: pass
- unresolved deterministic candidate ties are held outside the write plan: pass
- unknown/incomplete Fable production palette roles fail validation: pass
- the retired legacy processor contains no direct-SQL mutation or Slack-posting implementation:
  pass
- TypeScript no-emit check for all relevant `.ts` files: pass
- `git diff --check`: pass

The required code-simplifier passes ran only after behavior was proven. They reduced redundant
validation/argument-handling and repeated object parsing in nine scoped files without changing
the contracts; the full suite and TypeScript check were rerun afterward.

The older 20-location replay suite is quarantined, not counted as evidence: all 20 website fixture hashes are missing after seed-path drift, and its idempotence run additionally contains one known Diego false positive. Treating that suite as a recall score would be misleading. The named immutable corpus replaces it as the release gate until those fixtures are re-recorded intentionally.

## Residual risk

- Full live wall-clock/resource improvement is unmeasured while the heartbeat is paused.
- External sites and provider challenges can change; those paths fail to holds/model exceptions rather than silent writes.
- The first supervised run must inspect structured plan JSON, effective production readback, Fable flags, proof parity receipt, link-tree screenshot, and generated Slack/Notion artifacts before the heartbeat is considered for resumption.
