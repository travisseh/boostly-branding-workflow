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
