#!/usr/bin/env bash
# messages-edit.sh — Edit (update) an existing Slack message by channel + timestamp

cmd_messages_edit() {
  local target="" ts="" text="" strict_mentions=false blocks_file="" dry_run=false

  if [ $# -lt 3 ]; then
    slack_emit_error 2 "missing_arg" \
      "Usage: slack messages edit TARGET TS NEWTEXT [--blocks-file PATH] [--strict-mentions]"
    exit 2
  fi

  target="$1"; shift
  ts="$1"; shift
  text="$1"; shift

  while [ $# -gt 0 ]; do
    case "$1" in
      --blocks-file)     blocks_file="$2"; shift 2 ;;
      --strict-mentions) strict_mentions=true; shift ;;
      --dry-run)         dry_run=true; shift ;;
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

  # Strict mentions check: fail if bare @word found (excluding special mentions and <@U...>)
  if [ "$strict_mentions" = true ]; then
    local cleaned
    cleaned=$(echo "$text" | sed -E 's/<@U[A-Za-z0-9]+>//g')
    # Match @word but not @here, @channel, @everyone (use perl — macOS grep lacks -P)
    if echo "$cleaned" | perl -0777 -ne 'exit(/(?<![<])\@(?!here\b|channel\b|everyone\b)\w/ ? 0 : 1)'; then
      local unresolved
      unresolved=$(echo "$cleaned" | perl -ne 'while (/(?<![<])\@(?!here\b|channel\b|everyone\b)(\w[\w._-]*)/g) { print "\@$1\n" }' | paste -sd, - | sed 's/,/, /g')
      slack_emit_error 5 "unresolved_mentions" \
        "Message contains unresolved @mentions: $unresolved" \
        "Use 'slack users lookup' to resolve them to <@USER_ID> format, or remove --strict-mentions."
      exit 5
    fi
  fi

  # edit is a full replacement: always send both content fields so the result
  # is deterministic. chat.update leaves a field unchanged when it is omitted,
  # so editing a message that had blocks down to plain text requires explicitly
  # clearing blocks (and vice versa) — otherwise stale content keeps rendering.
  local payload
  if [ -n "$blocks_file" ]; then
    if [ ! -f "$blocks_file" ]; then
      slack_emit_error 2 "file_not_found" "Blocks file not found: $blocks_file"
      exit 2
    fi
    local file_content
    file_content=$(cat "$blocks_file")
    if ! echo "$file_content" | jq -e 'type == "array"' > /dev/null 2>&1; then
      slack_emit_error 2 "invalid_blocks" "Blocks file must contain a JSON array"
      exit 2
    fi
    # Auto-detect: if first element has "color" key, treat as attachments (for colored sidebars); otherwise as blocks.
    # The unused field is cleared so it replaces, not merges with, the original.
    if echo "$file_content" | jq -e '.[0] | has("color")' > /dev/null 2>&1; then
      payload=$(jq -cn --arg channel "$channel_id" --arg ts "$ts" --arg text "$text" \
        --argjson content "$file_content" \
        '{channel:$channel, ts:$ts, text:$text, attachments:$content, blocks:[]}')
    else
      payload=$(jq -cn --arg channel "$channel_id" --arg ts "$ts" --arg text "$text" \
        --argjson content "$file_content" \
        '{channel:$channel, ts:$ts, text:$text, blocks:$content, attachments:[]}')
    fi
  else
    # Text-only edit: clear blocks/attachments so the message becomes exactly this text.
    payload=$(jq -cn --arg channel "$channel_id" --arg ts "$ts" --arg text "$text" \
      '{channel:$channel, ts:$ts, text:$text, blocks:[], attachments:[]}')
  fi

  if [ "$dry_run" = true ]; then
    local extra
    extra=$(echo "$payload" | jq '{
      ts, text,
      blocks: ((.blocks // []) | length),
      attachments: ((.attachments // []) | length)
    }')
    slack_emit_dry_run "chat.update" "edit" "$channel_id" "$extra"
    return 0
  fi

  local response
  response=$(slack_api_post_json "chat.update" "$payload") || exit $?

  echo "$response" | jq '{
    ok: .ok,
    channel: .channel,
    ts: .ts,
    message: .message.text
  }'
}

cmd_messages_edit "$@"
