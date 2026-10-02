# Derived Contract

This is a dated verification record, not a live reference. Every server-action id below
rotates on each production deploy; the current ids live in `scripts/action-ids.json`
(with the build id they were derived from and a `derived_at` timestamp), written by
`scripts/derive-actions.ts --write` and by the CLI's own self-heal when it detects a
rotated id (see "Action-id rotation" in `SKILL.md`). The table in `scripts/boostly-links.ts`
is only the fallback when that file is missing. Do not copy an id from this file into a request.

Source evidence used:

- `mvanhorn/cli-printing-press` at `4a2b02329e71e64cc7ffe14ff9af569d0dfa3495`
- `cli-printing-press browser-sniff` on a redacted HAR captured from `https://new.boostly.com/in-store/links/location/xkcjek1yxc3u8wkok64atqeb`
- Boostly production chunks for:
  - `/in-store/links/location/[locationId]`
  - `/locations/[location_id]`
  - `/in-store?tab=badges`
- Live Boostly repo source under `$BOOSTLY_REPO_DIR`

Production Next server action ids observed on July 1, 2026:

- `getTouchpointEventConfigForLocation`: `4024fc1c61f2fe48ecf83c71cdcc569239a56bf606`
- `getObjectiveOptionsForLocation`: `405b4b33ed6fe38eeb303b086bbdd649517679db3a`
- `saveLocationTouchpointEventConfigs`: `4038999606c43cb2364955232cbb8bdaff379cd462`
- `updateLocation`: `603c70dcac631968a9fd6ff1a096c2f6222b3244a9`

Production Next server action ids observed on July 6, 2026:

- `updateAccountBranding`: `40d8fc18d1e904c10247158d48d024c44801a0e2cd`

Production Next server action ids observed on July 13, 2026:

- `createBulkBadges`: `4035790324718a441a4521e7a954052230c964165b`

Production Next server action ids observed on July 16, 2026:

- `updateAccountBranding`: `400863ec375adb1081f9f4db8e1fa0071c37594b49`
- Source: direct authenticated `/account-settings` HTML plus its current page chunk; no browser runtime required.

Bulk badge contract:

- Request path: `/in-store?tab=badges`
- RSC argument: `[{"location_id":"<locationId>","quantity":<integer>}]`
- The production schema accepts whole numbers from 2 through 100.
- New badges are unassigned, type `badge`, receive sequential location issue IDs, and each
  receives a unique four-character short ID.
- The authenticated badge page renders the current `badges` array in its RSC payload, which
  provides a replayable browser-independent before/after count and created-ID readback. The
  parser concatenates all Flight response-partial chunks before extracting the array.
- Printing Press `probe-reachability` 4.27.1 classified the route as `standard_http` with
  confidence 0.95; the CLI therefore uses the raw-cookie HTTP session and no browser runtime.
- Apply mode acquires an exclusive per-idempotency-key lock and writes a `started` receipt before
  invoking the action. Any post-invocation response/readback uncertainty becomes `ambiguous` and
  is never retried automatically; only exact count and new-ID readback produces `completed`.

Logo upload contract:

- Both `updateAccountBranding` and `updateLocation` accept `logo_attachment_file` as a `File` inside their normal form-data object.
- React Server Components serializes that file call as multipart form data: part `0` contains the JSON arguments with a `$B1` file reference and part `1` contains the image blob and filename.
- The server validates PNG/JPEG/GIF content types and account-specific file-size limits, uploads to the attachments bucket, mints the attachment row, and writes its id to the selected branding scope in the same action.

Live verification on July 1, 2026:

- Auth check against `/api/jobs/active?type=csv_import`: HTTP 200 JSON.
- In-store `getTouchpointEventConfigForLocation`: HTTP 200 and returned the current Text Club, Reviews, Menu, Order, Downloads, Careers, Video, and Socials items for `xkcjek1yxc3u8wkok64atqeb`.
- In-store `getObjectiveOptionsForLocation`: HTTP 200 and returned active options.
- In-store `events set ... menu --link ...` dry run preserved the full event object and did not write.
- Location settings page `/locations/xkcjek1yxc3u8wkok64atqeb`: HTTP 500 while authenticated.
- Primary and replica V2 `locations` schema currently lacks the social, branding, app, and logo columns selected by the deployed location settings page/action. This appears to be the cause of the page failure.

Live verification on July 6, 2026:

- Account settings page `/account-settings` renders the new account branding form with `Branding` and `Social & App Links` tabs.
- Production account settings chunk uses `updateAccountBranding` and submits the branding/social/app fields directly to the account-settings action.
- Production V2 has a `branding` table with `account_id`, optional `location_id`, branding color fields, logo attachment id, social URLs, and app URLs.
- `branding_account_id_base_key` enforces one account-base row where `location_id IS NULL`; `branding_location_id_key` enforces one override row per location.
- Location settings page `/locations/xkcjek1yxc3u8wkok64atqeb` renders again and includes `location.accountBranding` plus `location.overrideBranding` in the RSC payload.
- Production location settings chunk still uses `updateLocation` (`603c70dcac631968a9fd6ff1a096c2f6222b3244a9`) for location edits, but the client form seeds branding/social/app inputs from `overrideBranding` and labels them as inheriting from account settings unless overridden.
- CLI `location get` was updated to parse the current RSC payload and report account-base, location-override, and effective branding.
- CLI `branding get` dry-run verification:
  - `xkcjek1yxc3u8wkok64atqeb` under the current Boostly Pizza (Orem) session selected `location` because the account has four enabled locations.
  - `qj32s530j0g9p7dbode36q89` under the Music City Denver scoped session selected `account` because the account has one enabled location.
- CLI `branding set` dry runs preserved unrelated branding fields and showed the selected write scope before writing.
- CLI `location set` now refuses mixed core-location plus branding/social/app writes in the same command.
- A mismatched-cookie test showed DB context can resolve a target location even when the cookie is spoofed to a different account. The CLI therefore checks `/api/auth/session` and refuses `branding set --apply` unless the authenticated effective account id matches the target location's account id.

Important behavior:

- In-store saves require the full `events` array for the location. Omitting an existing event soft-deletes it.
- The CLI therefore reads current events before `events set`, `events add-custom`, and `events delete`.
- `save-json` intentionally requires `--apply` and assumes the file contains the full desired array.
- Text club welcome message and promotion are stored through the subscribe event passthrough fields and then written to the underlying touchpoint subscribe link keyword.
- Downloads/social URLs now live in `branding`; their touchpoint event enabled/label state remains in `touchpoint_events`.
- `branding` resolves per field from location override first, then account-base. Null/blank override values inherit.
- General locations (`is_general = true`) are always ignored for matching and scope. `branding set --scope auto` writes account settings only when the target is the sole non-General enabled/paused location. A disabled target with one non-General enabled/paused sibling uses a location override instead of changing the sibling's account-wide branding.
- The CLI blocks `location set --apply` and `branding set --apply` when it had to read from the DB fallback, because the app actions need a current authenticated page payload.
- The CLI also blocks `branding set --apply` when `/api/auth/session` reports an effective account that does not match the DB-resolved target account. This prevents account-settings writes from updating the wrong currently-spoofed account.

Live verification on September 16, 2026 (fulfillment request actions):

- Page `/admin/fulfillment/<requestId>` (admin-scoped; `requireAdmin`, no account spoof needed) renders the full `request` prop in its flight payload: stamps (`$D` dates), `offer_text` (leading `$` escaped as `$$`), items with `printed_at`, flattened ship-to fields, `offerOptions`, and the server-computed `state`. The CLI reads and reads back from it.
- Derived from its page chunk (build `4jnFthvfTvoyU7FxoRTm6`): `setStoreDetailsConfirmedAction`, `setDigitalFulfillmentCompletedAction`, `updateFulfillmentOfferAction` (ids live in `scripts/action-ids.json`).
- Argument shapes (plain RSC args, no FormData): `[requestId, boolean]` for both status flips; `[requestId, { promotion_id: string | null, text: string }]` for the offer (`text` trimmed, 1-200; a non-null `promotion_id` must be a live promotion on the location's account and snapshots its title as `offer_text`). Result is `{ success: true }` or `{ success: false, error }`.
- Side effects: offer change nulls `printed_at` on signage/sticker items and logs `offer_updated`; every action ends with `notifyFulfillmentReadyForPhysical`, which posts the "ready for physical fulfillment" Slack message and stamps `physical_fulfillment_notified_at` when state is `physical_fulfillment` and the stamp is null (reset on regression to `digital_fulfillment` / `store_details`).
- Pilot: `iv1dzvf6qhnfpjzyvvticbhd` offer write returned success with page readback `20% Off`; `store-details --confirm` returned success, page readback `state: physical_fulfillment`, replica stamp `physical_fulfillment_notified_at` visible within about one second.
