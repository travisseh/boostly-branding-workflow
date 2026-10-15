#!/bin/bash
# launchd wrapper for the fulfillment review checklist (added 2026-09-29). No model is involved.
# Job: ~/Library/LaunchAgents/com.boostly.fulfillment-checklist.plist, every 300 seconds.
# It runs build-checklist.py (a thin wrapper over review-checklist.py in the fulfillment skill):
# a read-only query of open requests, a join to each run.json, and the publish of the public-safe
# status board to Vercel Blob for https://fulfillment-reviews.vercel.app (Travisse 2026-10-13; the
# Apple Note rewrite is retired). It never opens or activates an app and never writes production.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${HOME:-$(eval echo ~$(id -un))}"
export LANG="en_US.UTF-8"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_ROOT="$(dirname "$HERE")"
PROJECT_ROOT="$(dirname "$RUN_ROOT")"
LOG="$HERE/launchd.log"
LOCK="$HERE/.launchd-refresh.lock"
stamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }

# Keep the log small: launchd reopens the path on the next start.
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$LOG" "$LOG.1"
fi

# One run at a time. A lock older than 15 minutes is stale and is cleared.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || { echo "[$(stamp)] skip: lock busy"; exit 0; }
  else
    echo "[$(stamp)] skip: previous run still active"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "[$(stamp)] start pid=$$"
cd "$PROJECT_ROOT" || { echo "[$(stamp)] FAIL: cannot cd to $PROJECT_ROOT"; exit 1; }
OUTPUT="$(python3 "$HERE/build-checklist.py" --publish-status 2>&1)"
CODE=$?
printf '%s\n' "$OUTPUT"

RESULT="ok"
[ "$CODE" -ne 0 ] && RESULT="FAIL: script exit $CODE"
# BOOSTLY_PUBLISH_STATUS=0 (a dry-run machine) skips the PUT on purpose; that is still a good run.
if [ "$RESULT" = "ok" ] && ! printf '%s\n' "$OUTPUT" | grep -qE '^status published: (ok |skipped \(BOOSTLY_PUBLISH_STATUS=0)'; then RESULT="FAIL: status board publish did not return ok"; fi
if [ "$RESULT" = "ok" ] && ! printf '%s\n' "$OUTPUT" | grep -q 'stale=False'; then RESULT="FAIL: stale data (live request query failed)"; fi
echo "[$(stamp)] end result=$RESULT"
[ "$RESULT" = "ok" ] || exit 1
exit 0
