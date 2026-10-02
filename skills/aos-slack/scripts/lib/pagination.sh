#!/usr/bin/env bash
# pagination.sh — Cursor-based pagination for Slack list endpoints

# Generic cursor pagination.
#   endpoint:     e.g. "conversations.list"
#   array_filter: jq selector for page items, e.g. ".channels // []"
#   max_items:    final cap (default 100)
#   page_limit:   per-request limit (default 200)
#   remaining:    optional key=value query args applied every page
# Prints combined JSON array on stdout.
slack_paginate() {
  local endpoint="$1" array_filter="$2" max_items="${3:-100}" page_limit="${4:-200}"
  shift 4 2>/dev/null || shift $#

  local cursor="" all_items="[]"
  local fixed_query=("$@")

  while true; do
    local query_args=("limit=$page_limit")
    [ -n "$cursor" ] && query_args+=("cursor=$cursor")
    query_args+=("${fixed_query[@]+"${fixed_query[@]}"}")

    local response
    response=$(slack_api_get "$endpoint" "${query_args[@]}") || return 4

    # Single jq: extract items + cursor together
    local page_data
    page_data=$(echo "$response" | jq -c \
      '{ items: ('"$array_filter"'), cursor: (.response_metadata.next_cursor // "") }')
    local items
    items=$(echo "$page_data" | jq -c '.items')
    cursor=$(echo "$page_data" | jq -r '.cursor')

    # Merge + count in one pass
    local count
    all_items=$(echo "$all_items" "$items" | jq -s '.[0] + .[1]')
    count=$(echo "$all_items" | jq 'length')
    [ "$count" -ge "$max_items" ] && break
    [ -z "$cursor" ] && break
  done

  echo "$all_items" | jq ".[:$max_items]"
}
