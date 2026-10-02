# Edit — Change a Slack Message Already Sent

`messages edit` wraps Slack's `chat.update`. You can only edit messages your own token authored.

## Reference Loading

- **Tier 1 (load at start):** Read `references/safety.md`
- **Tier 2 (when resolving mentions in the new text):** Read `references/mention-resolution.md`
- **Tier 3 (when the new content uses blocks):** The `slack-ui` skill provides Block Kit composition guidance.

## Workflow

### Step 1: Validate

Run `scripts/slack auth check`. If it fails, stop and report.

### Step 2: Identify the message

The user must provide (or you must already know from a prior send/read/search):
- **Channel** — where the message lives
- **Timestamp** — the `ts` value of the message to edit

If you sent the message earlier in this session, reuse the `ts` from that `messages send` output. Otherwise help the user find it:
- `scripts/slack messages read <channel> --limit N` to browse recent messages
- `scripts/slack messages search "<query>"` to find by content

**Note on permalink timestamps:** `p`-prefixed permalink timestamps (e.g. `p1774538774123456`) need conversion: strip the `p`, insert a `.` before the last 6 digits → `1774538774.123456`. Convert before passing to the CLI.

### Step 3: Compose the new content

An edit is a **full replacement**, not a diff or an append. Pass the complete new message. A text-only edit also clears any existing Block Kit blocks and attachments, so the message becomes exactly the text you pass — to keep or change rich formatting, supply it via `--blocks-file` in the same call.

- Multi-line content: pass via `"$(cat /tmp/msg.txt)"` so newlines and quotes survive.
- Resolve any `@mentions` in the new text first (see `references/mention-resolution.md`), then pass `--strict-mentions` to catch any you missed.
- To change Block Kit content, pass `--blocks-file PATH` (same JSON-array format as `send`; a first element with a `color` key is treated as attachments). Keep the positional `NEWTEXT` as the notification fallback.

### Step 4: Preview and confirm

Editing changes content others may have already read. Show the user:
- **Channel:** #channel-name
- **Timestamp:** ts value
- **New message:** the final text (with resolved mentions)

Ask for explicit confirmation before applying the edit.

### Step 5: Edit

Text only:
```
scripts/slack messages edit <channel> <ts> "<new_text>" --strict-mentions
```

With blocks:
```
scripts/slack messages edit <channel> <ts> "<fallback_text>" --blocks-file <path> --strict-mentions
```

Report the result: `{ok, channel, ts, message}`. Re-editing to identical content still returns `ok`, so retries are safe.

Handle errors:
- `cant_update_message` — you can only edit your own messages; some message types (other apps/bots) are not editable
- `edit_window_closed` — the workspace limits how long a message stays editable; it's too old
- `message_not_found` — already deleted, or the timestamp is wrong
- `msg_too_long` — the new text exceeds Slack's length limit; shorten and retry

## Edit vs delete-and-resend

Prefer `edit` to fix wording, formatting, or a wrong link — it preserves the message's position, timestamp, and any reactions/replies. Use delete-and-resend only when the message must move to a different channel or thread.

## Red Flags

- Editing without confirming the new content with the user
- Treating `edit` as append — it replaces the whole message; include all content you want to keep
- Editing a message the user didn't author (will fail with `cant_update_message`)
- Leaving `@mentions` unresolved in the new text (edit succeeds but the mention won't render/notify)
