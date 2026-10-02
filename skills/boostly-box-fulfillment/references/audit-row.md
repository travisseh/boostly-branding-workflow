# Audit row schema

Append one JSON object per attempted write OR skip to the shared append-only log
(`.codex/skills/boostly-link-discovery/runs/boosted-box-heartbeat-audit.jsonl`).
Never rewrite existing rows. Match the existing key set:

```json
{
  "ts": "<slack request timestamp or ISO time>",
  "event": "link_write | link_skip | link_discovery_correction | audit_correction | branding_write | branding_hold | branding_revision | branding_scope_migration | badge_create | badge_hold | link_tree_proof | notion_review_page | notion_review_page_update | location_bootstrap | location_match_review | slack_result_post | slack_result_update | searchapi_slack_evidence",
  "account_id": "<v2 account id>",
  "location_id": "<v2 location id>",
  "category": "order | menu | catering | careers | facebook | instagram | branding | website | ...",
  "url": "<verified URL when applicable>",
  "source_page": "<source URL when applicable>",
  "verifier_evidence": "<one-line evidence only>",
  "run_id": "<fulfillment run id>",
  "request_key": "<normalized request key>",
  "slack_request_ts": "<canonical request thread timestamp>",
  "slack_paired_ts": ["<other paired top-level timestamps>"],
  "branding_case_id": "<feedback case id when applicable>",
  "badge_quantity": "<requested Tap Cards count when applicable>",
  "badge_count_before": "<active count before badge creation>",
  "badge_count_after": "<active count after verified creation>",
  "badge_ids": ["<created badge id when applicable>"],
  "badge_request_id": "<canonical_thread_ts>|<normalized request key>",
  "idempotency_key": "<canonical badge request key when applicable>",
  "slack_file_id": "<uploaded proof file id when applicable>",
  "slack_file_ids": ["<every flattened uploaded Slack file id when applicable>"],
  "link_tree_url": "<verified public touchpoint URL used for capture when applicable>",
  "link_tree_screenshot_path": "<run-local link-tree.png path when applicable>",
  "link_tree_captured_at": "<ISO timestamp when capture succeeded>",
  "link_tree_slack_file_id": "<uploaded link-tree screenshot file id when applicable>",
  "searchapi_contact_sheet_path": "<identity-gated selected contact sheet when applicable>",
  "searchapi_selected_paths": ["<selected detail image paths in manifest order>"],
  "searchapi_slack_file_ids": ["<contact sheet id followed by selected detail file ids>"],
  "searchapi_exact_place_match": "<true only when the returned Place ID and identity checks match>",
  "website_desktop_screenshot_path": "<captured full-page desktop website screenshot when applicable>",
  "website_mobile_screenshot_path": "<captured full-page mobile website screenshot when applicable>",
  "website_computed_styles_path": "<semantic visible-surface computed-style manifest when applicable>",
  "palette_correspondence_pass": "<true only when chosen palette maps to visible screenshot surfaces and exact computed values>",
  "notion_page_id": "<Boostly Notion review page id when applicable>",
  "notion_page_url": "<Boostly Notion review page URL when applicable>",
  "notion_page_title": "<deterministic review title when applicable>",
  "notion_image_count": "<proof plus link-tree screenshot plus GBP image count successfully appended>",
  "note": "<short human note; source page + verifier evidence for writes, reason for skips>",
  "outcome": "applied | applied_pending_review | held | skipped | review | revised | verified",
  "scope": "account | location | n/a"
}
```

Never place cookie/credential values or full verifier payloads in a row. Source URL,
category, and a one-line evidence note only.

Because the log is append-only, never rewrite an inaccurate historical row. Append an
`audit_correction` row with `corrects_audit_lines` and `corrected_values` so consumers can
apply the correction without losing the original evidence.
