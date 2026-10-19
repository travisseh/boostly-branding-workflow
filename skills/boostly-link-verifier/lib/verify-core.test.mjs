#!/usr/bin/env node

import assert from "node:assert/strict";
import { collectEvidence, decide, eventTimingDecision, extractStructuredEventDates, isLoginWallOrEmptyShell, parseFollowerCount, SOCIAL_BUSINESS_SIGNAL_THRESHOLDS, visibleTextEventDates } from "./verify-core.mjs";

const link = {
  input_url: "https://example.com/event",
  link_type: "custom_event",
  category: "events",
};
const location = {
  account_name: "Example Restaurant",
  location_name: "Example Restaurant",
  full_address: "123 Main St, Denver, CO 80202",
};

function verify(evidence) {
  return decide(link, location, {
    ok: true,
    http_status: 200,
    final_url: link.input_url,
    ...evidence,
  }, new Map());
}

const unsafeCases = [
  [
    "extension challenge without HTTP metadata",
    { http_status: null, title: "Just a moment...", text: "Verify you are human. Checking your browser." },
    "needs_manual_review",
    "security_or_bot_challenge_detected=true",
  ],
  [
    "challenge served with a success status",
    { http_status: 200, title: "Security verification", text: "Complete verification to continue." },
    "needs_manual_review",
    "security_or_bot_challenge_detected=true",
  ],
  [
    "soft 404",
    { title: "404: Page not found - Example Restaurant", h1: ["Page Not Found"] },
    "broken",
    "soft_not_found_page_detected=true",
  ],
  [
    "bot challenge",
    { http_status: 403, title: "Just a moment...", text: "Checking your browser before accessing" },
    "needs_manual_review",
    "security_or_bot_challenge_detected=true",
  ],
  [
    "timeout",
    { ok: false, http_status: null, error: "page.goto: Timeout 30000ms exceeded" },
    "needs_manual_review",
    "fetch_timeout_soft=true",
  ],
  [
    "HTTP error",
    { ok: false, http_status: 503, title: "Service unavailable" },
    "broken",
    "http_status=503",
  ],
];

for (const [name, evidence, expectedStatus, evidenceMarker] of unsafeCases) {
  const result = verify(evidence);
  assert.equal(result.status, expectedStatus, name);
  assert.notEqual(result.status, "verified", name);
  assert(result.validity_evidence.includes(evidenceMarker), name);
}

const bodyOnlyError = verify({
  title: "Example Restaurant",
  h1: ["Example Restaurant"],
  text: "Sorry, we couldn't find the page you requested. Return to our homepage.",
});
assert.equal(bodyOnlyError.status, "broken");
assert.equal(bodyOnlyError.destination_state, "hard_rejection");
assert(bodyOnlyError.validity_evidence.includes("soft_not_found_page_detected=true"));

const alternateBodyOnlyError = verify({
  title: "Error Page",
  h1: ["Sorry, we were not able to find that page."],
  text: "Sorry, we were not able to find that page. Go to the web-ordering main page.",
});
assert.equal(alternateBodyOnlyError.status, "broken");
assert.equal(alternateBodyOnlyError.destination_state, "hard_rejection");
assert(alternateBodyOnlyError.validity_evidence.includes("soft_not_found_page_detected=true"));

const unavailableFacebook = decide({
  input_url: "https://www.facebook.com/ExampleRestaurant",
  link_type: "social_facebook",
  category: "facebook",
}, location, {
  ok: true,
  http_status: 200,
  final_url: "https://www.facebook.com/ExampleRestaurant",
  title: "Facebook",
  text: "This content isn't available right now. The owner only shared it with a small group of people, changed who can see it or it's been deleted.",
}, new Map());
assert.equal(unavailableFacebook.status, "broken");
assert.equal(unavailableFacebook.destination_state, "hard_rejection");
assert(unavailableFacebook.destination_state_evidence.includes("hard_failure_detected=true"));
assert(unavailableFacebook.validity_evidence.includes("platform_unavailable_page_detected=true"));

const craftOrderingUnavailable = decide({
  input_url: "https://www.toasttab.com/local/order/craft-by-smoke-and-fire",
  link_type: "ordering_menu",
  category: "ordering",
}, {
  account_name: "Craft by Smoke and Fire",
  location_name: "Craft by Smoke and Fire",
  website_url: "https://craftbysmokeandfire.com/",
  shipping_city: "Anaheim",
}, {
  ok: true,
  http_status: 200,
  final_url: "https://www.toasttab.com/local/order/craft-by-smoke-and-fire",
  title: "Craft by Smoke and Fire | Online Ordering",
  text: "Online ordering is currently unavailable. Please check back soon.",
}, new Map());
assert.equal(craftOrderingUnavailable.status, "rejected");
assert.equal(craftOrderingUnavailable.destination_state, "configured_but_disabled");
assert(craftOrderingUnavailable.destination_state_evidence.includes("ordering_unavailable_detected=true"));

const californiaGrillNoOpenings = decide({
  input_url: "https://californiagrill.com/careers",
  link_type: "other",
  category: "careers",
}, {
  account_name: "California Grill",
  location_name: "California Grill",
  website_url: "https://californiagrill.com/",
  shipping_city: "Whittier",
}, {
  ok: true,
  http_status: 200,
  final_url: "https://californiagrill.com/careers",
  title: "Careers | California Grill",
  h1: ["Join California Grill"],
  text: "There are currently no open positions. Please check back later.",
}, new Map());
assert.equal(californiaGrillNoOpenings.status, "rejected");
assert.equal(californiaGrillNoOpenings.destination_state, "configured_but_disabled");
assert(californiaGrillNoOpenings.destination_state_evidence.includes("careers_no_openings_detected=true"));

const dormantSocial = decide({
  input_url: "https://www.instagram.com/examplerestaurant/",
  link_type: "social_instagram",
  category: "instagram",
}, location, {
  ok: true,
  http_status: 200,
  final_url: "https://www.instagram.com/examplerestaurant/",
  title: "Example Restaurant (@examplerestaurant)",
  text: "No posts yet",
}, new Map());
assert.equal(dormantSocial.status, "rejected");
assert.equal(dormantSocial.destination_state, "configured_but_disabled");
assert(dormantSocial.destination_state_evidence.includes("dormant_social_profile_detected=true"));

const genericHomepageOrdering = decide({
  input_url: "https://example.com/",
  link_type: "ordering_menu",
  category: "ordering",
}, {
  ...location,
  website_url: "https://example.com/",
}, {
  ok: true,
  http_status: 200,
  final_url: "https://example.com/",
  title: "Example Restaurant",
  h1: ["Example Restaurant"],
  text: "Welcome to Example Restaurant in Denver.",
  links: ["https://example.com/about", "https://example.com/contact"],
}, new Map());
assert.equal(genericHomepageOrdering.relevance, "match");
assert.equal(genericHomepageOrdering.status, "rejected");
assert.equal(genericHomepageOrdering.destination_state, "hard_rejection");
assert(genericHomepageOrdering.destination_state_evidence.includes("ordering_action_evidence=false"));

const homepageWithOrderingAction = decide({
  input_url: "https://example.com/",
  link_type: "ordering_menu",
  category: "ordering",
}, {
  ...location,
  website_url: "https://example.com/",
}, {
  ok: true,
  http_status: 200,
  final_url: "https://example.com/",
  title: "Example Restaurant",
  h1: ["Example Restaurant"],
  text: "Welcome to Example Restaurant in Denver.",
  action_labels: ["Order Online"],
  labeled_links: [{ href: "https://orders.example.com/store/123", label: "Order Online", source: "anchor" }],
}, new Map());
assert.equal(homepageWithOrderingAction.status, "verified");
assert.equal(homepageWithOrderingAction.destination_state, "functional");
assert(homepageWithOrderingAction.destination_state_evidence.includes("ordering_action_signal=ordering_action_control"));

const trackedWebsite = decide({
  input_url: "https://example.com/?locationId=denver&utm_source=tapcard&fbclid=abc123",
  link_type: "website",
  category: "website",
}, {
  ...location,
  website_url: "https://example.com/",
}, {
  ok: true,
  http_status: 200,
  final_url: "https://example.com/?locationId=denver&utm_source=tapcard&fbclid=abc123",
  title: "Example Restaurant",
  h1: ["Example Restaurant in Denver"],
}, new Map());
assert.equal(trackedWebsite.url_canonicalization.has_removable_tracking_params, true);
assert.deepEqual(trackedWebsite.url_canonicalization.removable_tracking_params, ["utm_source", "fbclid"]);
assert.deepEqual(trackedWebsite.url_canonicalization.retained_input_query_params, ["locationId"]);
assert.match(trackedWebsite.url_canonicalization.canonical_input_url, /locationId=denver/);
assert.doesNotMatch(trackedWebsite.url_canonicalization.canonical_input_url, /utm_source|fbclid/);

const challengeDestination = verify({
  http_status: 403,
  title: "Just a moment...",
  text: "Checking your browser before accessing",
});
assert.equal(challengeDestination.destination_state, "security_or_bot_challenge");
assert(challengeDestination.destination_state_evidence.includes("security_or_bot_challenge_detected=true"));

const officialSiteOnlyInstagram = decide({
  input_url: "https://www.instagram.com/mickscrabhouse/",
  link_type: "social_instagram",
  category: "instagram",
  officialWebsiteLinksCandidate: true,
}, {
  account_name: "Mick's Pub & Crabs",
  location_name: "Mick's Pub & Crabs",
  website_url: "https://mickspub.com/",
  shipping_city: "Elkton",
  shipping_zip: "21921",
}, {
  ok: true,
  final_url: "https://www.instagram.com/accounts/login/?next=%2Fmickscrabhouse%2F",
  title: "Mick's Crab House (@mickscrabhouse) - Instagram photos and videos",
  meta: {
    description: "Mick's Crab House serves exceptional seafood.",
    "og:url": "https://www.instagram.com/mickscrabhouse/",
  },
  links: [],
}, new Map());
assert.equal(officialSiteOnlyInstagram.status, "needs_manual_review");
assert.equal(officialSiteOnlyInstagram.relevance, "uncertain");
assert(officialSiteOnlyInstagram.location_match_evidence.includes("official_website_links_to_candidate=true"));
assert.match(officialSiteOnlyInstagram.rejection_reason, /did not independently confirm/i);

const corroboratedInstagram = decide({
  input_url: "https://www.instagram.com/examplerestaurant/",
  link_type: "social_instagram",
  category: "instagram",
  officialWebsiteLinksCandidate: true,
}, {
  account_name: "Example Restaurant",
  location_name: "Example Restaurant",
  website_url: "https://example.com/",
  shipping_city: "Denver",
  shipping_zip: "80202",
}, {
  ok: true,
  final_url: "https://www.instagram.com/examplerestaurant/",
  title: "Example Restaurant (@examplerestaurant) - Instagram photos and videos",
  meta: {
    description: "Example Restaurant in Denver.",
    "og:url": "https://www.instagram.com/examplerestaurant/",
  },
  links: [],
}, new Map());
assert.equal(corroboratedInstagram.status, "verified");
assert(corroboratedInstagram.location_match_evidence.includes("social_destination_identity_signal=true"));

const unavailableOrdering = decide({
  input_url: "https://order.example.com/store?utm_source=website",
  link_type: "ordering_menu",
  category: "ordering",
}, location, {
  ok: true,
  http_status: 200,
  final_url: "https://order.example.com/store?utm_source=website",
  title: "Example Restaurant Online Ordering",
  text: "Online ordering is temporarily unavailable.",
}, new Map());
assert.equal(unavailableOrdering.status, "rejected");
assert.equal(unavailableOrdering.destination_state, "configured_but_disabled");
assert.deepEqual(unavailableOrdering.url_canonicalization.removable_tracking_params, ["utm_source"]);

const futureEvent = verify({
  title: "Upcoming Events - Example Restaurant",
  text: "Live music and dinner at Example Restaurant.",
  event_dates: ["2099-08-12T19:00:00-06:00"],
});
assert.equal(futureEvent.event_timing.has_upcoming_event, true);
assert(futureEvent.event_timing.evidence.includes("upcoming_event_evidence=true"));

const pastEventsOnly = verify({
  title: "Events Archive - Example Restaurant",
  text: "Past events at Example Restaurant.",
  event_dates: ["2020-08-12T19:00:00-06:00"],
});
assert.equal(pastEventsOnly.event_timing.has_upcoming_event, false);
assert(pastEventsOnly.event_timing.evidence.includes("upcoming_event_evidence=false"));

assert.deepEqual(extractStructuredEventDates(`
  <time datetime="2099-09-01T18:30:00-06:00">September 1</time>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Event","startDate":"2099-10-02T19:00:00-06:00"}
  </script>
`), [
  "2099-09-01T18:30:00-06:00",
  "2099-10-02T19:00:00-06:00",
]);

let browserEscalations = 0;
const staticOnly = await collectEvidence(
  "data:text/html,<title>Example Restaurant</title><h1>Example Restaurant Denver</h1>",
  async () => {
    browserEscalations += 1;
    throw new Error("browser should not be requested for sufficient static evidence");
  },
);
assert.equal(staticOnly.fetch_method, "static_fetch");
assert.equal(browserEscalations, 0);

// ---- soft 404 served as a 200 (cbgnevada.com/order/<slug>, 2026-09-22): broken, never manual review ----
const cbgnevadaBody = verify({
  http_status: 200,
  final_url: "https://cbgnevada.com/order/chuys-baja-grill-henderson-2560-saint-rose-parkway-suite-150",
  title: "Page not found",
  h1: ["Oops. This page does not exist!"],
  text: "Oops. This page does not exist! Home",
});
assert.equal(cbgnevadaBody.status, "broken");
assert.equal(cbgnevadaBody.destination_state, "hard_rejection");
assert(cbgnevadaBody.validity_evidence.includes("soft_not_found_page_detected=true"));

for (const [name, evidence] of [
  ["oops heading only, brand title", { title: "CHUY\u2019S", h1: ["Oops. This page does not exist!"], text: "Oops. This page does not exist! Home" }],
  ["body-only page doesn't exist", { title: "CHUY\u2019S", text: "Sorry, this page doesn't exist. Go back home." }],
  ["we can't find that page", { title: "Example Restaurant", h1: ["We can\u2019t find that page"], text: "We can't find that page. Try the menu." }],
  ["no longer available heading", { title: "Example Restaurant", h1: ["This page is no longer available"], text: "This page is no longer available." }],
  ["page no longer exists body", { title: "Example Restaurant", text: "The page you're looking for is no longer available." }],
]) {
  const result = verify({ http_status: 200, ...evidence });
  assert.equal(result.status, "broken", name);
  assert(result.validity_evidence.includes("soft_not_found_page_detected=true"), name);
}
// A live page that merely mentions "oops" or "no longer available" in passing is NOT a soft 404.
const livePassingMention = verify({
  http_status: 200,
  title: "Menu - Example Restaurant",
  h1: ["Our Menu"],
  text: "Example Restaurant Denver menu. Oops, the seasonal pumpkin latte is no longer available this week. Tacos $7.",
});
assert.equal(livePassingMention.liveness, "live");
assert(!livePassingMention.validity_evidence.includes("soft_not_found_page_detected=true"));

// ---- social business-signal gate (instagram.com/Chuys, 2026-09-22) ----
const chuysLocation = {
  account_name: "Chuy's",
  location_name: "CHUY\u2019S (Henderson)",
  website_url: "http://www.cbgnevada.com/",
  shipping_city: "Henderson",
  shipping_zip: "89074",
  ordering_phone_number: "+1 725-204-9251",
  address: "2560 St Rose Pkwy #150, Henderson, NV 89074, USA",
};
const socialLink = (url, category) => ({ input_url: url, link_type: `social_${category}`, category, officialWebsiteLinksCandidate: true });
const namelessInstagram = decide(socialLink("https://www.instagram.com/Chuys/", "instagram"), chuysLocation, {
  ok: true,
  http_status: 200,
  final_url: "https://www.instagram.com/Chuys/",
  title: "(@chuys) \u2022 Instagram photos and videos",
  meta: {
    "og:title": " (@Chuys) \u2022 Instagram photos and videos",
    "og:description": "32 Followers, 0 Following, 42 Posts - See Instagram photos and videos from  (@Chuys)",
    description: "32 Followers, 0 Following, 42 Posts - @Chuys on Instagram: \"\"",
  },
  text: "chuys 32 followers 0 following Show more posts from Chuys Meta About Blog Jobs Help API Privacy Terms Locations",
  links: ["https://www.instagram.com/accounts/login/", "https://about.meta.com/"],
}, new Map());
assert.equal(namelessInstagram.status, "rejected", "nameless 32-follower profile is rejected, not held");
assert.equal(namelessInstagram.relevance, "mismatch");
assert(namelessInstagram.location_match_evidence.includes("social_no_business_signal=true"));
assert(namelessInstagram.location_match_evidence.includes("social_followers=32"));
assert(namelessInstagram.location_match_evidence.includes("social_reject_reason=identity_mismatch"));
assert.match(namelessInstagram.rejection_reason, /no business signal/);

// A login wall exposes nothing. Anchored from the official site it is verified_by_anchor (Link write
// gate, 2026-10-19); without the anchor it is still held, never auto-rejected.
const loginWallEvidence = {
  ok: true,
  http_status: 200,
  final_url: "https://www.instagram.com/accounts/login/",
  title: "Instagram",
  text: "Log in Phone number, username, or email Password Log in Forgot password? Sign up",
  links: [],
};
const loginWalledInstagram = decide(socialLink("https://www.instagram.com/example.restaurant/", "instagram"), chuysLocation, loginWallEvidence, new Map());
assert.equal(loginWalledInstagram.status, "verified");
assert.equal(loginWalledInstagram.status_basis, "verified_by_anchor");
assert.equal(loginWalledInstagram.liveness, "live");
assert.equal(loginWalledInstagram.relevance, "match");
assert(loginWalledInstagram.location_match_evidence.includes("verified_by_anchor=true"));
assert(loginWalledInstagram.location_match_evidence.includes("official_website_links_to_candidate=true"));
const unanchoredLoginWall = decide({ ...socialLink("https://www.instagram.com/example.restaurant/", "instagram"), officialWebsiteLinksCandidate: false }, chuysLocation, loginWallEvidence, new Map());
assert.equal(unanchoredLoginWall.status, "needs_manual_review");
assert.equal(unanchoredLoginWall.status_basis, "evidence");
// A readable profile stands on its own evidence: the anchor never overrides what the page says.
assert.equal(isLoginWallOrEmptyShell(loginWallEvidence), true);
assert.equal(isLoginWallOrEmptyShell({ ok: true, http_status: 200, title: "Log in to Facebook", text: "Log in to Facebook Email or phone number Password Forgot account? Create new account", meta: { "og:title": "Log in or sign up to view" } }), true);
assert.equal(isLoginWallOrEmptyShell({ ok: true, http_status: 200, final_url: "https://www.instagram.com/accounts/login/?next=%2Fmickscrabhouse%2F", title: "Mick's Crab House (@mickscrabhouse) - Instagram photos and videos", meta: { "og:url": "https://www.instagram.com/mickscrabhouse/", description: "Mick's Crab House serves exceptional seafood." } }), false);
assert.equal(isLoginWallOrEmptyShell({ ok: false, error: "fetch failed" }), false);

// A small real business page with an address match is never rejected by the follower floor.
const smallBusinessFacebook = decide(socialLink("https://www.facebook.com/chuyshenderson", "facebook"), chuysLocation, {
  ok: true,
  http_status: 200,
  final_url: "https://www.facebook.com/chuyshenderson",
  title: "Chuy's-Henderson | Henderson NV",
  text: "Chuy's-Henderson 28 followers 0 following Restaurant 2560 St Rose pkwy #150, Henderson, NV, United States, 89074 cbgnevada.com (725) 204-9251",
  links: ["https://l.facebook.com/l.php?u=http%3A%2F%2Fcbgnevada.com%2F"],
}, new Map());
assert.equal(smallBusinessFacebook.status, "verified");
assert(smallBusinessFacebook.location_match_evidence.some((line) => /^social_business_signals=/.test(line)));

// Same name, different business: links another own-brand site, no address or phone match → rejected.
const texMexChain = decide({ input_url: "https://www.facebook.com/Chuys.Restaurants", link_type: "social_facebook", category: "facebook" }, chuysLocation, {
  ok: true,
  http_status: 200,
  final_url: "https://www.facebook.com/Chuys.Restaurants",
  title: "Chuy's | Facebook",
  text: "Chuy's 122K followers 11 following WELCOME TO THE OFFICIAL CHUY'S RESTAURANTS PAGE. Check us out at http://www.chuys.com and follow our Tex-Mex Restaurant Links chuys.com Contact info hey@chuys.com",
  links: ["https://chuys.com/", "https://www.facebook.com/Chuys.Restaurants/about"],
}, new Map());
assert.equal(texMexChain.status, "rejected", "a different brand's page with its own website is rejected");
assert(texMexChain.location_match_evidence.some((line) => line.startsWith("social_links_other_domain=chuys.com")));

// Same name, no other website, no geo: genuinely ambiguous → held, as before.
const ambiguousSameName = decide({ input_url: "https://www.facebook.com/chuys", link_type: "social_facebook", category: "facebook" }, chuysLocation, {
  ok: true,
  http_status: 200,
  final_url: "https://www.facebook.com/chuys",
  title: "Chuy's | Facebook",
  text: "Chuy's 4.2K followers Restaurant Great tacos and margaritas every day",
  links: [],
}, new Map());
assert.equal(ambiguousSameName.status, "needs_manual_review");

assert.equal(parseFollowerCount("16.2K Likes. 163 Followers. Food from all over"), 163);
assert.equal(parseFollowerCount("122K followers \u2022 11 following"), 122000);
assert.equal(parseFollowerCount("no counts here"), null);
assert.equal(SOCIAL_BUSINESS_SIGNAL_THRESHOLDS.min_followers, 100);

console.log("verify-core: ok");

// ---- visible upcoming events in readable text (Link write gate, 2026-10-19) ----
const eventsNow = new Date("2026-10-19T12:00:00Z");
const visible = visibleTextEventDates({
  title: "Events | Example Restaurant",
  text: "Trivia Night Thursday, October 22 at 7pm. Halloween Bash Oct. 31st. Our Sept 5 party was a blast. New Year's Eve 12/31/2026. Open Mon-Fri 11/2 price special.",
}, eventsNow);
assert.deepEqual(visible.map((item) => item.raw), ["2026-10-22", "2026-10-31", "2026-12-31"], "past and numeric-without-year dates are ignored");
const visibleTiming = eventTimingDecision({ event_dates: [], text: "Live music Saturday, November 14" }, eventsNow);
assert.equal(visibleTiming.has_upcoming_event, true);
assert.equal(visibleTiming.source, "visible_text");
assert.deepEqual(visibleTiming.upcoming_event_dates, ["2026-11-14"]);
assert(visibleTiming.evidence.includes("upcoming_event_source=visible_text"));
const structuredTiming = eventTimingDecision({ event_dates: ["2026-11-20"], text: "Live music Saturday, November 14" }, eventsNow);
assert.equal(structuredTiming.source, "structured", "a future structured date wins over readable text");
assert.deepEqual(structuredTiming.upcoming_event_dates, ["2026-11-20"]);
const pastOnly = eventTimingDecision({ event_dates: ["2026-09-01"], text: "Thanks for coming on September 1!" }, eventsNow);
assert.equal(pastOnly.has_upcoming_event, false);
assert.equal(pastOnly.source, null);
