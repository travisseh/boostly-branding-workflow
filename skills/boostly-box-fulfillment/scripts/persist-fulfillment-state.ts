#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAuditRows, buildStatePatch, parseFulfillmentResult, type FulfillmentResult } from "./fulfillment-artifacts.ts";
import { asObject, fulfillmentResultFromRun, readRun, setBlock } from "./run-file.ts";

type JsonObject = Record<string, unknown>;

export function persistFulfillmentState(
  result: FulfillmentResult,
  options: { auditLog: string; stateFile: string; apply: boolean },
): JsonObject {
  result = parseFulfillmentResult(result);
  const patch = buildStatePatch(result);
  if (!patch.execution_concluded) {
    throw new Error("Refusing state update because the plan did not complete with applied/skipped/held readbacks");
  }
  const auditRows = buildAuditRows(result);
  const current = readState(options.stateFile);
  const next = applyAdditiveStatePatch(current, patch);
  const preview = {
    applied: options.apply,
    audit_rows: auditRows.length,
    request_key: patch.add_processed_request_key,
    badge_request_id: patch.add_processed_badge_request_id,
    state: next,
  };
  if (!options.apply) return preview;

  fs.mkdirSync(path.dirname(options.auditLog), { recursive: true });
  fs.mkdirSync(path.dirname(options.stateFile), { recursive: true });
  const lockPath = `${options.stateFile}.lock`;
  let lock: number | null = null;
  let appliedPreview = preview;
  try {
    lock = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), plan_id: result.plan.plan_id })}\n`);
    const lockedState = readState(options.stateFile);
    const lockedNext = applyAdditiveStatePatch(lockedState, patch);
    const existingAuditKeys = readAuditKeys(options.auditLog);
    const newAuditRows = auditRows.filter((row) => !existingAuditKeys.has(auditKey(row)));
    if (newAuditRows.length) {
      fs.appendFileSync(options.auditLog, `${newAuditRows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
    }
    const temp = `${options.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(lockedNext, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, options.stateFile);
    appliedPreview = { ...preview, audit_rows: newAuditRows.length, state: lockedNext };
  } finally {
    if (lock !== null) {
      fs.closeSync(lock);
      try { fs.unlinkSync(lockPath); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  return appliedPreview;
}

function readAuditKeys(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  const keys = new Set<string>();
  for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!line) continue;
    try { keys.add(auditKey(JSON.parse(line) as JsonObject)); } catch {
      throw new Error(`Invalid audit JSON at ${file}:${index + 1}`);
    }
  }
  return keys;
}

function auditKey(row: JsonObject): string {
  return [row.run_id, row.event, row.category ?? "", row.idempotency_key].join("|");
}

function readState(file: string): JsonObject {
  if (!fs.existsSync(file)) return { initialized: true, processed_request_keys: [], processed_badge_request_ids: [], processed_message_ts: [] };
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Heartbeat state must be a JSON object");
  return value as JsonObject;
}

function applyAdditiveStatePatch(state: JsonObject, patch: JsonObject): JsonObject {
  const next = structuredClone(state);
  addUnique(next, "processed_request_keys", patch.add_processed_request_key);
  addUnique(next, "processed_fulfillment_request_ids", patch.add_processed_fulfillment_request_id);
  if (typeof patch.fulfillment_request_id === "string" && patch.fulfillment_request_outcome) {
    const outcomes = next.fulfillment_request_outcomes != null && typeof next.fulfillment_request_outcomes === "object" ? next.fulfillment_request_outcomes as JsonObject : {};
    next.fulfillment_request_outcomes = { ...outcomes, [patch.fulfillment_request_id]: patch.fulfillment_request_outcome };
    if ((patch.fulfillment_request_outcome as JsonObject).status !== "completed") {
      const id = patch.fulfillment_request_id;
      next.processed_fulfillment_request_ids = (Array.isArray(next.processed_fulfillment_request_ids) ? next.processed_fulfillment_request_ids : []).filter(value => value !== id);
      next.processed_request_keys = (Array.isArray(next.processed_request_keys) ? next.processed_request_keys : []).filter(value => value !== `v2:${id}`);
    }
  }
  addUnique(next, "processed_badge_request_ids", patch.add_processed_badge_request_id);
  addUnique(next, "processed_message_ts", patch.add_processed_message_ts);
  next.last_processed_ts = laterSlackTimestamp(state.last_processed_ts, patch.last_processed_ts);
  next.last_checked_at = patch.last_checked_at;
  next.last_run = patch.last_run;
  return next;
}

function laterSlackTimestamp(current: unknown, proposed: unknown): unknown {
  if (typeof current !== "string" || !current) return proposed;
  if (typeof proposed !== "string" || !proposed) return current;
  return Number(proposed) > Number(current) ? proposed : current;
}

function addUnique(state: JsonObject, field: string, value: unknown): void {
  if (typeof value !== "string" || !value) return;
  const existing = Array.isArray(state[field]) ? state[field] as unknown[] : [];
  state[field] = [...new Set([...existing.filter((item): item is string => typeof item === "string"), value])];
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = value;
      index += 1;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runDir = typeof args.run === "string" ? path.resolve(args.run) : null;
  if ((typeof args.input !== "string" && !runDir) || typeof args["audit-log"] !== "string" || typeof args["state-file"] !== "string") {
    throw new Error("Usage: (--input <fulfillment-result.json> | --run <run_dir>) --audit-log <audit.jsonl> --state-file <state.json> [--apply]");
  }
  // With --run the result is read from run.json: plan block, links block (execution), and the
  // artifacts derived from the notion/write/proofs/evidence blocks. --input still wins when given.
  const result = typeof args.input === "string"
    ? JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8")) as FulfillmentResult
    : fulfillmentResultFromRun(readRun(runDir as string)) as unknown as FulfillmentResult;
  const output = persistFulfillmentState(result, {
    auditLog: path.resolve(args["audit-log"]),
    stateFile: path.resolve(args["state-file"]),
    apply: args.apply === true,
  });
  if (runDir) {
    const auditRows = buildAuditRows(result);
    const existing = asObject(readRun(runDir).state);
    const receipt = {
      request_key: output.request_key ?? null,
      audit_row_ids: auditRows.map((row) => String(row.idempotency_key ?? "")).filter(Boolean),
      audit_log: path.resolve(args["audit-log"]),
      state_file: path.resolve(args["state-file"]),
      ...(args.apply === true
        ? { persisted_at: new Date().toISOString(), audit_rows_appended: output.audit_rows }
        : { last_dry_run_at: new Date().toISOString() }),
    };
    setBlock(runDir, "state", { ...existing, ...receipt }, { by: "persist-fulfillment-state" });
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
