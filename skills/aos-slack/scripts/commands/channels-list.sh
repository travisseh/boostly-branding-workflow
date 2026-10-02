#!/usr/bin/env bash
# channels-list.sh — List Slack channels with optional filter

cmd_channels_list() {
  local filter="" limit=100

  while [ $# -gt 0 ]; do
    case "$1" in
      --filter) filter="$2"; shift 2 ;;
      --limit)  limit="$2"; shift 2 ;;
      *) slack_emit_error 2 "invalid_arg" "Unknown argument: $1"; exit 2 ;;
    esac
  done

  local result
  result=$(slack_paginate "conversations.list" ".channels // []" "$limit" 200 \
    "exclude_archived=true" "types=public_channel,private_channel") || exit $?

  local lower_filter=""
  [ -n "$filter" ] && lower_filter=$(echo "$filter" | tr '[:upper:]' '[:lower:]')

  echo "$result" | jq --arg f "$lower_filter" '
    [ .[] | select(if $f != "" then (.name | ascii_downcase | contains($f)) else true end) ]
    | map({id, name, is_private: (.is_private // false), topic: (.topic.value // ""), num_members: (.num_members // 0)})
  '
}

cmd_channels_list "$@"
