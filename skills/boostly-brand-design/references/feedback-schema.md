# Branding feedback contract

## Ownership

`boostly-brand-design` owns the feedback schema and CLI. The fulfillment automation may call
the CLI and copy `branding_case_id` plus status into its audit, but it must not hand-edit the
ledger. Link discovery and heartbeat state have no branding-feedback fields.

Canonical append-only ledger:

`~/.claude/skills/boostly-brand-design/feedback/branding-feedback.jsonl`

Override only for tests or deliberate migration with `BOOSTLY_BRANDING_FEEDBACK_FILE` or the
CLI's `--ledger` option. Both Codex and Claude skill copies use the canonical default.

## Event model

Every line is one immutable JSON event with:

- `schema_version`, `event_id`, `event_type`, `case_id`, `occurred_at`
- `case_created`: V2 identity, Slack request timestamp, run ID, artifact paths/hashes, and a
  complete snapshot of the generated manifest
- `feedback_recorded`: reviewer, verbatim feedback, normalized tags, source, and optional notes
- `revision_created`: actor, reason, revised artifact paths/hashes, and revised manifest snapshot
- `production_applied`: automation/actor, notes, and complete production-readback snapshot;
  this does not imply human approval
- `approved`: human reviewer and notes, with an optional fresh production-readback snapshot
- `rejected`: reviewer, verbatim reason, normalized tags, and optional notes

The stable case ID is derived from location ID + Slack request timestamp + run ID unless
`--case-id` is explicitly supplied. Re-running `create` for the same case is idempotent only
when the manifest and proof hashes match; changed artifacts require `revise` or a new run ID.

## Required sequence

1. Finalize proposal manifest and proof.
2. `create` the case and retain the returned `case_id`.
3. Record reviewer language verbatim with `record` before changing anything.
4. Add normalized tags. Prefer a small reusable vocabulary such as `wrong_color`,
   `logo_crop`, `logo_treatment`, `poor_contrast`, `brand_mismatch`, `wrong_identity`,
   `composition`, `typography`, `low_resolution`, or `scope_error`.
5. Produce new immutable artifacts and append them with `revise`.
6. After an unattended production write, append `apply` with the readback. This means deployed,
   not approved.
7. Append `approve` only after a human reviewer approves it; append `reject` if the direction
   is abandoned.

Revision manifests must match the case's V2 `location_id`. Production readbacks are checked
too whenever they expose a top-level `location_id`; cross-location artifacts are rejected.

Do not edit or delete old rows. Corrections are new events. Do not include cookies, API keys,
database URLs, or raw authentication material in feedback, notes, manifests, or readbacks.

## CLI

```bash
SCRIPT=~/.claude/skills/boostly-brand-design/scripts/branding-feedback.ts

node --experimental-strip-types "$SCRIPT" create \
  --manifest <manifest.json> --proof <proof.png> \
  --request-ts <slack_ts> --run-id <run_id>

node --experimental-strip-types "$SCRIPT" record \
  --case-id <id> --reviewer Cam --feedback "<verbatim feedback>" \
  --tags wrong_color,logo_treatment --source slack

node --experimental-strip-types "$SCRIPT" revise \
  --case-id <id> --manifest <revised-manifest.json> \
  --proof <revised-proof.png> --actor Fable --reason "<reason>"

node --experimental-strip-types "$SCRIPT" apply \
  --case-id <id> --actor automation --production-readback <readback.json>

node --experimental-strip-types "$SCRIPT" approve \
  --case-id <id> --reviewer Cam --notes "<approval note>"

node --experimental-strip-types "$SCRIPT" reject \
  --case-id <id> --reviewer Cam --feedback "<verbatim reason>" \
  --tags wrong_identity

node --experimental-strip-types "$SCRIPT" export \
  --reviewed-only --output <training-set.jsonl>
```

`export` emits one aggregated JSON object per case containing the original generated snapshot,
all feedback, revisions, production applications, and final human disposition. `--reviewed-only` excludes
cases with no feedback, approval, or rejection.
