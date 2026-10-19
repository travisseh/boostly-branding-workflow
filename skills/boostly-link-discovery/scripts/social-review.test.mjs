import assert from "node:assert/strict";
import test from "node:test";
import { buildProposals, fulfillmentLocationContext, manualReviewReason, resolveCategories } from "./discover-links.mjs";

test("fulfillment identity uses the physical address, not a different shipping city", () => {
  const context = fulfillmentLocationContext({
    location_id: "restaurant", address: "19 W Central St, Chippewa Falls, WI 54729, USA",
    shipping_city: "Elk Mound", shipping_state: "WI", shipping_zip: "54739",
    shipping_address_line1: "300 Moundsview Ct.", facebook_url: "https://facebook.com/example",
  });
  assert.equal(context.shipping_city, "Chippewa Falls");
  assert.equal(context.shipping_zip, "54729");
  assert.equal(context.shipping_address_line1, "");
  assert.equal(context.facebook_url, "https://facebook.com/example");
  assert.throws(() => fulfillmentLocationContext({ shipping_address_line1: "123 Shipping St" }), /database location address/);
});

const profile = {
  category: "facebook",
  input_url: "https://www.facebook.com/profile.php?id=61573226536882",
  final_url: "https://www.facebook.com/people/Thats-a-Wrap-eatsmore/61573226536882/",
  source_type: "search",
  status: "verified",
  liveness: "live",
  relevance: "match",
  location_match_evidence: ["social_destination_identity_signal=true"],
};

function resolve(link) {
  return resolveCategories({
    location: { website_url: "https://thatsawrapeats.com" },
    existingByCategory: new Map(),
    candidatesByCategory: new Map([["facebook", [link]]]),
    hiddenExisting: false,
    touchpoint_events: [],
  });
}

test("verified search social stays visible for review without authorizing a write", () => {
  const results = resolve(profile);
  const facebook = results.find(row => row.category === "facebook");
  assert.equal(facebook.category_status, "needs_manual_review");
  assert.equal(facebook.proposed_action, "noop");
  assert.match(manualReviewReason(facebook), /lacks official-site backing/);
  const proposals = buildProposals(results, []);
  assert.equal(JSON.stringify(proposals).includes("61573226536882"), false);
});

test("rejected, mismatched, and broken search socials are not promoted to review", () => {
  for (const override of [
    { status: "rejected", relevance: "mismatch" },
    { status: "broken", liveness: "dead" },
    { relevance: "mismatch" },
    { liveness: "dead" },
    { validity_evidence: ["http_status=404"] },
  ]) {
    const facebook = resolve({ ...profile, ...override }).find(row => row.category === "facebook");
    assert.notEqual(facebook.category_status, "needs_manual_review");
    assert.equal(facebook.proposed_action, "noop");
  }
});

test("official-site-backed verified socials retain their existing write gate", () => {
  const facebook = resolve({ ...profile, source_type: "website" }).find(row => row.category === "facebook");
  assert.equal(facebook.category_status, "found_verified");
  assert.equal(facebook.proposed_action, "create");
});

test("a website-linked social the verifier rejected (no business signal) is found_rejected, never held", () => {
  const rejected = {
    category: "instagram",
    input_url: "https://www.instagram.com/Chuys/",
    final_url: "https://www.instagram.com/Chuys/",
    source_type: "website",
    status: "rejected",
    liveness: "live",
    relevance: "mismatch",
    rejection_reason: "Social profile shows no business signal (32 followers, under the 100 floor; no display name; no name match, geo match, official domain backlink, external website link, bio, business category). Not a business page for this location.",
    location_match_evidence: ["official_website_links_to_candidate=true", "social_no_business_signal=true", "social_followers=32", "social_reject_reason=identity_mismatch"],
  };
  const results = resolveCategories({
    location: { website_url: "https://cbgnevada.com" },
    existingByCategory: new Map(),
    candidatesByCategory: new Map([["instagram", [rejected]]]),
    hiddenExisting: false,
    touchpoint_events: [],
  });
  const instagram = results.find(row => row.category === "instagram");
  assert.equal(instagram.category_status, "found_rejected");
  assert.equal(instagram.proposed_action, "noop");
  assert.equal(JSON.stringify(buildProposals(results, [])).includes("instagram.com/Chuys"), false);
});

test("an official-site-anchored social verified by anchor (login wall) is found_verified and proposed (Link write gate, 2026-10-19)", () => {
  const anchored = {
    category: "instagram",
    input_url: "https://www.instagram.com/thatsawrapeats/",
    final_url: "https://www.instagram.com/accounts/login/",
    source_type: "website",
    source_url: "https://thatsawrapeats.com/",
    status: "verified",
    status_basis: "verified_by_anchor",
    liveness: "live",
    relevance: "match",
    validity_evidence: ["final_url=https://www.instagram.com/accounts/login/", "http_status=200", "title=Instagram", "liveness_by_anchor=true"],
    location_match_evidence: ["official_website_links_to_candidate=true", "social_login_wall=true", "verified_by_anchor=true"],
  };
  const results = resolveCategories({
    location: { website_url: "https://thatsawrapeats.com" },
    existingByCategory: new Map(),
    candidatesByCategory: new Map([["instagram", [anchored]]]),
    hiddenExisting: false,
    touchpoint_events: [],
  });
  const instagram = results.find(row => row.category === "instagram");
  assert.equal(instagram.category_status, "found_verified");
  assert.equal(instagram.proposed_action, "create");
  const proposals = buildProposals(results, []);
  const proposal = proposals.locationUpdates.find(item => item.field_name === "branding.instagram_url");
  assert.equal(proposal.proposed_value, "https://www.instagram.com/thatsawrapeats/");
  assert.equal(proposal.verification.status_basis, "verified_by_anchor");
});
