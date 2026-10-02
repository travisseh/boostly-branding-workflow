#!/usr/bin/env bash
# auth-check.sh — Validate Slack token and report auth context

cmd_auth_check() {
  local response
  response=$(slack_api_post_json "auth.test" "{}") || exit $?

  # Extract and output relevant fields
  echo "$response" | jq '{
    ok: .ok,
    url: .url,
    team: .team,
    team_id: .team_id,
    user: .user,
    user_id: .user_id
  }'
}

cmd_auth_check "$@"
