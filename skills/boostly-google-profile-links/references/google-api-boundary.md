# Google API Boundary For Boostly Link Workflows

## Places API Without GBP Access

A `GOOGLE_PLACES_API_KEY` can fetch public Place Details. In local Boostly code this is already wired at `$BOOSTLY_REPO_DIR/src/lib/google-places.ts`.

Useful public fields:

- `id`
- `displayName`
- `formattedAddress`
- `addressComponents`
- `nationalPhoneNumber`
- `internationalPhoneNumber`
- `websiteUri`
- `googleMapsUri`
- `googleMapsLinks`
- `businessStatus`
- `types`
- `primaryType`
- `rating`
- `userRatingCount`
- `regularOpeningHours`
- `currentOpeningHours`
- `timeZone`
- `photos`

Practical implication: Places can seed location identity, website, review links, photos, phone, hours, rating, and Maps URLs without GBP access.

## Social Links

Do not assume Google Places exposes owner-entered social links. Treat social links as unavailable from public Places unless a live API test with a documented field proves otherwise.

DataForSEO `business_data/google/my_business_info` can return richer public business metadata than Places, including `local_business_links`, `services`, `attributes`, `book_online_url`, `domain`, `url`, and `cid`. Official docs list `place_id:<id>` as an accepted keyword form and document result fields such as `url`, `contact_url`, `contributor_url`, `book_online_url`, `domain`, `attributes`, `local_business_links`, and `services`; they do not document direct Facebook/Instagram/TikTok/YouTube profile fields. In a live test against `ChIJeym2YKez2IcRmA2f0EU4dFw`, it returned no direct social-link fields.

Docs checked:

- `https://docs.dataforseo.com/v3/business_data-google-my_business_info-task_get/`
- `https://docs.dataforseo.com/v3/business_data-google-my_business_info-live/`
- `https://docs.dataforseo.com/v3/business_data-business_listings-search-live/`

DataForSEO `business_data/business_listings/search/live` documents `contact_info`, but describes it as available contacts such as displayed values and source. Treat that as lead/contact enrichment, not as a reliable social-link source unless a live response for the specific business returns a verified social URL.

The working non-GBP path is:

1. Fetch `websiteUri` from Places.
2. Fetch the website HTML.
3. Extract anchors and JSON-LD `sameAs` links.
4. Verify discovered URLs against the restaurant name, domain, address, and platform profile metadata.
5. Mark uncertain hits for manual review instead of auto-adding them.

## GBP Access

Authenticated Google Business Profile API access is separate. It requires OAuth credentials and manager access to the target profile. Existing local pattern: `$BOOSTLY_REPO_DIR-review-responder/src/lib/google/gbp-client.ts`.

Use GBP only when access exists and the task specifically needs GBP-owned resources such as reviews, replies, managed location resource names, or future owner-curated attributes.
