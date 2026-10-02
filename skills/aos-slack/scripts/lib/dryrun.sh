#!/usr/bin/env bash
# dryrun.sh — Render a --dry-run plan as JSON without performing any Slack write.
#
# Single owner of the dry-run output contract so the four write commands
# (messages send|edit|delete, files upload) don't each re-derive the envelope
# and the DM-target branch (which is how a stale per-command note drifted out of
# sync). The note's action verb comes from $2 — never hand-write it per command.

# slack_emit_dry_run <method> <verb> <channel> [extra_json]
#   method  — API method(s) the real call would invoke (shown as would_call)
#   verb    — action for the DM note ("send"/"edit"/"delete"/"upload")
#   channel — resolved channel id; a U… id is an unresolved DM in dry-run
#             (slack_resolve_target leaves it unopened to avoid a side effect)
#   extra   — JSON object of command-specific plan fields (default {})
slack_emit_dry_run() {
  local method="$1" verb="$2" channel="$3" extra="${4:-}"
  [ -z "$extra" ] && extra='{}'
  jq -n --arg method "$method" --arg verb "$verb" --arg channel "$channel" \
        --argjson extra "$extra" '
    {
      ok: true,
      dry_run: true,
      would_call: $method,
      plan: (
        (if ($channel | test("^U[A-Za-z0-9]+$"))
           then {channel: null, dm_with_user: $channel,
                 note: ("DM channel is opened at " + $verb + " time; not resolved in dry-run.")}
           else {channel: $channel} end)
        + $extra
      )
    }'
}
