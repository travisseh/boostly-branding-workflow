#!/usr/bin/env bash
# users.sh — Bulk user name resolution

# Build a JSON map of user IDs to display names.
# Takes a newline-delimited list of user IDs as $1.
# Returns {"UABC": "Display Name", ...} on stdout.
# Uses a single users.list call instead of N users.info calls.
slack_resolve_user_names() {
  local user_ids="$1"
  [ -z "$user_ids" ] && echo "{}" && return 0

  local all_users
  all_users=$(slack_paginate "users.list" ".members // []" 1000 200) || {
    echo "{}"
    return 0
  }

  echo "$all_users" | jq --arg ids "$user_ids" '
    ($ids | split("\n") | map(select(. != ""))) as $wanted |
    [ .[] | select(.id as $uid | $wanted | index($uid)) |
      { key: .id, value: (.profile.display_name as $dn |
        if ($dn == "" or $dn == null) then (.real_name // .name // "unknown") else $dn end) }
    ] | from_entries
  '
}
