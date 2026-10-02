#!/usr/bin/env python3
"""boostly-branding-workflow stub for the message-me skill.

On Travisse's machine this script texts him over iMessage. On an operator machine there is no
iMessage bridge, so a blocker message is written to <BOOSTLY_RUN_ROOT>/inbox/messages.log and
echoed to stderr. The calling scripts (preflight-fulfillment-batch.ts, notify-fulfillment-review.ts)
only need the call to succeed. Read the inbox log, then escalate to Travisse by Slack yourself.

Usage: message_me.py <text | @file | ->
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path


def read_body(arg: str) -> str:
    if arg == "-":
        return sys.stdin.read()
    if arg.startswith("@"):
        return Path(arg[1:]).read_text()
    return arg


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: message_me.py <text | @file | ->", file=sys.stderr)
        return 2
    body = read_body(sys.argv[1]).rstrip()
    root = os.environ.get("BOOSTLY_RUN_ROOT") or str(Path.home() / "boostly-branding" / "runs")
    inbox = Path(root) / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    log = inbox / "messages.log"
    stamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    with log.open("a", encoding="utf-8") as fh:
        fh.write(f"[{stamp}]\n{body}\n\n")
    try:
        os.chmod(log, 0o600)
    except OSError:
        pass
    print(f"message-me stub: wrote {len(body)} chars to {log} (no iMessage on this machine; escalate by Slack)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
