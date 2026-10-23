#!/usr/bin/env bash
# Create (or, with --overwrite, replace) the "Claude Code: Boostly fulfillment" dashboard in Axiom (2026-10-21).
# Run once on Travisse's machine after the datasets exist and Claude Code events have arrived.
#
#   bash setup/axiom/create-dashboard.sh [--overwrite]
#
# Needs AXIOM_ADMIN_TOKEN: an Axiom API token with Dashboards create+update (the ingest token cannot create
# dashboards). Read from the first of $BOOSTLY_ENV_FILE, ~/Programming/.env, ~/.config/boostly-branding/.env that sets it.
# The token is passed to curl through a header file on stdin, so it never appears in argv, the terminal or shell history.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
read_key() { sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" -e 's/[[:space:]]*$//'; }
TOKEN=""; DS=""
for f in "${BOOSTLY_ENV_FILE:-}" "$HOME/Programming/.env" "$HOME/.config/boostly-branding/.env"; do
  [ -n "$f" ] && [ -r "$f" ] || continue
  t="$(read_key "$f" AXIOM_ADMIN_TOKEN)"; if [ -n "$t" ]; then TOKEN="$t"; DS="$(read_key "$f" AXIOM_DATASET)"; break; fi
done
[ -n "$TOKEN" ] || { echo "create-dashboard: AXIOM_ADMIN_TOKEN not set in ~/Programming/.env or ~/.config/boostly-branding/.env" >&2; exit 2; }
OVERWRITE=false; [ "${1:-}" = "--overwrite" ] && OVERWRITE=true
BODY="$(node "$HERE/build-dashboard.mjs" --dataset "${DS:-claude-logs}" | jq --argjson ow "$OVERWRITE" '{dashboard: ., overwrite: $ow}')"
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS -o /dev/stderr -w '\nHTTP %{http_code}\n' -X POST https://api.axiom.co/v2/dashboards \
  -H @- -H 'Content-Type: application/json' --data-binary "$BODY"
