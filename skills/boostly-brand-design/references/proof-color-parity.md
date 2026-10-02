# Production proof color parity

`proposal-proof.png` and `proof.png` have different ownership:

- Fable renders `proposal-proof.png` from the proposed manifest before any write. It is immutable
  proposal/feedback evidence and may differ from production when a reviewer changes colors.
- After an applied branding write and verified readback, the orchestrator renders `proof.png`
  from the readback's resolved `effective_branding`. This is the only tap-card proof eligible for
  an applied fulfillment's Slack/Notion result.

Run:

```bash
node --experimental-strip-types \
  ~/.claude/skills/boostly-brand-design/scripts/render-effective-proof.ts \
  --readback <run_dir>/production-readback.json \
  --location-id <location_id> \
  --out <run_dir>/proof.png
```

The helper intentionally does not accept a proposal manifest as a color source. It requires
resolved production branding so account inheritance, location overrides, blank-value inheritance,
and print-to-web fallback have already been decided by the production resolver. It downloads the
effective production logo when `logo_url` is present and writes `<run_dir>/proof-branding.json`
with the readback hash, selected colors, logo hash, and proof hash.

Validate it immediately before upload:

```bash
node --experimental-strip-types \
  ~/.claude/skills/boostly-brand-design/scripts/validate-effective-proof.ts \
  --readback <run_dir>/production-readback.json \
  --metadata <run_dir>/proof-branding.json \
  --proof <run_dir>/proof.png \
  --location-id <location_id>
```

The default `digital` mode matches Boostly's visible tap-card preview exactly:

- `web_primary_color`
- `web_secondary_color`
- `web_text_color` for both text roles

`--mode print` is available for a separate print proof and uses resolved print colors with the
same print-to-web fallback as production. The customer-facing link tree itself uses the resolved
`web_primary_color`; its live screenshot remains the definitive link-tree proof.

## Required fulfillment integration

1. Preserve Fable's artifact as `proposal-proof.png` and use it for the initial feedback case.
2. Apply branding, then save a fresh `branding get` result as `production-readback.json`.
3. Run `render-effective-proof.ts` after readback and before Slack/Notion assembly.
4. For applied branding, run `validate-effective-proof.ts` immediately before upload and require
   exit code 0. It verifies the latest readback hash, effective logo, exact location, selected
   colors, color mode, and proof hash.
5. Never fall back to a root/stale proposal proof after an applied color or scope revision. If the
   post-write render fails, report the proof as unavailable rather than attaching mismatched colors.
6. For held branding, attach and label `proposal-proof.png` as a proposal; do not describe it as a
   production-matched preview.
