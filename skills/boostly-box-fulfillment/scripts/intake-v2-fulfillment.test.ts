import assert from "node:assert/strict";
import test from "node:test";
import { databasePreparation, type DatabaseRequest } from "./intake-v2-fulfillment.ts";
import { prepareFulfillmentPlan } from "./prepare-fulfillment-plan.ts";
import { buildStatePatch } from "./fulfillment-artifacts.ts";
import { buildFulfillmentPlan, validateFulfillmentPlan } from "./fulfillment-plan.ts";
import { buildOperationCommands, executePlan } from "./execute-fulfillment-plan.ts";

const row: DatabaseRequest = {
  request_id: "req1", created_at: "2026-09-15T00:00:00", order_type: "full_order", canceled_at: null,
  digital_fulfilled_at: "2026-09-15T00:01:00", location_id: "loc1", location_name: "Restaurant",
  account_id: "acct1", account_name: "Account", location_status: "enabled", account_status: "enabled",
  address: "1 Main St, Charlotte, NC 28202, USA", website_url: "https://example.com", google_place_id: "place1", is_general: false,
};
const report = { location_context: { location_id: "loc1" }, runtime: { fulfillment_mode: true, browser_provider: "codex-extension", browser_provider_preflighted: true, chrome_profile_resolved: "Boostly.com" }, category_results: [], proposed_location_updates: [], proposed_touchpoint_events: [], manual_review_items: [] };

test("database identity works without Slack and does not skip digitally fulfilled requests", () => {
  const input = databasePreparation(row, [row], report);
  const result = prepareFulfillmentPlan(input);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.plan.request.fulfillment_request_id, "req1");
  assert.equal(result.plan.request.canonical_thread_ts, "");
  assert.equal(result.plan.writes.at(-1)?.kind, "linktree_defaults");
  assert.deepEqual(validateFulfillmentPlan(result.plan), []);
  const patch = buildStatePatch({ plan: result.plan, execution: result.plan.writes.map(operation => ({ operation, outcome: "skipped_existing", readback: {} })), artifacts: {} as any });
  assert.equal(patch.add_processed_fulfillment_request_id, "req1");
  assert.equal(patch.add_processed_message_ts, null);
  assert.equal(patch.last_processed_ts, null);
  input.request.expected_location_id = "sibling";
  assert.throws(() => prepareFulfillmentPlan(input), /foreign-key/);
});

test("canceled, ad hoc, General, and mismatched database joins fail closed", () => {
  for (const change of [{ canceled_at: "2026-09-15" }, { order_type: "ad_hoc" }, { is_general: true }]) {
    assert.throws(() => databasePreparation({ ...row, ...change }, [row], report));
  }
  assert.throws(() => databasePreparation(row, [{ ...row, account_id: "other" }], report));
});

test("operational blockers remain retryable instead of entering the processed-ID set", () => {
  const prepared = prepareFulfillmentPlan(databasePreparation(row, [row], report));
  if (prepared.status !== "ready") throw new Error("not prepared");
  const patch = buildStatePatch({ plan: prepared.plan,
    execution: prepared.plan.writes.map(operation => ({ operation, outcome: "skipped_existing", readback: {} })),
    operational_blockers: ["Search incomplete: Payment Required"], artifacts: {} as any });
  assert.equal(patch.execution_concluded, true);
  assert.equal(patch.add_processed_request_key, null);
  assert.equal(patch.add_processed_fulfillment_request_id, null);
  assert.equal((patch.fulfillment_request_outcome as any).status, "blocked");
});

test("links-only policy routes verified socials through URL-only writes and rejects branding payloads", () => {
  const prepared = prepareFulfillmentPlan(databasePreparation(row, [row], report));
  if (prepared.status !== "ready") throw new Error("not prepared");
  const plan = buildFulfillmentPlan({
    write_policy: "links_only", request: prepared.plan.request, location: prepared.plan.location,
    discovery_report: { ...report, category_results: [{ category: "instagram", category_status: "found_verified", selected_link: { input_url: "https://instagram.com/example" } }], proposed_location_updates: [{ field_name: "branding.instagram_url", proposed_value: "https://instagram.com/example", verification: { status: "verified", liveness: "live", relevance: "match", source_type: "website", validity_evidence: ["http_status=200"], location_match_evidence: ["official_website_links_to_candidate=true"] }, write_gate: {} }] },
  });
  assert.ok(plan.links.some(link => link.action === "write" && link.category === "instagram"));
  assert.ok(plan.writes.every(write => write.kind !== "branding"));
  const social = plan.writes.find(write => write.kind === "social");
  assert(social);
  assert.deepEqual(validateFulfillmentPlan(plan), []);
  assert.deepEqual(buildOperationCommands(plan, social, "/tmp/cookie").apply.slice(0, 2), ["socials", "set"]);
  const defaults = plan.writes.find(write => write.kind === "linktree_defaults");
  assert(defaults);
  assert(buildOperationCommands(plan, defaults, "/tmp/cookie").dryRun.includes("--planned-socials-present"));
  const calls: string[][] = [];
  const hash = "a".repeat(64);
  const records = executePlan(plan, { apply: true, cookieFile: "/tmp/cookie",
    runCommand: command => {
      calls.push([...command]);
      return command[0] === "socials" && !command.includes("--apply") ? { state_hash: hash } : { success: true };
    },
  });
  assert(records.every(record => record.outcome === "applied"));
  const socialApply = calls.find(command => command[0] === "socials" && command.includes("--apply"));
  assert(socialApply);
  assert.equal(socialApply[socialApply.indexOf("--expected-state-hash") + 1], hash);
  let appliedWithoutHash = false;
  const refused = executePlan(plan, { apply: true, cookieFile: "/tmp/cookie",
    runCommand: command => { if (command.includes("--apply")) appliedWithoutHash = true; return {}; },
  });
  assert.equal(refused[0].outcome, "error");
  assert.equal(appliedWithoutHash, false);
  social.payload!.logo_attachment_id = "forbidden";
  assert.ok(validateFulfillmentPlan(plan).includes(`invalid_social_write_${social.sequence}`));
  plan.writes[0].kind = "branding";
  assert.ok(validateFulfillmentPlan(plan).includes("out_of_scope_link_only_write"));
});

test("explicit wrong-location holds survive the URL-only social writer", () => {
  const prepared = prepareFulfillmentPlan(databasePreparation(row, [row], report));
  if (prepared.status !== "ready") throw new Error("not prepared");
  const url = "https://instagram.com/sibling";
  const plan = buildFulfillmentPlan({
    write_policy: "links_only", request: prepared.plan.request, location: prepared.plan.location,
    safety_holds: [{ category: "instagram", url, reason: "Wrong location" }],
    discovery_report: { ...report, category_results: [{ category: "instagram", category_status: "found_verified", selected_link: { input_url: url } }], proposed_location_updates: [{ field_name: "branding.instagram_url", proposed_value: url, verification: { status: "verified", liveness: "live", relevance: "match", source_type: "website", validity_evidence: ["http_status=200"], location_match_evidence: ["official_website_links_to_candidate=true"] }, write_gate: {} }] },
  });
  assert.ok(plan.links.some(link => link.category === "instagram" && link.action === "hold" && link.reason === "Wrong location"));
  assert.ok(plan.writes.every(write => write.kind !== "social"));
});
