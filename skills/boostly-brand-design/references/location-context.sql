-- Location context for a brand-design run, via boostly-admin MCP run_read_query.
-- One query per location; substitute :location_id. Read-only replica.

-- 1) Core location + account, and how many non-General enabled/paused siblings the account has
--    (decides branding write scope: 1 => account base, >1 => location override).
SELECT
  l.id            AS location_id,
  l.name          AS location_name,
  l.address,
  l.website_url,
  l.ordering_url,
  l.google_place_id,
  l.status,
  a.id            AS account_id,
  a.name          AS account_name,
  (SELECT count(*) FROM locations s
    WHERE s.account_id = a.id
      AND s.status IN ('enabled','paused')
      AND s.is_general = false) AS sibling_count
FROM locations l
JOIN accounts a ON a.id = l.account_id
WHERE l.id = ':location_id'
  AND l.is_general = false;

-- 2) Existing branding rows for the account (account-base row has location_id IS NULL;
--    any row with location_id set is that location's override).
SELECT
  b.location_id,           -- NULL = account base
  b.web_primary_color, b.web_secondary_color, b.web_text_color,
  b.print_primary_color, b.print_secondary_color, b.print_text_color,
  b.print_text_secondary_color,
  b.logo_attachment_id,
  att.cdn_url AS logo_url
FROM branding b
LEFT JOIN attachments att ON att.id = b.logo_attachment_id
WHERE b.account_id = (SELECT account_id FROM locations WHERE id = ':location_id');

-- Column names drift; if a column errors, introspect first:
--   SELECT column_name FROM information_schema.columns WHERE table_name='locations';
