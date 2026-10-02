#!/usr/bin/env bash
# Start (or confirm) the local static review server on 127.0.0.1:3917 that serves the run root, so the
# review page links in the Apple Note and in agent reports open on this Mac. Idempotent: exits 0 when
# the port already answers. Nothing is written; no production access.
#
# Usage: boostly-review-server.sh [--run-root <dir>] [--port 3917] [--refresh]
#   --refresh also rebuilds the Apple Note checklist from the current run dirs (no live query).
set -euo pipefail
ENV_FILE="${BOOSTLY_BRANDING_ENV_FILE:-$HOME/.config/boostly-branding/.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
RUN_ROOT="${BOOSTLY_RUN_ROOT:-$HOME/boostly-branding/runs}"
PORT=3917
REFRESH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --run-root) RUN_ROOT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --refresh) REFRESH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
RUN_ROOT="$(eval echo "$RUN_ROOT")"
mkdir -p "$RUN_ROOT/checklist"
if [ "$REFRESH" = 1 ]; then
  python3 "$HOME/.claude/skills/boostly-box-fulfillment/scripts/review-checklist.py" --run-root "$RUN_ROOT" --no-live --port "$PORT"
  exit $?
fi
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "review server already listening on http://127.0.0.1:$PORT (serving $RUN_ROOT)"
  exit 0
fi
nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$RUN_ROOT" >"$RUN_ROOT/checklist/server.log" 2>&1 &
sleep 1
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "review server started on http://127.0.0.1:$PORT (serving $RUN_ROOT, log $RUN_ROOT/checklist/server.log)"
else
  echo "review server failed to start; see $RUN_ROOT/checklist/server.log" >&2
  exit 1
fi
