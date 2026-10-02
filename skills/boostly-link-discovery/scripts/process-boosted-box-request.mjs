#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DISCOVER = path.join(DIR, "discover-links.mjs");
const SLACK_CLI = path.join(os.homedir(), ".config/slack-tools/slack.js");
const DEFAULT_RUN_ROOT = path.join(DIR, "..", "runs");
const DEFAULT_AUDIT_LOG = path.join(DEFAULT_RUN_ROOT, "boosted-box-write-audit.jsonl");
const AUTO_WRITE_LOCATION_FIELDS = new Set([
  "locations.ordering_url",
  "branding.instagram_url",
  "branding.facebook_url",
  "branding.tiktok_url",
  "branding.youtube_url",
  "branding.x_url"
]);
const AUTO_WRITE_TOUCHPOINT_CATEGORIES = new Set(["order", "menu", "events", "careers_jobs", "catering"]);
const FIRST_PARTY_TOUCHPOINT_CATEGORIES = new Set(["menu", "events", "careers_jobs", "catering"]);
const DESTINATION_SPECIFIC_TOUCHPOINT_CATEGORIES = new Set(["events", "catering"]);
const NEGATIVE_WRITE_EVIDENCE = /(?:^|\b)(?:404|410|page not found|not found|page isn['’]?t available|doesn['’]?t exist|unavailable|error page)(?:\b|$)|security_or_bot_challenge_detected=true|fetch_timeout_soft=true|http_status=(?:4\d\d|5\d\d)/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["channel-id"]) throw new Error("--channel-id is required");
  if (!args["message-ts"]) throw new Error("--message-ts is required");
  if (!args["location-id"]) throw new Error("--location-id is required for the pilot writer");
  if (args.apply) {
    throw new Error(
      "The legacy pilot processor is dry-run/replay-only. Build a validated fulfillment plan and apply it with boostly-box-fulfillment/scripts/execute-fulfillment-plan.ts so fill-only, locking, sequential saves, and readback gates cannot be bypassed.",
    );
  }
  const dryRun = true;

  const runId = args["run-id"] || makeRunId(args["message-ts"], args["location-id"]);
  const runDir = args["run-dir"] || path.join(DEFAULT_RUN_ROOT, runId);
  const auditLogPath = args["audit-log"] || DEFAULT_AUDIT_LOG;
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });

  const reportPath = path.join(runDir, "discovery-report.json");
  const thread = await fetchSlackThread(args["channel-id"], args["message-ts"]);
  const report = runDiscovery(args["location-id"], reportPath, args);
  const classified = classifyReport(report, {
    runId,
    channelId: args["channel-id"],
    messageTs: args["message-ts"],
    threadTs: thread.thread_ts || args["message-ts"],
    dryRun
  });

  const auditRows = [];
  for (const item of classified) {
    const row = baseAuditRow(item, report, {
      runId,
      channelId: args["channel-id"],
      messageTs: args["message-ts"],
      threadTs: thread.thread_ts || args["message-ts"],
      reportPath,
      dryRun
    });
    if (item.decision !== "write") {
      row.outcome = item.decision;
      row.skipped_reason = item.reason;
      auditRows.push(row);
      continue;
    }
    row.outcome = "dry_run_write";
    row.skipped_reason = "dry_run_default";
    auditRows.push(row);
  }

  appendAuditRows(auditLogPath, auditRows);
  const reply = buildSlackReply({ runId, auditRows, reportPath, dryRun });
  fs.writeFileSync(path.join(runDir, "slack-reply.txt"), reply);
  console.log(reply);

  const hadWriteError = auditRows.some((row) => row.outcome === "error");
  writeJson(path.join(runDir, "processor-summary.json"), {
    run_id: runId,
    dry_run: dryRun,
    report_path: reportPath,
    audit_log_path: auditLogPath,
    slack_reply_posted: false,
    counts: countOutcomes(auditRows),
    had_write_error: hadWriteError
  });
  if (hadWriteError) process.exitCode = 1;
}

function runDiscovery(locationId, reportPath, args) {
  const discoverArgs = [
    DISCOVER,
    "--location-id", locationId,
    "--out", reportPath,
    "--mode", "discovery+verify"
  ];
  if (args["discover-categories"]) discoverArgs.push("--discover-categories", args["discover-categories"]);
  if (args["search-provider"]) discoverArgs.push("--search-provider", args["search-provider"]);
  if (args["browser-provider"]) discoverArgs.push("--browser-provider", args["browser-provider"]);
  if (args["chrome-cdp-url"]) discoverArgs.push("--chrome-cdp-url", args["chrome-cdp-url"]);
  if (args["chrome-profile"]) discoverArgs.push("--chrome-profile", args["chrome-profile"]);
  if (args["cookie-file"]) discoverArgs.push("--cookie-file", args["cookie-file"]);
  discoverArgs.push("--skip-website-bootstrap");
  if (args["skip-schema-check"]) discoverArgs.push("--skip-schema-check");
  execFileSync(process.execPath, discoverArgs, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

async function fetchSlackThread(channelId, messageTs) {
  const res = spawnSync(process.execPath, [SLACK_CLI, "thread", "boostly", channelId, messageTs], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024
  });
  return {
    thread_ts: messageTs,
    fetched: res.status === 0,
    preview: (res.stdout || res.stderr || "").slice(0, 2000)
  };
}

function classifyReport(report, context) {
  const out = [];
  for (const item of report.proposed_location_updates || []) {
    const category = categoryFromLocationField(item.field_name);
    const decision = locationUpdateEligible(item) ? "write" : "skipped_allowlist";
    out.push({
      kind: "location_update",
      category,
      url: item.proposed_value,
      source_url: item.verification?.source_url || null,
      verification: item.verification || null,
      field_name: item.field_name,
      decision,
      reason: decision === "write" ? null : "location_field_not_allowlisted_or_not_verified",
      context
    });
  }
  for (const item of report.proposed_touchpoint_events || []) {
    const decision = touchpointEligible(item) ? "write" : "skipped_allowlist";
    out.push({
      kind: "touchpoint_event",
      category: item.touchpoint_category,
      url: item.url,
      source_url: item.verification?.source_url || null,
      verification: item.verification || null,
      touchpoint: item,
      decision,
      reason: decision === "write" ? null : "touchpoint_category_not_allowlisted_or_insufficient_write_gate",
      context
    });
  }
  for (const item of report.manual_review_items || []) {
    out.push({
      kind: "manual_review",
      category: item.category,
      url: item.candidate_url || null,
      source_url: null,
      verification: null,
      decision: "skipped_manual_review",
      reason: item.reason || "manual_review_required",
      context
    });
  }
  return out;
}

function locationUpdateEligible(item) {
  if (!AUTO_WRITE_LOCATION_FIELDS.has(item.field_name)) return false;
  if (!verifiedDestinationEligible(item.verification)) return false;
  if (item.current_value) return false;
  return true;
}

function touchpointEligible(item) {
  const category = item.touchpoint_category;
  const verification = item.verification;
  if (!AUTO_WRITE_TOUCHPOINT_CATEGORIES.has(category)) return false;
  if (!verifiedDestinationEligible(verification)) return false;
  if (FIRST_PARTY_TOUCHPOINT_CATEGORIES.has(category) && verification.source_type !== "website") return false;
  if (DESTINATION_SPECIFIC_TOUCHPOINT_CATEGORIES.has(category) && item.write_gate?.custom_destination_specific !== true) return false;
  if (category === "events" && (
    item.write_gate?.upcoming_event_evidence !== true ||
    verification.event_timing?.has_upcoming_event !== true ||
    !verification.event_timing?.upcoming_event_dates?.length
  )) return false;
  return true;
}

function verifiedDestinationEligible(verification) {
  return verification?.status === "verified" &&
    verification.liveness === "live" &&
    verification.relevance === "match" &&
    !hasNegativeWriteEvidence(verification);
}

function hasNegativeWriteEvidence(verification) {
  const evidence = [
    ...asArray(verification?.validity_evidence),
    ...asArray(verification?.location_match_evidence),
    verification?.rejection_reason,
  ].filter(Boolean).join(" ");
  return NEGATIVE_WRITE_EVIDENCE.test(evidence);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function baseAuditRow(item, report, context) {
  const verification = item.verification || {};
  return {
    run_id: context.runId,
    checked_at: new Date().toISOString(),
    dry_run: context.dryRun,
    slack_channel_id: context.channelId,
    slack_message_ts: context.messageTs,
    slack_thread_ts: context.threadTs,
    location_id: report.location_context?.location_id || null,
    account_id: report.location_context?.account_id || null,
    location_name: report.location_context?.location_name || null,
    category: item.category,
    target_type: item.kind,
    field_name: item.field_name || null,
    url: item.url,
    source_url: item.source_url,
    verifier_status: verification.status || null,
    verifier_evidence: evidenceSummary(verification),
    action: item.decision,
    outcome: null,
    skipped_reason: item.reason || null,
    previous_value: null,
    written_record_id: null,
    report_path: context.reportPath
  };
}

function evidenceSummary(verification) {
  return {
    source_evidence: (verification.source_evidence || []).slice(0, 6),
    validity_evidence: (verification.validity_evidence || []).slice(0, 6),
    location_match_evidence: (verification.location_match_evidence || []).slice(0, 6),
    write_gate: verification.write_gate || null
  };
}

function buildSlackReply({ runId, auditRows, reportPath, dryRun }) {
  const counts = countOutcomes(auditRows);
  const written = auditRows.filter((row) => row.outcome === "written" || row.outcome === "dry_run_write");
  const held = auditRows.filter((row) => row.outcome?.startsWith("skipped") || row.outcome === "skipped_allowlist");
  const errors = auditRows.filter((row) => row.outcome === "error");
  const prefix = dryRun ? "*DRY RUN* " : "";
  const lines = [
    `${prefix}Boostly link discovery finished. Added ${counts.written || 0}, held ${held.length}, errors ${errors.length}.`,
    `Run: ${runId}`
  ];
  if (written.length) {
    lines.push(`Added${dryRun ? " if applied" : ""}: ${written.map((row) => `${row.category} <${row.url}|${shortUrl(row.url)}>`).join(", ")}`);
  }
  if (held.length) {
    lines.push(`Held for review: ${held.slice(0, 8).map((row) => `${row.category}${row.url ? ` <${row.url}|${shortUrl(row.url)}>` : ""}`).join(", ")}`);
  }
  if (errors.length) {
    lines.push(`Errors: ${errors.map((row) => `${row.category}: ${row.error}`).join("; ")}`);
  }
  lines.push(`Report: ${reportPath}`);
  return lines.join("\n");
}

function countOutcomes(rows) {
  return rows.reduce((acc, row) => {
    acc[row.outcome] = (acc[row.outcome] || 0) + 1;
    if (row.outcome === "dry_run_write") acc.written = (acc.written || 0) + 1;
    return acc;
  }, {});
}

function appendAuditRows(auditLogPath, rows) {
  if (!rows.length) return;
  fs.appendFileSync(auditLogPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function categoryFromLocationField(field) {
  return {
    "locations.ordering_url": "ordering",
    "branding.instagram_url": "instagram",
    "branding.facebook_url": "facebook",
    "branding.tiktok_url": "tiktok",
    "branding.youtube_url": "youtube",
    "branding.x_url": "x_twitter"
  }[field] || field;
}

function makeRunId(messageTs, locationId) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const digest = crypto.createHash("sha1").update(`${messageTs}:${locationId}:${stamp}`).digest("hex").slice(0, 8);
  return `boosted_box_${stamp}_${digest}`;
}

function shortUrl(value) {
  try {
    const u = new URL(value);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 60);
  } catch {
    return String(value || "").slice(0, 60);
  }
}

function safeError(error) {
  return String(error?.message || error || "").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://<redacted>");
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else out[key] = next, i++;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(safeError(error));
    process.exit(1);
  });
}

export { touchpointEligible };
