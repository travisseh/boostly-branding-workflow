import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOM_LINK_PRESENTATION,
  appListingMatchesBusiness,
  buildFulfillmentPlan,
  canonicalLinkUrl,
  parseFulfillmentPlan,
  validateFulfillmentPlan,
} from "./fulfillment-plan.ts";
import { matchLocationExactly, selectBrandingScope } from "./location-match.ts";

const location = {
  location_id: "loc_1",
  location_name: "Piloni's Italian Restaurant (Terre Haute)",
  location_status: "enabled",
  account_id: "acct_1",
  account_name: "Piloni's",
  address: "1733 Lafayette Ave, Terre Haute, IN 47804, USA",
  is_general: false,
};

test("canonical link URLs remove content queries but preserve functional provider identity", () => {
  assert.equal(canonicalLinkUrl("https://tmt.spotapps.co/job-listings?spot_id=96533&utm_source=site", "careers_jobs"), "https://tmt.spotapps.co/job-listings?spot_id=96533");
  assert.equal(canonicalLinkUrl("https://example.com/menu?location=42&ref=restaurant", "menu"), "https://example.com/menu?location=42&ref=restaurant");
  assert.equal(
    canonicalLinkUrl("https://example.com/menu?utm_source=google&location=1#dinner"),
    "https://example.com/menu#dinner",
  );
  assert.equal(
    canonicalLinkUrl(
      "https://ordering.example.com/start?merchant_id=42&utm_campaign=summer",
      "ordering",
    ),
    "https://ordering.example.com/start?merchant_id=42",
  );
  assert.equal(
    canonicalLinkUrl(
      "https://www.opentable.com/booking/restref/availability?restRef=1213069&otSource=Restaurant%20website&utm_source=site",
      "reservations",
    ),
    "https://www.opentable.com/booking/restref/availability?restRef=1213069&otSource=Restaurant+website",
  );
});

test("review-only and unmatched-app URLs retain functional IDs without becoming writable", () => {
  const base = minimalPlan();
  // apps with a store listing that does not name the business hold; loyalty and generic app pages are review-only
  const cases = [
    ["android_app", "https://play.google.com/store/apps/details?id=com.foxspizza.foxspizza"],
    ["ios_app", "https://apps.apple.com/app?id=123"],
    ["app_downloads", "https://example.com/app?location=42"],
    ["loyalty_rewards", "https://example.com/rewards?location=42"],
  ];
  const plan = buildFulfillmentPlan({
    request: base.request,
    location: base.location,
    write_policy: "links_only",
    discovery_report: {
      category_results: cases.map(([category, url]) => result(category, "found_verified", `${url}&utm_source=site`)),
      proposed_location_updates: [],
      proposed_touchpoint_events: cases.map(([category, url]) => touchpointProposal(category, `${url}&utm_source=site`, verified())),
      manual_review_items: [],
    },
  });
  for (const [category, url] of cases) {
    assert.equal(canonicalLinkUrl(`${url}&utm_source=site`, category), url);
    const link = plan.links.find(link => link.category === category)!;
    assert.equal(link.url, url);
    assert.equal(link.action, "hold");
    assert.ok(!plan.writes.some(write => write.category === category));
  }
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("cached rejected social with verified identity becomes a hold, never a write", () => {
  const base = minimalPlan();
  const url = "https://www.facebook.com/profile.php?id=61573226536882";
  for (const status of ["verified", "rejected"]) {
    const plan = buildFulfillmentPlan({
      request: base.request,
      location: base.location,
      write_policy: "links_only",
      discovery_report: {
        category_results: [{ category: "facebook", category_status: "found_rejected", selected_link: {
          input_url: url, status, liveness: "live", relevance: "match", source_type: "search",
        } }],
        proposed_location_updates: [], proposed_touchpoint_events: [], manual_review_items: [],
      },
    });
    const link = plan.links.find(link => link.category === "facebook")!;
    assert.equal(link.action, status === "verified" ? "hold" : "not_found");
    assert.equal(link.url, url);
    assert.ok(!plan.writes.some(write => write.category === "facebook"));
    assert.deepEqual(validateFulfillmentPlan(plan), []);
  }
});

test("exact location matching normalizes punctuation/address suffixes and excludes General", () => {
  const match = matchLocationExactly({
    account_name: "PILONI'S",
    location_name: "Piloni’s Italian Restaurant (Terre Haute)",
    street_address: "1733 Lafayette Avenue",
    city: "Terre Haute",
    state: "IN",
    postal_code: "47804",
  }, [
    { ...location, location_id: "general", is_general: true },
    location,
  ]);
  assert.equal(match.status, "matched");
  if (match.status === "matched") assert.equal(match.location.location_id, "loc_1");
});

test("V2 city-suffix disambiguator matches when the request omits it and the address is exact (El Guapo)", () => {
  const elGuapo = {
    ...location,
    location_id: "loc_eg",
    account_name: "El Guapo",
    location_name: "El Guapo (Catonsville)",
    address: "729 Frederick Rd, Catonsville, MD 21228",
  };
  const match = matchLocationExactly({
    account_name: "El Guapo",
    location_name: "El Guapo",
    street_address: "729 Frederick Rd",
    city: "Catonsville",
    state: "MD",
    postal_code: "21228",
  }, [elGuapo]);
  assert.equal(match.status, "matched");
  if (match.status === "matched") assert.equal(match.match_basis, "exact_address");
  // a parenthetical that is NOT the request city misses the exact path but
  // still resolves through the single-location fallback (account name + only
  // location on the account); it carries the flagged basis, not exact_address
  const wrongCity = matchLocationExactly({
    account_name: "El Guapo",
    location_name: "El Guapo",
    street_address: "729 Frederick Rd",
    city: "Catonsville",
    state: "MD",
    postal_code: "21228",
  }, [{ ...elGuapo, location_name: "El Guapo (Towson)" }]);
  assert.equal(wrongCity.status, "matched");
  if (wrongCity.status === "matched") assert.equal(wrongCity.match_basis, "single_location_shipping_address");
  // on a multi-location account the wrong-city parenthetical still requires review
  const wrongCityMulti = matchLocationExactly({
    account_name: "El Guapo",
    location_name: "El Guapo",
    street_address: "729 Frederick Rd",
    city: "Catonsville",
    state: "MD",
    postal_code: "21228",
  }, [
    { ...elGuapo, location_name: "El Guapo (Towson)" },
    { ...elGuapo, location_id: "loc_eg2", location_name: "El Guapo (Baltimore)", address: "1 Light St, Baltimore, MD 21202" },
  ]);
  assert.equal(wrongCityMulti.status, "needs_model_review");
});

test("single-location account with exact name match treats a mismatched request address as a ship-to (Um.ma)", () => {
  const umma = {
    ...location,
    location_id: "loc_umma",
    account_id: "acct_umma",
    account_name: "um.ma",
    location_name: "um.ma (San Francisco)",
    address: "1220 9th Ave, San Francisco, CA 94122, USA",
  };
  // Request carries the owner's residential ship-to, not the restaurant address.
  const match = matchLocationExactly({
    account_name: "Um.ma",
    location_name: "Um.ma",
    street_address: "328 Anita Dr",
    city: "Millbrae",
    state: "California",
    postal_code: "94030",
  }, [umma]);
  assert.equal(match.status, "matched");
  if (match.status === "matched") {
    assert.equal(match.location.location_id, "loc_umma");
    assert.equal(match.match_basis, "single_location_shipping_address");
  }
  // A multi-location account with a mismatched address still requires review.
  const multi = matchLocationExactly({
    account_name: "Um.ma",
    location_name: "Um.ma",
    street_address: "328 Anita Dr",
    city: "Millbrae",
    state: "California",
    postal_code: "94030",
  }, [umma, { ...umma, location_id: "loc_umma2", location_name: "um.ma (Oakland)", address: "1 Broadway, Oakland, CA 94607" }]);
  assert.equal(multi.status, "needs_model_review");
});

test("name mismatch or duplicate exact identity routes to model review without guessing", () => {
  const request = {
    account_name: "Piloni's",
    location_name: "Piloni's Italian Restaurant (Terre Haute)",
    street_address: "1733 Lafayette Ave",
    city: "Terre Haute",
    state: "IN",
    postal_code: "47804",
  };
  // Address mismatch AND location-name mismatch: identity is not unambiguous.
  assert.equal(
    matchLocationExactly(request, [{ ...location, location_name: "Piloni's Downtown", address: "999 Other Rd" }]).status,
    "needs_model_review",
  );
  const duplicate = matchLocationExactly(request, [location, { ...location, location_id: "loc_2" }]);
  assert.equal(duplicate.status, "needs_model_review");
  if (duplicate.status === "needs_model_review") assert.equal(duplicate.reason, "ambiguous_exact_match");
});

test("scope ignores General and uses account only for one eligible customer location", () => {
  assert.equal(selectBrandingScope(location, [location, { ...location, location_id: "general", is_general: true }]), "account");
  assert.equal(selectBrandingScope(location, [location, { ...location, location_id: "loc_2", location_name: "Brazil" }]), "location");
  assert.throws(() => selectBrandingScope({ ...location, is_general: true }, [location]), /General/);
});

test("plan writes only deterministic high-confidence links and holds challenges, events, and review-only categories", () => {
  const report = {
    category_results: [
      result("instagram", "found_verified", "https://instagram.com/pilonis"),
      result("ordering", "found_verified", "https://order.example/pilonis"),
      result("events", "found_verified", "https://example.com/events"),
      result("careers_jobs", "found_verified", "https://example.com/jobs"),
      result("gift_cards", "found_verified", "https://example.com/gift"),
      result("loyalty_rewards", "found_verified", "https://example.com/rewards"),
    ],
    proposed_location_updates: [
      locationProposal("instagram", "branding.instagram_url", "https://instagram.com/pilonis", verified()),
      locationProposal("ordering", "locations.ordering_url", "https://order.example/pilonis", verified({
        validity_evidence: ["http_status=403", "security_or_bot_challenge_detected=true"],
      })),
    ],
    proposed_touchpoint_events: [
      touchpointProposal("events", "https://example.com/events", verified({ event_timing: { has_upcoming_event: false, upcoming_event_dates: [] } }), { custom_destination_specific: true }),
      touchpointProposal("careers_jobs", "https://example.com/jobs", verified()),
      touchpointProposal("gift_cards", "https://example.com/gift", verified()),
      touchpointProposal("loyalty_rewards", "https://example.com/rewards", verified()),
    ],
    manual_review_items: [],
  };
  const plan = buildFulfillmentPlan({
    request: {
      request_key: "pilonis|terre-haute|1733-lafayette",
      canonical_thread_ts: "1783715705.000100",
      badge_quantity: 15,
      badge_quantity_status: "valid",
    },
    location: {
      location_id: "loc_1",
      location_name: location.location_name,
      account_id: "acct_1",
      account_name: "Piloni's",
      website_url: "https://pilonis.com",
      is_general: false,
      branding_scope: "location",
    },
    discovery_report: report,
    branding: { status: "hold", confidence: "medium", flags: ["neutral_mark_composition"] },
  });

  assert.deepEqual(plan.links.filter((link) => link.action === "write").map((link) => link.category), ["instagram", "careers_jobs", "gift_cards"]);
  assert.equal(plan.links.find((link) => link.category === "ordering")?.reason, "challenge_or_timeout_requires_review");
  assert.equal(plan.links.find((link) => link.category === "events")?.reason, "events_missing_upcoming_structured_date");
  // gift cards are a standing write (Link write gate, 2026-10-19); loyalty stays review-only
  assert.deepEqual(plan.links.find((link) => link.category === "gift_cards")?.presentation, CUSTOM_LINK_PRESENTATION.gift_cards);
  assert.equal(plan.links.find((link) => link.category === "loyalty_rewards")?.reason, "category_requires_human_review");
  assert.deepEqual(plan.links.find((link) => link.category === "careers_jobs")?.presentation, {
    title: "Careers",
    display_title: "Join Our Team",
    description: "Grow with our team",
    button_text: "Apply Now",
  });
  assert.equal(plan.writes.at(-1)?.kind, "linktree_defaults");
  assert.deepEqual(plan.writes.map((write) => write.sequence), [1, 2, 3, 4]);
  assert.equal(plan.writes.some((write) => String(write.kind) === "badges"), false);
  assert.deepEqual(plan.badges, {
    action: "none",
    quantity: 15,
    reason: "owned_by_fulfillment_request",
  });
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("existing verified ordering URL still reconciles the customer-visible Order Online event", () => {
  const report = {
    category_results: [
      {
        category: "ordering",
        category_status: "existing_verified",
        existing_link: {
          input_url: "https://order.example.com/location",
        },
      },
    ],
    proposed_location_updates: [],
    proposed_touchpoint_events: [],
    manual_review_items: [],
  };
  const plan = buildFulfillmentPlan({
    request: {
      request_key: "restaurant|location|123-main",
      canonical_thread_ts: "1785270883.000100",
      badge_quantity: null,
      badge_quantity_status: "missing",
    },
    location: {
      location_id: "loc_1",
      location_name: "Restaurant",
      account_id: "acct_1",
      account_name: "Restaurant",
      website_url: "https://example.com",
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: report,
    branding: { status: "hold", flags: [] },
  });

  assert.deepEqual(plan.links, [{
    category: "ordering",
    url: "https://order.example.com/location",
    action: "preserve",
    reason: "existing_verified",
    target: "none",
  }]);
  assert.deepEqual(plan.writes, [
    {
      sequence: 1,
      kind: "touchpoint",
      scope: "location",
      category: "ordering",
      url: "https://order.example.com/location",
      payload: {
        title: "Order Online",
        display_title: "Order Online",
        description: "Order your favorites",
        button_text: "Order Now",
      },
      idempotency_key: "1785270883.000100|restaurant|location|123-main|1|touchpoint|ordering",
      fill_only: true,
      requires_readback: true,
    },
    {
      sequence: 2,
      kind: "linktree_defaults",
      scope: "location",
      payload: { verified_socials_present: false },
      idempotency_key: "1785270883.000100|restaurant|location|123-main|2|linktree_defaults|",
      fill_only: true,
      requires_readback: true,
    },
  ]);
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("location ordering and order touchpoint proposals produce one Order Online event", () => {
  const orderingUrl = "https://order.example.com/location";
  const report = {
    category_results: [
      result("ordering", "found_verified", orderingUrl),
      result("order", "found_verified", orderingUrl),
    ],
    proposed_location_updates: [
      locationProposal("ordering", "locations.ordering_url", orderingUrl, verified()),
    ],
    proposed_touchpoint_events: [
      touchpointProposal("order", orderingUrl, verified()),
    ],
    manual_review_items: [],
  };
  const plan = buildFulfillmentPlan({
    request: {
      request_key: "restaurant|location|123-main",
      canonical_thread_ts: "1785270883.000100",
      badge_quantity: null,
      badge_quantity_status: "missing",
    },
    location: {
      location_id: "loc_1",
      location_name: "Restaurant",
      account_id: "acct_1",
      account_name: "Restaurant",
      website_url: "https://example.com",
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: report,
    branding: { status: "hold", flags: [] },
  });

  assert.equal(plan.writes.filter((write) => write.kind === "location" && write.category === "ordering").length, 1);
  assert.equal(plan.writes.filter((write) => write.kind === "touchpoint" && write.category === "ordering").length, 1);
  assert.equal(plan.writes.filter((write) => write.kind === "touchpoint" && write.category === "order").length, 0);
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("verified existing socials still enforce link-tree defaults", () => {
  const plan = buildFulfillmentPlan({
    request: {
      request_key: "restaurant|location|123-main",
      canonical_thread_ts: "1785270883.000101",
      badge_quantity: null,
      badge_quantity_status: "missing",
    },
    location: {
      location_id: "loc_1",
      location_name: "Restaurant",
      account_id: "acct_1",
      account_name: "Restaurant",
      website_url: "https://example.com",
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: {
      category_results: [{
        category: "instagram",
        category_status: "existing_verified",
        existing_link: { input_url: "https://instagram.com/restaurant" },
      }],
      proposed_location_updates: [],
      proposed_touchpoint_events: [],
      manual_review_items: [],
    },
    branding: { status: "hold", flags: [] },
  });

  assert.deepEqual(plan.writes.map((write) => write.kind), ["linktree_defaults"]);
  assert.equal(plan.writes[0].payload?.verified_socials_present, true);
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("model routes are limited to the intended exception models", () => {
  const plan = minimalPlan();
  plan.model_exceptions = [{
    kind: "palette_or_composition",
    model: "luna",
    reason: "wrong model on purpose",
    evidence_refs: [],
  }];
  assert(validateFulfillmentPlan(plan).includes("invalid_model_route_palette_or_composition_luna"));
});

test("branding apply requires final shipped-asset QA and blocks low-contrast logos", () => {
  const base = minimalPlan();
  base.branding = {
    status: "apply",
    flags: [],
    final_logo_path: "/tmp/logo.png",
    final_asset_qa: {
      ship_gate_pass: true,
      border_dust_pass: true,
      soft_fringe_pass: true,
      source_preservation_pass: true,
      interior_low_contrast_share: 0.9138,
      upload_bytes: 68_000,
    },
    fable_output: {
      logo_choice: "/tmp/source-logo.png",
      palette: {
        web_primary_color: "#418200",
        web_secondary_color: "#68B92B",
        web_text_color: "#FFFFFF",
        print_primary_color: "#418200",
        print_secondary_color: "#68B92B",
        print_text_color: "#FFFFFF",
        print_text_secondary_color: "#E2FBD5",
      },
      composition: "Centered wordmark",
      confidence: "high",
      flags: [],
      rationale: "Official source",
    },
  };
  assert(validateFulfillmentPlan(base).includes("branding_interior_contrast_failed"));
  base.branding.final_asset_qa.interior_low_contrast_share = 0;
  assert.deepEqual(validateFulfillmentPlan(base), []);
});

test("existing branding cannot be marked reusable without effective proof and logo-surface QA", () => {
  const plan = minimalPlan();
  plan.branding = { status: "reuse", flags: ["existing_branding_preserved"] };
  assert(validateFulfillmentPlan(plan).includes("branding_reuse_missing_effective_qa"));

  plan.branding.effective_branding_qa = {
    proof_path: "/tmp/effective-proof.png",
    proof_validation_pass: true,
    logo_surface_pass: false,
    logo_surface_verdict: "opaque_light_panel_on_colored_surface",
  };
  assert(validateFulfillmentPlan(plan).includes("branding_reuse_logo_surface_failed"));

  plan.branding.effective_branding_qa.logo_surface_pass = true;
  assert(validateFulfillmentPlan(plan).includes("branding_reuse_logo_surface_failed"));

  plan.branding.effective_branding_qa.logo_surface_verdict = "ok";
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("website-backed branding cannot apply without screenshot and computed-style corroboration", () => {
  const plan = minimalPlan();
  plan.location.website_url = "https://example.com";
  plan.branding = {
    status: "apply",
    flags: [],
    fable_output: {
      logo_choice: null,
      palette: {
        web_primary_color: "#C05700",
        web_secondary_color: "#202233",
        web_text_color: "#FFFFFF",
      },
      composition: "Use the visible website surfaces",
      confidence: "high",
      flags: [],
      rationale: "Desktop and mobile screenshots agree with computed styles.",
    },
  };
  assert(validateFulfillmentPlan(plan).includes("branding_missing_website_visual_qa"));

  plan.branding.website_visual_qa = {
    status: "captured",
    desktop_screenshot: "/tmp/website-desktop.png",
    mobile_screenshot: "/tmp/website-mobile.png",
    computed_styles_manifest: "/tmp/computed-styles.json",
    palette_correspondence_pass: false,
  };
  assert(validateFulfillmentPlan(plan).includes("branding_palette_not_visually_corroborated"));

  plan.branding.website_visual_qa.palette_correspondence_pass = true;
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("an unresolved deterministic candidate tie is held and cannot reach the write plan", () => {
  const plan = buildFulfillmentPlan({
    request: { request_key: "key", canonical_thread_ts: "1.0", badge_quantity: null, badge_quantity_status: "missing" },
    location: {
      location_id: "loc_1",
      location_name: "Location",
      account_id: "acct_1",
      account_name: "Account",
      website_url: "https://example.com",
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: {
      category_results: [result("menu", "found_verified", "https://example.com/menu-a")],
      proposed_location_updates: [],
      proposed_touchpoint_events: [touchpointProposal("menu", "https://example.com/menu-a", verified())],
      manual_review_items: [],
    },
    model_exceptions: [{
      kind: "conflicting_candidate_tie",
      model: "luna",
      category: "menu",
      reason: "equal deterministic scores",
      evidence_refs: ["https://example.com/menu-a", "https://example.com/menu-b"],
    }],
  });
  assert.equal(plan.links[0].action, "hold");
  assert.equal(plan.links[0].reason, "conflicting_candidate_tie_requires_luna");
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("high-confidence destination-specific reservations are writable with compact presentation", () => {
  const reservationUrl = "https://www.opentable.com/booking/restref/availability?restRef=1213069&utm_source=website";
  const plan = buildFulfillmentPlan({
    request: { request_key: "fusion|totowa", canonical_thread_ts: "2.0", badge_quantity: null, badge_quantity_status: "missing" },
    location: {
      location_id: "loc_fusion",
      location_name: "Fusion 27",
      account_id: "acct_fusion",
      account_name: "Fusion 27",
      website_url: "https://fusion27.com",
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: {
      category_results: [result("reservations", "found_verified", reservationUrl)],
      proposed_location_updates: [],
      proposed_touchpoint_events: [touchpointProposal("reservations", reservationUrl, verified(), { custom_destination_specific: true })],
      manual_review_items: [],
    },
  });
  const decision = plan.links[0];
  assert.equal(decision.action, "write");
  assert.equal(decision.url, "https://www.opentable.com/booking/restref/availability?restRef=1213069");
  assert.deepEqual(decision.presentation, {
    title: "Reservations",
    display_title: "Reservations",
    description: "Save your table",
    button_text: "Reserve Now",
  });
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("validated GPT-5.6 Luna event timing clears the event write gate", () => {
  const evidenceHash = "a".repeat(64);
  const eventTiming = {
    source: "gpt-5.6-luna",
    has_upcoming_event: true,
    upcoming_event_dates: ["2026-08-04"],
    luna_review: {
      status: "accepted",
      model: "gpt-5.6-luna",
      verdict: "upcoming_events_verified",
      confidence: 0.99,
      evidence_hash: evidenceHash,
      events: [{ normalized_start_date: "2026-08-04" }],
    },
  };
  const plan = buildFulfillmentPlan({
    request: { request_key: "olde-silver|manalapan", canonical_thread_ts: "3.0", badge_quantity: null, badge_quantity_status: "missing" },
    location: {
      location_id: "loc_old_silver",
      location_name: "Olde Silver Tavern (Manalapan Township)",
      account_id: "acct_old_silver",
      account_name: "Olde Silver Tavern",
      website_url: "https://oldesilversnj.com",
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: {
      category_results: [result("events", "found_verified", "https://oldesilversnj.com/-events")],
      proposed_location_updates: [],
      proposed_touchpoint_events: [touchpointProposal(
        "events",
        "https://oldesilversnj.com/-events",
        verified({ event_timing: eventTiming }),
        { custom_destination_specific: true },
      )],
      manual_review_items: [],
    },
    model_exceptions: [{
      kind: "unstructured_event_timing",
      model: "luna",
      reason: "Visible event card verified",
      category: "events",
      evidence_refs: ["https://oldesilversnj.com/-events", evidenceHash],
    }],
  });
  assert.equal(plan.links[0].action, "write");
  assert.equal(plan.links[0].reason, "deterministic_high_confidence_gate_passed");
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

test("runtime parsing rejects incomplete or General-location JSON before execution", () => {
  assert.throws(() => parseFulfillmentPlan({ schema_version: 1 }), /request_must_be_object/);
  const plan = minimalPlan();
  assert.throws(() => parseFulfillmentPlan({ ...plan, location: { ...plan.location, is_general: true } }), /general_location_forbidden/);
});

function minimalPlan() {
  return buildFulfillmentPlan({
    request: { request_key: "key", canonical_thread_ts: "1.0", badge_quantity: null, badge_quantity_status: "missing" },
    location: {
      location_id: "loc_1",
      location_name: "Location",
      account_id: "acct_1",
      account_name: "Account",
      website_url: null,
      is_general: false,
      branding_scope: "account",
    },
    discovery_report: { category_results: [], proposed_location_updates: [], proposed_touchpoint_events: [], manual_review_items: [] },
  });
}

test("first-party app store links write when the listing names the business, hold otherwise (standing default)", () => {
  const base = minimalPlan();
  const report = (iosTitle: string, androidEvidence: string[]) => ({
    category_results: [
      result("ios_app", "found_verified", "https://apps.apple.com/us/app/foxs-pizza-den/id123"),
      result("android_app", "found_verified", "https://play.google.com/store/apps/details?id=com.foxspizza"),
    ],
    proposed_location_updates: [
      locationProposal("ios_app", "branding.apple_app_url", "https://apps.apple.com/us/app/foxs-pizza-den/id123", verified({ source_type: "search", page_evidence: { title: iosTitle } })),
      locationProposal("android_app", "branding.google_app_url", "https://play.google.com/store/apps/details?id=com.foxspizza", verified({ source_type: "search", location_match_evidence: androidEvidence })),
    ],
    proposed_touchpoint_events: [],
    manual_review_items: [],
  });
  const matched = buildFulfillmentPlan({
    request: base.request,
    location: { ...base.location, location_name: "Fox's Pizza Den - Coraopolis", account_name: "Fox's Pizza Den" },
    discovery_report: report("Fox's Pizza Den on the App Store", ["app_store_metadata_names_business"]),
  });
  assert.equal(matched.links.find((link) => link.category === "ios_app")?.action, "write");
  assert.equal(matched.links.find((link) => link.category === "android_app")?.action, "write");
  const branding = matched.writes.find((write) => write.kind === "branding");
  assert.equal(branding?.payload?.apple_app_url, "https://apps.apple.com/us/app/foxs-pizza-den/id123");
  assert.equal(branding?.payload?.google_app_url, "https://play.google.com/store/apps/details?id=com.foxspizza");
  assert.deepEqual(validateFulfillmentPlan(matched), []);

  const mismatched = buildFulfillmentPlan({
    request: base.request,
    location: { ...base.location, location_name: "Fox's Pizza Den - Coraopolis", account_name: "Fox's Pizza Den" },
    discovery_report: report("Pizza Rewards Club on the App Store", ["official_website_links_to_candidate=true"]),
  });
  assert.equal(mismatched.links.find((link) => link.category === "ios_app")?.reason, "app_listing_name_mismatch");
  assert.equal(mismatched.links.find((link) => link.category === "android_app")?.reason, "app_listing_name_mismatch");
  assert.ok(!mismatched.writes.some((write) => write.kind === "branding"));

  assert.equal(appListingMatchesBusiness({ page_evidence: { title: "Mick's Pub & Crabs - Apps on Google Play" } }, ["Mick's Pub & Crabs"]), true);
  assert.equal(appListingMatchesBusiness({ page_evidence: { title: "Olo Ordering" } }, ["Mick's Pub & Crabs"]), false);
});

test("visible upcoming events on the page clear the events write gate (verify-core visible_text timing)", () => {
  const base = minimalPlan();
  const plan = buildFulfillmentPlan({
    request: base.request,
    location: base.location,
    discovery_report: {
      category_results: [result("events", "found_verified", "https://example.com/events")],
      proposed_location_updates: [],
      proposed_touchpoint_events: [touchpointProposal(
        "events",
        "https://example.com/events",
        verified({ event_timing: { has_upcoming_event: true, upcoming_event_dates: ["2099-11-02"], source: "visible_text" } }),
        { custom_destination_specific: true },
      )],
      manual_review_items: [],
    },
  });
  assert.equal(plan.links.find((link) => link.category === "events")?.action, "write");
  assert.ok(plan.writes.some((write) => write.kind === "touchpoint" && write.category === "events"));
  assert.deepEqual(validateFulfillmentPlan(plan), []);
});

function result(category: string, categoryStatus: string, url: string) {
  return { category, category_status: categoryStatus, selected_link: { input_url: url } };
}

function verified(overrides = {}) {
  return {
    status: "verified",
    liveness: "live",
    relevance: "match",
    source_type: "website",
    validity_evidence: ["http_status=200"],
    location_match_evidence: ["official_website_links_to_candidate=true"],
    ...overrides,
  };
}

function locationProposal(category: string, fieldName: string, url: string, verification: unknown) {
  return { category, field_name: fieldName, proposed_value: url, verification, write_gate: {} };
}

function touchpointProposal(category: string, url: string, verification: unknown, writeGate = {}) {
  return { touchpoint_category: category, url, verification, write_gate: writeGate };
}
