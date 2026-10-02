#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFulfillmentPlan,
  validateFulfillmentPlan,
  type FulfillmentPlan,
  type ModelException,
} from "./fulfillment-plan.ts";
import {
  matchLocationExactly,
  selectBrandingScope,
  type FulfillmentRequestIdentity,
  type LocationCandidate,
} from "./location-match.ts";
import { StageRecorder, type StageMetric } from "./stage-metrics.ts";
import { DEFAULT_STATE_FILE } from "./list-branding-requests.ts";
import { FULFILLMENT_BROWSER_PROVIDERS } from "./paths.ts";
import { preparationInputFromRun, readRun, setBlock } from "./run-file.ts";

type JsonObject = Record<string, unknown>;

export type ParsedSlackRequest = {
  request_key: string;
  canonical_thread_ts: string;
  fulfillment_request_id?: string;
  expected_location_id?: string;
  fields: FulfillmentRequestIdentity;
  badge_quantity: number | null;
  badge_quantity_status: FulfillmentPlan["request"]["badge_quantity_status"];
};

export type PreparationInput = {
  write_policy?: "links_only";
  safety_holds?: Array<{ category: string; url: string; reason: string }>;
  request: ParsedSlackRequest;
  location_candidates: LocationCandidate[];
  account_locations?: LocationCandidate[];
  discovery_report: JsonObject;
  branding?: FulfillmentPlan["branding"];
  heartbeat_state?: {
    processed_request_keys?: string[];
    // Dedupe key for v2-db intake: the fulfillment_requests.id. Legacy Slack request keys
    // remain honoured through processed_request_keys.
    processed_fulfillment_request_ids?: string[];
  };
  metrics?: StageMetric[];
};

export type PreparationResult =
  | { status: "ready"; plan: FulfillmentPlan; dedupe: { links_already_processed: boolean } }
  | { status: "needs_model_review"; exception: ModelException; candidates: LocationCandidate[]; metrics: StageMetric[] };

export function prepareFulfillmentPlan(input: PreparationInput): PreparationResult {
  assertFableDecisionIsImmutable(input.branding);
  const metrics = new StageRecorder();
  metrics.start("location_match");
  const match = matchLocationExactly(input.request.fields, input.location_candidates);
  metrics.increment("location_match", "candidates_total", input.location_candidates.length);
  metrics.increment("location_match", "general_candidates_excluded", input.location_candidates.filter((item) => item.is_general === true).length);
  if (match.status !== "matched") metrics.increment("location_match", "model_exceptions", 1);
  metrics.finish("location_match");

  if (match.status === "needs_model_review") {
    return {
      status: "needs_model_review",
      exception: {
        kind: "ambiguous_business_identity",
        model: "sol",
        reason: match.reason,
        evidence_refs: match.candidates.map((candidate) => candidate.location_id),
      },
      candidates: match.candidates,
      metrics: metrics.snapshot().stages,
    };
  }

  if (!stringValue(match.location.google_place_id)) {
    throw new Error(
      `Missing google_place_id for matched location ${match.location.location_name} (${match.location.location_id}); batch preflight must stop fulfillment before discovery or writes`,
    );
  }
  if (input.request.fulfillment_request_id && input.request.expected_location_id !== match.location.location_id) {
    throw new Error("Database fulfillment request foreign-key target mismatch");
  }

  const reportLocation = asObject(input.discovery_report.location_context);
  const reportLocationId = stringValue(reportLocation.location_id);
  if (reportLocationId !== match.location.location_id) {
    throw new Error(`Discovery report location mismatch: expected ${match.location.location_id}, found ${reportLocationId ?? "none"}`);
  }

  const accountLocations = input.account_locations ?? input.location_candidates.filter(
    (candidate) => candidate.account_id === match.location.account_id,
  );
  const brandingScope = selectBrandingScope(match.location, accountLocations);
  const state = input.heartbeat_state ?? {};
  const dedupe = {
    links_already_processed:
      (state.processed_request_keys ?? []).includes(input.request.request_key) ||
      (input.request.fulfillment_request_id != null &&
        (state.processed_fulfillment_request_ids ?? []).includes(input.request.fulfillment_request_id)),
  };
  if (!dedupe.links_already_processed) {
    assertFulfillmentDiscoveryRuntime(input.discovery_report);
  }
  const modelExceptions = [
    ...tieExceptions(input.discovery_report),
    ...eventTimingExceptions(input.discovery_report),
  ];
  const completedMatchMetrics = metrics.snapshot().stages;
  metrics.start("plan_build");
  const plan = buildFulfillmentPlan({
    write_policy: input.write_policy,
    safety_holds: input.safety_holds,
    request: {
      request_key: input.request.request_key,
      canonical_thread_ts: input.request.canonical_thread_ts,
      fulfillment_request_id: input.request.fulfillment_request_id,
      badge_quantity: input.request.badge_quantity,
      badge_quantity_status: input.request.badge_quantity_status,
    },
    location: {
      location_id: match.location.location_id,
      location_name: match.location.location_name,
      account_id: match.location.account_id,
      account_name: match.location.account_name,
      website_url: match.location.website_url ?? stringValue(reportLocation.website_url),
      is_general: false,
      branding_scope: brandingScope,
    },
    discovery_report: input.discovery_report,
    branding: input.branding,
    model_exceptions: modelExceptions,
    metrics: [...(input.metrics ?? []), ...completedMatchMetrics],
  });
  applyDedupe(plan, dedupe);
  metrics.increment("plan_build", "link_decisions", plan.links.length);
  metrics.increment("plan_build", "write_operations", plan.writes.length);
  metrics.increment("plan_build", "model_exceptions", plan.model_exceptions.length);
  plan.metrics.push(metrics.finish("plan_build"));
  const errors = validateFulfillmentPlan(plan);
  if (errors.length) throw new Error(`Dedupe produced invalid plan: ${errors.join("; ")}`);
  return { status: "ready", plan, dedupe };
}

function assertFulfillmentDiscoveryRuntime(report: JsonObject): void {
  const runtime = asObject(report.runtime);
  const provider = stringValue(runtime.browser_provider);
  if (runtime.fulfillment_mode !== true) {
    throw new Error("Discovery report was not generated in fulfillment mode");
  }
  if (!provider || !(FULFILLMENT_BROWSER_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Fulfillment discovery requires browser_provider=codex-extension or claude-chrome, found ${provider ?? "none"}`);
  }
  if (runtime.browser_provider_preflighted !== true) {
    throw new Error(`Fulfillment discovery did not preflight the ${provider} browser provider`);
  }
  if (provider === "claude-chrome") {
    // claude-chrome is final only when every browser escalation has a recorded result.
    const needed = runtime.browser_needed;
    if (!Array.isArray(needed)) throw new Error("claude-chrome discovery report is missing runtime.browser_needed");
    if (needed.length > 0) throw new Error(`claude-chrome discovery has ${needed.length} browser result(s) pending; visit the manifest urls and rerun discovery with --browser-results`);
  }
  if (asObject(report.website_bootstrap).reason === "website_url_override_unwritten") {
    throw new Error("Discovery ran with a diagnostics website override; the website_url was never written to V2");
  }
  if (stringValue(runtime.chrome_profile_resolved) !== "Boostly.com") {
    throw new Error(`Fulfillment discovery requires the Boostly.com Chrome profile, found ${stringValue(runtime.chrome_profile_resolved) ?? "none"}`);
  }
}

function assertFableDecisionIsImmutable(branding: FulfillmentPlan["branding"] | undefined): void {
  if (!branding?.fable_output) return;

  const decisionPath = stringValue(branding.fable_decision_path);
  const expectedSha256 = stringValue(branding.fable_decision_sha256);
  if (!decisionPath || !expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("Validated Fable output requires fable_decision_path and fable_decision_sha256 provenance");
  }

  const resolvedPath = path.resolve(decisionPath);
  const source = fs.readFileSync(resolvedPath);
  const actualSha256 = crypto.createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error("Validated Fable decision hash mismatch; downstream branding override is forbidden");
  }

  const validatedDecision = JSON.parse(source.toString("utf8")) as unknown;
  if (JSON.stringify(validatedDecision) !== JSON.stringify(branding.fable_output)) {
    throw new Error("Branding output differs from the validated Fable decision; downstream branding override is forbidden");
  }
}

function applyDedupe(
  plan: FulfillmentPlan,
  dedupe: { links_already_processed: boolean },
): void {
  if (dedupe.links_already_processed) {
    plan.links = plan.links.map((link) =>
      link.action === "write" ? { ...link, action: "preserve", target: "none", reason: "request_key_already_processed" } : link,
    );
    plan.writes = [];
  }
  plan.writes = plan.writes.map((write, index) => ({ ...write, sequence: index + 1 }));
}

function tieExceptions(report: JsonObject): ModelException[] {
  return asArray(report.manual_review_items)
    .map(asObject)
    .filter((item) => /deterministic candidate tie|conflicting evidence/i.test(stringValue(item.reason) ?? ""))
    .map((item) => ({
      kind: "conflicting_candidate_tie" as const,
      model: "luna" as const,
      reason: stringValue(item.reason) ?? "deterministic candidate tie",
      category: stringValue(item.category) ?? undefined,
      evidence_refs: [
        ...asArray(item.candidate_urls).filter((value): value is string => typeof value === "string"),
        stringValue(item.candidate_url),
      ].filter((value): value is string => value != null),
    }));
}

function eventTimingExceptions(report: JsonObject): ModelException[] {
  return asArray(report.category_results)
    .map(asObject)
    .filter((item) => stringValue(item.category) === "events")
    .map((item) => asObject(item.selected_link ?? item.existing_link))
    .filter((link) => {
      const review = asObject(asObject(link.event_timing).luna_review);
      return review.status === "accepted" && review.model === "gpt-5.6-luna";
    })
    .map((link) => {
      const review = asObject(asObject(link.event_timing).luna_review);
      return {
        kind: "unstructured_event_timing" as const,
        model: "luna" as const,
        reason: stringValue(review.reason) ?? "Validated GPT-5.6 Luna review of visible upcoming-event evidence",
        category: "events",
        evidence_refs: [
          stringValue(link.final_url) ?? stringValue(link.input_url),
          stringValue(review.evidence_hash),
        ].filter((value): value is string => value != null),
      };
    });
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

const USAGE = [
  "Usage: --input <preparation-input.json> --out <fulfillment-plan.json>",
  "   or: --run <run_dir> [--input <preparation-input.json>] [--discovery <link-discovery-report.json>]",
  "       [--state-file <heartbeat-state.json>] [--write-policy links_only] [--out <file>] [--force <reason>]",
  "With --run and no --input, the preparation input is assembled from run.json (request block, decision",
  "block when present) plus the discovery report; the result lands in run.json as the plan block.",
].join("\n");

/** Assemble the PreparationInput from a run dir's run.json plus its discovery report. */
export function preparationInputFromRunDir(runDir: string, options: { discovery?: string; stateFile?: string; writePolicy?: "links_only" } = {}): PreparationInput {
  const run = readRun(runDir);
  const discoveryPath = path.resolve(options.discovery ?? path.join(runDir, "link-discovery-report.json"));
  if (!fs.existsSync(discoveryPath)) {
    throw new Error(`No discovery report at ${discoveryPath}; pass --discovery <report.json> or --input <preparation-input.json>`);
  }
  const discovery = JSON.parse(fs.readFileSync(discoveryPath, "utf8")) as JsonObject;
  const stateFile = path.resolve(options.stateFile ?? DEFAULT_STATE_FILE);
  const heartbeat = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) as JsonObject : {};
  return preparationInputFromRun(run, {
    discovery_report: discovery,
    heartbeat_state: heartbeat,
    write_policy: options.writePolicy,
    run_dir: path.resolve(runDir),
  }) as unknown as PreparationInput;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.run ? path.resolve(args.run) : null;
  if (!runDir && (!args.input || !args.out)) throw new Error(USAGE);
  const input: PreparationInput = args.input
    ? JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8")) as PreparationInput
    : preparationInputFromRunDir(runDir as string, {
      discovery: args.discovery,
      stateFile: args["state-file"],
      writePolicy: args["write-policy"] === "links_only" ? "links_only" : undefined,
    });
  const result = prepareFulfillmentPlan(input);
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(result, null, 2)}\n`);
  if (runDir) {
    setBlock(runDir, "plan", result, { by: "prepare-fulfillment-plan", force: typeof args.force === "string", reason: args.force });
  }
  process.stdout.write(`${JSON.stringify({ status: result.status, out: args.out ? path.resolve(args.out) : null, run: runDir })}\n`);
  if (result.status === "needs_model_review") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
