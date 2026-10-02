---
name: askelephant
description: Search AskElephant meetings and transcripts, including Travisse's meetings or broader AE meeting history. Use when the user asks about AskElephant, AE meetings, meeting transcripts, promises, follow-ups, objections, summaries, or things discussed in recent calls.
---

# AskElephant Meeting Search

Use this skill to search AskElephant meetings/transcripts and answer questions like:

- "What things did I promise in meetings yesterday?"
- "Summarize my calls with customers last week."
- "What objections came up in my AE meetings?"
- "How many people asked for websites last week?"
- "Find calls where we discussed pricing."

## Default Behavior

- Default person: `travisse@boostly.com` when the user asks about "my" meetings or Travisse's calls.
- Use `--all` when the user asks about AE meetings generally, cross-team trends, or topics discussed anywhere in AskElephant.
- Default date: yesterday when the user asks a relative daily question.
- Default source: the Boostly Reporting transcript mirror first, then live AskElephant engagements with transcripts when the mirror has no coverage.
- Prefer meetings where Travisse is owner, host, internal participant, or appears in transcript metadata.
- When the user asks for a specific meeting/link, prioritize exact record retrieval and explicit verification over recap or inference.
- If a date-only same-day range is needed, use `--date YYYY-MM-DD` or ensure `--since YYYY-MM-DD --until YYYY-MM-DD` expands to the full local day.

## Quick Commands

Run from any directory:

```bash
python3 ~/.claude/skills/askelephant/scripts/search_meetings.py --person travisse@boostly.com --date yesterday --query "promise promised follow up send I'll I will"
```

For a range:

```bash
python3 ~/.claude/skills/askelephant/scripts/search_meetings.py --person travisse@boostly.com --since 2026-05-06 --until 2026-05-07 --query "pricing objection competitor"
```

For all AE meetings, not just Travisse's:

```bash
python3 ~/.claude/skills/askelephant/scripts/search_meetings.py --all --since 2026-05-06 --until 2026-05-07 --query "pricing objection competitor"
```

Force the Boostly Reporting transcript mirror only:

```bash
python3 ~/.claude/skills/askelephant/scripts/search_meetings.py --all --since 2026-05-06 --until 2026-05-07 --query "pricing objection competitor" --source db
```

Force live AskElephant only:

```bash
python3 ~/.claude/skills/askelephant/scripts/search_meetings.py --all --since 2026-05-06 --until 2026-05-07 --query "pricing objection competitor" --source live
```

To fetch broader context without keyword filtering:

```bash
python3 ~/.claude/skills/askelephant/scripts/search_meetings.py --person travisse@boostly.com --date yesterday --limit 20
```

## Source Selection

The script defaults to `--source auto`:

1. Read cached transcript bodies from Boostly Reporting (`reporting.call_transcripts` joined to `reporting.call_transcript_bodies`).
2. If the DB has no rows for the window or is unavailable, fall back to live AskElephant REST.
3. If REST auth is unavailable or REST fails, fall back to the derived-token GraphQL path.

Use `--source db` when you specifically want the reporting mirror. Use `--source live` when you need to bypass the mirror and re-read AskElephant directly.

## Auth

The script reads credentials from environment variables and common local env files. Do not hardcode tokens in this skill.

Reporting DB:

- `SALES_DATABASE_URL` or `DATABASE_URL`

Preferred:

- `ASKELEPHANT_API_KEY`

Fallback:

- `ASKELEPHANT_REFRESH_TOKEN`
- `ASKELEPHANT_FIREBASE_API_KEY`

Common local files loaded automatically when present:

- `$BOOSTLY_REPO_DIR-reporting/apps/dashboard/.env.local`
- `/Users/travisse/.config/render/product-analytics.env` (expected local source for the REST API key)

Use REST when `ASKELEPHANT_API_KEY` is present. Use GraphQL only when REST auth is unavailable or REST errors. If REST succeeds with zero results, report the zero-result REST search; do not fall through to GraphQL.

## Answering Follow-Up / Promise Questions

1. Search yesterday's meetings for Travisse with promise/action keywords.
2. Read the returned snippets and transcript excerpts.
3. Extract concrete commitments only:
   - promised sends/docs
   - follow-up tasks
   - introductions
   - pricing/contract items
   - product/support actions
4. Include the meeting title, date/time, external company/contact when available, and a short quoted/paraphrased basis.
5. Separate "clear commitments" from "possible follow-ups" when the transcript is ambiguous.

Never print API keys, refresh tokens, or raw auth headers.

## Answering Count / Mention Questions

- For questions like "how many people asked for websites last week," search the relevant AE scope first; use `--all` unless the user asks about "my" meetings.
- Count the requested unit explicitly. If the user asks for people, count distinct external contacts/participants where the snippets support that they asked or raised the topic; do not silently substitute meeting count.
- Report the searched date window, query terms, count, and any coverage caveat when transcript data or identity matching is partial.

## Evals

Run offline regression checks without live AskElephant credentials:

```bash
python3 ~/.claude/skills/askelephant/evals/static_checks.py
```

Run prompt-level Codex agent evals:

```bash
python3 ~/.claude/skills/askelephant/evals/run_cases.py --case date_window_same_day --live
```

Use `--schema-only` to validate case definitions without running Codex. The evals cover date-window behavior, person filtering, keyword snippets, REST/GraphQL fallback, quantitative mention counting, auth-secret safety, and prompt-level cases in `evals/cases.json`.
