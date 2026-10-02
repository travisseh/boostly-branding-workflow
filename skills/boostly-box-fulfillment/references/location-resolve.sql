-- Resolve one V2 location for a Boosted Box request with the read-only v2-db CLI.
-- Fetch candidate rows only. The deterministic location-match.ts matcher is the authority:
-- it requires normalized account name + location name + full address and excludes General.
-- Never confirm a row by eyeballing or substring score. Read-only replica.

-- Execute after substitution with:
-- ~/.claude/skills/v2-database/bin/v2-db query --sql "<query>" --json

-- A) Candidate retrieval by normalized account/location name. Keep the full address intact
--    for exact matching in prepare-fulfillment-plan.ts.
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
WHERE regexp_replace(replace(lower(a.name), '&', 'and'), '[^a-z0-9]+', '', 'g') =
      regexp_replace(replace(lower(':account_name'), '&', 'and'), '[^a-z0-9]+', '', 'g')
  AND regexp_replace(replace(lower(l.name), '&', 'and'), '[^a-z0-9]+', '', 'g') =
      regexp_replace(replace(lower(':location_name'), '&', 'and'), '[^a-z0-9]+', '', 'g')
  AND l.is_general = false
ORDER BY l.status = 'enabled' DESC
LIMIT 25;
-- Pass the JSON rows plus the parsed account/location/street/city/state/postal fields to
-- boostly-box-fulfillment/scripts/prepare-fulfillment-plan.ts. Only one exact normalized full
-- address may match. Zero or multiple exact matches => model exception; no write.

-- B) Existing branding for the matched account (account-base row: location_id IS NULL;
--    a row with location_id set = that location's override). Decides fill-only vs overwrite.
SELECT
  b.location_id,   -- NULL = account base
  b.web_primary_color, b.web_secondary_color, b.web_text_color,
  b.print_primary_color, b.print_secondary_color, b.print_text_color,
  b.print_text_secondary_color,
  b.facebook_url, b.instagram_url, b.tiktok_url, b.youtube_url, b.x_url,
  b.logo_attachment_id,
  att.cdn_url AS logo_url
FROM branding b
LEFT JOIN attachments att ON att.id = b.logo_attachment_id
WHERE b.account_id = ':account_id';

-- If a column errors (schema drift), introspect:
--   SELECT column_name FROM information_schema.columns WHERE table_name='locations';
