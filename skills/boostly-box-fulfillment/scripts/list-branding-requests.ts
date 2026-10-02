#!/usr/bin/env node
// Pipeline step 1: pull open fulfillment requests from the V2 read replica and emit them in the
// canonical request shape the rest of the deterministic pipeline consumes. Replaced the Slack
// parser (parse-boosted-box-requests.mjs, deleted 2026-09-16) as the intake source.
//
// The "Branding" lane in /admin/fulfillment is a derived state, not a column. It mirrors
// src/lib/fulfillment/status.ts on origin/main: canceled_at IS NULL, tracking_number IS NULL,
// digital_fulfilled_at IS NULL => digital_fulfillment (labelled "Branding" in the admin UI).
//
// Read-only: every query goes through the replica-only v2-db CLI. Nothing here writes production,
// Slack, Notion, audit, or state.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import type { FulfillmentRequestIdentity, LocationCandidate } from "./location-match.ts";
import { initRun, requestBlockFromCanonical, runFileExists, runFilePath, slugify } from "./run-file.ts";
import { HEARTBEAT_STATE_FILE, V2_DB } from "./paths.ts";

const DB = V2_DB;
export const DEFAULT_STATE_FILE = HEARTBEAT_STATE_FILE;

export type OpenFulfillmentState = "digital_fulfillment" | "store_details" | "physical_fulfillment" | "printing_label";
export type RequestedStatus = OpenFulfillmentState | "open";
export const DEFAULT_STATUS: RequestedStatus = "digital_fulfillment";
const STATUS_ALIASES: Record<string, RequestedStatus> = {
  branding: "digital_fulfillment",
  digital: "digital_fulfillment",
  "digital-fulfillment": "digital_fulfillment",
  digital_fulfillment: "digital_fulfillment",
  "store-details": "store_details",
  store_details: "store_details",
  physical: "physical_fulfillment",
  "physical-fulfillment": "physical_fulfillment",
  physical_fulfillment: "physical_fulfillment",
  "printing-label": "printing_label",
  printing_label: "printing_label",
  open: "open",
};
const STATUS_LABELS: Record<OpenFulfillmentState, string> = {
  digital_fulfillment: "Branding",
  store_details: "Store Details",
  physical_fulfillment: "Physical Fulfillment",
  printing_label: "Printing Label",
};
const OFFER_BEARING_ITEM_TYPES = new Set(["signage", "stickers"]);

export type DatabaseItem = {
  item_type: string;
  placement: string | null;
  focus: string | null;
  quantity: number;
  printed_at: string | null;
};

export type DatabaseRequestRow = {
  request_id: string;
  created_at: string;
  updated_at: string;
  order_type: string;
  notes: string | null;
  offer_text: string | null;
  offer_promotion_id: string | null;
  slack_thread_ts: string | null;
  onboarding_session_id: string | null;
  store_details_confirmed_at: string | null;
  digital_fulfilled_at: string | null;
  canceled_at: string | null;
  tracking_number: string | null;
  tracking_status: string | null;
  account_id: string;
  account_name: string;
  account_status: string;
  csm_name: string | null;
  csm_email: string | null;
  requested_by_name: string | null;
  requested_by_email: string | null;
  location_id: string;
  location_name: string;
  location_status: string;
  address: string | null;
  website_url: string | null;
  ordering_url: string | null;
  google_place_id: string | null;
  is_general: boolean;
  shipping_recipient_name: string | null;
  shipping_address_line1: string | null;
  shipping_address_line2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_zip: string | null;
  items: DatabaseItem[] | null;
};

export type CanonicalRequest = {
  source: "v2-db";
  request_key: string;
  fulfillment_request_id: string;
  canonical_thread_ts: string;
  paired_message_ts: string[];
  request_types: string[];
  order_type: string;
  status: OpenFulfillmentState;
  status_label: string;
  created_at: string;
  updated_at: string;
  store_details_confirmed_at: string | null;
  onboarding_session_id: string | null;
  fields: FulfillmentRequestIdentity & {
    owner: string;
    requested_by: string;
    offer: string;
    tap_card_offer: string;
    boostly_box_offer: string;
    ship_to: string;
    ship_to_name: string;
    tap_card_count: string;
    table_count: string;
    bathroom_stall_count: string;
  };
  identity_complete: boolean;
  badge_quantity: null;
  badge_quantity_status: "missing";
  badge_quantity_source: string[];
  csm: { name: string; email: string } | null;
  requested_by: { name: string; email: string } | null;
  slack_thread_ts: string | null;
  notes: string | null;
  offer_promotion_id: string | null;
  shipping: {
    recipient_name: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    complete: boolean;
  };
  quantities: { tap_cards: number; tables: number; bathroom_stalls: number; signage: number; to_go_rolls: number };
  items: Array<Omit<DatabaseItem, "printed_at"> & { printed: boolean }>;
  expected_location_id: string;
  expected_account_id: string;
  location_candidates: LocationCandidate[];
  account_locations: LocationCandidate[];
  already_processed: boolean;
  prior_outcome: Record<string, unknown> | null;
};

export type ListOptions = {
  status?: RequestedStatus;
  after?: string | null;
  limit?: number | null;
  excludeProcessed?: boolean;
  stateFile?: string;
};

export type ListResult = {
  source: "v2-db";
  status: RequestedStatus;
  fetched_at: string;
  requests: CanonicalRequest[];
  excluded: { processed: number; ad_hoc: number; general: number; other_status: number };
  stage_metrics: Array<{
    stage: "v2_db_intake";
    started_at: string;
    duration_ms: number;
    counters: Record<string, number>;
    outcome: "ok";
  }>;
};

export function resolveStatus(value: string | undefined): RequestedStatus {
  if (value == null || value === "") return DEFAULT_STATUS;
  const status = STATUS_ALIASES[value.trim().toLowerCase()];
  if (!status) throw new Error(`Unsupported --status ${value}; use branding|digital_fulfillment|store_details|physical_fulfillment|printing_label|open`);
  return status;
}

export function hasCompleteShippingAddress(row: Pick<DatabaseRequestRow, "shipping_recipient_name" | "shipping_address_line1" | "shipping_city" | "shipping_state" | "shipping_zip">): boolean {
  return [row.shipping_recipient_name, row.shipping_address_line1, row.shipping_city, row.shipping_state, row.shipping_zip]
    .every((value) => typeof value === "string" && value.trim().length > 0);
}

// Mirror of getFulfillmentState for rows that are neither canceled nor shipped.
export function deriveOpenState(row: DatabaseRequestRow): OpenFulfillmentState | null {
  if (row.canceled_at || row.tracking_number) return null;
  if (row.tracking_status && ["delivered", "return_to_sender", "failure", "cancelled", "error"].includes(row.tracking_status)) return null;
  if (!row.digital_fulfilled_at) return "digital_fulfillment";
  const items = row.items ?? [];
  const needsOffer = items.some((item) => OFFER_BEARING_ITEM_TYPES.has(item.item_type));
  const storeDetailsComplete = row.store_details_confirmed_at != null
    && hasCompleteShippingAddress(row)
    && (!needsOffer || Boolean(row.offer_text?.trim()));
  if (!storeDetailsComplete) return "store_details";
  if (items.length === 0 || items.some((item) => !item.printed_at)) return "physical_fulfillment";
  return "printing_label";
}

// "533 Nostrand Ave, Brooklyn, NY 11216, USA" -> street/city/state/postal. The V2 address is the
// identity address; the ship-to lives on the location's shipping_* columns and stays separate.
export function parseLocationAddress(address: string | null): Pick<FulfillmentRequestIdentity, "street_address" | "city" | "state" | "postal_code"> & { complete: boolean } {
  const parts = String(address ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length && /^(usa|us|united states(?: of america)?)$/i.test(parts.at(-1)!)) parts.pop();
  const stateZip = parts.at(-1)?.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!stateZip || parts.length < 3) {
    return { street_address: parts.join(", "), city: "", state: "", postal_code: "", complete: false };
  }
  return {
    street_address: parts.slice(0, -2).join(", "),
    city: parts.at(-2)!,
    state: stateZip[1].toUpperCase(),
    postal_code: stateZip[2],
    complete: true,
  };
}

export function toLocationCandidate(row: Pick<DatabaseRequestRow, "location_id" | "location_name" | "location_status" | "account_id" | "account_name" | "account_status" | "address" | "website_url" | "ordering_url" | "google_place_id" | "is_general">): LocationCandidate & { ordering_url: string | null } {
  return {
    location_id: row.location_id,
    location_name: row.location_name,
    location_status: row.location_status,
    account_id: row.account_id,
    account_name: row.account_name,
    account_status: row.account_status,
    address: row.address ?? "",
    website_url: row.website_url,
    ordering_url: row.ordering_url,
    google_place_id: row.google_place_id,
    is_general: row.is_general === true,
  };
}

export function toCanonicalRequest(
  row: DatabaseRequestRow,
  status: OpenFulfillmentState,
  accountLocations: LocationCandidate[],
  state: HeartbeatState,
): CanonicalRequest {
  const address = parseLocationAddress(row.address);
  const items = row.items ?? [];
  const quantity = (predicate: (item: DatabaseItem) => boolean) => items.filter(predicate).reduce((sum, item) => sum + item.quantity, 0);
  const quantities = {
    tap_cards: quantity((item) => item.item_type === "tapcards"),
    tables: quantity((item) => item.item_type === "stickers" && item.placement === "table" && item.focus === "subscribe"),
    bathroom_stalls: quantity((item) => item.item_type === "stickers" && item.placement === "bathroom" && item.focus === "subscribe"),
    signage: quantity((item) => item.item_type === "signage"),
    to_go_rolls: quantity((item) => item.item_type === "stickers" && item.placement === "to_go"),
  };
  const shippingComplete = hasCompleteShippingAddress(row);
  const shipTo = shippingComplete
    ? [row.shipping_recipient_name, row.shipping_address_line1, row.shipping_address_line2, row.shipping_city, `${row.shipping_state} ${row.shipping_zip}`]
      .filter((value) => typeof value === "string" && value.trim()).join(", ")
    : "";
  const offer = row.offer_text?.trim() ?? "";
  const requestedBy = row.requested_by_name?.trim() ?? "";
  const target = toLocationCandidate(row);
  const requestKey = `v2:${row.request_id}`;
  const processedIds = new Set(state.processed_fulfillment_request_ids ?? []);
  const processedKeys = new Set(state.processed_request_keys ?? []);
  return {
    source: "v2-db",
    request_key: requestKey,
    fulfillment_request_id: row.request_id,
    canonical_thread_ts: row.slack_thread_ts ?? "",
    paired_message_ts: row.slack_thread_ts ? [row.slack_thread_ts] : [],
    request_types: ["fulfillment_request"],
    order_type: row.order_type,
    status,
    status_label: STATUS_LABELS[status],
    created_at: row.created_at,
    updated_at: row.updated_at,
    store_details_confirmed_at: row.store_details_confirmed_at,
    onboarding_session_id: row.onboarding_session_id,
    fields: {
      account_name: row.account_name,
      location_name: row.location_name,
      street_address: address.street_address,
      city: address.city,
      state: address.state,
      postal_code: address.postal_code,
      owner: requestedBy,
      requested_by: requestedBy,
      offer,
      tap_card_offer: offer,
      boostly_box_offer: offer,
      ship_to: shipTo,
      ship_to_name: row.shipping_recipient_name?.trim() ?? "",
      tap_card_count: String(quantities.tap_cards),
      table_count: String(quantities.tables),
      bathroom_stall_count: String(quantities.bathroom_stalls),
    },
    identity_complete: address.complete,
    badge_quantity: null,
    badge_quantity_status: "missing",
    badge_quantity_source: [],
    csm: row.csm_name ? { name: row.csm_name, email: row.csm_email ?? "" } : null,
    requested_by: row.requested_by_name ? { name: row.requested_by_name, email: row.requested_by_email ?? "" } : null,
    slack_thread_ts: row.slack_thread_ts,
    notes: row.notes,
    offer_promotion_id: row.offer_promotion_id,
    shipping: {
      recipient_name: row.shipping_recipient_name,
      address_line1: row.shipping_address_line1,
      address_line2: row.shipping_address_line2,
      city: row.shipping_city,
      state: row.shipping_state,
      zip: row.shipping_zip,
      complete: shippingComplete,
    },
    quantities,
    items: items.map(({ printed_at, ...item }) => ({ ...item, printed: printed_at != null })),
    expected_location_id: row.location_id,
    expected_account_id: row.account_id,
    location_candidates: [target],
    account_locations: accountLocations.filter((location) => location.account_id === row.account_id),
    already_processed: processedIds.has(row.request_id) || processedKeys.has(requestKey),
    prior_outcome: asObject(state.fulfillment_request_outcomes)[row.request_id] as Record<string, unknown> | undefined ?? null,
  };
}

export type HeartbeatState = {
  processed_request_keys?: string[];
  processed_fulfillment_request_ids?: string[];
  fulfillment_request_outcomes?: Record<string, unknown>;
};

export function readHeartbeatState(file: string): HeartbeatState {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Heartbeat state must be a JSON object");
  return value as HeartbeatState;
}

function query<T>(sql: string): T[] {
  return JSON.parse(execFileSync(DB, ["query", "--json", "--sql", sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as T[];
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const REQUEST_FIELDS = `
  fr.id request_id, fr.created_at, fr.updated_at, fr.order_type::text, fr.notes, fr.offer_text, fr.offer_promotion_id,
  fr.slack_thread_ts, fr.onboarding_session_id, fr.store_details_confirmed_at, fr.digital_fulfilled_at, fr.canceled_at,
  fr.tracking_number, fr.tracking_status,
  a.id account_id, a.name account_name, a.status::text account_status,
  mgr.name csm_name, mgr.email csm_email, rb.name requested_by_name, rb.email requested_by_email,
  l.id location_id, l.name location_name, l.status::text location_status, l.address, l.website_url, l.ordering_url,
  l.google_place_id, l.is_general,
  l.shipping_recipient_name, l.shipping_address_line1, l.shipping_address_line2, l.shipping_city, l.shipping_state, l.shipping_zip,
  (select json_agg(json_build_object('item_type', i.item_type, 'placement', i.placement, 'focus', i.focus,
     'quantity', i.quantity, 'printed_at', i.printed_at) order by i.created_at, i.id)
   from fulfillment_items i where i.fulfillment_request_id = fr.id) items`;

const REQUEST_FROM = `
  from fulfillment_requests fr
  join locations l on l.id = fr.location_id
  join accounts a on a.id = l.account_id
  left join users mgr on mgr.id = a.manager_user_id
  left join users rb on rb.id = fr.created_by_user_id`;

export function fetchOpenRequestRows(after: string | null): DatabaseRequestRow[] {
  if (after != null && !/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(after)) {
    throw new Error("Invalid --after value; expected an ISO date or timestamp");
  }
  const rows: DatabaseRequestRow[] = [];
  let cursor: DatabaseRequestRow | undefined;
  for (;;) {
    const afterClause = after ? `and fr.created_at >= ${literal(after)}::timestamptz` : "";
    const cursorClause = cursor ? `and (fr.created_at, fr.id) > (${literal(cursor.created_at)}::timestamp, ${literal(cursor.request_id)})` : "";
    const page = query<DatabaseRequestRow>(
      `select ${REQUEST_FIELDS} ${REQUEST_FROM}
       where fr.canceled_at is null and fr.tracking_number is null ${afterClause} ${cursorClause}
       order by fr.created_at, fr.id limit 200`,
    );
    rows.push(...page);
    if (page.length < 200) break;
    cursor = page.at(-1);
  }
  return rows;
}

export function fetchAccountLocations(accountIds: string[]): LocationCandidate[] {
  if (!accountIds.length) return [];
  if (accountIds.some((id) => !/^[a-z0-9]+$/.test(id))) throw new Error("Invalid account id");
  return query<Parameters<typeof toLocationCandidate>[0]>(
    `select l.id location_id, l.name location_name, l.status::text location_status, l.account_id, a.name account_name,
       a.status::text account_status, l.address, l.website_url, l.ordering_url, l.google_place_id, l.is_general
     from locations l join accounts a on a.id = l.account_id
     where l.account_id in (${accountIds.map(literal).join(",")})
     order by l.account_id, l.created_at, l.id`,
  ).map(toLocationCandidate);
}

export function listBrandingRequests(options: ListOptions = {}): ListResult {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const status = options.status ?? DEFAULT_STATUS;
  const state = readHeartbeatState(options.stateFile ?? DEFAULT_STATE_FILE);
  const rows = fetchOpenRequestRows(options.after ?? null);
  const excluded = { processed: 0, ad_hoc: 0, general: 0, other_status: 0 };
  const selected: Array<{ row: DatabaseRequestRow; state: OpenFulfillmentState }> = [];
  for (const row of rows) {
    const derived = deriveOpenState(row);
    if (!derived || (status !== "open" && derived !== status)) { excluded.other_status += 1; continue; }
    if (row.is_general) { excluded.general += 1; continue; }
    if (row.order_type !== "full_order") { excluded.ad_hoc += 1; continue; }
    selected.push({ row, state: derived });
  }
  const accountLocations = fetchAccountLocations([...new Set(selected.map(({ row }) => row.account_id))]);
  let requests = selected.map(({ row, state: derived }) => toCanonicalRequest(row, derived, accountLocations, state));
  if (options.excludeProcessed) {
    const before = requests.length;
    requests = requests.filter((request) => !request.already_processed);
    excluded.processed = before - requests.length;
  }
  if (options.limit != null) requests = requests.slice(0, options.limit);
  return {
    source: "v2-db",
    status,
    fetched_at: startedAt,
    requests,
    excluded,
    stage_metrics: [{
      stage: "v2_db_intake",
      started_at: startedAt,
      duration_ms: Number((performance.now() - startedMs).toFixed(3)),
      counters: {
        open_rows_total: rows.length,
        canonical_requests: requests.length,
        excluded_processed: excluded.processed,
        excluded_ad_hoc: excluded.ad_hoc,
        excluded_general: excluded.general,
        excluded_other_status: excluded.other_status,
        identity_incomplete: requests.filter((request) => !request.identity_complete).length,
        missing_google_place_id: requests.filter((request) => !request.location_candidates[0]?.google_place_id).length,
      },
      outcome: "ok",
    }],
  };
}

/**
 * One run dir per request under `root`, each holding a run.json whose request block is the
 * canonical request. Existing run.json files are left alone (the request block is owned by intake,
 * but a re-pull must never clobber a run in flight); they are reported as skipped.
 */
export function emitRunDirs(result: ListResult, root: string): Array<{ request_id: string; run_dir: string; action: "created" | "skipped_existing" }> {
  const out: Array<{ request_id: string; run_dir: string; action: "created" | "skipped_existing" }> = [];
  for (const request of result.requests) {
    const runDir = path.join(path.resolve(root), slugify(request.fields.location_name || request.fulfillment_request_id));
    if (runFileExists(runDir)) {
      out.push({ request_id: request.fulfillment_request_id, run_dir: runDir, action: "skipped_existing" });
      continue;
    }
    initRun({ runDir, request: requestBlockFromCanonical(request as unknown as Record<string, unknown>) });
    out.push({ request_id: request.fulfillment_request_id, run_dir: runDir, action: "created" });
  }
  return out;
}

export function summaryLine(request: CanonicalRequest): string {
  const flags = [
    request.already_processed ? "processed" : null,
    request.prior_outcome ? `prior=${String((request.prior_outcome as { status?: unknown }).status ?? "?")}` : null,
    request.identity_complete ? null : "address-unparsed",
    request.location_candidates[0]?.google_place_id ? null : "no-place-id",
    request.slack_thread_ts ? null : "no-slack-thread",
  ].filter(Boolean).join(",");
  return [
    request.fulfillment_request_id,
    request.created_at.slice(0, 16),
    request.status,
    `${request.fields.account_name} / ${request.fields.location_name}`,
    request.fields.city ? `${request.fields.city}, ${request.fields.state}` : "(no city)",
    `cards=${request.quantities.tap_cards} tables=${request.quantities.tables} stalls=${request.quantities.bathroom_stalls}`,
    `csm=${request.csm?.name ?? "-"}`,
    flags ? `[${flags}]` : "",
  ].filter(Boolean).join(" | ");
}

function asObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  if (args.help === true) {
    process.stdout.write([
      "Usage: list-branding-requests.ts [--status branding|digital_fulfillment|store_details|physical_fulfillment|printing_label|open]",
      "         [--after <iso>] [--limit <n>] [--exclude-processed] [--state-file <path>] [--json] [--out <file>]",
      "         [--run-root <dir>]   also create <dir>/<location-slug>/run.json per request (request block; existing files skipped)",
      "Read-only pull of open V2 fulfillment requests in the canonical pipeline request shape.",
    ].join("\n") + "\n");
    return;
  }
  const limit = typeof args.limit === "string" ? Number(args.limit) : null;
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  const result = listBrandingRequests({
    status: resolveStatus(typeof args.status === "string" ? args.status : undefined),
    after: typeof args.after === "string" ? args.after : null,
    limit,
    excludeProcessed: args["exclude-processed"] === true,
    stateFile: typeof args["state-file"] === "string" ? path.resolve(args["state-file"]) : undefined,
  });
  if (typeof args.out === "string") {
    fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  const runDirs = typeof args["run-root"] === "string" ? emitRunDirs(result, args["run-root"]) : [];
  for (const entry of runDirs) process.stderr.write(`run.json ${entry.action}: ${runFilePath(entry.run_dir)}\n`);
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const request of result.requests) process.stdout.write(`${summaryLine(request)}\n`);
  const counters = result.stage_metrics[0].counters;
  process.stdout.write(
    `${result.requests.length} request(s) in ${result.status}; excluded processed=${result.excluded.processed} ad_hoc=${result.excluded.ad_hoc} general=${result.excluded.general} other_status=${result.excluded.other_status}; identity_incomplete=${counters.identity_incomplete} missing_place_id=${counters.missing_google_place_id}${typeof args.out === "string" ? `; wrote ${path.resolve(args.out)}` : ""}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
