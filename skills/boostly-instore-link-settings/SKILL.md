---
name: boostly-instore-link-settings
description: Read and edit Boostly in-store/touchpoint link settings, core location links, account/location branding settings, and employee badges using the authenticated new.boostly.com session. Use when Travisse asks to inspect or change in-store links, tapcard/box/custom links, text club titles, promotions, welcome messages, menu/order/video/download/social link settings, website/ordering URLs, social/app links, branding colors, or bulk-create badges from a Tap Cards request.
---

# Boostly In-Store Link Settings

Use the bundled CLI first. It wraps the production Next.js server actions for `new.boostly.com/in-store/links/location/[locationId]`, `new.boostly.com/locations/[locationId]`, `new.boostly.com/account-settings`, and `new.boostly.com/in-store?tab=badges`. Touchpoint event writes perform read-modify-write saves so existing events are preserved.

## Quick Command

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links events list <locationId> --cookie-file <raw-cookie-file> --json
```

Auth requires a raw `Cookie:` header file or `BOOSTLY_COOKIE`/`BOOSTLY_COOKIE_FILE`. Never print cookie values or save tokens in the skill. If the current session cookie is unavailable or expired, use Chrome with Travisse's Boostly profile to obtain a fresh authenticated cookie header.

## Workflow

1. Run `auth check` before a live task:

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links auth check --cookie-file <raw-cookie-file> --json
```

2. Check and, when needed, scope/spoof the session to the target location account. `auth check` only proves generic login; it does not prove the session is scoped to the customer account.

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links auth session --cookie-file <raw-cookie-file> --json
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links auth ensure-location <locationId> \
  --cookie-file <raw-cookie-file> \
  --cookie-out <updated-cookie-file> \
  --json
```

For location-specific reads and writes, prefer passing `--ensure-location-scope`; the CLI resolves the location's account, calls the production account-switch action for validation/audit, updates the NextAuth session cookie, and requires the resulting session account to match the target account before continuing. Never print cookie values.

3. Read current events before changing anything:

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links events list <locationId> --cookie-file <raw-cookie-file> --ensure-location-scope --json
```

4. For branding/social/app edits, read the selected write scope before changing anything:

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links branding get <locationId> --cookie-file <raw-cookie-file> --ensure-location-scope --json
```

5. For edits, run a dry run first and inspect `before`/`after`:

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links events set <locationId> video \
  --active true \
  --link 'https://example.com/video' \
  --button-text 'Watch Video' \
  --cookie-file <raw-cookie-file> \
  --ensure-location-scope \
  --json
```

6. Apply only after the dry run matches the requested change:

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links events set <locationId> video \
  --active true \
  --link 'https://example.com/video' \
  --button-text 'Watch Video' \
  --cookie-file <raw-cookie-file> \
  --ensure-location-scope \
  --apply \
  --json
```

7. Read back the target event or branding state and report the persisted state.

For a Tap Cards fulfillment, create badges only after the other settings writes. Read current
counts, dry-run, then apply with the stable Slack request key:

```bash
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links badges list <locationId> \
  --cookie-file <raw-cookie-file> --ensure-location-scope --json
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links badges bulk-create <locationId> \
  --quantity <2-100> --idempotency-key '<canonical-thread-ts>|<request-key>|badges' \
  --cookie-file <raw-cookie-file> --ensure-location-scope --json
~/.claude/skills/boostly-instore-link-settings/scripts/boostly-links badges bulk-create <locationId> \
  --quantity <2-100> --idempotency-key '<canonical-thread-ts>|<request-key>|badges' \
  --cookie-file <raw-cookie-file> --ensure-location-scope --apply --json
```

## Commands

- `events list <locationId>`: list current in-store/touchpoint events.
- `events objectives <locationId>`: list active objective options.
- `events set <locationId> <eventSelector>`: edit an existing event. Common selectors are `text club`, `reviews`, `downloads`, `socials`, `menu`, `order`, `careers`, `video`, or the event id.
- `events add-custom <locationId> --title <title> --link <url>`: add a custom link.
- Always pass `--category` for supported custom links. The CLI deterministically forces these
  compact presentation templates, even if the caller supplies different text:
  - `careers_jobs`: `Join Our Team` / `Grow with our team` / `Apply Now`
  - `ordering`: `Order Online` / `Order your favorites` / `Order Now`
  - `menu`: `Menu` / `See what's cooking` / `View Menu`
  - `catering`: `Catering` / `Food for your gathering` / `View Options`
  - `events`: `Events` / `See what's happening` / `View Events`
  - `reservations`: `Reservations` / `Save your table` / `Reserve Now`
- Every custom Link/Product event must have a compact description. Supported categories always
  receive the deterministic description above. Other allowed custom links preserve an explicit
  description of 40 characters or fewer, or receive the fallback `Learn more` when omitted.
- Never create Specials as a custom Link/Product event. The CLI rejects explicit Specials
  categories and titles such as `Daily Specials` or `Monthly Specials`, even when another
  category is supplied.
- Keep at most six active Linktree sections. When the cap requires deactivation, preserve this
  priority: Reviews, verified Socials, Subscribe, Order Online or Menu, verified upcoming Events
  or Reservations, Catering, Careers, then Apps. Order Online wins when both it and Menu are active;
  keep Menu configured but disabled rather than presenting both.
- Reviews are always active. Events are active only when current discovery verifies at least one
  upcoming event. Keep Careers configured but disable it when current discovery verifies no open
  positions. Socials are active only when current discovery verifies at least one active social.
- `events enforce-linktree-defaults <locationId>`: always activate Reviews and activate
  Socials when effective branding has at least one verified active social. Pass
  `--verified-socials-present true|false` and, when current discovery resolved them,
  `--verified-upcoming-events true|false` and `--verified-openings true|false`. Dry-run by default;
  repeat with `--apply`. It also disables Menu when Order Online is active, enforces the six-section
  cap, and normalizes the title, compact description, and CTA on recognized existing custom links.
  The command performs readback and fails closed when a required default event is missing instead
  of creating a fake custom event.
- `events delete <locationId> <eventSelector>`: remove an event from the saved full set.
- `events save-json <locationId> --file <events.json>`: save a full desired event array.
- `location get <locationId>`: read core location fields plus account-base, location-override, and effective branding.
- `location set <locationId>`: edit core location fields such as website and online ordering URL.
- `branding get <locationId>`: read account-base branding, location override branding, effective branding, and the auto-selected write scope.
- `socials set <locationId> --facebook-url <url>`: fill missing social URLs using
  the existing account/location save action. No new endpoint or deployment.
  Supports Facebook, Instagram, X, TikTok, and YouTube flags only; rejects
  branding flags, app URLs, clears, and conflicting existing social URLs.
  Dry-run returns `state_hash`; apply requires `--expected-state-hash <hash>`.
  The CLI carries current logo/color/app fields and location settings unchanged,
  rereads before saving to reject drift, and verifies all preserved fields afterward.
  It refuses form normalization that would alter unrelated stored settings.
  This is an optimistic client-side guard, not an atomic server compare-and-swap.
  The typed fulfillment executor supplies the preview hash automatically.
- `branding set <locationId>`: edit branding/social/app fields. Default `--scope auto` ignores General locations, writes account settings when the account has exactly one non-General enabled/paused location, and writes a location override when it has multiple non-General enabled/paused locations.
- `branding set <locationId> --logo-file <path>`: upload a PNG, JPEG, or GIF and assign the resulting attachment at the selected account/location scope. This uses the same production server action as the web form and does not require browser runtime.
- `branding set <locationId> --secondary-logo-file <path>` / `--secondary-logo-attachment-id <id>`: the V2 secondary logo for light backgrounds (form fields `secondary_logo_attachment_file` / `secondary_logo_attachment_id`, replica column `branding.secondary_logo_attachment_id`, added 2026-10). Same upload path, scope rules, dry-run/apply/readback/mismatch handling, and fill-only semantics as `--logo-file`; both logos can go in one write. `branding get` and every readback include `secondary_logo_attachment_id`, `secondary_logo_url`, and `secondary_logo_filename`. The whole row is replayed, so the secondary logo is carried forward unchanged on every other `branding set`; `--clear secondary_logo_attachment_id` removes it. In the brand workflow it is the on-white sticker asset, written in the closeout apply alongside the primary logo (since 2026-10-19; closeout-finish only backfills older runs).
- `branding set <locationId> --expect-logo-attachment-id <id|null>`: foreign-logo guard. Before any write (dry-run and `--apply` alike) the CLI compares the id to `logo_attachment_id` on the row at the selected scope, the row that will be replayed. On mismatch it exits 6 and prints both ids, the current `logo_filename`/`logo_url`, and the fix (pass `--logo-file` to replace the logo, or `--expect-logo-attachment-id <current>` to accept it). Skipped when `--logo-file` or `--logo-attachment-id` is supplied, because the replayed logo is discarded.
- `branding set <locationId> --expect-from-readback <path>`: same guard, but the expected id is derived from a prior readback JSON: either the `branding get` shape (`account_branding` / `override_branding` / `effective_branding`) or the `branding set --apply` output shape (the same object under `.readback`). It reads `account_branding` when the selected scope is account and `override_branding` when it is location, falling back to `effective_branding` when the scoped row is absent. Brand-design runners pass `--expect-from-readback <run-dir>/production-readback.json` on every `branding set` after the first apply. If both flags are given they must agree.
- `branding set <locationId> --expect-secondary-logo-attachment-id <id|null>`: the same guard for `secondary_logo_attachment_id`. `--expect-from-readback` also pins the secondary id when the readback file carries that field (a readback written before 2026-10 asserts nothing about it). Skipped when `--secondary-logo-file` or `--secondary-logo-attachment-id` is supplied. `secondary_logo_guard` in the output records the result.
- Every `branding set` dry run also prints `logo_replay` (`attachment_id`, `filename`, `uploaded_at` parsed from the `logo_url` timestamp prefix, note) so the reviewer sees the logo that will be carried forward, and, when unguarded, a one-line stderr `WARNING`. `logo_guard` in dry-run and apply output records whether the guard matched, was skipped, or was absent.
  Why (2026-09-09, Swine Dining `qbdaugsa2trj7p6x1tmzi22i`): we applied a knockout logo on 9/8, an app user uploaded a phone-photo JPG overnight, and a 9/9 `branding set` that changed only two secondary colors replayed the row and kept the foreign JPG. The before/after diff was clean because the logo was identical on both sides of the write; nobody noticed until the proof was viewed.
- `badges list <locationId>`: read active badge counts for one location from the authenticated in-store page. Add `--full` for badge IDs and issue IDs.
- `badges bulk-create <locationId> --quantity <2-100> --idempotency-key <key>`: bulk-create unassigned badges through the production app action. Dry-run is the default; `--apply` requires exact count and new-ID readback.
- `fulfillment get|store-details|branding|offer|ship-to|note <requestId>`: read a fulfillment request, flip its Store Details / Branding completion, edit its offer text, set the ship-to, or append to its internal notes through the admin page actions. See "fulfillment" below, including the Slack ping caveat.
- `auth session`: print sanitized current effective account/session metadata.
- `auth ensure-location <locationId>`: switch/spoof the authenticated session to the target location account, write an updated cookie header to `--cookie-out`, and print sanitized before/after metadata.

Writes are dry-run by default. `--apply` is required for persistence.

## Editable Event Fields

- `--active true|false`
- `--title`
- `--display-title`
- `--description`
- `--button-text`
- `--link`
- `--objective-id`
- `--promotion-id`
- `--welcome-message`
- `--config-json`
- `--clear description|button-text|link|objective-id|config|promotion-id|welcome-message`

Text club welcome message and promotion are represented on the subscribe event as `subscribe_link_response_message` and `subscribe_link_promotion_id`.

## Editable Location Fields

- `--website-url`
- `--ordering-url`
- `--name`
- `--address`
- `--ordering-phone-number`
- `--timezone`
- `--google-place-id`

Do not mix core location fields with branding/social/app fields in one command. The CLI refuses mixed writes because core fields write to the location action, while branding fields may write to account settings or a location override.

## Editable Branding/Social/App Fields

- `--facebook-url`
- `--instagram-url`
- `--x-url`
- `--tiktok-url`
- `--youtube-url`
- `--apple-app-url`
- `--google-app-url`
- `--web-primary-color`
- `--web-secondary-color`
- `--web-text-color`
- `--print-primary-color`
- `--print-secondary-color`
- `--print-text-color`
- `--print-text-secondary-color`
- `--logo-attachment-id`
- `--logo-file <path>`
- `--clear <field>`

Use `--logo-file` for a new local image and `--logo-attachment-id` for an attachment that already exists. They are mutually exclusive. Logo uploads remain dry-run by default; the dry run reports filename, content type, byte size, and selected scope without uploading. With `--apply`, the CLI uploads and saves in one server action, then reads branding back to report the minted `logo_attachment_id`.

## Branding Model

Production stores branding in `branding`, not on `locations`.

- Account-base branding rows have `branding.account_id = <accountId>` and `branding.location_id IS NULL`.
- Location overrides have `branding.location_id = <locationId>`.
- Effective branding resolves per field: location override first, then account-base; null/blank override values inherit from account-base.
- General locations (`is_general = true`) are always excluded from business-location matching, sibling counts, and branding scope decisions. Never let a General row force a location override or serve as the matched fulfillment location.
- `branding set --scope auto` writes account settings only when the target itself is the account's sole non-General enabled/paused location. It writes a location override when there are multiple non-General enabled/paused locations or when the sole non-General enabled/paused location is a sibling; it refuses to auto-select a scope if none are enabled/paused.
- Existing storage does not override that rule. If a sole-location account already has branding/social/app values in a location override, migrate the effective values to account scope first, then clear the redundant override and verify the effective readback is unchanged. Website/ordering fields and Link/Product touchpoint events remain location-scoped by design.
- `branding set --scope account` or `--scope location` can force the target when the operator has explicitly chosen that behavior.
- Every branding write, including an explicitly forced scope, requires current V2 location/account
  evidence. If V2 is unavailable, hold the write; the authenticated page alone cannot prove the
  non-General sibling count or safe account/location scope.

The CLI still requires an authenticated web page payload for writes. DB fallback reads are useful for inspection, but `--apply` refuses fallback-only location/branding writes. Branding writes also verify that the session's effective account matches the target location's DB account before calling the app action.

## Safety Rules

- `branding set` is a WHOLE-ROW REPLAY (2026-09-01, Tony & Tina's null-palette incident): even a
  logo-only `--logo-file` write reads the current row and resubmits every branding field from
  that read. It preserves untouched fields only as faithfully as its own read: pre-existing
  nulls/corruption are re-written, and a concurrent writer's changes landing between the read
  and the apply are silently reverted. Before any partial branding write, verify the untouched
  fields in that same readback against their expected values (a before/after drift check alone
  cannot catch damage that predates the write), never run concurrent branding writers against
  one account, and after apply confirm the untouched fields equal the expected values, not
  merely "unchanged".
- FOREIGN-LOGO REPLAY (2026-09-09, Swine Dining phone-photo incident): a before/after diff cannot
  catch a logo someone else uploaded between our writes, because the replay keeps it identical on
  both sides. Runners pass `--expect-from-readback <run-dir>/production-readback.json` on every
  `branding set` after the first apply, and any manual partial write pins the logo with
  `--expect-logo-attachment-id <id>`. Read `logo_replay` in every dry run before `--apply`.
- Do not create duplicate custom links if an inactive item already exists for the requested concept. Prefer updating the existing `Video`, `Menu`, `Order`, `Careers`, etc. item.
- Fulfillment writes use `--fill-only`, and custom-event dedupe compares canonical URLs. Run
  read → dry-run → apply → readback for each operation, sequentially; never batch saves against
  a stale event or location payload.
- Preserve existing events by using `events set` or `events add-custom`; the save action expects the full event array and omitting an existing event soft-deletes it.
- The CLI normalizes legacy inactive custom placeholders that have button text but no URL by
  clearing only their stale button text before a full-array save. The production schema rejects
  that legacy combination and would otherwise block unrelated Reviews, Socials, or Order changes.
- Event writes refuse to save from an empty baseline unless `--force-empty-events` is passed. Discovery/heartbeat automation must not use that force flag.
- For account-level branding writes, first confirm the requested location page loads under the current session; the CLI validates the page payload and authenticated effective account against the DB-resolved target before calling the account-settings action.
- Logo uploads accept only PNG, JPEG, and GIF files. Inspect the dry-run file metadata and selected scope before applying; a location-scope upload must not be changed to account scope when sibling locations should retain different branding.
- For customer-location reads/writes, use `--ensure-location-scope` or an updated cookie produced by `auth ensure-location`.
- Do not expose cookies, API keys, or env values in responses.
- For any write, state exactly what changed and include the readback result.
- Badge bulk creation accepts only 2–100, requires `--idempotency-key`, and stores a two-phase receipt in the shared ignored runs directory. It also takes an exclusive per-key lock before submission, so overlapping automation runs cannot both write. Never automatically retry a `started` or `ambiguous` receipt (including an interrupted lock); inspect the live location first.

## fulfillment: flip request statuses and edit the offer from the terminal

```bash
boostly-links fulfillment get <requestId> --cookie-file <path> [--json] [--full]
boostly-links fulfillment store-details <requestId> --confirm | --unconfirm [--apply] [--json]
boostly-links fulfillment branding <requestId> --complete | --incomplete [--apply] [--json]
boostly-links fulfillment offer <requestId> --text '20% Off' [--apply] [--json]
boostly-links fulfillment ship-to <requestId> --recipient '<name>' --line1 '<street>' [--line2 '<unit>'] --city '<city>' --state XX --zip 12345 [--apply] [--json]
boostly-links fulfillment note <requestId> --append '<line>' | --set '<notes>' [--apply] [--json]
```

Targets the admin page `new.boostly.com/admin/fulfillment/<requestId>` (admin session; no
account scoping or `--ensure-location-scope` needed) and replays its own server actions:
`setStoreDetailsConfirmedAction(requestId, bool)`, `setDigitalFulfillmentCompletedAction(requestId, bool)`
("branding" in the admin UI), and `updateFulfillmentOfferAction(requestId, { promotion_id: null, text })`.
The inverse of each status flip exists (`--unconfirm`, `--incomplete`). Reads and the post-apply
readback parse the `request` prop the page renders (offer, stamps, items, ship-to, `state`); the
V2 replica adds `physical_fulfillment_notified_at` and must agree with the page on request id and
location id/name, otherwise the CLI exits 6 and `--apply` refuses when the replica is unreachable.

- Dry run (default) prints the exact `before`/`after` for the fields it changes, `state_before` /
  `state_after` (a local port of `getFulfillmentState`), `enters_physical_fulfillment`,
  `reopens_prints`, and `slack_ping.expected`. A no-op (value already set) or a server-rule refusal
  (canceled request, shipped request, confirm without a usable ship-to/offer) never calls the action.
- SLACK PING CAVEAT: every one of these actions ends in `runMutation()`, which schedules
  `notifyFulfillmentReadyForPhysical(requestId)` after the transaction. When the request's state
  is `physical_fulfillment` (branding complete AND store details confirmed with usable data AND
  something unprinted) and `physical_fulfillment_notified_at` is null, production posts
  "*<location>* is ready for physical fulfillment" to `#fulfillment`, threaded under the request's
  `slack_thread_ts` when it has one, and stamps the request. So `store-details --confirm` or
  `branding --complete` on the last-open gate pings ops, and so does ANY save (even a no-op offer
  save) on a request that is already ready but un-pinged. The stamp resets only when the request
  regresses below physical fulfillment (`--unconfirm`, `--incomplete`), so it can ping again later.
  The dry run predicts this and `--apply` prints a stderr `WARNING:` line first; after apply the CLI
  polls the replica up to 20 s for the stamp and reports `slack_ping_observed`.
- `ship-to` replays `updateShippingAddressAction(requestId, address)`: the address lives on the
  request's LOCATION row (`locations.shipping_*`, shared by every request for that location), not on
  the request. It validates like the admin form (trimmed, 2-letter state, 5/9-digit ZIP), invalidates
  unpurchased shipping quotes, logs `shipping_updated`, and leaves both confirmation stamps alone.
  Because store-details completeness reads the address, adding one to a confirmed-but-addressless
  request can by itself move it into `physical_fulfillment` and ping (the dry run predicts this).
- `note` replays `updateNotesAction(requestId, notes)`, the admin page's "Add internal notes"
  textarea (`fulfillment_requests.notes`; `fulfillmentNotesSchema` = trimmed, 2000 chars max,
  blank stored as null). `--append '<line>'` re-reads the current notes and writes them back with
  the line added underneath (never erases existing notes); `--set` replaces them (`--set ''`
  clears). Dry run prints before/after `notes`; apply reads back the page and fails if the text
  differs. Notes never change the request state, so the only Slack case is the general one above
  (a ready-but-un-pinged request pings on ANY save). Cam's lookup convention: after building a
  signage section, `note --append 'Figma signage: <section canvas url>'`. `get` now prints `notes`.
  Verified live 2026-09-18 on nine Store Details requests (Place Pizza, Gregorio's x4, Coriander x3):
  note append (no ping, state stayed store_details), then `store-details --confirm` pinged each.
- Offer text is custom text only (`promotion_id` written as null, 1-200 chars, trimmed). Changing it
  reopens `printed_at` on signage/sticker items (`reopens_prints`), never tapcards. Convention seen
  in production (2026-09-16): plain `20% Off` / `10% Off $30+` style; promotion-linked snapshots use
  the promo title (`20% OFF`). The wizard default is `Join the Club!`.
- Verified live 2026-09-16 on Olympus Pizza `iv1dzvf6qhnfpjzyvvticbhd`: offer `Enjoyed your meal?`
  -> `20% Off` (no ping, state stayed `store_details`), then `store-details --confirm` moved it to
  `physical_fulfillment` and the replica showed `physical_fulfillment_notified_at` one second later.

## offer set: make the signup pay what the sign says (one step)

```bash
boostly-links offer set <location-id> --title '25% OFF' --code SAVE25 --value 25 \
  [--description '...'] [--terms '...'] --cookie-file <path> [--apply] [--json]
```

Reuses an existing non-deleted promotion with that title on the account or
creates it (createPromotion action), points the location's text club subscribe
event at it, then reads back `keywords.promotion_id` for the SUBSCRIBE_ keyword
and fails loudly if it did not change. Dry-run prints existing promos, what
would be created or reused, and the before/after promotion id. This is the
required fix for a preflight OFFER_MISMATCH / INVITE_NOT_LOADED before print.
If the action id has rotated after a deploy, the CLI self-heals (see
"Action-id rotation" below). Verified 2026-09-03: dry-run on Vito's reports reuse of "25% OFF"
vamvm6mv7kve4gem3dyeyzzb with no change.

## promotions create: one custom promotion (signage offer that has no promo)

```bash
boostly-links promotions create <location-id> --title '$10 OFF' --description '$10 off your next order' \
  --code SAVE10 --value 10 --cookie-file <path> [--apply] [--json]
```

Replays the /promotions/new createPromotion action (all three redemption types
active with the same code, terms default "Not valid w/ other offers."). Refuses
duplicate titles on the account. Then point the signup at it:
`events set <loc> "text club" --promotion-id <new-id> --ensure-location-scope --apply`;
verify `keywords.promotion_id` for the location's SUBSCRIBE_ keyword changed.
Response echo shows `$$10 OFF` / `$D<date>`: that is RSC encoding in the echo,
the DB row is correct (verified 2026-09-03, Butt Hutt t4slj3vg9gg7zzechdydujfe).
Use this whenever a sign promises a specific offer the account does not have. RULE (Travisse
2026-09-16): an offer change is always a NEW promotion, never an edit of an existing one, unless
that exact promotion (same title and value) already exists on the account; then reuse it. Never
edit the default 20% promo to become the agreed offer.

## subscribe-link set: fix the join-page offer copy after a promotion change

```bash
boostly-links subscribe-link set <location-id> --promotion-text '10% off orders of $30 or more' \
  [--promotion-id <id>] [--subscribe-link-id <id>] --cookie-file <path> --ensure-location-scope [--apply] [--json]
```

`offer set` and `events set --promotion-id` repoint the SUBSCRIBE_ keyword, but
`subscribe_links.promotion_text` (the offer copy on the public `/l/<link>` join
page and the Click to Join editor) is stamped once by touchpoint init from the
promotion description and is never updated afterwards (2026-09-16, Mara's
Snackery `n2nlek5tqbp1j4m1tudghshr`: keyword paid "10% OFF $30+" while the join
page still said "20% off your next order"). This command replays the Click to
Join edit page's `updateSubscribeLink` action, which writes the keyword promotion
and the link text in one transaction. It is a WHOLE-FORM REPLAY of the rendered
edit page (`subscribeLink` flight prop, mirroring the edit form's defaultValues):
dry-run prints before/after plus every replayed untouched field; `--apply`
re-reads immediately before the write, refuses on drift, then reads back the page
and the V2 replica and fails (exit 5) if text, keyword promotion, or any untouched
field differs. Targets the location's single live touchpoint link unless
`--subscribe-link-id` is given. Convention for the copy: the linked promotion's
`description` verbatim (that is what init writes; e.g. "10% off orders of $30 or
more" for the default "10% OFF $30+"). Run it after `offer set`.

## instore-init: provision touchpoints/promotions for uninitialized locations

For locations whose onboarding never completed (`touchpoints_initialized_at`
is null; wizard-created locations reach the fulfillment queue this way), these
commands replay the app's own authenticated server actions (no DB writes) to
reproduce the completed-onboarding state:

```bash
boostly-links instore-init status <location-id>                 # diff vs completed state
boostly-links instore-init provision-events <location-id>       # location events from defaults (+ CTJ when subscribe activates)
boostly-links instore-init provision-signage <location-id>      # the 7 DEFAULT_SIGNAGE touchpoints + review-focused overrides
boostly-links instore-init provision-signage <location-id> --only "Tables - Reviews,To-Go - Reviews,Bathroom - Subscribe,Bathroom - Reviews"   # legacy hand-named signage: create exactly these defaults, leave existing ones untouched
boostly-links instore-init provision-promotions <account-id>    # the 6 default catalog promos (invite-first ordering preserved)
boostly-links instore-init provision-objectives <location-id>   # 'New Subscriber' + 'Google Review' wired to events
boostly-links instore-init delete-objective <location-id> <objective-id>  # soft-delete a NON-default objective (dupe cleanup)
```

Rules: dry-run by default (`--apply` to write); `auth ensure-location` before
every write (shared session gets re-spoofed); idempotent per piece; run
events → promotions → signage → objectives; verify afterward via the v2
signage endpoint and the join page. Order matters for signage: events must
exist first (review-focused signage copies overrides from them).

ACTION-ID ROTATION (self-healing since 2026-09-16): every server-action id
rotates on every prod deploy (proven live 2026-09-01 and 2026-09-14). The
live table is `scripts/action-ids.json` (build id + `derived_at` + one id per
action); the hardcoded table in `boostly-links.ts` is only the fallback when
that file is missing, and `BOOSTLY_ACTION_ID_<SNAKE_UPPER_KEY>` /
`BOOSTLY_SWITCH_ACCOUNT_ACTION_ID` env overrides still win. Rotation is
detected precisely (HTTP 404 + `x-nextjs-action-not-found: 1` header / body
"Server action not found."; a page 404 from a wrong account scope is NOT
matched). On detection the CLI derives fresh ids from the live page chunks
ONCE per process, rewrites `action-ids.json`, logs one `[boostly-links]
self-heal:` line to stderr (which actions, old build -> new build), then:
read actions (`getEvents`, `getObjectives`, `switchUserAccount`) are retried
once; write actions are never retried: the command aborts with "Nothing was
written ... rerun the command" (the 404 proves the action did not execute,
and the healed table makes the rerun succeed). A second rotation in the same
process is never healed again. Manual check or repair after a deploy:

```bash
node --experimental-strip-types ~/.claude/skills/boostly-instore-link-settings/scripts/derive-actions.ts --check --cookie-file <raw-cookie-file>   # exit 3 if any id changed
node --experimental-strip-types ~/.claude/skills/boostly-instore-link-settings/scripts/derive-actions.ts --write --cookie-file <raw-cookie-file>   # rewrite action-ids.json
```

Both take `--location <id>` (a location in the session's current account) to
reach the account-scoped pages (in-store links, location settings, signage,
objectives); without it the first enabled location of the session account is
used. `--request <id>` picks the fulfillment request for the admin
`/admin/fulfillment/<id>` page (default: latest non-canceled request from V2;
any request works because the page is admin-scoped). Keys reported as "not
derivable" keep their previous id; scope the session to that account
(`auth ensure-location`) and rerun. Never print the cookie.

DO NOT run `provision-objectives` for a location whose account has a PENDING
(incomplete) onboarding session: when reps complete the session, real
initialization creates the `is_default:true` objectives itself and the
app-created `is_default:false` rows DUPLICATE (proven live on Fahrenheit
Charlotte 2026-09-01; until CORE-1089 / PR #1464 merges, real init has no
name-based dedupe). Run objectives only when the location has NO onboarding
session, or the session is already completed and the objectives are missing.
Cleanup when duplication has already happened: `delete-objective` on the
`is_default:false` rows (the app action nulls event wiring and removes the
row's platform mappings), then re-wire the subscribe/review events to the
surviving `is_default:true` rows via `events set <loc> subscribe|review
--objective-id <id>`, and verify one live row per name.

Known limits (only real `initializeTouchpointsForLocation` can do these):
`touchpoints_initialized_at` stamp; `is_default`/`is_priority` flags on
objectives (app-created rows are is_default:false — CORE-1089 adds name-based
dedupe so a later real init won't duplicate them); social-platform objective
mappings; the PAUSED engage rotation (the exposed rotation action goes ACTIVE
+ publishes NATS — never replay it). Transport note: RSC decodeReply treats a
leading `$` in string args as a reference marker; callServerAction escapes it
(don't bypass it for promo titles like "$5 OFF $30+").
