#!/usr/bin/env python3
"""Thin wrapper: the real script lives in the fulfillment skill (review-checklist.py)."""
import os, sys
script = os.path.expanduser("~/.claude/skills/boostly-box-fulfillment/scripts/review-checklist.py")
run_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.execvp("python3", ["python3", script, "--run-root", run_root] + sys.argv[1:])
