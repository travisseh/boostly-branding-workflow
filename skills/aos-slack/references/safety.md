# Remote-First Safety

Every command that writes to Slack follows the same contract: validate, draft+confirm, execute.

## 3-Step Contract

1. **Validate** — Run `scripts/slack auth check`. Fail fast if token is missing or invalid.
2. **Draft + Confirm** — Show the user exactly what will be sent/uploaded. Nothing touches Slack until the user approves.
3. **Execute** — Run the CLI write command. Report the outcome.

## Failure Semantics

| Step | What happens |
|------|-------------|
| Validate fails | Stop immediately. Nothing sent. Report auth error. |
| User rejects draft | Nothing sent. Acknowledge cancellation. |
| Execute fails (send/share) | Report the Slack API error. Nothing was delivered. Suggest retry. |
| Execute fails (delete) | Nothing was deleted. Report the Slack API error. |

Applies to: `send`, `share`, `delete`. Does NOT apply to read-only commands.
