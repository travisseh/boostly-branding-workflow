#!/usr/bin/env bash
# messages-delete.sh — Delete a Slack message by channel + timestamp

cmd_messages_delete() {
  local target="" ts="" dry_run=false

  if [ $# -lt 2 ]; then
    slack_emit_error 2 "missing_arg" \
      "Usage: slack messages delete TARGET TS [--dry-run]"
    exit 2
  fi

  target="$1"; shift
  ts="$1"; shift

  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=true; shift ;;
      *) slack_emit_error 2 "invalid_arg" "Unknown argument: $1"; exit 2 ;;
    esac
  done

  # Validate timestamp format (Slack ts: digits.digits)
  if ! [[ "$ts" =~ ^[0-9]+\.[0-9]+$ ]]; then
    slack_emit_error 2 "invalid_ts" \
      "Invalid timestamp format: $ts" \
      "Slack timestamps look like 1774538774.123456"
    exit 2
  fi

  local channel_id
  channel_id=$(slack_resolve_target "$target" "$dry_run") || exit $?

  local payload response
  payload=$(jq -cn --arg channel "$channel_id" --arg ts "$ts" \
    '{channel:$channel, ts:$ts}')

  if [ "$dry_run" = true ]; then
    slack_emit_dry_run "chat.delete" "delete" "$channel_id" "$(echo "$payload" | jq '{ts}')"
    return 0
  fi

  response=$(slack_api_post_json "chat.delete" "$payload") || exit $?

  echo "$response" | jq '{ok: .ok, channel: .channel, ts: .ts}'
}

cmd_messages_delete "$@"
