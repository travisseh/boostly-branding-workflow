import assert from "node:assert/strict";
import test from "node:test";

import { buildFulfillmentPlan } from "./fulfillment-plan.ts";
import { buildAuditRows, buildStatePatch, renderNotionChecklist, renderSlackSummary } from "./fulfillment-artifacts.ts";
import { buildOperationCommands, executePlan } from "./execute-fulfillment-plan.ts";
import { generateBatchReview, generateFulfillmentArtifacts } from "./generate-fulfillment-artifacts.ts";
import { StageRecorder } from "./stage-metrics.ts";
import { reconcileSocialReview } from "./reconcile-social-review.ts";

test("batch review validates results and includes held URL, reason, and decision", () => {
  const plan = planFixture();
  const result = {
    plan,
    execution: plan.writes.map(operation => ({ operation, outcome: "skipped_existing" as const, readback: { ok: true } })),
    artifacts: {
      boostly_account_url: "https://new.boostly.com/admin/accounts/acct_1",
      official_website_url: "https://pilonis.com",
      notion_review_url: null,
      link_tree_screenshot: "unavailable" as const,
      branding_case_id: null,
      branding_outcome: "held" as const,
      branding_reason: "Outside link-only scope",
    },
  };
  const review = generateBatchReview([result]);
  assert.match(review, /1 requests require review/);
  assert.match(review, /Loyalty Rewards: https:\/\/pilonis.com\/rewards/);
  assert.match(review, /Next action: Verify the exact location and approve or reject/);
  assert.doesNotMatch(review, /branding_reason|local paths|badge_outcome/);
  assert.throws(() => generateBatchReview([{ ...result, execution: [] }]), /does not cover every planned write/);
  const incomplete = generateBatchReview([], [{ request_id: "req_2", location_name: "Example", reason: "Browser verification timed out" }]);
  assert.match(incomplete, /0 request results checked/);
  assert.match(incomplete, /1 additional requests have incomplete discovery/);
  assert.doesNotMatch(incomplete, /No held links or operational blockers remain/);
  const held = plan.links.find(link => link.action === "hold");
  assert(held);
  held.reason = "Social URL-only endpoint is not deployed";
  const legacyReview = generateBatchReview([result]);
  assert.match(legacyReview, /Retry with the current socials set CLI/);
  assert.doesNotMatch(legacyReview, /Next action: Deploy/);
});

test("Slack and Notion golden output comes only from structured result data", () => {
  const plan = planFixture();
  const execution = plan.writes.map((operation) => ({ operation, outcome: "applied" as const, readback: { ok: true } }));
  const result = {
    plan,
    execution,
    artifacts: {
      boostly_account_url: "https://new.boostly.com/admin/accounts/acct_1",
      official_website_url: "https://pilonis.com",
      notion_review_url: "https://www.notion.so/review",
      link_tree_screenshot: "attached" as const,
      link_tree_url: "https://tp.boostly.com/5PAT",
      branding_proof_screenshot: "attached" as const,
      source_photo_count: 10,
      branding_case_id: "brand_case_1",
      branding_outcome: "held" as const,
      branding_reason: "existing values are fill-only",
      badge_outcome: "created" as const,
      badges_created: 15,
    },
  };
  const slack = renderSlackSummary(result);
  assert.equal(slack, [
    "<https://new.boostly.com/admin/accounts/acct_1|Open Boostly account>",
    "<https://pilonis.com|Open official website>",
    "",
    "Added 1 links, held 1 for review, unresolved 0",
    "",
    "Verified writes:",
    "- Careers: https://pilonis.com/jobs",
    "",
    "Held for review:",
    "- Loyalty Rewards: https://pilonis.com/rewards — This category requires human approval under the current write policy.",
    "",
  ].join("\n"));
  const notion = renderNotionChecklist(result);
  assert.match(notion, /\[x\] Careers: https:\/\/pilonis.com\/jobs/);
  assert.match(notion, /\[ \] Loyalty Rewards: https:\/\/pilonis.com\/rewards/);
  assert.match(notion, /Cam must review and explicitly approve every held or unresolved item/);
  assert.equal(buildAuditRows(result).length, plan.writes.length);
  assert.equal(buildStatePatch(result).add_processed_badge_request_id, null);
  const generated = generateFulfillmentArtifacts(result);
  assert.equal((generated.stage_metrics as Array<Record<string, unknown>>)[0].stage, "artifact_generation");
});

test("executor builds settings-CLI commands and keeps operations sequential with dry-run/readback", () => {
  const plan = planFixture();
  const careers = plan.writes.find((operation) => operation.category === "careers_jobs");
  assert(careers);
  const commands = buildOperationCommands(plan, careers, "/tmp/cookie");
  assert.deepEqual(commands.dryRun.slice(0, 3), ["events", "add-custom", "loc_1"]);
  assert(commands.dryRun.includes("Join Our Team"));
  assert(commands.dryRun.includes("Grow with our team"));
  assert(commands.dryRun.includes("Apply Now"));
  assert(commands.dryRun.includes("--fill-only"));
  assert.equal(commands.apply.at(-1), "--apply");

  const invoked: string[][] = [];
  const metrics = new StageRecorder();
  const records = executePlan(plan, {
    apply: false,
    cookieFile: "/tmp/cookie",
    runCommand(args) {
      invoked.push(args);
      return { ok: true };
    },
    metrics,
  });
  assert(records.every((record) => record.outcome === "dry_run"));
  assert.equal(invoked.length, plan.writes.length * 2, "each dry-run operation reads first, then previews");
  assert.equal(metrics.snapshot().stages.length, plan.writes.length * 2);
  const dryRunResult = {
    plan,
    execution: records,
    artifacts: {
      boostly_account_url: "https://new.boostly.com/admin/accounts/acct_1",
      official_website_url: "https://pilonis.com",
      notion_review_url: null,
      link_tree_screenshot: "unavailable" as const,
      branding_case_id: null,
      branding_outcome: "held" as const,
      branding_reason: "dry run",
      badge_outcome: "none" as const,
      badges_created: 0,
    },
  };
  assert.equal(buildStatePatch(dryRunResult).add_processed_request_key, null, "dry runs never advance dedupe state");

  const defaultsPlan = structuredClone(plan);
  const defaults = defaultsPlan.writes.find((operation) => operation.kind === "linktree_defaults");
  assert(defaults);
  defaults.payload = { verified_socials_present: true };
  defaultsPlan.writes.unshift({
    kind: "branding",
    scope: "account",
    payload: { facebook_url: "https://www.facebook.com/example" },
    sequence: 0,
    idempotency_key: "test-branding",
    fill_only: true,
    requires_readback: true,
  });
  const defaultsCommands = buildOperationCommands(defaultsPlan, defaults, "/tmp/cookie");
  assert(defaultsCommands.dryRun.includes("--planned-socials-present"));
  assert(!defaultsCommands.apply.includes("--planned-socials-present"));

  const applied = executePlan(plan, {
    apply: true,
    cookieFile: "/tmp/cookie",
    lockDir: "/tmp/boostly-test-locks",
    runCommand(args) {
      return args.includes("--apply") ? { success: true, no_op: true } : { ok: true };
    },
  });
  assert(applied.every((record) => record.outcome === "skipped_existing"));
});

test("generated collaboration artifacts include social URLs written through branding payloads", () => {
  const plan = planFixture();
  plan.links.unshift({
    category: "facebook",
    url: "https://www.facebook.com/example",
    action: "write",
    reason: "deterministic_high_confidence_gate_passed",
    target: "branding",
  });
  plan.writes.unshift({
    kind: "branding",
    scope: "account",
    payload: { facebook_url: "https://www.facebook.com/example" },
    sequence: 0,
    idempotency_key: "test-facebook-write",
    fill_only: true,
    requires_readback: true,
  });
  const execution = plan.writes.map((operation) => ({ operation, outcome: "applied" as const, readback: { ok: true } }));
  const result = {
    plan,
    execution,
    artifacts: {
      boostly_account_url: "https://new.boostly.com/admin/accounts/acct_1",
      official_website_url: "https://pilonis.com",
      notion_review_url: null,
      link_tree_screenshot: "unavailable" as const,
      branding_case_id: null,
      branding_outcome: "held" as const,
      branding_reason: "handled separately",
      badge_outcome: "created" as const,
      badges_created: 15,
    },
  };

  assert.match(renderSlackSummary(result), /- Facebook: https:\/\/www\.facebook\.com\/example/);
  assert.doesNotMatch(renderSlackSummary(result), /Badges:|Branding:|Review checklist:|Link tree|branding_case_id/i);
  assert.match(renderNotionChecklist(result), /\[x\] Facebook: https:\/\/www\.facebook\.com\/example/);
  plan.request.fulfillment_request_id = "req1";
  plan.request.request_key = "v2:req1";
  plan.writes.forEach((operation, index) => { operation.sequence = index + 1; });
  const stale = "- [ ] Facebook: https://www.facebook.com/example\nReason: Social URL-only endpoint is not deployed; engineering must deploy it before this verified URL can be saved.\nNext action: Deploy the URL-only social endpoint, then rerun the fill-only write and readback. Do not use the branding writer.";
  const page = `Request: req1\n${stale}\nUser note: preserve this\n${stale}`;
  const updates = reconcileSocialReview(page, [result]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].replace_all_matches, true);
  assert.equal(updates[0].new_str, "- [x] Facebook: https://www.facebook.com/example");
  assert.match(page.replaceAll(updates[0].old_str, updates[0].new_str), /User note: preserve this/);
  assert.throws(() => reconcileSocialReview(`${page}\nRequest: other\n${stale}`, [result]), /outside validated request context/);
  assert.throws(() => reconcileSocialReview(`Request: req1\n${stale.replaceAll("/example", "/unknown")}`, [result]), /No verified current replacement/);
});

test("existing URL reconciliation is not counted as a new link", () => {
  const plan = planFixture();
  plan.write_policy = "links_only";
  const result = {
    plan,
    execution: plan.writes.map(operation => ({
      operation,
      outcome: "applied" as const,
      after: { reconciled_existing: operation.category === "careers_jobs" },
      readback: { ok: true },
    })),
    artifacts: {
      boostly_account_url: "https://new.boostly.com/admin/accounts/acct_1",
      official_website_url: "https://pilonis.com",
      notion_review_url: null,
      link_tree_screenshot: "unavailable" as const,
      branding_case_id: null,
      branding_outcome: "held" as const,
      branding_reason: "Outside link-only scope",
    },
  };
  assert.match(renderSlackSummary(result), /Added 0 links/);
  const notion = renderNotionChecklist(result);
  assert.match(notion, /Existing Link Settings Updated[\s\S]*Careers: https:\/\/pilonis.com\/jobs/);
  assert.doesNotMatch(notion.split("## Existing Link Settings Updated")[0], /\[x\] Careers/);
});

function planFixture() {
  return buildFulfillmentPlan({
    request: {
      request_key: "pilonis|terre-haute",
      canonical_thread_ts: "1783715705.000100",
      badge_quantity: 15,
      badge_quantity_status: "valid",
    },
    location: {
      location_id: "loc_1",
      location_name: "Piloni's Italian Restaurant",
      account_id: "acct_1",
      account_name: "Piloni's",
      website_url: "https://pilonis.com",
      is_general: false,
      branding_scope: "location",
    },
    discovery_report: {
      category_results: [
        { category: "careers_jobs", category_status: "found_verified", selected_link: { input_url: "https://pilonis.com/jobs" } },
        // loyalty stays review-only (gift cards became a standing write on 2026-10-19)
        { category: "loyalty_rewards", category_status: "found_verified", selected_link: { input_url: "https://pilonis.com/rewards" } },
      ],
      proposed_location_updates: [],
      proposed_touchpoint_events: [
        {
          touchpoint_category: "careers_jobs",
          url: "https://pilonis.com/jobs",
          verification: {
            status: "verified",
            liveness: "live",
            relevance: "match",
            source_type: "website",
            validity_evidence: ["http_status=200"],
            location_match_evidence: ["official_website_links_to_candidate=true"],
          },
          write_gate: {},
        },
        {
          touchpoint_category: "loyalty_rewards",
          url: "https://pilonis.com/rewards",
          verification: {
            status: "verified",
            liveness: "live",
            relevance: "match",
            source_type: "website",
            validity_evidence: ["http_status=200"],
          },
          write_gate: {},
        },
      ],
      manual_review_items: [],
    },
    branding: { status: "hold", flags: [] },
  });
}
