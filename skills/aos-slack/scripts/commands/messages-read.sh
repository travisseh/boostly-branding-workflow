#!/usr/bin/env bash
# messages-read.sh — Read channel history or thread replies

cmd_messages_read() {
  local channel="" limit=10 thread_ts=""

  if [ $# -eq 0 ]; then
    slack_emit_error 2 "missing_arg" \
      "Usage: slack messages read CHANNEL [--limit N] [--thread-ts TS]"
    exit 2
  fi

  channel="$1"; shift

  while [ $# -gt 0 ]; do
    case "$1" in
      --limit)     limit="$2"; shift 2 ;;
      --thread-ts) thread_ts="$2"; shift 2 ;;
      *) slack_emit_error 2 "invalid_arg" "Unknown argument: $1"; exit 2 ;;
    esac
  done

  # Clamp limit
  [ "$limit" -gt 100 ] && limit=100

  local resolved
  resolved=$(slack_resolve_target_with_privacy "$channel") || exit $?
  local channel_id privacy
  channel_id=$(echo "$resolved" | jq -r '.id')
  privacy=$(echo "$resolved" | jq -r '.privacy // "unknown"')

  local response
  if [ -n "$thread_ts" ]; then
    response=$(slack_api_get "conversations.replies" \
      "channel=$channel_id" "ts=$thread_ts" "limit=$limit") || exit $?
  else
    response=$(slack_api_get "conversations.history" \
      "channel=$channel_id" "limit=$limit") || exit $?
  fi

  local messages
  messages=$(echo "$response" | jq '.messages // []')

  # Bulk resolve user display names (1 API call instead of N)
  local user_ids
  user_ids=$(echo "$messages" | jq -r '[.[].user // empty] | unique | .[]')
  local user_map
  user_map=$(slack_resolve_user_names "$user_ids")

  # Additive: preserve the top-level array contract and attach the channel's
  # privacy classification to each message (same per-result shape as
  # `messages search`), so existing consumers of the array keep working.
  echo "$messages" | jq --arg priv "$privacy" --argjson users "$user_map" '
    [ .[] | {
      user: ($users[(.user // "")] // .user // .bot_profile.name // .bot_id // "bot"),
      user_id: (.user // .bot_id // null),
      text: (.text // ""),
      ts: .ts,
      thread_ts: (.thread_ts // null),
      reply_count: (.reply_count // 0),
      privacy: $priv
    }]
  '
}

cmd_messages_read "$@"
