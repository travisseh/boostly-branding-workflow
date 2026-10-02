#!/usr/bin/env bash
# help.sh — Usage and per-subcommand help text.
#
# Help is intercepted in the dispatcher BEFORE token/dependency init so that
# `slack <cmd> <sub> --help` works without a configured token. Each subcommand
# prints only its own flags plus at least one copy-pasteable Example, so an
# agent discovering flags via `--help` never pulls unrelated command docs into
# context.

# Top-level usage. Prints to stdout; the dispatcher's unknown-command arm
# redirects this to stderr and exits non-zero.
slack_usage_top() {
  cat <<'USAGE'
Usage: slack <command> <subcommand> [args]

Commands:
  auth check                                    Validate token and show auth info
  channels list [--filter TEXT] [--limit N]      List channels
  channels resolve CHANNEL                       Resolve channel to {id, name, privacy}
  users lookup NAME [--limit N]                  Search users by name
  dms open USER_ID                               Open DM channel
  messages read CHANNEL [--limit N] [--thread-ts TS]   Read messages
  messages search QUERY [--channel NAME] [--limit N]   Search messages
  messages send TARGET TEXT [--thread-ts TS] [--blocks-file PATH] [--strict-mentions] [--no-unfurl] [--dry-run]  Send message
  messages edit TARGET TS NEWTEXT [--blocks-file PATH] [--strict-mentions] [--dry-run]  Edit a message
  messages delete TARGET TS [--dry-run]                   Delete a message
  files upload TARGET FILE [--title T] [--comment C] [--thread-ts TS] [--dry-run]  Upload file

Run 'slack <command> <subcommand> --help' for a command's flags and examples.
--dry-run (on send/edit/delete/upload) resolves the plan and makes no Slack write.

Examples:
  slack auth check
  slack channels resolve '#general'
  slack messages read '#general' --limit 20
  slack messages send '#general' 'Deploy finished :rocket:'
  slack messages send '#ops' 'Preview me' --dry-run
USAGE
}

# Per-subcommand help. Arg is "$COMMAND:$SUBCOMMAND". Prints to stdout and
# returns 0 for a known pair; returns 1 (printing nothing) for an unknown pair
# so the caller can fall back to top-level usage.
slack_help_for() {
  case "$1" in
    auth:check)
      cat <<'EOF'
slack auth check — Validate the Slack token and report auth context

Usage:
  slack auth check

Examples:
  slack auth check
EOF
      ;;
    channels:list)
      cat <<'EOF'
slack channels list — List public and private channels

Usage:
  slack channels list [--filter TEXT] [--limit N]

Flags:
  --filter TEXT   Case-insensitive substring match on channel name
  --limit N       Max channels to return (default 100)

Examples:
  slack channels list
  slack channels list --filter eng --limit 50
EOF
      ;;
    channels:resolve)
      cat <<'EOF'
slack channels resolve — Resolve a channel name or ID to canonical {id, name, privacy}

Usage:
  slack channels resolve CHANNEL

Arguments:
  CHANNEL   Channel name (#general or general) or channel ID (C…)

Output:
  {id, name, privacy} — privacy is public/private/dm/group_dm/unknown

Examples:
  slack channels resolve '#general'
  slack channels resolve C0123456789
EOF
      ;;
    users:lookup)
      cat <<'EOF'
slack users lookup — Search users by display name, real name, or username

Usage:
  slack users lookup NAME [--limit N]

Arguments:
  NAME   Case-insensitive substring to match (exact matches rank first)

Flags:
  --limit N   Max users to return (default 5)

Examples:
  slack users lookup mikey
  slack users lookup "jane doe" --limit 10
EOF
      ;;
    dms:open)
      cat <<'EOF'
slack dms open — Open a DM channel with a user and return its channel ID

Usage:
  slack dms open USER_ID

Arguments:
  USER_ID   Slack user ID (U…). Use 'slack users lookup' to find one.

Examples:
  slack dms open U0123456789
EOF
      ;;
    messages:read)
      cat <<'EOF'
slack messages read — Read channel history or thread replies

Usage:
  slack messages read CHANNEL [--limit N] [--thread-ts TS]

Arguments:
  CHANNEL   Channel name (#general), channel ID (C…), or user ID (U…) for a DM

Flags:
  --limit N        Max messages to return (default 10, capped at 100)
  --thread-ts TS   Read replies in the thread rooted at TS instead of channel history

Examples:
  slack messages read '#general' --limit 20
  slack messages read C0123456789 --thread-ts 1774538774.123456
EOF
      ;;
    messages:search)
      cat <<'EOF'
slack messages search — Full-text search across messages

Usage:
  slack messages search QUERY [--channel NAME] [--limit N]

Arguments:
  QUERY   Search text (Slack search operators allowed)

Flags:
  --channel NAME   Restrict to a channel (adds in:#NAME to the query)
  --limit N        Max results (default 10, capped at 50)

Examples:
  slack messages search "deploy failed"
  slack messages search incident --channel ops --limit 25
EOF
      ;;
    messages:send)
      cat <<'EOF'
slack messages send — Send a message to a channel, DM, or thread

Usage:
  slack messages send TARGET TEXT [--thread-ts TS] [--blocks-file PATH] [--strict-mentions] [--no-unfurl] [--dry-run]

Arguments:
  TARGET   Channel name (#general), channel ID (C…), or user ID (U…) for a DM
  TEXT     Message text (mrkdwn). Mentions must be <@USER_ID>.

Flags:
  --thread-ts TS       Reply in the thread rooted at TS
  --blocks-file PATH   JSON file with an array of Block Kit blocks (or attachments if the first has "color")
  --strict-mentions    Fail if TEXT contains unresolved bare @mentions
  --no-unfurl          Disable link/media unfurling
  --dry-run            Resolve the target and print the plan; make no Slack write

Examples:
  slack messages send '#general' 'Deploy finished :rocket:'
  slack messages send C0123456789 'Hi <@U0123456789>' --strict-mentions
  slack messages send '#ops' 'See attached' --blocks-file ./blocks.json --dry-run
EOF
      ;;
    messages:edit)
      cat <<'EOF'
slack messages edit — Edit (replace) an existing message by channel + timestamp

Usage:
  slack messages edit TARGET TS NEWTEXT [--blocks-file PATH] [--strict-mentions] [--dry-run]

Arguments:
  TARGET    Channel name (#general), channel ID (C…), or user ID (U…) for a DM
  TS        Timestamp of the message to edit (e.g. 1774538774.123456)
  NEWTEXT   Replacement text. Edit replaces content fully (clears prior blocks/attachments).

Flags:
  --blocks-file PATH   JSON file with an array of Block Kit blocks (or attachments if the first has "color")
  --strict-mentions    Fail if NEWTEXT contains unresolved bare @mentions
  --dry-run            Resolve the target and print the plan; make no Slack write

Examples:
  slack messages edit '#general' 1774538774.123456 'Updated text'
  slack messages edit C0123456789 1774538774.123456 'New copy' --dry-run
EOF
      ;;
    messages:delete)
      cat <<'EOF'
slack messages delete — Delete a message by channel + timestamp

Usage:
  slack messages delete TARGET TS [--dry-run]

Arguments:
  TARGET   Channel name (#general), channel ID (C…), or user ID (U…) for a DM
  TS       Timestamp of the message to delete (e.g. 1774538774.123456)

Flags:
  --dry-run   Resolve the target and print the plan; make no Slack write

Examples:
  slack messages delete '#general' 1774538774.123456
  slack messages delete C0123456789 1774538774.123456 --dry-run
EOF
      ;;
    files:upload)
      cat <<'EOF'
slack files upload — Upload a file to a channel, DM, or thread

Usage:
  slack files upload TARGET FILE [--title T] [--comment C] [--thread-ts TS] [--dry-run]

Arguments:
  TARGET   Channel name (#general), channel ID (C…), or user ID (U…) for a DM
  FILE     Path to a local file (max 50 MB)

Flags:
  --title T        Title shown in Slack (defaults to the filename)
  --comment C      Initial comment posted with the file
  --thread-ts TS   Attach to the thread rooted at TS
  --dry-run        Run preflight + resolve the target and print the plan; upload nothing

Examples:
  slack files upload '#general' ./report.pdf --title 'Q2 report'
  slack files upload C0123456789 ./log.txt --comment 'see attached' --dry-run
EOF
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}
