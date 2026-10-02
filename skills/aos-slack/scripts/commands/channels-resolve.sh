#!/usr/bin/env bash
# channels-resolve.sh — Resolve channel name or ID to canonical {id, name, privacy}
# privacy is the channel's classification (public/private/dm/group_dm/unknown) via
# slack_classify_privacy — an exact, single-call, side-effect-free way to obtain a
# target's privacy (unlike `channels list --filter`, which is a substring match).

cmd_channels_resolve() {
  local channel="${1:-}"
  if [ -z "$channel" ]; then
    slack_emit_error 2 "missing_arg" "Usage: slack channels resolve CHANNEL"
    exit 2
  fi

  # Strip leading #
  channel="${channel#\#}"

  local privacy

  # If already a channel/DM ID, classify via conversations.info (one lookup).
  if [[ "$channel" =~ ^[CDG][A-Z0-9]+$ ]]; then
    local info ch
    info=$(slack_api_get "conversations.info" "channel=$channel" 2>/dev/null) || true
    ch=$(echo "${info:-{}}" | jq -c '.channel // {}')
    privacy=$(echo "$ch" | slack_classify_privacy)
    privacy="${privacy:-unknown}"
    echo "$ch" | jq --arg id "$channel" --arg p "$privacy" '{id: $id, name: (.name // null), privacy: $p}'
    return 0
  fi

  # Search by name through channel list
  local channels
  channels=$(slack_paginate "conversations.list" ".channels // []" 1000 200 \
    "exclude_archived=true" "types=public_channel,private_channel") || exit $?

  local match
  match=$(echo "$channels" | jq --arg name "$channel" '
    [ .[] | select(.name == $name) ] | first // null
  ')

  if [ "$match" = "null" ] || [ -z "$match" ]; then
    slack_emit_error 5 "channel_not_found" \
      "Channel \"$channel\" not found." \
      "Use 'slack channels list' to see available channels."
    exit 5
  fi

  privacy=$(echo "$match" | slack_classify_privacy)
  privacy="${privacy:-unknown}"
  echo "$match" | jq --arg p "$privacy" '{id, name, privacy: $p}'
}

cmd_channels_resolve "$@"
