---
name: apple-notes-decision-brief
description: Create or revise concise, evidence-backed decision briefs in Apple Notes with a clear recommendation, ranked alternatives, risks, decision gates, next actions, source notes, and verified rich-text formatting. Use when the user wants scattered information consolidated into an Apple Note for making a decision, comparing candidates or options, preparing an executive brief, or turning messages, documents, research, meetings, and prior chats into one decision-ready note.
---

# Apple Notes Decision Brief

Create a short decision surface, not a research dump. Gather the relevant evidence, take a defensible position, preserve meaningful uncertainty, and write a genuinely formatted Apple Note.

## Workflow

1. **Define the decision.** State the exact choice, owner, and deadline when known.
2. **Add traceability.** If the brief is being created from Codex, a linked Codex task, or a Codex discussion, put the direct `codex://threads/...` deeplink near the top under the date.
3. **Name the tension.** Before recommending, explain the fundamental conflict, tradeoff, or problem the decision is solving in 1-3 concrete bullets. This should make the reader feel why the decision is hard.
4. **Gather narrowly.** Search only the sources implied by the request. Distinguish:
   - direct evidence
   - current/live verification
   - prior discussion or memory
   - inference
5. **Resolve conflicts.** Prefer current primary sources. Label unresolved identity, timing, or data gaps.
6. **Recommend.** Lead with one package or option when the evidence supports it. Do not hide behind a balanced menu.
7. **Compress.** Keep only facts that could change the decision, ranking, or next action.
8. **Write the note.** Use `scripts/write_decision_brief.py` so headings and bold text are real rich text.
9. **Verify.** Confirm the saved note contains bold tags, sized headings, and native lists. Return the direct Notes link.

Do not send messages, publish externally, or mutate source systems unless separately authorized. Creating or updating the requested Apple Note is authorized by the request.

## Brief Shape

Use this structure unless the decision needs fewer sections:

```markdown
# [Decision title]
**Decision brief** · [date]
**Codex task:** [codex://threads/...]

## Tension
- **[Pressure 1]:** [what makes one side of the decision compelling]
- **[Pressure 2]:** [what makes the opposing side materially important]
- **Problem to solve:** [the practical decision problem in one sentence]

## Recommendation
- **[Decision slot]:** [lead choice]
- **Why:** [one sentence]

## 1. [Decision area]
### Lead: [option]
- [strongest evidence]
- [relevant current context]
- [main risk or condition]

### Backups
- **[Option]:** [why it remains viable]

### Hold / eliminate
- **[Option]:** [specific reason]

## Decision gates
- [fact or conversation required before committing]

## Next moves
1. [immediate action]
2. [fallback or follow-up]

_Sources: [compact source list and freshness date]._
```

Omit empty sections. For multiple related choices, put the recommended package first, then give each choice its own numbered section.

## Writing Rules

- Put the Codex task deeplink, when available, directly under the date so the source conversation is traceable.
- Put the tension/problem and recommendation in the first screenful, in that order.
- Do not open by jumping straight to the answer when the decision has a meaningful emotional, strategic, financial, or operational tradeoff.
- Rank alternatives. Avoid alphabetical candidate dumps.
- Give each option only decision-relevant facts.
- Separate a real concern from missing information.
- Include sensitive personal facts only when they materially affect the decision and the destination is appropriate.
- Use ages, dates, tenure, prices, or status only when current enough for the decision.
- Prefer three strong bullets over a biography.
- End with concrete next moves, not a recap.

## Rich-Text Writer

Draft the brief as Markdown in a temporary file, then run:

```bash
python3 scripts/write_decision_brief.py \
  --input /path/to/brief.md \
  --folder Notes \
  --create
```

To update an existing note:

```bash
python3 scripts/write_decision_brief.py \
  --input /path/to/brief.md \
  --replace-id 'x-coredata://.../ICNote/p123'
```

Use `--replace-title "Exact note title"` only when the title is unambiguous. Use `--preview` to inspect generated HTML without writing.

Supported formatting:

- `#` title, rendered 24px bold
- `##` section heading, rendered 18px bold
- `###` bold subheading
- `**bold**` and `_italic_`
- `-` native bullet lists
- `1.` native numbered lists

The script returns the note ID, direct `notes://` link, and verification counts. Treat the write as successful only when `verified` is true.

## Handoff

Return:

- confirmation that the note was created or updated
- the recommended option or package in one line
- the clickable direct Apple Notes link
- any unresolved fact that could change the recommendation
