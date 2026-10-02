---
name: message-me
description: Deliver a blocker or status message to the operator's inbox. In this package the iMessage bridge is replaced by a file inbox; the fulfillment scripts call this when a preflight blocks a batch or a review needs a human.
---

# message-me (operator inbox stub)

On Travisse's machine this skill texts him over an iMessage bridge. On an operator machine there is
no bridge, so `scripts/message_me.py` appends the message to `$BOOSTLY_RUN_ROOT/inbox/messages.log`
(mode 0600) and prints a one-line notice to stderr. Callers only need a zero exit.

```bash
python3 ~/.claude/skills/message-me/scripts/message_me.py "<text>"
python3 ~/.claude/skills/message-me/scripts/message_me.py @/path/to/file.md
echo "text" | python3 ~/.claude/skills/message-me/scripts/message_me.py -
```

Read the inbox after a preflight stop:

```bash
tail -n 40 "$BOOSTLY_RUN_ROOT/inbox/messages.log"
```

Escalations that need Travisse go to him in Slack; this file is a local record, not a notification.
