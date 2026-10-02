# Brand-environment evidence contract

Use this contract to supplement authored website/logo evidence with exact-location photos of the
restaurant's physical brand. Environment evidence informs palette and composition; it never
becomes logo authority.

## Identity gate

Resolve the V2 location first. The SearchAPI `google_maps_place` receipt must echo the exact
`google_place_id` and remain consistent with the resolved business name, street number, city, and
official domain when SearchAPI returns one. A conflict is `brand_environment_identity_conflict`
and blocks unattended branding judgment. Do not replace it with a same-name search result.

Official-domain images prove first-party provenance, not necessarily that a photo depicts the
current location. Third-party image-search results require page-level exact-business evidence or
independent visual corroboration.

## Retrieval order

1. Capture desktop/mobile official-site screenshots and likely About, Gallery, Location, Contact,
   Catering, and Private Events pages. Preserve `img`, `srcset`, and CSS-background provenance.
2. Fetch the existing Google Places top-photo packet as the baseline/identity receipt.
3. Fetch SearchAPI Maps Photos categories in priority order: Vibe, By owner, All page 1, then All
   page 2 only when the selected evidence is still thin. Fixed fallbacks are Vibe `CgIYIg`, By
   owner `CgIgARICEAE`, and Street View/360 `CgIgARICCAI`; prefer returned dynamic IDs when present.
   Auto mode fetches page 2 whenever no classification receipt exists. If a supplied receipt still
   yields `brand_environment_evidence_insufficient`, rerun once with `--include-page-2 always`,
   classify only the newly materialized hashes, and rebuild the receipt.
4. Treat Street View/360 as storefront identity support only. Do not pass panorama payloads to
   Fable when they do not materialize as ordinary still images.
5. Use narrow DataForSEO Google Images queries only for remaining gaps: exact name plus city plus
   `interior`, `dining room`, `storefront`, `exterior`, `bar`, `signage`, and
   `site:official-domain`.

SearchAPI is fail-open. Empty categories, download failures, missing dynamic categories, or an
outage add explicit flags and fall back to the official site, Places baseline, and DataForSEO.
Identity conflicts are not fail-open.

## Fixed-label classification receipt

`fetch-searchapi-brand-environment.ts --classifications <json>` accepts an array, or an object with
a `classifications` array. Each row requires `sha256` or `candidate_id`, plus one classification:

- `brand_environment`
- `food`
- `people`
- `mixed`
- `noise`

Eligible `brand_environment` or `mixed` rows also require one subtype:

- `storefront`
- `exterior_signage`
- `interior_fixture`
- `vibe`
- `menu_signage`
- `branded_collateral`
- `other_environment`

The classifier may be model-assisted, but the runner owns the fixed schema, cache key, thresholds,
and replay. It must not choose logos, colors, or production actions. Without a receipt, the script
passes only exact-place Vibe candidates to a provisional review sheet, keeps By owner/All in the
ledger for later classification, marks minimum evidence `unassessed`, and emits
`brand_environment_classification_unavailable`.

## Ranking and dedupe

Base ranking: verified first-party environment 100, SearchAPI Vibe 90, SearchAPI By owner 75,
official-domain image search 70, SearchAPI All 60, Street View still 50, verified third-party image
search 40. Add 25 for storefront/exterior signage, 20 for interior/fixtures, 15 for menu/in-store
signage, 10 for branded collateral, and 10 for a legible exact business mark. Reject or heavily
penalize food-dominant, people-dominant, weak-identity, stock/template, map-tile, icon, failed-decode,
and longest-side-under-480px candidates.

Canonicalize URLs, SHA-256 exact bytes, then use 64-bit difference hash with Hamming distance at or
below 6 plus an aspect-ratio check for near duplicates. Keep the highest-scoring provenance and
resolution. Select at most three images of one subtype and at most two views of one scene.

## Minimum evidence and Fable handoff

Confident environment evidence requires four perceptually unique eligible images spanning at least
two physical subtypes:

- one storefront, exterior, or signage image;
- two interior, fixture, or Vibe images;
- one menu/signage or additional physical-environment image.

If unmet, emit `brand_environment_evidence_insufficient`. Continue logo/site-palette work, but do
not imply that the physical brand was confidently established.

Fable receives the required official-site screenshots/computed styles, separately ranked
first-party logos, one labeled selected-environment contact sheet, and at most ten selected detail
images with source, category, dimensions, identity evidence, hashes, duplicate group,
classification, and subtype. Never pass the raw gallery pages or rejected images.

## Physical-brand precedence for Fable

Website capture remains mandatory whenever an official website is available. Exact-place photos
do not bypass the desktop/mobile screenshot receipt, computed-style manifest, logo QA, or human
review rules. They refine which evidence best represents the physical brand.

Corroborated deliberate physical-brand usage may outrank only generic website evidence:

- `framework_default_risk` colors;
- CSS values absent from screenshot-visible semantic surfaces;
- generic template chrome; or
- one low-salience CTA without independent brand corroboration.

A repeated screenshot-visible `theme_authored` website system remains authoritative. Human-supplied
assets and the current verified first-party mark remain logo-identity authority.

Physical evidence qualifies through one of two bounded paths:

1. At least two perceptually unique exact-place images independently show the same deliberate
   brand-owned signage, mark treatment, collateral treatment, or color family.
2. One exceptionally clear permanent exact-location sign agrees with an independent
   human-supplied or `first_party_*` asset, or a screenshot-visible `theme_authored` signal.

Another GBP/SearchAPI image is not the independent first-party signal. Duplicate crops, alternate
resolutions of one photo, and two views of one scene do not establish repeated usage.

Qualifying evidence may justify a faithful simplified, full-white-knockout, or one-color treatment
of the already verified first-party mark. It may establish which color family leads in-store. It
must not create a new mark, substitute a stale sign for the current identity, or authorize a
photographic/shaded logo knockout that would fail the existing treatment rules.

Exclude colors caused by:

- food or drink;
- lighting, camera white balance, or reflected color casts;
- general decor, paint, furniture, or fixtures without a deliberate brand mark;
- uniforms;
- seasonal displays or temporary promotions;
- one-off objects;
- third-party/vendor signage, delivery decals, or beverage equipment; and
- neighboring tenants or sibling brands.

Photos determine treatment and color family or role, not a whole-scene sampled hex. Prefer an
agreeing authored website token, logo pixel, SVG fill, or first-party collateral value for the
exact output hex. If no authored exact value exists, lower confidence and flag the measurement
gap rather than presenting a cast-affected photo sample as exact.

When exact-place signage conflicts with the current verified first-party identity or appears
pre-rebrand, add `environment_sign_conflicts_current_identity`, lower confidence, and retain the
current identity hierarchy. Permanence alone does not prove recency.
