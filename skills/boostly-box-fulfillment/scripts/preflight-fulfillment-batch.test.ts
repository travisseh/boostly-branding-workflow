import assert from "node:assert/strict";
import test from "node:test";

import {
  missingPlaceIdMessage,
  preflightFulfillmentBatch,
  type BatchPreflightRequest,
} from "./preflight-fulfillment-batch.ts";

test("batch preflight is ready when every exact match has a Place ID", () => {
  const result = preflightFulfillmentBatch([request("loc_1", "ChIJ-one")]);
  assert.equal(result.status, "ready");
  assert.equal(result.matched_requests, 1);
  assert.deepEqual(result.blockers, []);
});

test("one missing Place ID blocks the whole batch and identifies the location", () => {
  const result = preflightFulfillmentBatch([
    request("loc_1", "ChIJ-one"),
    request("loc_2", null, "Second Restaurant"),
  ]);
  assert.equal(result.status, "blocked_missing_google_place_id");
  assert.equal(result.checked_requests, 2);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].location_id, "loc_2");
  assert.match(missingPlaceIdMessage(result.blockers), /Second Restaurant/);
  assert.match(missingPlaceIdMessage(result.blockers), /No request state was advanced/);
});

test("General locations are never considered a matched Place ID substitute", () => {
  const input = request("loc_1", null);
  input.location_candidates.unshift({
    ...input.location_candidates[0],
    location_id: "general",
    location_name: "General",
    google_place_id: "ChIJ-general",
    is_general: true,
  });
  const result = preflightFulfillmentBatch([input]);
  assert.equal(result.status, "blocked_missing_google_place_id");
  assert.equal(result.blockers[0].location_id, "loc_1");
});

function request(
  locationId: string,
  googlePlaceId: string | null,
  name = "Example Restaurant",
): BatchPreflightRequest {
  return {
    request_key: `${name}|123 main st`,
    canonical_thread_ts: "1785000000.000100",
    fields: {
      account_name: name,
      location_name: name,
      street_address: "123 Main St",
      city: "Lehi",
      state: "UT",
      postal_code: "84043",
    },
    location_candidates: [{
      location_id: locationId,
      location_name: name,
      location_status: "enabled",
      account_id: `acct_${locationId}`,
      account_name: name,
      address: "123 Main St, Lehi, UT 84043",
      google_place_id: googlePlaceId,
      is_general: false,
    }],
  };
}
