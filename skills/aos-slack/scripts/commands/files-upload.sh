#!/usr/bin/env bash
# files-upload.sh — Upload a file via Slack's 3-step external upload flow

MAX_FILE_SIZE=$((50 * 1024 * 1024))  # 50 MB

cmd_files_upload() {
  local target="" file_path="" title="" comment="" thread_ts="" dry_run=false

  if [ $# -lt 2 ]; then
    slack_emit_error 2 "missing_arg" \
      "Usage: slack files upload TARGET FILE [--title T] [--comment C] [--thread-ts TS]"
    exit 2
  fi

  target="$1"; shift
  file_path="$1"; shift

  while [ $# -gt 0 ]; do
    case "$1" in
      --title)     title="$2"; shift 2 ;;
      --comment)   comment="$2"; shift 2 ;;
      --thread-ts) thread_ts="$2"; shift 2 ;;
      --dry-run)   dry_run=true; shift ;;
      *) slack_emit_error 2 "invalid_arg" "Unknown argument: $1"; exit 2 ;;
    esac
  done

  # --- Preflight ---

  # Validate file exists
  if [ ! -f "$file_path" ]; then
    slack_emit_error 6 "file_not_found" "File not found: $file_path"
    exit 6
  fi

  # Get file size
  local file_size
  file_size=$(wc -c < "$file_path" | tr -d ' ')

  if [ "$file_size" -le 0 ]; then
    slack_emit_error 6 "empty_file" "File is empty: $file_path"
    exit 6
  fi

  if [ "$file_size" -gt "$MAX_FILE_SIZE" ]; then
    local size_mb
    size_mb=$(echo "scale=1; $file_size / 1024 / 1024" | bc)
    slack_emit_error 6 "file_too_large" \
      "File too large (${size_mb} MB). Maximum is 50 MB."
    exit 6
  fi

  local filename
  filename=$(basename "$file_path")
  [ -z "$title" ] && title="$filename"

  local channel_id
  channel_id=$(slack_resolve_target "$target" "$dry_run") || exit $?

  if [ "$dry_run" = true ]; then
    local extra
    extra=$(jq -n --arg file "$file_path" --arg filename "$filename" --argjson size "$file_size" \
      --arg title "$title" --arg comment "$comment" --arg thread_ts "$thread_ts" '{
        file: $file, filename: $filename, size_bytes: $size, title: $title,
        comment: (if $comment != "" then $comment else null end),
        thread_ts: (if $thread_ts != "" then $thread_ts else null end)
      }')
    slack_emit_dry_run "files.getUploadURLExternal+files.completeUploadExternal" "upload" "$channel_id" "$extra"
    return 0
  fi

  # --- Step 1: Get upload URL ---

  local step1_response upload_url file_id
  step1_response=$(slack_api_get "files.getUploadURLExternal" \
    "filename=$filename" "length=$file_size") || exit $?

  upload_url=$(echo "$step1_response" | jq -r '.upload_url // empty')
  file_id=$(echo "$step1_response" | jq -r '.file_id // empty')

  if [ -z "$upload_url" ] || [ -z "$file_id" ]; then
    slack_emit_error 4 "upload_init_failed" \
      "Failed to get upload URL from Slack."
    exit 4
  fi

  # --- Step 2: Upload file bytes ---

  slack_upload_binary "$upload_url" "$file_path" || exit $?

  # --- Step 3: Complete upload ---

  local files_json
  files_json=$(jq -cn --arg id "$file_id" --arg title "$title" '[{id:$id,title:$title}]')

  local complete_args=("files=$files_json" "channel_id=$channel_id")
  [ -n "$comment" ] && complete_args+=("initial_comment=$comment")
  [ -n "$thread_ts" ] && complete_args+=("thread_ts=$thread_ts")

  local step3_response
  step3_response=$(slack_api_post_form "files.completeUploadExternal" \
    "${complete_args[@]}") || exit $?

  # Extract permalink (may be nested)
  local permalink
  permalink=$(echo "$step3_response" | jq -r '.files[0].files[0].permalink // .files[0].permalink // empty')

  # Fallback: get permalink from files.info
  if [ -z "$permalink" ]; then
    local info_response
    info_response=$(slack_api_get "files.info" "file=$file_id" 2>/dev/null) || true
    permalink=$(echo "${info_response:-}" | jq -r '.file.permalink // empty')
  fi

  jq -cn --arg file_id "$file_id" --arg permalink "$permalink" --arg channel "$channel_id" \
    '{ok:true, file_id:$file_id, permalink:$permalink, channel:$channel}'
}

cmd_files_upload "$@"
