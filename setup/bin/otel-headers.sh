#!/usr/bin/env bash
# Claude Code otelHeadersHelper (2026-10-21): prints the OTLP export headers for Axiom as JSON.
# Claude Code runs it at startup and every 29 minutes; settings.json never holds the token.
#
# Reads AXIOM_TOKEN, AXIOM_DATASET (events, default claude-logs) and AXIOM_METRICS_DATASET (default claude-metrics)
# from the first of these files that sets a non-empty AXIOM_TOKEN:
#   $BOOSTLY_ENV_FILE, ~/.config/boostly-branding/.env (the package env file), ~/Programming/.env (Travisse's workspace)
# Values are read as plain KEY=value lines; the files are never sourced, nothing is printed to stderr,
# and the token is never echoed anywhere but this JSON on stdout (which Claude Code reads, not the terminal).
# Both dataset headers go on every signal: Axiom's /v1/logs routes on X-Axiom-Dataset and /v1/metrics on
# X-Axiom-Metrics-Dataset. With no token it prints {} so exports are rejected quietly (401) until the token exists.
set -u
read_key() { # file key -> last value of KEY=..., surrounding quotes stripped
  sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" -e 's/[[:space:]]*$//'
}
TOKEN=""; SRC=""
for f in "${BOOSTLY_ENV_FILE:-}" "$HOME/.config/boostly-branding/.env" "$HOME/Programming/.env"; do
  [ -n "$f" ] && [ -r "$f" ] || continue
  t="$(read_key "$f" AXIOM_TOKEN)"; if [ -n "$t" ]; then TOKEN="$t"; SRC="$f"; break; fi
done
if [ -z "$TOKEN" ]; then printf '{}\n'; exit 0; fi
DS="$(read_key "$SRC" AXIOM_DATASET)"; MDS="$(read_key "$SRC" AXIOM_METRICS_DATASET)"
# JSON-escape: tokens and dataset names are [A-Za-z0-9_.-]; drop anything else rather than emit broken JSON.
clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9_.:-'; }
printf '{"Authorization":"Bearer %s","X-Axiom-Dataset":"%s","X-Axiom-Metrics-Dataset":"%s"}\n' \
  "$(clean "$TOKEN")" "$(clean "${DS:-claude-logs}")" "$(clean "${MDS:-claude-metrics}")"
