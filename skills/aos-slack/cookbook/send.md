# Send — Compose and Send a Slack Message

## Reference Loading

- **Tier 1 (load at start):** Read `references/safety.md`, `references/privacy.md`
- **Tier 2 (when resolving mentions):** Read `references/mention-resolution.md`
- **Tier 3 (when composing blocks):** The `slack-ui` skill provides Block Kit composition guidance. If it hasn't already been loaded in this conversation, read its SKILL.md.

## Workflow

### Step 1: Validate

Run `scripts/slack auth check`. If it fails, stop and report the error.

### Step 2: Resolve target

Determine where to send. The CLI commands accept channel names directly and resolve them internally — only use `channels list` when you need to disambiguate.

- **Unambiguous channel** (e.g., "#home-team") — pass the name directly to `messages send`. No pre-resolution needed.
- **Ambiguous channel** (e.g., "the engineering channel") — run `scripts/slack channels list --filter <name>` to disambiguate. Show options and ask.
- **DM by person** — run `scripts/slack users lookup <name>`. If one match, use the user ID as the target (the CLI opens the DM automatically). If multiple matches, show candidates (display_name, real_name, username) and ask user to pick.
- **Channel/user ID** — use directly.

### Step 3: Resolve mentions in message text

Follow `references/mention-resolution.md`. For each @name in the message:
1. Run `scripts/slack users lookup <name>`
2. If exactly one match — replace with `<@USER_ID>`
3. If multiple — show candidates, ask user to pick, then replace
4. If none found — warn user, leave as plain text or ask to remove
5. Skip @here, @channel, @everyone (Slack handles these natively)

### Step 4: Privacy cross-check

**Obtain target privacy** (no remote side effects before confirmation):
- **Person / DM target** → privacy is `dm` by definition.
- **Channel target** → run `scripts/slack channels resolve <name>` and read the `privacy` field from its `{id, name, privacy}` output (exact match, no side effects, works on empty channels). Or reuse the `privacy` from a prior read/search of that channel. Don't use `messages read` just to learn target privacy — it opens the DM for a person target and returns no privacy for an empty channel.

If the message content was derived from **any** prior `messages read` or `messages search`, compare each source's `privacy` to the target's, using the sensitivity order `public` < `private` < `dm` = `group_dm` (treat `unknown` as `private`):
- Any source **more sensitive than the target** → warn the user before drafting (e.g. `private`/`dm`/`group_dm` → `public`, or `group_dm`/`dm` → `private`)
- Source is `dm` or `group_dm` → also suggest paraphrasing over direct quoting
- Multiple sources at different levels → apply the mixed-source rule from `references/privacy.md` (treat the whole message at the highest sensitivity present)
- If unsure about source privacy, ask

This check happens before drafting so the user can adjust the message content.

### Step 5: Compose blocks (when warranted)

Read `references/rich-ui.md` for block vocabulary and composition principles.

**Decide:** does this message benefit from blocks? Structured data, action items, status changes, deep links, or visual hierarchy → yes. Conversational reply or quick FYI → no, plain text is fine.

If composing blocks:
1. Choose blocks based on the content and principles in the reference
2. Build the blocks JSON array
3. Write it to a temp file (e.g., `/tmp/slack-blocks-XXXXX.json`)
4. The `text` parameter becomes the notification fallback — write a plain-text summary of the message (shown in push notifications and non-Block Kit clients)

If using a colored sidebar for urgency, wrap blocks inside an attachment:
```json
[{"color": "#E01E5A", "blocks": [...]}]
```
And pass the attachment array as the blocks file. Note: when using attachments, the top-level payload uses `attachments` not `blocks` — the CLI handles both via `--blocks-file`.

### Step 6: Draft and confirm

Show the user:
- **To:** #channel-name or @person-name (DM)
- **Thread:** (if replying) timestamp
- **Message:** the final text with resolved mentions
- **Blocks:** (if composed) summary of block types and count, e.g., "header + 2 sections + divider + context (5 blocks)". Offer to show full JSON on request.

Ask for confirmation before sending.

### Step 7: Send

**Text-only:**
Run: `scripts/slack messages send <channel_id> "<resolved_text>" [--thread-ts <ts>] --strict-mentions`

**With blocks:**
Run: `scripts/slack messages send <channel_id> "<fallback_text>" --blocks-file <path> [--thread-ts <ts>] --strict-mentions`

Report the result: channel, timestamp.
If `--strict-mentions` catches an unresolved @mention, report it and ask whether to fix or send anyway (re-run without --strict-mentions).

## Red Flags

- Sending without confirming the target channel
- Leaving @mentions unresolved (message sends but doesn't notify)
- Composing the message in a way that's too formal/robotic for Slack
