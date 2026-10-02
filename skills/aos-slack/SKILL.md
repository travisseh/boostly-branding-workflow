---
name: aos-slack
description: 'Use this skill when the user wants to send Slack messages, read
  channel history, search conversations, edit or delete messages, or share
  files. Trigger for sending ("send a message", "post in #channel", "DM
  @person", "tell the team"), reading ("what''s happening in #channel", "read
  the thread", "find the conversation about"), editing ("edit that message",
  "update my message", "fix the message I sent", "reword the post"), deleting
  ("delete that message", "remove my message", "clean up messages"), and sharing
  ("upload this file", "share in #channel"). Slash commands: /slack
  send|read|edit|delete|share. EXCLUDE: Slack app configuration, workspace
  admin, bot management.'
version: 1.3.0
author: '@mikeyamadeo'
requires:
  - bin:curl
  - bin:jq
  - env:SLACK_USER_OAUTH_TOKEN
allowed-tools: Bash, Read, Write
argument-hint: send|read|edit|delete|share [channel or description]
---

> Installed as `aos-slack`. Original upstream AOS skill name: `slack`.

# Slack

Send messages, read conversations, and share files — all via the co-located `slack` CLI.

## Commands

| Command | Purpose | Input |
|---------|---------|-------|
| `send` | Compose and send a message to a channel, thread, or DM | Target + message content |
| `read` | Read channel history, thread replies, or search messages | Channel/query |
| `edit` | Edit the text (or blocks) of a message already sent | Channel + timestamp + new content |
| `delete` | Delete a message | Channel + timestamp |
| `share` | Upload and share a file | File path + target |

## Cookbook

| Command | File | Use When |
|---------|------|----------|
| `send` | `cookbook/send.md` | User wants to post a message or DM someone |
| `read` | `cookbook/read.md` | User wants to see messages or find a conversation |
| `edit` | `cookbook/edit.md` | User wants to change a message they already sent |
| `delete` | `cookbook/delete.md` | User wants to delete a message |
| `share` | `cookbook/share.md` | User wants to upload a file to Slack |

Read the matching cookbook file first, then execute the steps.

## CLI

All commands use the co-located CLI at `scripts/slack` (relative to this skill's directory).
The CLI reads `SLACK_USER_OAUTH_TOKEN` from the environment (or `SLACK_TOKEN` as override).
User tokens (`xoxp-`) are required — see `references/setup.md` for setup instructions.

Every write follows remote-first safety: validate auth, draft and confirm with the user,
then execute. If the user cancels, stop — nothing is sent to Slack until the final confirmed step.

## CLI Commands Reference

```
slack auth check
slack channels list [--filter TEXT] [--limit N]
slack channels resolve CHANNEL
slack users lookup NAME [--limit N]
slack dms open USER_ID
slack messages read CHANNEL [--limit N] [--thread-ts TS]
slack messages search QUERY [--channel NAME] [--limit N]
slack messages send TARGET TEXT [--thread-ts TS] [--blocks-file PATH] [--strict-mentions] [--no-unfurl] [--dry-run]
slack messages edit TARGET TS NEWTEXT [--blocks-file PATH] [--strict-mentions] [--dry-run]
slack messages delete TARGET TS [--dry-run]
slack files upload TARGET FILE [--title T] [--comment C] [--thread-ts TS] [--dry-run]
```

Run a command with `--help` (or `-h`) as the first argument after the subcommand —
e.g. `slack messages send --help` — to print that command's flags and copy-pasteable
examples (works without a token).

`--dry-run` (on `messages send|edit|delete` and `files upload`) resolves the target and
prints the plan as JSON, performing **no** Slack write — use it to preview an action.

All command *results* are JSON on stdout, and errors are JSON on stderr. The one
exception is `--help`/`-h`, which prints human-readable usage text on stdout (the
discovery surface) — don't pipe help output through `jq`.
