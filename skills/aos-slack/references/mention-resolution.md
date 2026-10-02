# Mention Resolution

Process for converting human names to Slack user mentions before sending.

## Steps

1. Identify @mentions in the message text (bare @name patterns).
2. For each @name:
   a. Skip @here, @channel, @everyone — Slack handles these natively.
   b. Run: `scripts/slack users lookup <name>`
   c. **One match** — replace @name with `<@USER_ID>`.
   d. **Multiple matches** — show candidates to user, ask them to pick.
   e. **No matches** — warn user. Options: remove mention, try different name, or send as-is.
3. After all mentions resolved, the message is ready for send.

## Why This Lives in the Skill

The CLI's `users lookup` returns raw candidates. Claude handles disambiguation
because it understands context ("message @John about the deploy" — Claude knows
which John based on conversation context). This is strictly better than regex-based
multi-word matching.

## The --strict-mentions Safety Net

The CLI's `messages send --strict-mentions` flag catches any remaining bare @word
patterns and fails instead of silently sending. This ensures the skill didn't miss
a mention. If it fires, re-resolve the flagged mention before retrying.
