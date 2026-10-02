# Badge Preview Harness Dev Page

Install into the Boostly app:

```bash
mkdir -p $BOOSTLY_REPO_DIR/src/app/public/badge-preview-harness
cp ~/.claude/skills/boostly-brand-design/harness/dev-page/page.tsx $BOOSTLY_REPO_DIR/src/app/public/badge-preview-harness/page.tsx
```

Remove from the Boostly app:

```bash
rm -f $BOOSTLY_REPO_DIR/src/app/public/badge-preview-harness/page.tsx
rmdir $BOOSTLY_REPO_DIR/src/app/public/badge-preview-harness 2>/dev/null || true
```
