#!/usr/bin/env bash
# users-lookup.sh — Search Slack users by name (display_name, real_name, username)

cmd_users_lookup() {
  local name="" limit=5

  if [ $# -eq 0 ]; then
    slack_emit_error 2 "missing_arg" "Usage: slack users lookup NAME [--limit N]"
    exit 2
  fi

  # First positional arg is the name
  name="$1"; shift

  while [ $# -gt 0 ]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) slack_emit_error 2 "invalid_arg" "Unknown argument: $1"; exit 2 ;;
    esac
  done

  # Fetch all users (paginated)
  local all_users
  all_users=$(slack_paginate "users.list" ".members // []" 10000 200) || exit $?

  # Filter: exclude deleted, bots, slackbot. Match by name fields.
  local lower_name
  lower_name=$(echo "$name" | tr '[:upper:]' '[:lower:]')

  echo "$all_users" | jq --arg q "$lower_name" --argjson lim "$limit" '
    [ .[]
      | select(.deleted != true and .is_bot != true and .id != "USLACKBOT")
      | {
          id,
          display_name: (.profile.display_name // ""),
          real_name: (.real_name // ""),
          username: (.name // "")
        }
      | select(
          (.display_name | ascii_downcase | contains($q)) or
          (.real_name | ascii_downcase | contains($q)) or
          (.username | ascii_downcase | contains($q))
        )
    ]
    | sort_by(
        if (.display_name | ascii_downcase) == $q or
           (.real_name | ascii_downcase) == $q or
           (.username | ascii_downcase) == $q
        then 0 else 1 end
      )
    | .[:$lim]
  '
}

cmd_users_lookup "$@"
