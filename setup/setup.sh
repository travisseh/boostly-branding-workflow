#!/usr/bin/env bash
# boostly-branding-workflow installer for macOS. Idempotent. No secrets in this file.
#
# Usage:
#   setup/setup.sh            install everything, then run the doctor
#   setup/setup.sh --check    doctor only: report OK/MISSING per dependency, change nothing
#   setup/setup.sh --force    overwrite skills/agents already present in ~/.claude (default: skip them)
#   setup/setup.sh --skip-npm skip npm/pip installs (fast re-run after a config change)
#   setup/setup.sh --load-launchd   also load the 5-minute Apple Note refresh job (off by default)
#
# What it does (all under $HOME; nothing touches production):
#   1. checks Homebrew, node (>=22), npm, python3, potrace, gh, jq, sqlite3, poppler, nc
#   2. installs npm deps for the brand-design harness (sharp, playwright, qrcode, tsx) and image-generator,
#      Playwright's chromium, Pillow (pip --user), and an OpenCV venv at ~/.config/boostly-branding/cvenv
#   3. copies skills/ -> ~/.claude/skills/, agents/ -> ~/.claude/agents/, tools/ -> ~/.claude/tools/
#   4. creates ~/.config/boostly-branding/.env from setup/env.example (0600) and lists the empty keys
#   5. creates the run root, heartbeat root, checklist dir, launchd helpers and plist (not loaded)
#   6. installs the Notion wrapper shim and the review-server command
#   7. adds one line to ~/.zshrc that exports the env file into every shell
#   8. doctor
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK=0; FORCE=0; SKIP_NPM=0; LOAD_LAUNCHD=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    --skip-npm) SKIP_NPM=1 ;;
    --load-launchd) LOAD_LAUNCHD=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
CONF="$HOME/.config/boostly-branding"
ENV_FILE="$CONF/.env"
SKILLS_DST="$HOME/.claude/skills"
AGENTS_DST="$HOME/.claude/agents"
TOOLS_DST="$HOME/.claude/tools"
NOTION_WRAPPER_DST="$HOME/.config/notion-tools/notion-ai-ntn.sh"
PLIST="$HOME/Library/LaunchAgents/com.boostly.fulfillment-checklist.plist"
MISSING=0
ok()   { printf '  OK       %s\n' "$*"; }
miss() { printf '  MISSING  %s\n' "$*"; MISSING=$((MISSING+1)); }
warn() { printf '  WARN     %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(uname -s)" != "Darwin" ]; then echo "macOS only (Chrome keychain cookie decrypt and Apple Notes)." >&2; exit 1; fi

# ---------------------------------------------------------------- 1. system tools
step "system tools"
if ! have brew; then
  if [ "$CHECK" = 1 ]; then miss "Homebrew (https://brew.sh)"; else
    echo "Installing Homebrew (interactive)..."; /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi
have brew && ok "brew $(brew --version | head -1)"
need_formula() { # name, command
  if have "$2"; then ok "$1 ($($2 --version 2>&1 | head -1))"; else
    if [ "$CHECK" = 1 ]; then miss "$1 (brew install $1)"; else echo "brew install $1"; brew install "$1"; have "$2" && ok "$1" || miss "$1"; fi
  fi
}
need_formula node node
need_formula potrace potrace
need_formula gh gh
need_formula jq jq
need_formula poppler pdftoppm
have python3 && ok "python3 $(python3 --version 2>&1)" || need_formula python python3
have sqlite3 && ok "sqlite3" || miss "sqlite3 (ships with macOS)"
have nc && ok "nc" || miss "nc (ships with macOS)"
have npm && ok "npm $(npm --version)" || miss "npm"
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 22 ] && ok "node major $NODE_MAJOR (>=22, needed for --experimental-strip-types)" || miss "node >= 22 (have $NODE_MAJOR); brew upgrade node"
fi
have claude && ok "claude $(claude --version 2>&1 | head -1)" || miss "Claude Code CLI (https://claude.com/claude-code)"
have codex && ok "codex (optional) $(codex --version 2>&1 | head -1)" || warn "codex CLI not installed (optional; the discovery-transport agent is the fallback)"
have psql && ok "psql (optional, replica path only)" || warn "psql not installed (only needed if V2_DB_* replica credentials are used)"

# ---------------------------------------------------------------- 2. language deps
step "node and python dependencies"
HARNESS="$REPO/skills/boostly-brand-design/harness"
if [ "$CHECK" = 1 ] || [ "$SKIP_NPM" = 1 ]; then
  [ -d "$HARNESS/node_modules/sharp" ] && [ -d "$HARNESS/node_modules/playwright" ] && ok "harness node_modules (repo copy)" || warn "harness node_modules not installed in the repo copy (run without --check/--skip-npm)"
else
  (cd "$HARNESS" && npm install --no-audit --no-fund && npm install --no-audit --no-fund --save-dev tsx) && ok "harness npm deps (sharp, playwright, qrcode, tsx)" || miss "harness npm install failed"
  (cd "$HARNESS" && npx playwright install chromium) && ok "playwright chromium" || warn "playwright chromium install failed (website captures will not work)"
  (cd "$REPO/skills/image-generator" && npm install --no-audit --no-fund) && ok "image-generator npm deps" || warn "image-generator npm install failed (optional)"
  python3 -m pip install --user --quiet -r "$REPO/setup/requirements.txt" && ok "Pillow (pip --user)" || warn "pip install Pillow failed"
  PYV="$(command -v python3.12 || command -v python3.13 || command -v python3)"
  if [ ! -x "$CONF/cvenv/bin/python" ]; then
    mkdir -p "$CONF" && "$PYV" -m venv "$CONF/cvenv" && "$CONF/cvenv/bin/pip" install --quiet opencv-python-headless numpy && ok "OpenCV venv at $CONF/cvenv ($PYV)" || warn "OpenCV venv failed (QR decode verification will not run); try: python3.12 -m venv $CONF/cvenv"
  fi
fi
python3 -c 'import PIL' 2>/dev/null && ok "python3 PIL" || miss "python3 Pillow (python3 -m pip install --user Pillow)"
[ -x "$CONF/cvenv/bin/python" ] && "$CONF/cvenv/bin/python" -c 'import cv2' 2>/dev/null && ok "cv2 venv $CONF/cvenv" || warn "cv2 venv missing at $CONF/cvenv"

# ---------------------------------------------------------------- 3. skills, agents, tools
step "skills, agents, tools -> ~/.claude"
install_dir() { # src dst label
  if [ -e "$2" ] && [ "$FORCE" = 0 ]; then ok "$3 present (kept; --force to overwrite)"; return; fi
  if [ "$CHECK" = 1 ]; then [ -e "$2" ] && ok "$3 present" || miss "$3 not installed"; return; fi
  mkdir -p "$(dirname "$2")" && rsync -a --delete --exclude node_modules --exclude feedback --exclude runs "$1/" "$2/" && ok "$3 installed" || miss "$3 copy failed"
}
for s in "$REPO"/skills/*/; do n="$(basename "$s")"; install_dir "$s" "$SKILLS_DST/$n" "skill $n"; done
# harness node_modules are installed in the repo copy; link the installed skill to them so sharp/playwright resolve
if [ "$CHECK" = 0 ] && [ -d "$HARNESS/node_modules" ] && [ ! -e "$SKILLS_DST/boostly-brand-design/harness/node_modules" ]; then
  ln -s "$HARNESS/node_modules" "$SKILLS_DST/boostly-brand-design/harness/node_modules" && ok "harness node_modules linked into ~/.claude/skills"
fi
if [ "$CHECK" = 0 ] && [ -d "$REPO/skills/image-generator/node_modules" ] && [ ! -e "$SKILLS_DST/image-generator/node_modules" ]; then
  ln -s "$REPO/skills/image-generator/node_modules" "$SKILLS_DST/image-generator/node_modules"
fi
for a in "$REPO"/agents/*.md; do n="$(basename "$a")"
  if [ -e "$AGENTS_DST/$n" ] && [ "$FORCE" = 0 ]; then ok "agent $n present (kept)"; elif [ "$CHECK" = 1 ]; then [ -e "$AGENTS_DST/$n" ] && ok "agent $n present" || miss "agent $n not installed"; else mkdir -p "$AGENTS_DST" && cp "$a" "$AGENTS_DST/$n" && ok "agent $n installed"; fi
done
if [ -e "$TOOLS_DST/apple-notes.py" ] || [ "$CHECK" = 1 ]; then [ -e "$TOOLS_DST/apple-notes.py" ] && ok "tools/apple-notes.py present" || miss "tools/apple-notes.py not installed"; else mkdir -p "$TOOLS_DST" && cp "$REPO/tools/apple-notes.py" "$TOOLS_DST/" && chmod 700 "$TOOLS_DST/apple-notes.py" && ok "tools/apple-notes.py installed"; fi

# ---------------------------------------------------------------- 4. env file
step "config: $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  if [ "$CHECK" = 1 ]; then miss "$ENV_FILE (setup.sh creates it from setup/env.example)"; else
    mkdir -p "$CONF" && chmod 700 "$CONF" && cp "$REPO/setup/env.example" "$ENV_FILE" && chmod 600 "$ENV_FILE" && ok "created from env.example"
  fi
fi
if [ -f "$ENV_FILE" ]; then
  [ "$(stat -f %Lp "$ENV_FILE")" = "600" ] && ok "mode 0600" || { [ "$CHECK" = 1 ] && miss "mode is not 0600 (chmod 600 $ENV_FILE)" || { chmod 600 "$ENV_FILE"; ok "mode set to 0600"; }; }
  set -a; . "$ENV_FILE"; set +a
  EMPTY="$(grep -E '^[A-Z0-9_]+=\s*$' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ')"
  [ -n "$EMPTY" ] && warn "empty keys: $EMPTY" || ok "no empty keys"
fi
: "${BOOSTLY_RUN_ROOT:=$HOME/boostly-branding/runs}"
BOOSTLY_RUN_ROOT="$(eval echo "$BOOSTLY_RUN_ROOT")"
: "${BOOSTLY_HEARTBEAT_ROOT:=$BOOSTLY_RUN_ROOT/heartbeat}"
BOOSTLY_HEARTBEAT_ROOT="$(eval echo "$BOOSTLY_HEARTBEAT_ROOT")"

# ---------------------------------------------------------------- 5. run root, launchd helpers
step "run root: $BOOSTLY_RUN_ROOT"
if [ "$CHECK" = 1 ]; then
  [ -d "$BOOSTLY_RUN_ROOT" ] && ok "run root exists" || miss "run root missing"
  [ -d "$BOOSTLY_HEARTBEAT_ROOT" ] && ok "heartbeat root $BOOSTLY_HEARTBEAT_ROOT" || miss "heartbeat root missing"
  [ -f "$BOOSTLY_RUN_ROOT/checklist/launchd-refresh.sh" ] && ok "checklist helpers" || miss "checklist helpers not installed"
  [ -f "$PLIST" ] && ok "launchd plist present (load with: launchctl bootstrap gui/\$(id -u) $PLIST)" || warn "launchd plist not installed"
else
  mkdir -p "$BOOSTLY_RUN_ROOT/checklist" "$BOOSTLY_HEARTBEAT_ROOT/account-write-locks" "$BOOSTLY_RUN_ROOT/inbox" && ok "directories"
  [ -f "$BOOSTLY_RUN_ROOT/checklist/notes.json" ] || { echo '{}' > "$BOOSTLY_RUN_ROOT/checklist/notes.json"; chmod 600 "$BOOSTLY_RUN_ROOT/checklist/notes.json"; }
  cp "$REPO/setup/launchd/launchd-refresh.sh" "$REPO/setup/launchd/build-checklist.py" "$BOOSTLY_RUN_ROOT/checklist/" && chmod 755 "$BOOSTLY_RUN_ROOT/checklist/launchd-refresh.sh" && ok "checklist helpers copied"
  mkdir -p "$HOME/Library/LaunchAgents" && sed "s#__RUN_ROOT__#$BOOSTLY_RUN_ROOT#g" "$REPO/setup/launchd/com.boostly.fulfillment-checklist.plist.template" > "$PLIST" && ok "launchd plist written (not loaded)"
  if [ "$LOAD_LAUNCHD" = 1 ]; then launchctl bootout "gui/$(id -u)/com.boostly.fulfillment-checklist" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$PLIST" && ok "launchd job loaded" || warn "launchctl bootstrap failed"; fi
fi

# ---------------------------------------------------------------- 6. wrappers
step "wrapper commands"
if [ -e "$NOTION_WRAPPER_DST" ]; then ok "Notion wrapper present at $NOTION_WRAPPER_DST (kept)"; elif [ "$CHECK" = 1 ]; then miss "Notion wrapper $NOTION_WRAPPER_DST (setup.sh installs setup/bin/notion-ai-ntn.sh)"; else
  mkdir -p "$(dirname "$NOTION_WRAPPER_DST")" && cp "$REPO/setup/bin/notion-ai-ntn.sh" "$NOTION_WRAPPER_DST" && chmod 755 "$NOTION_WRAPPER_DST" && ok "Notion wrapper shim installed"
fi
if [ "$CHECK" = 0 ]; then mkdir -p "$CONF/bin" && cp "$REPO/setup/bin/boostly-review-server.sh" "$CONF/bin/" && chmod 755 "$CONF/bin/boostly-review-server.sh" && ok "review server command: $CONF/bin/boostly-review-server.sh"; else [ -x "$CONF/bin/boostly-review-server.sh" ] && ok "review server command installed" || miss "review server command (setup.sh installs it)"; fi

# ---------------------------------------------------------------- 7. shell
step "shell profile"
LINE='[ -f "$HOME/.config/boostly-branding/.env" ] && set -a && . "$HOME/.config/boostly-branding/.env" && set +a  # boostly-branding-workflow'
if grep -qs 'boostly-branding-workflow' "$HOME/.zshrc"; then ok "~/.zshrc exports the env file"; elif [ "$CHECK" = 1 ]; then miss "~/.zshrc does not source the env file"; else printf '\n%s\n' "$LINE" >> "$HOME/.zshrc" && ok "~/.zshrc line added (open a new shell, or: source ~/.zshrc)"; fi

# ---------------------------------------------------------------- 8. doctor
step "doctor"
for k in BOOSTLY_RUN_ROOT BOOSTLY_CHROME_PROFILE BOOSTLY_ADMIN_MCP_KEY SLACK_USER_OAUTH_TOKEN NOTION_API_TOKEN SEARCHAPI_API_KEY GOOGLE_PLACES_API_KEY DATAFORSEO_LOGIN DATAFORSEO_PASSWORD BOOSTLY_V2_API_KEY BOOSTLY_REPO_DIR; do
  v="${!k:-}"; [ -n "$v" ] && ok "env $k set" || miss "env $k empty"
done
for k in ASKELEPHANT_API_KEY TINYPNG_API_KEY REPLICATE_API_TOKEN OPENAI_API_KEY; do v="${!k:-}"; [ -n "$v" ] && ok "env $k set (optional)" || warn "env $k empty (optional)"; done
[ -n "${FIGMA_TOKEN:-}" ] && ok "env FIGMA_TOKEN set (print hand-off)" || warn "env FIGMA_TOKEN empty (print hand-off PDF export will not run)"
GT="$(eval echo "${GMAIL_TOOLS_DIR:-$HOME/.config/gmail-tools}")"; GO="$(eval echo "${GOOGLE_TOOLS_DIR:-$HOME/.config/google-tools}")"
[ -f "$GT/gmail.js" ] && grep -q -- '--cc' "$GT/gmail.js" && ok "gmail-tools CLI with draft --cc at $GT" || warn "gmail-tools CLI with --cc not at $GT (print hand-off drafts need it; see README)"
[ -f "$GO/auth.js" ] && ok "google-tools auth.js at $GO" || warn "google-tools auth.js not at $GO (print hand-off Drive upload needs it; see README)"
if [ -n "${BOOSTLY_CHROME_PROFILE:-}" ]; then
  CK="$HOME/Library/Application Support/Google/Chrome/$BOOSTLY_CHROME_PROFILE/Cookies"
  [ -f "$CK" ] && ok "Chrome profile cookie jar found for $BOOSTLY_CHROME_PROFILE" || miss "no Cookies file at \"$CK\" (wrong BOOSTLY_CHROME_PROFILE?)"
fi
V2DB="$SKILLS_DST/v2-database/bin/v2-db"; [ -x "$V2DB" ] || V2DB="$REPO/skills/v2-database/bin/v2-db"
if [ -n "${BOOSTLY_ADMIN_MCP_KEY:-}" ] || [ -n "${V2_DB_HOST:-}" ]; then
  "$V2DB" doctor >/dev/null 2>&1 && ok "v2-db doctor (Boostly reads)" || miss "v2-db doctor failed (run: $V2DB doctor)"
fi
if [ -n "${SLACK_USER_OAUTH_TOKEN:-}" ]; then
  SL="$SKILLS_DST/aos-slack/scripts/slack"; [ -x "$SL" ] || SL="$REPO/skills/aos-slack/scripts/slack"
  "$SL" auth check >/dev/null 2>&1 && ok "slack auth check" || miss "slack auth check failed"
fi
if [ -n "${NOTION_API_TOKEN:-}" ]; then
  NW="$NOTION_WRAPPER_DST"; [ -x "$NW" ] || NW="$REPO/setup/bin/notion-ai-ntn.sh"
  "$NW" --workspace boostly whoami >/dev/null 2>&1 && ok "notion whoami" || miss "notion whoami failed"
fi
BR="$(eval echo "${BOOSTLY_REPO_DIR:-$HOME/Programming/boostly}")"
# 2026-10-13: the variant sheet, review canvas and signage previews draw from templates/sheet-templates.js; the Boostly
# repo and its :3457 harness page are only used by the close-out proof render (render-effective-proof.ts). WARN, not MISSING.
[ -d "$BR/.git" ] && ok "Boostly repo at $BR" || warn "Boostly repo not cloned at $BR (only the close-out proof render needs it; previews do not)"
[ -f "$BR/src/app/public/badge-preview-harness/page.tsx" ] && ok "badge preview harness page installed in the repo" || warn "harness page not installed (see skills/boostly-brand-design/harness/dev-page/README.md)"
curl -s -o /dev/null -m 3 -w '%{http_code}' http://localhost:3457/public/badge-preview-harness 2>/dev/null | grep -q '^200$' && ok "badge preview harness answering on :3457" || warn "badge preview harness not running on :3457 (PORT=3457 npm run dev in the Boostly repo)"
nc -z 127.0.0.1 3917 2>/dev/null && ok "review server on :3917" || warn "review server not running (start: $CONF/bin/boostly-review-server.sh)"
have claude && claude mcp list 2>/dev/null | grep -q 'boostly-admin' && ok "claude mcp: boostly-admin registered" || warn "boostly-admin MCP not registered in Claude Code (see docs/BOOTSTRAP.md step 6)"
have claude && claude mcp list 2>/dev/null | grep -qi 'figma' && ok "claude mcp: figma plugin registered" || warn "Figma MCP plugin not registered (see docs/BOOTSTRAP.md step 7)"

printf '\n%s\n' "doctor: $MISSING MISSING item(s)."
[ "$MISSING" = 0 ]
