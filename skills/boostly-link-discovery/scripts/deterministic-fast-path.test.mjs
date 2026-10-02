#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyLunaEventReview,
  bestByStatus,
  buildEventLunaPacket,
  reclassifyVerifiedFunction,
  buildSearchTerms,
  categoryForUrl,
  conflictingTopCandidates,
  decorateLinksForVerification,
  extractHtml,
  extractXmlLinks,
  eventNeedsLunaReview,
  FixtureStore,
  isKnownOrderProviderHost,
  proposalUrlForLink,
  seedWebsiteUrls,
  staticFetchEvidence,
} from "./discover-links.mjs";

test("GPT-5.6 Luna can validate visible SpotHopper events when structured dates are absent", () => {
  const link = {
    category: "events",
    input_url: "https://oldesilversnj.com/-events",
    final_url: "https://oldesilversnj.com/manalapan-township-manalapan-new-jersey-olde-silver-tavern-events",
    source_type: "website",
    status: "verified",
    liveness: "live",
    relevance: "match",
    destination_state: "functional",
    page_evidence: {
      h1: ["Events"],
      h2: ["DJ Trivia Night", "Pasta night"],
      text_sample: "Events DJ Trivia Night Tuesday August 4th Every Tuesday 7PM to 9PM Pasta night Sunday August 9th Every Sunday 04:00 PM - 10:00 PM",
      event_dates: [],
    },
    event_timing: {
      has_upcoming_event: false,
      upcoming_event_dates: [],
      inspected_event_dates: [],
      evidence: ["upcoming_event_evidence=false"],
    },
  };
  const location = {
    location_id: "m7q7a7sdtk963ndt6kyssf1z",
    location_name: "Olde Silver Tavern (Manalapan Township)",
    website_url: "https://oldesilversnj.com/",
  };
  assert.equal(eventNeedsLunaReview(link, location), true);
  const packet = buildEventLunaPacket(link, location, "2026-08-03T22:00:00.000Z");
  const reviewed = applyLunaEventReview(link, {
    schema_version: 1,
    model: "gpt-5.6-luna",
    candidate_url: packet.candidate.final_url,
    evidence_hash: packet.evidence_hash,
    verdict: "upcoming_events_verified",
    confidence: 0.99,
    reason: "The official event card shows a future Tuesday date and recurring weekly schedule.",
    events: [{
      title: "DJ Trivia Night",
      date_text: "Tuesday August 4th",
      time_text: "7PM to 9PM",
      recurrence_text: "Every Tuesday",
      normalized_start_date: "2026-08-04",
    }],
  }, packet);
  assert.equal(reviewed.event_timing.source, "gpt-5.6-luna");
  assert.equal(reviewed.event_timing.has_upcoming_event, true);
  assert.deepEqual(reviewed.event_timing.upcoming_event_dates, ["2026-08-04"]);
  assert.equal(reviewed.event_timing.luna_review.status, "accepted");
});

test("Luna event review fails closed on low confidence or ungrounded dates", () => {
  const link = {
    category: "events",
    input_url: "https://example.com/events",
    final_url: "https://example.com/events",
    source_type: "website",
    status: "verified",
    liveness: "live",
    relevance: "match",
    destination_state: "functional",
    page_evidence: { h1: ["Events"], h2: [], text_sample: "Events coming soon", event_dates: [] },
    event_timing: { has_upcoming_event: false, upcoming_event_dates: [], evidence: [] },
  };
  const packet = buildEventLunaPacket(link, { website_url: "https://example.com" }, "2026-08-03T22:00:00.000Z");
  assert.throws(() => applyLunaEventReview(link, {
    schema_version: 1,
    model: "gpt-5.6-luna",
    candidate_url: packet.candidate.final_url,
    evidence_hash: packet.evidence_hash,
    verdict: "upcoming_events_verified",
    confidence: 0.6,
    reason: "Maybe upcoming.",
    events: [{
      title: "Imagined Event",
      date_text: "August 20th",
      time_text: "",
      recurrence_text: "",
      normalized_start_date: "2026-08-20",
    }],
  }, packet), /invalid_luna_event_review/);
});

assert.equal(reclassifyVerifiedFunction({
  category: "menu",
  status: "verified",
  destination_state: "functional",
  destination_state_evidence: ["ordering_action_evidence=true", "ordering_action_signal=ordering_action_control"],
}).category, "order");
assert.equal(reclassifyVerifiedFunction({
  category: "menu",
  status: "verified",
  destination_state: "functional",
  destination_state_evidence: ["ordering_action_evidence=true", "ordering_action_signal=ordering_specific_route"],
}).category, "menu");
assert.deepEqual(reclassifyVerifiedFunction({
  category: "events",
  input_url: "https://example.com/book",
  final_url: "https://www.opentable.com/r/example",
  status: "verified",
  destination_state: "functional",
}), {
  category: "reservations",
  original_category: "events",
  input_url: "https://example.com/book",
  final_url: "https://www.opentable.com/r/example",
  status: "verified",
  destination_state: "functional",
  classification_evidence: ["reclassified_by_verified_function=destination_url_to_reservations"],
});

test("Heartland HRPOS menu paths are classified as online ordering", () => {
  assert.equal(categoryForUrl("https://micks.hrpos.heartland.us/menu", "Main Menu"), "order");
  assert.equal(isKnownOrderProviderHost("micks.hrpos.heartland.us"), true);
});

test("links extracted from the configured official website carry official cross-link evidence", () => {
  const [officialLink, searchLink] = decorateLinksForVerification(
    { website_url: "https://restaurant.example/" },
    [
      {
        category: "order",
        input_url: "https://restaurant.hrpos.heartland.us/menu",
        source_type: "website",
        source_url: "https://www.restaurant.example/order",
      },
      {
        category: "order",
        input_url: "https://restaurant.hrpos.heartland.us/menu",
        source_type: "search",
        source_url: "google-search:Restaurant order online",
      },
    ],
  );
  assert.equal(officialLink.officialWebsiteLinksCandidate, true);
  assert.equal(searchLink.officialWebsiteLinksCandidate, false);
});

test("one HTML extraction captures nav, footer, JSON-LD, and obvious categories", () => {
  const evidence = extractHtml(`
    <html><head><title>Example Restaurant</title>
      <script type="application/ld+json">{"@type":"Restaurant","sameAs":["https://www.instagram.com/example"],"potentialAction":{"target":"https://order.example.com/store"}}</script>
    </head><body>
      <nav><a href="/menu">Menu</a></nav>
      <footer><a href="/careers">Jobs</a></footer>
    </body></html>
  `, "https://example.com/");
  assert(evidence.labeled_links.some((link) => link.href === "https://example.com/menu" && link.source === "nav"));
  assert(evidence.labeled_links.some((link) => link.href === "https://example.com/careers" && link.source === "footer"));
  assert(evidence.labeled_links.some((link) => link.href === "https://www.instagram.com/example" && link.source === "json-ld:sameAs"));
  assert(evidence.labeled_links.some((link) => link.href === "https://order.example.com/store" && link.source === "json-ld:target"));
});

test("sitemap extraction is deterministic and bounded", () => {
  const evidence = extractXmlLinks("<urlset><url><loc>https://example.com/menu</loc></url><url><loc>https://example.com/jobs</loc></url></urlset>", "https://example.com/sitemap.xml");
  assert.deepEqual(evidence.links, ["https://example.com/menu", "https://example.com/jobs"]);
});

test("external search terms cover only requested auto-write categories", () => {
  const terms = buildSearchTerms(["order", "menu", "events", "careers_jobs", "catering"], {
    location_name: "Example",
    account_name: "Example",
    website_url: "https://example.com",
  });
  const text = terms.map((term) => term.term).join(" ");
  assert.match(text, /order online/);
  assert.match(text, /careers jobs/);
  assert.doesNotMatch(text, /gift cards|loyalty rewards|App Store|Google Play/);
});

test("known-path seeding excludes review-only reservations unless the site exposes them", () => {
  const seeds = seedWebsiteUrls({ website_url: "https://example.com", account_name: "Example", location_name: "Example" }, ["events", "reservations"]);
  assert(seeds.some((url) => url.includes("/events")));
  assert(!seeds.some((url) => /\/(?:reservations|reserve|book)\/?$/.test(new URL(url).pathname)));
});

test("equal deterministic scores with distinct verified URLs emit an explicit tie", () => {
  const candidate = (url) => ({
    input_url: url,
    final_url: url,
    status: "verified",
    source_type: "website",
    source_evidence: [],
    validity_evidence: [],
    location_match_evidence: [],
  });
  const tie = conflictingTopCandidates([candidate("https://example.com/menu-a"), candidate("https://example.com/menu-b")], "menu", {});
  assert.equal(tie.reason, "equal_deterministic_score_with_distinct_verified_destinations");
});

test("same-domain verified menu ties choose the location-specific page without a hold", () => {
  const candidate = (url) => ({
    category: "menu",
    input_url: url,
    final_url: url,
    status: "verified",
    relevance: "match",
    source_type: "website",
    source_evidence: ["official_website_links_to_candidate=true"],
    validity_evidence: ["http_status=200"],
    location_match_evidence: ["location_name_match=true"],
  });
  const generic = candidate("https://southlandscafe.com/menu");
  const locationSpecific = candidate("https://southlandscafe.com/menu/southlands-cafe-aurora");
  const location = { location_name: "Southlands Cafe (Aurora)", shipping_city: "Aurora" };
  assert.equal(conflictingTopCandidates([generic, locationSpecific], "menu", location), null);
  assert.equal(bestByStatus([generic, locationSpecific], "menu", location), locationSpecific);
});

test("menu root beats a product leaf discovered from script data", () => {
  const candidate = (url, evidence) => ({
    category: "menu",
    input_url: url,
    final_url: url,
    status: "verified",
    relevance: "match",
    source_type: "website",
    source_url: "https://potbelly.com/",
    source_evidence: evidence,
    validity_evidence: ["http_status=200"],
    location_match_evidence: [],
  });
  const root = candidate("https://potbelly.com/menu", ["link_source=anchor"]);
  const product = candidate("https://potbelly.com/menu/cookies-shake", ["link_source=script-url"]);
  assert.equal(bestByStatus([product, root], "menu", {}), root);
});

test("ordering FAQ is excluded in favor of the functional order route", () => {
  const candidate = (url) => ({
    category: "order",
    input_url: url,
    final_url: url,
    status: "verified",
    relevance: "match",
    source_type: "website",
    source_url: "https://potbelly.com/",
    source_evidence: ["official_site_order_candidate=true"],
    validity_evidence: ["http_status=200"],
    location_match_evidence: [],
  });
  const faq = candidate("https://potbelly.com/faqs-online-ordering");
  const order = candidate("https://potbelly.com/order");
  assert.equal(bestByStatus([faq, order], "order", {}), order);
});

test("first-party order and menu proposals preserve the human-facing route", () => {
  assert.equal(proposalUrlForLink("order", {
    input_url: "https://potbelly.com/order",
    final_url: "https://potbelly.com/menu",
    source_type: "website",
  }), "https://potbelly.com/order");
  assert.equal(proposalUrlForLink("menu", {
    input_url: "https://potbelly.com/menu",
    final_url: "https://potbelly.com/menu/combos-deals",
    source_type: "website",
  }), "https://potbelly.com/menu");
});

test("static evidence includes a stable content hash", async () => {
  const page = await staticFetchEvidence("data:text/html,<title>Example</title><a href='https://example.com/menu'>Menu</a>");
  assert.match(page.content_hash, /^[a-f0-9]{64}$/);
});

test("content cache never shares context-sensitive evidence across distinct URLs", () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-link-cache-"));
  const store = new FixtureStore(null, "loc", { cacheDir, cacheTtlDays: 5, cacheEnabled: true });
  const sharedHash = "a".repeat(64);
  store.writeCache("website", "https://example.com/a/", {
    final_url: "https://example.com/a/",
    http_status: 200,
    content_hash: sharedHash,
    links: ["https://example.com/a/menu"],
  });
  store.writeCache("website", "https://example.com/b/", {
    final_url: "https://example.com/b/",
    http_status: 200,
    content_hash: sharedHash,
    links: ["https://example.com/b/menu"],
  });
  assert.deepEqual(store.readCache("website", "https://example.com/a/").links, ["https://example.com/a/menu"]);
  assert.deepEqual(store.readCache("website", "https://example.com/b/").links, ["https://example.com/b/menu"]);
});

test("extension DOM evidence can be cached without inventing an HTTP status", () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-dom-cache-"));
  try {
    const store = new FixtureStore(null, "loc", { cacheDir, cacheTtlDays: 5, cacheEnabled: true });
    const url = "https://example.com/menu";
    store.writeCache("candidate", url, { final_url: url, http_status: null, ok: true, title: "Example Restaurant Menu", h1: ["Example Restaurant"], text: "Our restaurant menu with pizza, salads and pasta.", fetch_method: "codex_extension" });
    assert.equal(store.readCache("candidate", url).http_status, null);
    const htmlHash = "a".repeat(64);
    for (const text of ["Old restaurant event schedule", "New restaurant event schedule"]) {
      store.writeCache("candidate", url, { final_url: url, http_status: null, ok: true, title: "Example Restaurant Events", text, content_hash: htmlHash });
      assert.equal(store.readCache("candidate", url).text, text, "new rendered content must not reuse stale evidence with the same HTML hash");
    }
    for (const [suffix, evidence] of Object.entries({
      challenge: { title: "Just a moment...", text: "Verify you are human. Checking your browser before proceeding." },
      missing: { title: "Page not found", text: "Page not found" },
      thin: { title: "", text: "", ok: true },
    })) {
      const input = `${url}/${suffix}`;
      store.writeCache("candidate", input, { final_url: input, http_status: null, ...evidence });
      assert.equal(store.readCache("candidate", input), null);
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
