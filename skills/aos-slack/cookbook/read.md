# Read — Read or Search Slack Messages

## Reference Loading

- **Tier 1 (load at start):** Read `references/privacy.md`

## Workflow

### Step 1: Determine intent

Three modes — pick based on what the user asked:
- **Channel history** — "what's happening in #general", "show me recent messages"
- **Thread** — "read that thread", "show replies to..."
- **Search** — "find where we discussed pricing", "search for deployment messages"

### Step 2: Resolve channel (if needed)

The CLI commands accept channel names directly — only pre-resolve when the name is ambiguous.

- **Unambiguous name** (e.g., "#general") — pass directly to the command in Step 3.
- **Ambiguous name** (e.g., "the dev channel") — run `scripts/slack channels list --filter <name>` to disambiguate. Show options and ask.

### Step 3: Execute

**Channel history:**
`scripts/slack messages read <channel> [--limit N]`

**Thread:**
`scripts/slack messages read <channel> --thread-ts <ts>`

**Search:**
`scripts/slack messages search "<query>" [--channel <name>] [--limit N]`

Slack supports modifiers: `from:username`, `in:#channel`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`, `has:link`, `has:emoji`. Use these when they match user intent.

### Step 4: Present results

Summarize the messages. Include timestamps and permalinks for reference. For search, include total match count.

Note the `privacy` field in the output. If messages are from a private channel, DM, or group DM, mention this when presenting results (e.g., "From private channel #secret-strategy:").

For search results, each result may have a different `privacy` level — note privacy per result when levels are mixed.

### Step 5: Offer follow-ups

- "Want me to expand the window?" (increase limit)
- "Want me to read that thread?" (if a message has replies)
- "Want me to search more specifically?"

## Red Flags

- Reading an entire channel with no limit (overwhelming output)
- Not resolving channel name before reading (will fail)
