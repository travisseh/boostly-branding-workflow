# Delete — Delete a Slack Message

## Reference Loading

- **Tier 1 (load at start):** Read `references/safety.md`

## Workflow

### Step 1: Validate

Run `scripts/slack auth check`. If it fails, stop and report.

### Step 2: Identify the message

The user must provide:
- **Channel** — where the message lives
- **Timestamp** — the `ts` value of the message to delete

If the user doesn't have the timestamp, help them find it:
- `scripts/slack messages read <channel> --limit N` to browse recent messages
- `scripts/slack messages search "<query>"` to find by content
- Each message in the output includes a `ts` field

**Note on permalink timestamps:** Users sometimes copy `p`-prefixed timestamps from Slack permalinks (e.g. `p1774538774123456`). These need conversion: strip the `p`, insert a `.` before the last 6 digits → `1774538774.123456`. Do this conversion before passing to the CLI command.

### Step 3: Preview and confirm

**Preview is required.** Before deleting, always show the message content. If the message wasn't already visible from a prior read/search, fetch it:
- `scripts/slack messages read <channel> --limit 1 --thread-ts <ts>` (or find it in recent history)

Show the user:
- **Channel:** #channel-name
- **Author:** who posted it
- **Message:** the full text
- **Timestamp:** ts value

**Warn explicitly:** "This will permanently delete the message. This cannot be undone."

Ask for explicit confirmation before proceeding.

### Step 4: Delete

Run: `scripts/slack messages delete <channel> <ts>`

Report the result. Handle errors:
- `cant_delete_message` — user can only delete their own messages (unless admin)
- `message_not_found` — message was already deleted or timestamp is wrong
- `compliance_exports_prevent_deletion` — enterprise compliance hold prevents deletion

### Step 5: Offer follow-ups

- "Want me to delete more messages?"
- "Want me to read the channel to verify it's gone?"

## Thread Deletion

Delete works on individual messages, including thread replies. Each reply has its own `ts` in the same channel. To delete an entire thread:
1. Read the thread: `scripts/slack messages read <channel> --thread-ts <parent_ts>`
2. Delete each reply individually (one confirm per message)
3. Delete the parent message last

This requires N+1 API calls. Warn the user about the scope before starting.

## Batch Deletion

When deleting multiple messages (e.g., cleanup), go one at a time:
1. Show each message before deleting
2. Confirm each deletion individually
3. If a delete fails (rate limit, permission), stop and report — don't continue silently

Do NOT batch-confirm multiple deletions at once.

## Red Flags

- Deleting without confirming with the user (destructive + irreversible)
- Bulk deletion without individual confirmation
- Deleting messages the user didn't author (will fail without admin token)
- Continuing after a failed delete in a batch sequence
