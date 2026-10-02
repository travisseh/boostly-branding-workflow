#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { touchpointEligible } from "./process-boosted-box-request.mjs";

function eventItem(eventTiming, writeGate = {}) {
  return {
    touchpoint_category: "events",
    verification: {
      status: "verified",
      liveness: "live",
      relevance: "match",
      source_type: "website",
      event_timing: eventTiming,
      validity_evidence: ["http_status=200"],
    },
    write_gate: {
      custom_destination_specific: true,
      upcoming_event_evidence: eventTiming?.has_upcoming_event === true,
      ...writeGate,
    },
  };
}

assert.equal(touchpointEligible(eventItem(null)), false);
assert.equal(touchpointEligible(eventItem({
  has_upcoming_event: false,
  upcoming_event_dates: [],
})), false);
assert.equal(touchpointEligible(eventItem({
  has_upcoming_event: true,
  upcoming_event_dates: ["2099-08-12T19:00:00-06:00"],
})), true);

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "process-boosted-box-request.mjs"), "utf8");
assert.match(source, /legacy pilot processor is dry-run\/replay-only/);
assert.doesNotMatch(source.match(/const AUTO_WRITE_LOCATION_FIELDS[\s\S]*?\]\);/)?.[0] ?? "", /apple_app_url|google_app_url/);

console.log("process-boosted-box-request: ok");
