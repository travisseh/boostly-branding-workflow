#!/usr/bin/env bash
# messages-send.sh — Send a message to a Slack channel, DM, or thread

cmd_messages_send() {
  local target="" text="" thread_ts="" strict_mentions=false blocks_file="" unfurl_links=true dry_run=false

  if [ $# -lt 2 ]; then
    slack_emit_error 2 "missing_arg" \
      "Usage: slack messages send TARGET TEXT [--thread-ts TS] [--blocks-file PATH] [--strict-mentions]"
    exit 2
  fi

  target="$1"; shift
  text="$1"; shift

  while [ $# -gt 0 ]; do
    case "$1" in
      --thread-ts)       thread_ts="$2"; shift 2 ;;
      --blocks-file)     blocks_file="$2"; shift 2 ;;
      --strict-mentions) strict_mentions=true; shift ;;
      --no-unfurl)       unfurl_links=false; shift ;;
      --dry-run)         dry_run=true; shift ;;
      *) slack_emit_error 2 "invalid_arg" "Unknown argument: $1"; exit 2 ;;
    esac
  done

  local channel_id
  channel_id=$(slack_resolve_target "$target" "$dry_run") || exit $?

  # Strict mentions check: fail if bare @word found (excluding special mentions and <@U...>)
  if [ "$strict_mentions" = true ]; then
    # Remove already-resolved <@U...> mentions, then check for bare @word
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
    # Auto-detect: if first element has "color" key, treat as attachments (for colored sidebars); otherwise as blocks
    local payload_key="blocks"
    if echo "$file_content" | jq -e '.[0] | has("color")' > /dev/null 2>&1; then
      payload_key="attachments"
    fi
    payload=$(jq -cn --arg channel "$channel_id" --arg text "$text" --arg thread_ts "$thread_ts" \
      --argjson unfurl "$unfurl_links" --arg key "$payload_key" --argjson content "$file_content" \
      '{channel:$channel, text:$text, unfurl_links:$unfurl, unfurl_media:$unfurl, ($key):$content} + if $thread_ts != "" then {thread_ts:$thread_ts} else {} end')
  else
    payload=$(jq -cn --arg channel "$channel_id" --arg text "$text" --arg thread_ts "$thread_ts" \
      --argjson unfurl "$unfurl_links" \
      '{channel:$channel, text:$text, unfurl_links:$unfurl, unfurl_media:$unfurl} + if $thread_ts != "" then {thread_ts:$thread_ts} else {} end')
  fi

  if [ "$dry_run" = true ]; then
    local extra
    extra=$(echo "$payload" | jq '{
      text, thread_ts: (.thread_ts // null),
      blocks: ((.blocks // []) | length),
      attachments: ((.attachments // []) | length)
    }')
    slack_emit_dry_run "chat.postMessage" "send" "$channel_id" "$extra"
    return 0
  fi

  local response
  response=$(slack_api_post_json "chat.postMessage" "$payload") || exit $?

  echo "$response" | jq '{
    ok: .ok,
    channel: .channel,
    ts: .ts,
    message: .message.text
  }'
}

cmd_messages_send "$@"
