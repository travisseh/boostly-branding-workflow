#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { parseFulfillmentResult } from "./fulfillment-artifacts.ts";
import { generateFulfillmentArtifacts } from "./generate-fulfillment-artifacts.ts";
import { persistFulfillmentState } from "./persist-fulfillment-state.ts";
import { refreshReview } from "./notion-review-refresh.ts";

const wrapper = process.env.NOTION_WRAPPER || `${process.env.HOME}/.config/notion-tools/notion-ai-ntn.sh`;
import { HEARTBEAT_RUNS_ROOT } from "./paths.ts";

const root = HEARTBEAT_RUNS_ROOT;
const dir = path.resolve(process.argv[2] ?? "");
const resultFile = path.join(dir, "fulfillment-result.json");
const result = parseFulfillmentResult(JSON.parse(fs.readFileSync(resultFile, "utf8")));
if (!result.plan.request.fulfillment_request_id || result.plan.write_policy !== "links_only") throw new Error("Expected database link-only result");
const call = (...args: string[]) => execFileSync(wrapper, ["--workspace", "boostly", ...args], { encoding: "utf8", timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
const artifacts = generateFulfillmentArtifacts(result);
const title = String(artifacts.notion_checklist).split("\n")[0].replace(/^# /, "");
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "fulfillment-notion-"));
const checklistPath = path.join(stagingDir, "notion-checklist.md");
fs.writeFileSync(checklistPath, String(artifacts.notion_checklist), { mode: 0o600 });
process.on("exit", () => fs.rmSync(stagingDir, { recursive: true, force: true }));
const found = JSON.parse(call("find-output", title));
if (!Array.isArray(found.results) || found.has_more) throw new Error("Incomplete Notion dedupe response");
const matches = found.results.filter((page: any) => page.properties?.Name?.title?.map((part: any) => part.plain_text ?? part.text?.content ?? "").join("") === title);
if (matches.length !== found.results.length || matches.length > 1) throw new Error("Unexpected Notion title match");
let pageId: string;
let url: string;
if (matches.length) { pageId = matches[0].id; url = matches[0].url; }
else {
  const created = call("create", title, "research", `@${checklistPath}`).trim().split("\n");
  [pageId, url] = created;
}
if (!/^[a-f0-9-]{36}$/.test(pageId) || !/^https:\/\//.test(url)) throw new Error("Invalid Notion creation receipt; do not retry blindly");
let readback = call("read", pageId);
if (!matches.length || process.argv.includes("--refresh")) {
  refreshReview(call, pageId, String(artifacts.notion_checklist), path.join(dir, "notion-review-snapshot.json"), stagingDir);
  readback = call("read", pageId);
  if (!readback.includes(`Current Result ${result.plan.generated_at}`)) throw new Error("Notion updated-result readback failed");
}
if (!readback.includes(result.plan.request.fulfillment_request_id) || !readback.includes("Production readbacks")) throw new Error("Notion content readback failed");
result.artifacts.notion_review_url = url;
fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n");
fs.writeFileSync(path.join(dir, "notion-review.json"), JSON.stringify({ page_id: pageId, url, outcome: matches.length ? "reused" : "created", verified_at: new Date().toISOString() }, null, 2) + "\n");
const options = { auditLog: path.join(root, "boosted-box-heartbeat-audit.jsonl"), stateFile: path.join(root, "boosted-box-heartbeat-state.json") };
persistFulfillmentState(result, { ...options, apply: false });
persistFulfillmentState(result, { ...options, apply: true });
console.log(JSON.stringify({ request_id: result.plan.request.fulfillment_request_id, page_id: pageId, url, verified: true }));
