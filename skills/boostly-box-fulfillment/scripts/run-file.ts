#!/usr/bin/env node
// run-file.ts: the one run file per location (run.json) that every pipeline stage reads and
// writes. Notion, Slack, Figma, proofs, and the review ledger render from it; nothing is retyped
// from prose. Schema: ../references/run-schema.json (block names fixed, block contents open).
//
//   run-file init --request <json> --dir <run_dir> [--run-id <id>]
//   run-file set <run_dir> <block> --from <json-file> [--force --reason "<why>"] [--by <who>]
//   run-file get <run_dir> [block] [--path a.b.c]
//   run-file validate <run_dir>
//   run-file migrate <run_dir> [--force]        build run.json from manifest.json/STATE/ledger/receipts (lossless)
//   run-file select <run_dir> <letter> --by <who> [--reason "<why>"]      record the chosen variant letter
//   run-file override <run_dir> --gate <g> --asset <a> --decided-by <who> --reason "<why>"   append an override record
//       (refused when gates.json marks the gate override_allowed=false; overrides never change a rule)
//
// Rules enforced here:
// - a block is validated against its schema before it lands;
// - a block that other blocks already depend on is not overwritten without --force plus a reason
//   (the force is itself recorded under state.forces);
// - `overrides` is append-only: set appends, nothing replaces or deletes an entry;
// - `decision` is only ever the parsed decision file; this library never edits its six keys.
// No dependencies beyond node. Run with: node --experimental-strip-types run-file.ts ...

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type JsonObject = Record<string, unknown>;
export type RunFile = JsonObject & {
  schema_version: 1;
  run_id: string;
  run_dir?: string;
  created_at: string;
  updated_at?: string;
  request: JsonObject;
  state: JsonObject;
  overrides?: JsonObject[];
  legacy?: JsonObject;
};

export const RUN_FILE_NAME = "run.json";
export const DECISION_FILE_NAME = "decision.json";
export const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "references", "run-schema.json");

/** Block -> the blocks that are built from it. Overwriting a block with live dependents needs --force. */
export const DEPENDENTS: Record<string, string[]> = {
  request: ["plan", "links", "evidence", "decision", "variants", "gates", "write", "proofs"],
  plan: ["links", "write", "proofs"],
  links: [],
  evidence: ["decision", "variants", "gates", "write", "proofs"],
  decision: ["variants", "gates", "write", "proofs"],
  variants: ["gates", "write", "proofs"],
  gates: ["write", "proofs"],
  write: ["proofs"],
  proofs: [],
  figma: [],
  signage: [],
  notion: [],
  slack: [],
  state: [],
  legacy: [],
  taste: [],
};
export const BLOCKS = [
  "request", "plan", "links", "evidence", "decision", "variants", "gates", "overrides",
  "write", "proofs", "figma", "signage", "notion", "slack", "state", "legacy", "taste",
] as const;
export type BlockName = typeof BLOCKS[number];

// ---------------------------------------------------------------------------------------------
// Minimal JSON Schema validator (the subset run-schema.json uses): type, const, enum, pattern,
// minimum/maximum, properties, required, additionalProperties, items.
// ---------------------------------------------------------------------------------------------

let schemaCache: JsonObject | null = null;
export function loadSchema(): JsonObject {
  if (!schemaCache) schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as JsonObject;
  return schemaCache;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

export function validateAgainst(schema: unknown, value: unknown, at = "$", errors: string[] = []): string[] {
  if (schema == null || typeof schema !== "object" || Array.isArray(schema)) return errors;
  const s = schema as JsonObject;
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) {
    errors.push(`${at}: must equal ${JSON.stringify(s.const)}`);
    return errors;
  }
  if (Array.isArray(s.enum) && !s.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: must be one of ${s.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return errors;
  }
  const actual = typeOf(value);
  if (s.type != null) {
    const expected = Array.isArray(s.type) ? (s.type as string[]) : [String(s.type)];
    if (!expected.some((type) => typeMatches(type, actual))) {
      errors.push(`${at}: expected ${expected.join("|")}, got ${actual}`);
      return errors;
    }
  }
  if (actual === "string") {
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(value as string)) {
      errors.push(`${at}: does not match ${s.pattern}`);
    }
  }
  if (actual === "number" || actual === "integer") {
    if (typeof s.minimum === "number" && (value as number) < s.minimum) errors.push(`${at}: below minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && (value as number) > s.maximum) errors.push(`${at}: above maximum ${s.maximum}`);
  }
  if (actual === "object") {
    const obj = value as JsonObject;
    const props = (s.properties ?? {}) as JsonObject;
    for (const key of (Array.isArray(s.required) ? s.required as string[] : [])) {
      if (!(key in obj)) errors.push(`${at}: missing required "${key}"`);
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key in props) validateAgainst(props[key], child, `${at}.${key}`, errors);
      else if (s.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
      else if (s.additionalProperties != null && typeof s.additionalProperties === "object") {
        validateAgainst(s.additionalProperties, child, `${at}.${key}`, errors);
      }
    }
  }
  if (actual === "array" && s.items != null) {
    (value as unknown[]).forEach((item, index) => validateAgainst(s.items, item, `${at}[${index}]`, errors));
  }
  return errors;
}

export function blockSchema(block: string): JsonObject {
  const props = loadSchema().properties as JsonObject;
  const schema = props[block];
  if (!schema) throw new Error(`Unknown block "${block}". Blocks: ${BLOCKS.join(", ")}`);
  return schema as JsonObject;
}

export function validateBlock(block: string, value: unknown): string[] {
  return validateAgainst(blockSchema(block), value, `$.${block}`);
}

export function validateRun(run: unknown): string[] {
  return validateAgainst(loadSchema(), run);
}

// ---------------------------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------------------------

export function runFilePath(runDir: string): string {
  return path.join(path.resolve(runDir), RUN_FILE_NAME);
}

export function runFileExists(runDir: string): boolean {
  return fs.existsSync(runFilePath(runDir));
}

export function readRun(runDir: string): RunFile {
  const file = runFilePath(runDir);
  if (!fs.existsSync(file)) throw new Error(`No ${RUN_FILE_NAME} in ${path.resolve(runDir)}; run "run-file init" or "run-file migrate" first`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as RunFile;
}

export function writeRun(runDir: string, run: RunFile): string {
  const file = runFilePath(runDir);
  const errors = validateRun(run);
  if (errors.length) throw new Error(`Refusing to write an invalid ${RUN_FILE_NAME}:\n  ${errors.join("\n  ")}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Library: init / set / get / select / override
// ---------------------------------------------------------------------------------------------

export function deriveRunId(runDir: string): string {
  const abs = path.resolve(runDir);
  const parent = path.basename(path.dirname(abs));
  const base = path.basename(abs);
  return /^runs-/.test(parent) ? `${parent}/${base}` : base;
}

export function initRun(options: { runDir: string; request: JsonObject; runId?: string; force?: boolean }): RunFile {
  const runDir = path.resolve(options.runDir);
  if (runFileExists(runDir) && !options.force) {
    throw new Error(`${runFilePath(runDir)} already exists; pass --force to re-init (the existing file is kept as run.json.bak)`);
  }
  const requestErrors = validateBlock("request", options.request);
  if (requestErrors.length) throw new Error(`Invalid request block:\n  ${requestErrors.join("\n  ")}`);
  const at = nowIso();
  const run: RunFile = {
    schema_version: 1,
    run_id: options.runId ?? deriveRunId(runDir),
    run_dir: runDir,
    created_at: at,
    updated_at: at,
    request: options.request,
    overrides: [],
    state: { cursor: "request", stages: { request: { written_at: at, by: "run-file init" } }, forces: [] },
  };
  if (runFileExists(runDir)) fs.copyFileSync(runFilePath(runDir), `${runFilePath(runDir)}.bak`);
  fs.mkdirSync(runDir, { recursive: true });
  writeRun(runDir, run);
  return run;
}

export type SetOptions = { force?: boolean; reason?: string; by?: string };

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as JsonObject).length > 0;
  return true;
}

/** Blocks that depend on `block` and already hold data in `run`. */
export function liveDependents(run: RunFile, block: string): string[] {
  return (DEPENDENTS[block] ?? []).filter((name) => isNonEmpty(run[name]));
}

export function setBlock(runDir: string, block: string, value: unknown, options: SetOptions = {}): RunFile {
  if (!BLOCKS.includes(block as BlockName)) throw new Error(`Unknown block "${block}". Blocks: ${BLOCKS.join(", ")}`);
  if (block === "legacy") throw new Error("The legacy block is written only by run-file migrate");
  const run = readRun(runDir);
  const at = nowIso();
  const state = asObject(run.state);
  const stages = asObject(state.stages);

  if (block === "overrides") {
    const incoming = Array.isArray(value) ? value : [value];
    const errors = validateBlock("overrides", incoming);
    if (errors.length) throw new Error(`Invalid override record(s):\n  ${errors.join("\n  ")}`);
    const existing = Array.isArray(run.overrides) ? run.overrides : [];
    run.overrides = [...existing, ...(incoming as JsonObject[])];
    stages.overrides = { written_at: at, by: options.by ?? null, count: run.overrides.length };
  } else {
    const errors = validateBlock(block, value);
    if (errors.length) throw new Error(`Invalid ${block} block:\n  ${errors.join("\n  ")}`);
    const dependents = liveDependents(run, block);
    const overwriting = isNonEmpty(run[block]);
    if (overwriting && dependents.length) {
      if (!options.force) {
        throw new Error(
          `Refusing to overwrite "${block}": ${dependents.join(", ")} already depend on it. ` +
          `Re-run those stages, or pass --force --reason "<why>" to record a forced rewrite.`,
        );
      }
      if (!options.reason || !options.reason.trim()) throw new Error("--force requires --reason");
      const forces = Array.isArray(state.forces) ? state.forces : [];
      forces.push({ block, at, by: options.by ?? null, reason: options.reason, dependents, previous_sha256: sha256Json(run[block]) });
      state.forces = forces;
    }
    if (block === "state") {
      // persist-fulfillment-state owns the receipts; run-file keeps cursor/stages/forces alongside them.
      const incoming = asObject(value);
      run.state = { ...state, ...incoming, cursor: state.cursor ?? null, stages, forces: state.forces ?? [] };
    } else {
      run[block] = value;
    }
    stages[block] = { written_at: at, by: options.by ?? null, ...(overwriting ? { overwrote: true } : {}) };
  }
  const nextState = asObject(run.state);
  nextState.stages = stages;
  nextState.cursor = block;
  run.state = nextState;
  run.updated_at = at;
  writeRun(runDir, run);
  return run;
}

export function getBlock(runDir: string, block?: string, dotPath?: string): unknown {
  const run = readRun(runDir);
  let value: unknown = block ? run[block] : run;
  if (block && !(block in run)) return undefined;
  if (dotPath) {
    for (const segment of dotPath.split(".")) {
      if (value == null || typeof value !== "object") return undefined;
      value = (value as JsonObject)[segment];
    }
  }
  return value;
}

export function selectLetter(runDir: string, letter: string, options: { by: string; reason?: string }): RunFile {
  const run = readRun(runDir);
  const variants = asObject(run.variants);
  if (!isNonEmpty(variants)) throw new Error("No variants block yet; render the variant sheet first");
  const cells = asObject(variants.cells);
  if (Object.keys(cells).length && !(letter in cells)) {
    throw new Error(`Letter "${letter}" is not a cell on the sheet (${Object.keys(cells).join(", ")})`);
  }
  const at = nowIso();
  const next = { ...variants, applied_letter: letter, selection: { letter, decided_by: options.by, reason: options.reason ?? null, at } };
  // Selection is the human choice and does not invalidate downstream work by itself.
  run.variants = next;
  const stages = asObject(asObject(run.state).stages);
  stages.variants = { ...(asObject(stages.variants)), selected_at: at, by: options.by };
  const fableDefault = typeof variants.fable_default_letter === "string" ? variants.fable_default_letter : null;
  if (fableDefault && fableDefault !== letter) {
    const existing = Array.isArray(run.overrides) ? run.overrides : [];
    run.overrides = [...existing, {
      gate: "fable_default_letter",
      asset: String(variants.sheet_json ?? variants.sheet_png ?? "variant-sheet"),
      decided_by: options.by,
      reason: options.reason ?? `picked ${letter} over Fable's ${fableDefault}`,
      at,
      from_letter: fableDefault,
      to_letter: letter,
    }];
  }
  run.updated_at = at;
  writeRun(runDir, run);
  return run;
}

// The gate registry (boostly-brand-design/references/gates.json) says which gates may be overridden.
// Recording is refused for a gate marked override_allowed=false: the only path there is a deliberate
// human edit of the registry. The registry is never written from here.
export const GATES_REGISTRY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "boostly-brand-design", "references", "gates.json");
export function gateRegistryEntry(gate: string, registryPath = GATES_REGISTRY_PATH): { id: string; override_allowed: boolean; override_allowed_verdicts?: string[]; override_allowed_for_shipped?: boolean } | null {
  if (!fs.existsSync(registryPath)) return null;
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { aliases?: Record<string, string>; gates?: Array<{ id: string; override_allowed: boolean; override_allowed_verdicts?: string[]; override_allowed_for_shipped?: boolean }> };
  const id = (registry.gates ?? []).some((entry) => entry.id === gate) ? gate : (registry.aliases ?? {})[gate] ?? null;
  return id ? (registry.gates ?? []).find((entry) => entry.id === id) ?? null : null;
}

/** Evidence that the run's asset is live in production: an applied write block or an apply receipt under fix/. */
export function runHasAppliedEvidence(runDir: string): boolean {
  const dir = path.resolve(runDir);
  if (runFileExists(dir) && asObject(readRun(dir).write).status === "applied") return true;
  const fix = path.join(dir, "fix");
  if (!fs.existsSync(fix)) return false;
  const walk = (current: string, level: number): boolean => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (level < 3 && walk(full, level + 1)) return true; }
      else if (/^apply.*\.json$/.test(entry.name)) return true;
    }
    return false;
  };
  return walk(fix, 0);
}

export function appendOverride(runDir: string, record: { gate: string; asset: string; decided_by: string; reason: string; at?: string } & JsonObject, options: { registryPath?: string; shipped?: boolean } = {}): RunFile {
  const entry = gateRegistryEntry(record.gate, options.registryPath);
  if (entry && !entry.override_allowed) {
    // The shipped path (gates.json rule override_allowed_for_shipped): only for an asset that is already live.
    if (!(options.shipped && entry.override_allowed_for_shipped)) {
      throw new Error(`Override refused: gate "${entry.id}" is not overridable (override_allowed=false in gates.json${entry.override_allowed_for_shipped ? "; on an asset that is already live, pass --shipped" : ""}). Rules change only by a deliberate edit of the registry followed by "gates replay"; an override never changes a rule.`);
    }
    if (!runHasAppliedEvidence(runDir)) {
      throw new Error(`Override refused: --shipped needs proof the asset is live (an applied write block in run.json or an apply receipt under fix/); ${path.resolve(runDir)} has neither.`);
    }
  }
  const assetPath = path.isAbsolute(record.asset) ? record.asset : path.join(path.resolve(runDir), record.asset);
  const assetSha = fs.existsSync(assetPath) && fs.statSync(assetPath).isFile() ? sha256File(assetPath) : null;
  const normalized = { ...record, gate: entry?.id ?? record.gate, ...(assetSha ? { asset_sha256: assetSha } : {}), ...(options.shipped ? { shipped_asset: true } : {}), at: record.at ?? nowIso() };
  return setBlock(runDir, "overrides", normalized, { by: record.decided_by });
}

// ---------------------------------------------------------------------------------------------
// Adapters used by the stage scripts
// ---------------------------------------------------------------------------------------------

/** The `request` block from a CanonicalRequest (list-branding-requests.ts output). */
export function requestBlockFromCanonical(request: JsonObject): JsonObject {
  const fields = asObject(request.fields);
  const candidates = Array.isArray(request.location_candidates) ? request.location_candidates as JsonObject[] : [];
  const target = candidates.find((candidate) => candidate.location_id === request.expected_location_id) ?? candidates[0] ?? {};
  return {
    source: "v2-db",
    request_id: String(request.fulfillment_request_id ?? ""),
    request_key: String(request.request_key ?? `v2:${String(request.fulfillment_request_id ?? "")}`),
    location_id: String(request.expected_location_id ?? target.location_id ?? ""),
    account_id: String(request.expected_account_id ?? target.account_id ?? ""),
    location_name: String(fields.location_name ?? target.location_name ?? ""),
    account_name: stringOrNull(fields.account_name ?? target.account_name),
    order_type: stringOrNull(request.order_type),
    status: stringOrNull(request.status),
    created_at: stringOrNull(request.created_at),
    offer_text: stringOrNull(fields.offer),
    offer_promotion_id: stringOrNull(request.offer_promotion_id),
    onboarding_session_id: stringOrNull(request.onboarding_session_id),
    slack_thread_ts: firstTs(request.slack_thread_ts),
    slack_channel: null,
    csm: (request.csm as JsonObject | null) ?? null,
    requested_by: (request.requested_by as JsonObject | null) ?? null,
    quantities: asObject(request.quantities),
    quantities_source: "fulfillment_items",
    shipping: (request.shipping as JsonObject | null) ?? null,
    address: stringOrNull(target.address),
    website_url: stringOrNull(target.website_url),
    ordering_url: stringOrNull(target.ordering_url),
    google_place_id: stringOrNull(target.google_place_id),
    identity: {
      account_name: fields.account_name ?? null,
      location_name: fields.location_name ?? null,
      street_address: fields.street_address ?? null,
      city: fields.city ?? null,
      state: fields.state ?? null,
      postal_code: fields.postal_code ?? null,
    },
    location_candidates: candidates,
    account_locations: Array.isArray(request.account_locations) ? request.account_locations : [],
    canonical_request: request,
  };
}

/** A PreparationInput (prepare-fulfillment-plan.ts) assembled from run.json. */
export function preparationInputFromRun(run: RunFile, extras: { discovery_report: JsonObject; heartbeat_state?: JsonObject; write_policy?: "links_only"; run_dir?: string }): JsonObject {
  const request = run.request;
  const canonical = asObject(request.canonical_request);
  const identity = asObject(request.identity);
  const decision = asObject(run.decision);
  const evidence = asObject(run.evidence);
  const runDir = extras.run_dir ?? (typeof run.run_dir === "string" ? run.run_dir : process.cwd());
  const absolute = (value: unknown): string | undefined => {
    const text = stringOrNull(value);
    return text ? (path.isAbsolute(text) ? text : path.resolve(runDir, text)) : undefined;
  };
  const branding = isNonEmpty(decision)
    ? {
      // Conservative: a run.json decision never auto-promotes to "apply"; the write stage decides.
      status: "hold",
      flags: Array.isArray(decision.flags) ? decision.flags : [],
      confidence: decision.confidence,
      rationale: decision.rationale,
      evidence_packet: absolute(evidence.packet_path),
      evidence_fingerprint: evidence.evidence_fingerprint,
      fable_decision_path: absolute(decision.source_path),
      fable_decision_sha256: decision.decision_sha256,
      fable_output: sixKeys(decision),
    }
    : undefined;
  return {
    ...(extras.write_policy ? { write_policy: extras.write_policy } : {}),
    request: {
      request_key: request.request_key ?? `v2:${String(request.request_id)}`,
      canonical_thread_ts: canonical.canonical_thread_ts ?? request.slack_thread_ts ?? "",
      fulfillment_request_id: request.request_id,
      expected_location_id: request.location_id,
      fields: {
        account_name: identity.account_name ?? request.account_name ?? "",
        location_name: identity.location_name ?? request.location_name ?? "",
        street_address: identity.street_address ?? "",
        city: identity.city ?? "",
        state: identity.state ?? "",
        postal_code: identity.postal_code ?? "",
      },
      badge_quantity: canonical.badge_quantity ?? null,
      badge_quantity_status: canonical.badge_quantity_status ?? "missing",
    },
    location_candidates: Array.isArray(request.location_candidates) ? request.location_candidates : [],
    account_locations: Array.isArray(request.account_locations) ? request.account_locations : undefined,
    discovery_report: extras.discovery_report,
    ...(branding ? { branding } : {}),
    heartbeat_state: extras.heartbeat_state ?? {},
  };
}

export const SIX_KEYS = ["logo_choice", "palette", "composition", "confidence", "flags", "rationale"] as const;
export function sixKeys(decision: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of SIX_KEYS) out[key] = decision[key];
  return out;
}

/** The `decision` block: Fable's file parsed verbatim plus provenance. Never edits the six keys. */
export function decisionBlockFromFile(decisionFile: string, extras: { evidence_fingerprint?: string | null } = {}): JsonObject {
  const abs = path.resolve(decisionFile);
  const bytes = fs.readFileSync(abs);
  const parsed = JSON.parse(bytes.toString("utf8")) as JsonObject;
  return {
    ...sixKeys(parsed),
    decision_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    source_path: abs,
    validated_at: nowIso(),
    evidence_fingerprint: extras.evidence_fingerprint ?? null,
  };
}

/** The `evidence` block summarised from a branding-evidence.json packet. */
export function evidenceBlockFromPacket(packetPath: string): JsonObject {
  const abs = path.resolve(packetPath);
  const packet = JSON.parse(fs.readFileSync(abs, "utf8")) as JsonObject;
  const candidates = (Array.isArray(packet.logo_candidates) ? packet.logo_candidates : []).map((item) => {
    const candidate = asObject(item);
    return {
      local_path: String(candidate.local_path ?? ""),
      sha256: stringOrNull(candidate.sha256),
      provenance: stringOrNull(candidate.provenance),
      source: stringOrNull(candidate.source),
      width: numberOrNull(candidate.width),
      height: numberOrNull(candidate.height),
      format: stringOrNull(candidate.format),
      bytes: numberOrNull(candidate.bytes),
      measured_colors: candidate.measured_colors ?? null,
      sharpness: (candidate.sharpness as JsonObject | null) ?? null,
      mechanical_qa: candidate.mechanical_qa ?? null,
      rank_score: numberOrNull(candidate.rank_score),
    };
  });
  const website = asObject(packet.website);
  return {
    evidence_fingerprint: String(packet.evidence_fingerprint ?? ""),
    packet_path: abs,
    packet_sha256: sha256File(abs),
    generated_at: stringOrNull(packet.generated_at),
    schema_version: packet.schema_version ?? null,
    reuse: (packet.reuse as JsonObject | null) ?? null,
    location: (packet.location as JsonObject | null) ?? null,
    website: {
      url: stringOrNull(website.url ?? website.website_url),
      status: stringOrNull(website.status),
      visual_evidence: asObject(website.visual_evidence).status ?? null,
      authored_color_tokens: Array.isArray(website.authored_color_tokens) ? website.authored_color_tokens.slice(0, 12) : null,
    },
    brand_environment: asObject(packet.brand_environment).status ?? null,
    feedback_case: (packet.feedback_case as JsonObject | null) ?? null,
    production_branding: (packet.production_branding as JsonObject | null) ?? null,
    logo_candidates: candidates,
  };
}

/** The `variants` block from a variant-sheet.json manifest. Paths relative to the run dir when inside it. */
export function variantsBlockFromSheet(sheetJsonPath: string, runDir: string, extras: { fable_default_letter?: string | null } = {}): JsonObject {
  const abs = path.resolve(sheetJsonPath);
  const sheet = JSON.parse(fs.readFileSync(abs, "utf8")) as JsonObject;
  const rel = (value: unknown): string | null => {
    const text = stringOrNull(value);
    if (!text) return null;
    const resolved = path.isAbsolute(text) ? text : path.resolve(path.dirname(abs), text);
    const relative = path.relative(path.resolve(runDir), resolved);
    if (relative && !relative.startsWith("..")) return relative;
    // A copied run dir (or a sibling alias like "reston/fix/..."): re-root on this run dir's basename.
    const marker = `/${path.basename(path.resolve(runDir))}/`;
    const index = text.indexOf(marker);
    if (index >= 0) {
      const tail = text.slice(index + marker.length);
      if (fs.existsSync(path.join(path.resolve(runDir), tail))) return tail;
    }
    return text;
  };
  const cells: JsonObject = {};
  for (const [letter, value] of Object.entries(asObject(sheet.cells))) {
    const cell = asObject(value);
    cells[letter] = {
      letter,
      row: cell.row ?? null,
      row_label: cell.row_label ?? null,
      logo: rel(cell.logo),
      primary: cell.primary ?? null,
      secondary: cell.secondary ?? null,
      secondary_source: cell.secondary_source ?? null,
      text: cell.text ?? null,
      print_text_secondary: cell.print_text_secondary ?? null,
      badge_digit_web: cell.badge_digit_web ?? null,
      badge_digit_print: cell.badge_digit_print ?? null,
      row_gates: cell.row_gates ?? null,
      card: rel(cell.card ?? cell.card_png),
    };
  }
  const sheetPng = rel(sheet.sheet) ?? rel(path.join(path.dirname(abs), "variant-sheet.png"));
  // variant-sheet.mjs writes chosen_secondary as a hex string; older sheets carry {hex, source}.
  const chosenSecondary = typeof sheet.chosen_secondary === "string" ? { hex: sheet.chosen_secondary } : asObject(sheet.chosen_secondary);
  const fableDefault = extras.fable_default_letter ?? (() => {
    // Fable's default is the cell in the first row whose secondary is the chosen (Fable) secondary.
    const chosenHex = stringOrNull(chosenSecondary.hex)?.toUpperCase();
    const firstRow = stringOrNull(asObject((sheet.rows as unknown[] | undefined)?.[0]).key);
    const hit = Object.values(cells).map(asObject).find((cell) => cell.row === firstRow && String(cell.secondary ?? "").toUpperCase() === chosenHex);
    return hit ? String(hit.letter) : null;
  })();
  return {
    sheet_png: sheetPng,
    sheet_json: rel(abs),
    sheets: [{ png: sheetPng, json: rel(abs), label: path.basename(sheetPng ?? "variant-sheet.png") }],
    generated_at: stringOrNull(sheet.generated_at),
    business_name: stringOrNull(sheet.business_name),
    decision_file: rel(sheet.decision),
    primary: stringOrNull(sheet.primary),
    text: stringOrNull(sheet.text),
    chosen_secondary: stringOrNull(chosenSecondary.hex),
    rows: Array.isArray(sheet.rows) ? sheet.rows.map((row) => ({ ...asObject(row), logo: rel(asObject(row).logo) })) : [],
    columns: Array.isArray(sheet.columns) ? sheet.columns : [],
    contract: stringOrNull(sheet.contract),
    fable_default_letter: fableDefault,
    applied_letter: null,
    selection: null,
    cells,
  };
}

/** A FulfillmentResult (persist-fulfillment-state / generate-fulfillment-artifacts input) from run.json. */
export function fulfillmentResultFromRun(run: RunFile, artifactsOverride?: JsonObject): JsonObject {
  const planBlock = asObject(run.plan);
  const plan = asObject(planBlock.plan);
  if (planBlock.status !== "ready" || !isNonEmpty(plan)) {
    throw new Error("run.json has no ready plan block (prepare-fulfillment-plan --run first)");
  }
  const links = asObject(run.links);
  const execution = Array.isArray(links.execution) ? links.execution : [];
  const notion = asObject(run.notion);
  const write = asObject(run.write);
  const proofs = asObject(run.proofs);
  const evidence = asObject(run.evidence);
  const request = run.request;
  const pageId = stringOrNull(notion.page_id);
  const brandingStatus = String(asObject(plan.branding).status ?? "needs_fable");
  const brandingOutcome = write.status === "applied" ? "applied" : brandingStatus === "reuse" ? "reused" : "held";
  const caseId = stringOrNull(
    asObject(evidence.feedback_case).case_id
    ?? asObject(evidence.feedback_case).branding_case_id
    ?? asObject(asObject(run.legacy).manifest).feedback_case_id,
  );
  const artifacts: JsonObject = {
    boostly_account_url: `https://new.boostly.com/admin/accounts/${String(request.account_id)}`,
    official_website_url: stringOrNull(request.website_url) ?? stringOrNull(asObject(plan.location).website_url),
    ...(stringOrNull(request.website_url) ? {} : { official_website_reason: "no website on the request" }),
    notion_review_url: pageId ? `https://www.notion.so/${pageId.replace(/-/g, "")}` : null,
    ...(pageId ? {} : { notion_review_reason: "no notion block yet" }),
    link_tree_screenshot: "unavailable",
    link_tree_reason: "link-tree capture is a weekly QA step, not a per-run artifact",
    branding_proof_screenshot: asObject(proofs.validated).ok === true ? "attached" : "unavailable",
    ...(asObject(proofs.validated).ok === true ? {} : { branding_proof_reason: "no validated proof in run.json" }),
    branding_case_id: caseId,
    branding_outcome: brandingOutcome,
    branding_reason: stringOrNull(write.reason) ?? `write.status=${String(write.status ?? "not_written")}; plan.branding.status=${brandingStatus}`,
    ...(artifactsOverride ?? {}),
  };
  return { plan, execution, artifacts };
}

// ---------------------------------------------------------------------------------------------
// Migrate: build run.json from a pre-run.json run directory. Lossless: the whole manifest, ledger,
// hand-written plan, and STATE land under `legacy`; typed blocks carry what could be mapped.
// ---------------------------------------------------------------------------------------------

export function migrateRun(runDir: string, options: { force?: boolean } = {}): RunFile {
  const dir = path.resolve(runDir);
  if (runFileExists(dir) && !options.force) throw new Error(`${runFilePath(dir)} already exists; pass --force to rebuild it (kept as run.json.bak)`);
  const readJson = (rel: string): JsonObject | unknown[] | null => {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  };
  const readText = (rel: string): string | null => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : null);
  const exists = (rel: string): boolean => Boolean(rel) && fs.existsSync(path.join(dir, rel));
  const consumed: string[] = [];
  const take = <T>(rel: string, reader: (rel: string) => T): T => { const value = reader(rel); if (value != null) consumed.push(rel); return value; };

  const manifest = asObject(take("manifest.json", readJson));
  const requestRows = take("request.json", readJson);
  const fulfillmentItems = take("fulfillment-items.json", readJson);
  const accountLocations = take("account-locations.json", readJson);
  const ledger = take("ledger.json", readJson);
  const handPlan = take("fulfillment-plan.json", readJson);
  const discovery = take("link-discovery-report.json", readJson);
  const stateText = take("STATE.md", readText) ?? take("STATE", readText);
  const readback = asObject(take("production-readback.json", readJson));
  const mLocation = asObject(manifest.location);
  const mRequest = asObject(manifest.request);
  const requestRow = asObject(Array.isArray(requestRows) ? requestRows[0] : requestRows);

  // ---- request ----
  const locationId = stringOrNull(mLocation.location_id ?? manifest.location_id ?? requestRow.location_id ?? asObject(readback.location).id) ?? "";
  const accountId = stringOrNull(mLocation.account_id ?? manifest.account_id ?? requestRow.account_id ?? asObject(readback.account).id) ?? "";
  const locationName = stringOrNull(mLocation.name ?? manifest.location_name ?? requestRow.loc_name ?? asObject(readback.location).name) ?? "";
  const requestId = stringOrNull(mRequest.id ?? requestRow.id ?? (Array.isArray(fulfillmentItems) ? asObject(fulfillmentItems[0]).fulfillment_request_id : null)) ?? `unknown:${locationId}`;
  const address = stripNote(mLocation.address ?? manifest.address ?? null);
  const quantities = asObject(mRequest.quantities);
  const request: JsonObject = {
    source: "migrated:manifest",
    request_id: requestId,
    request_key: `v2:${requestId}`,
    location_id: locationId,
    account_id: accountId,
    location_name: locationName,
    account_name: stringOrNull(mLocation.account_name ?? requestRow.account_name ?? asObject(readback.account).name),
    order_type: stringOrNull(mRequest.order_type ?? requestRow.order_type),
    status: null,
    created_at: stringOrNull(mRequest.created_at ?? requestRow.created_at),
    offer_text: typeof mRequest.offer_text === "string" ? mRequest.offer_text : stringOrNull(requestRow.offer_text),
    offer_note: stringOrNull(mRequest.offer_note),
    offer_promotion_id: null,
    onboarding_session_id: stringOrNull(requestRow.onboarding_session_id) ?? firstToken(mRequest.onboarding_session),
    slack_thread_ts: firstTs(mRequest.slack_thread_ts ?? requestRow.slack_thread_ts ?? manifest.request_thread_ts),
    slack_channel: channelIn(mRequest.slack_thread_ts),
    csm: null,
    requested_by: null,
    quantities: {
      tap_cards: numberOrNull(quantities.tap_cards),
      tables: numberOrNull(quantities.tables),
      bathroom_stalls: numberOrNull(quantities.bathroom_stalls),
      signage: numberOrNull(quantities.pop ?? quantities.signage),
      to_go_rolls: numberOrNull(quantities.to_go ?? quantities.to_go_rolls),
      ...(quantities.wants_signage != null ? { wants_signage: quantities.wants_signage } : {}),
    },
    quantities_source: stringOrNull(mRequest.quantities_source),
    shipping: typeof mRequest.ship_to === "string" ? { note: mRequest.ship_to } : null,
    address,
    website_url: stripNote(mLocation.website ?? manifest.website_url ?? requestRow.website_url),
    ordering_url: stripNote(mLocation.ordering_url ?? requestRow.ordering_url),
    google_place_id: stringOrNull(mLocation.google_place_id ?? manifest.google_place_id ?? requestRow.google_place_id),
    timezone: stringOrNull(mLocation.timezone ?? requestRow.timezone),
    identity: identityFrom(locationName, address, stringOrNull(mLocation.account_name ?? requestRow.account_name ?? asObject(readback.account).name)),
    location_candidates: [],
    account_locations: Array.isArray(accountLocations) ? accountLocations.map((row) => candidateFromRow(asObject(row), accountId)) : [],
    canonical_request: null,
    items: Array.isArray(fulfillmentItems) ? fulfillmentItems : null,
    contact_note: stringOrNull(mRequest.contact),
    signup_keyword: stringOrNull(mRequest.signup_keyword),
  };
  request.location_candidates = [{
    location_id: locationId,
    location_name: locationName,
    location_status: firstToken(mLocation.status) ?? stringOrNull(requestRow.status) ?? "enabled",
    account_id: accountId,
    account_name: request.account_name ?? locationName,
    address: address ?? "",
    website_url: request.website_url,
    google_place_id: request.google_place_id,
    is_general: false,
  }];

  // ---- the applied update, live receipts dir ----
  const appliedKeys = Object.keys(manifest).filter((key) => /^applied_update/.test(key)).sort();
  const applied = asObject(appliedKeys.length ? manifest[appliedKeys[appliedKeys.length - 1]] : null);
  const branding = asObject(manifest.branding);
  const variantSpec = asObject(manifest.variant_sheet ?? branding.variant_sheet);
  const appliedLetter = stripNote(applied.cell_letter ?? variantSpec.applied_letter) ?? letterFromCellText(applied.cell);
  const liveDir = findLiveDir(dir, appliedLetter);
  const liveJson = (name: string): JsonObject | null => (liveDir ? asObject(readJson(path.join(liveDir, name))) : null);
  const liveRel = (name: string): string | null => (liveDir && exists(path.join(liveDir, name)) ? path.join(liveDir, name) : null);
  if (liveDir) consumed.push(`${liveDir}/`);

  // ---- evidence ----
  const packetRel = stringOrNull(asObject(manifest.evidence).packet) ?? "evidence/branding-evidence.json";
  const evidence = exists(packetRel) ? { ...evidenceBlockFromPacket(path.join(dir, packetRel)), packet_path: packetRel } : null;
  if (evidence) consumed.push(packetRel);

  // ---- decision ----
  const decisionRel = ["decision.json", stringOrNull(asObject(branding.fable_decision).path) ?? "", "fable-decision.json"].find((rel) => rel && exists(rel)) ?? null;
  let decision: JsonObject | null = null;
  if (decisionRel) {
    decision = { ...decisionBlockFromFile(path.join(dir, decisionRel), { evidence_fingerprint: evidence ? String(evidence.evidence_fingerprint) : null }), source_path: decisionRel, validated_at: null };
    const recordedSha = stringOrNull(asObject(branding.fable_decision).sha256);
    decision.manifest_sha256 = recordedSha;
    decision.manifest_sha256_matches = recordedSha ? recordedSha === decision.decision_sha256 : null;
    decision.validated_by_manifest = asObject(branding.fable_decision).validated ?? null;
    consumed.push(decisionRel);
  }

  // ---- variants ----
  let variants: JsonObject | null = null;
  {
    const sheets: JsonObject[] = [];
    const v1Png = stripNote(variantSpec.png);
    const v1Json = stripNote(variantSpec.json);
    const v2Png = stripNote(variantSpec.v2_png);
    const v2Json = stripNote(variantSpec.v2_json);
    if (v1Png && exists(v1Png)) sheets.push({ png: v1Png, json: v1Json && exists(v1Json) ? v1Json : null, label: "v1" });
    if (v2Png && exists(v2Png)) sheets.push({ png: v2Png, json: v2Json && exists(v2Json) ? v2Json : null, label: "v2" });
    const appliedSheet = stringOrNull(variantSpec.applied_sheet);
    const primarySheet = (appliedSheet === "v2" ? sheets.find((sheet) => sheet.label === "v2") : null) ?? sheets[0] ?? null;
    const primaryJson = primarySheet && typeof primarySheet.json === "string" ? primarySheet.json : null;
    if (primaryJson) {
      variants = variantsBlockFromSheet(path.join(dir, primaryJson), dir, { fable_default_letter: stripNote(variantSpec.fable_default_letter) });
      variants.sheet_png = primarySheet!.png;
      variants.sheets = sheets;
      consumed.push(primaryJson);
    } else if (sheets.length) {
      variants = { sheet_png: primarySheet!.png, sheet_json: null, sheets, cells: {}, fable_default_letter: stripNote(variantSpec.fable_default_letter), applied_letter: null, selection: null };
    }
    if (variants) {
      variants.applied_sheet = appliedSheet;
      variants.applied_letter = appliedLetter;
      variants.note = stringOrNull(variantSpec.note);
      if (appliedLetter) {
        variants.selection = {
          letter: appliedLetter,
          decided_by: pickerFrom(applied.decision) ?? "unknown",
          reason: stringOrNull(applied.decision),
          at: dateFrom(appliedKeys[appliedKeys.length - 1]) ?? stringOrNull(manifest.generated_at) ?? "unknown",
          source: "migrated:manifest",
        };
      }
    }
  }

  // ---- gates ----
  const gateResults: JsonObject[] = [];
  const logoFileRaw = stripNote(applied.logo_file);
  const logoFileRel = resolveLoose(dir, logoFileRaw);
  if (liveDir) {
    for (const name of fs.readdirSync(path.join(dir, liveDir)).filter((file) => /^gate-.*\.json$/.test(file)).sort()) {
      const result = asObject(readJson(path.join(liveDir, name)));
      if (!isNonEmpty(result)) continue;
      gateResults.push({
        gate: name.replace(/^gate-/, "").replace(/\.json$/, ""),
        asset: logoFileRel ?? logoFileRaw ?? "unknown",
        pass: typeof result.pass === "boolean" ? result.pass : result.verdict === "ok",
        verdict: stringOrNull(result.verdict),
        file: path.join(liveDir, name),
        result,
        at: null,
        source: "live_receipts",
      });
    }
  }
  for (const [gate, text] of Object.entries(asObject(applied.gates))) {
    if (gate === "files" || typeof text !== "string") continue;
    gateResults.push({ gate, asset: logoFileRel ?? logoFileRaw ?? "unknown", pass: !/\bFAIL\b/i.test(text), verdict: text, file: null, result: text, at: null, source: "manifest" });
  }
  const gates = gateResults.length ? { results: gateResults, files_note: stringOrNull(asObject(applied.gates).files), proposal_gates: branding.gates ?? null } : null;

  // ---- overrides ----
  const overrides: JsonObject[] = [];
  const gateOverride = asObject(applied.gate_override);
  const appliedAt = dateFrom(appliedKeys[appliedKeys.length - 1]) ?? stringOrNull(gateOverride.date);
  if (isNonEmpty(gateOverride)) {
    const failed = Array.isArray(gateOverride.gates_failed) ? gateOverride.gates_failed.map(String) : ["unspecified"];
    for (const gate of failed) {
      overrides.push({
        gate,
        asset: logoFileRel ?? logoFileRaw ?? "unknown",
        decided_by: stringOrNull(gateOverride.approved_by) ?? "unknown",
        reason: stringOrNull(gateOverride.reason) ?? "(no reason recorded)",
        at: stringOrNull(gateOverride.date) ?? appliedAt ?? "unknown",
        source: "migrated:manifest",
      });
    }
  }
  const fableDefault = variants ? stringOrNull(variants.fable_default_letter) : null;
  if (appliedLetter && fableDefault && appliedLetter !== fableDefault) {
    overrides.push({
      gate: "fable_default_letter",
      asset: String(variants?.sheet_json ?? variants?.sheet_png ?? "variant-sheet"),
      decided_by: pickerFrom(applied.decision) ?? stringOrNull(gateOverride.approved_by) ?? "unknown",
      reason: stringOrNull(applied.decision) ?? `picked ${appliedLetter} over Fable's ${fableDefault}`,
      at: appliedAt ?? "unknown",
      from_letter: fableDefault,
      to_letter: appliedLetter,
      source: "migrated:manifest",
    });
  }

  // ---- write ----
  // The apply receipt is the primary evidence of a production write: any fix/**/apply*.json whose
  // readback carries logo_attachment_id marks the run applied, whatever the manifest says.
  const proofBranding = liveJson("proof-branding.json");
  const cdnLogo = liveRel("cdn-logo.png");
  const applyReceipt = findApplyReceipt(dir, liveDir);
  const receiptEffective = applyReceipt ? applyReceipt.effective : {};
  const productionEffective = asObject(readback.effective_branding);
  let write: JsonObject | null = null;
  if (applyReceipt || isNonEmpty(applied) || /applied/i.test(String(branding.status ?? ""))) {
    const colorsAfter = asObject(applied.colors_after);
    // production-readback.json wins over the receipt when it carries the field.
    const logoAttachmentId = stringOrNull(productionEffective.logo_attachment_id)
      ?? stringOrNull(receiptEffective.logo_attachment_id)
      ?? stringOrNull(applied.logo_attachment_id);
    const logoFilename = stringOrNull(productionEffective.logo_filename) ?? stringOrNull(receiptEffective.logo_filename);
    const receiptDir = applyReceipt ? path.dirname(applyReceipt.path) : liveDir;
    const downloadedCopy = receiptDir
      ? ["applied-logo.png", "cdn-logo.png"].map((name) => path.join(receiptDir, name)).find((rel) => exists(rel)) ?? null
      : null;
    const logoFromReceipt = logoFilename ? (downloadedCopy ?? findFileByBasename(dir, logoFilename)) : null;
    const logoFile = logoFromReceipt ?? logoFileRel ?? logoFileRaw;
    const logoSha = logoFromReceipt
      ? sha256File(path.join(dir, logoFromReceipt))
      : (stringOrNull(asObject(proofBranding).logo_sha256)
        ?? (cdnLogo ? sha256File(path.join(dir, cdnLogo)) : null)
        ?? (logoFileRel ? sha256File(path.join(dir, logoFileRel)) : null));
    const receipt = (name: string): JsonObject | null => {
      const rel = liveRel(name);
      return rel ? { path: rel, sha256: sha256File(path.join(dir, rel)) } : null;
    };
    const applyRel = applyReceipt ? applyReceipt.path : liveRel("apply.json");
    write = {
      status: "applied",
      source: applyReceipt ? "migrated:apply_receipt" : "migrated:manifest",
      scope: stringOrNull(applyReceipt?.selected_scope) ?? firstToken(applied.scope ?? branding.scope)?.toLowerCase() ?? null,
      scope_note: stringOrNull(applied.scope ?? branding.scope),
      applied_at: appliedAt,
      colors_after: isNonEmpty(colorsAfter) ? colorsAfter
        : (productionEffective.web_primary_color ? pickColors(productionEffective)
          : (receiptEffective.web_primary_color ? pickColors(receiptEffective) : null)),
      logo_file: logoFile,
      logo_filename: logoFilename,
      logo_file_manifest: logoFileRaw,
      logo_file_resolved: logoFileRel,
      logo_sha256: logoSha,
      logo_attachment_id: logoAttachmentId,
      gate_override: isNonEmpty(gateOverride),
      wizard_overwrite_risk: applied.wizard_overwrite_risk ?? manifest.wizard_overwrite_risk ?? null,
      receipts: {
        readback_before: receipt("readback-before.json") ?? receipt("before.json"),
        dry: receipt("dry.json"),
        apply: applyRel ? { path: applyRel, sha256: sha256File(path.join(dir, applyRel)) } : null,
        readback_after: receipt("readback-after.json"),
        production_readback: exists("production-readback.json") ? { path: "production-readback.json", sha256: sha256File(path.join(dir, "production-readback.json")) } : null,
      },
      write_note: stringOrNull(applied.write),
      hold_reason: stringOrNull(branding.hold_reason),
    };
  } else if (isNonEmpty(branding)) {
    write = { status: /held/i.test(String(branding.status ?? "")) ? "held" : "not_written", source: "migrated:manifest", scope: firstToken(branding.scope)?.toLowerCase() ?? null, hold_reason: stringOrNull(branding.hold_reason), status_note: stringOrNull(branding.status), gate_override: false };
  }

  // ---- proofs ----
  let proofs: JsonObject | null = null;
  if (proofBranding && isNonEmpty(proofBranding)) {
    const proofRel = liveRel("proof.png");
    const validate = liveJson("proof-validate.json");
    const badgePdf = liveRel("badge-proof.pdf");
    proofs = {
      proof_png: proofRel ?? stringOrNull(proofBranding.proof_path),
      proof_sha256: stringOrNull(proofBranding.proof_sha256),
      proof_sha256_verified: proofRel ? sha256File(path.join(dir, proofRel)) === proofBranding.proof_sha256 : null,
      proof_branding_json: liveRel("proof-branding.json"),
      logo_sha256: stringOrNull(proofBranding.logo_sha256),
      badge_pdf: badgePdf,
      badge_png: liveRel("badge-proof.png"),
      badge_pdf_sha256: badgePdf ? sha256File(path.join(dir, badgePdf)) : null,
      rendered_at: stringOrNull(proofBranding.rendered_at),
      color_mode: stringOrNull(proofBranding.color_mode),
      rendered_colors: proofBranding.rendered_colors ?? null,
      effective_branding: proofBranding.effective_branding ?? null,
      validated: validate && isNonEmpty(validate) ? { ok: validate.ok === true, at: null, file: liveRel("proof-validate.json"), proof_logo_region: validate.proof_logo_region ?? null } : null,
      proposal_proof: exists("proposal-proof.png") ? "proposal-proof.png" : null,
      note: stringOrNull(applied.proofs),
    };
  } else if (exists("proposal-proof.png")) {
    proofs = { proof_png: null, proposal_proof: "proposal-proof.png", validated: null, note: stringOrNull(branding.proposal_proof) };
  }

  // ---- links ----
  const mLinks = asObject(manifest.links);
  let links: JsonObject | null = null;
  if (isNonEmpty(mLinks) || exists("links")) {
    const receipts: JsonObject[] = [];
    if (exists("links")) {
      for (const name of fs.readdirSync(path.join(dir, "links")).filter((file) => /\.json$/.test(file)).sort()) {
        receipts.push({ name: name.replace(/\.json$/, ""), path: path.join("links", name) });
      }
    }
    links = {
      source: "migrated:manifest",
      applied: Array.isArray(mLinks.written) && mLinks.written.length > 0,
      executed_at: null,
      execution: [],
      written: mLinks.written ?? [],
      existing: mLinks.existing ?? [],
      held: mLinks.held ?? [],
      not_found: mLinks.not_found ?? [],
      final_active: mLinks.final_active ?? null,
      verification: mLinks.verification ?? null,
      note: mLinks.note ?? null,
      receipts,
      discovery_report: discovery ? "link-discovery-report.json" : null,
    };
  }

  // ---- plan ----
  let plan: JsonObject | null = null;
  const handPlanObj = asObject(handPlan);
  if (handPlanObj.schema_version === 1 && typeof handPlanObj.plan_id === "string") {
    plan = { status: "ready", plan: handPlanObj, dedupe: null, source: "fulfillment-plan.json" };
  } else if (asObject(handPlanObj.plan).schema_version === 1) {
    plan = { ...handPlanObj, source: "fulfillment-plan.json" };
  }

  // ---- figma ----
  const signage = asObject(manifest.signage);
  const appliedFigma = applied.figma;
  let figma: JsonObject | null = null;
  if (isNonEmpty(signage)) {
    const hashesFrom = (text: unknown): string[] => (typeof text === "string" ? text.match(/\b[0-9a-f]{8}\b/g) ?? [] : []);
    const popSegment = typeof appliedFigma === "string"
      ? (appliedFigma.split(";").find((part) => /pop primary/i.test(part)) ?? "")
      : String(asObject(appliedFigma).pop_primary_logo ?? "");
    const popFromApplied = hashesFrom(popSegment.includes("->") ? popSegment.slice(popSegment.lastIndexOf("->")) : popSegment);
    const logosText = String(signage.logos ?? "");
    const stickerHash = /sticker[^;]*?hash ([0-9a-f]{8})/i.exec(logosText)?.[1] ?? hashesFrom(asObject(appliedFigma).sticker_logos)[0] ?? null;
    const popHash = popFromApplied.length ? popFromApplied[popFromApplied.length - 1] : (/POP Primary[^;]*?hash ([0-9a-f]{8})/i.exec(logosText)?.[1] ?? null);
    figma = {
      file: stringOrNull(signage.figma_file),
      section_node_id: stringOrNull(signage.section_id),
      section_url: stringOrNull(signage.section_url ?? signage.url ?? asObject(manifest.figma).url),
      band: /#[0-9A-Fa-f]{6}/.exec(String(signage.band ?? ""))?.[0] ?? null,
      band_note: stringOrNull(signage.band),
      slot: stringOrNull(signage.slot),
      template: stringOrNull(signage.template),
      sheet_ids: (signage.sheet_ids as JsonObject | null) ?? null,
      sheets: stringOrNull(signage.sheets),
      shots: stringOrNull(signage.shots),
      logo_hashes: { sticker: stickerHash, pop_primary: popHash },
      logos_note: stringOrNull(signage.logos),
      qr: stringOrNull(signage.qr),
      copy: stringOrNull(signage.copy),
      stroke_gate: stringOrNull(signage.stroke_gate),
      header: stringOrNull(signage.header),
      plan_json: exists("signage/plan.json") ? "signage/plan.json" : null,
      applied_update: appliedFigma ?? null,
    };
  }

  // ---- notion ----
  const mNotion = asObject(manifest.notion);
  const notion: JsonObject = {
    page_id: stringOrNull(mNotion.page ?? mNotion.page_id),
    entry: mNotion.entry ?? null,
    block_id: stringOrNull(mNotion.block_id),
    heading_block_id: stringOrNull(mNotion.heading_block_id),
    section: stringOrNull(mNotion.section),
    last_patched_at: null,
    note: stringOrNull(applied.notion),
    upsert_log: exists("notion-upsert.log") ? "notion-upsert.log" : null,
  };

  // ---- slack ----
  const slackPost = asObject(readJson("slack-post.json"));
  const slack: JsonObject = {
    thread_ts: request.slack_thread_ts,
    channel: request.slack_channel ?? stringOrNull(asObject(ledger).slack_channel),
    draft_path: exists("slack-note.txt") ? "slack-note.txt" : null,
    posted_at: stringOrNull(slackPost.posted_at),
    message_ts: stringOrNull(slackPost.message_ts),
    note: stringOrNull(applied.slack),
  };

  // ---- assemble ----
  const at = nowIso();
  const run: RunFile = {
    schema_version: 1,
    run_id: stringOrNull(manifest.run_id) ?? deriveRunId(dir),
    run_dir: dir,
    created_at: stringOrNull(manifest.generated_at) ?? at,
    updated_at: at,
    request,
    ...(plan ? { plan } : {}),
    ...(links ? { links } : {}),
    ...(evidence ? { evidence } : {}),
    ...(decision ? { decision } : {}),
    ...(variants ? { variants } : {}),
    ...(gates ? { gates } : {}),
    overrides,
    ...(write ? { write } : {}),
    ...(proofs ? { proofs } : {}),
    ...(figma ? { figma } : {}),
    notion,
    slack,
    state: {
      cursor: "migrated",
      stages: Object.fromEntries(
        ["request", plan && "plan", links && "links", evidence && "evidence", decision && "decision", variants && "variants", gates && "gates", write && "write", proofs && "proofs", figma && "figma", "notion", "slack"]
          .filter((name): name is string => typeof name === "string")
          .map((name) => [name, { written_at: at, by: "run-file migrate" }]),
      ),
      forces: [],
      migrated_at: at,
      migrated_from: consumed,
    },
    legacy: {
      manifest_path: exists("manifest.json") ? path.join(dir, "manifest.json") : null,
      manifest: isNonEmpty(manifest) ? manifest : null,
      ledger: ledger ?? null,
      fulfillment_plan: plan ? null : (handPlan ?? null),
      request_rows: requestRows ?? null,
      state_markdown: stateText,
      ledger_err: readText("ledger.err"),
    },
  };
  if (runFileExists(dir)) fs.copyFileSync(runFilePath(dir), `${runFilePath(dir)}.bak`);
  writeRun(dir, run);
  return run;
}

// ---- migrate helpers ----

function findLiveDir(dir: string, letter: string | null): string | null {
  const fixDir = path.join(dir, "fix");
  if (!fs.existsSync(fixDir)) return null;
  const live = fs.readdirSync(fixDir).filter((name) => /^live-/.test(name) && fs.statSync(path.join(fixDir, name)).isDirectory());
  if (!live.length) return null;
  if (letter) {
    const hit = live.find((name) => name.toLowerCase() === `live-${letter.toLowerCase()}`);
    if (hit) return path.join("fix", hit);
  }
  live.sort((a, b) => fs.statSync(path.join(fixDir, b)).mtimeMs - fs.statSync(path.join(fixDir, a)).mtimeMs);
  return path.join("fix", live[0]);
}

/** Walk fix/ (skipping node_modules) for apply*.json receipts whose readback carries a logo attachment. */
function findApplyReceipt(dir: string, liveDir: string | null): { path: string; effective: JsonObject; selected_scope: unknown } | null {
  const fixDir = path.join(dir, "fix");
  if (!fs.existsSync(fixDir)) return null;
  const hits: Array<{ path: string; effective: JsonObject; selected_scope: unknown; mtime: number }> = [];
  const walk = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = path.join(abs, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/^apply.*\.json$/.test(entry.name)) continue;
      let parsed: JsonObject;
      try { parsed = asObject(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { continue; }
      const readback = isNonEmpty(asObject(parsed.readback)) ? asObject(parsed.readback) : parsed;
      const effective = isNonEmpty(asObject(readback.effective_branding)) ? asObject(readback.effective_branding) : asObject(readback.account_branding);
      if (!stringOrNull(effective.logo_attachment_id)) continue;
      hits.push({ path: path.relative(dir, file), effective, selected_scope: readback.selected_scope ?? parsed.selected_scope ?? null, mtime: fs.statSync(file).mtimeMs });
    }
  };
  walk(fixDir);
  if (!hits.length) return null;
  const inLive = liveDir ? hits.find((hit) => hit.path.startsWith(`${liveDir}${path.sep}`)) : null;
  const chosen = inLive ?? hits.sort((a, b) => b.mtime - a.mtime)[0];
  return { path: chosen.path, effective: chosen.effective, selected_scope: chosen.selected_scope };
}

function findFileByBasename(dir: string, base: string): string | null {
  const hits: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === base) hits.push(path.relative(dir, file));
    }
  };
  walk(dir);
  hits.sort((a, b) => a.length - b.length);
  return hits[0] ?? null;
}

function resolveLoose(dir: string, rel: string | null): string | null {
  if (!rel) return null;
  if (fs.existsSync(path.join(dir, rel))) return rel;
  const parts = rel.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const candidate = parts.slice(index).join("/");
    if (fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return null;
}

function identityFrom(locationName: string, address: string | null, accountName: string | null): JsonObject {
  const parts = (address ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const stateZip = /^([A-Z]{2})\s+(\d{5})/.exec(parts[2] ?? "");
  return {
    account_name: accountName ?? locationName.replace(/\s*\([^)]*\)\s*$/, ""),
    location_name: locationName,
    street_address: parts[0] ?? "",
    city: parts[1] ?? "",
    state: stateZip?.[1] ?? "",
    postal_code: stateZip?.[2] ?? "",
  };
}

function candidateFromRow(row: JsonObject, accountId: string): JsonObject {
  return {
    location_id: String(row.id ?? row.location_id ?? ""),
    location_name: String(row.name ?? row.location_name ?? ""),
    location_status: String(row.status ?? row.location_status ?? "enabled"),
    account_id: String(row.account_id ?? accountId),
    account_name: String(row.account_name ?? ""),
    address: String(row.address ?? ""),
    website_url: stringOrNull(row.website_url),
    google_place_id: stringOrNull(row.google_place_id),
    is_general: row.is_general === true,
  };
}

function pickColors(effective: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of ["web_primary_color", "web_secondary_color", "web_text_color", "print_primary_color", "print_secondary_color", "print_text_color", "print_text_secondary_color"]) {
    out[key] = stringOrNull(effective[key]);
  }
  return out;
}

function letterFromCellText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /cells(?:\[['"]|\.)([A-Za-z0-9]+)['"]?\]?/.exec(value);
  return match ? match[1] : null;
}

function pickerFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^([A-Z][a-z]+) (?:picked|chose|selected)/.exec(value.trim());
  return match ? match[1] : null;
}

function dateFrom(key: string | undefined): string | null {
  if (!key) return null;
  const match = /(\d{4})_(\d{2})_(\d{2})/.exec(key);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

// ---- shared small helpers ----

export function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** "1789418445.935639 (channel C09...)" -> "1789418445.935639" */
export function firstTs(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /\d{6,}\.\d+/.exec(value);
  return match ? match[0] : null;
}

export function channelIn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /\b(C[0-9A-Z]{8,})\b/.exec(value);
  return match ? match[1] : null;
}

/** Strip a trailing "(note)" from manifest prose values: "variants/x.png (superseded)" -> "variants/x.png" */
export function stripNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/, "").trim();
  return text || null;
}

export function firstToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^[A-Za-z0-9_-]+/.exec(value.trim());
  return match ? match[0] : null;
}

export function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseCli(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) flags[key] = true;
      else { flags[key] = value; index += 1; }
    } else positional.push(token);
  }
  return { positional, flags };
}

const USAGE = [
  "run-file init --request <json> --dir <run_dir> [--run-id <id>] [--force]",
  "run-file set <run_dir> <block> --from <json-file> [--force --reason \"<why>\"] [--by <who>]",
  "run-file set <run_dir> variants --from-sheet <variant-sheet.json> [--by <who>]",
  "run-file get <run_dir> [block] [--path a.b.c]",
  "run-file validate <run_dir>",
  "run-file migrate <run_dir> [--force]",
  "run-file select <run_dir> <letter> --by <who> [--reason \"<why>\"]",
  "run-file override <run_dir> --gate <gate> --asset <asset> --decided-by <who> --reason \"<why>\" [--shipped] [--at <iso>]   (--by is accepted too; --shipped only for an asset already live)",
].join("\n");

function flagString(flags: Record<string, string | boolean>, key: string): string | null {
  return typeof flags[key] === "string" ? flags[key] as string : null;
}

export function main(argv: string[]): number {
  const { positional, flags } = parseCli(argv);
  const [command, ...rest] = positional;
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  switch (command) {
    case "init": {
      const requestFile = flagString(flags, "request");
      const dir = flagString(flags, "dir");
      if (!requestFile || !dir) throw new Error(`init needs --request <json> --dir <run_dir>\n${USAGE}`);
      const request = JSON.parse(fs.readFileSync(path.resolve(requestFile), "utf8")) as JsonObject;
      // Accept either a ready request block or a CanonicalRequest straight from list-branding-requests.ts.
      const block = "request_id" in request ? request : requestBlockFromCanonical(request);
      const run = initRun({ runDir: dir, request: block, runId: flagString(flags, "run-id") ?? undefined, force: flags.force === true });
      out({ ok: true, file: runFilePath(dir), run_id: run.run_id });
      return 0;
    }
    case "set": {
      const [dir, block] = rest;
      const from = flagString(flags, "from");
      const fromSheet = flagString(flags, "from-sheet");
      if (!dir || !block || (!from && !fromSheet)) throw new Error(`set needs <run_dir> <block> --from <json-file> (variants also accepts --from-sheet <variant-sheet.json>)\n${USAGE}`);
      if (fromSheet && block !== "variants") throw new Error("--from-sheet applies to the variants block only");
      const value: unknown = fromSheet
        ? (() => {
          const previous = runFileExists(dir) ? asObject(readRun(dir).variants) : {};
          const built = variantsBlockFromSheet(fromSheet, dir);
          // A re-render keeps the human's recorded choice when the letter still exists on the new sheet.
          const keepLetter = typeof previous.applied_letter === "string" && previous.applied_letter in asObject(built.cells);
          return keepLetter ? { ...built, applied_letter: previous.applied_letter, selection: previous.selection ?? null } : built;
        })()
        : JSON.parse(from === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(from as string), "utf8")) as unknown;
      const run = setBlock(dir, block, value, { force: flags.force === true, reason: flagString(flags, "reason") ?? undefined, by: flagString(flags, "by") ?? undefined });
      out({ ok: true, file: runFilePath(dir), block, cursor: asObject(run.state).cursor });
      return 0;
    }
    case "get": {
      const [dir, block] = rest;
      if (!dir) throw new Error(`get needs <run_dir> [block]\n${USAGE}`);
      const value = getBlock(dir, block, flagString(flags, "path") ?? undefined);
      if (value === undefined) { process.stderr.write(`${block ?? "run"}: not set\n`); return 3; }
      out(value);
      return 0;
    }
    case "validate": {
      const [dir] = rest;
      if (!dir) throw new Error(`validate needs <run_dir>\n${USAGE}`);
      const run = readRun(dir);
      const errors = validateRun(run);
      const blocks = BLOCKS.filter((name) => isNonEmpty(run[name]));
      out({ valid: errors.length === 0, errors, run_id: run.run_id, blocks, cursor: asObject(run.state).cursor });
      return errors.length ? 2 : 0;
    }
    case "migrate": {
      const [dir] = rest;
      if (!dir) throw new Error(`migrate needs <run_dir>\n${USAGE}`);
      const run = migrateRun(dir, { force: flags.force === true });
      out({ ok: true, file: runFilePath(dir), run_id: run.run_id, blocks: BLOCKS.filter((name) => isNonEmpty(run[name])), migrated_from: asObject(run.state).migrated_from });
      return 0;
    }
    case "select": {
      const [dir, letter] = rest;
      const by = flagString(flags, "by");
      if (!dir || !letter || !by) throw new Error(`select needs <run_dir> <letter> --by <who>\n${USAGE}`);
      const run = selectLetter(dir, letter, { by, reason: flagString(flags, "reason") ?? undefined });
      out({ ok: true, applied_letter: asObject(run.variants).applied_letter, overrides: (run.overrides ?? []).length });
      return 0;
    }
    case "override": {
      const [dir] = rest;
      const gate = flagString(flags, "gate");
      const asset = flagString(flags, "asset");
      const by = flagString(flags, "decided-by") ?? flagString(flags, "by");
      const reason = flagString(flags, "reason");
      if (!dir || !gate || !asset || !by || !reason) throw new Error(`override needs <run_dir> --gate --asset --decided-by --reason\n${USAGE}`);
      const run = appendOverride(dir, { gate, asset, decided_by: by, reason, ...(flagString(flags, "at") ? { at: flagString(flags, "at") as string } : {}) }, { shipped: flags.shipped === true });
      out({ ok: true, overrides: (run.overrides ?? []).length });
      return 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
