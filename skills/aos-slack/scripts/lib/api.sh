#!/usr/bin/env bash
# api.sh — Slack API HTTP execution and error normalization

# Map Slack error codes to actionable hints
slack_error_hint() {
  case "$1" in
    missing_scope)     echo "Token missing required scope. Add it at https://api.slack.com/apps under OAuth & Permissions." ;;
    not_in_channel)    echo "Not a member of this channel. Invite the bot or use a user token with appropriate scopes." ;;
    invalid_auth)      echo "Token is invalid. Regenerate at https://api.slack.com/apps." ;;
    token_revoked)     echo "Token has been revoked. Create a new one at https://api.slack.com/apps." ;;
    account_inactive)  echo "Account is inactive or disabled." ;;
    channel_not_found) echo "Channel not found. Use 'slack channels list' to see available channels." ;;
    thread_not_found)  echo "Thread not found. Verify the thread timestamp is correct." ;;
    user_not_found)    echo "User not found. Use 'slack users lookup' to search." ;;
    ratelimited)       echo "Rate limited by Slack. Wait and retry." ;;
    cant_delete_message)  echo "Cannot delete this message. You can only delete your own messages unless you have admin privileges." ;;
    cant_update_message)  echo "Cannot edit this message. You can only edit your own messages, and some message types (e.g. those posted by other apps/bots) are not editable." ;;
    edit_window_closed)   echo "The message is too old to edit. Slack workspaces can limit how long a message stays editable." ;;
    msg_too_long)         echo "The new message text exceeds Slack's length limit. Shorten it and retry." ;;
    message_not_found)    echo "Message not found. It may have already been deleted, or the timestamp is wrong." ;;
    compliance_exports_prevent_deletion) echo "Enterprise compliance hold prevents deletion of this message." ;;
    *)                 echo "Slack API error: $1" ;;
  esac
}

# Internal: parse response, check .ok, emit error if needed.
# Single jq pass for validation + ok check + error extraction.
# Prints body on success, returns 4 on failure.
_slack_check_response() {
  local body="$1" endpoint="$2"
  local parsed
  parsed=$(echo "$body" | jq -r '[(.ok // false | tostring), (.error // "unknown")] | @tsv' 2>/dev/null) || {
    slack_emit_error 4 "invalid_response" "Non-JSON response from $endpoint"
    return 4
  }
  local ok err
  IFS=$'\t' read -r ok err <<< "$parsed"
  if [ "$ok" != "true" ]; then
    slack_emit_error 4 "$err" "$(slack_error_hint "$err")"
    return 4
  fi
  echo "$body"
}

# GET request with query params passed as key=value args
slack_api_get() {
  local endpoint="$1"; shift
  local url="${SLACK_API_BASE}/${endpoint}"

  # Build query string
  local query_args=()
  for kv in "$@"; do
    query_args+=(--data-urlencode "$kv")
  done

  local body
  body=$(curl -sS --get "$url" \
    -H "Authorization: Bearer ${SLACK_TOKEN}" \
    "${query_args[@]+"${query_args[@]}"}") || {
    slack_emit_error 4 "http_error" "Failed to connect to Slack API ($endpoint)"
    return 4
  }

  _slack_check_response "$body" "$endpoint"
}

# POST with JSON body
slack_api_post_json() {
  local endpoint="$1" payload="$2"
  local url="${SLACK_API_BASE}/${endpoint}"

  local body
  body=$(curl -sS -X POST "$url" \
    -H "Authorization: Bearer ${SLACK_TOKEN}" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$payload") || {
    slack_emit_error 4 "http_error" "Failed to connect to Slack API ($endpoint)"
    return 4
  }

  _slack_check_response "$body" "$endpoint"
}

# POST with form fields passed as key=value args
slack_api_post_form() {
  local endpoint="$1"; shift
  local url="${SLACK_API_BASE}/${endpoint}"

  local form_args=()
  for kv in "$@"; do
    form_args+=(-F "$kv")
  done

  local body
  body=$(curl -sS -X POST "$url" \
    -H "Authorization: Bearer ${SLACK_TOKEN}" \
    "${form_args[@]+"${form_args[@]}"}") || {
    slack_emit_error 4 "http_error" "Failed to connect to Slack API ($endpoint)"
    return 4
  }

  _slack_check_response "$body" "$endpoint"
}

# Upload file bytes to a presigned URL (non-Slack host)
# Returns 0 only for HTTP 200
slack_upload_binary() {
  local upload_url="$1" file_path="$2"

  local http_code
  http_code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST "$upload_url" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${file_path}") || {
    slack_emit_error 4 "upload_http_error" "Failed to upload file to presigned URL"
    return 4
  }

  if [ "$http_code" != "200" ]; then
    slack_emit_error 4 "upload_http_error" "Upload returned HTTP $http_code (expected 200)"
    return 4
  fi
}
