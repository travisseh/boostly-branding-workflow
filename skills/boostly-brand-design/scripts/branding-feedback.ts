#!/usr/bin/env -S node --experimental-strip-types

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type Args = Record<string, string | boolean>;
type LedgerEvent = JsonObject & {
  schema_version: 1;
  event_id: string;
  event_type: string;
  case_id: string;
  occurred_at: string;
};

const DEFAULT_LEDGER =
  `${process.env.HOME}/.claude/skills/boostly-brand-design/feedback/branding-feedback.jsonl`;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "", ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return { command, args };
}

function stringArg(args: Args, key: string, required = false): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) fail(`--${key} is required`);
  return undefined;
}

function readJson(path: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${path} must contain a JSON object`);
    }
    return parsed as JsonObject;
  } catch (error) {
    fail(`cannot read JSON ${path}: ${(error as Error).message}`);
  }
}

function hashFile(path: string): string {
  if (!existsSync(path)) fail(`artifact does not exist: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifact(path: string | undefined): JsonObject | undefined {
  if (!path) return undefined;
  const absolutePath = resolve(path);
  return { path: absolutePath, sha256: hashFile(absolutePath) };
}

function artifactSha(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sha = (value as JsonObject).sha256;
  return typeof sha === "string" ? sha : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ledgerPath(args: Args): string {
  return resolve(
    stringArg(args, "ledger") ||
      process.env.BOOSTLY_BRANDING_FEEDBACK_FILE ||
      DEFAULT_LEDGER,
  );
}

function readLedger(path: string): LedgerEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch (error) {
        fail(`invalid JSON at ${path}:${index + 1}: ${(error as Error).message}`);
      }
    });
}

function appendEvent(path: string, event: LedgerEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function baseEvent(eventType: string, caseId: string): LedgerEvent {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    event_type: eventType,
    case_id: caseId,
    occurred_at: new Date().toISOString(),
  };
}

function requireCase(events: LedgerEvent[], caseId: string): void {
  if (!events.some((event) => event.case_id === caseId && event.event_type === "case_created")) {
    fail(`unknown case_id: ${caseId}`);
  }
}

function createdCase(events: LedgerEvent[], caseId: string): LedgerEvent {
  requireCase(events, caseId);
  return events.find(
    (event) => event.case_id === caseId && event.event_type === "case_created",
  )!;
}

function requireMatchingLocation(
  caseEvent: LedgerEvent,
  snapshot: JsonObject,
  artifactLabel: string,
): void {
  const expected = String(caseEvent.location_id || "").trim();
  const location = isJsonObject(snapshot.location) ? snapshot.location : undefined;
  const readback = isJsonObject(snapshot.readback) ? snapshot.readback : undefined;
  const readbackLocation =
    readback && isJsonObject(readback.location) ? readback.location : undefined;
  const actualIds = [
    snapshot.location_id,
    location?.id,
    readbackLocation?.id,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (actualIds.length === 0) {
    fail(`${artifactLabel} must include a verifiable location_id`);
  }
  const mismatch = actualIds.find((actual) => actual !== expected);
  if (mismatch) {
    fail(`${artifactLabel} location_id ${mismatch} does not match case location_id ${expected}`);
  }
}

function tags(value: string | undefined): string[] {
  return [...new Set((value || "").split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function createCase(args: Args, path: string, events: LedgerEvent[]): JsonObject {
  const manifestPath = resolve(stringArg(args, "manifest", true)!);
  const requestTs = stringArg(args, "request-ts", true)!;
  const runId = stringArg(args, "run-id") || dirname(manifestPath).split("/").pop() || "run";
  const manifest = readJson(manifestPath);
  const locationId = String(manifest.location_id || "").trim();
  if (!locationId) fail("manifest.location_id is required");
  const caseId =
    stringArg(args, "case-id") ||
    `brand_${createHash("sha256")
      .update(`${locationId}|${requestTs}|${runId}`)
      .digest("hex")
      .slice(0, 20)}`;
  const manifestArtifact = artifact(manifestPath)!;
  const proofArtifact = artifact(stringArg(args, "proof"));
  const existing = events.find(
    (event) => event.case_id === caseId && event.event_type === "case_created",
  );
  if (existing) {
    const existingArtifacts = existing.artifacts as JsonObject | undefined;
    const sameManifest =
      artifactSha(existingArtifacts?.manifest) === artifactSha(manifestArtifact);
    const sameProof = artifactSha(existingArtifacts?.proof) === artifactSha(proofArtifact);
    if (!sameManifest || !sameProof) {
      fail(
        `case_id ${caseId} already exists with different artifacts; use revise or a new run_id`,
      );
    }
    return { ok: true, idempotent: true, case_id: caseId, ledger: path };
  }

  const event: LedgerEvent = {
    ...baseEvent("case_created", caseId),
    request_ts: requestTs,
    run_id: runId,
    location_id: locationId,
    location_name: manifest.location_name || null,
    address: manifest.address || null,
    artifacts: {
      manifest: manifestArtifact,
      proof: proofArtifact,
    },
    generated_manifest: manifest,
  };
  appendEvent(path, event);
  return { ok: true, idempotent: false, case_id: caseId, ledger: path };
}

function recordFeedback(args: Args, path: string, events: LedgerEvent[]): JsonObject {
  const caseId = stringArg(args, "case-id", true)!;
  requireCase(events, caseId);
  const event: LedgerEvent = {
    ...baseEvent("feedback_recorded", caseId),
    reviewer: stringArg(args, "reviewer", true),
    feedback: stringArg(args, "feedback", true),
    tags: tags(stringArg(args, "tags")),
    source: stringArg(args, "source") || "manual",
    source_ref: stringArg(args, "source-ref") || null,
    notes: stringArg(args, "notes") || null,
  };
  appendEvent(path, event);
  return { ok: true, case_id: caseId, event_id: event.event_id };
}

function createRevision(args: Args, path: string, events: LedgerEvent[]): JsonObject {
  const caseId = stringArg(args, "case-id", true)!;
  const caseEvent = createdCase(events, caseId);
  const manifestPath = resolve(stringArg(args, "manifest", true)!);
  const manifest = readJson(manifestPath);
  requireMatchingLocation(caseEvent, manifest, "revision manifest");
  const event: LedgerEvent = {
    ...baseEvent("revision_created", caseId),
    actor: stringArg(args, "actor", true),
    reason: stringArg(args, "reason") || null,
    artifacts: {
      manifest: artifact(manifestPath),
      proof: artifact(stringArg(args, "proof")),
    },
    revised_manifest: manifest,
  };
  appendEvent(path, event);
  return { ok: true, case_id: caseId, event_id: event.event_id };
}

function approveCase(args: Args, path: string, events: LedgerEvent[]): JsonObject {
  const caseId = stringArg(args, "case-id", true)!;
  const caseEvent = createdCase(events, caseId);
  const readbackArg = stringArg(args, "production-readback");
  const readbackPath = readbackArg ? resolve(readbackArg) : undefined;
  const productionReadback = readbackPath ? readJson(readbackPath) : undefined;
  if (productionReadback) {
    requireMatchingLocation(caseEvent, productionReadback, "production readback");
  }
  const event: LedgerEvent = {
    ...baseEvent("approved", caseId),
    reviewer: stringArg(args, "reviewer", true),
    notes: stringArg(args, "notes") || null,
    production_readback_artifact: artifact(readbackPath),
    production_readback: productionReadback || null,
  };
  appendEvent(path, event);
  return { ok: true, case_id: caseId, event_id: event.event_id, status: "approved" };
}

function applyCase(args: Args, path: string, events: LedgerEvent[]): JsonObject {
  const caseId = stringArg(args, "case-id", true)!;
  const caseEvent = createdCase(events, caseId);
  const readbackPath = resolve(stringArg(args, "production-readback", true)!);
  const productionReadback = readJson(readbackPath);
  requireMatchingLocation(caseEvent, productionReadback, "production readback");
  const event: LedgerEvent = {
    ...baseEvent("production_applied", caseId),
    actor: stringArg(args, "actor", true),
    notes: stringArg(args, "notes") || null,
    production_readback_artifact: artifact(readbackPath),
    production_readback: productionReadback,
  };
  appendEvent(path, event);
  return {
    ok: true,
    case_id: caseId,
    event_id: event.event_id,
    status: "applied_pending_review",
  };
}

function rejectCase(args: Args, path: string, events: LedgerEvent[]): JsonObject {
  const caseId = stringArg(args, "case-id", true)!;
  requireCase(events, caseId);
  const event: LedgerEvent = {
    ...baseEvent("rejected", caseId),
    reviewer: stringArg(args, "reviewer", true),
    feedback: stringArg(args, "feedback", true),
    tags: tags(stringArg(args, "tags")),
    notes: stringArg(args, "notes") || null,
  };
  appendEvent(path, event);
  return { ok: true, case_id: caseId, event_id: event.event_id, status: "rejected" };
}

function exportCases(args: Args, events: LedgerEvent[]): JsonObject {
  const output = resolve(stringArg(args, "output", true)!);
  const grouped = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    const caseEvents = grouped.get(event.case_id) || [];
    caseEvents.push(event);
    grouped.set(event.case_id, caseEvents);
  }

  const rows = [...grouped.entries()]
    .map(([caseId, caseEvents]) => {
      const created = caseEvents.find((event) => event.event_type === "case_created");
      const feedback = caseEvents.filter((event) => event.event_type === "feedback_recorded");
      const revisions = caseEvents.filter((event) => event.event_type === "revision_created");
      const productionEvents = caseEvents.filter(
        (event) => event.event_type === "production_applied",
      );
      const dispositions = caseEvents.filter((event) =>
        ["approved", "rejected"].includes(event.event_type),
      );
      const finalDisposition = dispositions.at(-1) || null;
      return {
        schema_version: 1,
        case_id: caseId,
        created,
        feedback,
        revisions,
        production_events: productionEvents,
        final_disposition: finalDisposition,
      };
    })
    .filter((row) =>
      args["reviewed-only"]
        ? row.feedback.length > 0 || row.final_disposition !== null
        : true,
    );

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  return { ok: true, output, cases: rows.length };
}

function usage(): never {
  fail("usage: branding-feedback.ts <create|record|revise|apply|approve|reject|export> [options]");
}

const { command, args } = parseArgs(process.argv.slice(2));
const path = ledgerPath(args);
const events = readLedger(path);
let result: JsonObject;

switch (command) {
  case "create":
    result = createCase(args, path, events);
    break;
  case "record":
    result = recordFeedback(args, path, events);
    break;
  case "revise":
    result = createRevision(args, path, events);
    break;
  case "approve":
    result = approveCase(args, path, events);
    break;
  case "apply":
    result = applyCase(args, path, events);
    break;
  case "reject":
    result = rejectCase(args, path, events);
    break;
  case "export":
    result = exportCases(args, events);
    break;
  default:
    usage();
}

process.stdout.write(`${JSON.stringify(result)}\n`);
