#!/usr/bin/env bash
# resolve.sh — Unified target resolution (channel ID, user ID, or channel name)

# Resolve a target string to a Slack channel ID.
#   Channel/DM ID (C.../D.../G...) → passthrough
#   User ID (U...) → open DM via conversations.open → DM channel ID
#   Channel name → paginate conversations.list → exact match → channel ID
# Returns channel ID on stdout. Returns 5 on not-found.
#
# Second arg (default false): when true, resolve without any Slack write — a
# User ID passes through unchanged instead of opening a DM (conversations.open
# is a side effect). Used by --dry-run so previews never mutate Slack. Channel
# name resolution stays on (conversations.list is read-only).
slack_resolve_target() {
  local target="$1"
  local dry_run="${2:-false}"

  # Already a channel/DM ID
  if [[ "$target" =~ ^[CDG][A-Z0-9]+$ ]]; then
    echo "$target"
    return 0
  fi

  # User ID — open DM (pass through unchanged in dry-run to avoid the write)
  if [[ "$target" =~ ^U[A-Za-z0-9]+$ ]]; then
    if [ "$dry_run" = true ]; then
      echo "$target"
      return 0
    fi
    local payload dm_response
    payload=$(jq -cn --arg users "$target" '{users:$users}')
    dm_response=$(slack_api_post_json "conversations.open" "$payload") || return $?
    echo "$dm_response" | jq -r '.channel.id'
    return 0
  fi

  # Channel name — resolve via conversations.list
  local name="${target#\#}"
  local channels match
  channels=$(slack_paginate "conversations.list" ".channels // []" 1000 200 \
    "exclude_archived=true" "types=public_channel,private_channel") || return $?

  match=$(echo "$channels" | jq -r --arg name "$name" \
    '[ .[] | select(.name == $name) ] | first // null | .id // empty')

  if [ -z "$match" ]; then
    slack_emit_error 5 "channel_not_found" \
      "Channel \"$name\" not found." \
      "Use 'slack channels list' to see available channels."
    return 5
  fi

  echo "$match"
}

# Classify a channel object's privacy level from JSON on stdin.
# Returns: "public", "private", "dm", "group_dm", or "unknown"
# NOTE: is_im must be checked before is_private — DMs return is_private:null
# CANONICAL classifier — the inline jq in messages-search.sh mirrors this; keep both in sync.
slack_classify_privacy() {
  jq -r '
    if .is_im == true then "dm"
    elif .is_mpim == true then "group_dm"
    elif .is_private == true then "private"
    elif .is_private == false then "public"
    else "unknown"
    end
  '
}

# Resolve target to channel ID + privacy. Returns JSON: {"id":"C...", "privacy":"public"}
# Reuses data already fetched during resolution — only raw ID passthrough needs extra API call.
slack_resolve_target_with_privacy() {
  local target="$1"

  # Already a channel/DM ID — need conversations.info for privacy
  if [[ "$target" =~ ^[CDG][A-Z0-9]+$ ]]; then
    local info privacy
    info=$(slack_api_get "conversations.info" "channel=$target" 2>/dev/null) || true
    privacy=$(echo "${info:-{}}" | jq -r '.channel // {}' 2>/dev/null | slack_classify_privacy 2>/dev/null)
    # If the info lookup failed/was unparseable, fall back to the documented
    # "unknown" classification (consumers treat unknown as private) — never "".
    privacy="${privacy:-unknown}"
    jq -cn --arg id "$target" --arg p "$privacy" '{id:$id, privacy:$p}'
    return 0
  fi

  # User ID — open DM (inherently a DM)
  if [[ "$target" =~ ^U[A-Za-z0-9]+$ ]]; then
    local payload dm_response dm_id
    payload=$(jq -cn --arg users "$target" '{users:$users}')
    dm_response=$(slack_api_post_json "conversations.open" "$payload") || return $?
    dm_id=$(echo "$dm_response" | jq -r '.channel.id')
    jq -cn --arg id "$dm_id" '{id:$id, privacy:"dm"}'
    return 0
  fi

  # Channel name — resolve via conversations.list (already has privacy fields)
  local name="${target#\#}"
  local channels match
  channels=$(slack_paginate "conversations.list" ".channels // []" 1000 200 \
    "exclude_archived=true" "types=public_channel,private_channel") || return $?

  match=$(echo "$channels" | jq --arg name "$name" \
    '[ .[] | select(.name == $name) ] | first // null')

  if [ "$match" = "null" ] || [ -z "$match" ]; then
    slack_emit_error 5 "channel_not_found" \
      "Channel \"$name\" not found." \
      "Use 'slack channels list' to see available channels."
    return 5
  fi

  local id privacy
  id=$(echo "$match" | jq -r '.id')
  privacy=$(echo "$match" | slack_classify_privacy)
  privacy="${privacy:-unknown}"
  jq -cn --arg id "$id" --arg p "$privacy" '{id:$id, privacy:$p}'
}
