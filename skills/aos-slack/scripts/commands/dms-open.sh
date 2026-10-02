#!/usr/bin/env bash
# dms-open.sh — Open a DM channel with a user ID

cmd_dms_open() {
  local user_id="${1:-}"
  if [ -z "$user_id" ]; then
    slack_emit_error 2 "missing_arg" "Usage: slack dms open USER_ID"
    exit 2
  fi

  if [[ ! "$user_id" =~ ^U[A-Za-z0-9]+$ ]]; then
    slack_emit_error 2 "invalid_arg" \
      "Invalid user ID: $user_id. Expected format: U followed by alphanumeric characters."
    exit 2
  fi

  local payload
  payload=$(jq -cn --arg users "$user_id" '{users:$users}')

  local response
  response=$(slack_api_post_json "conversations.open" "$payload") || exit $?

  echo "$response" | jq '{channel: .channel.id}'
}

cmd_dms_open "$@"
