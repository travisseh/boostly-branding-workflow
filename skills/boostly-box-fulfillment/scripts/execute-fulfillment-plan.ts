#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExecutionRecord } from "./fulfillment-artifacts.ts";
import { parseFulfillmentPlan, validateFulfillmentPlan, type FulfillmentPlan, type WriteOperation } from "./fulfillment-plan.ts";
import { StageRecorder } from "./stage-metrics.ts";
import { asObject, readRun, setBlock } from "./run-file.ts";
import { ACCOUNT_WRITE_LOCK_DIR, BOOSTLY_LINKS_CLI } from "./paths.ts";

const DEFAULT_CLI = BOOSTLY_LINKS_CLI;
const DEFAULT_LOCK_DIR = ACCOUNT_WRITE_LOCK_DIR;
// Final-asset QA is the data-driven gate battery in the sibling boostly-brand-design skill:
// `gates.ts check` runs every gate from references/gates.json and combines the results with the
// override records in run.json. The write is refused on HOLD; SHIP-WITH-OVERRIDE is allowed only
// because a human recorded the override as data. No threshold lives here.
const BRAND_GATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "boostly-brand-design", "scripts", "gates.ts",
);

type CommandSpec = { dryRun: string[]; apply: string[]; readback: string[] };

export function buildOperationCommands(
  plan: FulfillmentPlan,
  operation: WriteOperation,
  cookieFile: string,
): CommandSpec {
  const locationId = plan.location.location_id;
  const common = ["--cookie-file", cookieFile, "--ensure-location-scope", "--json"];
  let base: string[];
  let readback: string[];
  let dryRun: string[] | null = null;

  if (operation.kind === "social") {
    base = ["socials", "set", locationId, "--scope", operation.scope, ...brandingArgs(operation.payload), "--fill-only", ...common];
    readback = ["branding", "get", locationId, ...common];
  } else if (operation.kind === "branding") {
    base = ["branding", "set", locationId, "--scope", operation.scope, ...brandingArgs(operation.payload), "--fill-only", ...common];
    readback = ["branding", "get", locationId, ...common];
  } else if (operation.kind === "location") {
    if (operation.category !== "ordering" || !operation.url) {
      throw new Error(`Unsupported location operation: ${operation.category ?? "missing"}`);
    }
    base = ["location", "set", locationId, "--ordering-url", operation.url, "--fill-only", ...common];
    readback = ["location", "get", locationId, ...common];
  } else if (operation.kind === "touchpoint") {
    if (!operation.category || !operation.url) throw new Error("Touchpoint operation lacks category/url");
    const presentation = operation.payload ?? {};
    base = [
      "events", "add-custom", locationId,
      "--title", stringValue(presentation.title) ?? categoryTitle(operation.category),
      "--link", operation.url,
      "--category", operation.category,
      "--fill-only",
      ...optionalArg("--display-title", stringValue(presentation.display_title)),
      ...optionalArg("--description", stringValue(presentation.description)),
      ...optionalArg("--button-text", stringValue(presentation.button_text)),
      ...common,
    ];
    readback = ["events", "list", locationId, ...common];
  } else if (operation.kind === "linktree_defaults") {
    const hasSocials = operation.payload?.verified_socials_present === true;
    base = [
      "events", "enforce-linktree-defaults", locationId,
      "--verified-socials-present", String(hasSocials),
      ...common,
    ];
    if (hasSocials && hasPriorPlannedSocialWrite(plan, operation.sequence)) {
      dryRun = [...base, "--planned-socials-present"];
    }
    readback = ["events", "list", locationId, ...common];
  } else {
    throw new Error(`Unsupported write operation: ${String(operation.kind)}`);
  }
  return { dryRun: dryRun ?? base, apply: [...base, "--apply"], readback };
}

function hasPriorPlannedSocialWrite(plan: FulfillmentPlan, sequence: number): boolean {
  return plan.writes.some((write) =>
    write.sequence < sequence &&
    (write.kind === "branding" || write.kind === "social") &&
    ["facebook_url", "instagram_url", "x_url", "tiktok_url", "youtube_url", "apple_app_url", "google_app_url"]
      .some((field) => stringValue(write.payload?.[field]) !== null),
  );
}

export function executePlan(
  plan: FulfillmentPlan,
  options: {
    apply: boolean;
    cookieFile: string;
    cli?: string;
    lockDir?: string;
    runCommand?: (args: string[]) => unknown;
    metrics?: StageRecorder;
    runDir?: string | null;
    gateVerdict?: (args: string[]) => GateVerdict;
  },
): ExecutionRecord[] {
  const errors = validateFulfillmentPlan(plan);
  if (errors.length) throw new Error(`Plan validation failed: ${errors.join("; ")}`);
  const cli = options.cli ?? DEFAULT_CLI;
  const runCommand = options.runCommand ?? ((args: string[]) => runJsonCommand(cli, args));
  const needsAccountLock = options.apply && plan.writes.some((write) =>
    (write.kind === "branding" || write.kind === "social") && write.scope === "account",
  );
  const release = needsAccountLock
    ? acquireAccountLock(options.lockDir ?? DEFAULT_LOCK_DIR, plan.location.account_id, plan.plan_id)
    : () => undefined;
  const records: ExecutionRecord[] = [];
  try {
    for (const operation of plan.writes) {
      // Final-asset QA runs before any production call; a HOLD throws out of the plan, as before.
      const gateVerdict = operation.kind === "branding"
        ? assertBrandingAssetSafe(operation, { runDir: options.runDir, gateVerdict: options.gateVerdict })
        : null;
      const withVerdict = (record: ExecutionRecord): ExecutionRecord => (gateVerdict ? { ...record, gate_verdict: gateVerdict } : record);
      const commands = buildOperationCommands(plan, operation, options.cookieFile);
      try {
        const before = runMeasured(options.metrics, "production_read", "before_reads", () => runCommand(commands.readback));
        const dryRun = runMeasured(options.metrics, "production_apply", "dry_run_previews", () => runCommand(commands.dryRun));
        if (!options.apply) {
          records.push(withVerdict({ operation, outcome: "dry_run", before, after: dryRun }));
          continue;
        }
        if (operation.kind === "social") {
          const hash = (dryRun as { state_hash?: string })?.state_hash;
          if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Social dry-run lacks its guarded state hash");
          commands.apply.push("--expected-state-hash", hash);
        }
        const after = runMeasured(options.metrics, "production_apply", "apply_commands", () => runCommand(commands.apply));
        const readback = runMeasured(options.metrics, "production_read", "after_reads", () => runCommand(commands.readback));
        records.push(withVerdict({ operation, outcome: isNoOpResult(after) ? "skipped_existing" : "applied", before, after, readback }));
      } catch (error) {
        records.push({
          operation,
          outcome: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  } finally {
    release();
  }
  return records;
}

export type GateVerdict = {
  verdict: "SHIP" | "SHIP-WITH-OVERRIDE" | "HOLD";
  reasons: string[];
  failing?: Array<Record<string, unknown>>;
  overridden?: Array<Record<string, unknown>>;
  refused?: Array<Record<string, unknown>>;
  missing?: string[];
};

/**
 * Final-asset QA before a branding write: the gate battery plus recorded overrides, as one verdict.
 * HOLD refuses the write. The verdict itself is returned so the caller can record it (write.verdict).
 */
export function assertBrandingAssetSafe(operation: WriteOperation, options: { runDir?: string | null; gateVerdict?: (args: string[]) => GateVerdict } = {}): GateVerdict | null {
  const logoFile = stringValue(operation.payload?.logo_file);
  if (!logoFile) return null;
  const primary = stringValue(operation.payload?.web_primary_color);
  if (!primary) throw new Error("Branding logo write requires web_primary_color for final-asset QA");
  if (!fs.existsSync(logoFile)) throw new Error(`Branding final logo does not exist: ${logoFile}`);
  assertPdfSafeLogoEncoding(logoFile);
  const args = ["check", "--asset", path.resolve(logoFile), "--color", primary];
  if (options.runDir) args.push("--run", path.resolve(options.runDir));
  const expected = stringValue(operation.payload?.expected_text);
  if (expected) args.push("--expected", expected);
  const source = stringValue(operation.payload?.verified_source);
  if (source) args.push("--source", source);
  const verdict = (options.gateVerdict ?? runGateVerdict)(args);
  if (verdict.verdict === "HOLD") {
    throw new Error(`Branding final logo HOLD: ${verdict.reasons.join("; ") || "gate verdict is HOLD"}. Record an override with run-file override (allowed gates only) or fix the asset; never edit a gate to pass.`);
  }
  return verdict;
}

export function assertPdfSafeLogoEncoding(logoFile: string): void {
  const header = fs.readFileSync(logoFile).subarray(0, 26);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (header.length < 26 || !header.subarray(0, 8).equals(pngSignature)) return;
  const chunkType = header.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") throw new Error("Branding PNG has an invalid IHDR header");
  const colorType = header[25];
  if (colorType === 3) {
    throw new Error(
      "Branding logo is an indexed/palette PNG (color type 3), which corrupts in downloadable badge PDFs; convert the exact pixels to truecolor RGB/RGBA and rerun every logo gate",
    );
  }
}

function runGateVerdict(args: string[]): GateVerdict {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", BRAND_GATES, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  // exit 2 = HOLD (still valid JSON on stdout); anything else without JSON is a tooling failure
  let parsed: unknown = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as GateVerdict).verdict !== "string") {
    throw new Error((result.stderr || result.stdout || "Branding gate verdict failed").trim());
  }
  return parsed as GateVerdict;
}

function isNoOpResult(value: unknown): boolean {
  return value != null && typeof value === "object" && !Array.isArray(value) && (
    (value as Record<string, unknown>).no_op === true ||
    (value as Record<string, unknown>).idempotent === true
  );
}

function runMeasured<T>(
  metrics: StageRecorder | undefined,
  stage: "production_read" | "production_apply",
  counter: string,
  operation: () => T,
): T {
  if (!metrics) return operation();
  metrics.start(stage);
  metrics.increment(stage, counter);
  try {
    const result = operation();
    metrics.finish(stage);
    return result;
  } catch (error) {
    metrics.finish(stage, "error", error instanceof Error ? error.name : "unknown_error");
    throw error;
  }
}

function acquireAccountLock(lockDir: string, accountId: string, planId: string): () => void {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${safeSegment(accountId)}.lock`);
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "EEXIST") throw new Error(`Account write lock already held: ${accountId}`);
    throw error;
  }
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ plan_id: planId, pid: process.pid, acquired_at: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
  return () => fs.rmSync(lockPath, { recursive: true, force: true });
}

function runJsonCommand(cli: string, args: string[]): unknown {
  const result = spawnSync(cli, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `command failed with ${result.status}`).trim());
  }
  return JSON.parse(result.stdout);
}

function brandingArgs(payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [];
  const flagByField: Record<string, string> = {
    instagram_url: "--instagram-url",
    facebook_url: "--facebook-url",
    tiktok_url: "--tiktok-url",
    youtube_url: "--youtube-url",
    x_url: "--x-url",
    apple_app_url: "--apple-app-url",
    google_app_url: "--google-app-url",
    web_primary_color: "--web-primary-color",
    web_secondary_color: "--web-secondary-color",
    web_text_color: "--web-text-color",
    print_primary_color: "--print-primary-color",
    print_secondary_color: "--print-secondary-color",
    print_text_color: "--print-text-color",
    print_text_secondary_color: "--print-text-secondary-color",
    logo_file: "--logo-file",
  };
  const out: string[] = [];
  for (const [field, flag] of Object.entries(flagByField)) {
    const value = stringValue(payload[field]);
    if (value) out.push(flag, value);
  }
  return out;
}

function optionalArg(flag: string, value: string | null): string[] {
  return value ? [flag, value] : [];
}

function categoryTitle(category: string): string {
  const known: Record<string, string> = { careers_jobs: "Careers", order: "Order Online" };
  return known[category] ?? category.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) out[key] = true;
    else {
      out[key] = value;
      index += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = typeof args.run === "string" ? path.resolve(args.run) : null;
  if (typeof args.plan !== "string" && !runDir) throw new Error("Missing --plan <fulfillment-plan.json> (or --run <run_dir> to read run.json's plan block)");
  if (typeof args["cookie-file"] !== "string") throw new Error("Missing --cookie-file <raw-cookie-file>");
  const rawPlan = typeof args.plan === "string"
    ? JSON.parse(fs.readFileSync(path.resolve(args.plan), "utf8"))
    : (() => {
      const block = asObject(readRun(runDir as string).plan);
      if (block.status !== "ready") throw new Error(`run.json plan block is ${String(block.status ?? "missing")}; prepare-fulfillment-plan --run first`);
      return block.plan;
    })();
  const plan = parseFulfillmentPlan(rawPlan);
  const metrics = new StageRecorder();
  const execution = executePlan(plan, {
    apply: args.apply === true,
    cookieFile: path.resolve(args["cookie-file"]),
    cli: typeof args.cli === "string" ? path.resolve(args.cli) : undefined,
    lockDir: typeof args["lock-dir"] === "string" ? path.resolve(args["lock-dir"]) : undefined,
    metrics,
    runDir,
  });
  const output = { plan_id: plan.plan_id, applied: args.apply === true, execution, stage_metrics: metrics.snapshot() };
  if (typeof args.out === "string") fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(output, null, 2)}\n`);
  if (runDir) {
    setBlock(runDir, "links", { ...output, executed_at: new Date().toISOString() }, {
      by: "execute-fulfillment-plan",
      force: args.force === true,
      reason: typeof args.reason === "string" ? args.reason : undefined,
    });
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (execution.some((record) => record.outcome === "error")) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
