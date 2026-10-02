# Privacy-Aware Information Handling

## Privacy Classification

Every `messages read` and `messages search` result includes a `privacy` field:

| Value | Source Type | Sensitivity |
|---|---|---|
| `public` | Public channel | Low — visible to all workspace members |
| `private` | Private channel | High — restricted to invited members |
| `dm` | Direct message | Highest — private 1:1 conversation |
| `group_dm` | Group DM | Highest — private multi-party conversation |
| `unknown` | Couldn't classify | Treat as private (safe default) |

## Cross-Privacy Rules

When information read from one privacy level is about to be shared at a lower privacy level:

### Private/DM → Public Channel
**Always warn.** Before sending, tell the user:
- Where the information came from (channel name + privacy level)
- Where it's going (target channel + privacy level)
- Ask for explicit confirmation

### DM → Any Channel (Public or Private)
**Warn + prefer paraphrasing.** DM content is the most sensitive:
- Suggest paraphrasing over direct quoting
- If direct quoting is needed, flag it explicitly
- Never include the other DM participant's name without asking

### Mixed-Source Summaries
When summarizing messages from **any** prior `messages read` or `messages search` with results from multiple privacy levels:
- Treat the entire summary at the **highest** sensitivity level present
- Call out which parts came from private/DM sources
- Search results span multiple channels — check each result's `privacy` field individually

### Same Level or Higher Privacy
No special handling needed (e.g., public → public, public → private).

## How to Apply

1. After reading messages, note the `privacy` field
2. Before any write operation (send, share), compare source privacy to target privacy
3. If target is less private than source, follow the rules above
4. If `privacy` is `unknown`, treat as private

## What This Does NOT Do

- Does not block any action — the user always has the final say
- Does not apply to read-only operations
- Does not track privacy across conversation turns (each read result is self-contained)
