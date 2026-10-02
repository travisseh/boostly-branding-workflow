import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFulfillmentPlan } from "./fulfillment-plan.ts";
import { persistFulfillmentState } from "./persist-fulfillment-state.ts";

test("state persistence is dry-run by default, additive, atomic, and audit append-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-state-"));
  const auditLog = path.join(root, "audit.jsonl");
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({ initialized: true, last_processed_ts: "101.2", processed_request_keys: ["older"], processed_badge_request_ids: [], processed_message_ts: [] })}\n`);
  const plan = buildFulfillmentPlan({
    request: { request_key: "new", canonical_thread_ts: "100.1", badge_quantity: null, badge_quantity_status: "missing" },
    location: { location_id: "loc", location_name: "Location", account_id: "acct", account_name: "Account", website_url: null, is_general: false, branding_scope: "account" },
    discovery_report: {
      category_results: [{ category: "instagram", category_status: "found_verified", selected_link: { input_url: "https://instagram.com/account" } }],
      proposed_location_updates: [{
        field_name: "branding.instagram_url",
        proposed_value: "https://instagram.com/account",
        verification: { status: "verified", liveness: "live", relevance: "match", source_type: "website", validity_evidence: ["http_status=200"], location_match_evidence: ["official_website_links_to_candidate=true"] },
        write_gate: {},
      }],
      proposed_touchpoint_events: [],
      manual_review_items: [],
    },
  });
  const result = {
    plan,
    execution: plan.writes.map((operation) => ({ operation, outcome: "applied" as const, readback: { ok: true } })),
    artifacts: {
      boostly_account_url: "https://new.boostly.com/admin/accounts/acct",
      official_website_url: null,
      notion_review_url: null,
      link_tree_screenshot: "unavailable" as const,
      branding_case_id: null,
      branding_outcome: "held" as const,
      branding_reason: "no branding write",
      badge_outcome: "none" as const,
      badges_created: 0,
    },
  };
  persistFulfillmentState(result, { auditLog, stateFile, apply: false });
  assert.equal(fs.existsSync(auditLog), false);
  persistFulfillmentState(result, { auditLog, stateFile, apply: true });
  persistFulfillmentState(result, { auditLog, stateFile, apply: true });
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(state.processed_request_keys, ["older", "new"]);
  assert.deepEqual(state.processed_message_ts, ["100.1"]);
  assert.equal(state.last_processed_ts, "101.2", "an older canonical thread cannot move the cursor backward");
  assert.equal(fs.existsSync(`${stateFile}.lock`), false);
  assert.equal(fs.readFileSync(auditLog, "utf8").trim().split(/\r?\n/).length, plan.writes.length, "retries do not duplicate append-only audit rows");
});
