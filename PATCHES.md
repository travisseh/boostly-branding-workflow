# PATCHES: every change made to the copied skills and agents

The files under `skills/`, `agents/`, and `tools/` are copies of Travisse's `~/.claude/skills`, `~/.claude/agents`,
and `~/.claude/tools` taken on 2026-10-02 and resynced from the live copies on 2026-10-12 (see the last section). Logic is unchanged. Each entry below is one anchored text replacement
(the patch script refused to run when an anchor matched anything but once). Line numbers are in the patched copy.
Env variables referenced here are documented in `setup/env.example`; every one keeps the old value as its default
so the copy still runs on Travisse's machine unchanged.

## Code patches (45)

| File | Line | Change |
|---|---|---|
| `skills/v2-database/src/v2-db.ts` | 7 | env file candidates: the shared boostly-branding .env first, then ~/.config/boostly/v2-db.env; Travisse-only paths dropped |
| `skills/v2-database/src/v2-db.ts` | 120 | error text points at the new env file |
| `skills/boostly-box-fulfillment/scripts/paths.ts` | 18 | shared heartbeat state root from BOOSTLY_HEARTBEAT_ROOT (default: <run root>/heartbeat, set by setup.sh); old value kept as fallback |
| `skills/boostly-box-fulfillment/scripts/paths.test.ts` | 28 | test follows the env override |
| `skills/boostly-box-fulfillment/scripts/publish-v2-fulfillment-review.ts` | 11 | Notion wrapper path from NOTION_WRAPPER or $HOME (setup.sh installs setup/bin/notion-ai-ntn.sh there when missing) |
| `skills/boostly-box-fulfillment/scripts/publish-v2-batch-review.ts` | 43 | same as above |
| `skills/boostly-box-fulfillment/references/location-resolve.sql` | 7 | doc comment: canonical skills path |
| `skills/boostly-instore-link-settings/scripts/boostly-links.ts` | 36 | badge receipt ledger under BOOSTLY_HEARTBEAT_ROOT; old value kept as fallback |
| `skills/boostly-signage-sheets/scripts/lib/v2-reads.mjs` | 11 | v2-db resolved relative to the skills root (sibling skill), not the ~/.codex mirror |
| `skills/boostly-signage-sheets/scripts/post-review.mjs` | 24 | same |
| `skills/boostly-signage-sheets/scripts/post-review.mjs` | 131 | Slack token from SLACK_USER_OAUTH_TOKEN (the env file) before the slack-tools config.json |
| `skills/boostly-signage-sheets/scripts/find-calls.mjs` | 35 | AskElephant search script resolved as a sibling skill |
| `skills/boostly-signage-sheets/scripts/plan.mjs` | 29 | BOOSTLY_V2_API_BASE / BOOSTLY_V2_API_KEY read from the shared env file (was a Travisse-only project .env) |
| `skills/boostly-brand-design/scripts/decrypt-boostly-cookie.mjs` | 26 | Chrome profile directory from BOOSTLY_CHROME_PROFILE (her Boostly.com profile), default unchanged |
| `skills/boostly-brand-design/scripts/gates.ts` | 80 | run root from BOOSTLY_RUN_ROOT |
| `skills/boostly-brand-design/scripts/variant-sheet.mjs` | 696 | error text names BOOSTLY_REPO_DIR |
| `skills/boostly-brand-design/scripts/fetch-searchapi-brand-environment.ts` | 52 | SEARCHAPI_API_KEY from the shared env file (or ~/.config/searchapi.env) |
| `skills/boostly-brand-design/scripts/fetch-google-place-photos.mjs` | 10 | GOOGLE_PLACES_API_KEY from the shared env file |
| `skills/boostly-brand-design/scripts/tinypng-compress.mjs` | 12 | TINYPNG_API_KEY from the shared env file |
| `skills/boostly-brand-design/scripts/imagegen-knockout.mjs` | 39 | $HOME instead of the literal home |
| `skills/boostly-brand-design/scripts/render-badge-pdf.sh` | 15 | Boostly repo from BOOSTLY_REPO_DIR |
| `skills/boostly-brand-design/harness/iterate-logo-rules.mjs` | 366 | REPLICATE_API_TOKEN fallback file is the shared env file |
| `skills/boostly-brand-design/scripts/branding-feedback.ts` | 18 | feedback ledger under the canonical skills root (git-ignored, created on first write) |
| `skills/boostly-link-discovery/scripts/discover-links.mjs` | 39 | GOOGLE_PLACES_API_KEY from the shared env file |
| `skills/boostly-link-discovery/scripts/discover-links.mjs` | 2252 | Playwright from the harness node_modules (installed by setup.sh) or BOOSTLY_PLAYWRIGHT_MODULE |
| `skills/boostly-link-discovery/scripts/codex-discovery-handoff.mjs` | 28 | Codex transport paths from env or $HOME (Codex is optional; the discovery-transport agent is the fallback) |
| `skills/boostly-link-discovery/scripts/dataforseo-credentials.mjs` | 3 | DataForSEO login from DATAFORSEO_LOGIN |
| `skills/boostly-link-discovery/scripts/dataforseo-credentials.mjs` | 6 | DataForSEO password from DATAFORSEO_PASSWORD before the macOS keychain item |
| `skills/boostly-link-verifier/lib/verify-core.mjs` | 12 | Playwright from the harness node_modules or BOOSTLY_PLAYWRIGHT_MODULE |
| `skills/boostly-google-profile-links/scripts/google-profile-public-snapshot.sh` | 62 | GOOGLE_PLACES_API_KEY from the shared env file |
| `skills/boostly-google-profile-links/scripts/google-profile-public-snapshot.sh` | 10 | doc text |
| `skills/boostly-google-profile-links/scripts/dataforseo-business-info-snapshot.sh` | 43 | DataForSEO credentials from the shared env file first; legacy Travisse-only sources kept as fallbacks |
| `skills/askelephant/scripts/search_meetings.py` | 36 | ASKELEPHANT_* keys from the shared env file |
| `skills/boostly-review-queue/scripts/notion-client.mjs` | 14 | Notion token from the shared env file before the wrapper script |
| `setup/launchd/launchd-refresh.sh` | 9 | launchd wrapper: HOME resolved for the current user |
| `agents/fulfill-location.md` | 19 | agent working directory is the configured run root |
| `agents/closeout-location.md` | 19 | agent working directory is the configured run root |
| `agents/closeout-finish.md` | 16 | agent working directory is the configured run root |
| `agents/discovery-transport.md` | 21 | agent working directory is the configured run root |
| `agents/fulfill-location.md` | 110 | heartbeat location from env |
| `agents/closeout-location.md` | 21 | heartbeat location from env |
| `skills/boostly-print-handoff/scripts/lib/common.mjs` | 11 | FIGMA_TOKEN fallback file is the shared env file (BOOSTLY_BRANDING_ENV_FILE override), not Travisse's workspace .env |
| `skills/boostly-print-handoff/scripts/lib/common.mjs` | 58 | error text names that file |
| `skills/boostly-print-handoff/scripts/draft-email.mjs` | 13 | gmail-tools CLI from GMAIL_TOOLS_DIR (default ~/.config/gmail-tools) |
| `skills/boostly-print-handoff/scripts/lib/drive.mjs` | 9 | google-tools auth.js from GOOGLE_TOOLS_DIR (default ~/.config/google-tools) |

## Added behaviour (not a path fix, reviewed separately)

- `skills/v2-database/src/v2-db.ts`: new MCP read backend. When `BOOSTLY_ADMIN_MCP_KEY` is set and `V2_DB_HOST` is not,
  `query`, `doctor`, `conn-info`, and the named reports send the SQL to the Boostly admin MCP `run_read_query` tool
  (JSON-RPC `tools/call` over HTTPS, `Authorization: Bearer`). `--json` prints the same row array psql mode printed;
  plain mode prints `|`-separated rows; `--csv` prints CSV; `--limit` maps to `max_rows` (cap 5000). The psql replica
  path is untouched and still wins when `V2_DB_*` are set. The read-only SQL guard and the write refusal still apply
  before the request leaves the machine. Verified on 2026-10-02: doctor, JSON query, plain query, write refusal.
  Differences from the replica: 5 s statement timeout, 1000-row default cap, credential tables blocked, no psql
  `\d`-style output. The named commands became async (`Promise<void>`) so one `main()` awaits either backend.
- `skills/message-me/scripts/message_me.py`: replaced by a stub. The original texts Travisse over his iMessage bridge
  (`~/.config/imessage-tools`). The stub appends the message to `$BOOSTLY_RUN_ROOT/inbox/messages.log` and prints a
  one-line notice to stderr; callers (`preflight-fulfillment-batch.ts`, `notify-fulfillment-review.ts`) see exit 0.
- `setup/bin/notion-ai-ntn.sh`: a reimplementation of the private `~/.config/notion-tools/notion-ai-ntn.sh` wrapper
  (which could not be copied: it embeds a token). Same command surface for `whoami`, `search`, `read`, `create-page`,
  `edit`, `append`, `create`; token from `NOTION_API_TOKEN` or the env file; Notion REST API directly, no `ntn` CLI.
  Not reimplemented: `find-output`, `read-markdown`, `patch-markdown`, `embed`, `htmlblock`, `clear`, `tags`, `type`,
  `source`. `notion-image-upload.js` (used by `boostly-review-queue/notion-client.mjs` only as a reference) is not
  needed: notion-client.mjs has its own uploader. Verified read-only on 2026-10-02 (whoami, search, read).
- `setup/launchd/launchd-refresh.sh` and `build-checklist.py`: copied from Travisse's run root `checklist/` folder
  (they are not part of any skill); HOME patched as listed above.

## Documentation substitutions (17 files)

Bulk text replacement in `.md` files only (SKILL.md, references, agents); no code. Applied in this order:
`/Users/travisse/.codex/skills/` and `~/.codex/skills/` -> `~/.claude/skills/`; `/Users/travisse/.claude/skills/` ->
`~/.claude/skills/`; the spike project dir -> `$BOOSTLY_RUN_ROOT`; `/Users/travisse/Programming/boostly-worktrees` ->
`$HOME/Programming/boostly-worktrees`; `/Users/travisse/Programming/boostly` -> `$BOOSTLY_REPO_DIR`.

| File | Replacements |
|---|---|
| `skills/askelephant/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x8; /Users/travisse/Programming/boostly -> $BOOSTLY_REPO_DIR x1 |
| `skills/boostly-box-fulfillment/ARCHITECTURE.md` | ~/.codex/skills/ -> ~/.claude/skills/ x1; /Users/travisse/Programming/projects/brand-design-spike-2026-07-06 -> $BOOSTLY_RUN_ROOT x1 |
| `skills/boostly-box-fulfillment/SKILL.md` | ~/.codex/skills/ -> ~/.claude/skills/ x2 |
| `skills/boostly-box-fulfillment/references/link-automation-port-2026-09-21.md` | ~/.codex/skills/ -> ~/.claude/skills/ x1 |
| `skills/boostly-brand-design/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x1; /Users/travisse/Programming/projects/brand-design-spike-2026-07-06 -> $BOOSTLY_RUN_ROOT x1; /Users/travisse/Programming/boostly -> $BOOSTLY_REPO_DIR x1 |
| `skills/boostly-brand-design/harness/dev-page/README.md` | /Users/travisse/.claude/skills/ -> ~/.claude/skills/ x1; /Users/travisse/Programming/boostly -> $BOOSTLY_REPO_DIR x4 |
| `skills/boostly-brand-design/references/feedback-schema.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x2 |
| `skills/boostly-brand-design/references/proof-color-parity.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x2 |
| `skills/boostly-brand-design/references/subagent-prompt-template.md` | /Users/travisse/Programming/projects/brand-design-spike-2026-07-06 -> $BOOSTLY_RUN_ROOT x1 |
| `skills/boostly-fulfillment-qa/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x2 |
| `skills/boostly-google-profile-links/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x2; /Users/travisse/Programming/boostly -> $BOOSTLY_REPO_DIR x4 |
| `skills/boostly-google-profile-links/references/google-api-boundary.md` | /Users/travisse/Programming/boostly -> $BOOSTLY_REPO_DIR x2 |
| `skills/boostly-instore-link-settings/references/derived-contract.md` | /Users/travisse/Programming/boostly -> $BOOSTLY_REPO_DIR x1 |
| `skills/boostly-link-discovery/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x1 |
| `skills/boostly-link-verifier/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x3 |
| `skills/boostly-print-handoff/SKILL.md` | working directory /Users/travisse/Programming -> $BOOSTLY_RUN_ROOT; FIGMA_TOKEN source is the shared env file; gmail-tools and google-tools paths -> $GMAIL_TOOLS_DIR / $GOOGLE_TOOLS_DIR x3 |
| `skills/message-me/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x2 |
| `skills/v2-database/SKILL.md` | /Users/travisse/.codex/skills/ -> ~/.claude/skills/ x12 |

## Left unchanged on purpose

- The `sharp` fallback `require('/Users/travisse/.cache/codex-runtimes/.../sharp')` in `build-branding-evidence.ts`,
  `logo-quality-gates.ts`, `validate-effective-proof.ts`, `fetch-searchapi-brand-environment.ts`: dead on any other
  machine because the harness `node_modules/sharp` (installed by setup.sh) is tried first.
- `boostly-google-profile-links/scripts/dataforseo-business-info-snapshot.sh` legacy credential sources (two
  Travisse-only project files) remain as fallbacks after the new env-file source.
- Eval and legacy paths in docs (`boostly-link-discovery/SKILL.md` eval CSVs under `~/Documents/Codex`,
  `boostly-link-verifier/SKILL.md` Codex runtime node, `image-generator/SKILL.md` output dir, `v2-database/SKILL.md`
  env path list, `askelephant/SKILL.md` render env, `boostly-brand-design/SKILL.md` TinyPNG env line): historical
  references, not on the fulfillment path. The scripts themselves read the shared env file.
- Agent prose still says "Travisse" for the person who picks and approves; see `docs/BOOTSTRAP.md` for the reading.
- Agent lines "never touch `~/.codex/skills`" stay; there is no Codex mirror on the operator's machine, so they are inert.

## Stripped from the copies

- `boostly-brand-design/harness/node_modules` (48 MB; reinstalled by setup.sh), `boostly-brand-design/feedback/`
  (run ledger with Travisse's review history), `boostly-link-discovery/runs/` (3.1 GB of run outputs and the
  link-evidence cache), `boostly-link-discovery/.local/` (empty), `askelephant/evals/` (13 MB of eval artifacts),
  `image-generator/node_modules` and `image-generator/.env` (a secret), `__pycache__`, `*.bak*`
  (`boostly-instore-link-settings/scripts/boostly-links.ts.bak-2026-09-15`). No file over 5 MB remains.

## Doc patches 2026-10-09: public review site

Text-only edits (no logic change) so the shareable review page is the public site
https://fulfillment-reviews.vercel.app (repo `Boostly/fulfillment-reviews`) instead of the local
127.0.0.1:3917 page or a Claude artifact. Clone path in the copies is `~/Programming/repos/fulfillment-reviews`
and the run root is `"$BOOSTLY_RUN_ROOT"`; the originals name Travisse's paths.

| File | Change |
|---|---|
| `skills/boostly-box-fulfillment/SKILL.md` | "Public review site" section under Finish (publish command, Blob/env facts, one-machine caveat); local review-server bullet says the site is the shareable link |
| `skills/boostly-brand-design/SKILL.md` | `review-canvas.mjs --open` is the operator's own look; the shareable page is the site (script list and rule 2c) |
| `agents/fulfill-location.md` | publish step after the Apple Note refresh; commit carve-out; site URL in the final report |
| `agents/closeout-finish.md` | site rebuild and push after the note refresh in step 8; commit carve-out; site URL in the final report |

## Resync 2026-10-12: live copies refreshed

Every file under `skills/`, `agents/`, and `tools/` was diffed against the live `~/.claude` copy. Files whose
only difference was a patch above were left alone (the patch is still the whole diff). Files the live copy
had changed since 2026-10-02 were copied fresh and the patches above re-applied by anchored single-match
replacement (every anchor still matched exactly once; line numbers above are current):

| File | Live change | Patch re-applied |
|---|---|---|
| `skills/boostly-brand-design/scripts/review-canvas.mjs` | candidate source captions and link verdict chips (displayUrl, candidateSource, linkVerdict, overviewLinkChips), 2026-10-12 | none needed |
| `skills/boostly-brand-design/scripts/review-canvas.test.ts` | tests for the above | none needed |
| `skills/boostly-signage-sheets/scripts/plan.mjs` | to-go label style "A framed QR" (text only, auto-fit headline, togoPromo copy, DISCOUNT_RE normalization), 2026-10-05 | ENV_FILE from the shared env file |
| `skills/boostly-signage-sheets/SKILL.md` | to-go label layout and copy rules | none needed |
| `skills/boostly-box-fulfillment/SKILL.md` | print hand-off paragraph under closeout-finish | ~/.codex -> ~/.claude x2; review-site clone path and `--run-root "$BOOSTLY_RUN_ROOT"` |
| `skills/image-generator/generate-image.ts`, `SKILL.md` | model pinning (gpt-image-2.5-sunburst and Nano Banana 2.1 only, `--provider nanobanana`) | none needed |
| `agents/closeout-finish.md` | step 5b print hand-off, `print-handoff.log`, report line | working directory; review-site path |
| `agents/closeout-location.md` | to-go label paragraph in the Figma step | working directory; heartbeat root |
| `agents/fulfill-location.md`, `agents/discovery-transport.md` | none | re-copied, same patches |
| `skills/boostly-print-handoff/` | NEW skill (2026-10-06): vector PDF export, Drive upload, summary row, Gmail draft with cc | the four code rows and the doc row above |

`skills/v2-database/src/v2-db.ts` and `skills/message-me/scripts/message_me.py` keep the package versions (MCP
backend, inbox stub): the live copies had not changed. The print hand-off depends on two CLIs that are NOT in
this repo (`gmail-tools/gmail.js` with the `draft --cc` flag of 2026-10-12, and `google-tools/auth.js`); the
env file points at them with `GMAIL_TOOLS_DIR` and `GOOGLE_TOOLS_DIR`, and `setup.sh --check` warns when they
are missing. `FIGMA_TOKEN` was added to the env file for the REST export.

## Resync 2026-10-12 (second pass, after b83ae60): live copies refreshed again

Diffed every skill dir and the four agents against the live `~/.claude` copies again; four files had changed
live since the morning resync and were copied fresh, with the patches above re-applied by anchored single-match
replacement. `references/drive-master.json` in boostly-print-handoff differed only by mtime (byte-identical).

| File | Live change | Patch re-applied |
|---|---|---|
| `skills/boostly-brand-design/scripts/review-canvas.mjs` | variant sheet image loads eagerly and is cache-busted by file mtime; `links.rejected` rows from run.json beat the report for the same category; `approvedWebsiteSwap` helper so an approved website swap shows as the ready website row and in the page subtitle | none needed |
| `skills/boostly-brand-design/scripts/review-canvas.test.ts` | test for `approvedWebsiteSwap` and the swap row (11 tests pass on the live copy; the package copy needs the harness `node_modules/sharp` from setup.sh) | none needed |
| `skills/boostly-print-handoff/scripts/draft-email.mjs` | short email body (no file list, no vector-PDF explanation, no closer) | GMAIL_TOOLS_DIR for the gmail-tools CLI |
| `skills/boostly-print-handoff/SKILL.md` | short-body rule; `drafts list` / `drafts delete` commands for stale drafts (delete only ids recorded in handoff.json) | working directory; FIGMA_TOKEN source; gmail-tools and google-tools paths x4 |

The gmail-tools CLI the operator receives from Travisse must be the 2026-10-12 build or later: `draft --cc`,
`drafts list`, and `drafts delete`.

## 2026-10-12 (second resync, evening)

- `skills/boostly-print-handoff/scripts/drive-upload.mjs`: copied from live. Requires only the sheet kinds export-sheets.mjs found (zero-table locations), records `drive.not_included_kinds`.
- `agents/closeout-finish.md`, `agents/fulfill-location.md`: review-site rebuild uses `--limit 0 --slug <RUN_DIR name>` (limit 25 rewrote every page and concurrent builds dropped pages from the manifest). Package path patches on those lines kept.

- `tools/google-cli/google-tools/auth.js` line 32: the `boostly` login hint reads `BOOSTLY_GOOGLE_EMAIL` (another operator's address) before Travisse's default.
- `tools/google-cli/` added 2026-10-12: copies of ~/.config/gmail-tools (gmail.js, package.json, package-lock.json), ~/.config/google-tools (auth.js, google.js), ~/.config/google-calendar-tools (calendar.js) plus install.sh. No tokens, no keys.

## 2026-10-13: client-side card, sticker and signage previews

Live copies refreshed for the change Travisse approved on 2026-10-13 (review previews stop being Playwright
screenshots of the Boostly app). Copied from `~/.claude/skills/boostly-brand-design` and `~/.claude/agents`:

| File | Live change | Patch re-applied |
|---|---|---|
| `skills/boostly-brand-design/templates/sheet-templates.js` | NEW: vendored badge card (boostly `generate-badge-html.ts` @ 8bf7a2e), sticker mock, POP tile, signage row, sheet montage, compare view; pure functions of JSON, Node + browser | none |
| `skills/boostly-brand-design/scripts/render-preview.mjs` | NEW: the one in-memory raster path (Playwright `setContent`, relative paths served from disk, no server) | none |
| `skills/boostly-brand-design/scripts/signage-preview.mjs` | NEW: `review/signage-preview-<L>.json` spec per cell (`--png` for the raster) | none |
| `skills/boostly-brand-design/scripts/variant-sheet.mjs` | schema 3 `view` per cell, `variant-sheet.html` instead of per-cell PNGs, `--raster`, `render --cell`, `--url-base` ignored; the harness is gone | the line-696 `BOOSTLY_REPO_DIR` error-text patch no longer applies (the HARNESS DOWN message was removed) |
| `skills/boostly-brand-design/scripts/review-canvas.mjs` | sheet, default cell and signage previews drawn from templates; `--png` (opt-in tall PNG), `--no-record`; on-page select + compare; `review/sheet-templates.js` copied next to the page | none needed (`REVIEW_CANVAS_CHROME_LIVE` block identical) |
| `skills/boostly-brand-design/harness/mockups/ai-mockup.mjs` | renders missing card/sticker/POP tiles and the signage raster on demand (`variant-sheet.mjs render`, `signage-preview.mjs --png`) | none (`$HOME` form kept) |
| `skills/boostly-brand-design/scripts/variant-sheet.test.ts`, `scripts/sheet-templates.test.ts` | HTML-sheet tests; template and JSON-contract tests (143 tests pass on the live copy) | none |
| `skills/boostly-brand-design/SKILL.md` | script list, rules 2/2b/2c/2d, workflow step 1 | `$BOOSTLY_RUN_ROOT`, `$BOOSTLY_REPO_DIR` substitutions untouched (hunks applied in place) |
| `agents/fulfill-location.md`, `agents/closeout-location.md` | canvas step says no dev server; signage preview via `signage-preview.mjs` | working directory and heartbeat patches untouched (hunks applied in place) |
| `setup/setup.sh`, `setup/env.example`, `docs/BOOTSTRAP.md` | Boostly repo + :3457 harness are WARN / optional (close-out proofs only) | package-only |

## 2026-10-13 (evening): sticker and POP previews match the Figma templates

Travisse reviewed the client-side previews and asked for the sticker and POP tiles to be EXACTLY the Figma
signage output (font sizes, rounded QR, thin divider touching the band). Copied from
`~/.claude/skills/boostly-brand-design`:

| File | Live change | Patch re-applied |
|---|---|---|
| `skills/boostly-brand-design/templates/sheet-templates.js` | sticker and POP tiles rebuilt on the measured In-Store-Fulfillment-8 template geometry (900x900 sticker, 1500x2100 POP, Figtree 500/600, 7px divider, QR 359/675); `styledQrSvg` (plan.mjs generateStyledSvgQR verbatim), `mockQrModules`, `FONT_LINK_HTML` (Figtree from Google Fonts), full POP legal line | none |
| `skills/boostly-brand-design/scripts/variant-sheet.mjs` | `signageCopy` (plan.mjs specificOfferCopy port), `qrModules` (qrcode ECC M), `loadQrLinks` / `ensureQrLinks` (signage/plan.json, then a read-only V2 `touchpoints/signage` GET cached in `variants/touchpoint-links.json`); cell views carry `sticker.qr`, `sticker.layout`, `pop.body`, `pop.qr` | none needed: the V2 env lookup reads `BOOSTLY_BRANDING_ENV_FILE`, then `~/.config/boostly-branding/.env` (BOOSTLY_V2_API_BASE / BOOSTLY_V2_API_KEY, already in env.example), before Travisse's service env |
| `skills/boostly-brand-design/scripts/review-canvas.mjs` | Figtree font link in the page head | none |
| `skills/boostly-brand-design/scripts/sheet-templates.test.ts` | template geometry, QR, copy tests; the byte-identical master check reads `$BOOSTLY_RUN_ROOT` and skips when the Slice run is absent | none (env-aware upstream) |
| `skills/boostly-brand-design/SKILL.md` | templates entry documents the measured geometry, copy, QR source and the overlay diff | applied as a patch; substitutions untouched |

Overlay diff against the Figma 2x REST renders of Slice of the 80's: sticker 1.5%, POP 0.9% of pixels
(edge anti-aliasing), down from 14.8% and 9.0%. 144 skill tests pass on the live copy.

## 2026-10-13: status board on the review site (resync)

Travisse: statuses live on https://fulfillment-reviews.vercel.app, not in Notion or an Apple Note. Resynced from the live copies: `agents/closeout-finish.md` (step 7 writes `review/status.json` with `review-status.mjs`, no Notion), `agents/closeout-location.md` (interim `waiting` status, board publish, page publish after the Figma build), `agents/fulfill-location.md` (board publish instead of the Apple Note), `skills/boostly-box-fulfillment/SKILL.md` ("Status board on the review site"; "Review checklist" marked retired), `skills/boostly-box-fulfillment/scripts/review-checklist.py` (`--publish-status` uploads the public-safe board to Blob; `--note` opt-in), new `skills/boostly-brand-design/scripts/review-status.mjs`, `setup/launchd/launchd-refresh.sh` (publishes the board, keeps the portable HOME line), `docs/BOOTSTRAP.md` section 10, `setup/env.example` (`BOOSTLY_REVIEWS_REPO_DIR`; Notion optional). No code patch beyond the live copies.

## 2026-10-14: doctor no longer requires Notion

- `setup/setup.sh`: `NOTION_API_TOKEN` moved from the required list to the optional list; the Notion wrapper shim
  check is a WARN, not MISSING. Karissa's doctor reported it MISSING although nothing in the review workflow reads
  Notion since 2026-10-13 (`closeout-finish` step 7 writes `review/status.json` through `review-status.mjs`).

## 2026-10-14: print hand-off sends the vendor email

- `skills/boostly-print-handoff/scripts/draft-email.mjs`: after creating the Gmail draft it runs `gmail.js drafts send`
  and records `draft.sent`, `sent_at`, `message_id`; an unsent recorded draft is sent on rerun, never twice; `--no-send`
  keeps the old draft-only behaviour. `print-handoff.mjs` forwards `--no-send` and reports `email_sent`.
- gmail-tools (shared out of band, not in this repo) gained `drafts send <account> <draftId>`; the doctor checks for it.
- `agents/closeout-finish.md` step 5b and `skills/boostly-box-fulfillment/SKILL.md` wording updated.

## 2026-10-14: preserve postal codes in the print summary

- `skills/boostly-print-handoff/scripts/drive-upload.mjs` and `scripts/lib/drive.mjs`: replace whole-sheet
  CSV conversion with a single-row Sheets API update using `valueInputOption=RAW`. Postal codes stay literal
  strings (including leading zeroes); quantities stay numeric. New sheets use the same typed write.
- Verify returned values and types before continuing the handoff; refuse ambiguous headers, duplicate
  row keys, or numeric postal input. Existing rows, extra columns, other tabs and formatting are preserved.
- Keep the package's `GOOGLE_TOOLS_DIR` configuration. No extra OAuth scope is needed beyond Drive.
- `scripts/lib/drive.test.mjs`: 19 offline regression tests for create, update, append/retry, leading-zero
  ZIPs, ZIP+4, alphanumeric postal codes, numeric counts, preserved cells and failed readback.
  Run `node --test skills/boostly-print-handoff/scripts/lib/drive.test.mjs` from the repo root.
- This prevents future export corruption. Historical postal-code corrections still require checking
  the authoritative source; never guess or pad an already-numeric value.

## 2026-10-14: run-progress: resume state on the review site Blob store

- New `skills/boostly-brand-design/scripts/run-progress.mjs` (copied from the live skill, no package patch):
  `set --run <dir> --stage <intake|fulfill|review|closeout|closeout-finish|done> --last "<step done>" --next "<next step>"
  [--blocked-on "<what Travisse owes>" | --clear-blocked] --by <agent>` writes `<dir>/review/progress.json` and publishes
  `status/<slug>.json` plus a small bundle (run.json with ship-to and contact fields redacted, review JSON, root .md
  handoff files with address-looking lines dropped, candidates, variants JSON, signage shots, the images run.json
  points at; secret-looking files refused) to the Vercel Blob store the review site uses (token from the
  fulfillment-reviews clone's `.env.local`, or `BLOB_READ_WRITE_TOKEN` in the env). `get`, `publish`, `list`,
  `resume --slug`, `pull --slug --run-root` let a fresh agent on another machine continue from `next_step`.
- `agents/fulfill-location.md`, `agents/closeout-location.md`, `agents/closeout-finish.md`: resynced from the live
  copies. Each gained a resume rule at startup (no `run.json` here: `resume`, then `pull`, continue from `next_step`,
  never re-run a done stage; fulfill starts over when Blob has nothing, closeout and finish stop and report), a
  `run-progress.mjs set` stamp at each step boundary, and a hard rule that progress text never carries ship-to data,
  cookies, or tokens and that a failed publish (missing Blob token) is reported, not retried. `discovery-transport.md`
  is unchanged (it has no stage boundary of its own; the fulfill agent stamps around it) and keeps its package-only
  working-directory patch.
- `skills/boostly-box-fulfillment/SKILL.md` ("Status board on the review site": progress per run, resume on another
  machine), `skills/boostly-brand-design/SKILL.md` (script list: `review-status.mjs`, `run-progress.mjs`),
  `skills/boostly-box-fulfillment/scripts/review-checklist.py` (folds `review/progress.json` into the published
  board as `progress`): resynced from the live copies, no package patch.
- `docs/BOOTSTRAP.md`: section 14 "Resuming a location from another machine"; section 9 checklist line for
  `BLOB_READ_WRITE_TOKEN`; section 0 note that the Chrome profile name the extension reports must be exactly
  `Boostly.com` (rename the profile or connect the extension in it; the fix is on the operator's machine).
- `SUBAGENT_BRIEF.md` now ships in `skills/boostly-brand-design/` (the live brief moved into the skill on 2026-10-14;
  the project-root copy is a pointer), so `~/.claude/skills/boostly-brand-design/SUBAGENT_BRIEF.md` exists after
  `setup.sh`. `references/subagent-prompt-template.md` now points there on both machines, so its earlier
  `$BOOSTLY_RUN_ROOT/SUBAGENT_BRIEF.md` doc substitution is superseded and dropped. The brief is byte-identical to
  the live copy; its one `/Users/travisse/Programming/boostly` mention reads as `$BOOSTLY_REPO_DIR` here.

## 2026-10-14: Slack bot token instead of per-operator user tokens

- `setup/env.example`, `docs/BOOTSTRAP.md`: `SLACK_USER_OAUTH_TOKEN` now carries the shared xoxb bot token of the
  "Boostly Fulfillment Notifications" app (scopes chat:write, files:write, channels:history, channels:read, users:read,
  files:read; bot already in #boosted-box-requests). No code change: aos-slack and post-review.mjs send the token as
  a bearer either way, and post-review's thread scan already matches bot replies (`m.bot_id`).

## 2026-10-14: Chrome profile name compares case-insensitively

- `skills/boostly-link-discovery/scripts/validate-discovery-report.mjs` (mirrored) and `discover-links.mjs` (patched in place,
  keeps the package env-path and Playwright-module patches): the three profile checks lowercase both sides. Karissa's
  profile is spelled `boostly.com`; it no longer has to be renamed.

## 2026-10-14: agent working-directory patch restored

- `agents/fulfill-location.md`, `closeout-location.md`, `closeout-finish.md`: the working directory is `$BOOSTLY_RUN_ROOT` again and the
  review-site rebuild cds into `${BOOSTLY_REVIEWS_REPO_DIR:-$HOME/Programming/repos/fulfillment-reviews}`. An earlier resync had
  copied Travisse's literal paths over these lines. Re-apply after every mirror of the agents (diff the package copy before copying).

## 2026-10-14: Chrome profile fallback via Local State when the extension reports no profile name

- `skills/boostly-link-discovery/scripts/discover-links.mjs` (patched in place, keeps the package env-path and
  Playwright-module patches), `claude-chrome-browser.mjs`, `validate-discovery-report.mjs`, new
  `chrome-profile-fallback.test.mjs` (mirrored): the extension profile-name match stays the first path. When no
  connected browser reports a profile name, the run may go on only when exactly one connected browser is on this
  computer AND Chrome's `Local State` has exactly one profile named Boostly.com (any casing) at the
  `BOOSTLY_CHROME_PROFILE` directory when set. `results init` takes `--profile-source local-state` with
  `--browsers <list_connected_browsers.json>` or `--device-id`; `profile probe` prints the Local State profiles.
  `chrome_profile_resolved` stays the canonical `Boostly.com`; the new `chrome_profile_resolution` object records
  the method, directory, Local State name, device id, and browser label. The validator requires the device id and
  directory for the fallback method.
- `agents/discovery-transport.md`, `agents/fulfill-location.md`: step 1 profile check with both paths; the
  `$BOOSTLY_RUN_ROOT`, reviews-repo, and `$BOOSTLY_HEARTBEAT_ROOT` package lines kept.
- `docs/BOOTSTRAP.md` section 0: the fallback requirement (single profile named Boostly.com, env directory set).

## 2026-10-14: Figma target rotated to In-Store-Fulfillment-9

- `skills/boostly-signage-sheets/references/figma-target.json` (mirrored): new signage sections go to
  In-Store-Fulfillment-9 (key `5LsXaingsVCdMuJhWzR0g3`, page `0:1`, template section `1:2` at row 0 col 0, grid
  unchanged). File 8 (`N5uzBBdCz7ySxxaNTxfKGm`) moved to `previous_files`, read-only from 2026-10-14; run.json
  figma blocks built in File 8 still point there. The File 9 template was rebuilt from the File 8 REST dump and
  proved identical by structural hash (12355 nodes counting the section) with the stroke gate passing.

## 2026-10-14: Ad hoc requests auto-fulfill when branding and store details are complete

- `skills/boostly-box-fulfillment/scripts/adhoc-fulfillment.ts` (new, mirrored) and `adhoc-fulfillment.test.ts` (13 tests):
  per open `ad_hoc` request, eligible when the live V2 branding row has a primary logo, the store details are complete
  (ship-to plus the offer for printed items) and, for printed items, a prior completed run with a Figma section exists
  under the run root; then store-details confirm, branding complete, Figma section reuse (or a clone brief for the build
  agent when the table or stall pages differ), the print hand-off limited to the ordered kinds, the one Slack result,
  a `<location>-adhoc-<yyyymmdd>` run dir with `adhoc.json`, the status and progress stamps, the board refresh.
  Otherwise the request is queued for the normal pipeline with a blocked-on stamp and a board note. Dry run by default;
  `--apply` needs `ADHOC_AUTO_APPLY=1` (environment or the shared env file, `BOOSTLY_BRANDING_ENV_FILE`) or `--go`.
  No package patch: the script reads `BOOSTLY_BRANDING_ENV_FILE` and `SLACK_TOOLS_DIR` itself.
- `skills/boostly-box-fulfillment/scripts/list-branding-requests.ts` (mirrored): `--include-ad-hoc` / `--ad-hoc-only`
  listing options; the default pull still excludes ad hoc orders.
- `skills/boostly-box-fulfillment/SKILL.md` (mirrored): run loop step 2b with the `ADHOC_AUTO_APPLY` switch, the
  "Ad hoc orders" rule under Finish (quoting Travisse 2026-10-14), the components table rows.
- `skills/boostly-print-handoff/scripts/export-sheets.mjs`, `print-handoff.mjs`, `SKILL.md` (mirrored): `--kinds`
  exports only the ordered kinds; the sheet_ids cross-check follows the filter.
- `setup/env.example`: `ADHOC_AUTO_APPLY=0`.


## 2026-10-14: "Order placed (email sent)" column on the Print order summary sheet

- Vendor request (Gracie, CK Brands, 2026-10-14): a column with the date each order's email was sent, so no order
  is missed. Column N, header `Order placed (email sent)`, value `YYYY-MM-DD` in Mountain time.
- `skills/boostly-print-handoff/scripts/lib/drive.mjs` (patched in place, keeps the package `GOOGLE_TOOLS_DIR`
  line): new `stampSummaryOrderDate()` and `orderDate()`; the tab lookup moved into a shared `gridSheet()` helper.
  The stamp is keyed on the Drive folder name like the A:M row writer, writes the N1 header once when blank,
  refuses any other N1 text, writes only the keyed row's N cell through `values:batchUpdate` with RAW, and verifies
  the readback. The A:M row writer never touches N, so a blank N means the email has not gone out.
- `skills/boostly-print-handoff/scripts/draft-email.mjs` (mirrored): after a successful `drafts send` the row is
  stamped with the send date; a failure is recorded as `draft.order_placed_error` without losing the send receipt,
  and a rerun stamps any sent draft that has no `draft.order_placed`. `print-handoff.mjs` (mirrored) prints
  `order_placed` in its summary.
- `skills/boostly-print-handoff/scripts/lib/drive.test.mjs` (patched in place, keeps the package fixture names and
  sheet id): fixture serves `A:N` reads and `values:batchUpdate` stamps; four new tests (Mountain-time date, header
  once and keyed row only with A:M untouched, refusals, row writer leaves N alone and the email script stamps after
  the send). 23 tests pass on both copies.
- `skills/boostly-print-handoff/SKILL.md` (mirrored): column list, step 3 stamp behaviour, receipts, test coverage,
  report line. The 15 live rows that predate the column were backfilled from boostly sent mail on 2026-10-14.

## 2026-10-15: Status board publish merges across machines instead of overwriting

- Why: on 2026-10-14 Karissa's launchd job published its local view of `status/checklist.json` and clobbered the
  board (Slice of the 80's, closed out on Travisse's machine with AK, showed "pick a letter" with a dry-run note).
- `skills/boostly-box-fulfillment/scripts/review-checklist.py` (patched identically on both copies; the package copy
  carries no package-only patch): `publish_status` lists the blob, reads it cache-busted (404 or empty is an empty
  board; any other read failure skips the PUT), merges per location (request_id, then run dir, then name) and PUTs.
  Newer wins by progress.updated_at, then review_status.updated_at, then a new per-item `updated_at` (newest mtime of
  run.json, HOLD.md, review/status.json, review/progress.json); a null progress, review_status or figma_url never
  replaces a value; `done` never downgrades; fewer completed steps win only when strictly newer and not a dry run.
  Remote-only items stay while this side's live query is stale and drop when a fresh live query does not list them.
  Each item carries `host` and `request_id`; the payload has a top-level `publishers` map {host: generated_at}. The
  ship-to assertion runs on the merged payload. Dry runs never publish: `BOOSTLY_PUBLISH_STATUS=0` (environment or
  the shared env file, `BOOSTLY_BRANDING_ENV_FILE`) skips the PUT; a run dir with a `DRY_RUN` file or a notes.json
  line starting "Dry run" is left out, and remote "Dry run" items are dropped. `main()` now runs only as a script.
- `skills/boostly-box-fulfillment/scripts/test_review_checklist_publish.py` (new, mirrored): 14 unittest cases, no
  network. `python3 -m unittest discover -s skills/boostly-box-fulfillment/scripts -p 'test_review_checklist_publish.py'`.
- `setup/launchd/launchd-refresh.sh` (patched in place, keeps the portable HOME line): a
  `status published: skipped (BOOSTLY_PUBLISH_STATUS=0` line counts as a good run.
- `skills/boostly-box-fulfillment/SKILL.md` (mirrored): merge rule, dry-run switches, the residual same-minute race
  (the merge is idempotent, so the next 5 minute run heals it). `docs/BOOTSTRAP.md` section 10: both machines may run
  the job once Karissa pulls and reruns `bash setup/setup.sh --force`. `setup/env.example`: `BOOSTLY_PUBLISH_STATUS=`.
- `setup/launchd/build-checklist.py`: unchanged (thin wrapper).

## 2026-10-15: one run dir per request, and "Branding applied" means this location's own write
- `skills/boostly-box-fulfillment/scripts/review-checklist.py` (mirrored from the live copy): `load_runs` no longer
  lets whichever run.json glob listed last win when two run dirs share a request id. New `run_progress` ranks them by
  recorded stages plus pipeline blocks, then a review canvas; the most progressed dir wins. A one-file re-seeded stub
  (surfin-betty-s-burger-bar-downtown-15th-st) had shadowed the real Downtown run on the board.
- Same file: the "Branding applied in prod" step reads this run's own `write.status` (`applied` or
  `applied+inherited`), not the source run's, so a links-only sibling with a held write is not shown as applied.
- The review site repo (fulfillment-reviews, `scripts/build.mjs`) got the matching rule: the page chip says
  "Branding applied" only for those write statuses; a sibling with `write.branding_source_run` otherwise reads
  "Branding: inherits <source> (pending pick)".

## 2026-10-15: third Chrome profile path, a user-confirmed device id

- `skills/boostly-link-discovery/scripts/discover-links.mjs` (patched in place, keeps the package env-path line 40 and
  Playwright-module line 2265), `claude-chrome-browser.mjs` and `chrome-profile-fallback.test.mjs` (mirrored): the
  extension stopped reporting `profileName`, and `list_connected_browsers` now returns `isLocal` and `name`.
  `connectedBrowserRows` and the Codex fallback accept `isLocal: true` as on this computer. New method
  `user-confirmed-device`: `results init --profile-source user-confirmed` reads
  `~/.config/boostly-branding/chrome-confirmed-device.json` (or takes `--device-id --browser-label --confirmed-by
  --confirmed-note`), refuses any device id other than the confirmed one, and with `--browsers` checks the id is
  connected and local. The validator requires `device_id`, `browser_label`, `confirmed_by`, `confirmed_at` for it.
  Four new tests (10 in the file).
- `agents/discovery-transport.md` (adds `select_browser` to its tools), `agents/fulfill-location.md`: step 1 profile
  check gains path c; the `$BOOSTLY_RUN_ROOT`, reviews-repo, and `$BOOSTLY_HEARTBEAT_ROOT` package lines kept.
- `docs/BOOTSTRAP.md` section 0: how an operator writes their own confirmation file with their own device id.

## 2026-10-15: direct signage PDFs without Figma (parity-proven, not yet the default)

- `skills/boostly-signage-sheets/scripts/direct-pdf/` (new, mirrored): `direct-pdf.mjs` builds the location section
  from `references/template-spec.json` (new: the File 9 Munchie template recipe) and renders every Print Sheet frame
  to vector PDF with pdf-lib, into the same six kind files + `_vector-pages/` + `sheets.json` the Figma export
  produces. `lib/retarget.mjs` (clone-head + figma-trim + figma-recopy + fills + stroke gate as JSON transforms),
  `lib/text-layout.mjs` (Figma text engine calibrated on Figma's own PDF text layer), `lib/qr-nodes.mjs` (styled QR SVG
  to the Figma import tree), `lib/pdf-render.mjs` (ICC sRGB fills, even-odd stroke rings, embedded Figtree subsets,
  lossless logos, Apple Color Emoji bitmap), `lib/kinds.mjs`, `lib/fonts.mjs`. `parity.mjs` proves a run against a
  Figma export (page set, geometry vs REST tree, 300 dpi raster diff, text, fonts, QR decode, images, sizes).
  `direct-pdf.test.mjs` (6 tests): `node --test skills/boostly-signage-sheets/scripts/direct-pdf/direct-pdf.test.mjs`.
- `skills/boostly-signage-sheets/references/fonts/` (new): Figtree Medium/SemiBold/Bold (OFL).
- `skills/boostly-print-handoff/scripts/export-direct.mjs` (new) and `print-handoff.mjs --direct` (mirrored): the
  direct render in place of export-sheets.mjs, same handoff.json blocks (`source: "direct"`); refuses a run dir that
  already holds a Figma export unless `--force` (drive-upload updates the vendor's files in place).
- `skills/boostly-brand-design/harness/package.json`: pdf-lib, @pdf-lib/fontkit, fontkit, jsqr. `setup/setup.sh`:
  links the harness node_modules into `~/.claude/skills/boostly-signage-sheets` (plan.mjs and direct-pdf resolve there).
- Both SKILL.md files document the path and the parity numbers (Scoops 3:2 and Pig & Parrot Hoboken 5:2, 2026-10-15:
  0 geometry mismatches, max 0.004 pt; raster 0.06 to 0.28% of pixels at 300 dpi; text identical; QR 22/22 and 36/36).
  Default flow unchanged: closeout still builds the Figma section, the hand-off still exports it.

## 2026-10-15: print-handoff.mjs never touches Drive or email in a dry mode; --direct needs --live
- `skills/boostly-print-handoff/scripts/print-handoff.mjs` (mirrored): the step list is a pure `planSteps(args)`.
  `--offline`, `--dry-run` or `--scratch` stop after the export (no drive-upload, no summary row, no draft-email;
  `--offline` is no longer forwarded to drive-upload.mjs, run that by hand when v2-db is down). `--direct` runs
  drive-upload and draft-email only with an explicit `--live`. Cause: a scratch `--direct --offline` test overwrote
  the six Scoops PDFs in the vendor Drive folder for about 30 s (18:05:35Z to 18:06:03Z) before they were restored.
- `skills/boostly-print-handoff/scripts/print-handoff.test.mjs` (new, mirrored): 4 tests incl. an end-to-end run under
  an empty HOME proving the dry flags make zero Drive calls. `node --test skills/boostly-print-handoff/scripts/print-handoff.test.mjs`.
- `skills/boostly-print-handoff/SKILL.md` (mirrored): the flag text above.

## 2026-10-15: Opus 5.5 pipeline, Fable only for judgment, plus the variant taste pass
- `agents/fulfill-location.md`, `agents/closeout-location.md` (mirrored, package lines kept): `model: opus`. Fable is
  launched only as the nested judgment subagent and for the new taste pass. Step 3 gains the model fallback (a Fable
  rate limit: relaunch the same prompt once on Opus, `validate-fable-decision.ts --judgment-model opus`); new step 4b
  runs the taste pass between the variant sheet and the review canvas and puts its `notes_line` in the checklist note.
- `skills/boostly-brand-design/scripts/taste-pass.mjs` (new, mirrored): `brief` (every real color with its source,
  every existing asset, the sheet, the evidence images, the filled prompt), `validate` (real colors or a darker step
  only, 1.3:1 primary floor, existing pixels or crop/stack/cut_words derivations, dedupe against the live sheet,
  web/print text split, LIGHT GROUND escalation), `apply` (derivations into `taste/assets/`, `gates.ts check` with
  the registry's override rules, `variant-sheet.mjs add-cell`, the `taste` run.json block, the notes line).
  `scripts/taste-pass.test.mjs` (new, mirrored; 11 tests, needs the harness node_modules for sharp):
  `node --test --experimental-strip-types skills/boostly-brand-design/scripts/taste-pass.test.mjs`.
- `skills/boostly-brand-design/references/taste-pass-prompt-template.md` (new, mirrored): the Fable prompt with the
  worked examples (Scoops K-S, Pig & Parrot K/M, Surfin' Betty's E-F) and the output JSON shape.
- `skills/boostly-brand-design/scripts/validate-fable-decision.ts` (mirrored): `--judgment-model fable|opus` recorded
  as `decision.judgment_model` beside the six keys.
- `skills/boostly-box-fulfillment/scripts/run-file.ts` and `references/run-schema.json` (mirrored): the `taste` block.
- Both SKILL.md files (mirrored): rule 2b-taste, the model note, step 8. Scratch proof on copies of three runs: the
  pass proposed Pig & Parrot's black-disc knockout and words-only (his K and M), Scoops' two-tone pinks (his K and L)
  and the stacked lockup (held on ink-retention like his M), and a gold-card swap for Shawarma Inn.
