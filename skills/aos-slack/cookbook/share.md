# Share — Upload a File to Slack

## Reference Loading

- **Tier 1:** Read `references/safety.md`, `references/privacy.md`

## Workflow

### Step 1: Validate

Run `scripts/slack auth check`. Verify the file exists and is under 50MB.

### Step 2: Resolve target

Same as send cookbook Step 2 — resolve channel or DM.

### Step 3: Resolve mentions in comment (if any)

If the user provided a comment message with @mentions, follow the mention-resolution reference (same as send cookbook Step 3).

### Step 4: Preview and confirm

Show:
- **File:** path, size, type
- **To:** #channel or @person
- **Title:** (if provided)
- **Comment:** (if provided, with resolved mentions)

**Privacy cross-check:** If the file was obtained from or relates to a prior `messages read` or `messages search`, compare the source's `privacy` field to the target's privacy. A person/DM target is `dm`; for a channel, run `scripts/slack channels resolve <name>` and read its `privacy` field, or reuse a prior read's `privacy`. If the source is more private than the target (e.g., DM content → public channel), warn the user and ask for explicit confirmation. For DM-sourced files, suggest describing the content rather than sharing the original file. See `references/privacy.md` for the full cross-privacy rules.

### Step 5: Upload

Run: `scripts/slack files upload <channel_id> <file_path> [--title "..."] [--comment "..."] [--thread-ts <ts>]`

Report: file_id, permalink.

## Red Flags

- Uploading without checking file size first
- Uploading sensitive files (credentials, .env) — warn if filename matches common patterns
