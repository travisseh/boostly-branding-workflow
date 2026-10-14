#!/usr/bin/env node
// Ad hoc in-store orders (order_type = 'ad_hoc'): auto-fulfillment path, Travisse 2026-10-14:
// "update the skill so that adhoc requests automatically get marked as in-store complete and for
// signage get sent to customstickers as long as we've previously completed branding and in-store
// details are complete. I.e. I don't want to manually touch those at all they should go straight
// to physical fulfillment and to customstickers.com. if those things aren't complete they should
// be added to the queue".
//
// Decision rule (per open ad_hoc request, oldest first):
//   eligible  = live V2 branding has a primary logo (location row, else account row)
//           AND the request's store details are complete (ship-to recipient, line1, city, state,
//               zip on the location; offer text when the order carries signage or stickers)
//           AND, when the order carries anything printed (signage, table or bathroom stickers,
//               to-go rolls), the location has a prior completed run under the run root
//               (run.json write.status applied, branding complete recorded, figma block with a
//               section id and file key) whose Figma section is the print master to reuse.
//   queued    = anything else; the request gets a normal intake run dir, a blocked-on stamp and a
//               one-line board note naming the failed precondition (never ship-to data).
//
// Eligible requests go straight through: store-details confirm (dry run, then --apply) when not
// yet confirmed, branding complete (dry run, then --apply) when digital_fulfilled_at is null,
// Figma section reuse (same table/stall pages) or a clone brief for the build agent (trim or
// expand), the customstickers.com print hand-off limited to the ordered kinds, the single Slack
// result in the request thread, a new run dir <location>-adhoc-<yyyymmdd> linking the prior run,
// progress and review-status stamps, and the board refresh. No Figma approval stop.
//
// Default is --dry-run: prints the decision per request and the exact commands, writes nothing.
// --apply needs ADHOC_AUTO_APPLY=1 in the environment (or the workspace .env), or --go for a
// one-off run Travisse authorized in the session.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  listBrandingRequests,
  type CanonicalRequest,
} from "./list-branding-requests.ts";
import {
  initRun,
  readRun,
  requestBlockFromCanonical,
  runFileExists,
  setBlock,
  slugify,
  validateRun,
  type JsonObject,
} from "./run-file.ts";
import { BOOSTLY_LINKS_CLI, HEARTBEAT_STATE_FILE, SKILLS_ROOT, V2_DB } from "./paths.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRINT_HANDOFF = path.join(SKILLS_ROOT, "boostly-print-handoff", "scripts", "print-handoff.mjs");
export const POST_REVIEW = path.join(SKILLS_ROOT, "boostly-signage-sheets", "scripts", "post-review.mjs");
export const FIGMA_TRIM = path.join(SKILLS_ROOT, "boostly-signage-sheets", "scripts", "figma-trim.mjs");
export const FIGMA_TARGET = path.join(SKILLS_ROOT, "boostly-signage-sheets", "references", "figma-target.json");
export const RUN_PROGRESS = path.join(SKILLS_ROOT, "boostly-brand-design", "scripts", "run-progress.mjs");
export const REVIEW_STATUS = path.join(SKILLS_ROOT, "boostly-brand-design", "scripts", "review-status.mjs");
export const DECRYPT_COOKIE = path.join(SKILLS_ROOT, "boostly-brand-design", "scripts", "decrypt-boostly-cookie.mjs");
export const REVIEW_CHECKLIST = path.join(HERE, "review-checklist.py");
export const SLACK_JS = path.join(process.env.SLACK_TOOLS_DIR ?? path.join(os.homedir(), ".config", "slack-tools"), "slack.js");
export const SLACK_WORKSPACE = "boostly";
export const SLACK_CHANNEL = "C09MSM8MA9Y";
// The run loop switch file: the shared branding env file on another machine, the workspace .env here.
export const WORKSPACE_ENV_FILE = process.env.BOOSTLY_BRANDING_ENV_FILE ?? process.env.BOOSTLY_ENV_FILE ?? "/Users/travisse/Programming/.env";
export const STICKERS_PER_PAGE = 4;
const BY = "adhoc-fulfillment";
const OFFER_BEARING_ITEM_TYPES = new Set(["signage", "stickers"]);

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type Quantities = { tap_cards: number; tables: number; bathroom_stalls: number; signage: number; to_go_rolls: number };
export type PrintKind = "table-stickers" | "review-stickers" | "bathroom-stickers" | "bathroom-review-stickers" | "pop-sign" | "togo-label";
export type FigmaAction = "none" | "reuse" | "clone_trim" | "clone_expand";
export type Outcome = "eligible" | "queued" | "done" | "needs_figma_build";

export type PriorRun = {
  run_dir: string;
  slug: string;
  location_id: string;
  request_id: string | null;
  order_type: string | null;
  write_status: string | null;
  branding_complete_evidence: string | null;
  figma: {
    file_key: string | null;
    section_node_id: string | null;
    section_url: string | null;
    section_name: string | null;
    sheet_ids: Record<string, unknown> | null;
    quantities: Partial<Quantities> | null;
    built_at: string | null;
  };
  write: {
    scope: string | null;
    logo_file: string | null;
    sticker_logo_file: string | null;
    logo_attachment_id: string | null;
    secondary_logo: JsonObject | null;
  };
  updated_at: string | null;
  complete: boolean;
  problems: string[];
};

export type LiveBranding = {
  logo_set: boolean;
  scope: "location" | "account" | null;
  logo_attachment_id: string | null;
  prior_full_orders_completed: number;
};

export type AdHocRequestFacts = {
  request_id: string;
  location_id: string;
  account_id: string;
  location_name: string;
  account_name: string;
  created_at: string;
  status: string;
  slack_thread_ts: string | null;
  offer_text: string;
  store_details_confirmed_at: string | null;
  digital_fulfilled_at: string | null;
  shipping: { recipient_name: string | null; address_line1: string | null; city: string | null; state: string | null; zip: string | null; complete: boolean };
  quantities: Quantities;
  items: Array<{ item_type: string; placement: string | null; focus: string | null; quantity: number; printed: boolean }>;
};

export type AdHocState = {
  status: "queued" | "in_progress" | "needs_figma_build" | "done" | "failed";
  outcome?: Outcome;
  reasons?: string[];
  steps?: Record<string, unknown>;
  updated_at?: string;
  error?: string;
};

export type Decision = {
  request_id: string;
  location_id: string;
  location_name: string;
  account_name: string;
  created_at: string;
  live_state: string;
  slug: string;
  run_dir: string;
  outcome: Outcome;
  reasons: string[];
  checks: {
    live_branding_logo: boolean;
    live_branding_scope: string | null;
    store_details_complete: boolean;
    store_details_missing: string[];
    store_details_confirmed: boolean;
    branding_complete_recorded: boolean;
    print_needed: boolean;
    prior_run: string | null;
    prior_run_problems: string[];
  };
  quantities: Quantities;
  prior_quantities: Partial<Quantities> | null;
  print_kinds: PrintKind[];
  figma_action: FigmaAction;
  figma_pages: { tables: number; bathroom: number; prior_tables: number | null; prior_bathroom: number | null };
  figma_section: { file_key: string | null; section_node_id: string | null; section_url: string | null } | null;
  actions: string[];
  slack_thread_ts: string | null;
  existing_adhoc_status: AdHocState["status"] | null;
};

// ---------------------------------------------------------------------------------------------
// Pure decision logic (unit tested)
// ---------------------------------------------------------------------------------------------

export function pagesFor(count: number): number {
  return count > 0 ? Math.ceil(count / STICKERS_PER_PAGE) : 0;
}

export function printKindsFor(q: Quantities): PrintKind[] {
  const kinds: PrintKind[] = [];
  if (q.tables > 0) kinds.push("table-stickers", "review-stickers");
  if (q.bathroom_stalls > 0) kinds.push("bathroom-stickers", "bathroom-review-stickers");
  if (q.signage > 0) kinds.push("pop-sign");
  if (q.to_go_rolls > 0) kinds.push("togo-label");
  return kinds;
}

export function missingShipToFields(shipping: AdHocRequestFacts["shipping"]): string[] {
  const fields: Array<[string, string | null]> = [
    ["recipient", shipping.recipient_name],
    ["line1", shipping.address_line1],
    ["city", shipping.city],
    ["state", shipping.state],
    ["zip", shipping.zip],
  ];
  return fields.filter(([, value]) => !(typeof value === "string" && value.trim())).map(([name]) => name);
}

export function needsOffer(items: AdHocRequestFacts["items"]): boolean {
  return items.some((item) => OFFER_BEARING_ITEM_TYPES.has(item.item_type));
}

/** Mirrors src/lib/fulfillment/status.ts store-details completeness: ship-to plus the offer when printed items carry one. */
export function storeDetailsMissing(request: Pick<AdHocRequestFacts, "shipping" | "items" | "offer_text">): string[] {
  const missing = missingShipToFields(request.shipping);
  if (needsOffer(request.items) && !request.offer_text.trim()) missing.push("offer");
  return missing;
}

export function figmaActionFor(q: Quantities, prior: Partial<Quantities> | null): FigmaAction {
  if (printKindsFor(q).length === 0) return "none";
  if (q.tables === 0 && q.bathroom_stalls === 0) return "reuse";
  const priorTables = Number(prior?.tables ?? 0);
  const priorStalls = Number(prior?.bathroom_stalls ?? 0);
  if (pagesFor(q.tables) === pagesFor(priorTables) && pagesFor(q.bathroom_stalls) === pagesFor(priorStalls)
    && q.tables === priorTables && q.bathroom_stalls === priorStalls) return "reuse";
  if (q.tables <= priorTables && q.bathroom_stalls <= priorStalls) return "clone_trim";
  return "clone_expand";
}

export function adHocSlug(locationName: string, createdAt: string): string {
  const day = String(createdAt).slice(0, 10).replaceAll("-", "");
  return `${slugify(locationName)}-adhoc-${day}`;
}

export function decideAdHoc(input: {
  request: AdHocRequestFacts;
  prior: PriorRun | null;
  branding: LiveBranding;
  runRoot: string;
  existing?: { run_dir: string; adhoc: AdHocState | null } | null;
}): Decision {
  const { request, prior, branding } = input;
  const q = request.quantities;
  const kinds = printKindsFor(q);
  const printNeeded = kinds.length > 0;
  const missing = storeDetailsMissing(request);
  const reasons: string[] = [];
  if (!branding.logo_set) reasons.push("no_prior_branding: live V2 branding has no primary logo for the location or its account");
  if (missing.length) reasons.push(`store_details_incomplete: missing ${missing.join(", ")}`);
  if (printNeeded && !prior) reasons.push("no_prior_run: no completed run with a Figma signage section for this location under the run root");
  if (printNeeded && prior && !prior.complete) reasons.push(`prior_run_incomplete: ${prior.problems.join("; ")}`);
  const figmaAction = printNeeded && prior && prior.complete ? figmaActionFor(q, prior.figma.quantities) : "none";
  const slug = adHocSlug(request.location_name, request.created_at);
  const runDir = input.existing?.run_dir ?? path.join(path.resolve(input.runRoot), slug);
  const existingStatus = input.existing?.adhoc?.status ?? null;
  let outcome: Outcome = reasons.length ? "queued" : "eligible";
  if (existingStatus === "done") outcome = "done";
  else if (outcome === "eligible" && existingStatus === "needs_figma_build") outcome = "needs_figma_build";
  const actions: string[] = [];
  if (outcome === "eligible" || outcome === "needs_figma_build") {
    actions.push(runFileExists(runDir) ? "run_dir: reuse existing" : `run_dir: init ${slug}`);
    if (!request.store_details_confirmed_at) actions.push("store_details: confirm (dry run, then --apply)");
    else actions.push("store_details: already confirmed");
    if (!request.digital_fulfilled_at) actions.push("branding_complete: mark (dry run, then --apply)");
    else actions.push("branding_complete: already recorded (digital_fulfilled_at set)");
    if (figmaAction === "reuse") actions.push(`figma: reuse prior section ${prior?.figma.section_node_id ?? "?"}`);
    else if (figmaAction === "clone_trim") actions.push(`figma: clone prior section to the next free slot and trim to tables=${q.tables} stalls=${q.bathroom_stalls} (build agent)`);
    else if (figmaAction === "clone_expand") actions.push(`figma: clone prior section to the next free slot and expand to tables=${q.tables} stalls=${q.bathroom_stalls} (build agent)`);
    else actions.push("figma: not needed (no printed items)");
    if (printNeeded) actions.push(`print_handoff: export ${kinds.join(",")}, Drive folder, summary row, vendor email sent`);
    else actions.push("print_handoff: not needed (tap cards are made elsewhere)");
    actions.push(request.slack_thread_ts ? "slack: one result post in the request thread" : "slack: no thread, nothing posted");
    actions.push("stamps: review-status done, run-progress done, board note, checklist publish");
  } else if (outcome === "queued") {
    actions.push(runFileExists(runDir) ? "run_dir: reuse existing" : `run_dir: init ${slug} (normal intake request block)`);
    actions.push("stamps: run-progress intake blocked-on <precondition>, review-status waiting, board note, checklist publish");
  }
  return {
    request_id: request.request_id,
    location_id: request.location_id,
    location_name: request.location_name,
    account_name: request.account_name,
    created_at: request.created_at,
    live_state: request.status,
    slug,
    run_dir: runDir,
    outcome,
    reasons,
    checks: {
      live_branding_logo: branding.logo_set,
      live_branding_scope: branding.scope,
      store_details_complete: missing.length === 0,
      store_details_missing: missing,
      store_details_confirmed: request.store_details_confirmed_at != null,
      branding_complete_recorded: request.digital_fulfilled_at != null,
      print_needed: printNeeded,
      prior_run: prior?.run_dir ?? null,
      prior_run_problems: prior?.problems ?? [],
    },
    quantities: q,
    prior_quantities: prior?.figma.quantities ?? null,
    print_kinds: kinds,
    figma_action: figmaAction,
    figma_pages: {
      tables: pagesFor(q.tables),
      bathroom: pagesFor(q.bathroom_stalls),
      prior_tables: prior ? pagesFor(Number(prior.figma.quantities?.tables ?? 0)) : null,
      prior_bathroom: prior ? pagesFor(Number(prior.figma.quantities?.bathroom_stalls ?? 0)) : null,
    },
    figma_section: prior ? { file_key: prior.figma.file_key, section_node_id: prior.figma.section_node_id, section_url: prior.figma.section_url } : null,
    actions,
    slack_thread_ts: request.slack_thread_ts,
    existing_adhoc_status: existingStatus,
  };
}

/** One-line board note for a decision. Never carries ship-to data: only field names. */
export function boardNote(decision: Decision): string {
  const q = decision.quantities;
  const order = [
    q.tap_cards ? `${q.tap_cards} tap cards` : null,
    q.tables ? `${q.tables} tables` : null,
    q.bathroom_stalls ? `${q.bathroom_stalls} stalls` : null,
    q.signage ? `${q.signage} POP sign sets` : null,
    q.to_go_rolls ? `${q.to_go_rolls} to-go rolls` : null,
  ].filter(Boolean).join(", ") || "no items";
  if (decision.outcome === "queued") {
    const why = decision.reasons.map((reason) => reason.split(":")[0].replaceAll("_", " ")).join(", ");
    return `Ad hoc order (${order}) queued for the normal pipeline: ${why}.`;
  }
  if (decision.outcome === "needs_figma_build") {
    return `Ad hoc order (${order}): preconditions met, waiting on the Figma signage build (${decision.figma_action.replace("clone_", "clone and ")}), then the auto path resumes.`;
  }
  if (decision.outcome === "done") return `Ad hoc order (${order}) auto-fulfilled: in physical fulfillment${decision.checks.print_needed ? ", print files sent to customstickers.com" : ""}.`;
  return `Ad hoc order (${order}) eligible for auto-fulfillment.`;
}

export function renderCommands(decision: Decision): string[] {
  const L = BOOSTLY_LINKS_CLI;
  const id = decision.request_id;
  const run = decision.run_dir;
  const lines: string[] = [];
  if (decision.outcome === "queued") {
    lines.push(`run-file init ${run} (request block from the v2-db intake)`);
    lines.push(`node ${RUN_PROGRESS} set --run ${run} --stage intake --last "ad hoc intake" --next "normal pipeline" --blocked-on "<precondition>" --by ${BY}`);
    lines.push(`node ${REVIEW_STATUS} set --run ${run} --status waiting --waiting-on "<precondition>" --by ${BY}`);
    lines.push(`python3 ${REVIEW_CHECKLIST} --run-root ${path.dirname(run)} --no-live --publish-status`);
    return lines;
  }
  if (decision.outcome === "done") return ["nothing: already auto-fulfilled (adhoc.json status done)"];
  lines.push(`run-file init ${run} (request block, request.adhoc links the prior run)`);
  lines.push(`node ${DECRYPT_COOKIE} --out <tmp 0700 dir>/admin.cookie   # never printed`);
  lines.push(`${L} auth check --cookie-file <admin.cookie> --json`);
  lines.push(`${L} fulfillment get ${id} --cookie-file <admin.cookie> --json`);
  if (!decision.checks.store_details_confirmed) {
    lines.push(`${L} fulfillment store-details ${id} --confirm --cookie-file <admin.cookie> --json`);
    lines.push(`${L} fulfillment store-details ${id} --confirm --cookie-file <admin.cookie> --json --apply`);
  }
  if (!decision.checks.branding_complete_recorded) {
    lines.push(`${L} fulfillment branding ${id} --complete --cookie-file <admin.cookie> --json`);
    lines.push(`${L} fulfillment branding ${id} --complete --cookie-file <admin.cookie> --json --apply`);
  }
  lines.push(`${L} fulfillment get ${id} --cookie-file <admin.cookie> --json   # readback`);
  if (decision.figma_action === "reuse") {
    lines.push(`run-file set ${run} figma  # copied from ${decision.checks.prior_run}: section ${decision.figma_section?.section_node_id} in ${decision.figma_section?.file_key}, reused_from_run recorded`);
  } else if (decision.figma_action !== "none") {
    lines.push(`write ${run}/figma-build-brief.md and stop with status needs_figma_build; the run loop launches the Figma build agent (clone ${decision.figma_section?.section_node_id} to the next free slot from a live scan of ${decision.figma_section?.file_key}, then` +
      (decision.figma_action === "clone_trim"
        ? ` node ${FIGMA_TRIM} --section <new id> --tables ${decision.quantities.tables} --stalls ${decision.quantities.bathroom_stalls}, QR decode, stroke gate), which writes the figma block; then rerun this script with --apply --request ${id}`
        : ` expand to ${decision.figma_pages.tables} table pages and ${decision.figma_pages.bathroom} bathroom pages, QR decode, stroke gate), which writes the figma block; then rerun this script with --apply --request ${id}`));
  }
  if (decision.checks.print_needed) {
    lines.push(`run-file set ${run} write  # inherited: prior logo files copied to ${run}/inherited/`);
    lines.push(`node ${PRINT_HANDOFF} --run-dir ${run} --kinds ${decision.print_kinds.join(",")}`);
    lines.push(`${L} fulfillment note ${id} --append 'Figma signage: <section url> (ad hoc, section reused)' --cookie-file <admin.cookie> --json --apply`);
  }
  if (decision.slack_thread_ts) {
    lines.push(`node ${POST_REVIEW} --run-dir ${run} --thread-ts ${decision.slack_thread_ts} --files <prior proof and sheet shots>   # dry run, then --apply (text-only slack.js send when no shots exist)`);
  }
  lines.push(`node ${REVIEW_STATUS} set --run ${run} --status done --ease 1 --by ${BY}`);
  lines.push(`node ${RUN_PROGRESS} set --run ${run} --stage done --last "ad hoc auto-fulfilled" --next "nothing" --clear-blocked --by ${BY}`);
  lines.push(`python3 ${REVIEW_CHECKLIST} --run-root ${path.dirname(run)} --no-live --publish-status`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// File readers (run root scans)
// ---------------------------------------------------------------------------------------------

/** JSON that may be preceded by node warnings or a WARNING line (the CLI receipts under finish/). */
export function parseLooseJson(text: string): unknown {
  const start = text.search(/^[\[{]/m);
  if (start < 0) throw new Error("no JSON object in output");
  return JSON.parse(text.slice(start));
}

function readJsonLoose(file: string): unknown {
  return parseLooseJson(fs.readFileSync(file, "utf8"));
}

export function brandingCompleteEvidence(runDir: string, run: JsonObject): string | null {
  const write = asObject(run.write);
  if (write.branding_complete === true || typeof write.branding_complete_at === "string") return "run.json write.branding_complete";
  const applyReceipt = path.join(runDir, "finish", "branding-complete-apply.json");
  if (fs.existsSync(applyReceipt)) return "finish/branding-complete-apply.json";
  const after = path.join(runDir, "finish", "fulfillment-after.json");
  if (fs.existsSync(after)) {
    try {
      const value = asObject(readJsonLoose(after));
      if (typeof value.digital_fulfilled_at === "string" && value.digital_fulfilled_at) return "finish/fulfillment-after.json digital_fulfilled_at";
    } catch { /* unreadable receipt: no evidence */ }
  }
  return null;
}

export function evaluatePriorRun(runDir: string): PriorRun | null {
  if (!runFileExists(runDir)) return null;
  let run: JsonObject;
  try { run = readRun(runDir) as JsonObject; } catch { return null; }
  const request = asObject(run.request);
  const locationId = typeof request.location_id === "string" ? request.location_id : "";
  if (!locationId) return null;
  const write = asObject(run.write);
  const figma = asObject(run.figma);
  const problems: string[] = [];
  const writeStatus = typeof write.status === "string" ? write.status : null;
  if (writeStatus !== "applied") problems.push(`write.status is ${writeStatus ?? "missing"}, not applied`);
  const evidence = brandingCompleteEvidence(runDir, run);
  if (!evidence) problems.push("branding complete not recorded (no finish receipt)");
  const sectionId = typeof figma.section_node_id === "string" ? figma.section_node_id : null;
  const fileKey = typeof figma.file_key === "string" ? figma.file_key : null;
  if (!sectionId || !fileKey) problems.push("figma block has no section_node_id or file_key");
  const secondary = asObject(write.secondary_logo);
  return {
    run_dir: runDir,
    slug: path.basename(runDir),
    location_id: locationId,
    request_id: typeof request.request_id === "string" ? request.request_id : null,
    order_type: typeof request.order_type === "string" ? request.order_type : null,
    write_status: writeStatus,
    branding_complete_evidence: evidence,
    figma: {
      file_key: fileKey,
      section_node_id: sectionId,
      section_url: typeof figma.section_url === "string" ? figma.section_url : null,
      section_name: typeof figma.section_name === "string" ? figma.section_name : null,
      sheet_ids: figma.sheet_ids != null && typeof figma.sheet_ids === "object" ? figma.sheet_ids as Record<string, unknown> : null,
      quantities: figma.quantities != null && typeof figma.quantities === "object"
        ? figma.quantities as Partial<Quantities>
        : (request.quantities != null && typeof request.quantities === "object" ? request.quantities as Partial<Quantities> : null),
      built_at: typeof figma.built_at === "string" ? figma.built_at : null,
    },
    write: {
      scope: typeof write.scope === "string" ? write.scope : null,
      logo_file: typeof write.logo_file === "string" ? write.logo_file : null,
      sticker_logo_file: typeof write.sticker_logo_file === "string" ? write.sticker_logo_file : (typeof secondary.file === "string" ? secondary.file : null),
      logo_attachment_id: typeof write.logo_attachment_id === "string" ? write.logo_attachment_id : null,
      secondary_logo: Object.keys(secondary).length ? secondary : null,
    },
    updated_at: typeof run.updated_at === "string" ? run.updated_at : null,
    complete: problems.length === 0,
    problems,
  };
}

function runDirsUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name));
}

/** Newest complete prior run for the location (full orders first, then any run), with the best incomplete one as a fallback for reporting. */
export function findPriorRun(roots: string[], locationId: string, excludeRequestId?: string): PriorRun | null {
  const candidates: PriorRun[] = [];
  for (const root of roots) {
    for (const dir of runDirsUnder(root)) {
      const prior = evaluatePriorRun(dir);
      if (!prior || prior.location_id !== locationId) continue;
      if (excludeRequestId && prior.request_id === excludeRequestId) continue;
      candidates.push(prior);
    }
  }
  const byNewest = (a: PriorRun, b: PriorRun) => String(b.figma.built_at ?? b.updated_at ?? "").localeCompare(String(a.figma.built_at ?? a.updated_at ?? ""));
  const complete = candidates.filter((c) => c.complete).sort(byNewest);
  if (complete.length) return complete[0];
  return candidates.sort(byNewest)[0] ?? null;
}

export function readAdHocState(runDir: string): AdHocState | null {
  const file = path.join(runDir, "adhoc.json");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as AdHocState; } catch { return null; }
}

function writeAdHocState(runDir: string, state: AdHocState): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "adhoc.json"), `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

/** The ad hoc run dir for a request id, if one exists (request.request_id match under the run root). */
export function findExistingAdHocRun(root: string, requestId: string): { run_dir: string; adhoc: AdHocState | null } | null {
  for (const dir of runDirsUnder(root)) {
    if (!runFileExists(dir)) continue;
    try {
      const request = asObject((readRun(dir) as JsonObject).request);
      if (request.request_id === requestId) return { run_dir: dir, adhoc: readAdHocState(dir) };
    } catch { /* skip unreadable */ }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Live reads (read-only v2-db replica)
// ---------------------------------------------------------------------------------------------

function dbQuery<T>(sql: string): T[] {
  return JSON.parse(execFileSync(V2_DB, ["query", "--json", "--sql", sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as T[];
}

function literal(value: string): string {
  if (!/^[a-z0-9]+$/.test(value)) throw new Error(`unexpected id ${value}`);
  return `'${value}'`;
}

export function readLiveBranding(locationId: string, accountId: string): LiveBranding {
  const rows = dbQuery<{ location_id: string | null; account_id: string; logo_attachment_id: string | null }>(
    `select b.location_id, b.account_id, b.logo_attachment_id from branding b
     where b.location_id = ${literal(locationId)} or (b.account_id = ${literal(accountId)} and b.location_id is null)
     order by b.location_id nulls last`,
  );
  const withLogo = rows.filter((row) => typeof row.logo_attachment_id === "string" && row.logo_attachment_id);
  const pick = withLogo.find((row) => row.location_id === locationId) ?? withLogo[0] ?? null;
  const prior = dbQuery<{ n: number | string }>(
    `select count(*) n from fulfillment_requests fr where fr.location_id = ${literal(locationId)}
     and fr.order_type::text = 'full_order' and fr.canceled_at is null and fr.digital_fulfilled_at is not null`,
  );
  return {
    logo_set: pick != null,
    scope: pick ? (pick.location_id === locationId ? "location" : "account") : null,
    logo_attachment_id: pick?.logo_attachment_id ?? null,
    prior_full_orders_completed: Number(prior[0]?.n ?? 0),
  };
}

export function factsFromCanonical(request: CanonicalRequest): AdHocRequestFacts {
  return {
    request_id: request.fulfillment_request_id,
    location_id: request.expected_location_id,
    account_id: request.expected_account_id,
    location_name: request.fields.location_name,
    account_name: request.fields.account_name,
    created_at: request.created_at,
    status: request.status,
    slack_thread_ts: request.slack_thread_ts,
    offer_text: request.fields.offer ?? "",
    store_details_confirmed_at: request.store_details_confirmed_at,
    digital_fulfilled_at: null,
    shipping: {
      recipient_name: request.shipping.recipient_name,
      address_line1: request.shipping.address_line1,
      city: request.shipping.city,
      state: request.shipping.state,
      zip: request.shipping.zip,
      complete: request.shipping.complete,
    },
    quantities: request.quantities,
    items: request.items,
  };
}

/** Open ad hoc requests in the three pre-print lanes, oldest first (printing_label means everything is printed already). */
export function listOpenAdHoc(options: { stateFile?: string; requestId?: string } = {}): Array<{ canonical: CanonicalRequest; facts: AdHocRequestFacts }> {
  const result = listBrandingRequests({ status: "open", includeAdHoc: true, adHocOnly: true, stateFile: options.stateFile });
  const ids = result.requests.map((request) => request.fulfillment_request_id);
  const fulfilled = ids.length
    ? dbQuery<{ id: string; digital_fulfilled_at: string | null }>(`select id, digital_fulfilled_at from fulfillment_requests where id in (${ids.map(literal).join(",")})`)
    : [];
  const fulfilledAt = new Map(fulfilled.map((row) => [row.id, row.digital_fulfilled_at]));
  return result.requests
    .filter((request) => request.status !== "printing_label")
    .filter((request) => !options.requestId || request.fulfillment_request_id === options.requestId)
    .map((request) => {
      const facts = factsFromCanonical(request);
      facts.digital_fulfilled_at = fulfilledAt.get(request.fulfillment_request_id) ?? null;
      return { canonical: request, facts };
    });
}

// ---------------------------------------------------------------------------------------------
// Apply helpers
// ---------------------------------------------------------------------------------------------

type Cookie = { dir: string; admin: string };

function runCapture(file: string, args: string[], options: { cwd?: string; allowFail?: boolean } = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(file, args, { encoding: "utf8", cwd: options.cwd, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number; message?: string };
    if (options.allowFail) return { stdout: `${err.stdout ?? ""}\n${err.stderr ?? ""}`, status: err.status ?? 1 };
    throw new Error(`${path.basename(file)} ${args.filter((a) => !a.includes("cookie")).slice(0, 6).join(" ")} failed (exit ${err.status ?? "?"}): ${redact(`${err.stdout ?? ""}\n${err.stderr ?? ""}`).slice(-1500)}`);
  }
}

/** Keep secrets out of logs and reports: anything that looks like a cookie header, token, or key. */
export function redact(text: string): string {
  return text
    .replace(/(cookie|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2<redacted>")
    .replace(/xox[abp]-[A-Za-z0-9-]+/g, "<redacted>");
}

function mintCookie(): Cookie {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adhoc-cookie-"));
  fs.chmodSync(dir, 0o700);
  const admin = path.join(dir, "admin.cookie");
  runCapture("node", [DECRYPT_COOKIE, "--out", admin]);
  const check = asObject(parseLooseJson(runCapture(BOOSTLY_LINKS_CLI, ["auth", "check", "--cookie-file", admin, "--json"]).stdout));
  if (check.ok === false || check.authenticated === false) throw new Error("auth check failed for the minted cookie");
  return { dir, admin };
}

function dropCookie(cookie: Cookie | null): void {
  if (cookie && cookie.dir.includes("adhoc-cookie-")) fs.rmSync(cookie.dir, { recursive: true, force: true });
}

function saveReceipt(runDir: string, name: string, text: string): string {
  const dir = path.join(runDir, "finish");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, redact(text), { mode: 0o600 });
  return file;
}

function fulfillmentGet(cookie: Cookie, requestId: string, runDir: string, name: string): JsonObject {
  const out = runCapture(BOOSTLY_LINKS_CLI, ["fulfillment", "get", requestId, "--cookie-file", cookie.admin, "--json"]).stdout;
  saveReceipt(runDir, name, out);
  return asObject(parseLooseJson(out));
}

function fulfillmentFlip(cookie: Cookie, requestId: string, runDir: string, kind: "store-details" | "branding"): { dry: JsonObject; apply: JsonObject } {
  const flag = kind === "store-details" ? "--confirm" : "--complete";
  const stem = kind === "store-details" ? "store-details" : "branding-complete";
  const dryOut = runCapture(BOOSTLY_LINKS_CLI, ["fulfillment", kind, requestId, flag, "--cookie-file", cookie.admin, "--json"]).stdout;
  saveReceipt(runDir, `${stem}-dry.json`, dryOut);
  const dry = asObject(parseLooseJson(dryOut));
  const applyOut = runCapture(BOOSTLY_LINKS_CLI, ["fulfillment", kind, requestId, flag, "--cookie-file", cookie.admin, "--json", "--apply"]).stdout;
  saveReceipt(runDir, `${stem}-apply.json`, applyOut);
  return { dry, apply: asObject(parseLooseJson(applyOut)) };
}

function stampProgress(runDir: string, stage: string, last: string, next: string, blockedOn: string | null): void {
  const args = [RUN_PROGRESS, "set", "--run", runDir, "--stage", stage, "--last", last, "--next", next, "--by", BY];
  args.push(...(blockedOn ? ["--blocked-on", blockedOn] : ["--clear-blocked"]));
  const result = runCapture("node", args, { allowFail: true });
  if (result.status !== 0) process.stderr.write(`run-progress publish failed (local file may still be written): ${redact(result.stdout).trim().slice(-300)}\n`);
}

function stampStatus(runDir: string, status: "waiting" | "done", waitingOn: string, ease: number | null): void {
  const args = [REVIEW_STATUS, "set", "--run", runDir, "--status", status, "--by", BY];
  if (waitingOn) args.push("--waiting-on", waitingOn); else args.push("--clear-waiting-on");
  if (ease != null) args.push("--ease", String(ease));
  runCapture("node", args);
}

function setBoardNote(runRoot: string, slug: string, note: string): void {
  const dir = path.join(runRoot, "checklist");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "notes.json");
  const notes = fs.existsSync(file) ? asObject(JSON.parse(fs.readFileSync(file, "utf8"))) : {};
  notes[slug] = note;
  fs.writeFileSync(file, `${JSON.stringify(notes, null, 1)}\n`, { mode: 0o600 });
}

function refreshBoard(runRoot: string): void {
  const result = runCapture("python3", [REVIEW_CHECKLIST, "--run-root", runRoot, "--no-live", "--publish-status"], { allowFail: true });
  if (result.status !== 0) process.stderr.write(`review-checklist refresh failed: ${redact(result.stdout).trim().slice(-300)}\n`);
}

function ensureRunDir(decision: Decision, canonical: CanonicalRequest, prior: PriorRun | null): void {
  if (runFileExists(decision.run_dir)) return;
  const request = requestBlockFromCanonical(canonical as unknown as JsonObject);
  request.adhoc = {
    created_by: BY,
    prior_run_dir: prior?.run_dir ?? null,
    prior_run_slug: prior?.slug ?? null,
    prior_request_id: prior?.request_id ?? null,
    figma_action: decision.figma_action,
    print_kinds: decision.print_kinds,
  };
  initRun({ runDir: decision.run_dir, request });
}

function figmaBuildBrief(decision: Decision, prior: PriorRun): string {
  const q = decision.quantities;
  const target = fs.existsSync(FIGMA_TARGET) ? asObject(JSON.parse(fs.readFileSync(FIGMA_TARGET, "utf8"))) : {};
  return [
    `# Figma build brief: ad hoc order for ${decision.location_name}`,
    "",
    `Request ${decision.request_id}, run dir ${decision.run_dir}.`,
    `Prior section: ${prior.figma.section_url ?? prior.figma.section_node_id} (file ${prior.figma.file_key}, run ${prior.run_dir}).`,
    `Action: ${decision.figma_action === "clone_trim" ? "clone and trim" : "clone and expand"}.`,
    `New quantities: tables=${q.tables} (${decision.figma_pages.tables} pages), stalls=${q.bathroom_stalls} (${decision.figma_pages.bathroom} pages), signage=${q.signage}, to-go rolls=${q.to_go_rolls}.`,
    `Prior quantities: tables=${prior.figma.quantities?.tables ?? "?"}, stalls=${prior.figma.quantities?.bathroom_stalls ?? "?"}.`,
    "",
    "Steps (closeout-location Figma step, no branding or logo decision):",
    `1. Live REST scan of the current target file ${String(target.file_key ?? "")} (${String(target.file_name ?? "")}); take the next free slot from the scan, never a typed number.`,
    `2. Clone the prior section into that slot (same file when the prior section is in the current file; otherwise copy the prior section across files with the cross-file template recipe), rename it "${decision.location_name} - ad hoc production sheets ${new Date().toISOString().slice(0, 10)}".`,
    decision.figma_action === "clone_trim"
      ? `3. node ${FIGMA_TRIM} --section <new id> --tables ${q.tables} --stalls ${q.bathroom_stalls}; paste as the use_figma code; strokeGateFixed must be empty.`
      : `3. Expand to ${decision.figma_pages.tables} table pages and ${decision.figma_pages.bathroom} bathroom pages by duplicating the last page of each kind and renumbering the stickers (the closeout 16-table and 35-table expansions are the pattern); run the stroke gate.`,
    "4. QR decode every sticker and POP QR in the new section against the location's touchpoint URLs, as closeouts do.",
    `5. Write the figma block of ${decision.run_dir}/run.json (run-file set) with file_key, section_node_id, section_url, section_name, sheet_ids, quantities, qr, stroke_gate, built_at, and reused_from_run = "${prior.run_dir}".`,
    `6. Rerun: node --experimental-strip-types ${path.join(HERE, "adhoc-fulfillment.ts")} --run-root ${path.dirname(decision.run_dir)} --apply --request ${decision.request_id}`,
    "",
    "No Figma approval stop on this path (Travisse 2026-10-14). Never edit the prior section.",
  ].join("\n");
}

function copyInheritedLogos(decision: Decision, prior: PriorRun): JsonObject {
  const dest = path.join(decision.run_dir, "inherited");
  fs.mkdirSync(dest, { recursive: true });
  const copy = (rel: string | null): string | null => {
    if (!rel) return null;
    const src = path.join(prior.run_dir, rel);
    if (!fs.existsSync(src)) return null;
    const name = path.basename(rel);
    fs.copyFileSync(src, path.join(dest, name));
    return path.posix.join("inherited", name);
  };
  const logo = copy(prior.write.logo_file);
  const sticker = copy(prior.write.sticker_logo_file);
  return {
    status: "applied",
    inherited: true,
    branding_source_run: prior.run_dir,
    scope: prior.write.scope,
    logo_attachment_id: prior.write.logo_attachment_id,
    logo_file: logo,
    sticker_logo_file: sticker,
    secondary_logo: prior.write.secondary_logo ? { ...prior.write.secondary_logo, file: sticker ?? prior.write.secondary_logo.file } : null,
    note: `Ad hoc order: branding unchanged, logo files copied from ${prior.slug} for the print hand-off.`,
    applied_at: new Date().toISOString(),
  };
}

function reusedFigmaBlock(prior: PriorRun, decision: Decision): JsonObject {
  return {
    status: "built",
    approved: true,
    reused_from_run: prior.run_dir,
    reuse_note: `Ad hoc order ${decision.request_id}: prior section reused unchanged (${decision.figma_action}); QR decode and stroke gate were verified at the prior close-out.`,
    file: `${prior.figma.file_key}`,
    file_key: prior.figma.file_key,
    section_node_id: prior.figma.section_node_id,
    section_url: prior.figma.section_url,
    section_name: prior.figma.section_name,
    sheet_ids: prior.figma.sheet_ids ?? {},
    quantities: prior.figma.quantities ?? {},
    adhoc_quantities: decision.quantities,
    print_kinds: decision.print_kinds,
    built_at: prior.figma.built_at,
  };
}

function slackNote(decision: Decision, prior: PriorRun | null, handoff: JsonObject | null, figma: JsonObject | null): string {
  const q = decision.quantities;
  const order = [
    q.tap_cards ? `${q.tap_cards} tap cards` : null,
    q.tables ? `${q.tables} table sticker sets` : null,
    q.bathroom_stalls ? `${q.bathroom_stalls} bathroom strip sets` : null,
    q.signage ? `${q.signage} POP sign sets` : null,
    q.to_go_rolls ? `${q.to_go_rolls} to-go label rolls` : null,
  ].filter(Boolean).join(", ");
  const lines = [
    `Ad hoc in-store order for ${decision.location_name}: ${order}.`,
    "Branding and store details were already complete, so this went straight to physical fulfillment (no changes to the live branding).",
  ];
  if (prior) lines.push(`Signage master: the ${prior.slug} close-out section${figma?.section_url ? ` ${String(figma.section_url)}` : ""}${decision.figma_action === "reuse" ? " (reused unchanged)" : " (cloned and re-laid out for the new quantities)"}.`);
  if (handoff) {
    const drive = asObject(handoff.drive);
    const sheets = asObject(handoff.sheets);
    const pages = Object.entries(sheets).map(([kind, value]) => `${kind} ${String(asObject(value).pages ?? "?")}p`).join(", ");
    lines.push(`Print files: ${String(drive.folder_link ?? "(Drive folder)")} (${pages}); vendor email sent to customstickers.com.`);
  } else if (!decision.checks.print_needed) {
    lines.push("Nothing to print here (tap cards are made elsewhere).");
  }
  lines.push("Posted by the ad hoc auto-fulfillment path (box-fulfillment skill, 2026-10-14).");
  return lines.join("\n");
}

function postSlack(decision: Decision, prior: PriorRun | null, note: string): JsonObject {
  const runDir = decision.run_dir;
  const threadTs = decision.slack_thread_ts;
  if (!threadTs) return { skipped: "no slack_thread_ts" };
  fs.writeFileSync(path.join(runDir, "slack-note.txt"), `${note}\n`);
  const receipt = path.join(runDir, "slack-post.json");
  if (fs.existsSync(receipt)) return { already_posted: true, ...asObject(JSON.parse(fs.readFileSync(receipt, "utf8"))) };
  const shots: string[] = [];
  if (prior) {
    const wanted = ["proof.png", "signage/shots/pop-primary.png", "signage/shots/table-p1.png", "signage/shots/bathroom-p1.png"];
    for (const rel of wanted) {
      const file = path.join(prior.run_dir, rel);
      if (!fs.existsSync(file)) continue;
      if (rel.includes("table") && decision.quantities.tables === 0) continue;
      if (rel.includes("bathroom") && decision.quantities.bathroom_stalls === 0) continue;
      if (rel.includes("pop") && decision.quantities.signage === 0) continue;
      shots.push(file);
    }
  }
  if (shots.length) {
    const base = [POST_REVIEW, "--run-dir", runDir, "--thread-ts", threadTs, "--channel", SLACK_CHANNEL, "--files", shots.join(",")];
    saveReceipt(runDir, "slack-dry.log", runCapture("node", base).stdout);
    const out = runCapture("node", [...base, "--apply"]).stdout;
    saveReceipt(runDir, "slack-apply.log", out);
    const posted = fs.existsSync(receipt) ? asObject(JSON.parse(fs.readFileSync(receipt, "utf8"))) : {};
    return { thread_ts: threadTs, channel: SLACK_CHANNEL, posted_at: new Date().toISOString(), message_ts: posted.message_ts ?? posted.ts ?? null, files: posted.files ?? [], via: "post-review.mjs" };
  }
  // No shots to attach (no prior run on this machine): text-only reply through the Slack CLI.
  const out = runCapture("node", [SLACK_JS, "send", SLACK_WORKSPACE, SLACK_CHANNEL, note, "--thread", threadTs]).stdout;
  saveReceipt(runDir, "slack-apply.log", out);
  let messageTs: string | null = null;
  try { const value = asObject(parseLooseJson(out)); messageTs = typeof value.ts === "string" ? value.ts : null; } catch { /* non-JSON CLI output */ }
  const record = { thread_ts: threadTs, channel: SLACK_CHANNEL, posted_at: new Date().toISOString(), message_ts: messageTs, via: "slack.js send" };
  fs.writeFileSync(receipt, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

function handoffKindsOk(handoff: JsonObject, kinds: PrintKind[]): string[] {
  const problems: string[] = [];
  const sheets = asObject(handoff.sheets);
  for (const kind of kinds) {
    const sheet = asObject(sheets[kind]);
    if (!Object.keys(sheet).length) { problems.push(`${kind}: not exported`); continue; }
    if (sheet.vector !== true) problems.push(`${kind}: not vector`);
    if (sheet.pages !== sheet.expected_pages) problems.push(`${kind}: ${String(sheet.pages)}/${String(sheet.expected_pages)} pages`);
  }
  const draft = asObject(handoff.draft);
  if (!draft.id) problems.push("vendor email: no draft id");
  if (draft.sent !== true) problems.push("vendor email: not sent");
  if (!asObject(handoff.drive).folder_link) problems.push("drive: no folder link");
  return problems;
}

function applyEligible(decision: Decision, canonical: CanonicalRequest, prior: PriorRun | null, runRoot: string): Decision {
  ensureRunDir(decision, canonical, prior);
  const runDir = decision.run_dir;
  const state: AdHocState = readAdHocState(runDir) ?? { status: "in_progress", steps: {} };
  state.status = "in_progress";
  state.outcome = decision.outcome;
  state.steps = state.steps ?? {};
  writeAdHocState(runDir, state);
  stampProgress(runDir, "closeout-finish", "ad hoc auto-fulfillment started", "store details, branding complete, print hand-off", null);
  let cookie: Cookie | null = null;
  try {
    cookie = mintCookie();
    const before = fulfillmentGet(cookie, decision.request_id, runDir, "fulfillment-before.json");
    const liveLocation = asObject(before.location);
    if (liveLocation.id && liveLocation.id !== decision.location_id) throw new Error(`live request location ${String(liveLocation.id)} differs from ${decision.location_id}`);
    // 1. Store details confirm (pre-authorized when the ship-to is complete; Travisse 2026-10-01 and 2026-10-14).
    if (before.store_details_confirmed_at) {
      state.steps.store_details = { status: "already_confirmed", at: before.store_details_confirmed_at };
    } else if (before.shipping_address_complete === false) {
      throw new Error("live ship-to is incomplete on the request; not confirming (queue it)");
    } else {
      const flip = fulfillmentFlip(cookie, decision.request_id, runDir, "store-details");
      state.steps.store_details = { status: "confirmed", state_before: flip.dry.state_before ?? null, state_after: flip.apply.state_after ?? null };
    }
    writeAdHocState(runDir, state);
    // 2. Branding complete (ad hoc orders usually carry digital_fulfilled_at from creation; this is the fallback).
    if (before.digital_fulfilled_at) {
      state.steps.branding_complete = { status: "already_recorded", at: before.digital_fulfilled_at };
    } else {
      const flip = fulfillmentFlip(cookie, decision.request_id, runDir, "branding");
      state.steps.branding_complete = { status: "applied", state_before: flip.dry.state_before ?? null, state_after: flip.apply.state_after ?? null, enters_physical_fulfillment: flip.dry.enters_physical_fulfillment ?? null };
    }
    const after = fulfillmentGet(cookie, decision.request_id, runDir, "fulfillment-after.json");
    state.steps.live_state_after = after.state ?? null;
    writeAdHocState(runDir, state);
    // 3. Figma section.
    let figma: JsonObject | null = null;
    let handoff: JsonObject | null = null;
    if (decision.checks.print_needed) {
      if (!prior) throw new Error("print needed but no prior run (decision should have queued this)");
      const run = readRun(runDir) as JsonObject;
      const existingFigma = asObject(run.figma);
      if (existingFigma.section_node_id && existingFigma.file_key) {
        figma = existingFigma;
        state.steps.figma = { status: "present", section_node_id: existingFigma.section_node_id, source: existingFigma.reused_from_run ? "reused" : "built by agent" };
      } else if (decision.figma_action === "reuse") {
        figma = reusedFigmaBlock(prior, decision);
        setBlock(runDir, "figma", figma, { by: BY });
        state.steps.figma = { status: "reused", section_node_id: figma.section_node_id };
      } else {
        const brief = figmaBuildBrief(decision, prior);
        fs.writeFileSync(path.join(runDir, "figma-build-brief.md"), `${brief}\n`);
        state.status = "needs_figma_build";
        state.steps.figma = { status: "needs_build", action: decision.figma_action, brief: "figma-build-brief.md" };
        writeAdHocState(runDir, state);
        stampProgress(runDir, "closeout", "ad hoc preconditions met; store details and branding complete", `Figma ${decision.figma_action.replace("clone_", "clone and ")} by the build agent, then rerun adhoc-fulfillment --apply`, null);
        stampStatus(runDir, "waiting", "Figma signage build (agent)", null);
        setBoardNote(runRoot, decision.slug, boardNote({ ...decision, outcome: "needs_figma_build" }));
        refreshBoard(runRoot);
        return { ...decision, outcome: "needs_figma_build" };
      }
      // 4. Inherited logo files for the hand-off, then the hand-off itself (ordered kinds only).
      const run2 = readRun(runDir) as JsonObject;
      if (!Object.keys(asObject(run2.write)).length) setBlock(runDir, "write", copyInheritedLogos(decision, prior), { by: BY });
      const out = runCapture("node", [PRINT_HANDOFF, "--run-dir", runDir, "--kinds", decision.print_kinds.join(",")]).stdout;
      saveReceipt(runDir, "print-handoff.log", out);
      const handoffFile = path.join(runDir, "print-handoff", "handoff.json");
      handoff = fs.existsSync(handoffFile) ? asObject(JSON.parse(fs.readFileSync(handoffFile, "utf8"))) : {};
      const problems = handoffKindsOk(handoff, decision.print_kinds);
      if (problems.length) throw new Error(`print hand-off incomplete: ${problems.join("; ")}`);
      const drive = asObject(handoff.drive);
      const draft = asObject(handoff.draft);
      state.steps.print_handoff = { status: "sent", folder_link: drive.folder_link ?? null, draft_id: draft.id ?? null, message_id: draft.message_id ?? null, kinds: decision.print_kinds };
      writeAdHocState(runDir, state);
      // 5. Cam's lookup convention: the section URL on the request's internal notes.
      if (figma?.section_url) {
        const line = `Figma signage: ${String(figma.section_url)} (ad hoc order, ${decision.figma_action === "reuse" ? "section reused" : "section cloned"})`;
        const noteOut = runCapture(BOOSTLY_LINKS_CLI, ["fulfillment", "note", decision.request_id, "--append", line, "--cookie-file", cookie.admin, "--json", "--apply"], { allowFail: true });
        saveReceipt(runDir, "figma-note.json", noteOut.stdout);
        state.steps.figma_note = { status: noteOut.status === 0 ? "appended" : "failed" };
      }
    } else {
      state.steps.figma = { status: "not_needed" };
      state.steps.print_handoff = { status: "not_needed" };
    }
    // 6. The one Slack result.
    const slack = postSlack(decision, prior, slackNote(decision, prior, handoff, figma));
    if (!slack.skipped && !slack.already_posted) setBlock(runDir, "slack", slack, { by: BY });
    state.steps.slack = slack;
    // 7. Stamps, board, validation.
    stampStatus(runDir, "done", "", 1);
    stampProgress(runDir, "done", "ad hoc auto-fulfilled: in physical fulfillment" + (handoff ? ", print files sent" : ""), "nothing", null);
    const errors = validateRun(readRun(runDir));
    if (errors.length) throw new Error(`run.json invalid after the ad hoc run: ${errors.join("; ")}`);
    state.status = "done";
    state.outcome = "done";
    writeAdHocState(runDir, state);
    setBoardNote(runRoot, decision.slug, boardNote({ ...decision, outcome: "done" }));
    refreshBoard(runRoot);
    return { ...decision, outcome: "done" };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    state.status = "failed";
    state.error = message;
    writeAdHocState(runDir, state);
    stampProgress(runDir, "closeout-finish", "ad hoc auto-fulfillment failed", "lead reads adhoc.json error and reruns", "auto path failed; see adhoc.json");
    setBoardNote(runRoot, decision.slug, `Ad hoc auto-fulfillment failed: ${message.split("\n")[0].slice(0, 160)}`);
    refreshBoard(runRoot);
    throw new Error(`${decision.location_name}: ${message}`);
  } finally {
    dropCookie(cookie);
  }
}

function applyQueued(decision: Decision, canonical: CanonicalRequest, prior: PriorRun | null, runRoot: string): void {
  ensureRunDir(decision, canonical, prior);
  const runDir = decision.run_dir;
  const why = decision.reasons.map((reason) => reason.split(":")[0].replaceAll("_", " ")).join(", ");
  writeAdHocState(runDir, { status: "queued", outcome: "queued", reasons: decision.reasons, steps: {} });
  stampProgress(runDir, "intake", "ad hoc intake: auto path preconditions failed", "normal pipeline (fulfill-location)", why);
  stampStatus(runDir, "waiting", why, null);
  setBoardNote(runRoot, decision.slug, boardNote(decision));
  refreshBoard(runRoot);
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function autoApplyEnabled(env: NodeJS.ProcessEnv = process.env, envFile: string = WORKSPACE_ENV_FILE): boolean {
  if (env.ADHOC_AUTO_APPLY != null) return /^(1|true|on|yes)$/i.test(env.ADHOC_AUTO_APPLY.trim());
  if (fs.existsSync(envFile)) {
    const match = fs.readFileSync(envFile, "utf8").match(/^\s*(?:export\s+)?ADHOC_AUTO_APPLY\s*=\s*["']?([^"'\n#]+)/m);
    if (match) return /^(1|true|on|yes)$/i.test(match[1].trim());
  }
  return false;
}

function parseArgs(argv: string[]): Record<string, string | boolean | string[]> {
  const args: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) { args[key] = true; continue; }
    index += 1;
    if (key === "also-root") args[key] = [...(Array.isArray(args[key]) ? args[key] as string[] : []), value];
    else args[key] = value;
  }
  return args;
}

function decisionTable(decisions: Decision[]): string {
  const rows = decisions.map((d) => [
    d.location_name,
    d.request_id.slice(0, 8),
    d.live_state,
    `cards=${d.quantities.tap_cards} tables=${d.quantities.tables} stalls=${d.quantities.bathroom_stalls} pop=${d.quantities.signage} togo=${d.quantities.to_go_rolls}`,
    d.outcome,
    d.figma_action,
    d.checks.prior_run ? path.basename(d.checks.prior_run) : "-",
    d.reasons.length ? d.reasons.map((r) => r.split(":")[0]).join(",") : "ok",
  ]);
  const header = ["location", "request", "lane", "quantities", "decision", "figma", "prior run", "reasons"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write([
      "Usage: adhoc-fulfillment.ts --run-root <dir> [--dry-run | --apply [--go]] [--request <id>] [--also-root <dir>]...",
      "         [--state-file <path>] [--json] [--out <report.json>]",
      "Ad hoc orders: auto-fulfill when branding and store details are complete, else queue. Dry run by default.",
      "--apply needs ADHOC_AUTO_APPLY=1 (environment or the workspace .env) or --go for a session-authorized run.",
    ].join("\n") + "\n");
    return;
  }
  if (typeof args["run-root"] !== "string") throw new Error("--run-root <dir> is required");
  const runRoot = path.resolve(args["run-root"]);
  const roots = [runRoot, ...(Array.isArray(args["also-root"]) ? (args["also-root"] as string[]).map((r) => path.resolve(r)) : [])];
  const apply = args.apply === true;
  if (apply && args["dry-run"] === true) throw new Error("pass --apply or --dry-run, not both");
  if (apply && !(autoApplyEnabled() || args.go === true)) {
    throw new Error("--apply refused: ADHOC_AUTO_APPLY is off. Set ADHOC_AUTO_APPLY=1 in the environment or in " + WORKSPACE_ENV_FILE + " (the run loop switch), or pass --go for a run Travisse authorized in the session.");
  }
  const stateFile = typeof args["state-file"] === "string" ? path.resolve(args["state-file"]) : HEARTBEAT_STATE_FILE;
  const requestId = typeof args.request === "string" ? args.request : undefined;
  const open = listOpenAdHoc({ stateFile, requestId });
  const decisions: Decision[] = [];
  const failures: string[] = [];
  let needsBuild = 0;
  for (const { canonical, facts } of open) {
    const existing = findExistingAdHocRun(runRoot, facts.request_id);
    const prior = findPriorRun(roots, facts.location_id, facts.request_id);
    const branding = readLiveBranding(facts.location_id, facts.account_id);
    const decision = decideAdHoc({ request: facts, prior, branding, runRoot, existing });
    if (!apply) { decisions.push(decision); continue; }
    try {
      if (decision.outcome === "done") decisions.push(decision);
      else if (decision.outcome === "queued") { applyQueued(decision, canonical, prior, runRoot); decisions.push(decision); }
      else {
        const result = applyEligible(decision, canonical, prior, runRoot);
        if (result.outcome === "needs_figma_build") needsBuild += 1;
        decisions.push(result);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      decisions.push({ ...decision, reasons: [...decision.reasons, `failed: ${error instanceof Error ? error.message : String(error)}`] });
    }
  }
  const report = { mode: apply ? "apply" : "dry-run", run_root: runRoot, fetched_at: new Date().toISOString(), decisions, failures };
  if (typeof args.out === "string") fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (args.json === true) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }
  else {
    process.stdout.write(`${apply ? "APPLY" : "DRY RUN"}: ${decisions.length} open ad hoc request(s) under ${runRoot}\n\n`);
    process.stdout.write(decisions.length ? `${decisionTable(decisions)}\n` : "none\n");
    for (const decision of decisions) {
      process.stdout.write(`\n== ${decision.location_name} (${decision.request_id}) -> ${decision.outcome}\n`);
      process.stdout.write(`   run dir: ${decision.run_dir}\n`);
      if (decision.checks.prior_run) process.stdout.write(`   prior run: ${decision.checks.prior_run}${decision.figma_section?.section_node_id ? ` (section ${decision.figma_section.section_node_id} in ${decision.figma_section.file_key})` : ""}\n`);
      process.stdout.write(`   checks: logo=${decision.checks.live_branding_logo}${decision.checks.live_branding_scope ? ` (${decision.checks.live_branding_scope})` : ""} store_details=${decision.checks.store_details_complete}${decision.checks.store_details_missing.length ? ` (missing ${decision.checks.store_details_missing.join(",")})` : ""} confirmed=${decision.checks.store_details_confirmed} branding_complete=${decision.checks.branding_complete_recorded} print_needed=${decision.checks.print_needed}\n`);
      for (const reason of decision.reasons) process.stdout.write(`   reason: ${reason}\n`);
      for (const action of decision.actions) process.stdout.write(`   action: ${action}\n`);
      if (!apply) for (const command of renderCommands(decision)) process.stdout.write(`   $ ${command}\n`);
    }
    if (failures.length) process.stdout.write(`\nfailures:\n${failures.map((f) => `  ${f}`).join("\n")}\n`);
  }
  if (failures.length) process.exitCode = 1;
  else if (needsBuild) process.exitCode = 3;
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
