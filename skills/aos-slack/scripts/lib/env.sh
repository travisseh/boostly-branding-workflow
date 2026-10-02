#!/usr/bin/env bash
# env.sh — Token resolution, dependency checks
#
# The token is read from the process environment ($VAR) only — never from a
# .env file at runtime.

# Resolve token with precedence: SLACK_TOKEN > SLACK_USER_OAUTH_TOKEN
# Exports SLACK_TOKEN. Returns 3 if no token found.
slack_resolve_token() {
  if [ -n "${SLACK_TOKEN:-}" ]; then
    export SLACK_TOKEN
    return 0
  fi
  if [ -n "${SLACK_USER_OAUTH_TOKEN:-}" ]; then
    SLACK_TOKEN="$SLACK_USER_OAUTH_TOKEN"
    export SLACK_TOKEN
    return 0
  fi
  return 3
}

# Check required binaries exist. Returns 2 if any missing.
slack_require_bins() {
  local missing=()
  for bin in curl jq; do
    if ! command -v "$bin" &>/dev/null; then
      missing+=("$bin")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    slack_emit_error 2 "missing_dependency" \
      "Required tools not found: ${missing[*]}" \
      "Install with: brew install ${missing[*]}"
    return 2
  fi
  return 0
}

# Emit structured error JSON to stderr. Does not exit.
# Uses printf fallback when jq is unavailable (needed by slack_require_bins).
slack_emit_error() {
  local exit_code="$1" code="$2" message="$3" hint="${4:-}"
  if command -v jq &>/dev/null; then
    local json
    if [ -n "$hint" ]; then
      json=$(jq -cn --arg code "$code" --arg message "$message" --arg hint "$hint" \
        '{"ok":false,"error":{"code":$code,"message":$message,"hint":$hint}}')
    else
      json=$(jq -cn --arg code "$code" --arg message "$message" \
        '{"ok":false,"error":{"code":$code,"message":$message}}')
    fi
    echo "$json" >&2
  else
    if [ -n "$hint" ]; then
      printf '{"ok":false,"error":{"code":"%s","message":"%s","hint":"%s"}}\n' "$code" "$message" "$hint" >&2
    else
      printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' "$code" "$message" >&2
    fi
  fi
}

# Full init: resolve token, validate deps. Reads secrets from the
# environment only — no .env file IO.
# Sets SLACK_API_BASE. Returns non-zero on failure.
slack_env_init() {
  SLACK_API_BASE="${SLACK_API_BASE_URL:-https://slack.com/api}"
  export SLACK_API_BASE

  slack_require_bins || return $?

  if ! slack_resolve_token; then
    slack_emit_error 3 "token_missing" \
      "No Slack token found in the environment." \
      "Set SLACK_USER_OAUTH_TOKEN (or SLACK_TOKEN) in the environment and retry."
    return 3
  fi
}
