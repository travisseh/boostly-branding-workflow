# BOOTSTRAP: install the Boostly in-store branding workflow on this Mac

This document is written for Claude Code to execute step by step on the operator's Mac, with Travisse
sitting next to it. Claude: read the whole file first, then run the steps in order. Each step ends with a
CHECKPOINT. At a checkpoint that stores a credential, stop and ask Travisse to confirm before you touch
the file. Never ask anyone to paste a secret into the chat. Never print, cat, echo, log, or commit a
secret, a cookie, a token, or the contents of `~/.config/boostly-branding/.env`. Report every step as
done, skipped, or failed with the output; do not describe a dry run as applied.

The operator in this document is Karissa; the plan this implements is the Boostly Notion page
"Karissa branding workflow handoff plan". The pipeline's own documentation (the SKILL.md files and the
agents) still says "Travisse" for the person who picks the variant letter and approves the signage.
On this machine that person is the operator; Travisse is the escalation point.

## 0. Prerequisites (confirm before anything else)

Ask Travisse to confirm each item; do not proceed with an unconfirmed one.

- [ ] Claude Code installed (`claude --version` works) and signed in with the operator's own Claude
      account (Pro or Team seat). No Anthropic API key is needed.
- [ ] Google Chrome with a profile named `Boostly.com` (any casing, `boostly.com` is fine), signed in to new.boostly.com as the
      operator's own Boostly admin user, and the "Claude in Chrome" extension installed and enabled in
      that profile. The discovery scripts and the validator first check the profile name the
      extension reports (`list_connected_browsers`, `metadata.profileName`); casing does not matter
      since 2026-10-14. The extension may report no profile name at all (the browser shows only as
      "Browser 1"). Then the fallback applies (since 2026-10-14): the ONLY Chrome profile on this Mac
      (`~/Library/Application Support/Google/Chrome/Local State`, `profile.info_cache`) must be named
      `Boostly.com` (any casing) and `BOOSTLY_CHROME_PROFILE` in the env file must be that profile's
      directory (usually `Default`). A second Chrome profile on the Mac, another name, or two
      connected browsers makes the agent stop with `chrome_profile_fallback_refused`; delete or
      rename the extra profile. `node ~/.claude/skills/boostly-link-discovery/scripts/claude-chrome-browser.mjs profile probe`
      prints the profiles (directory and name only). The fix is on this machine, nothing on
      Travisse's side.
      Third path (since 2026-10-15), for a Mac with several Chrome profiles where neither check above
      can pass: a machine-local confirmation file `~/.config/boostly-branding/chrome-confirmed-device.json`
      (mode 0600) naming the one connected browser the operator confirms is their Boostly.com profile.
      The operator creates their own: open Chrome in the Boostly.com profile, have Claude call
      `list_connected_browsers`, take the `deviceId` of that browser (the row with `isLocal: true`
      whose `name` you gave that profile's extension), then write
      `{"device_id": "<that id>", "browser_label": "<its name>", "profile": "Boostly.com",
      "confirmed_by": "<your name>", "confirmed_note": "<one line saying why>", "confirmed_at": "<ISO time>"}`
      with `mkdir -p ~/.config/boostly-branding` first and `chmod 600` after. Agents then select that
      device and run `results init ... --profile-source user-confirmed --browsers <list json>`; any
      other device id is refused. Travisse's device id does not work on Karissa's Mac.
- [ ] Figma desktop app installed and signed in with an account that has edit access to the
      In-Store-Fulfillment file named in `skills/boostly-signage-sheets/references/figma-target.json`.
- [ ] A GitHub account that is a member of the Boostly GitHub org (github.com/Boostly/boostly for the
      badge preview harness, github.com/Boostly/fulfillment-reviews for the public review site). This
      package repo (travisseh/boostly-branding-workflow) is public, so cloning it needs no access.
- [ ] A Vercel account that is a member of the Boostly Vercel team (`boostly`), and the Vercel CLI
      (`npm i -g vercel`, then `vercel login` in the terminal). Needed once, to pull the review site's
      image-upload token (step 9).
- [ ] Travisse has, ready to paste into files himself: the operator's Boostly admin MCP key, the shared Slack bot
      token (Boostly Fulfillment Notifications app), the SearchAPI key, the Google Places
      key, the DataForSEO login and password, and the signage service API key (`BOOSTLY_V2_API_KEY`).
      Optional: AskElephant, TinyPNG, Replicate, OpenAI keys.

CHECKPOINT 0: list which prerequisites are confirmed and which are missing. Missing ones block the step
that needs them, not the whole install.

## 1. Clone this repo

```bash
gh auth status || gh auth login        # interactive, in the terminal, operator's GitHub account
mkdir -p ~/Programming/projects
gh repo clone travisseh/boostly-branding-workflow ~/Programming/projects/boostly-branding-workflow
cd ~/Programming/projects/boostly-branding-workflow && git log --oneline -1
```

If `gh auth login` needs the browser, tell Travisse to run it himself in the terminal (prefix `!` in
Claude Code runs a command in the session). CHECKPOINT 1: the repo is cloned and `git log` shows a commit.

## 2. Run the installer

```bash
cd ~/Programming/projects/boostly-branding-workflow
bash setup/setup.sh
```

It installs Homebrew packages (node, potrace, gh, jq, poppler), npm deps for the brand-design harness
(sharp, playwright, qrcode, tsx) and image-generator, Playwright's chromium, Pillow, an OpenCV venv at
`~/.config/boostly-branding/cvenv`, copies `skills/` to `~/.claude/skills/`, `agents/` to
`~/.claude/agents/`, `tools/apple-notes.py` to `~/.claude/tools/`, creates
`~/.config/boostly-branding/.env` from `setup/env.example` (mode 0600), creates the run root
(`~/boostly-branding/runs`, with `heartbeat/`, `checklist/`, `inbox/`), writes the launchd plist (not
loaded), installs the Notion wrapper shim at `~/.config/notion-tools/notion-ai-ntn.sh`, the review
server command at `~/.config/boostly-branding/bin/boostly-review-server.sh`, and adds one line to
`~/.zshrc` that exports the env file into every shell. It ends with a doctor report. Expect MISSING on
every credential at this point; that is the next section.

If Homebrew is not installed the script starts its interactive installer; let Travisse answer the
prompts. Re-run `bash setup/setup.sh` until the only MISSING lines are env keys and the Boostly repo.
CHECKPOINT 2: paste the doctor summary line and the list of MISSING items.

## 3. Store credentials, one at a time

All credentials live in ONE file: `~/.config/boostly-branding/.env`, mode 0600, owned by the operator.
For each key below: tell Travisse the exact key name and the line to edit, then say this sentence and
wait: "Ask Travisse to paste the value into the file himself; never ask him to paste it into the chat."
Open the file for him with `open -a TextEdit ~/.config/boostly-branding/.env` or let him use
`nano ~/.config/boostly-branding/.env`. After he saves, verify only that the key is non-empty, never its
value:

```bash
grep -cE '^KEY_NAME=.+' ~/.config/boostly-branding/.env   # prints 1 when set
chmod 600 ~/.config/boostly-branding/.env
```

Order (one checkpoint each; stop and ask before each file edit):

1. `BOOSTLY_RUN_ROOT` and `BOOSTLY_HEARTBEAT_ROOT`: keep the defaults unless Travisse wants another folder.
2. `BOOSTLY_CHROME_PROFILE`: the DIRECTORY name of the Boostly.com Chrome profile. Find it without
   printing anything else:
   ```bash
   python3 - <<'EOF'
   import json, os
   p = os.path.expanduser('~/Library/Application Support/Google/Chrome/Local State')
   for d, v in json.load(open(p))['profile']['info_cache'].items():
       print(d, '->', v.get('name'))
   EOF
   ```
   Put the directory (for example `Profile 3`) whose name is `Boostly.com` into the env file.
3. `BOOSTLY_ADMIN_MCP_KEY` (new.boostly.com admin, the operator's own user, MCP/API key). Travisse pastes.
4. `SLACK_USER_OAUTH_TOKEN`: the shared bot token (xoxb) of the "Boostly Fulfillment Notifications" Slack app,
   sent by Travisse with the other keys. Closeout posts appear as that bot. (The name is historical; a personal
   xoxp user token also works.)
5. `NOTION_API_TOKEN`: no longer needed for the review workflow (2026-10-13: statuses live on the
   review site, the Notion review queue is retired). Leave it empty unless Travisse asks for it.
6. `SEARCHAPI_API_KEY`, `GOOGLE_PLACES_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`,
   `BOOSTLY_V2_API_KEY` (and `BOOSTLY_V2_API_BASE` if Travisse says it differs). Travisse pastes each.
7. Optional: `ASKELEPHANT_*`, `TINYPNG_API_KEY`, `REPLICATE_API_TOKEN`, `OPENAI_API_KEY`.
8. `BOOSTLY_REPO_DIR`: where the Boostly app repo will be cloned (step 8).
9. Print hand-off: `FIGMA_TOKEN` (the operator's own Figma personal access token; Travisse pastes),
   `GMAIL_TOOLS_DIR` and `GOOGLE_TOOLS_DIR` (keep the defaults). The gmail-tools, google-tools and
   google-calendar-tools CLIs ship in this repo under `tools/google-cli/` (code only). Install them with
   `bash tools/google-cli/install.sh` (copies to `~/.config/<name>/`, runs npm install). Two things are
   never in the repo: the Google OAuth client keys file, which Travisse sends out of band and you save as
   `~/.config/google-calendar-mcp/gcp-oauth.keys.json` (mode 600), and your own token, which you create once with
   `BOOSTLY_GOOGLE_EMAIL=<your boostly email> node ~/.config/google-tools/google.js add boostly` (sign in with
   your Boostly Google account in the browser). Check with `node ~/.config/gmail-tools/gmail.js drafts list boostly 3`.
   Without them closeout-finish reports the print hand-off as failed and continues.

After each edit: `source ~/.zshrc` (or open a new shell) so the key is exported.
CHECKPOINT 3: list the keys that are set (names only) and the ones still empty.

## 4. Boostly admin cookie decrypt (the operator's Chrome profile)

The settings CLI authenticates with the admin session cookie from the operator's own Chrome profile.
Chrome must be running with the Boostly.com profile signed in. The first run asks macOS Keychain for
"Chrome Safe Storage"; tell Travisse a keychain prompt is expected and he should click "Always Allow"
for `security`.

```bash
CK=$(mktemp -d) && chmod 700 "$CK"
node ~/.claude/skills/boostly-brand-design/scripts/decrypt-boostly-cookie.mjs --out "$CK/admin.cookie"
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links auth check --cookie-file "$CK/admin.cookie" --json
rm -rf "$CK"
```

`auth check` must report the operator's own admin user. If it reports someone else or fails, the
profile directory in `BOOSTLY_CHROME_PROFILE` is wrong or the profile is not signed in. Never print the
cookie file. CHECKPOINT 4: auth check result (user name only).

## 5. Boostly reads: v2-db through the admin MCP

There is no personal replica database user. `~/.claude/skills/v2-database/bin/v2-db` routes read-only
SQL through the Boostly admin MCP server's `run_read_query` tool using `BOOSTLY_ADMIN_MCP_KEY` (5 second
statement timeout, 1000 rows by default, 5000 max, credential tables blocked, every query audited under
the operator's user).

```bash
~/.claude/skills/v2-database/bin/v2-db doctor
~/.claude/skills/v2-database/bin/v2-db query --json --sql "select id, name from locations order by created_at desc limit 3"
```

CHECKPOINT 5: doctor prints `"mode": "mcp"` and the query returns rows.

## 6. Register the Boostly admin MCP server in Claude Code

Mirror of the registration on Travisse's machine: user scope, HTTP transport, URL
`https://new.boostly.com/api/mcp`, one header `Authorization: Bearer <key>`. Read the key from the env
file inside the shell; do not type it into the command or the chat:

```bash
set -a; . ~/.config/boostly-branding/.env; set +a
claude mcp add --transport http --scope user boostly-admin "$BOOSTLY_ADMIN_MCP_URL" \
  --header "Authorization: Bearer $BOOSTLY_ADMIN_MCP_KEY"
claude mcp list | grep boostly-admin
```

Restart Claude Code afterwards so the tools (`run_read_query`, `get_location`, `search_accounts`, and
the rest) load. CHECKPOINT 6: `claude mcp list` shows boostly-admin as connected.

## 7. Figma MCP plugin

```bash
claude plugin install figma@claude-plugins-official
```

Then in a Claude Code session run `/mcp`, choose the figma server, and authenticate in the browser with
the operator's Figma account. There is no key to store. Verify with the `whoami` tool of the Figma MCP
or `claude mcp list` showing `plugin:figma:figma` connected. The closeout agent needs `use_figma`,
`get_metadata`, `get_screenshot`, and `upload_assets`. CHECKPOINT 7: Figma connected as the operator.

## 8. Badge preview harness (Boostly app repo on port 3457): OPTIONAL, close-out proofs only

Since 2026-10-13 the variant sheet, the review canvas and the signage previews need no Boostly dev
server: the cells are drawn by the browser from the vendored templates
(`skills/boostly-brand-design/templates/sheet-templates.js`, the production badge markup copied from
the app) and the sheet JSON. The only step that still renders through the app is the close-out
production-parity proof (`render-effective-proof.ts` / `harness/screenshot.mjs`). Skip this section for
the fulfill stage and the dry run; set it up before the first close-out. `setup.sh --check` reports a
missing repo or harness as WARN, not MISSING.

```bash
set -a; . ~/.config/boostly-branding/.env; set +a
gh repo clone Boostly/boostly "$BOOSTLY_REPO_DIR"
cd "$BOOSTLY_REPO_DIR" && npm install
mkdir -p src/app/public/badge-preview-harness
cp ~/.claude/skills/boostly-brand-design/harness/dev-page/page.tsx src/app/public/badge-preview-harness/page.tsx
PORT=3457 npm run dev     # leave running in its own terminal; never commit the harness page
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3457/public/badge-preview-harness   # 200
```

The app's own `.env` needs are Boostly engineering's; if `npm run dev` fails on missing env, ask Travisse
which minimal `.env.local` the app needs for this page. The `signage-preview-harness` page is no longer
used (signage previews come from `scripts/signage-preview.mjs`). CHECKPOINT 8: the curl prints 200, or
"skipped until the first close-out".

## 9. Public review site (Boostly/fulfillment-reviews)

The shareable review page for every location lives at https://fulfillment-reviews.vercel.app (one
page per run dir at `/<run dir name>/`, index with search by name or city, status filter, sort by
last updated or request date). It is a static site built from the run root and pushed to GitHub;
Vercel deploys `main` automatically and the images go to a Vercel Blob store (public read, keyed by
content hash, cache committed at `data/blob-index.json`). Karissa, Cam, and customstickers.com review
from the site, and the site index is the status board (needs-you, steps, notes, waiting-on, ease);
the local 127.0.0.1:3917 page is only a fallback for an unpublished page.
Claude artifacts are not used for review pages. Needs the Boostly GitHub org and Boostly Vercel team
membership from section 0.

```bash
mkdir -p ~/Programming/repos
gh repo clone Boostly/fulfillment-reviews ~/Programming/repos/fulfillment-reviews
cd ~/Programming/repos/fulfillment-reviews
vercel login                                        # interactive, in the terminal, operator's Vercel account
vercel link --scope boostly --project fulfillment-reviews --yes
vercel env pull .env.local --scope boostly          # writes BLOB_READ_WRITE_TOKEN into the git-ignored .env.local
chmod 600 .env.local
grep -cE '^BLOB_READ_WRITE_TOKEN=.+' .env.local     # prints 1; never print the file
```

- [ ] `BLOB_READ_WRITE_TOKEN` is in the clone's `.env.local` (the `vercel env pull` above). The site
      build needs it, and so does progress publishing (`run-progress.mjs`, section 14): without it the
      agents still write `review/progress.json` locally and report the publish failure.

Dry build into a scratch folder (nothing uploaded, nothing committed):

```bash
set -a; . ~/.config/boostly-branding/.env; set +a
cd ~/Programming/repos/fulfillment-reviews
node scripts/build.mjs --run-root "$BOOSTLY_RUN_ROOT" --limit 0 --no-upload --out /tmp/fulfillment-reviews-dry
git restore data/sites.json      # the dry build only rewrote the manifest timestamp
git status --short               # must print nothing
```

`--no-upload` makes the build fail instead of uploading when an asset is missing from the blob index;
with `--limit 0` on an empty run root it proves the toolchain (node 20+, python3 with Pillow, the
token) without touching the site. The build merges into the committed manifest: only runs found in
this run root are rebuilt, every other page is kept, so pages built on Travisse's Mac survive a push
from this one (`--prune` is the only way a page is removed). CHECKPOINT 9: the grep prints 1, the dry
build exits 0, `git status --short` prints nothing.

## 10. Slack, status board, review server

```bash
~/.claude/skills/aos-slack/scripts/slack auth check
~/.config/boostly-branding/bin/boostly-review-server.sh
python3 ~/.claude/skills/boostly-box-fulfillment/scripts/review-checklist.py --run-root ~/boostly-branding/runs --no-live --publish-status
```

The last command writes `checklist/checklist.json` and uploads the public-safe status board to the
site's Blob store (`status/checklist.json`; the token comes from the fulfillment-reviews clone's
`.env.local`, section 9, or `BOOSTLY_REVIEWS_REPO_DIR` when the clone is elsewhere). The site index and
every location page overlay it on load. The 5-minute refresh job keeps it current without a model:
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.boostly.fulfillment-checklist.plist`.
Both machines can run that job: since 2026-10-15 the publish merges per location instead of overwriting
(newer wins, nulls never replace values, `done` never downgrades, the other machine's items stay unless a
fresh live query shows them closed, each item carries `host`), so Karissa's job is safe once she pulls this
repo and reruns `bash setup/setup.sh --force`. Dry runs stay off the board: put `BOOSTLY_PUBLISH_STATUS=0` in
`~/.config/boostly-branding/.env` to stop this machine publishing at all (the launchd run still ends `result=ok`),
or drop a `DRY_RUN` file in a run dir, or start its notes.json line with "Dry run", to keep one location off.
CHECKPOINT 10: Slack auth check shows "Boostly Fulfillment Notifications" (or the operator, with a user token), the publish prints `status published: ok`, the
review server answers on 127.0.0.1:3917.

## 11. Doctor

```bash
cd ~/Programming/projects/boostly-branding-workflow && bash setup/setup.sh --check
```

CHECKPOINT 11: 0 MISSING. WARN lines for optional keys are fine. Fix anything MISSING before the dry run.

## 12. First dry run (one request, no production writes)

Read `memory/RULES.md` and `~/.claude/skills/boostly-box-fulfillment/SKILL.md` first. Then:

```bash
set -a; . ~/.config/boostly-branding/.env; set +a
cd "$BOOSTLY_RUN_ROOT"
node --experimental-strip-types ~/.claude/skills/boostly-box-fulfillment/scripts/list-branding-requests.ts \
  --status open --json --limit 5 --out "$BOOSTLY_RUN_ROOT/branding-requests.json"
```

Pick ONE request with Travisse (ideally one already closed out on his machine, so the result can be
compared). Create its run dir and seed `run.json` with the request block through `run-file.ts init`
(the request JSON comes from the listing; never retype ids). Then launch the `fulfill-location` agent
with the run dir and the request facts. It stops at the review stage: evidence packet, Fable decision,
variant sheet, review canvas, link candidates. It makes no production writes.

Review the page against the GBP photos, Instagram, and the website. In the dry run that is the local
page at `http://127.0.0.1:3917/<run dir>/review/review-canvas.html` and, once the agent has
published it (step 9), the site page `https://fulfillment-reviews.vercel.app/<run dir>/`.
Do NOT run a closeout in the dry run. CHECKPOINT 12: review page
exists, `run-file validate <run dir>` exits 0, no production write happened (confirm from run.json:
`write.status` is `not_written`).

## 13. How to run a day

Every command assumes the env file is sourced and `cd "$BOOSTLY_RUN_ROOT"`.

1. Pull requests: `list-branding-requests.ts --status open --json --out branding-requests.json`, then
   `preflight-fulfillment-batch.ts --input branding-requests.json --out batch-preflight-result.json`.
   A preflight block writes a note to `$BOOSTLY_RUN_ROOT/inbox/messages.log` (the iMessage bridge is
   stubbed on this machine); read it and escalate by Slack.
2. Fulfill: for each request, seed the run dir (`run-file.ts init`) and launch `fulfill-location`
   (one agent per location; they run in parallel). Refresh and publish the status board:
   `python3 ~/.claude/skills/boostly-box-fulfillment/scripts/review-checklist.py --run-root "$BOOSTLY_RUN_ROOT" --publish-status`.
   The agent publishes the location's page to `https://fulfillment-reviews.vercel.app/<run dir>/`
   (step 9). If it reports "not published", run the publish command from the box-fulfillment
   SKILL.md "Public review site" section yourself:
   `cd ~/Programming/repos/fulfillment-reviews && git pull --ff-only && npm run build -- --run-root "$BOOSTLY_RUN_ROOT" --limit 0 --slug <run dir> && git add public data && git commit -m "Add <location> review page" && git push`
3. Pick: open the site page (or the local 127.0.0.1:3917 page), compare with GBP/Instagram/website,
   choose the letter. The letter is the go. When Cam, Travisse, or the vendor needs to see a review,
   share the site URL, never the local link and never a Claude artifact. If the pick's text equals
   the band, state the web/print split in the closeout prompt.
4. Closeout: launch `closeout-location` with the run dir and the letter. It applies branding to that
   location, writes ready links, renders proofs, builds the Figma section, and STOPS with a screenshot.
   Check the signage in Figma.
5. Finish: after approving the signage, launch `closeout-finish` with the run dir. One Slack post in the
   request thread, then the print hand-off (vector PDFs to the customstickers.com Drive folder, summary
   row, Gmail DRAFT to the vendor with Colin Dunn and Maren Dunn on cc; never sent, Travisse sends it),
   branding complete, store details confirmed when the ship-to is complete, the site status
   written (`review-status.mjs set`, status/waiting-on/ease), run.json validated, and the site
   page rebuilt and pushed so it shows "Closed out".
6. End of day: `review-checklist.py --publish-status` once more; held links and ship-to gaps go to
   the CSM in Slack. The board is public: never put a ship-to name or address in a note line.

## 14. Resuming a location from another machine

Every agent stamps its step boundaries with `run-progress.mjs set` (stage, last step, next step, what
Travisse owes). The stamp writes `<run dir>/review/progress.json` and publishes `status/<slug>.json`
plus a small bundle (run.json with ship-to and contact fields redacted, candidates, proofs, handoff
files) to the review site's Blob store, so the board at https://fulfillment-reviews.vercel.app shows
the stage, the next step, the blocked-on item, and who stamped it. To pick a location up here that was
started on Travisse's Mac (or the other way round):

```bash
set -a; . ~/.config/boostly-branding/.env; set +a
node ~/.claude/skills/boostly-brand-design/scripts/run-progress.mjs list                       # every published status
node ~/.claude/skills/boostly-brand-design/scripts/run-progress.mjs resume --slug <run dir name> --run-root "$BOOSTLY_RUN_ROOT"
node ~/.claude/skills/boostly-brand-design/scripts/run-progress.mjs pull --slug <run dir name> --run-root "$BOOSTLY_RUN_ROOT"
```

`resume` prints the brief (stage, last and next step, blocked-on, pick, branding write, Figma, bundle
manifest); `pull` downloads the bundle into `$BOOSTLY_RUN_ROOT/<run dir name>`. Then launch the agent
for the stage the brief names (`fulfill-location`, `closeout-location`, or `closeout-finish`) with that
run dir; each agent's resume rule continues from `next_step` and never re-runs a stage the bundle
shows done. The bundle is public read, so ship-to and contact data are not in it; the finish agent
reads the ship-to live from Boostly (`fulfillment get`), and `production-readback.json` is rewritten
from a live `branding get` when the pull did not bring it. Progress text never carries ship-to data,
cookies, or tokens.

Escalate to Travisse (do not improvise): a refused gate override, an identity conflict between sources,
a logo that cannot be rebuilt crisp from any ladder rung, a held link that needs a business decision, a
Figma slot conflict, any production write outside the picked location, any auth failure, any step where
the only way forward is a workaround of a guardrail (Chrome filter, CSP, gate, validator). Everything in
`memory/RULES.md` applies.
