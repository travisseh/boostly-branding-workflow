---
name: boostly-google-profile-links
description: Find and audit public Google Business Profile/Google Places data for Boostly restaurant locations, starting from a Google Place ID, Boostly location ID, or business name/address. Use when checking what can be pulled without GBP manager access, validating whether Google exposes social links, finding website/social/app links for a location, or drafting automation for "Grab & Verify & Add Social Links" workflows.
---

# Boostly Google Profile Links

## Core Rule

Separate these sources clearly:

- **Places API public profile data:** usable with `GOOGLE_PLACES_API_KEY`; no GBP manager access required.
- **Website scrape data:** use the public website returned by Places, then verify discovered social/app/custom links against the business name, address, domain, and platform metadata.
- **Google Business Profile API data:** requires OAuth/manager access. Do not claim GBP-only attributes are available from Places.

## Existing Boostly Surfaces

Prefer these local code paths before inventing new ones:

- `$BOOSTLY_REPO_DIR/src/lib/google-places.ts`
  Existing Places API helper. Uses `GOOGLE_PLACES_API_KEY` and imports place ID, name, address, phone, website, timezone, and photos.
- `$BOOSTLY_REPO_DIR/src/lib/onboarding/link-acquisition/`
  Existing link resolver. GBP source is stubbed off; website source scrapes social/app/custom links and verifies ownership.
- `$BOOSTLY_REPO_DIR-review-responder/src/lib/google/gbp-client.ts`
  Authenticated GBP client pattern. Requires `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GBP_REFRESH_TOKEN`.
- `$BOOSTLY_REPO_DIR-reporting/work/gbp-access-baseline/`
  Prior GBP access baseline artifacts with example `googlePlaceId`, `gbpResourceName`, `mapsCid`, and `websiteUri` fields.
- `/Users/travisse/Programming/product2/shared/apps/review-analyzer-tool/fetch-reviews.js`
  DataForSEO review fetcher with a hardcoded DataForSEO credential pair. This account may return `Payment Required`.
- `/Users/travisse/Programming/gmr_enrichment/fetchReviewsDataForSEO.js`
  Legacy GMR enrichment flow with a funded DataForSEO credential pair and older Zembra lookup. Use this for DataForSEO research, but do not print credentials.

When searching for credentials or env names, print only variable names and file paths. Never print API keys, OAuth secrets, refresh tokens, or full env file contents.

## Workflow

1. Resolve the input:
   - If it looks like a Google Place ID (`ChIJ...`), use it directly.
   - If it is a Boostly location ID, query the app/reporting database or inspect the location record for `google_place_id`, name, address, and website.
   - If it is a name/address, call Places Text Search and ask the user to confirm if multiple plausible matches appear.
2. Fetch Places Details with a deliberate field mask. Useful public fields include:
   - `id`, `displayName`, `formattedAddress`, `addressComponents`
   - `nationalPhoneNumber`, `internationalPhoneNumber`
   - `websiteUri`, `googleMapsUri`, `googleMapsLinks`
   - `businessStatus`, `types`, `primaryType`
   - `rating`, `userRatingCount`
   - `regularOpeningHours`, `currentOpeningHours`, `timeZone`
   - `photos`
3. State the boundary: Places does not expose owner-entered social links as a normal Place Details field. If social links are needed without GBP access, pull the website from Places and scrape/verify links.
4. Optionally check DataForSEO `business_data/google/my_business_info` by `place_id:<id>`:
   - Useful returned fields can include `domain`, `url`, `contact_url`, `book_online_url`, `local_business_links`, `services`, `attributes`, `is_claimed`, `rating`, `cid`, and richer category/menu data.
   - In tested output, DataForSEO did not return direct social link fields (`facebook`, `instagram`, `tiktok`, `youtube`, etc.). Treat it as a richer public business-profile source, not a social-link source.
   - Official docs: `https://docs.dataforseo.com/v3/business_data-google-my_business_info-task_get/` and `https://docs.dataforseo.com/v3/business_data-google-my_business_info-live/`.
   - `business_data/business_listings/search/live` has a `contact_info` field, but docs describe it as available contacts such as phone/source, not social profile URLs. Official docs: `https://docs.dataforseo.com/v3/business_data-business_listings-search-live/`.
5. Run the existing Boostly website-source logic when working in the app repo, or use the bundled snapshot scripts for quick research.
6. Classify output:
   - `google_public`: fields returned directly by Places.
   - `website_verified`: social/app/custom links found on the official website and ownership-verified.
   - `needs_manual_review`: plausible search/platform hits that were not clearly verified.
   - `requires_gbp_access`: any claim that depends on authenticated GBP-only attributes.

## Helper Script

Use `scripts/google-profile-public-snapshot.sh` for quick Places + website research. It loads `GOOGLE_PLACES_API_KEY` from the current environment or common Boostly env files, then returns a JSON snapshot.

Examples:

```bash
~/.claude/skills/boostly-google-profile-links/scripts/google-profile-public-snapshot.sh --place-id ChIJeym2YKez2IcRmA2f0EU4dFw
~/.claude/skills/boostly-google-profile-links/scripts/google-profile-public-snapshot.sh --query "Social Bar & Grill Soulard 1551 S 7th St St. Louis"
```

Use `scripts/dataforseo-business-info-snapshot.sh --place-id <id>` when checking DataForSEO. It extracts credentials from known local integration files, redacts the credential material, and returns a bounded JSON summary.

Read `references/google-api-boundary.md` when you need the current public-vs-GBP distinction or a paste-ready answer about social-link availability.
