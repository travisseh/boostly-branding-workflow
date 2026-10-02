# Setup — Getting the Slack Skill Working

## Prerequisites

- `curl` and `jq` installed (`brew install curl jq`)
- A `.env` file at the workspace root

## Quick Start (Existing App)

If someone on your workspace already has a Slack app set up (e.g., "Bizfeed Bot" on Boostly):

1. Ask them to share the app's **OAuth & Permissions** page URL
2. Click **"Add to Slack"** or have an admin authorize you
3. Copy your **User OAuth Token** (`xoxp-...`) from the OAuth & Permissions page
4. Add it to your `.env`:
   ```
   SLACK_USER_OAUTH_TOKEN=xoxp-your-token-here
   ```
5. Verify: `scripts/slack auth check`

## New Workspace Setup

### Step 1: Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From scratch**
3. Name it (e.g., "Claude Slack"), select your workspace

### Step 2: Add OAuth Scopes

Go to **OAuth & Permissions** → **Scopes**.

**User Token Scopes** (required — the skill uses user tokens):

| Scope | Purpose |
|---|---|
| `channels:history` | Read public channel messages |
| `channels:read` | List public channels |
| `chat:write` | Send and delete messages |
| `files:read` | View shared files |
| `files:write` | Upload and delete files |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read DM messages |
| `im:read` | List DM channels |
| `im:write` | Open DMs |
| `mpim:history` | Read group DM messages |
| `reactions:read` | View reactions |
| `reactions:write` | Add/remove reactions |
| `search:read` | Search messages |
| `users:read` | Look up users |
| `users.profile:read` | View user profiles |

**Bot Token Scopes** (optional — only if you want a shared bot identity):

| Scope | Purpose |
|---|---|
| `channels:history` | Read public channels the bot is in |
| `channels:read` | List public channels |
| `chat:write` | Send messages as the bot |
| `groups:history` | Read private channels the bot is in |
| `im:history` | Read DMs with the bot |
| `reactions:read` | View reactions |
| `users:read` | Look up users |
| `users.profile:read` | View user profiles |

**Do NOT add** `identity.*` scopes (identity.basic, identity.avatar, etc.) — these are Sign in with Slack scopes and cannot be combined with API scopes.

### Step 3: Install to Workspace

1. Click **Install to Workspace** on the OAuth & Permissions page
2. Authorize the requested permissions
3. Copy the **User OAuth Token** (`xoxp-...`)

### Step 4: Configure

Add the token to your workspace `.env`:

```
SLACK_USER_OAUTH_TOKEN=xoxp-your-token-here
```

### Step 5: Verify

```bash
scripts/slack auth check
```

Should return `{"ok": true, ...}` with your user info.

## Token Types

| Variable | Token | Identity |
|---|---|---|
| `SLACK_USER_OAUTH_TOKEN` | `xoxp-...` | Acts as you — messages show your name, access follows your permissions |
| `SLACK_TOKEN` | `xoxp-...` | Direct override (takes precedence over `SLACK_USER_OAUTH_TOKEN`) |

The skill requires a **user token** (`xoxp-`). Bot tokens (`xoxb-`) are not supported — they can't search messages, and access control follows the bot's channel membership instead of the user's.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `token_missing` error | No token in `.env` | Add `SLACK_USER_OAUTH_TOKEN` |
| `invalid_auth` error | Token is wrong or revoked | Regenerate at api.slack.com/apps |
| `missing_scope` error | Token doesn't have required scope | Add scope in app settings, **reinstall** to activate |
| Search returns empty | Using bot token (`xoxb-`) | Switch to user token — search requires `xoxp-` |
| Can't see private channels | Missing `groups:read` scope | Add scope, reinstall |
| `invalid_scope` on install | Incompatible scopes added | Remove `identity.*` scopes and any deprecated scopes |

## Adding New Users (Same Workspace)

Each user who wants the skill to act as them needs their own user token:

1. They authorize the same Slack app (admin may need to approve)
2. They get their own `xoxp-` token
3. They add it to their local `.env`

The bot token (`xoxb-`) is shared across all users on the workspace — one per install.
