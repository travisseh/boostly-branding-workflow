import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareFulfillmentPlan, type PreparationInput } from "./prepare-fulfillment-plan.ts";

test("preparation matches exactly, excludes General, selects account scope, and applies state dedupe", () => {
  const input = fixture();
  input.heartbeat_state = {
    processed_request_keys: [input.request.request_key],
  };
  const result = prepareFulfillmentPlan(input);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.plan.location.branding_scope, "account");
  assert.deepEqual(result.plan.writes, []);
  assert.deepEqual(result.plan.metrics.map((metric) => metric.stage), ["location_match", "plan_build"]);
});

test("ambiguous identity stops before plan creation and routes only that exception to Sol", () => {
  const input = fixture();
  input.location_candidates.push({ ...input.location_candidates[1], location_id: "loc_2" });
  const result = prepareFulfillmentPlan(input);
  assert.equal(result.status, "needs_model_review");
  if (result.status === "needs_model_review") {
    assert.equal(result.exception.kind, "ambiguous_business_identity");
    assert.equal(result.exception.model, "sol");
  }
});

test("a discovery report for another location fails closed", () => {
  const input = fixture();
  input.discovery_report.location_context = { location_id: "wrong" };
  assert.throws(() => prepareFulfillmentPlan(input), /Discovery report location mismatch/);
});

test("preparation rejects a Playwright discovery report for live fulfillment", () => {
  const input = fixture();
  input.discovery_report.runtime = {
    fulfillment_mode: true,
    browser_provider: "playwright",
    browser_provider_preflighted: false,
  };
  assert.throws(() => prepareFulfillmentPlan(input), /requires browser_provider=codex-extension or claude-chrome/);
});

// 2026-09-29: Codex is the default fulfillment discovery transport; both live-session providers
// pass, always with the Boostly.com profile and preflight true.
test("preparation accepts a preflighted codex-extension report and rejects static, unpreflighted, or another profile", () => {
  const runtime = {
    fulfillment_mode: true,
    browser_provider: "codex-extension",
    required_browser_provider: "codex-extension",
    browser_provider_preflighted: true,
    chrome_profile_requested: "Boostly.com",
    chrome_profile_resolved: "Boostly.com",
  };
  const accepted = fixture();
  accepted.discovery_report.runtime = runtime;
  assert.equal(prepareFulfillmentPlan(accepted).status, "ready");

  const staticReport = fixture();
  staticReport.discovery_report.runtime = { ...runtime, browser_provider: "static" };
  assert.throws(() => prepareFulfillmentPlan(staticReport), /requires browser_provider=codex-extension or claude-chrome/);

  const unpreflighted = fixture();
  unpreflighted.discovery_report.runtime = { ...runtime, browser_provider_preflighted: false };
  assert.throws(() => prepareFulfillmentPlan(unpreflighted), /did not preflight the codex-extension browser provider/);

  const otherProfile = fixture();
  otherProfile.discovery_report.runtime = { ...runtime, chrome_profile_resolved: "Travisse" };
  assert.throws(() => prepareFulfillmentPlan(otherProfile), /requires the Boostly.com Chrome profile/);
});

test("preparation accepts a preflighted claude-chrome discovery report with no browser results pending", () => {
  const input = fixture();
  input.discovery_report.runtime = {
    fulfillment_mode: true,
    browser_provider: "claude-chrome",
    required_browser_provider: "claude-chrome",
    browser_provider_preflighted: true,
    chrome_profile_requested: "Boostly.com",
    chrome_profile_resolved: "Boostly.com",
    browser_needed: [],
  };
  assert.equal(prepareFulfillmentPlan(input).status, "ready");
});

test("preparation rejects a claude-chrome report with browser results pending, unpreflighted, or from another profile", () => {
  const runtime = {
    fulfillment_mode: true,
    browser_provider: "claude-chrome",
    required_browser_provider: "claude-chrome",
    browser_provider_preflighted: true,
    chrome_profile_requested: "Boostly.com",
    chrome_profile_resolved: "Boostly.com",
    browser_needed: [{ url: "https://www.dogwood.pizza/", kind: "website" }],
  };
  const pending = fixture();
  pending.discovery_report.runtime = runtime;
  assert.throws(() => prepareFulfillmentPlan(pending), /1 browser result\(s\) pending/);

  const unpreflighted = fixture();
  unpreflighted.discovery_report.runtime = { ...runtime, browser_provider_preflighted: false, browser_needed: [] };
  assert.throws(() => prepareFulfillmentPlan(unpreflighted), /did not preflight the claude-chrome browser provider/);

  const missing = fixture();
  missing.discovery_report.runtime = { ...runtime, browser_needed: undefined };
  assert.throws(() => prepareFulfillmentPlan(missing), /missing runtime.browser_needed/);

  const wrongProfile = fixture();
  wrongProfile.discovery_report.runtime = { ...runtime, browser_needed: [], chrome_profile_resolved: "Travisse" };
  assert.throws(() => prepareFulfillmentPlan(wrongProfile), /requires the Boostly.com Chrome profile/);
});

test("preparation rejects a report crawled through the diagnostics website override", () => {
  const input = fixture();
  input.discovery_report.website_bootstrap = { attempted: false, reason: "website_url_override_unwritten", override_url: "https://example.com" };
  assert.throws(() => prepareFulfillmentPlan(input), /diagnostics website override/);
});

test("a processed request does not require a fresh browser-backed discovery report", () => {
  const input = fixture();
  delete input.discovery_report.runtime;
  input.heartbeat_state = {
    processed_request_keys: [input.request.request_key],
  };
  const result = prepareFulfillmentPlan(input);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.deepEqual(result.plan.writes, []);
  }
});

test("a matched location without a Google Place ID fails before plan creation", () => {
  const input = fixture();
  input.location_candidates[1].google_place_id = null;
  assert.throws(() => prepareFulfillmentPlan(input), /Missing google_place_id/);
});

test("preparation rejects any downstream override of validated Fable branding", () => {
  const input = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fable-immutable-"));
  const decisionPath = path.join(directory, "fable-decision.json");
  const decision = {
    logo_choice: "/tmp/source-logo.jpg",
    palette: {
      web_primary_color: "#FE0000",
      web_secondary_color: "#000000",
      web_text_color: "#000000",
    },
    composition: "Place on white or black surfaces, never on red fields.",
    confidence: "high" as const,
    flags: [],
    rationale: "The authored red roundel requires a contrasting surface.",
  };
  const serialized = `${JSON.stringify(decision, null, 2)}\n`;
  fs.writeFileSync(decisionPath, serialized);
  input.branding = {
    status: "hold",
    flags: [],
    fable_decision_path: decisionPath,
    fable_decision_sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    fable_output: {
      ...decision,
      composition: "Preserve the opaque white square on a red field.",
    },
  };

  assert.throws(
    () => prepareFulfillmentPlan(input),
    /downstream branding override is forbidden/,
  );
});

test("preparation preserves an exact validated Fable decision", () => {
  const input = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fable-immutable-"));
  const decisionPath = path.join(directory, "fable-decision.json");
  const decision = {
    logo_choice: "/tmp/source-logo.jpg",
    palette: {
      web_primary_color: "#FE0000",
      web_secondary_color: "#000000",
      web_text_color: "#000000",
    },
    composition: "Place on white or black surfaces, never on red fields.",
    confidence: "high" as const,
    flags: [],
    rationale: "The authored red roundel requires a contrasting surface.",
  };
  const serialized = `${JSON.stringify(decision, null, 2)}\n`;
  fs.writeFileSync(decisionPath, serialized);
  input.branding = {
    status: "hold",
    flags: [],
    fable_decision_path: decisionPath,
    fable_decision_sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    fable_output: decision,
  };

  const result = prepareFulfillmentPlan(input);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.plan.branding.fable_output, decision);
});

test("preparation records accepted Luna event timing as an explicit model exception", () => {
  const input = fixture();
  input.discovery_report.category_results = [{
    category: "events",
    category_status: "found_verified",
    proposed_action: "create",
    selected_link: {
      input_url: "https://smalltowntavernpa.com/events",
      final_url: "https://smalltowntavernpa.com/events",
      event_timing: {
        luna_review: {
          status: "accepted",
          model: "gpt-5.6-luna",
          evidence_hash: "a".repeat(64),
          reason: "Visible future event card verified.",
        },
      },
    },
  }];
  const result = prepareFulfillmentPlan(input);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.plan.model_exceptions, [{
    kind: "unstructured_event_timing",
    model: "luna",
    reason: "Visible future event card verified.",
    category: "events",
    evidence_refs: ["https://smalltowntavernpa.com/events", "a".repeat(64)],
  }]);
});

function fixture(): PreparationInput {
  const requestKey = "small town tavern|small town tavern|110 sara way|belle vernon|pa|15012";
  return {
    request: {
      request_key: requestKey,
      canonical_thread_ts: "1783960267.741929",
      fields: {
        account_name: "Small Town Tavern",
        location_name: "Small Town Tavern",
        street_address: "110 Sara Way",
        city: "Belle Vernon",
        state: "PA",
        postal_code: "15012",
      },
      badge_quantity: 10,
      badge_quantity_status: "valid",
    },
    location_candidates: [
      {
        location_id: "general",
        location_name: "General",
        location_status: "enabled",
        account_id: "acct_1",
        account_name: "Small Town Tavern",
        address: "110 Sara Way, Belle Vernon, PA 15012",
        is_general: true,
      },
      {
        location_id: "loc_1",
        location_name: "Small Town Tavern",
        location_status: "enabled",
        account_id: "acct_1",
        account_name: "Small Town Tavern",
        address: "110 Sara Way, Belle Vernon, PA 15012",
        website_url: "https://smalltowntavernpa.com",
        google_place_id: "ChIJ-small-town",
        is_general: false,
      },
    ],
    discovery_report: {
      location_context: { location_id: "loc_1", website_url: "https://smalltowntavernpa.com" },
      runtime: {
        fulfillment_mode: true,
        browser_provider: "codex-extension",
        required_browser_provider: "codex-extension",
        browser_provider_preflighted: true,
        chrome_profile_requested: "Boostly.com",
        chrome_profile_resolved: "Boostly.com",
      },
      category_results: [],
      proposed_location_updates: [],
      proposed_touchpoint_events: [],
      manual_review_items: [],
    },
  };
}
