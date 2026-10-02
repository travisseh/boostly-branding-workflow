import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveOpenState,
  parseLocationAddress,
  resolveStatus,
  toCanonicalRequest,
  type DatabaseRequestRow,
} from "./list-branding-requests.ts";
import { matchLocationExactly } from "./location-match.ts";
import { preflightFulfillmentBatch } from "./preflight-fulfillment-batch.ts";

function row(overrides: Partial<DatabaseRequestRow> = {}): DatabaseRequestRow {
  return {
    request_id: "req1",
    created_at: "2026-09-14T20:40:44.623",
    updated_at: "2026-09-14T20:41:05.014",
    order_type: "full_order",
    notes: null,
    offer_text: "20% Off",
    offer_promotion_id: null,
    slack_thread_ts: "1789418445.935639",
    onboarding_session_id: "onb1",
    store_details_confirmed_at: "2026-09-14T20:41:25.116",
    digital_fulfilled_at: null,
    canceled_at: null,
    tracking_number: null,
    tracking_status: null,
    account_id: "acc1",
    account_name: "Gregorio's Trattoria",
    account_status: "pending",
    csm_name: "Jonathan Watkins",
    csm_email: "jonathan@example.com",
    requested_by_name: null,
    requested_by_email: null,
    location_id: "loc1",
    location_name: "Gregorio's Trattoria (Reston)",
    location_status: "enabled",
    address: "1428 North Point Village Center, Reston, VA 20194, USA",
    website_url: "https://example.com/",
    ordering_url: null,
    google_place_id: "ChIJplace",
    is_general: false,
    shipping_recipient_name: "Gregory Kahn",
    shipping_address_line1: "1428 North Point Village Center",
    shipping_address_line2: null,
    shipping_city: "Reston",
    shipping_state: "VA",
    shipping_zip: "20194",
    items: [
      { item_type: "tapcards", placement: null, focus: null, quantity: 10, printed_at: null },
      { item_type: "signage", placement: "point_of_purchase", focus: null, quantity: 1, printed_at: null },
      { item_type: "stickers", placement: "table", focus: "subscribe", quantity: 10, printed_at: null },
      { item_type: "stickers", placement: "table", focus: "review", quantity: 10, printed_at: null },
      { item_type: "stickers", placement: "bathroom", focus: "subscribe", quantity: 6, printed_at: null },
      { item_type: "stickers", placement: "bathroom", focus: "review", quantity: 6, printed_at: null },
    ],
    ...overrides,
  };
}

test("status aliases resolve to the derived admin lane and reject unknown values", () => {
  assert.equal(resolveStatus(undefined), "digital_fulfillment");
  assert.equal(resolveStatus("branding"), "digital_fulfillment");
  assert.equal(resolveStatus("Digital-Fulfillment"), "digital_fulfillment");
  assert.equal(resolveStatus("open"), "open");
  assert.throws(() => resolveStatus("shipped"), /Unsupported --status/);
});

test("derived state mirrors getFulfillmentState for open rows", () => {
  assert.equal(deriveOpenState(row()), "digital_fulfillment");
  assert.equal(deriveOpenState(row({ canceled_at: "2026-09-01T00:00:00" })), null);
  assert.equal(deriveOpenState(row({ tracking_number: "1Z" })), null);
  assert.equal(deriveOpenState(row({ digital_fulfilled_at: "2026-09-15T00:00:00", store_details_confirmed_at: null })), "store_details");
  assert.equal(deriveOpenState(row({ digital_fulfilled_at: "2026-09-15T00:00:00", shipping_zip: null })), "store_details");
  assert.equal(deriveOpenState(row({ digital_fulfilled_at: "2026-09-15T00:00:00", offer_text: " " })), "store_details");
  assert.equal(deriveOpenState(row({ digital_fulfilled_at: "2026-09-15T00:00:00" })), "physical_fulfillment");
  const printed = row().items!.map((item) => ({ ...item, printed_at: "2026-09-15T00:00:00" }));
  assert.equal(deriveOpenState(row({ digital_fulfilled_at: "2026-09-15T00:00:00", items: printed })), "printing_label");
});

test("V2 location addresses split into identity fields and unparseable ones are flagged", () => {
  assert.deepEqual(parseLocationAddress("4611-a Sangamore Rd, Bethesda, MD 20816, USA"), {
    street_address: "4611-a Sangamore Rd", city: "Bethesda", state: "MD", postal_code: "20816", complete: true,
  });
  assert.deepEqual(parseLocationAddress("12505 Park Potomac Ave Ste 110, Potomac, MD 20854"), {
    street_address: "12505 Park Potomac Ave Ste 110", city: "Potomac", state: "MD", postal_code: "20854", complete: true,
  });
  assert.equal(parseLocationAddress(null).complete, false);
  assert.equal(parseLocationAddress("Somewhere in Reston").complete, false);
});

test("canonical request carries the v2 key, resolved ids, quantities, and exact-matches its own row", () => {
  const request = toCanonicalRequest(row(), "digital_fulfillment", [], {
    processed_fulfillment_request_ids: ["other"],
    fulfillment_request_outcomes: { req1: { status: "needs_review" } },
  });
  assert.equal(request.request_key, "v2:req1");
  assert.equal(request.fulfillment_request_id, "req1");
  assert.equal(request.canonical_thread_ts, "1789418445.935639");
  assert.equal(request.expected_location_id, "loc1");
  assert.equal(request.badge_quantity, null);
  assert.equal(request.badge_quantity_status, "missing");
  assert.deepEqual(request.quantities, { tap_cards: 10, tables: 10, bathroom_stalls: 6, signage: 1, to_go_rolls: 0 });
  assert.equal(request.fields.ship_to, "Gregory Kahn, 1428 North Point Village Center, Reston, VA 20194");
  assert.equal(request.already_processed, false);
  assert.deepEqual(request.prior_outcome, { status: "needs_review" });
  const match = matchLocationExactly(request.fields, request.location_candidates);
  assert.equal(match.status, "matched");
  const preflight = preflightFulfillmentBatch([request]);
  assert.equal(preflight.status, "ready");
  assert.equal(preflight.matched_requests, 1);
});

test("already processed ids and thread-less requests are represented honestly", () => {
  const request = toCanonicalRequest(row({ slack_thread_ts: null }), "digital_fulfillment", [], {
    processed_fulfillment_request_ids: ["req1"],
  });
  assert.equal(request.canonical_thread_ts, "");
  assert.deepEqual(request.paired_message_ts, []);
  assert.equal(request.already_processed, true);
});

test("preflight reports a foreign-key mismatch instead of trusting a wrong candidate", () => {
  const request = toCanonicalRequest(row(), "digital_fulfillment", [], {});
  request.location_candidates[0].location_id = "loc_other";
  const preflight = preflightFulfillmentBatch([request]);
  assert.equal(preflight.status, "ready");
  assert.equal(preflight.matched_requests, 0);
  assert.deepEqual(preflight.unresolved_requests.map((item) => item.reason), ["foreign_key_mismatch"]);
});
