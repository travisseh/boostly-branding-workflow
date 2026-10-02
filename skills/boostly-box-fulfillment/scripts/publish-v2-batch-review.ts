#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseFulfillmentResult, type BatchReviewFailure } from "./fulfillment-artifacts.ts";
import { generateBatchReview } from "./generate-fulfillment-artifacts.ts";
import { refreshReview } from "./notion-review-refresh.ts";

const root = path.resolve(process.argv[2] ?? "");
const intake = JSON.parse(fs.readFileSync(path.join(root, "intake.json"), "utf8"));
type IntakeRequest = { request_id: string; location_name: string; canceled_at: string | null; order_type: string };
const requests: IntakeRequest[] = intake.requests.filter((row: IntakeRequest) => !row.canceled_at && row.order_type === "full_order");
const progressPath = path.join(root, "discovery-progress.json");
const progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, "utf8")) : [];
const failures: BatchReviewFailure[] = [];
const allowIncomplete = process.argv.includes("--allow-incomplete");
const results = requests.flatMap(row => {
  const resultPath = path.join(root, row.request_id, "fulfillment-result.json");
  if (!fs.existsSync(resultPath)) {
    const failure = progress.find((item: any) => item.id === row.request_id && item.status === "error" && item.error);
    if (!failure && !allowIncomplete) throw new Error(`Request has neither a final result nor a recorded discovery failure: ${row.request_id}`);
    failures.push({ request_id: row.request_id, location_name: row.location_name,
      reason: failure?.error ?? "Fresh discovery and production readback are incomplete in this recovery run. This is pending automation work, not a customer approval request. Preserve existing production data until verification completes." });
    return [];
  }
  const result = parseFulfillmentResult(JSON.parse(fs.readFileSync(resultPath, "utf8")));
  if (result.plan.request.fulfillment_request_id !== row.request_id || result.plan.write_policy !== "links_only") throw new Error("Batch result identity/scope mismatch");
  return [result];
});
const reviewCount = failures.length + results.filter(result => result.plan.links.some(link => link.action === "hold") || result.operational_blockers?.length || result.execution.some(record => ["held", "error"].includes(record.outcome))).length;
if (!reviewCount) {
  console.log(JSON.stringify({ requests: results.length, requires_review: 0, url: null }));
} else {
  const body = generateBatchReview(results, failures);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const marker = `Review Snapshot ${digest.slice(0, 16)}`;
  const title = `Fulfillment Link Review - ${path.basename(root)}`;
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ dry_run: true, requests: requests.length, validated_results: results.length, incomplete_discovery: failures.length, requires_review: reviewCount, title, digest }));
  } else {
    const wrapper = process.env.NOTION_WRAPPER || `${process.env.HOME}/.config/notion-tools/notion-ai-ntn.sh`;
    const call = (...args: string[]) => execFileSync(wrapper, ["--workspace", "boostly", ...args], { encoding: "utf8", timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "fulfillment-batch-review-"));
    process.on("exit", () => fs.rmSync(staging, { recursive: true, force: true }));
    const content = path.join(staging, "review.md");
    fs.writeFileSync(content, `${body}\n${marker}\n`, { mode: 0o600 });
    const found = JSON.parse(call("find-output", title));
    if (!Array.isArray(found.results) || found.has_more || found.results.length > 1) throw new Error("Ambiguous Notion review dedupe");
    let pageId: string;
    let url: string;
    if (found.results.length) {
      const page = found.results[0];
      if (page.properties?.Name?.title?.map((part: any) => part.plain_text ?? part.text?.content ?? "").join("") !== title) throw new Error("Notion title mismatch");
      pageId = page.id; url = page.url;
    } else {
      [pageId, url] = call("create", title, "research", `@${content}`).trim().split("\n");
    }
    if (!/^[a-f0-9-]{36}$/.test(pageId) || !/^https:\/\//.test(url)) throw new Error("Invalid Notion receipt; inspect before retrying");
    refreshReview(call, pageId, `${body}\n${marker}\n`, path.join(root, "batch-review-snapshot.json"), staging);
    const readback = call("read", pageId);
    if (!readback.includes(marker) || !readback.includes("Held links are not counted as successful writes")) throw new Error("Batch review readback failed");
    const receipt = { requests: requests.length, validated_results: results.length, incomplete_discovery: failures.length, requires_review: reviewCount, page_id: pageId, url, digest, verified_at: new Date().toISOString() };
    fs.writeFileSync(path.join(root, "batch-review.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  }
}
