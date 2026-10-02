#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { databasePreparation, type DatabaseRequest } from "./intake-v2-fulfillment.ts";
import { prepareFulfillmentPlan } from "./prepare-fulfillment-plan.ts";
import { executePlan } from "./execute-fulfillment-plan.ts";
import { generateFulfillmentArtifacts } from "./generate-fulfillment-artifacts.ts";
import { persistFulfillmentState } from "./persist-fulfillment-state.ts";
import { parseFulfillmentResult } from "./fulfillment-artifacts.ts";
import { FULFILLMENT_BROWSER_PROVIDERS, HEARTBEAT_RUNS_ROOT, V2_DB, VALIDATE_DISCOVERY_REPORT } from "./paths.ts";

const root = HEARTBEAT_RUNS_ROOT;
const args = process.argv.slice(2);
if (args.includes("--hold-socials-until-deployed")) throw new Error("Retired option: socials set now uses existing save actions; rerun without --hold-socials-until-deployed");
const get = (key: string) => args[args.indexOf(key) + 1];
for (const key of ["--run-root", "--request-id", "--cookie-file"]) if (!args.includes(key)) throw new Error(`Missing ${key}`);
const runRoot = path.resolve(get("--run-root"));
const id = get("--request-id");
if (!/^[a-z0-9]+$/.test(id)) throw new Error("Invalid request ID");
const dir = path.join(runRoot, id);
const intake = JSON.parse(fs.readFileSync(path.join(runRoot, "intake.json"), "utf8"));
const row = intake.requests.find((r: DatabaseRequest) => r.request_id === id) as DatabaseRequest | undefined;
if (!row) throw new Error("Request absent from intake snapshot");
const reportPath = path.join(dir, "link-discovery-report.json");
// The report declares which live-session provider produced it (codex-extension from the Codex
// heartbeat, claude-chrome from a Claude session); the validator then enforces that provider's
// fulfillment rules. Anything else is rejected as codex-extension would be.
const reportProvider = String(JSON.parse(fs.readFileSync(reportPath, "utf8")).runtime?.browser_provider ?? "");
const requiredProvider = (FULFILLMENT_BROWSER_PROVIDERS as readonly string[]).includes(reportProvider) ? reportProvider : "codex-extension";
execFileSync(process.execPath, [VALIDATE_DISCOVERY_REPORT, "--report", reportPath, "--location-id", row.location_id, "--require-browser-provider", requiredProvider, "--require-chrome-profile", "Boostly.com"], { encoding: "utf8" });
const current = JSON.parse(execFileSync(V2_DB, ["query", "--json", "--sql", `select fr.id,fr.location_id,fr.canceled_at,fr.order_type::text,l.account_id,l.address,l.name from fulfillment_requests fr join locations l on l.id=fr.location_id where fr.id='${id}'`], { encoding: "utf8" }));
if (current.length !== 1 || current[0].canceled_at || current[0].order_type !== "full_order" || current[0].location_id !== row.location_id || current[0].account_id !== row.account_id || current[0].address !== row.address || current[0].name !== row.location_name) throw new Error("Live request identity/cancellation changed; refresh intake");
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const input = databasePreparation(row, intake.account_locations, report);
const holdsPath = path.join(runRoot, "safety-holds.json");
if (fs.existsSync(holdsPath)) input.safety_holds = JSON.parse(fs.readFileSync(holdsPath, "utf8"))[id] ?? [];
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const prepared = prepareFulfillmentPlan(input);
save("preparation-input.json", input);
save("preparation-result.json", prepared);
if (prepared.status !== "ready") throw new Error("Preparation needs identity review");
const plan = prepared.plan;
save("fulfillment-plan.json", plan);
const dryRun = executePlan(plan, { apply: false, cookieFile: get("--cookie-file") });
save("execution-dry-run.json", dryRun);
if (dryRun.length !== plan.writes.length || dryRun.some(record => record.outcome === "error")) throw new Error("Executor dry-run failed; inspect saved receipt");
if (!args.includes("--apply")) {
  console.log(JSON.stringify({ request_id: id, name: row.location_name, dry_run: true, operations: plan.writes.map(w => ({ kind: w.kind, category: w.category, url: w.url })), links: plan.links.map(l => ({ category: l.category, action: l.action, url: l.url, reason: l.reason })) }));
} else {
  const execution = executePlan(plan, { apply: true, cookieFile: get("--cookie-file") });
  save("execution.json", execution);
  if (execution.length !== plan.writes.length) throw new Error("Incomplete execution; preserve receipts and retry only after checking readbacks");
  const result = parseFulfillmentResult({ plan, execution,
    operational_blockers: [...new Set<string>([
      ...(report.source_pages ?? []).filter((page: any) => page.source_type === "search" && ["error", "blocked"].includes(page.search_status)).map((page: any) => `Search incomplete: ${page.error ?? page.search_status}`),
    ])],
    artifacts: {
    boostly_account_url: `https://new.boostly.com/admin/accounts/${row.account_id}`,
    official_website_url: row.website_url ?? null,
    notion_review_url: null,
    link_tree_screenshot: "unavailable",
    link_tree_reason: "No previously known exact-location public URL; no asset lookup performed",
    branding_case_id: null, branding_outcome: "held", branding_reason: "Outside link-only scope",
  } });
  save("fulfillment-result.json", result);
  const artifacts = generateFulfillmentArtifacts(result);
  save("artifact-generation.json", artifacts);
  fs.writeFileSync(path.join(dir, "slack-summary.txt"), String(artifacts.slack_summary));
  const options = { auditLog: path.join(root, "boosted-box-heartbeat-audit.jsonl"), stateFile: path.join(root, "boosted-box-heartbeat-state.json") };
  persistFulfillmentState(result, { ...options, apply: false });
  persistFulfillmentState(result, { ...options, apply: true });
  console.log(JSON.stringify({ request_id: id, name: row.location_name, applied: execution.filter(r => r.outcome === "applied").map(r => ({ kind: r.operation.kind, category: r.operation.category, url: r.operation.url })), skipped: execution.filter(r => r.outcome === "skipped_existing").length, held: plan.links.filter(l => l.action === "hold").length, errors: execution.filter(r => r.outcome === "error").map(r => r.reason) }));
}
