#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFulfillmentPlan, type FulfillmentPlan } from "./fulfillment-plan.ts";

import { MESSAGE_ME } from "./paths.ts";

export type ReviewNotification = {
  category: string;
  url: string | null;
  reason: string;
};

export function reviewNotifications(plan: FulfillmentPlan): ReviewNotification[] {
  return plan.links
    .filter((link) => link.action === "hold" && isSecurityRetrievalBlock(link))
    .map((link) => ({ category: link.category, url: link.url, reason: link.reason }))
    .sort((a, b) => `${a.category}|${a.url}`.localeCompare(`${b.category}|${b.url}`));
}

export function reviewNotificationMessage(
  plan: FulfillmentPlan,
  blockers: ReviewNotification[],
): string {
  const lines = blockers.map((blocker) =>
    `- ${blocker.category}: ${blocker.url ?? "no stable URL"} (${blocker.reason})`
  );
  return [
    `Boosted Box link verification needs review: ${plan.location.location_name}`,
    `V2 location: ${plan.location.location_id}`,
    "A security challenge or retrieval timeout prevented destination verification. No affected link was written.",
    ...lines,
  ].join("\n");
}

function isSecurityRetrievalBlock(link: FulfillmentPlan["links"][number]): boolean {
  if (/challenge|timeout|security/i.test(link.reason)) return true;
  const evidence = JSON.stringify(link.verification ?? {});
  return /security_or_bot_challenge_detected|fetch_timeout_soft|cloudflare|captcha/i.test(evidence);
}

function receiptHash(plan: FulfillmentPlan, blockers: ReviewNotification[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ plan_id: plan.plan_id, blockers }))
    .digest("hex");
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) args[key] = true;
    else {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.plan !== "string" || typeof args.receipt !== "string") {
    throw new Error("Usage: --plan <fulfillment-plan.json> --receipt <notification-receipt.json> [--notify]");
  }
  const plan = parseFulfillmentPlan(JSON.parse(fs.readFileSync(path.resolve(args.plan), "utf8")));
  const blockers = reviewNotifications(plan);
  const hash = receiptHash(plan, blockers);
  const receiptPath = path.resolve(args.receipt);
  const prior = readReceipt(receiptPath);
  if (!blockers.length) {
    process.stdout.write(`${JSON.stringify({ outcome: "noop", blocker_count: 0 })}\n`);
    return;
  }
  if (prior?.hash === hash && prior?.outcome === "sent") {
    process.stdout.write(`${JSON.stringify({ outcome: "already_sent", blocker_count: blockers.length })}\n`);
    return;
  }
  if (args.notify !== true) {
    process.stdout.write(`${JSON.stringify({ outcome: "dry_run", blocker_count: blockers.length, blockers })}\n`);
    return;
  }
  const message = reviewNotificationMessage(plan, blockers);
  const result = spawnSync("python3", [MESSAGE_ME, "-"], { input: message, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Failed to text fulfillment review blocker").trim());
  }
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify({ outcome: "sent", hash, sent_at: new Date().toISOString(), blockers }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outcome: "sent", blocker_count: blockers.length })}\n`);
}

function readReceipt(receiptPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(receiptPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
