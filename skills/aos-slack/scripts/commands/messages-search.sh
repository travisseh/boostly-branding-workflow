#!/usr/bin/env bash
# messages-search.sh — Full-text search across Slack messages

cmd_messages_search() {
  local query="" channel="" limit=10

  if [ $# -eq 0 ]; then
    slack_emit_error 2 "missing_arg" \
      "Usage: slack messages search QUERY [--channel NAME] [--limit N]"
    exit 2
  fi

  query="$1"; shift

  while [ $# -gt 0 ]; do
    case "$1" in
      --channel) channel="$2"; shift 2 ;;
      --limit)   limit="$2"; shift 2 ;;
      *) slack_emit_error 2 "invalid_arg" "Unknown argument: $1"; exit 2 ;;
    esac
  done

  # Clamp limit
  [ "$limit" -gt 50 ] && limit=50

  # Prepend channel filter if specified
  local effective_query="$query"
  if [ -n "$channel" ]; then
    local name="${channel#\#}"
    effective_query="in:#${name} ${query}"
  fi

  local response
  response=$(slack_api_get "search.messages" \
    "query=$effective_query" \
    "count=$limit" \
    "sort=timestamp" \
    "sort_dir=desc") || exit $?

  local matches
  matches=$(echo "$response" | jq '.messages.matches // []')

  # Bulk resolve user display names (1 API call instead of N)
  local user_ids
  user_ids=$(echo "$matches" | jq -r '[.[].user // empty] | unique | .[]')
  local user_map
  user_map=$(slack_resolve_user_names "$user_ids")

  # Shape output
  # NOTE: privacy classification is inlined here (mirror of slack_classify_privacy
  # in resolve.sh) because it runs inside a jq expression processing each search result.
  # resolve.sh holds the canonical logic — keep both copies in sync.
  jq -n --arg query "$effective_query" \
    --argjson total "$(echo "$response" | jq '.messages.total // 0')" \
    --argjson matches "$matches" \
    --argjson users "$user_map" '
    {
      query: $query,
      total: $total,
      results: [ $matches[] | {
        channel: (.channel.name // "unknown"),
        channel_id: (.channel.id // null),
        privacy: (.channel | (
          if .is_im == true then "dm"
          elif .is_mpim == true then "group_dm"
          elif .is_private == true then "private"
          elif .is_private == false then "public"
          else "unknown"
          end
        )),
        user: (if .user then ($users[.user] // .username // "unknown") else (.username // "unknown") end),
        text: (.text // ""),
        ts: .ts,
        permalink: (.permalink // null)
      }]
    }
  '
}

cmd_messages_search "$@"
