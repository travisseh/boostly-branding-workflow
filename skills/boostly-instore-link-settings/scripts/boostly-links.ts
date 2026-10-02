#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CUSTOM_LINK_DESCRIPTION_MAX_LENGTH,
  applyCustomLinkDescription,
  applyCustomLinkPresentation,
  enforceLinkTreeVisibility,
  isDisallowedCustomLink,
  normalizeLegacyInactiveCustomPlaceholders,
} from "./linktree-policy.ts";
import {
  ACTION_IDS_FILE,
  ACTION_KEYS,
  deriveActionIds,
  diffActionIds,
  mergeActionIdsFile,
  readActionIdsFile,
  resolveSampleIds,
  writeActionIdsFile,
  type ActionKey,
  type ActionIdsFile,
} from "./derive-actions.ts";

const DEFAULT_BASE_URL = "https://new.boostly.com";
// v2-db resolves relative to this skills root so the CLI runs from ~/.claude/skills (canonical)
// or the ~/.codex/skills mirror. The badge receipt ledger is shared heartbeat STATE and stays at
// the one ~/.codex runs location the Codex heartbeat still writes (see box-fulfillment paths.ts).
const V2_DB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "v2-database", "bin", "v2-db");
const DEFAULT_BADGE_RECEIPT_FILE = process.env.BOOSTLY_HEARTBEAT_ROOT
  ? `${process.env.BOOSTLY_HEARTBEAT_ROOT}/boosted-box-badge-receipts.jsonl`
  : "/Users/travisse/.codex/skills/boostly-link-discovery/runs/boosted-box-badge-receipts.jsonl";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const execFileAsync = promisify(execFile);

const DB_CORE_LOCATION_WARNING =
  "Using V2 DB fallback. Core location fields and branding rows can be read, but writes require the authenticated web page payload so the app action can enforce account scope.";

// Server-action ids rotate on every prod deploy. The live table is
// scripts/action-ids.json (written by derive-actions.ts --write and by the
// self-heal path below); this hardcoded copy is only the fallback when that
// file is missing. Env overrides: BOOSTLY_SWITCH_ACCOUNT_ACTION_ID (legacy) and
// BOOSTLY_ACTION_ID_<SNAKE_UPPER_KEY> for any key, e.g.
// BOOSTLY_ACTION_ID_CREATE_PROMOTION.
const FALLBACK_ACTIONS: Record<ActionKey, string> = {
  // Last hand-derived 2026-09-15 (build 4jnFthvfTvoyU7FxoRTm6).
  getEvents: "40961210cb94faba356ee049f416f26bd24e87fddd",
  getObjectives: "404ac41ea1e46062a9cf2da712d6091550398a9ec9",
  saveEvents: "408b29d7fb981c27e80615bc6a02760abafcea750f",
  updateLocation: "606ac60ff64d8f819cbd0c580c9bf8f43e1cb35c96",
  // Rotated 2026-08-18 (new prod build 85BNDfZGV8BAQOBsH6jnT). Recover after a
  // deploy by fetching /account-settings HTML with the auth cookie, locating the
  // account-settings page chunk, and grepping createServerReference("<42-hex>",
  // ..., "updateAccountBranding").
  updateAccountBranding: "4039198c911e6f06b9dab84e3166a275f857f7a029",
  createBulkBadges: "402d2e5aa258369a2fbfb9d6c454c5d0848d979fb8",
  // Rotated 2026-08-18. Recovery: fetch /admin/accounts with the auth cookie,
  // scan its chunks for createServerReference(...,"switchUserAccount").
  switchUserAccount: "4020718305cec6b1f59e65fdf921a2ae2047ba6ed2",
  // WARNING: the ids below were re-derived from the 2026-09-02 prod build and
  // ROTATE on every deploy (proven by the 2026-09-01 8:40am deploy). Re-derive
  // before any use: fetch the owning page HTML with the auth cookie and grep
  // its chunks for createServerReference("<42-hex>", ..., "<name>").
  // createSignage: /in-store/signage/new page chunk.
  createSignage: "401d7e64c1aa1cd0ffd826fd2c1d357044b7833169",
  // Derived 2026-08-31. Recovery: fetch /in-store/signage/<anySignageId>?tab=links
  // and grep the [signage_id] page chunk for "saveTouchpointEventConfigForTouchpoint".
  saveTouchpointEventOverrides: "60f28f2e44c6b6a1a1393bd153f9f94d8686b39391",
  // Derived 2026-08-31 from the /promotions/new page chunk ("createPromotion").
  createPromotion: "4010806d8109cdc60c50d8763a9f01e8c9c66ffad4",
  // Derived 2026-08-31 from the /in-store/objectives/new page chunk ("createObjective").
  createObjective: "70cc4e983ac0adc1544d86a4175b7e5d7a44da1731",
  // Derived 2026-09-01 from the /in-store/objectives/[objective_id] page chunk
  // ("deleteObjective"). Session must be scoped to the objective's account or
  // the page 404s.
  deleteObjective: "40400e3b855c0040a8b5d4cdda23a96b92f2f3040f",
  // Derived 2026-09-16 (build 4jnFthvfTvoyU7FxoRTm6) from the
  // /admin/fulfillment/<requestId> page chunk. Admin-scoped page: any admin
  // session and any request id reach it.
  setStoreDetailsConfirmed: "602b1119a77c1aece240cfc4fd2141ea30f0a7d5bc",
  setDigitalFulfillmentCompleted: "6011271319808a857952fb280f5ea7987935bd183a",
  updateFulfillmentOffer: "60deaad5506bb07cabab1ba46fcaa94630b96c0850",
  updateShippingAddress: "607a236eb1f07370288e0fd9eea41f6baa540c0676",
  // Derived 2026-09-18 (build 4jnFthvfTvoyU7FxoRTm6) from the same admin
  // fulfillment page chunk ("updateNotesAction": the internal notes field).
  updateFulfillmentNotes: "608092849cd2ea6cb5b74484e9873fff0df678afa2",
  // Derived 2026-09-16 (build 4jnFthvfTvoyU7FxoRTm6) from the
  // /click-to-join/<subscribeLinkId> page chunk ("updateSubscribeLink").
  // Account-scoped page: the session must be scoped to the link's account.
  updateSubscribeLink: "606644782fb0b03ff91e51a225f20dfd00cd8ce683",
};

const ACTION_IDS_PATH = process.env.BOOSTLY_ACTION_IDS_FILE || ACTION_IDS_FILE;

function actionEnvVar(key: ActionKey): string {
  return `BOOSTLY_ACTION_ID_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

export function loadActionIds(
  fileContents: ActionIdsFile | null,
  env: NodeJS.ProcessEnv = process.env,
): { actions: Record<ActionKey, string>; build_id: string | null; source: Record<ActionKey, string> } {
  const actions = { ...FALLBACK_ACTIONS };
  const source = Object.fromEntries(ACTION_KEYS.map((key) => [key, "fallback"])) as Record<ActionKey, string>;
  for (const key of ACTION_KEYS) {
    const fromFile = fileContents?.actions?.[key];
    if (typeof fromFile === "string" && /^[0-9a-f]{40,44}$/.test(fromFile)) {
      actions[key] = fromFile;
      source[key] = "action-ids.json";
    }
    const fromEnv =
      env[actionEnvVar(key)] ||
      (key === "switchUserAccount" ? env.BOOSTLY_SWITCH_ACCOUNT_ACTION_ID : undefined);
    if (fromEnv) {
      actions[key] = fromEnv;
      source[key] = "env";
    }
  }
  return { actions, build_id: fileContents?.build_id ?? null, source };
}

function readActionIdsFileSync(path: string): ActionIdsFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ActionIdsFile;
  } catch {
    return null;
  }
}

const loadedActionIds = loadActionIds(readActionIdsFileSync(ACTION_IDS_PATH));
// Mutable on purpose: a self-heal swaps in freshly derived ids for the rest of
// the process. Call sites pass the key, and the id is resolved at call time.
const ACTIONS: Record<ActionKey, string> = loadedActionIds.actions;
let actionIdsBuildId: string | null = loadedActionIds.build_id;

// Actions whose replay is safe to retry once after a self-heal: they do not
// write customer data. Everything else is a write and is never retried.
const READ_ACTIONS: ReadonlySet<ActionKey> = new Set<ActionKey>([
  "getEvents",
  "getObjectives",
  "switchUserAccount",
]);

const BRANDING_FIELD_FLAGS = [
  ["facebook-url", "facebook_url"],
  ["instagram-url", "instagram_url"],
  ["x-url", "x_url"],
  ["tiktok-url", "tiktok_url"],
  ["youtube-url", "youtube_url"],
  ["apple-app-url", "apple_app_url"],
  ["google-app-url", "google_app_url"],
  ["web-primary-color", "web_primary_color"],
  ["web-secondary-color", "web_secondary_color"],
  ["web-text-color", "web_text_color"],
  ["print-primary-color", "print_primary_color"],
  ["print-secondary-color", "print_secondary_color"],
  ["print-text-color", "print_text_color"],
  ["print-text-secondary-color", "print_text_secondary_color"],
  ["logo-attachment-id", "logo_attachment_id"],
] as const;

type BrandingField = (typeof BRANDING_FIELD_FLAGS)[number][1];

const BRANDING_FIELDS = BRANDING_FIELD_FLAGS.map(
  ([, field]) => field,
) as BrandingField[];

const CORE_LOCATION_FIELD_FLAGS = [
  ["name", "name"],
  ["address", "address"],
  ["ordering-phone-number", "ordering_phone_number"],
  ["ordering-url", "ordering_url"],
  ["website-url", "website_url"],
  ["timezone", "timezone"],
  ["google-place-id", "google_place_id"],
] as const;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type TouchpointEvent = {
  touchpoint_event_default_id: string;
  touchpoint_event_id?: string;
  type: "subscribe" | "review" | "downloads" | "socials" | "custom";
  title: string;
  display_title: string | null;
  description: string | null;
  primary_button_text: string | null;
  link: string | null;
  sort_order: number;
  is_active: boolean;
  config: JsonValue | undefined;
  objective_id: string | null;
  subscribe_link_response_message?: string;
  subscribe_link_promotion_id?: string;
};

type BadgeRecord = {
  id: string;
  short_id: string | null;
  name: string | null;
  issue_id: number;
  account_user_id: string | null;
  location_id: string;
  created_at: string;
  deleted_at: string | null;
};

type BadgeState = {
  location_id: string;
  active_count: number;
  assigned_count: number;
  unassigned_count: number;
  max_issue_id: number | null;
  badges: Array<{
    id: string;
    short_id: string | null;
    issue_id: number;
    assigned: boolean;
    created_at: string;
  }>;
};

type BadgeReceipt = {
  recorded_at: string;
  idempotency_key: string;
  location_id: string;
  quantity: number;
  status: "started" | "ambiguous" | "completed";
  before_count?: number;
  after_count?: number;
  created_badge_ids?: string[];
  error?: string;
};

type BrandingSettings = {
  web_primary_color: string | null;
  web_secondary_color: string | null;
  web_text_color: string | null;
  print_primary_color: string | null;
  print_secondary_color: string | null;
  print_text_color: string | null;
  print_text_secondary_color: string | null;
  logo_attachment_id: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  x_url: string | null;
  tiktok_url: string | null;
  youtube_url: string | null;
  apple_app_url: string | null;
  google_app_url: string | null;
  logo_url?: string | null;
  logo_filename?: string | null;
};

type LocationSettings = {
  id: string;
  account_id?: string;
  account_name?: string;
  name: string;
  address: string | null;
  ordering_phone_number: string | null;
  ordering_url: string | null;
  website_url: string | null;
  timezone: string;
  google_place_id: string | null;
  status: string;
  shipping_recipient_name: string | null;
  shipping_address_line1: string | null;
  shipping_address_line2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_zip: string | null;
  accountBranding?: BrandingSettings | null;
  overrideBranding?: BrandingSettings | null;
  __source?: "web-page" | "v2-db-core";
  __warning?: string;
  __web_error?: string;
};

type DbLocationRow = {
  id: string;
  account_id: string;
  account_name: string;
  name: string;
  address: string | null;
  ordering_phone_number: string | null;
  ordering_url: string | null;
  website_url: string | null;
  timezone: string;
  google_place_id: string | null;
  status: string;
  shipping_recipient_name: string | null;
  shipping_address_line1: string | null;
  shipping_address_line2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_zip: string | null;
  account_branding: BrandingSettings | null;
  override_branding: BrandingSettings | null;
};

type LocationAccountContext = {
  location_id: string;
  location_name: string;
  account_id: string;
  account_name: string;
  location_status: string;
  is_general: boolean;
  write_location_count: number;
  write_locations: Array<{ id: string; name: string; status: string }>;
};

type BrandingScope = "auto" | "account" | "location";

type BrandingState = {
  location: LocationSettings;
  context: LocationAccountContext;
  account: BrandingSettings;
  override: BrandingSettings | null;
  effective: BrandingSettings;
  selected_scope: Exclude<BrandingScope, "auto">;
  scope_reason: string;
};

type AuthSessionAccount = {
  id: string | null;
  name: string | null;
  spoofedAccountId: string | null;
  selectedAccountId: string | null;
  is_admin?: boolean;
  is_super_admin?: boolean;
};

type SwitchUserAccountResult = {
  id: string;
  name: string;
  isAdmin: boolean;
};

type Options = Record<string, string | boolean | string[]>;

let mutableCookieHeader: string | null = null;

class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const options: Options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey;
    if (inlineValue !== undefined) {
      setOption(options, key, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      setOption(options, key, next);
      i += 1;
    } else {
      setOption(options, key, true);
    }
  }

  return { positionals, options };
}

function setOption(options: Options, key: string, value: string | boolean) {
  if (key === "clear") {
    const current = options[key];
    if (Array.isArray(current)) current.push(String(value));
    else if (current) options[key] = [String(current), String(value)];
    else options[key] = [String(value)];
    return;
  }
  options[key] = value;
}

function optString(options: Options, key: string): string | undefined {
  const value = options[key];
  if (typeof value === "string") return value;
  return undefined;
}

function optBool(options: Options, key: string): boolean {
  const value = options[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return false;
}

function optTriBool(options: Options, key: string): boolean | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string")
    throw new CliError(`--${key} must be true or false`);
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new CliError(`--${key} must be true or false`);
}

function optClear(options: Options): string[] {
  const value = options.clear;
  if (!value) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function emptyBranding(): BrandingSettings {
  const fields = Object.fromEntries(
    BRANDING_FIELDS.map((field) => [field, null]),
  ) as Record<BrandingField, string | null>;

  return {
    ...fields,
    logo_url: null,
    logo_filename: null,
  };
}

function normalizeBranding(
  value: Partial<BrandingSettings> | null | undefined,
): BrandingSettings {
  const branding = emptyBranding();
  for (const field of BRANDING_FIELDS) {
    branding[field] = coerceUnset(value?.[field]);
  }
  branding.logo_url = coerceUnset(value?.logo_url);
  branding.logo_filename = coerceUnset(value?.logo_filename);
  return branding;
}

function coerceUnset(value: string | null | undefined): string | null {
  return value == null || value === "" ? null : value;
}

function resolveBranding(
  account: Partial<BrandingSettings> | null | undefined,
  override: Partial<BrandingSettings> | null | undefined,
): BrandingSettings {
  const accountBranding = normalizeBranding(account);
  const overrideBranding = normalizeBranding(override);
  const inherited = Object.fromEntries(
    BRANDING_FIELDS.map((field) => [
      field,
      overrideBranding[field] ?? accountBranding[field],
    ]),
  ) as Record<BrandingField, string | null>;

  const web_primary_color = inherited.web_primary_color;
  const web_secondary_color = inherited.web_secondary_color;
  const web_text_color = inherited.web_text_color;
  const print_primary_color =
    inherited.print_primary_color ?? web_primary_color;
  const print_secondary_color =
    inherited.print_secondary_color ?? web_secondary_color;
  const print_text_color = inherited.print_text_color ?? web_text_color;
  const print_text_secondary_color =
    inherited.print_text_secondary_color ?? print_text_color;

  return {
    ...inherited,
    web_primary_color,
    web_secondary_color,
    web_text_color,
    print_primary_color,
    print_secondary_color,
    print_text_color,
    print_text_secondary_color,
    logo_url:
      coerceUnset(override?.logo_url) ?? coerceUnset(account?.logo_url) ?? null,
    logo_filename:
      coerceUnset(override?.logo_filename) ??
      coerceUnset(account?.logo_filename) ??
      null,
  };
}

function hasOption(options: Options, key: string): boolean {
  return options[key] !== undefined;
}

function hasCoreLocationOptions(options: Options): boolean {
  return CORE_LOCATION_FIELD_FLAGS.some(([flag]) => hasOption(options, flag));
}

function hasBrandingOptions(options: Options): boolean {
  return (
    hasOption(options, "logo-file") ||
    BRANDING_FIELD_FLAGS.some(([flag]) => hasOption(options, flag)) ||
    optClear(options).some((field) => brandingFieldFromName(field) !== null)
  );
}

function brandingFieldFromName(name: string): BrandingField | null {
  const normalized = normalize(name);
  for (const [flag, field] of BRANDING_FIELD_FLAGS) {
    if (normalize(flag) === normalized || normalize(field) === normalized) {
      return field;
    }
  }
  return null;
}

async function readCookie(options: Options): Promise<string> {
  if (mutableCookieHeader !== null) return mutableCookieHeader;

  const inline = optString(options, "cookie") || process.env.BOOSTLY_COOKIE;
  if (inline) {
    mutableCookieHeader = normalizeCookieHeader(inline);
    return mutableCookieHeader;
  }

  const cookieFile =
    optString(options, "cookie-file") || process.env.BOOSTLY_COOKIE_FILE;
  if (cookieFile) {
    mutableCookieHeader = normalizeCookieHeader(await readFile(cookieFile, "utf8"));
    return mutableCookieHeader;
  }

  throw new CliError(
    "Missing auth. Set BOOSTLY_COOKIE, BOOSTLY_COOKIE_FILE, --cookie, or --cookie-file with a raw Cookie header.",
    4,
  );
}

function normalizeCookieHeader(value: string): string {
  return value.trim().replace(/^Cookie:\s*/i, "");
}

function cookiePairs(header: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    pairs.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return pairs;
}

function splitSetCookieHeader(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,=]+=[^;,]+)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function getSetCookieHeaders(headers: Headers): string[] {
  const maybeGetSetCookie = (headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;
  if (typeof maybeGetSetCookie === "function") {
    return maybeGetSetCookie.call(headers);
  }
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function applySetCookieHeaders(headers: Headers) {
  const setCookies = getSetCookieHeaders(headers);
  if (setCookies.length === 0) return;

  const pairs = cookiePairs(mutableCookieHeader ?? "");
  for (const setCookie of setCookies) {
    const [nameValue, ...attributes] = setCookie.split(";");
    const separator = nameValue.indexOf("=");
    if (separator <= 0) continue;
    const name = nameValue.slice(0, separator).trim();
    const value = nameValue.slice(separator + 1).trim();
    const lowerAttributes = attributes.map((attr) => attr.trim().toLowerCase());
    const expiresAttr = lowerAttributes.find((attr) => attr.startsWith("expires="));
    const isExpired =
      lowerAttributes.includes("max-age=0") ||
      lowerAttributes.includes("max-age=-1") ||
      (expiresAttr ? Number.isFinite(Date.parse(expiresAttr.slice(8))) && Date.parse(expiresAttr.slice(8)) <= Date.now() : false);

    if (isExpired) pairs.delete(name);
    else pairs.set(name, value);
  }

  mutableCookieHeader = Array.from(pairs.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function writeCookieOut(options: Options) {
  const cookieOut = optString(options, "cookie-out");
  if (!cookieOut) return null;
  const cookie = await readCookie(options);
  await writeFile(cookieOut, `${cookie}\n`, { mode: 0o600 });
  return cookieOut;
}

function baseUrl(options: Options): string {
  return (
    optString(options, "base-url") ||
    process.env.BOOSTLY_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
}

async function boostlyFetch(
  options: Options,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const cookie = await readCookie(options);
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept-Language", "en-US,en;q=0.9");

  const response = await fetch(`${baseUrl(options)}${path}`, {
    ...init,
    headers,
    redirect: "manual",
  });
  applySetCookieHeaders(response.headers);
  return response;
}

export class ActionRotatedError extends CliError {
  actionKey: ActionKey;
  constructor(message: string, actionKey: ActionKey) {
    super(message, 5);
    this.actionKey = actionKey;
  }
}

// Exact production signature of an unknown/rotated server-action id (probed
// live 2026-09-16): HTTP 404, header `x-nextjs-action-not-found: 1`, body
// "Server action not found.". A plain page 404 (wrong account scope) has an
// HTML body and no such header, so it is deliberately NOT matched.
export function isActionNotFoundResponse(
  status: number,
  headers: { get(name: string): string | null },
  bodyText: string,
): boolean {
  if (status !== 404) return false;
  if (headers.get("x-nextjs-action-not-found") === "1") return true;
  return /^Server action not found\.?$/i.test(bodyText.trim());
}

function resolveActionId(action: ActionKey | string): { key: ActionKey | null; id: string } {
  if ((ACTION_KEYS as string[]).includes(action)) {
    const key = action as ActionKey;
    return { key, id: ACTIONS[key] };
  }
  const key = ACTION_KEYS.find((candidate) => ACTIONS[candidate] === action) ?? null;
  return { key, id: action };
}

type HealResult = {
  from_build: string | null;
  to_build: string | null;
  changed: { key: ActionKey; from: string | null; to: string }[];
  missing: ActionKey[];
  file: string;
};

let healContextLocationId: string | null = null;
let healContextRequestId: string | null = null;
let selfHealDone = false;

// Derive the current ids from the live site, rewrite action-ids.json, and swap
// the new ids into ACTIONS. Runs at most once per process.
async function selfHealActionIds(options: Options): Promise<HealResult> {
  const cookie = await readCookie(options);
  const base = baseUrl(options);
  const sampleIds = await resolveSampleIds({
    fetchImpl: fetch,
    baseUrl: base,
    cookie,
    locationId: healContextLocationId,
    requestId: healContextRequestId,
  });
  const derived = await deriveActionIds({ cookie, baseUrl: base, sampleIds });
  const changed = diffActionIds(ACTIONS, derived.actions);
  const previous = await readActionIdsFile(ACTION_IDS_PATH);
  const next = mergeActionIdsFile(previous, derived, base);
  await writeActionIdsFile(next, ACTION_IDS_PATH);
  const from_build = actionIdsBuildId;
  for (const change of changed) ACTIONS[change.key] = change.to;
  actionIdsBuildId = next.build_id;
  return { from_build, to_build: next.build_id, changed, missing: derived.missing, file: ACTION_IDS_PATH };
}

export type ServerActionAttempt = {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
};

// Shared once-only retry policy, kept free of fetch so it can be unit-tested.
//   read action  : rotation -> heal once -> retry once -> still rotated: error
//   write action : rotation -> heal once (the 404 proves nothing executed) ->
//                  abort with a rerun instruction; never retried
// A second rotation in the same process is never healed again.
export async function withActionRotationHeal(
  key: ActionKey | null,
  attempt: (id: string) => Promise<ServerActionAttempt>,
  deps: {
    ids: Record<string, string>;
    isRead: (key: ActionKey) => boolean;
    heal: () => Promise<HealResult>;
    state: { healed: boolean };
    log?: (line: string) => void;
    rawId?: string;
  },
): Promise<ServerActionAttempt> {
  const idFor = () => (key ? deps.ids[key] : deps.rawId ?? "");
  const first = await attempt(idFor());
  if (!isActionNotFoundResponse(first.status, first.headers, first.text)) return first;
  const name = key ?? "unknown action";
  if (!key) {
    throw new CliError(
      `Server action ${idFor()} is unknown to production (rotated id; not in the action table, cannot self-heal).`,
      5,
    );
  }
  if (deps.state.healed) {
    throw new ActionRotatedError(
      `Server action ${key} (${idFor()}) is still unknown to production after a self-heal in this run. Refusing a second derivation; run derive-actions.ts --check and rerun.`,
      key,
    );
  }
  deps.state.healed = true;
  const before = idFor();
  const heal = await deps.heal();
  const rotated = heal.changed.map((c) => c.key);
  deps.log?.(
    `[boostly-links] self-heal: server action ids rotated (build ${heal.from_build ?? "unknown"} -> ${heal.to_build ?? "unknown"}); re-derived ${rotated.length ? rotated.join(", ") : "nothing new"}${heal.missing.length ? `; not derivable: ${heal.missing.join(", ")}` : ""}; wrote ${heal.file}`,
  );
  const after = idFor();
  if (!after || after === before) {
    throw new ActionRotatedError(
      `Server action ${key} (${before}) is unknown to production and the self-heal could not derive a new id for it (build ${heal.to_build ?? "unknown"}). Scope the session to the target account (--ensure-location-scope) and run derive-actions.ts --check.`,
      key,
    );
  }
  if (!deps.isRead(key)) {
    throw new ActionRotatedError(
      `Server action ${key} rotated (build ${heal.from_build ?? "unknown"} -> ${heal.to_build ?? "unknown"}) before this write. Nothing was written (production answered "Server action not found"). The action table was healed; rerun the command.`,
      key,
    );
  }
  const second = await attempt(after);
  if (isActionNotFoundResponse(second.status, second.headers, second.text)) {
    throw new ActionRotatedError(
      `Server action ${key} still unknown to production after self-heal (tried ${before} then ${after}, build ${heal.to_build ?? "unknown"}). Run derive-actions.ts --check.`,
      key,
    );
  }
  return second;
}

async function postServerAction<T>(
  options: Options,
  path: string,
  action: ActionKey | string,
  buildInit: () => RequestInit,
): Promise<T> {
  const { key, id } = resolveActionId(action);
  const response = await withActionRotationHeal(
    key,
    async (actionId) => {
      const init = buildInit();
      const headers = new Headers(init.headers);
      headers.set("next-action", actionId);
      const raw = await boostlyFetch(options, path, { ...init, headers });
      return { status: raw.status, headers: raw.headers, text: await raw.text() };
    },
    {
      ids: ACTIONS,
      isRead: (k) => READ_ACTIONS.has(k),
      heal: () => selfHealActionIds(options),
      state: { get healed() { return selfHealDone; }, set healed(v: boolean) { selfHealDone = v; } },
      log: (line) => console.error(line),
      rawId: id,
    },
  );
  const { status, headers, text } = response;

  if (status < 200 || status >= 300) {
    if (status >= 300 && status < 400) {
      throw new CliError(
        `Auth redirected to ${headers.get("location") || "unknown location"}`,
        4,
      );
    }
    throw new CliError(
      `Server action failed: HTTP ${status}\n${text.slice(0, 500)}`,
      5,
    );
  }
  return parseRscPayload<T>(text);
}

async function callServerAction<T>(
  options: Options,
  path: string,
  action: ActionKey | string,
  body: unknown[],
): Promise<T> {
  return postServerAction<T>(options, path, action, () => ({
    method: "POST",
    headers: {
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
    },
    // RSC decodeReply treats a leading "$" in a string as a reference marker
    // ($undefined, $B1, $D...); literal strings starting with "$" must be
    // escaped by doubling it (e.g. promo title "$5 OFF $30+").
    body: JSON.stringify(body, (_key, value: unknown) => {
      if (typeof value === "string" && value.startsWith("$")) {
        return `$${value}`;
      }
      return value;
    }),
  }));
}

async function callServerActionWithFile<T>(
  options: Options,
  path: string,
  action: ActionKey | string,
  body: unknown[],
  file: { fieldPath: [number, string]; blob: Blob; filename: string },
): Promise<T> {
  const [argumentIndex, field] = file.fieldPath;
  const argument = body[argumentIndex];
  if (!argument || typeof argument !== "object" || Array.isArray(argument)) {
    throw new CliError("File server-action argument must be an object.", 5);
  }

  // React Server Components encodes Blob/File arguments as a multipart part
  // referenced from the root JSON model with `$B<partId>`.
  const fileReference = {};
  const encodedBody = body.slice();
  encodedBody[argumentIndex] = {
    ...(argument as Record<string, unknown>),
    [field]: fileReference,
  };
  const buildForm = () => {
    const form = new FormData();
    // Part order matters: Next's Node runtime decodes multipart actions with
    // decodeReplyFromBusboy, which resolves $B references synchronously against
    // parts already streamed. The file part must precede the root "0" model
    // (browsers emit blob parts first too), or the reference resolves to null.
    form.set("1", file.blob, file.filename);
    form.set(
      "0",
      JSON.stringify(encodedBody, (_key, value: unknown) => {
        if (value === fileReference) return "$B1";
        if (typeof value === "string" && value.startsWith("$")) {
          return `$${value}`;
        }
        if (value === undefined) return "$undefined";
        return value;
      }),
    );
    return form;
  };

  return postServerAction<T>(options, path, action, () => ({
    method: "POST",
    headers: { Accept: "text/x-component" },
    body: buildForm(),
  }));
}

function parseRscPayload<T>(text: string): T {
  const line = text
    .split("\n")
    .find((candidate) => /^1:/.test(candidate.trim()));
  if (!line) {
    throw new CliError(
      `Could not find RSC payload line in response: ${text.slice(0, 500)}`,
      5,
    );
  }
  const payload = line.replace(/^1:/, "").replace(/\$undefined/g, "null");
  return JSON.parse(payload) as T;
}

function extractFlightPageProp<T>(html: string, prop: string, anchorOverride?: string): T {
  const scriptPattern = /self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g;
  const chunks: string[] = [];
  for (const match of html.matchAll(scriptPattern)) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (Array.isArray(envelope) && typeof envelope[1] === "string") {
      chunks.push(envelope[1]);
    }
  }
  const payload = chunks.join("");
  const anchor = `"${prop}":`;
  const anchorIndex = payload.indexOf(anchorOverride ?? anchor);
  if (anchorIndex === -1) {
    throw new CliError(`Could not find ${prop} in the rendered page payload.`, 5);
  }
  let valueStart = anchorIndex + anchor.length;
  while (/\s/.test(payload[valueStart] ?? "")) valueStart += 1;
  const opener = payload[valueStart];
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : null;
  if (!closer) {
    throw new CliError(`Rendered ${prop} payload is not JSON object/array.`, 5);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = valueStart; index < payload.length; index += 1) {
    const character = payload[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opener) depth += 1;
    if (character === closer) depth -= 1;
    if (depth === 0) {
      return JSON.parse(payload.slice(valueStart, index + 1)) as T;
    }
  }
  throw new CliError(`Could not find the end of rendered ${prop} payload.`, 5);
}

async function getBadgesForLocation(
  options: Options,
  locationId: string,
): Promise<BadgeState> {
  const response = await boostlyFetch(options, "/in-store?tab=badges", {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Cache-Control": "no-cache",
    },
  });
  const html = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new CliError(
      `Auth redirected to ${response.headers.get("location") || "unknown location"}`,
      4,
    );
  }
  if (!response.ok) {
    throw new CliError(
      `Badges page failed: HTTP ${response.status}\n${html.slice(0, 500)}`,
      5,
    );
  }
  if (html.includes("/sign-in") && !html.includes('"badges"')) {
    throw new CliError(
      "Badges page returned sign-in HTML. Refresh BOOSTLY_COOKIE.",
      4,
    );
  }
  const allBadges = extractFlightPageProp<BadgeRecord[]>(html, "badges");
  const badges = allBadges
    .filter(
      (badge) => badge.location_id === locationId && badge.deleted_at == null,
    )
    .sort((left, right) => left.issue_id - right.issue_id);
  return {
    location_id: locationId,
    active_count: badges.length,
    assigned_count: badges.filter((badge) => badge.account_user_id).length,
    unassigned_count: badges.filter((badge) => !badge.account_user_id).length,
    max_issue_id:
      badges.length > 0 ? Math.max(...badges.map((badge) => badge.issue_id)) : null,
    badges: badges.map((badge) => ({
      id: badge.id,
      short_id: badge.short_id,
      issue_id: badge.issue_id,
      assigned: Boolean(badge.account_user_id),
      created_at: badge.created_at,
    })),
  };
}

function requestedBadgeQuantity(options: Options): number {
  const raw = optString(options, "quantity");
  const quantity = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(quantity) || quantity < 2 || quantity > 100) {
    throw new CliError("--quantity must be a whole number from 2 to 100", 2);
  }
  return quantity;
}

function badgeReceiptPath(options: Options): string {
  return (
    optString(options, "receipt-file") ||
    process.env.BOOSTLY_BADGE_RECEIPT_FILE ||
    DEFAULT_BADGE_RECEIPT_FILE
  );
}

function badgeIdempotencyKey(options: Options): string {
  const key = optString(options, "idempotency-key")?.trim() ?? "";
  if (!key || key.length > 500) {
    throw new CliError(
      "--idempotency-key is required for badge creation and must be 500 characters or fewer",
      2,
    );
  }
  return key;
}

async function readBadgeReceipts(path: string): Promise<BadgeReceipt[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as BadgeReceipt;
      } catch (error) {
        throw new CliError(
          `Invalid badge receipt JSON at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          5,
        );
      }
    });
}

async function appendBadgeReceipt(path: string, receipt: BadgeReceipt) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function badgeReceiptError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://<redacted>")
    .slice(0, 500);
}

async function completedBadgeReceipt(
  options: Options,
  receiptFile: string,
  idempotencyKey: string,
  locationId: string,
  quantity: number,
  readback: BadgeState,
): Promise<boolean> {
  const prior = (await readBadgeReceipts(receiptFile))
    .filter((receipt) => receipt.idempotency_key === idempotencyKey)
    .at(-1);
  if (!prior) return false;
  if (prior.location_id !== locationId || prior.quantity !== quantity) {
    throw new CliError(
      `Idempotency key collision: prior badge attempt used location ${prior.location_id} quantity ${prior.quantity}.`,
      3,
    );
  }
  if (prior.status !== "completed") {
    throw new CliError(
      `Badge attempt ${idempotencyKey} has ${prior.status} status. Refusing an automatic retry; inspect the live badge count and receipt first.`,
      3,
    );
  }
  printOutput(options, {
    applied: false,
    idempotent: true,
    idempotency_key: idempotencyKey,
    prior_receipt: prior,
    readback,
  });
  return true;
}

async function acquireBadgeLock(receiptFile: string, idempotencyKey: string) {
  await mkdir(dirname(receiptFile), { recursive: true });
  const digest = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 24);
  const path = `${receiptFile}.${digest}.lock`;
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ idempotency_key: idempotencyKey, acquired_at: new Date().toISOString(), pid: process.pid })}\n`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(
        `Badge attempt ${idempotencyKey} is already locked by another run or a prior interrupted run. Refusing to submit.`,
        3,
      );
    }
    if (handle) await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return async () => {
    await handle.close();
    await unlink(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  };
}

function assertBadgeSession(
  context: LocationAccountContext,
  session: AuthSessionAccount,
) {
  if (!session.id || session.id !== context.account_id) {
    throw new CliError(
      `Refusing badge operation because the authenticated session account ${session.id ?? "none"} does not match target account ${context.account_id}. Re-run with --ensure-location-scope.`,
      4,
    );
  }
}

async function handleBulkBadgeCreate(options: Options, locationId: string) {
  const quantity = requestedBadgeQuantity(options);
  const idempotencyKey = badgeIdempotencyKey(options);
  await maybeEnsureLocationScope(options, locationId);
  const [context, session, before] = await Promise.all([
    getLocationAccountContext(locationId),
    getAuthSessionAccount(options),
    getBadgesForLocation(options, locationId),
  ]);
  assertBadgeSession(context, session);
  const receiptFile = badgeReceiptPath(options);

  if (!optBool(options, "apply")) {
    printOutput(options, {
      dry_run: true,
      action: "create_bulk_badges",
      location: { id: context.location_id, name: context.location_name },
      quantity,
      idempotency_key: idempotencyKey,
      before,
      receipt_file: receiptFile,
    });
    return;
  }

  if (
    await completedBadgeReceipt(
      options,
      receiptFile,
      idempotencyKey,
      locationId,
      quantity,
      before,
    )
  ) {
    return;
  }
  await assertTargetLocationWebPage(options, locationId);
  const releaseLock = await acquireBadgeLock(receiptFile, idempotencyKey);
  try {
    if (
      await completedBadgeReceipt(
        options,
        receiptFile,
        idempotencyKey,
        locationId,
        quantity,
        before,
      )
    ) {
      return;
    }
    const started: BadgeReceipt = {
      recorded_at: new Date().toISOString(),
      idempotency_key: idempotencyKey,
      location_id: locationId,
      quantity,
      status: "started",
      before_count: before.active_count,
    };
    await appendBadgeReceipt(receiptFile, started);

    let result: JsonValue;
    try {
      result = await callServerAction<JsonValue>(
        options,
        "/in-store?tab=badges",
        "createBulkBadges",
        [{ location_id: locationId, quantity }],
      );
      assertServerActionSucceeded(result, "Bulk badge creation");
    } catch (error) {
      await appendBadgeReceipt(receiptFile, {
        ...started,
        recorded_at: new Date().toISOString(),
        status: "ambiguous",
        error: badgeReceiptError(error),
      });
      throw error;
    }

    let after: BadgeState;
    let createdBadgeIds: string[];
    try {
      after = await getBadgesForLocation(options, locationId);
      const beforeIds = new Set(before.badges.map((badge) => badge.id));
      createdBadgeIds = after.badges
        .filter((badge) => !beforeIds.has(badge.id))
        .map((badge) => badge.id);
      if (
        after.active_count !== before.active_count + quantity ||
        createdBadgeIds.length !== quantity
      ) {
        throw new CliError(
          `Badge readback mismatch: expected count ${before.active_count + quantity} with ${quantity} new ids, got count ${after.active_count} with ${createdBadgeIds.length} new ids.`,
          5,
        );
      }
      await appendBadgeReceipt(receiptFile, {
        ...started,
        recorded_at: new Date().toISOString(),
        status: "completed",
        after_count: after.active_count,
        created_badge_ids: createdBadgeIds,
      });
    } catch (error) {
      await appendBadgeReceipt(receiptFile, {
        ...started,
        recorded_at: new Date().toISOString(),
        status: "ambiguous",
        error: badgeReceiptError(error),
      });
      throw error;
    }

    printOutput(options, {
      applied: true,
      idempotent: false,
      idempotency_key: idempotencyKey,
      quantity,
      created_badge_ids: createdBadgeIds,
      before,
      readback: after,
      receipt_file: receiptFile,
      success_result: result,
    });
  } finally {
    await releaseLock();
  }
}

async function getEvents(
  options: Options,
  locationId: string,
): Promise<TouchpointEvent[]> {
  const result = await callServerAction<TouchpointEvent[] | null>(
    options,
    `/in-store/links/location/${encodeURIComponent(locationId)}`,
    "getEvents",
    [locationId],
  );
  return result ?? [];
}

async function getObjectives(
  options: Options,
  locationId: string,
): Promise<JsonValue> {
  return callServerAction<JsonValue>(
    options,
    `/in-store/links/location/${encodeURIComponent(locationId)}`,
    "getObjectives",
    [locationId],
  );
}

async function saveEvents(
  options: Options,
  locationId: string,
  events: TouchpointEvent[],
): Promise<JsonValue> {
  const normalizedEvents = normalizeLegacyInactiveCustomPlaceholders(events);
  return callServerAction<JsonValue>(
    options,
    `/in-store/links/location/${encodeURIComponent(locationId)}`,
    "saveEvents",
    [[{ locationId, events: normalizedEvents }]],
  );
}

async function getAuthSessionAccount(options: Options): Promise<AuthSessionAccount> {
  const response = await boostlyFetch(options, "/api/auth/session", {
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(
      `Session check failed: HTTP ${response.status}\n${text.slice(0, 500)}`,
      4,
    );
  }
  const session = JSON.parse(text) as {
    user?: {
      account?: { id?: string | null; name?: string | null } | null;
      is_admin?: boolean;
      is_super_admin?: boolean;
    };
    spoofedAccountId?: string | null;
    selectedAccountId?: string | null;
  };
  return {
    id: session.user?.account?.id ?? null,
    name: session.user?.account?.name ?? null,
    spoofedAccountId: session.spoofedAccountId ?? null,
    selectedAccountId: session.selectedAccountId ?? null,
    is_admin: session.user?.is_admin,
    is_super_admin: session.user?.is_super_admin,
  };
}

async function getCsrfToken(options: Options): Promise<string> {
  const response = await boostlyFetch(options, "/api/auth/csrf", {
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(
      `CSRF token request failed: HTTP ${response.status}\n${text.slice(0, 500)}`,
      4,
    );
  }
  const payload = JSON.parse(text) as { csrfToken?: string };
  if (!payload.csrfToken) {
    throw new CliError("CSRF token request did not return csrfToken.", 4);
  }
  return payload.csrfToken;
}

async function updateAuthSession(
  options: Options,
  data: Record<string, string | null>,
): Promise<AuthSessionAccount> {
  const csrfToken = await getCsrfToken(options);
  const response = await boostlyFetch(options, "/api/auth/session", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ csrfToken, data }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(
      `Session update failed: HTTP ${response.status}\n${text.slice(0, 500)}`,
      4,
    );
  }
  const session = JSON.parse(text) as {
    user?: {
      account?: { id?: string | null; name?: string | null } | null;
      is_admin?: boolean;
      is_super_admin?: boolean;
    };
    spoofedAccountId?: string | null;
    selectedAccountId?: string | null;
  };
  return {
    id: session.user?.account?.id ?? null,
    name: session.user?.account?.name ?? null,
    spoofedAccountId: session.spoofedAccountId ?? null,
    selectedAccountId: session.selectedAccountId ?? null,
    is_admin: session.user?.is_admin,
    is_super_admin: session.user?.is_super_admin,
  };
}

async function switchUserAccount(
  options: Options,
  accountId: string,
): Promise<SwitchUserAccountResult> {
  return callServerAction<SwitchUserAccountResult>(
    options,
    "/campaigns",
    "switchUserAccount",
    [accountId],
  );
}

async function ensureLocationScope(options: Options, locationId: string) {
  const context = await getLocationAccountContext(locationId);
  const before = await getAuthSessionAccount(options);

  let switch_result: SwitchUserAccountResult | null = null;
  let session_update: AuthSessionAccount | null = null;
  if (before.id !== context.account_id) {
    if (!before.id) {
      throw new CliError(
        "Authenticated session has no effective account. Refresh the cookie or sign in again.",
        4,
      );
    }
    switch_result = await switchUserAccount(options, context.account_id);
    session_update = await updateAuthSession(
      options,
      switch_result.isAdmin
        ? { spoofedAccountId: context.account_id }
        : { selectedAccountId: context.account_id },
    );
  }

  const after = await getAuthSessionAccount(options);
  if (after.id !== context.account_id) {
    throw new CliError(
      `Unable to scope session to target account. Expected ${context.account_id} (${context.account_name}), got ${after.id ?? "none"} (${after.name ?? "unknown"}).`,
      4,
    );
  }
  const cookie_out = await writeCookieOut(options);
  return {
    target: {
      location_id: context.location_id,
      location_name: context.location_name,
      account_id: context.account_id,
      account_name: context.account_name,
    },
    changed: before.id !== after.id,
    before,
    switch_result,
    session_update,
    after,
    cookie_out: cookie_out ? { written: true, path: cookie_out } : null,
  };
}

async function maybeEnsureLocationScope(options: Options, locationId: string) {
  if (optBool(options, "ensure-location-scope")) {
    await ensureLocationScope(options, locationId);
  }
}

function assertNonEmptyEventsForWrite(
  events: TouchpointEvent[],
  locationId: string,
  options: Options,
) {
  if (events.length > 0 || optBool(options, "force-empty-events")) return;
  throw new CliError(
    `Refusing to save an empty event baseline for ${locationId}. This usually means the session is scoped to the wrong account. Re-run with --ensure-location-scope, or pass --force-empty-events only for an intentional empty-location repair.`,
    5,
  );
}

async function assertTargetLocationWebPage(options: Options, locationId: string) {
  const location = await getLocationFromWeb(options, locationId);
  if (location.id !== locationId) {
    throw new CliError(
      `Location page sanity check returned ${location.id}, expected ${locationId}.`,
      5,
    );
  }
}

async function getLocation(
  options: Options,
  locationId: string,
): Promise<LocationSettings> {
  const source = optString(options, "location-source") ?? "auto";
  if (!["auto", "web", "db"].includes(source)) {
    throw new CliError("--location-source must be auto, web, or db", 2);
  }
  if (source === "db") return getLocationFromDbCore(locationId);
  try {
    return await getLocationFromWeb(options, locationId);
  } catch (error) {
    if (source === "web") throw error;
    const fallback = await getLocationFromDbCore(locationId);
    fallback.__web_error =
      error instanceof Error ? error.message : String(error);
    return fallback;
  }
}

async function getLocationFromWeb(
  options: Options,
  locationId: string,
): Promise<LocationSettings> {
  const response = await boostlyFetch(
    options,
    `/locations/${encodeURIComponent(locationId)}`,
    {
      headers: { Accept: "text/html,application/xhtml+xml" },
    },
  );
  const html = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new CliError(
      `Auth redirected to ${response.headers.get("location") || "unknown location"}`,
      4,
    );
  }
  if (!response.ok) {
    throw new CliError(
      `Location page failed: HTTP ${response.status}\n${html.slice(0, 500)}`,
      5,
    );
  }
  if (
    html.includes("/sign-in") &&
    !html.includes(`\\"locationId\\":\\"${locationId}\\"`)
  ) {
    throw new CliError(
      "Location page returned sign-in HTML. Refresh BOOSTLY_COOKIE.",
      4,
    );
  }
  const location = extractLocation(html, locationId);
  location.__source = "web-page";
  return location;
}

async function getLocationFromDbCore(
  locationId: string,
): Promise<LocationSettings> {
  const sql = `
    select
      l.id,
      l.account_id,
      a.name as account_name,
      l.name,
      l.address,
      l.ordering_phone_number,
      l.ordering_url,
      l.website_url,
      l.timezone,
      l.google_place_id,
      l.status,
      l.shipping_recipient_name,
      l.shipping_address_line1,
      l.shipping_address_line2,
      l.shipping_city,
      l.shipping_state,
      l.shipping_zip,
      case when ab.id is null then null else jsonb_build_object(
        'web_primary_color', ab.web_primary_color,
        'web_secondary_color', ab.web_secondary_color,
        'web_text_color', ab.web_text_color,
        'print_primary_color', ab.print_primary_color,
        'print_secondary_color', ab.print_secondary_color,
        'print_text_color', ab.print_text_color,
        'print_text_secondary_color', ab.print_text_secondary_color,
        'logo_attachment_id', ab.logo_attachment_id,
        'facebook_url', ab.facebook_url,
        'instagram_url', ab.instagram_url,
        'x_url', ab.x_url,
        'tiktok_url', ab.tiktok_url,
        'youtube_url', ab.youtube_url,
        'apple_app_url', ab.apple_app_url,
        'google_app_url', ab.google_app_url,
        'logo_url', null,
        'logo_filename', null
      ) end as account_branding,
      case when ob.id is null then null else jsonb_build_object(
        'web_primary_color', ob.web_primary_color,
        'web_secondary_color', ob.web_secondary_color,
        'web_text_color', ob.web_text_color,
        'print_primary_color', ob.print_primary_color,
        'print_secondary_color', ob.print_secondary_color,
        'print_text_color', ob.print_text_color,
        'print_text_secondary_color', ob.print_text_secondary_color,
        'logo_attachment_id', ob.logo_attachment_id,
        'facebook_url', ob.facebook_url,
        'instagram_url', ob.instagram_url,
        'x_url', ob.x_url,
        'tiktok_url', ob.tiktok_url,
        'youtube_url', ob.youtube_url,
        'apple_app_url', ob.apple_app_url,
        'google_app_url', ob.google_app_url,
        'logo_url', null,
        'logo_filename', null
      ) end as override_branding
    from locations l
    join accounts a on a.id = l.account_id
    left join branding ab on ab.account_id = l.account_id and ab.location_id is null
    left join branding ob on ob.location_id = l.id
    where l.id = ${sqlLiteral(locationId)}
  `;
  const { stdout } = await execFileAsync(
    V2_DB,
    ["query", "--sql", sql, "--json"],
    {
      maxBuffer: 1024 * 1024,
    },
  );
  const rows = JSON.parse(stdout) as DbLocationRow[];
  const row = rows[0];
  if (!row)
    throw new CliError(
      `Location ${locationId} not found in V2 DB fallback.`,
      5,
    );
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    name: row.name,
    address: row.address,
    ordering_phone_number: row.ordering_phone_number,
    ordering_url: row.ordering_url,
    website_url: row.website_url,
    timezone: row.timezone,
    google_place_id: row.google_place_id,
    status: row.status,
    shipping_recipient_name: row.shipping_recipient_name,
    shipping_address_line1: row.shipping_address_line1,
    shipping_address_line2: row.shipping_address_line2,
    shipping_city: row.shipping_city,
    shipping_state: row.shipping_state,
    shipping_zip: row.shipping_zip,
    accountBranding: row.account_branding,
    overrideBranding: row.override_branding,
    __source: "v2-db-core",
    __warning: DB_CORE_LOCATION_WARNING,
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function extractLocation(html: string, locationId: string): LocationSettings {
  const anchor = `\\"locationId\\":\\"${escapeForRsc(locationId)}\\",\\"location\\":`;
  const start = html.indexOf(anchor);
  if (start === -1) {
    throw new CliError("Could not find location payload in rendered page.", 5);
  }
  const objectStart = html.indexOf("{", start + anchor.length);
  if (objectStart === -1)
    throw new CliError("Could not find location object start.", 5);

  let depth = 0;
  let end = -1;
  for (let i = objectStart; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) throw new CliError("Could not find location object end.", 5);

  const escapedJson = html.slice(objectStart, end);
  const decoded = decodeRscEscapedJson(escapedJson);
  return JSON.parse(decoded) as LocationSettings;
}

function escapeForRsc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function decodeRscEscapedJson(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  }
}

async function updateLocation(
  options: Options,
  locationId: string,
  location: LocationSettings,
): Promise<JsonValue> {
  return updateLocationForm(options, locationId, locationToFormData(location));
}

async function updateLocationForm(
  options: Options,
  locationId: string,
  payload: Record<string, JsonValue | undefined>,
  logoFile?: LogoFile,
): Promise<JsonValue> {
  if (logoFile) {
    return callServerActionWithFile<JsonValue>(
      options,
      `/locations/${encodeURIComponent(locationId)}`,
      "updateLocation",
      [locationId, payload],
      {
        fieldPath: [1, "logo_attachment_file"],
        blob: logoFile.blob,
        filename: logoFile.filename,
      },
    );
  }
  return callServerAction<JsonValue>(
    options,
    `/locations/${encodeURIComponent(locationId)}`,
    "updateLocation",
    [locationId, payload],
  );
}

function locationToFormData(
  location: LocationSettings,
): Record<string, JsonValue | undefined> {
  const branding = normalizeBranding(location.overrideBranding);
  return {
    name: location.name,
    address: location.address ?? "",
    ordering_phone_number: location.ordering_phone_number ?? "",
    ordering_url: location.ordering_url ?? "",
    website_url: location.website_url ?? "",
    timezone: location.timezone,
    google_place_id: location.google_place_id,
    ...brandingToFormFields(branding),
    shipping_recipient_name: location.shipping_recipient_name ?? "",
    shipping_address_line1: location.shipping_address_line1 ?? "",
    shipping_address_line2: location.shipping_address_line2 ?? "",
    shipping_city: location.shipping_city ?? "",
    shipping_state: location.shipping_state ?? "",
    shipping_zip: location.shipping_zip ?? "",
  };
}

function mutateLocation(
  location: LocationSettings,
  options: Options,
): LocationSettings {
  const next = { ...location };

  for (const [flag, field] of CORE_LOCATION_FIELD_FLAGS) {
    const value = optString(options, flag);
    if (value !== undefined) {
      (next[field] as string | null) = value;
    }
  }

  const clears = optClear(options);
  if (clears.length > 0) {
    throw new CliError(
      `Clearing location fields is not supported through the current app action. Refusing --clear ${clears.join(", ")}.`,
      2,
    );
  }

  return next;
}

function coreLocationFieldsRequested(
  options: Options,
): Array<(typeof CORE_LOCATION_FIELD_FLAGS)[number][1]> {
  return CORE_LOCATION_FIELD_FLAGS
    .filter(([flag]) => hasOption(options, flag))
    .map(([, field]) => field);
}

function assertFillOnlyLocation(
  before: LocationSettings,
  after: LocationSettings,
  options: Options,
) {
  if (!optBool(options, "fill-only")) return;
  const conflicts = coreLocationFieldsRequested(options).filter((field) => {
    const current = before[field];
    return current != null && String(current).trim() !== "" && current !== after[field];
  });
  if (conflicts.length) {
    throw new CliError(
      `Fill-only location write refused because these fields are already populated: ${conflicts.join(", ")}`,
      3,
    );
  }
}

function assertLocationReadback(
  expected: LocationSettings,
  actual: LocationSettings,
  options: Options,
) {
  const mismatches = coreLocationFieldsRequested(options).filter(
    (field) => actual[field] !== expected[field],
  );
  if (mismatches.length) {
    throw new CliError(`Location readback did not confirm: ${mismatches.join(", ")}`, 5);
  }
}

function brandingToFormFields(
  branding: BrandingSettings,
): Record<string, string | null> {
  return {
    ...Object.fromEntries(
      BRANDING_FIELDS.map((field) => [
        field,
        field === "logo_attachment_id"
          ? branding[field]
          : branding[field] ?? "",
      ]),
    ),
    logo_attachment_file: branding.logo_url ?? null,
  } as Record<string, string | null>;
}

async function updateAccountBranding(
  options: Options,
  branding: BrandingSettings,
  logoFile?: LogoFile,
): Promise<JsonValue> {
  const payload = brandingToFormFields(branding);
  if (logoFile) {
    return callServerActionWithFile<JsonValue>(
      options,
      "/account-settings",
      "updateAccountBranding",
      [payload],
      {
        fieldPath: [0, "logo_attachment_file"],
        blob: logoFile.blob,
        filename: logoFile.filename,
      },
    );
  }
  return callServerAction<JsonValue>(
    options,
    "/account-settings",
    "updateAccountBranding",
    [payload],
  );
}

type LogoFile = {
  path: string;
  filename: string;
  content_type: string;
  size: number;
  blob: Blob;
};

async function readLogoFile(options: Options): Promise<LogoFile | undefined> {
  const path = optString(options, "logo-file");
  if (!path) return undefined;
  if (hasOption(options, "logo-attachment-id")) {
    throw new CliError(
      "Use either --logo-file or --logo-attachment-id, not both.",
      2,
    );
  }
  const filename = path.split(/[\\/]/).pop() || "logo";
  const extension = filename.split(".").pop()?.toLowerCase();
  const contentType =
    extension === "png"
      ? "image/png"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "gif"
          ? "image/gif"
          : null;
  if (!contentType) {
    throw new CliError(
      "--logo-file must be a PNG, JPEG, or GIF image.",
      2,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new CliError(
      `Could not read --logo-file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  if (bytes.length === 0) {
    throw new CliError("--logo-file cannot be empty.", 2);
  }
  return {
    path,
    filename,
    content_type: contentType,
    size: bytes.length,
    blob: new Blob([new Uint8Array(bytes)], { type: contentType }),
  };
}

async function getLocationAccountContext(
  locationId: string,
): Promise<LocationAccountContext> {
  const sql = `
    with target as (
      select
        l.id as location_id,
        l.name as location_name,
        l.status as location_status,
        l.is_general,
        l.account_id,
        a.name as account_name
      from locations l
      join accounts a on a.id = l.account_id
      where l.id = ${sqlLiteral(locationId)}
    )
    select
      target.location_id,
      target.location_name,
      target.location_status,
      target.is_general,
      target.account_id,
      target.account_name,
      count(l2.id)::int as write_location_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object('id', l2.id, 'name', l2.name, 'status', l2.status)
          order by l2.name
        ) filter (where l2.id is not null),
        '[]'::jsonb
      ) as write_locations
    from target
    left join locations l2
      on l2.account_id = target.account_id
     and l2.status in ('enabled', 'paused')
     and l2.is_general = false
    group by
      target.location_id,
      target.location_name,
      target.location_status,
      target.is_general,
      target.account_id,
      target.account_name
  `;
  const { stdout } = await execFileAsync(
    V2_DB,
    ["query", "--sql", sql, "--json"],
    {
      maxBuffer: 1024 * 1024,
    },
  );
  const rows = JSON.parse(stdout) as LocationAccountContext[];
  const row = rows[0];
  if (!row) throw new CliError(`Location ${locationId} not found in V2 DB.`, 5);
  if (row.is_general) throw new CliError(`Location ${locationId} is General and cannot be a fulfillment target.`, 5);
  return row;
}

function selectedBrandingScope(
  context: LocationAccountContext,
  requested: BrandingScope,
): { scope: Exclude<BrandingScope, "auto">; reason: string } {
  if (requested === "account") {
    return { scope: "account", reason: "Forced by --scope account." };
  }
  if (requested === "location") {
    return { scope: "location", reason: "Forced by --scope location." };
  }
  if (context.write_location_count > 1) {
    return {
      scope: "location",
      reason: `Account has ${context.write_location_count} non-General enabled/paused locations, so branding writes use a location override.`,
    };
  }
  if (context.write_location_count === 1) {
    const onlyWriteLocation = context.write_locations[0];
    if (onlyWriteLocation?.id !== context.location_id) {
      return {
        scope: "location",
        reason: `The only non-General enabled/paused location is ${onlyWriteLocation?.name ?? onlyWriteLocation?.id ?? "a sibling"}, so branding for the target uses a location override.`,
      };
    }
    return {
      scope: "account",
      reason:
        "The target is the account's only non-General enabled/paused location, so branding writes use account settings.",
    };
  }
  throw new CliError(
    "Cannot auto-select branding scope because the account has no non-General enabled/paused locations. Re-run with --scope account or --scope location if that write is intentional.",
    2,
  );
}

async function getBrandingState(
  options: Options,
  locationId: string,
): Promise<BrandingState> {
  const requested = (optString(options, "scope") ?? "auto") as BrandingScope;
  if (!["auto", "account", "location"].includes(requested)) {
    throw new CliError("--scope must be auto, account, or location", 2);
  }

  const location = await getLocation(options, locationId);
  // Branding writes must have DB-backed scope evidence so General can never be
  // guessed from a page payload and account-vs-location inheritance stays exact.
  const context = await getLocationAccountContext(locationId);
  const account = normalizeBranding(location.accountBranding);
  const override = location.overrideBranding
    ? normalizeBranding(location.overrideBranding)
    : null;
  const { scope, reason } = selectedBrandingScope(context, requested);
  return {
    location,
    context,
    account,
    override,
    effective: resolveBranding(account, override),
    selected_scope: scope,
    scope_reason: reason,
  };
}

function mutateBranding(
  current: BrandingSettings,
  options: Options,
): BrandingSettings {
  const next = { ...current };
  for (const [flag, field] of BRANDING_FIELD_FLAGS) {
    const value = optString(options, flag);
    if (value !== undefined) {
      next[field] = value;
    }
  }
  for (const clear of optClear(options)) {
    const field = brandingFieldFromName(clear);
    if (!field) {
      throw new CliError(`Unsupported branding clear field: ${clear}`, 2);
    }
    next[field] = null;
    if (field === "logo_attachment_id") {
      next.logo_url = null;
      next.logo_filename = null;
    }
  }
  return next;
}

function locationFormWithBranding(
  location: LocationSettings,
  branding: BrandingSettings,
): Record<string, JsonValue | undefined> {
  return {
    ...locationToFormData(location),
    ...brandingToFormFields(branding),
  };
}

function assertLocationPageMatchesContext(state: BrandingState) {
  if (state.location.id !== state.context.location_id) {
    throw new CliError(
      `Refusing branding write because the authenticated page returned location ${state.location.id}, but DB context resolved ${state.context.location_id}.`,
      5,
    );
  }
  if (
    state.location.account_id &&
    state.location.account_id !== state.context.account_id
  ) {
    throw new CliError(
      `Refusing branding write because the authenticated page account ${state.location.account_id} does not match DB account ${state.context.account_id}.`,
      5,
    );
  }
}

function assertSessionMatchesContext(
  state: BrandingState,
  session: AuthSessionAccount,
) {
  if (!session.id) {
    throw new CliError(
      "Refusing branding write because the authenticated session has no effective account. Switch/spoof into the target account first.",
      4,
    );
  }
  if (session.id !== state.context.account_id) {
    throw new CliError(
      `Refusing branding write because the authenticated session account ${session.id} (${session.name ?? "unknown"}) does not match target account ${state.context.account_id} (${state.context.account_name}). Switch/spoof into the target account first.`,
      4,
    );
  }
}

function assertServerActionSucceeded(result: JsonValue, action: string) {
  if (
    !result ||
    Array.isArray(result) ||
    typeof result !== "object" ||
    result.success !== true
  ) {
    const errors =
      result && !Array.isArray(result) && typeof result === "object"
        ? result.errors
        : null;
    throw new CliError(
      `${action} failed: ${errors ? JSON.stringify(errors) : "server action did not return success: true"}`,
      5,
    );
  }
}

function brandingFieldsRequested(options: Options): BrandingField[] {
  const requested = BRANDING_FIELD_FLAGS.filter(([flag]) =>
    hasOption(options, flag),
  ).map(([, field]) => field);
  for (const clear of optClear(options)) {
    const field = brandingFieldFromName(clear);
    if (field) requested.push(field);
  }
  return [...new Set(requested)];
}

function assertFillOnlyBranding(
  before: BrandingSettings,
  after: BrandingSettings,
  options: Options,
  logoFile: LogoFile | undefined,
) {
  if (!optBool(options, "fill-only")) return;
  const conflicts = brandingFieldsRequested(options).filter(
    (field) => before[field] !== null && before[field] !== after[field],
  );
  if (logoFile && before.logo_attachment_id) conflicts.push("logo_attachment_id");
  if (conflicts.length) {
    throw new CliError(
      `Fill-only branding write refused because these target-scope fields are already populated: ${[...new Set(conflicts)].join(", ")}`,
      3,
    );
  }
}

function assertBrandingReadback(
  before: BrandingSettings,
  expected: BrandingSettings,
  actual: BrandingSettings,
  options: Options,
  logoFile: LogoFile | undefined,
) {
  const mismatches = brandingFieldsRequested(options).filter(
    (field) => actual[field] !== expected[field],
  );
  if (logoFile) {
    if (
      !actual.logo_attachment_id ||
      actual.logo_attachment_id === before.logo_attachment_id
    ) {
      mismatches.push("logo_attachment_id");
    }
  }
  if (mismatches.length > 0) {
    throw new CliError(
      `Branding readback did not confirm: ${[...new Set(mismatches)].join(", ")}`,
      5,
    );
  }
}

// ----------------------------------------------------------------------------
// Foreign-logo replay guard (2026-09-09, Swine Dining incident): `branding set`
// replays the whole row, so a logo someone else uploaded between our writes is
// carried forward unchanged and the before/after diff stays clean. These
// helpers let a caller pin the logo attachment they expect to be replayed.
// ----------------------------------------------------------------------------

export type LogoReplayInfo = {
  attachment_id: string | null;
  filename: string | null;
  uploaded_at: string | null;
  note: string;
};

// Attachment URLs carry a `2026-09-09T21-49-57-960Z-<hash>.png` basename.
export function logoUploadedAtFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const basename = url.split("?")[0].split("/").pop() ?? "";
  const match = basename.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
  );
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export function logoReplayInfo(row: BrandingSettings): LogoReplayInfo {
  return {
    attachment_id: row.logo_attachment_id ?? null,
    filename: row.logo_filename ?? null,
    uploaded_at: logoUploadedAtFromUrl(row.logo_url),
    note: "replayed unchanged; pass --expect-from-readback to guard",
  };
}

type ReadbackRowLike = {
  logo_attachment_id?: string | null;
  logo_url?: string | null;
  logo_filename?: string | null;
} | null | undefined;

// Accepts either the `branding get` shape (account_branding/override_branding/
// effective_branding at the top level) or the `branding set --apply` output
// shape (the same object nested under `.readback`). Returns the logo
// attachment id at the requested scope, falling back to effective_branding.
export function expectedLogoIdFromReadback(
  readback: unknown,
  scope: "account" | "location",
): { attachment_id: string | null; source: string } {
  if (!readback || typeof readback !== "object" || Array.isArray(readback)) {
    throw new CliError("--expect-from-readback file is not a JSON object.", 2);
  }
  let root = readback as Record<string, unknown>;
  let prefix = "";
  if (
    !("account_branding" in root) &&
    !("override_branding" in root) &&
    !("effective_branding" in root) &&
    root.readback &&
    typeof root.readback === "object" &&
    !Array.isArray(root.readback)
  ) {
    root = root.readback as Record<string, unknown>;
    prefix = "readback.";
  }
  const scoped = scope === "account" ? "account_branding" : "override_branding";
  const candidates: Array<[string, ReadbackRowLike]> = [
    [scoped, root[scoped] as ReadbackRowLike],
    ["effective_branding", root.effective_branding as ReadbackRowLike],
  ];
  const present = candidates.filter(
    ([, row]) => row && typeof row === "object",
  );
  if (present.length === 0) {
    throw new CliError(
      `--expect-from-readback file has no ${scoped} or effective_branding row (expected a branding get or branding set --apply output).`,
      2,
    );
  }
  const [key, row] = present[0];
  return {
    attachment_id: row?.logo_attachment_id ?? null,
    source: `${prefix}${key}`,
  };
}

export type ExpectedLogo = { attachment_id: string | null; source: string };

// Resolves the expected id from --expect-logo-attachment-id and/or
// --expect-from-readback. Returns undefined when neither flag is present.
export async function resolveExpectedLogo(
  options: Options,
  scope: "account" | "location",
): Promise<ExpectedLogo | undefined> {
  const explicit = optString(options, "expect-logo-attachment-id");
  const readbackPath = optString(options, "expect-from-readback");
  if (explicit === undefined && readbackPath === undefined) return undefined;
  let fromReadback: ExpectedLogo | undefined;
  if (readbackPath !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(readbackPath, "utf8"));
    } catch (error) {
      throw new CliError(
        `Could not read --expect-from-readback ${readbackPath}: ${error instanceof Error ? error.message : String(error)}`,
        2,
      );
    }
    const derived = expectedLogoIdFromReadback(parsed, scope);
    fromReadback = {
      attachment_id: derived.attachment_id,
      source: `${readbackPath} (${derived.source})`,
    };
  }
  if (explicit !== undefined) {
    const id = explicit.trim() === "" || explicit.toLowerCase() === "null" ? null : explicit.trim();
    if (fromReadback && fromReadback.attachment_id !== id) {
      throw new CliError(
        `--expect-logo-attachment-id ${id ?? "null"} disagrees with --expect-from-readback ${fromReadback.source} (${fromReadback.attachment_id ?? "null"}). Pass one or make them agree.`,
        2,
      );
    }
    return { attachment_id: id, source: "--expect-logo-attachment-id" };
  }
  return fromReadback;
}

// Throws (exit 6) when the row that is about to be replayed carries a logo
// other than the one the caller expects. Runs before any write, dry-run or
// --apply alike. Callers that replace the logo (--logo-file /
// --logo-attachment-id) skip this because the replayed logo is discarded.
export function assertExpectedLogoAttachment(
  row: BrandingSettings,
  expected: ExpectedLogo,
  scope: "account" | "location",
) {
  const current = row.logo_attachment_id ?? null;
  if (current === expected.attachment_id) return;
  throw new CliError(
    [
      `Refusing branding write: the ${scope}-scope row would replay logo attachment ${current ?? "null"} but ${expected.source} expects ${expected.attachment_id ?? "null"}.`,
      `Current logo: filename=${row.logo_filename ?? "null"} url=${row.logo_url ?? "null"} uploaded_at=${logoUploadedAtFromUrl(row.logo_url) ?? "unknown"}.`,
      "Someone else likely uploaded a logo since your last write (2026-09-09 Swine Dining incident).",
      `Fix: pass --logo-file <path> to replace it, or --expect-logo-attachment-id ${current ?? "null"} to accept it.`,
    ].join("\n"),
    6,
  );
}

export function socialLinksPayload(options: Options, scope: "account" | "location") {
  const flags = BRANDING_FIELD_FLAGS.slice(0, 5);
  const allowed = new Set([...flags.map(([flag]) => flag), "scope", "fill-only", "apply", "json", "cookie-file", "cookie", "cookie-out", "ensure-location-scope", "base-url", "expected-state-hash"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new CliError(`socials set does not accept --${key}`, 2);
  }
  const links: Record<string, string> = {};
  for (const [flag, field] of flags) {
    if (!hasOption(options, flag)) continue;
    const value = optString(options, flag)?.trim();
    if (!value) throw new CliError(`--${flag} requires a nonempty HTTPS URL`, 2);
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || value.length > 2048) throw new CliError(`Invalid --${flag}`, 2);
    links[field] = value;
  }
  if (!Object.keys(links).length) throw new CliError("socials set requires a social URL", 2);
  return { scope, links, dry_run: !optBool(options, "apply") };
}

function socialStateSnapshot(state: BrandingState) {
  const fields = (row: BrandingSettings | null) => Object.fromEntries(
    BRANDING_FIELDS.map(field => [field, row?.[field] ?? null]),
  );
  const core = locationToFormData(state.location);
  for (const field of [...BRANDING_FIELDS, "logo_attachment_file"]) delete core[field];
  return {
    location_id: state.location.id, account_id: state.context.account_id,
    scope: state.selected_scope, account: fields(state.account),
    override: fields(state.override), effective: fields(state.effective), core,
  };
}

export function prepareSocialSave(state: BrandingState, options: Options) {
  const { links } = socialLinksPayload(options, state.selected_scope);
  const before = state.selected_scope === "account" ? state.account : normalizeBranding(state.override);
  const after = { ...before };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(links)) {
    const field = key as BrandingField;
    for (const current of [before[field], state.effective[field]]) {
      if (current && current !== value) throw new CliError(`Fill-only social write refused: ${field} already contains a different URL`, 3);
    }
    if (state.effective[field] === value) continue;
    after[field] = value;
    changed.push(field);
  }
  // Refuse replay when the existing form action would normalize unrelated fields.
  if (changed.length && state.selected_scope === "account") {
    for (const [print, fallback] of [
      ["print_primary_color", "web_primary_color"], ["print_secondary_color", "web_secondary_color"],
      ["print_text_color", "web_text_color"], ["print_text_secondary_color", "print_text_color"],
    ] as const) {
      if (!before[print] && before[fallback]) throw new CliError(`Existing account save would normalize ${print}; refusing to change branding`, 5);
    }
  }
  if (changed.length && state.selected_scope === "location") {
    for (const field of BRANDING_FIELDS) {
      if (before[field] != null && before[field] === state.account[field]) {
        throw new CliError(`Existing location save would normalize redundant override ${field}; refusing to change saved settings`, 5);
      }
    }
  }
  const state_hash = createHash("sha256").update(JSON.stringify({ snapshot: socialStateSnapshot(state), links })).digest("hex");
  return { links, before, after, changed, state_hash };
}

type SocialSaveDependencies = {
  read: () => Promise<BrandingState>;
  session: () => Promise<AuthSessionAccount>;
  save: (state: BrandingState, after: BrandingSettings) => Promise<JsonValue>;
};

export async function runSocialSave(options: Options, deps: SocialSaveDependencies) {
  socialLinksPayload(options, "location");
  const validate = async (state: BrandingState) => {
    if (state.location.__source !== "web-page") throw new CliError("Social writes require authenticated web-page evidence", 5);
    assertLocationPageMatchesContext(state);
    assertSessionMatchesContext(state, await deps.session());
  };
  const state = await deps.read();
  await validate(state);
  const plan = prepareSocialSave(state, options);
  const expectedHash = optString(options, "expected-state-hash");
  if (expectedHash && expectedHash !== plan.state_hash) throw new CliError("Social settings changed since preview; run a fresh dry-run", 5);
  const result = { success: true, dry_run: !optBool(options, "apply"), selected_scope: state.selected_scope,
    state_hash: plan.state_hash, no_op: plan.changed.length === 0, changed: plan.changed,
    before: plan.before, after: plan.after };
  if (result.dry_run) return result;
  if (!expectedHash) throw new CliError("Social apply requires --expected-state-hash from its dry-run", 2);
  const fresh = await deps.read();
  await validate(fresh);
  if (prepareSocialSave(fresh, options).state_hash !== plan.state_hash) throw new CliError("Social settings changed before save; nothing was written", 5);
  if (!result.no_op) {
    assertServerActionSucceeded(await deps.save(fresh, plan.after), "socials set");
  }
  const readback = await deps.read();
  await validate(readback);
  const expected = { ...state };
  if (!result.no_op) {
    if (state.selected_scope === "account") expected.account = plan.after;
    else expected.override = plan.after;
    expected.effective = resolveBranding(expected.account, expected.override);
  }
  if (JSON.stringify(socialStateSnapshot(expected)) !== JSON.stringify(socialStateSnapshot(readback))) {
    throw new CliError("Social readback mismatch: URLs or preserved branding/location settings differ; stop and inspect before retrying", 5);
  }
  return { ...result, preserved_settings_verified: true, readback: summarizeBrandingState(readback) };
}

async function handleSocialsSet(options: Options, locationId: string) {
  const result = await runSocialSave(options, {
    read: () => getBrandingState(options, locationId),
    session: () => getAuthSessionAccount(options),
    save: (state, after) => state.selected_scope === "account"
      ? updateAccountBranding(options, after)
      : updateLocationForm(options, locationId, locationFormWithBranding(state.location, after)),
  });
  printOutput(options, result);
}

async function handleBrandingSet(options: Options, locationId: string) {
  const logoFile = await readLogoFile(options);
  const state = await getBrandingState(options, locationId);
  const session = await getAuthSessionAccount(options);
  const before =
    state.selected_scope === "account"
      ? state.account
      : normalizeBranding(state.override);
  const after = mutateBranding(before, options);
  assertFillOnlyBranding(before, after, options, logoFile);

  const replacesLogo = Boolean(logoFile) || hasOption(options, "logo-attachment-id");
  const expectedLogo = await resolveExpectedLogo(options, state.selected_scope);
  let logoGuard: JsonValue;
  if (replacesLogo) {
    logoGuard = expectedLogo
      ? "skipped: this write replaces the logo, so the replayed logo is discarded"
      : "not applicable: this write replaces the logo";
  } else if (expectedLogo) {
    assertExpectedLogoAttachment(before, expectedLogo, state.selected_scope);
    logoGuard = `matched ${expectedLogo.attachment_id ?? "null"} from ${expectedLogo.source}`;
  } else {
    logoGuard = "unguarded";
  }
  const logoReplay = replacesLogo ? null : logoReplayInfo(before);

  if (!optBool(options, "apply")) {
    if (logoReplay && logoReplay.attachment_id && !expectedLogo) {
      console.error(
        `WARNING: branding set will replay logo attachment ${logoReplay.attachment_id} (${logoReplay.filename ?? "unknown filename"}, uploaded ${logoReplay.uploaded_at ?? "unknown"}) unchanged at ${state.selected_scope} scope. Pass --expect-from-readback <production-readback.json> to guard against a foreign upload.`,
      );
    }
    printOutput(options, {
      dry_run: true,
      logo_replay: logoReplay,
      logo_guard: logoGuard,
      selected_scope: state.selected_scope,
      scope_reason: state.scope_reason,
      account: {
        id: state.context.account_id,
        name: state.context.account_name,
        write_location_count: state.context.write_location_count,
      },
      authenticated_account: session,
      location: {
        id: state.context.location_id,
        name: state.context.location_name,
      },
      before,
      after,
      logo_upload: logoFile
        ? {
            filename: logoFile.filename,
            content_type: logoFile.content_type,
            size: logoFile.size,
            note: "Will upload and replace logo_attachment_id on --apply.",
          }
        : null,
    });
    return;
  }

  if (state.location.__source !== "web-page") {
    throw new CliError(
      `Refusing branding write without an authenticated web page payload. ${DB_CORE_LOCATION_WARNING}`,
      5,
    );
  }
  assertLocationPageMatchesContext(state);
  assertSessionMatchesContext(state, session);

  const requested = brandingFieldsRequested(options);
  if (!logoFile && requested.every((field) => before[field] === after[field])) {
    printOutput(options, {
      success: true,
      no_op: true,
      selected_scope: state.selected_scope,
      scope_reason: state.scope_reason,
      readback: summarizeBrandingState(state),
    });
    return;
  }

  const result =
    state.selected_scope === "account"
      ? await updateAccountBranding(options, after, logoFile)
      : await updateLocationForm(
          options,
          locationId,
          locationFormWithBranding(state.location, after),
          logoFile,
        );
  assertServerActionSucceeded(result, "Branding update");
  const readback = await getBrandingState(options, locationId);
  const actual =
    state.selected_scope === "account"
      ? readback.account
      : normalizeBranding(readback.override);
  assertBrandingReadback(before, after, actual, options, logoFile);
  printOutput(options, {
    success_result: result,
    logo_guard: logoGuard,
    selected_scope: state.selected_scope,
    scope_reason: state.scope_reason,
    readback: summarizeBrandingState(readback),
  });
}

function findEvent(
  events: TouchpointEvent[],
  selector: string,
): TouchpointEvent {
  const normalized = normalize(selector);
  const candidates = events.filter((event) => {
    return (
      normalize(event.touchpoint_event_id || "") === normalized ||
      normalize(event.type) === normalized ||
      normalize(event.title) === normalized ||
      normalize(event.display_title || "") === normalized ||
      normalize(event.touchpoint_event_default_id) === normalized
    );
  });
  if (candidates.length === 0)
    throw new CliError(`No event matched "${selector}"`, 2);
  if (candidates.length > 1) {
    throw new CliError(
      `Selector "${selector}" matched multiple events: ${candidates.map(eventLabel).join(", ")}`,
      2,
    );
  }
  return candidates[0];
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function eventLabel(event: TouchpointEvent): string {
  return `${event.title} (${event.type}${event.touchpoint_event_id ? `:${event.touchpoint_event_id}` : ""})`;
}

function mutateEvent(event: TouchpointEvent, options: Options) {
  const active = optTriBool(options, "active");
  if (active !== undefined) event.is_active = active;

  const setters: Array<[string, keyof TouchpointEvent]> = [
    ["title", "title"],
    ["display-title", "display_title"],
    ["description", "description"],
    ["button-text", "primary_button_text"],
    ["link", "link"],
    ["objective-id", "objective_id"],
    ["promotion-id", "subscribe_link_promotion_id"],
    ["welcome-message", "subscribe_link_response_message"],
  ];
  for (const [flag, field] of setters) {
    const value = optString(options, flag);
    if (value !== undefined) {
      (event[field] as string | null | undefined) = value;
    }
  }

  const configJson = optString(options, "config-json");
  if (configJson !== undefined)
    event.config = JSON.parse(configJson) as JsonValue;

  for (const field of optClear(options)) {
    switch (field) {
      case "description":
        event.description = null;
        break;
      case "button-text":
      case "primary_button_text":
        event.primary_button_text = null;
        break;
      case "link":
        event.link = null;
        break;
      case "objective-id":
      case "objective_id":
        event.objective_id = null;
        break;
      case "config":
        event.config = null;
        break;
      case "promotion-id":
      case "subscribe_link_promotion_id":
        event.subscribe_link_promotion_id = undefined;
        break;
      case "welcome-message":
      case "subscribe_link_response_message":
        event.subscribe_link_response_message = undefined;
        break;
      default:
        throw new CliError(`Unsupported event clear field: ${field}`, 2);
    }
  }
}

function buildCustomEvent(
  events: TouchpointEvent[],
  options: Options,
): TouchpointEvent {
  const title = optString(options, "title");
  if (!title) throw new CliError("add-custom requires --title", 2);
  const maxSort = Math.max(-1, ...events.map((event) => event.sort_order));
  const category = optString(options, "category");
  const event: TouchpointEvent = {
    touchpoint_event_default_id: "tid_custom",
    type: "custom",
    title,
    display_title: optString(options, "display-title") ?? title,
    description: optString(options, "description") ?? "",
    primary_button_text: optString(options, "button-text") ?? "",
    link: optString(options, "link") ?? "",
    sort_order: maxSort + 1,
    is_active: optTriBool(options, "active") ?? true,
    config: null,
    objective_id: optString(options, "objective-id") ?? null,
  };
  if (isDisallowedCustomLink(category, event)) {
    throw new CliError("Specials must not be created as a custom Link/Product event", 2);
  }
  return validateCustomLinkDescription(
    applyCustomLinkPresentation(event, category),
  );
}

function validateCustomLinkDescription<T extends TouchpointEvent>(event: T): T {
  if (event.type !== "custom") return event;
  const described = applyCustomLinkDescription(event);
  const description = described.description?.trim() || "";
  if (!description) {
    throw new CliError("Custom Link/Product events require a description.", 2);
  }
  if ([...description].length > CUSTOM_LINK_DESCRIPTION_MAX_LENGTH) {
    throw new CliError(
      `Custom Link/Product descriptions must be ${CUSTOM_LINK_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      2,
    );
  }
  return described;
}

export function canonicalEventUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    for (const key of [...url.searchParams.keys()]) {
      const providerPopupParam = /(?:^|\.)foodtecsolutions\.com$/i.test(url.hostname) &&
        /^(?:source|destination|promotion)$/i.test(key);
      if (/^(?:utm_.+|fbclid|gclid)$/i.test(key) || providerPopupParam) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

function matchingCustomEvents(
  events: TouchpointEvent[],
  expected: TouchpointEvent,
): TouchpointEvent[] {
  const expectedUrl = canonicalEventUrl(expected.link);
  return events.filter((event) =>
    event.type === "custom" &&
    expectedUrl !== null &&
    canonicalEventUrl(event.link) === expectedUrl,
  );
}

function customEventMatches(expected: TouchpointEvent, actual: TouchpointEvent): boolean {
  return actual.is_active === expected.is_active &&
    actual.title === expected.title &&
    actual.display_title === expected.display_title &&
    (actual.description ?? "") === (expected.description ?? "") &&
    (actual.primary_button_text ?? "") === (expected.primary_button_text ?? "") &&
    canonicalEventUrl(actual.link) === canonicalEventUrl(expected.link);
}

function hasConfiguredSocials(branding: BrandingSettings): boolean {
  return [
    branding.facebook_url,
    branding.instagram_url,
    branding.x_url,
    branding.tiktok_url,
    branding.youtube_url,
  ].some((value) => Boolean(value?.trim()));
}

async function enforceLinkTreeDefaults(
  options: Options,
  locationId: string,
): Promise<void> {
  await maybeEnsureLocationScope(options, locationId);
  const current = await getEvents(options, locationId);
  assertNonEmptyEventsForWrite(current, locationId, options);
  const branding = await getBrandingState(options, locationId);
  const verifiedSocialsPresent = optTriBool(options, "verified-socials-present");
  const verifiedUpcomingEvents = optTriBool(options, "verified-upcoming-events");
  const verifiedOpenings = optTriBool(options, "verified-openings");
  const plannedSocialsPresent = optBool(options, "planned-socials-present");
  if (verifiedSocialsPresent === undefined) {
    throw new CliError("events enforce-linktree-defaults requires --verified-socials-present true|false from the validated discovery report.", 2);
  }
  if (plannedSocialsPresent && optBool(options, "apply")) {
    throw new CliError("--planned-socials-present is dry-run only; apply requires configured production socials.", 2);
  }
  if (verifiedSocialsPresent && !hasConfiguredSocials(branding.effective) && !plannedSocialsPresent) {
    throw new CliError("Validated socials were reported, but effective branding has no configured social URL.", 5);
  }
  const policy = enforceLinkTreeVisibility(current, {
    hasVerifiedSocials: verifiedSocialsPresent,
    hasVerifiedUpcomingEvents: verifiedUpcomingEvents,
    hasVerifiedOpenings: verifiedOpenings,
  });
  if (policy.missing.length > 0) {
    throw new CliError(
      `Cannot enforce link-tree defaults because these default events are missing: ${policy.missing.join(", ")}.`,
      5,
    );
  }

  if (!optBool(options, "apply")) {
    printOutput(options, {
      dry_run: true,
      has_verified_socials: verifiedSocialsPresent,
      has_verified_upcoming_events: verifiedUpcomingEvents ?? null,
      has_verified_openings: verifiedOpenings ?? null,
      socials_source: plannedSocialsPresent ? "prior_planned_branding_write" : "production_readback",
      changed: policy.changed,
      resulting_events: summarizeEvents(policy.events),
    });
    return;
  }

  await assertTargetLocationWebPage(options, locationId);
  if (policy.changed.length === 0) {
    printOutput(options, {
      success: true,
      no_op: true,
      has_verified_socials: verifiedSocialsPresent,
      has_verified_upcoming_events: verifiedUpcomingEvents ?? null,
      has_verified_openings: verifiedOpenings ?? null,
      changed: [],
      readback: summarizeEvents(current),
    });
    return;
  }
  await saveEvents(options, locationId, policy.events);
  const readback = await getEvents(options, locationId);
  const review = readback.find((event) => event.type === "review");
  const socials = readback.find((event) => event.type === "socials");
  if (!review?.is_active || (verifiedSocialsPresent && !socials?.is_active)) {
    throw new CliError(
      "Link-tree default readback failed: Reviews and configured Socials were not both active.",
      5,
    );
  }
  const readbackPolicy = enforceLinkTreeVisibility(readback, verifiedSocialsPresent);
  if (readbackPolicy.changed.includes("menu_duplicate_of_order")) {
    throw new CliError(
      "Link-tree default readback failed: Menu still duplicates the active Order Online URL.",
      5,
    );
  }
  printOutput(options, {
    success: true,
    has_verified_socials: verifiedSocialsPresent,
    changed: policy.changed,
    readback: summarizeEvents(readback),
  });
}

function assertApply(options: Options, action: string) {
  if (!optBool(options, "apply")) {
    throw new CliError(
      `${action} is a dry run. Re-run with --apply to write changes.`,
      3,
    );
  }
}

function printOutput(options: Options, value: unknown) {
  if (optBool(options, "json") || typeof value !== "object" || value === null) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "object" && raw !== null) {
      console.log(`${key}: ${JSON.stringify(raw)}`);
    } else {
      console.log(`${key}: ${raw ?? ""}`);
    }
  }
}

function summarizeEvents(events: TouchpointEvent[]) {
  return events
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((event) => ({
      id: event.touchpoint_event_id ?? "",
      type: event.type,
      title: event.title,
      display_title: event.display_title,
      active: event.is_active,
      link: event.link,
      sort_order: event.sort_order,
      promotion_id: event.subscribe_link_promotion_id,
      welcome_message: event.subscribe_link_response_message,
    }));
}

function summarizeLocation(location: LocationSettings) {
  const accountBranding = location.accountBranding
    ? normalizeBranding(location.accountBranding)
    : null;
  const overrideBranding = location.overrideBranding
    ? normalizeBranding(location.overrideBranding)
    : null;
  return {
    source: location.__source,
    warning: location.__warning,
    web_error: location.__web_error,
    id: location.id,
    account_id: location.account_id,
    account_name: location.account_name,
    name: location.name,
    website_url: location.website_url,
    ordering_url: location.ordering_url,
    account_branding: accountBranding,
    override_branding: overrideBranding,
    effective_branding: resolveBranding(accountBranding, overrideBranding),
  };
}

function summarizeBrandingState(state: BrandingState) {
  return {
    selected_scope: state.selected_scope,
    scope_reason: state.scope_reason,
    account: {
      id: state.context.account_id,
      name: state.context.account_name,
      write_location_count: state.context.write_location_count,
      write_locations: state.context.write_locations,
    },
    location: {
      id: state.context.location_id,
      name: state.context.location_name,
      status: state.context.location_status,
    },
    account_branding: state.account,
    override_branding: state.override,
    effective_branding: state.effective,
  };
}

// ============================================================================
// instore-init: provision touchpoints for pre-initialization locations through
// the app's own server actions (no DB writes from here). Mirrors
// src/lib/services/touchpoint-initialization.ts as closely as the exposed
// actions allow. Known gaps (not reproducible via app actions): objectives +
// objective mappings, and the touchpoints_initialized_at stamp.
// ============================================================================

// Mirrors DEFAULT_SIGNAGE in touchpoint-initialization.ts (order = issue_id).
const INIT_DEFAULT_SIGNAGE: { name: string; review_focused: boolean }[] = [
  { name: "Point of Purchase", review_focused: false },
  { name: "Tables - Subscribe", review_focused: false },
  { name: "Tables - Reviews", review_focused: true },
  { name: "To-Go - Subscribe", review_focused: false },
  { name: "To-Go - Reviews", review_focused: true },
  { name: "Bathroom - Subscribe", review_focused: false },
  { name: "Bathroom - Reviews", review_focused: true },
];

// Mirrors DEFAULT_SUBSCRIBE_LINK_MESSAGE (placeholders render at send time).
const INIT_SUBSCRIBE_MESSAGE =
  "🎉 Welcome to the {location_name} text club! {promo_title} - Valid for {expires_in_days} days.\n\n{offer_link}\n\nReply STOP to END. Msg&data rates may apply";

type InitState = {
  id: string;
  name: string;
  account_id: string;
  initialized: boolean;
  has_sender: boolean;
  has_gpid: boolean;
  first_promotion_id: string | null;
  has_social_links: boolean;
  has_download_links: boolean;
  loc_event_count: number;
  signage_count: number;
  ctj_count: number;
};

async function v2DbRows<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync(
    V2_DB,
    ["query", "--sql", sql, "--json"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as T[];
}

async function getInitState(locationId: string): Promise<InitState> {
  const rows = await v2DbRows<InitState>(`
    select
      l.id, l.name, l.account_id,
      l.touchpoints_initialized_at is not null as initialized,
      l.sender_number_id is not null as has_sender,
      l.google_place_id is not null as has_gpid,
      (select p.id from promotions p where p.account_id = l.account_id and p.deleted_at is null order by p.created_at asc limit 1) as first_promotion_id,
      coalesce(ob.facebook_url, ab.facebook_url, ob.instagram_url, ab.instagram_url, ob.x_url, ab.x_url, ob.tiktok_url, ab.tiktok_url, ob.youtube_url, ab.youtube_url) is not null as has_social_links,
      coalesce(ob.apple_app_url, ab.apple_app_url, ob.google_app_url, ab.google_app_url) is not null as has_download_links,
      (select count(*)::int from touchpoint_events te where te.location_id = l.id and te.scope = 'location' and te.deleted_at is null) as loc_event_count,
      (select count(*)::int from touchpoints t where t.location_id = l.id and t.type = 'signage' and t.deleted_at is null) as signage_count,
      (select count(*)::int from subscribe_links sl where sl.location_id = l.id and sl.attribution_source = 'touchpoint' and sl.deleted_at is null) as ctj_count
    from locations l
    left join branding ab on ab.account_id = l.account_id and ab.location_id is null
    left join branding ob on ob.location_id = l.id
    where l.id = ${sqlLiteral(locationId)}
  `);
  const row = rows[0];
  if (!row) throw new CliError(`Location ${locationId} not found in V2 DB.`, 5);
  return row;
}

type EventDefaultRow = {
  id: string;
  type: TouchpointEvent["type"];
  title: string;
  display_title: string | null;
  description: string | null;
  primary_button_text: string | null;
  link: string | null;
  sort_order: number;
  is_active: boolean;
  config: JsonValue | null;
};

async function getEventDefaults(): Promise<EventDefaultRow[]> {
  return v2DbRows<EventDefaultRow>(`
    select id, type, title, display_title, description, primary_button_text,
           link, sort_order, is_active, config
    from touchpoint_event_defaults
    where type <> 'custom'
    order by sort_order asc
  `);
}

// Builds the location-scope default event payload with the same conditional
// activation initializeLocationTouchpoints would apply.
function buildInitEventPayload(
  defaults: EventDefaultRow[],
  state: InitState,
  promotionId: string | null,
): TouchpointEvent[] {
  const subscribeActive = !!(promotionId && state.has_sender);
  return defaults.map((d) => {
    const active =
      d.type === "subscribe"
        ? subscribeActive
        : d.type === "review"
          ? state.has_gpid
          : d.type === "socials"
            ? state.has_social_links
            : d.type === "downloads"
              ? state.has_download_links
              : d.is_active;
    const event: TouchpointEvent = {
      touchpoint_event_default_id: d.id,
      type: d.type,
      title: d.title,
      display_title: d.display_title,
      description: d.description,
      primary_button_text: d.primary_button_text,
      link: d.link,
      sort_order: d.sort_order,
      is_active: active,
      config: d.config ?? null,
      objective_id: null,
    };
    if (d.type === "subscribe" && subscribeActive && promotionId) {
      event.subscribe_link_promotion_id = promotionId;
      event.subscribe_link_response_message = INIT_SUBSCRIBE_MESSAGE;
    }
    return event;
  });
}

// Mirrors buildSignageEventOverrides({type:'review-focused'}).
function buildReviewFocusedOverrides(
  locationEvents: TouchpointEvent[],
): TouchpointEvent[] {
  return locationEvents.map((e) => {
    const isReview = e.type === "review";
    const isSubscribe = e.type === "subscribe";
    return {
      ...e,
      touchpoint_event_id: undefined,
      sort_order: isReview ? 0 : isSubscribe ? 1 : e.sort_order + 10,
      is_active: (isReview || isSubscribe) && e.is_active,
    };
  });
}

async function createSignageTouchpoint(
  options: Options,
  locationId: string,
  name: string,
): Promise<JsonValue> {
  return callServerAction<JsonValue>(
    options,
    "/in-store/signage/new",
    "createSignage",
    [{ name, location_id: locationId }],
  );
}

async function saveTouchpointEventOverrides(
  options: Options,
  touchpointId: string,
  events: TouchpointEvent[],
): Promise<JsonValue> {
  return callServerAction<JsonValue>(
    options,
    `/in-store/signage/${encodeURIComponent(touchpointId)}?tab=links`,
    "saveTouchpointEventOverrides",
    [touchpointId, { events }],
  );
}

type SignageRow = { id: string; name: string; short_id: string | null; issue_id: number };

async function getSignageRows(locationId: string): Promise<SignageRow[]> {
  return v2DbRows<SignageRow>(`
    select id, name, short_id, issue_id
    from touchpoints
    where location_id = ${sqlLiteral(locationId)} and type = 'signage' and deleted_at is null
    order by issue_id asc
  `);
}

// Mirrors DEFAULT_PROMOTIONS in src/lib/constants/default-promotions.ts —
// the fixed catalog onboarding completion creates unconditionally (with an
// absent invite_offer, completion creates exactly these six, in this order,
// all three redemption codes active). Order matters: the first created is the
// earliest by created_at and becomes the CTJ keyword's promotion.
const INIT_DEFAULT_PROMOTIONS: {
  title: string;
  description: string;
  estimated_value: number;
  code: string;
}[] = [
  { title: "20% OFF", description: "20% off your next order", estimated_value: 20, code: "SU20" },
  { title: "10% OFF $30+", description: "10% off orders of $30 or more", estimated_value: 26, code: "BIG10" },
  { title: "$5 OFF $30+", description: "$5 off orders of $30 or more", estimated_value: 25, code: "SAVE5" },
  { title: "Free Large Cheese Pizza", description: "Free Large Cheese Pizza", estimated_value: 15, code: "WINNER" },
  { title: "15% OFF $30+", description: "15% off orders of $30 or more", estimated_value: 25, code: "SAVE15" },
  { title: "Free Garlic Bread w/ $25+", description: "Free order of garlic bread with purchase of $25 or more", estimated_value: 25, code: "FREEGB" },
];

const INIT_PROMO_TERMS = "Not valid w/ other offers.";

async function createPromotionViaAction(
  options: Options,
  promo: (typeof INIT_DEFAULT_PROMOTIONS)[number],
): Promise<JsonValue> {
  return callServerAction<JsonValue>(
    options,
    "/promotions/new",
    "createPromotion",
    [
      {
        promotion: {
          title: promo.title,
          description: promo.description,
          terms_and_conditions: INIT_PROMO_TERMS,
          estimated_value: promo.estimated_value,
        },
        promoCodes: ["online", "in_store", "phone"].map((redemption_type) => ({
          code: promo.code,
          redemption_type,
          is_active: true,
        })),
      },
    ],
  );
}

async function instoreInitProvisionPromotions(
  options: Options,
  locationId: string,
) {
  const state = await getInitState(locationId);
  const existingPromos = await v2DbRows<{ id: string; title: string }>(`
    select id, title from promotions
    where account_id = ${sqlLiteral(state.account_id)} and deleted_at is null
    order by created_at asc
  `);
  const catalogTitles = new Set(INIT_DEFAULT_PROMOTIONS.map((p) => p.title));
  const foreign = existingPromos.filter((p) => !catalogTitles.has(p.title));
  if (foreign.length > 0) {
    throw new CliError(
      `Account ${state.account_id} has non-catalog promotions (${foreign.map((p) => p.title).join(", ")}); refusing to mix in the default catalog. Handle manually.`,
      5,
    );
  }
  if (existingPromos.length > 0 && existingPromos[0].title !== "20% OFF") {
    throw new CliError(
      `Account ${state.account_id}'s earliest promotion is "${existingPromos[0].title}", not "20% OFF" — the CTJ ordering invariant would break. Handle manually.`,
      5,
    );
  }
  const existingTitles = new Set(existingPromos.map((p) => p.title));
  const toCreate = INIT_DEFAULT_PROMOTIONS.filter(
    (p) => !existingTitles.has(p.title),
  );
  if (!optBool(options, "apply")) {
    printOutput(options, {
      dry_run: true,
      location: { id: state.id, name: state.name, account_id: state.account_id },
      already_present: [...existingTitles],
      will_create: toCreate as unknown as JsonValue,
      note: "Completion-mirror for a payload with no invite_offer: the 6 default catalog promos, all 3 redemption codes active each, created in order so '20% OFF' is earliest and becomes the CTJ promotion.",
    } as unknown as JsonValue);
    return;
  }
  if (toCreate.length === 0) {
    printOutput(options, { applied: false, note: "catalog already complete" });
    return;
  }
  await ensureLocationScope(options, locationId);
  const created: JsonValue[] = [];
  for (const promo of toCreate) {
    const result = await createPromotionViaAction(options, promo);
    created.push({ title: promo.title, result });
  }
  printOutput(options, { applied: true, created } as unknown as JsonValue);
}

// promotions create <locationId> --title --description --value --code [--terms]
// Creates ONE custom promotion on the location's account via the app's own
// createPromotion action (same payload shape the /promotions/new form sends:
// all three redemption types active with the same code). Added 2026-09-03 for
// Butt Hutt's "$10 OFF" signage offer, which had no matching promotion.
async function promotionsCreate(options: Options, locationId: string) {
  const state = await getInitState(locationId);
  const title = optString(options, "title");
  const description = optString(options, "description") ?? title;
  const code = optString(options, "code");
  const valueRaw = optString(options, "value");
  const terms = optString(options, "terms") ?? INIT_PROMO_TERMS;
  if (!title || !code || !valueRaw || !Number.isFinite(Number(valueRaw))) {
    throw new CliError("promotions create requires --title, --code, and a numeric --value (estimated value in dollars)", 2);
  }
  const existing = await v2DbRows<{ id: string; title: string }>(`
    select id, title from promotions
    where account_id = ${sqlLiteral(state.account_id)} and deleted_at is null
    order by created_at asc
  `);
  const dupe = existing.find((p) => p.title.trim().toLowerCase() === title.trim().toLowerCase());
  if (dupe) {
    throw new CliError(`Account ${state.account_id} already has a promotion titled "${dupe.title}" (${dupe.id}); refusing to create a duplicate.`, 5);
  }
  const promo = { title, description: description ?? title, estimated_value: Number(valueRaw), code };
  if (!optBool(options, "apply")) {
    printOutput(options, {
      dry_run: true,
      location: { id: state.id, name: state.name, account_id: state.account_id },
      existing_titles: existing.map((p) => p.title),
      will_create: { ...promo, terms_and_conditions: terms, redemption_types: ["online", "in_store", "phone"] },
    } as unknown as JsonValue);
    return;
  }
  await ensureLocationScope(options, locationId);
  const result = await createPromotionViaAction(options, promo);
  const after = await v2DbRows<{ id: string; title: string; created_at: string }>(`
    select id, title, created_at::text as created_at from promotions
    where account_id = ${sqlLiteral(state.account_id)} and deleted_at is null
    order by created_at desc limit 1
  `);
  printOutput(options, { applied: true, result, newest_promotion: after[0] ?? null } as unknown as JsonValue);
}

// offer set <locationId> --title --code --value [--description] [--terms]
// One command for the signage-offer fix (2026-09-03, Butt Hutt "$10 OFF" and
// Vito's "25% OFF"): reuse the account's non-deleted promotion with that title
// or create it via the app's createPromotion action, point the location's
// text-club subscribe event at it (same save path as `events set ...
// --promotion-id`), then read keywords.promotion_id for the SUBSCRIBE_ keyword
// back from the V2 DB and fail loudly if it did not land. Dry-run by default.
async function readSubscribeKeyword(locationId: string) {
  const rows = await v2DbRows<{ id: string; keyword: string; promotion_id: string | null; title: string | null }>(`
    select k.id, k.keyword, k.promotion_id, p.title
    from keywords k left join promotions p on p.id = k.promotion_id
    where k.location_id = ${sqlLiteral(locationId)} and k.deleted_at is null and k.keyword ilike 'SUBSCRIBE%'
    order by k.created_at asc limit 1
  `);
  return rows[0] ?? null;
}


async function offerSet(options: Options, locationId: string) {
  const state = await getInitState(locationId);
  const title = optString(options, "title");
  const code = optString(options, "code");
  const valueRaw = optString(options, "value");
  const description = optString(options, "description") ?? title;
  const terms = optString(options, "terms") ?? INIT_PROMO_TERMS;
  if (!title || !code || !valueRaw || !Number.isFinite(Number(valueRaw))) {
    throw new CliError("offer set requires --title, --code, and a numeric --value (estimated value in dollars)", 2);
  }
  const existing = await v2DbRows<{ id: string; title: string; description: string | null; created_at: string }>(`
    select id, title, description, created_at::text as created_at from promotions
    where account_id = ${sqlLiteral(state.account_id)} and deleted_at is null
    order by created_at asc
  `);
  const reuse = existing.find((p) => p.title.trim().toLowerCase() === title.trim().toLowerCase()) ?? null;

  const apply = optBool(options, "apply");
  await maybeEnsureLocationScope(options, locationId);
  const events = await getEvents(options, locationId);
  const keywordBefore = await readSubscribeKeyword(locationId);
  let event: TouchpointEvent | null = null;
  let scopeNote: string | null = null;
  if (events.length === 0 && !apply) {
    // Dry-run must not touch the shared session: when the cookie is scoped to
    // another account the events read comes back empty, so report from the DB
    // (the SUBSCRIBE_ keyword is what the text club event pays) and say so.
    scopeNote = "Session is not scoped to this location's account (events read returned empty); dry-run used the DB keyword as the current pointer. --apply needs --ensure-location-scope.";
  } else {
    assertNonEmptyEventsForWrite(events, locationId, options);
    const subscribeEvents = events.filter((e) => e.type === "subscribe");
    if (subscribeEvents.length !== 1) {
      throw new CliError(
        subscribeEvents.length === 0
          ? `Location ${locationId} has no subscribe (text club) event; run instore-init provision-events first.`
          : `Location ${locationId} has ${subscribeEvents.length} subscribe events (${subscribeEvents.map(eventLabel).join(", ")}); refusing to guess.`,
        5,
      );
    }
    event = subscribeEvents[0];
  }
  const currentPointer = event ? (event.subscribe_link_promotion_id ?? null) : (keywordBefore?.promotion_id ?? null);
  const before = {
    event: event ? eventLabel(event) : null,
    subscribe_link_promotion_id: currentPointer,
    keyword: keywordBefore ? { keyword: keywordBefore.keyword, promotion_id: keywordBefore.promotion_id, title: keywordBefore.title } : null,
  };
  const promo = { title, description: description ?? title, estimated_value: Number(valueRaw), code };
  const plan = {
    location: { id: state.id, name: state.name, account_id: state.account_id },
    existing_promotions: existing.map((p) => ({ id: p.id, title: p.title })),
    promotion: reuse
      ? { action: "reuse", id: reuse.id, title: reuse.title }
      : { action: "create", ...promo, terms_and_conditions: terms, redemption_types: ["online", "in_store", "phone"] },
    before,
    after: { subscribe_link_promotion_id: reuse ? reuse.id : "<new promotion id>" },
    no_change: !!(reuse && currentPointer === reuse.id && keywordBefore?.promotion_id === reuse.id),
  };
  if (!apply) {
    printOutput(options, {
      dry_run: true,
      ...plan,
      ...(scopeNote ? { scope_note: scopeNote } : {}),
      note: plan.no_change
        ? "Nothing to do: the subscribe event and the SUBSCRIBE_ keyword already pay this promotion."
        : "Run with --apply to create/reuse the promotion, repoint the text club subscribe event, and verify keywords.promotion_id.",
    } as unknown as JsonValue);
    return;
  }
  if (plan.no_change) {
    printOutput(options, { applied: false, ...plan, note: "already pointing at this promotion" } as unknown as JsonValue);
    return;
  }

  if (!event) throw new CliError("internal: subscribe event missing on apply", 5);
  await ensureLocationScope(options, locationId);
  let promotionId = reuse?.id ?? null;
  let created: JsonValue | null = null;
  if (!promotionId) {
    // A rotated createPromotion id surfaces as ActionRotatedError from the
    // self-heal path (table healed, nothing written, rerun instruction).
    created = await createPromotionViaAction(options, promo);
    for (let attempt = 0; attempt < 5 && !promotionId; attempt += 1) {
      const rows = await v2DbRows<{ id: string; title: string }>(`
        select id, title from promotions
        where account_id = ${sqlLiteral(state.account_id)} and deleted_at is null
          and lower(trim(title)) = lower(trim(${sqlLiteral(title)}))
        order by created_at desc limit 1
      `);
      promotionId = rows[0]?.id ?? null;
      if (!promotionId) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!promotionId) {
      throw new CliError(`createPromotion returned but no promotion titled "${title}" appeared on account ${state.account_id}; inspect /promotions before retrying (a retry could create a duplicate).`, 5);
    }
  }

  event.subscribe_link_promotion_id = promotionId;
  await assertTargetLocationWebPage(options, locationId);
  const saveResult = await saveEvents(options, locationId, events);

  let keywordAfter = await readSubscribeKeyword(locationId);
  for (let attempt = 0; attempt < 5 && keywordAfter?.promotion_id !== promotionId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    keywordAfter = await readSubscribeKeyword(locationId);
  }
  const eventsAfter = await getEvents(options, locationId);
  const eventAfter = eventsAfter.find((e) => e.type === "subscribe") ?? null;
  const result = {
    applied: true,
    promotion: { id: promotionId, title, action: reuse ? "reused" : "created", create_result: created },
    save_result: saveResult,
    before,
    after: {
      subscribe_link_promotion_id: eventAfter?.subscribe_link_promotion_id ?? null,
      keyword: keywordAfter ? { keyword: keywordAfter.keyword, promotion_id: keywordAfter.promotion_id, title: keywordAfter.title } : null,
    },
  };
  if (!keywordAfter || keywordAfter.promotion_id !== promotionId) {
    printOutput(options, result as unknown as JsonValue);
    throw new CliError(
      `VERIFY FAILED: SUBSCRIBE_ keyword for ${locationId} still pays ${keywordAfter?.promotion_id ?? "nothing"} ("${keywordAfter?.title ?? ""}"), expected ${promotionId} ("${title}"). The event save may not have propagated to keywords; check the location's text club event in the app before printing anything.`,
      5,
    );
  }
  if (eventAfter?.subscribe_link_promotion_id !== promotionId) {
    printOutput(options, result as unknown as JsonValue);
    throw new CliError(`VERIFY FAILED: subscribe event readback shows promotion ${eventAfter?.subscribe_link_promotion_id ?? "none"}, expected ${promotionId}.`, 5);
  }
  printOutput(options, result as unknown as JsonValue);
}

// subscribe-link set <locationId> --promotion-text <t> [--promotion-id <id>] [--subscribe-link-id <id>]
//
// Edits the location's touchpoint Click to Join (subscribe) link through the
// app's own updateSubscribeLink action (click-to-join/[subscribeLinkId]/actions.ts).
// That action writes keywords.promotion_id / response_message / expiry AND
// subscribe_links.promotion_text in one transaction, so it is a WHOLE-FORM
// REPLAY: the CLI reads the rendered edit page (`subscribeLink` flight prop),
// mirrors use-edit-subscribe-link-form's defaultValues, applies only the
// requested fields, and refuses when the readback shows drift on any untouched
// field. Why this exists (2026-09-16, Mara's Snackery): touchpoint init stamps
// promotion_text from the promotion description once and nothing updates it
// when the SUBSCRIBE_ keyword is later repointed via `events set`/`offer set`,
// so the join page kept advertising the old offer.
export type SubscribeLinkPage = {
  id: string;
  account_id: string;
  location_id: string;
  name: string;
  attribution_source: string;
  promotion_text: string;
  promotion_subtext: string | null;
  promotion_attachment_id: string | null;
  logo_attachment_id: string | null;
  keyword: {
    id: string;
    keyword: string;
    promotion_id: string | null;
    response_message: string;
    attachment_id: string | null;
    offer_expires_in_days: number | null;
    redemption_timer_minutes: number | null;
  };
};

export type SubscribeLinkFormData = {
  name: string;
  attribution_source: string;
  location_id: string;
  promotion_id: string;
  response_message: string;
  attachment_id: string | undefined;
  attachment_file: null;
  offer_expires_in_days: number;
  redemption_timer_minutes: number | null;
  promotion_text: string;
  promotion_subtext: string;
  logo_attachment_id: string | undefined;
  logo_attachment_file: null;
  promotion_attachment_id: string | undefined;
  promotion_attachment_file: null;
};

export function normalizeSubscribeLinkPage(raw: Record<string, unknown>): SubscribeLinkPage {
  const keyword = (raw.keyword ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const nstr = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: str(raw.id),
    account_id: str(raw.account_id),
    location_id: str(raw.location_id),
    name: str(raw.name),
    attribution_source: str(raw.attribution_source),
    promotion_text: str(raw.promotion_text),
    promotion_subtext: nstr(raw.promotion_subtext),
    promotion_attachment_id: nstr(raw.promotion_attachment_id),
    logo_attachment_id: nstr(raw.logo_attachment_id),
    keyword: {
      id: str(keyword.id),
      keyword: str(keyword.keyword),
      promotion_id: nstr(keyword.promotion_id),
      response_message: str(keyword.response_message),
      attachment_id: nstr(keyword.attachment_id),
      offer_expires_in_days: num(keyword.offer_expires_in_days),
      redemption_timer_minutes: num(keyword.redemption_timer_minutes),
    },
  };
}

// Mirrors defaultValues in click-to-join/[subscribeLinkId]/_hooks/use-edit-subscribe-link-form.ts.
// *_file fields are sent as null: the action only acts on `instanceof File`,
// and the form's cdn_url string placeholder is ignored server-side.
export function buildSubscribeLinkFormData(
  link: SubscribeLinkPage,
  changes: { promotion_text?: string; promotion_id?: string },
): SubscribeLinkFormData {
  const promotionText = changes.promotion_text ?? link.promotion_text;
  const promotionId = changes.promotion_id ?? link.keyword.promotion_id ?? "";
  if (!promotionText.trim()) throw new CliError("promotion_text must not be empty", 2);
  if (!promotionId) throw new CliError("promotion_id must not be empty (the link's keyword has no promotion; pass --promotion-id)", 2);
  if (!link.keyword.response_message.includes("Reply STOP")) {
    throw new CliError("keyword response_message lacks the required opt-out language; refusing to replay it", 5);
  }
  return {
    name: link.name,
    attribution_source: link.attribution_source,
    location_id: link.location_id,
    promotion_id: promotionId,
    response_message: link.keyword.response_message,
    attachment_id: link.keyword.attachment_id ?? undefined,
    attachment_file: null,
    offer_expires_in_days: link.keyword.offer_expires_in_days ?? 0,
    redemption_timer_minutes: link.keyword.redemption_timer_minutes ?? null,
    promotion_text: promotionText,
    promotion_subtext: link.promotion_subtext ?? "",
    logo_attachment_id: link.logo_attachment_id ?? undefined,
    logo_attachment_file: null,
    promotion_attachment_id: link.promotion_attachment_id ?? undefined,
    promotion_attachment_file: null,
  };
}

// Fields the command never changes; any difference between the pre-write read
// and the post-write readback is reported as drift and fails the command.
const SUBSCRIBE_LINK_UNTOUCHED = [
  "name", "attribution_source", "location_id", "promotion_subtext",
  "promotion_attachment_id", "logo_attachment_id",
  "keyword.id", "keyword.keyword", "keyword.response_message", "keyword.attachment_id",
  "keyword.offer_expires_in_days", "keyword.redemption_timer_minutes",
] as const;

export function subscribeLinkDrift(before: SubscribeLinkPage, after: SubscribeLinkPage): string[] {
  const get = (o: SubscribeLinkPage, path: string) =>
    path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown> | null)?.[key], o);
  return SUBSCRIBE_LINK_UNTOUCHED.filter((path) => get(before, path) !== get(after, path));
}

async function getSubscribeLinkPage(options: Options, subscribeLinkId: string): Promise<SubscribeLinkPage> {
  const path = `/click-to-join/${encodeURIComponent(subscribeLinkId)}`;
  const response = await boostlyFetch(options, path, {
    headers: { Accept: "text/html,application/xhtml+xml", "Cache-Control": "no-cache" },
  });
  const html = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new CliError(`Auth redirected to ${response.headers.get("location") || "unknown location"}`, 4);
  }
  if (response.status === 404) {
    throw new CliError(`Subscribe link ${subscribeLinkId} not found (HTTP 404). The session must be scoped to the link's account (--ensure-location-scope).`, 5);
  }
  if (!response.ok) throw new CliError(`Subscribe link page failed: HTTP ${response.status}`, 5);
  let raw: Record<string, unknown>;
  try {
    raw = extractFlightPageProp<Record<string, unknown>>(html, "subscribeLink", `"subscribeLink":{"id":"${subscribeLinkId}"`);
  } catch {
    raw = extractFlightPageProp<Record<string, unknown>>(html, "subscribeLink");
  }
  const page = normalizeSubscribeLinkPage(raw);
  if (page.id !== subscribeLinkId) throw new CliError(`Rendered page is for subscribe link ${page.id}, expected ${subscribeLinkId}.`, 5);
  return page;
}

type SubscribeLinkDbRow = {
  id: string; location_id: string; account_id: string; attribution_source: string;
  promotion_text: string; keyword_id: string; keyword_promotion_id: string | null; promotion_title: string | null;
};

async function readSubscribeLinkRows(locationId: string): Promise<SubscribeLinkDbRow[]> {
  return v2DbRows<SubscribeLinkDbRow>(`
    select sl.id, sl.location_id, sl.account_id, sl.attribution_source, sl.promotion_text, sl.keyword_id,
      k.promotion_id as keyword_promotion_id, p.title as promotion_title
    from subscribe_links sl
    left join keywords k on k.id = sl.keyword_id
    left join promotions p on p.id = k.promotion_id
    where sl.location_id = ${sqlLiteral(locationId)} and sl.deleted_at is null
    order by (sl.attribution_source = 'touchpoint') desc, sl.created_at asc
  `);
}

async function subscribeLinkSet(options: Options, locationId: string) {
  const promotionText = optString(options, "promotion-text");
  const promotionIdOpt = optString(options, "promotion-id");
  if (!promotionText && !promotionIdOpt) {
    throw new CliError("subscribe-link set requires --promotion-text and/or --promotion-id", 2);
  }
  const state = await getInitState(locationId);
  const rows = await readSubscribeLinkRows(locationId);
  const requestedLinkId = optString(options, "subscribe-link-id");
  let row: SubscribeLinkDbRow | undefined;
  if (requestedLinkId) {
    row = rows.find((r) => r.id === requestedLinkId);
    if (!row) throw new CliError(`Subscribe link ${requestedLinkId} is not a live link on location ${locationId}.`, 5);
  } else {
    const touchpoint = rows.filter((r) => r.attribution_source === "touchpoint");
    if (touchpoint.length !== 1) {
      throw new CliError(
        touchpoint.length === 0
          ? `Location ${locationId} has no live touchpoint subscribe link (${rows.length} other link(s)); pass --subscribe-link-id.`
          : `Location ${locationId} has ${touchpoint.length} touchpoint subscribe links (${touchpoint.map((r) => r.id).join(", ")}); pass --subscribe-link-id.`,
        5,
      );
    }
    row = touchpoint[0];
  }
  if (row.account_id !== state.account_id) {
    throw new CliError(`Subscribe link ${row.id} belongs to account ${row.account_id}, location ${locationId} to ${state.account_id}.`, 5);
  }
  let promotion: { id: string; title: string; description: string | null } | null = null;
  if (promotionIdOpt) {
    const promos = await v2DbRows<{ id: string; title: string; description: string | null }>(`
      select id, title, description from promotions
      where id = ${sqlLiteral(promotionIdOpt)} and account_id = ${sqlLiteral(state.account_id)} and deleted_at is null
    `);
    promotion = promos[0] ?? null;
    if (!promotion) throw new CliError(`Promotion ${promotionIdOpt} is not a live promotion on account ${state.account_id}.`, 5);
  }

  const apply = optBool(options, "apply");
  await maybeEnsureLocationScope(options, locationId);
  const before = await getSubscribeLinkPage(options, row.id);
  if (before.location_id !== locationId) {
    throw new CliError(`Subscribe link ${row.id} renders location ${before.location_id}, expected ${locationId}.`, 5);
  }
  const changes = {
    ...(promotionText ? { promotion_text: promotionText } : {}),
    ...(promotion ? { promotion_id: promotion.id } : {}),
  };
  const form = buildSubscribeLinkFormData(before, changes);
  const summary = (page: SubscribeLinkPage, db: SubscribeLinkDbRow | null) => ({
    subscribe_link_id: page.id,
    promotion_text: page.promotion_text,
    keyword: { id: page.keyword.id, keyword: page.keyword.keyword, promotion_id: page.keyword.promotion_id, title: db?.promotion_title ?? null },
    db_promotion_text: db?.promotion_text ?? null,
    db_keyword_promotion_id: db?.keyword_promotion_id ?? null,
  });
  const noChange = form.promotion_text === before.promotion_text && form.promotion_id === (before.keyword.promotion_id ?? "");
  const plan = {
    location: { id: state.id, name: state.name, account_id: state.account_id },
    before: summary(before, row),
    after: { subscribe_link_id: before.id, promotion_text: form.promotion_text, keyword_promotion_id: form.promotion_id, promotion_title: promotion?.title ?? row.promotion_title },
    replayed_untouched_fields: Object.fromEntries(SUBSCRIBE_LINK_UNTOUCHED.map((path) => [path, path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown> | null)?.[key], before)])),
    no_change: noChange,
  };
  if (!apply) {
    printOutput(options, {
      dry_run: true,
      ...plan,
      note: noChange
        ? "Nothing to do: the subscribe link already has this promotion text and promotion."
        : "Run with --apply to replay updateSubscribeLink with these values, then read back the page and the V2 replica.",
    } as unknown as JsonValue);
    return;
  }
  if (noChange) {
    printOutput(options, { applied: false, ...plan, note: "already at the requested values" } as unknown as JsonValue);
    return;
  }

  await ensureLocationScope(options, locationId);
  // Fresh read right before the write so the replay carries current values.
  const fresh = await getSubscribeLinkPage(options, row.id);
  const drift = subscribeLinkDrift(before, fresh);
  if (drift.length) throw new CliError(`Subscribe link changed between dry-run read and apply (${drift.join(", ")}); rerun.`, 5);
  const freshForm = buildSubscribeLinkFormData(fresh, changes);
  const result = await callServerAction<{ success?: boolean; error?: string; subscribeLinkId?: string }>(
    options,
    `/click-to-join/${encodeURIComponent(row.id)}`,
    "updateSubscribeLink",
    [row.id, freshForm],
  );
  if (!result || result.success !== true) {
    throw new CliError(`updateSubscribeLink failed: ${result?.error ?? JSON.stringify(result)}`, 5);
  }

  let after = await getSubscribeLinkPage(options, row.id);
  let dbAfter = (await readSubscribeLinkRows(locationId)).find((r) => r.id === row.id) ?? null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ok = after.promotion_text === freshForm.promotion_text
      && after.keyword.promotion_id === freshForm.promotion_id
      && dbAfter?.promotion_text === freshForm.promotion_text
      && dbAfter?.keyword_promotion_id === freshForm.promotion_id;
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    after = await getSubscribeLinkPage(options, row.id);
    dbAfter = (await readSubscribeLinkRows(locationId)).find((r) => r.id === row.id) ?? null;
  }
  const untouchedDrift = subscribeLinkDrift(fresh, after);
  const output = {
    applied: true,
    action_result: result,
    location: plan.location,
    before: plan.before,
    after: summary(after, dbAfter),
    untouched_field_drift: untouchedDrift,
  };
  printOutput(options, output as unknown as JsonValue);
  if (after.promotion_text !== freshForm.promotion_text || dbAfter?.promotion_text !== freshForm.promotion_text) {
    throw new CliError(`VERIFY FAILED: promotion_text readback is page="${after.promotion_text}" db="${dbAfter?.promotion_text ?? ""}", expected "${freshForm.promotion_text}".`, 5);
  }
  if (after.keyword.promotion_id !== freshForm.promotion_id || dbAfter?.keyword_promotion_id !== freshForm.promotion_id) {
    throw new CliError(`VERIFY FAILED: keyword promotion readback is page=${after.keyword.promotion_id ?? "none"} db=${dbAfter?.keyword_promotion_id ?? "none"}, expected ${freshForm.promotion_id}.`, 5);
  }
  if (untouchedDrift.length) {
    throw new CliError(`VERIFY FAILED: untouched fields changed during the write: ${untouchedDrift.join(", ")}. Inspect the link in the app.`, 5);
  }
}

// Mirrors DEFAULT_OBJECTIVES in touchpoint-initialization.ts. The exposed
// createObjective action cannot set is_default or is_priority (residual gap —
// recorded, not worked around): rows land as is_default:false, is_priority:false.
const INIT_DEFAULT_OBJECTIVES: {
  name: string;
  eventType: TouchpointEvent["type"];
}[] = [
  { name: "New Subscriber", eventType: "subscribe" },
  { name: "Google Review", eventType: "review" },
];

async function instoreInitProvisionObjectives(
  options: Options,
  locationId: string,
) {
  const state = await getInitState(locationId);
  const existing = await v2DbRows<{ id: string; name: string }>(`
    select id, name from touchpoint_objectives
    where location_id = ${sqlLiteral(locationId)} and deleted_at is null
      and name in ('New Subscriber', 'Google Review')
  `);
  const existingByName = new Map(existing.map((o) => [o.name, o.id]));
  const toCreate = INIT_DEFAULT_OBJECTIVES.filter(
    (d) => !existingByName.has(d.name),
  );
  if (!optBool(options, "apply")) {
    printOutput(options, {
      dry_run: true,
      location: { id: state.id, name: state.name },
      already_present: [...existingByName.keys()],
      will_create: toCreate.map((d) => ({
        name: d.name,
        reward_value: 0,
        is_reward_enabled: false,
        activate: true,
        wire_to_event_type: d.eventType,
      })),
      residual_gap:
        "createObjective cannot set is_default/is_priority (real init uses is_default:true, is_priority:true).",
    } as unknown as JsonValue);
    return;
  }
  await ensureLocationScope(options, locationId);
  const created: JsonValue[] = [];
  for (const def of toCreate) {
    const result = await callServerAction<{
      success: boolean;
      created?: { id: string; name: string };
    }>(options, "/in-store/objectives/new", "createObjective", [
      locationId,
      { name: def.name, reward_value: 0, is_reward_enabled: false },
      { activate: true },
    ]);
    if (!result?.success || !result.created?.id) {
      throw new CliError(
        `createObjective failed for "${def.name}": ${JSON.stringify(result).slice(0, 300)}`,
        5,
      );
    }
    existingByName.set(def.name, result.created.id);
    created.push({ name: def.name, id: result.created.id });
  }

  // Wire objective_id onto the matching location events (mirrors the
  // updateMany in provisionObjectives). Only fills events with no objective.
  const events = await getEvents(options, locationId);
  assertNonEmptyEventsForWrite(events, locationId, options);
  let changed = false;
  const wired: JsonValue[] = [];
  for (const def of INIT_DEFAULT_OBJECTIVES) {
    const objectiveId = existingByName.get(def.name);
    const event = events.find((e) => e.type === def.eventType);
    if (!objectiveId || !event) continue;
    if (event.objective_id) {
      wired.push({ event: def.eventType, skipped: "already has an objective" });
      continue;
    }
    event.objective_id = objectiveId;
    changed = true;
    wired.push({ event: def.eventType, objective_id: objectiveId });
  }
  const saveResult = changed
    ? await saveEvents(options, locationId, events)
    : null;
  printOutput(options, {
    applied: true,
    created,
    wired,
    events_saved: changed,
    save_result: saveResult,
  } as unknown as JsonValue);
}

// Soft-deletes a NON-DEFAULT objective through the app's deleteObjective
// action (the action itself also rejects is_default rows). The action nulls
// objective_id on any events wired to it and deletes its platform mappings —
// re-wire events afterwards if a replacement objective should take over.
async function instoreInitDeleteObjective(
  options: Options,
  locationId: string,
  objectiveId: string,
) {
  const rows = await v2DbRows<{
    id: string;
    name: string;
    is_default: boolean;
    deleted_at: string | null;
  }>(`
    select id, name, is_default, deleted_at from touchpoint_objectives
    where id = ${sqlLiteral(objectiveId)} and location_id = ${sqlLiteral(locationId)}
  `);
  const row = rows[0];
  if (!row) throw new CliError(`Objective ${objectiveId} not found at location ${locationId}.`, 5);
  if (row.deleted_at) throw new CliError(`Objective ${objectiveId} ("${row.name}") is already deleted.`, 5);
  if (row.is_default) throw new CliError(`Objective ${objectiveId} ("${row.name}") is a default objective; refusing.`, 5);
  if (!optBool(options, "apply")) {
    printOutput(options, { dry_run: true, will_delete: row as unknown as JsonValue });
    return;
  }
  await ensureLocationScope(options, locationId);
  const result = await callServerAction<JsonValue>(
    options,
    `/in-store/objectives/${encodeURIComponent(objectiveId)}`,
    "deleteObjective",
    [objectiveId],
  );
  printOutput(options, { applied: true, deleted: row as unknown as JsonValue, result });
}

async function instoreInitStatus(options: Options, locationId: string) {
  const state = await getInitState(locationId);
  const signage = await getSignageRows(locationId);
  printOutput(options, { ...state, signage } as unknown as JsonValue);
}

async function instoreInitProvisionEvents(options: Options, locationId: string) {
  const state = await getInitState(locationId);
  if (state.initialized) {
    throw new CliError(
      `Location ${locationId} already has touchpoints_initialized_at set; use the normal events commands instead.`,
      5,
    );
  }
  if (state.loc_event_count > 0) {
    throw new CliError(
      `Location ${locationId} already has ${state.loc_event_count} location-scoped events; refusing to re-provision. Use events list/set.`,
      5,
    );
  }
  const promotionId =
    optString(options, "promotion-id") ?? state.first_promotion_id;
  const defaults = await getEventDefaults();
  if (defaults.length === 0) throw new CliError("No touchpoint_event_defaults found.", 5);
  const events = buildInitEventPayload(defaults, state, promotionId);
  const plan = {
    location: { id: state.id, name: state.name, account_id: state.account_id },
    subscribe_active: events.some((e) => e.type === "subscribe" && e.is_active),
    ctj_will_be_created: events.some((e) => e.type === "subscribe" && e.is_active),
    ctj_skip_reason: promotionId
      ? state.has_sender
        ? null
        : "no sender number"
      : "account has no promotions",
    events,
  };
  if (!optBool(options, "apply")) {
    printOutput(options, { dry_run: true, ...plan } as unknown as JsonValue);
    return;
  }
  await ensureLocationScope(options, locationId);
  await assertTargetLocationWebPage(options, locationId);
  const result = await saveEvents(options, locationId, events);
  printOutput(options, { applied: true, result } as unknown as JsonValue);
}

async function touchpointOverrideCounts(
  locationId: string,
): Promise<Map<string, number>> {
  const rows = await v2DbRows<{ touchpoint_id: string; n: number }>(`
    select touchpoint_id, count(*)::int as n
    from touchpoint_events
    where location_id = ${sqlLiteral(locationId)}
      and scope = 'touchpoint' and deleted_at is null
    group by touchpoint_id
  `);
  return new Map(rows.map((r) => [r.touchpoint_id, r.n]));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The V2 read replica can lag writes by several seconds; poll until the
// expected signage names are visible before wiring overrides.
async function awaitSignageRows(
  locationId: string,
  expectedNames: string[],
  timeoutMs = 60_000,
): Promise<SignageRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await getSignageRows(locationId);
    const names = new Set(rows.map((r) => r.name));
    if (expectedNames.every((n) => names.has(n))) return rows;
    if (Date.now() > deadline) {
      throw new CliError(
        `Timed out waiting for replica to show signage rows [${expectedNames.filter((n) => !names.has(n)).join(", ")}] for ${locationId}. Re-run provision-signage; it is idempotent per piece.`,
        5,
      );
    }
    await sleep(3000);
  }
}

async function instoreInitProvisionSignage(options: Options, locationId: string) {
  const state = await getInitState(locationId);
  if (state.loc_event_count === 0) {
    throw new CliError(
      `Location ${locationId} has no location-scoped events yet. Run instore-init provision-events first so review-focused signage can copy overrides.`,
      5,
    );
  }
  const existingRows = await getSignageRows(locationId);
  const existingNames = new Set(existingRows.map((r) => r.name));
  const nonDefaultExisting = existingRows.filter(
    (r) => !INIT_DEFAULT_SIGNAGE.some((s) => s.name === r.name),
  );
  if (nonDefaultExisting.length > 0) {
    throw new CliError(
      `Location ${locationId} has non-default signage (${nonDefaultExisting.map((r) => r.name).join(", ")}); refusing to mix in defaults. Handle manually.`,
      5,
    );
  }
  const toCreate = INIT_DEFAULT_SIGNAGE.filter((s) => !existingNames.has(s.name));

  if (!optBool(options, "apply")) {
    printOutput(options, {
      dry_run: true,
      location: { id: state.id, name: state.name },
      already_present: [...existingNames],
      will_create: toCreate as unknown as JsonValue,
      review_focused_overrides:
        "for each review-focused sign lacking touchpoint-scoped events: copy location events with review sort 0 / subscribe sort 1 / others +10, non-review+subscribe deactivated",
    } as unknown as JsonValue);
    return;
  }
  await ensureLocationScope(options, locationId);
  const locationEvents = await getEvents(options, locationId);
  assertNonEmptyEventsForWrite(locationEvents, locationId, options);
  const overrides = buildReviewFocusedOverrides(locationEvents);

  const created: JsonValue[] = [];
  for (const item of toCreate) {
    const result = await createSignageTouchpoint(options, locationId, item.name);
    created.push({ name: item.name, result });
  }
  const rows = await awaitSignageRows(
    locationId,
    INIT_DEFAULT_SIGNAGE.map((s) => s.name),
  );
  const overrideCounts = await touchpointOverrideCounts(locationId);
  const overrideResults: JsonValue[] = [];
  for (const item of INIT_DEFAULT_SIGNAGE.filter((s) => s.review_focused)) {
    const row = rows.find((r) => r.name === item.name);
    if (!row) {
      overrideResults.push({ name: item.name, error: "created row not found on readback" });
      continue;
    }
    if ((overrideCounts.get(row.id) ?? 0) > 0) {
      overrideResults.push({ name: item.name, touchpoint_id: row.id, skipped: "overrides already present" });
      continue;
    }
    const result = await saveTouchpointEventOverrides(options, row.id, overrides);
    overrideResults.push({ name: item.name, touchpoint_id: row.id, result });
  }
  printOutput(options, {
    applied: true,
    created,
    signage: rows as unknown as JsonValue,
    overrides: overrideResults,
  } as unknown as JsonValue);
}

// ---------------------------------------------------------------------------
// Admin fulfillment requests: /admin/fulfillment/<requestId>
//
// The request page renders the full `request` prop (offer, stamps, items,
// ship-to, state) in its flight payload, so reads and post-apply readbacks come
// from the same authenticated page. Writes replay the page's own server
// actions (src/app/(main)/(admin)/admin/fulfillment/[requestId]/actions.ts):
//   setStoreDetailsConfirmedAction(requestId, confirmed: boolean)
//   setDigitalFulfillmentCompletedAction(requestId, completed: boolean)
//   updateFulfillmentOfferAction(requestId, { promotion_id: null, text })
//   updateNotesAction(requestId, notes)   (internal notes textarea; trimmed, <= 2000 chars, "" -> null)
// Every one of them runs runMutation(), which after the transaction calls
// notifyFulfillmentReadyForPhysical(requestId): when the request's state is
// physical_fulfillment and physical_fulfillment_notified_at is null, it posts
// the "ready for physical fulfillment" ping to the #fulfillment Slack channel
// (threaded under the request's slack_thread_ts when one exists). So the write
// that completes branding or store details, or even a no-op save on a request
// that is already ready but un-pinged, fires Slack. The dry run predicts this.
// ---------------------------------------------------------------------------

type FulfillmentItemType = "tapcards" | "signage" | "stickers";
export type FulfillmentState =
  | "canceled"
  | "delivered"
  | "digital_fulfillment"
  | "store_details"
  | "physical_fulfillment"
  | "printing_label"
  | "shipping"
  | "shipping_issue";

export type FulfillmentRequestPage = {
  id: string;
  order_type: string;
  digital_fulfilled_at: string | null;
  store_details_confirmed_at: string | null;
  offer_promotion_id: string | null;
  offer_text: string;
  notes: string | null;
  canceled_at: string | null;
  tracking_number: string | null;
  tracking_status: string | null;
  shipping_recipient_name: string | null;
  shipping_address_line1: string | null;
  shipping_address_line2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_zip: string | null;
  location: { id: string; name: string; address: string | null };
  account: { id: string; name: string };
  items: Array<{
    id: string;
    item_type: FulfillmentItemType;
    placement: string | null;
    focus: string | null;
    quantity: number;
    printed_at: string | null;
  }>;
  offerOptions: Array<{ value: string; label: string }>;
  state: FulfillmentState;
};

export type FulfillmentDbMeta = {
  id: string;
  location_id: string;
  location_name: string;
  physical_fulfillment_notified_at: string | null;
  has_slack_thread: boolean;
  offer_text: string | null;
  store_details_confirmed_at: string | null;
  digital_fulfilled_at: string | null;
};

type AdminActionResult = { success: true } | { success: false; error: string };

// Flight encodes Date as "$D<iso>" and escapes a literal leading "$" as "$$"
// (e.g. offer text "$10 OFF" renders as "$$10 OFF").
function flightDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.startsWith("$D") ? value.slice(2) : value;
}

export function flightString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.startsWith("$$") ? value.slice(1) : value;
}

export function normalizeFulfillmentPage(raw: Record<string, unknown>): FulfillmentRequestPage {
  const dateKeys = ["digital_fulfilled_at", "store_details_confirmed_at", "canceled_at"] as const;
  const out = { ...raw } as unknown as FulfillmentRequestPage;
  for (const key of dateKeys) (out as Record<string, unknown>)[key] = flightDate(raw[key]);
  out.items = (Array.isArray(raw.items) ? raw.items : []).map((item: Record<string, unknown>) => ({
    ...(item as FulfillmentRequestPage["items"][number]),
    printed_at: flightDate(item.printed_at),
  }));
  out.offer_text = flightString(raw.offer_text);
  out.notes = typeof raw.notes === "string" ? flightString(raw.notes) : null;
  out.offerOptions = (Array.isArray(raw.offerOptions) ? (raw.offerOptions as FulfillmentRequestPage["offerOptions"]) : []).map(
    (option) => ({ value: option.value, label: flightString(option.label) }),
  );
  return out;
}

// Ports of src/lib/fulfillment/{store-details,status}.ts and
// src/lib/schemas/fulfillment.ts shippingAddressInputSchema, so the dry run
// can predict the post-write state (and therefore the Slack ping).
const OFFER_BEARING_ITEM_TYPES: readonly FulfillmentItemType[] = ["signage", "stickers"];

export function fulfillmentNeedsOffer(items: Array<{ item_type: FulfillmentItemType }>): boolean {
  return items.some((item) => OFFER_BEARING_ITEM_TYPES.includes(item.item_type));
}

export function hasCompleteShippingAddress(r: {
  shipping_recipient_name: string | null;
  shipping_address_line1: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_zip: string | null;
}): boolean {
  const nonEmpty = (v: string | null) => typeof v === "string" && v.trim().length > 0;
  return (
    nonEmpty(r.shipping_recipient_name) &&
    nonEmpty(r.shipping_address_line1) &&
    nonEmpty(r.shipping_city) &&
    /^[A-Z]{2}$/.test((r.shipping_state ?? "").trim().toUpperCase()) &&
    /^\d{5}(-\d{4})?$/.test((r.shipping_zip ?? "").trim())
  );
}

export function hasStoreDetailsData(r: FulfillmentRequestPage): boolean {
  return (
    hasCompleteShippingAddress(r) &&
    (!fulfillmentNeedsOffer(r.items) || Boolean(r.offer_text?.trim()))
  );
}

export function isStoreDetailsComplete(r: FulfillmentRequestPage): boolean {
  return r.store_details_confirmed_at != null && hasStoreDetailsData(r);
}

export function fulfillmentState(r: FulfillmentRequestPage): FulfillmentState {
  if (r.canceled_at) return "canceled";
  if (r.tracking_status === "delivered") return "delivered";
  if (
    r.tracking_status === "return_to_sender" ||
    r.tracking_status === "failure" ||
    r.tracking_status === "cancelled" ||
    r.tracking_status === "error"
  ) {
    return "shipping_issue";
  }
  if (r.tracking_number && !r.tracking_status) return "delivered";
  if (r.tracking_number) return "shipping";
  if (!r.digital_fulfilled_at) return "digital_fulfillment";
  if (!isStoreDetailsComplete(r)) return "store_details";
  if (r.items.length === 0 || r.items.some((item) => !item.printed_at)) return "physical_fulfillment";
  return "printing_label";
}

export type FulfillmentWriteKind = "store-details" | "branding" | "offer" | "ship-to" | "note";

// Port of src/lib/schemas/fulfillment.ts fulfillmentNotesSchema (z.string().trim().max(2000))
// and updateNotesAction's `parsed.data || null`.
export const FULFILLMENT_NOTES_MAX = 2000;
export function composeFulfillmentNotes(current: string | null, input: { set?: string; append?: string }): string | null {
  if ((input.set === undefined) === (input.append === undefined)) throw new CliError("Pass exactly one of --set '<notes>' or --append '<line>'.", 2);
  const base = (current ?? "").trim();
  const next = input.set !== undefined ? input.set : base ? `${base}\n${input.append}` : (input.append as string);
  const normalized = next.trim();
  if (normalized.length > FULFILLMENT_NOTES_MAX) throw new CliError(`Notes must be ${FULFILLMENT_NOTES_MAX} characters or fewer (would be ${normalized.length}).`, 2);
  return normalized || null;
}

export type ShipToInput = {
  shipping_recipient_name: string;
  shipping_address_line1: string;
  shipping_address_line2: string | null;
  shipping_city: string;
  shipping_state: string;
  shipping_zip: string;
};

// Mirrors shippingAddressInputSchema (trim, min 1, 2-letter state upper-cased,
// 5 or 9 digit zip). Throws CliError(2) on invalid input.
export function parseShipToInput(input: {
  recipient?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
}): ShipToInput {
  const need = (v: string | undefined, flag: string) => {
    const t = (v ?? "").trim();
    if (!t) throw new CliError(`--${flag} is required for ship-to.`, 2);
    return t;
  };
  const state = need(input.state, "state").toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw new CliError("--state must be the 2-letter state code.", 2);
  const zip = need(input.zip, "zip");
  if (!/^\d{5}(-\d{4})?$/.test(zip)) throw new CliError("--zip must be a valid ZIP code (12345 or 12345-6789).", 2);
  const line2 = (input.line2 ?? "").trim();
  return {
    shipping_recipient_name: need(input.recipient, "recipient"),
    shipping_address_line1: need(input.line1, "line1"),
    shipping_address_line2: line2 || null,
    shipping_city: need(input.city, "city"),
    shipping_state: state,
    shipping_zip: zip,
  };
}

const SHIP_TO_FIELDS = [
  "shipping_recipient_name",
  "shipping_address_line1",
  "shipping_address_line2",
  "shipping_city",
  "shipping_state",
  "shipping_zip",
] as const;

export type FulfillmentWritePlan = {
  kind: FulfillmentWriteKind;
  action: ActionKey;
  args: unknown[];
  before: Record<string, JsonValue>;
  after: Record<string, JsonValue>;
  state_before: FulfillmentState;
  state_after: FulfillmentState;
  enters_physical_fulfillment: boolean;
  reopens_prints: number;
  noop: boolean;
  refusal: string | null;
  slack_ping: {
    expected: boolean | "unknown";
    reason: string;
    threaded: boolean | "unknown";
  };
};

export function planFulfillmentWrite(
  page: FulfillmentRequestPage,
  kind: FulfillmentWriteKind,
  input: { confirmed?: boolean; completed?: boolean; text?: string; shipTo?: ShipToInput; notes?: string | null },
  meta: FulfillmentDbMeta | null,
): FulfillmentWritePlan {
  const stateBefore = fulfillmentState(page);
  const pendingStamp = "<server timestamp at apply>";
  let next: FulfillmentRequestPage = { ...page, items: page.items.map((i) => ({ ...i })) };
  let action: ActionKey;
  let args: unknown[];
  let before: Record<string, JsonValue>;
  let after: Record<string, JsonValue>;
  let noop = false;
  let refusal: string | null = null;
  let reopensPrints = 0;

  if (kind === "store-details") {
    const confirmed = input.confirmed;
    if (typeof confirmed !== "boolean") throw new CliError("Pass --confirm or --unconfirm.", 2);
    action = "setStoreDetailsConfirmed";
    args = [page.id, confirmed];
    before = { store_details_confirmed_at: page.store_details_confirmed_at };
    noop = (page.store_details_confirmed_at != null) === confirmed;
    if (page.canceled_at) refusal = "Cannot modify a canceled fulfillment request";
    else if (confirmed && !noop && !hasStoreDetailsData(page)) {
      refusal =
        "Add a ship-to address (and an offer for signage) before marking Store Details complete";
    }
    next.store_details_confirmed_at = confirmed ? (noop ? page.store_details_confirmed_at : pendingStamp) : null;
    after = { store_details_confirmed_at: next.store_details_confirmed_at };
  } else if (kind === "branding") {
    const completed = input.completed;
    if (typeof completed !== "boolean") throw new CliError("Pass --complete or --incomplete.", 2);
    action = "setDigitalFulfillmentCompleted";
    args = [page.id, completed];
    before = { digital_fulfilled_at: page.digital_fulfilled_at };
    noop = (page.digital_fulfilled_at != null) === completed;
    if (page.canceled_at) refusal = "Cannot modify a canceled fulfillment request";
    next.digital_fulfilled_at = completed ? (noop ? page.digital_fulfilled_at : pendingStamp) : null;
    after = { digital_fulfilled_at: next.digital_fulfilled_at };
  } else if (kind === "ship-to") {
    // updateShippingAddressAction(requestId, address) writes the six
    // shipping_* columns on the request's LOCATION row (shared by every
    // request for that location), invalidates unpurchased shipping quotes,
    // and logs shipping_updated. It does not touch the confirmation stamps.
    const shipTo = input.shipTo;
    if (!shipTo) throw new CliError("Ship-to fields are required.", 2);
    action = "updateShippingAddress";
    args = [page.id, shipTo];
    before = Object.fromEntries(SHIP_TO_FIELDS.map((f) => [f, page[f]]));
    after = { ...shipTo };
    noop = SHIP_TO_FIELDS.every((f) => (page[f] ?? null) === shipTo[f]);
    if (page.canceled_at) refusal = "Cannot modify a canceled fulfillment request";
    else if (page.tracking_number) refusal = "Cannot modify a request after shipping has started";
    next = { ...next, ...shipTo };
  } else if (kind === "note") {
    // updateNotesAction(requestId, notes): replaces the internal notes text
    // (trimmed; "" stored as null). It touches nothing else, so the state is
    // unchanged; only the "already ready but un-pinged" Slack case applies.
    if (input.notes === undefined) throw new CliError("Notes are required.", 2);
    action = "updateFulfillmentNotes";
    args = [page.id, input.notes ?? ""];
    before = { notes: page.notes };
    after = { notes: input.notes };
    noop = (page.notes ?? null) === input.notes;
    if (page.canceled_at) refusal = "Cannot modify a canceled fulfillment request";
    next.notes = input.notes;
  } else {
    const text = (input.text ?? "").trim();
    if (text.length === 0) throw new CliError("Offer is required: pass --text '<offer>'.", 2);
    if (text.length > 200) throw new CliError("Offer text must be 200 characters or fewer.", 2);
    action = "updateFulfillmentOffer";
    args = [page.id, { promotion_id: null, text }];
    before = { offer_text: page.offer_text, offer_promotion_id: page.offer_promotion_id };
    noop = page.offer_promotion_id === null && page.offer_text === text;
    if (page.canceled_at) refusal = "Cannot modify a canceled fulfillment request";
    else if (page.tracking_number) refusal = "Cannot modify a request after shipping has started";
    if (!noop) {
      next.offer_text = text;
      next.offer_promotion_id = null;
      // Offer text is printed on signage/stickers: a change reopens those prints.
      for (const item of next.items) {
        if (OFFER_BEARING_ITEM_TYPES.includes(item.item_type) && item.printed_at) {
          item.printed_at = null;
          reopensPrints += 1;
        }
      }
    }
    after = { offer_text: next.offer_text, offer_promotion_id: next.offer_promotion_id };
  }

  if (refusal) next = page;
  const stateAfter = refusal ? stateBefore : fulfillmentState(next);
  const entersPhysical = stateBefore !== "physical_fulfillment" && stateAfter === "physical_fulfillment";

  // Mirror physicalReadyAction(): ping iff state is physical_fulfillment and
  // the stamp is null. runMutation() schedules the check after EVERY call,
  // including a no-op save, so an already-ready but un-pinged request pings.
  let slackPing: FulfillmentWritePlan["slack_ping"];
  if (refusal) {
    slackPing = { expected: false, reason: "the server will reject this write before the check runs", threaded: "unknown" };
  } else if (stateAfter !== "physical_fulfillment") {
    slackPing = { expected: false, reason: `state after write is ${stateAfter}; only physical_fulfillment pings`, threaded: "unknown" };
  } else if (!meta) {
    slackPing = {
      expected: "unknown",
      reason: "state after write is physical_fulfillment; physical_fulfillment_notified_at could not be read from V2 DB (assume it pings)",
      threaded: "unknown",
    };
  } else if (meta.physical_fulfillment_notified_at) {
    slackPing = {
      expected: false,
      reason: `already pinged at ${meta.physical_fulfillment_notified_at}; the stamp only resets when the request regresses below physical fulfillment`,
      threaded: meta.has_slack_thread,
    };
  } else {
    slackPing = {
      expected: true,
      reason: entersPhysical
        ? "this write moves the request into physical_fulfillment and it has not been pinged yet"
        : "the request is already in physical_fulfillment and un-pinged; any save (even a no-op) fires the ping",
      threaded: meta.has_slack_thread,
    };
  }

  return {
    kind,
    action,
    args,
    before,
    after,
    state_before: stateBefore,
    state_after: stateAfter,
    enters_physical_fulfillment: entersPhysical,
    reopens_prints: reopensPrints,
    noop,
    refusal,
    slack_ping: slackPing,
  };
}

// The page and the DB must agree on which request (and which location) this
// is before anything is written. Exit 6 on mismatch, like the logo guard.
export function assertFulfillmentPageMatches(
  page: FulfillmentRequestPage,
  requestId: string,
  meta: FulfillmentDbMeta | null,
): void {
  if (page.id !== requestId) {
    throw new CliError(
      `Refusing: the rendered request page is for ${page.id}, not ${requestId}.`,
      6,
    );
  }
  if (!meta) return;
  if (meta.id !== requestId || meta.location_id !== page.location.id || meta.location_name !== page.location.name) {
    throw new CliError(
      `Refusing: page/DB mismatch for ${requestId}. Page location ${page.location.id} "${page.location.name}" vs DB location ${meta.location_id} "${meta.location_name}".`,
      6,
    );
  }
}

export function summarizeFulfillmentRequest(page: FulfillmentRequestPage, meta: FulfillmentDbMeta | null) {
  return {
    id: page.id,
    state: page.state,
    state_local: fulfillmentState(page),
    location: { id: page.location.id, name: page.location.name },
    account: page.account,
    order_type: page.order_type,
    offer_text: page.offer_text,
    offer_promotion_id: page.offer_promotion_id,
    notes: page.notes,
    store_details_confirmed_at: page.store_details_confirmed_at,
    digital_fulfilled_at: page.digital_fulfilled_at,
    canceled_at: page.canceled_at,
    tracking_number: page.tracking_number,
    tracking_status: page.tracking_status,
    shipping_address_complete: hasCompleteShippingAddress(page),
    needs_offer: fulfillmentNeedsOffer(page.items),
    store_details_data_usable: hasStoreDetailsData(page),
    items: page.items.map((item) => ({
      type: item.item_type,
      placement: item.placement,
      focus: item.focus,
      quantity: item.quantity,
      printed_at: item.printed_at,
    })),
    offer_options: page.offerOptions,
    physical_fulfillment_notified_at: meta ? meta.physical_fulfillment_notified_at : "unknown (V2 DB unavailable)",
    has_slack_thread: meta ? meta.has_slack_thread : "unknown",
  };
}

async function getFulfillmentRequestPage(options: Options, requestId: string): Promise<FulfillmentRequestPage> {
  const path = `/admin/fulfillment/${encodeURIComponent(requestId)}`;
  const response = await boostlyFetch(options, path, {
    headers: { Accept: "text/html,application/xhtml+xml", "Cache-Control": "no-cache" },
  });
  const html = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new CliError(`Auth redirected to ${response.headers.get("location") || "unknown location"}`, 4);
  }
  if (response.status === 404) {
    throw new CliError(`Fulfillment request ${requestId} not found (HTTP 404). Check the id and that the session is an admin.`, 5);
  }
  if (!response.ok) throw new CliError(`Fulfillment request page failed: HTTP ${response.status}`, 5);
  let raw: Record<string, unknown>;
  try {
    raw = extractFlightPageProp<Record<string, unknown>>(html, "request", `"request":{"id":"${requestId}"`);
  } catch {
    raw = extractFlightPageProp<Record<string, unknown>>(html, "request");
  }
  return normalizeFulfillmentPage(raw);
}

async function fulfillmentDbMeta(requestId: string): Promise<FulfillmentDbMeta | null> {
  const rows = await v2DbRows<FulfillmentDbMeta>(`
    select fr.id, fr.location_id, l.name as location_name,
      fr.physical_fulfillment_notified_at, fr.slack_thread_ts is not null as has_slack_thread,
      fr.offer_text, fr.store_details_confirmed_at, fr.digital_fulfilled_at
    from fulfillment_requests fr join locations l on l.id = fr.location_id
    where fr.id = ${sqlLiteral(requestId)}
  `);
  return rows[0] ?? null;
}

export type FulfillmentDeps = {
  fetchPage: (requestId: string) => Promise<FulfillmentRequestPage>;
  dbMeta: (requestId: string) => Promise<FulfillmentDbMeta | null>;
  callAction: (requestId: string, action: ActionKey, args: unknown[]) => Promise<AdminActionResult>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<unknown>;
};

function defaultFulfillmentDeps(options: Options): FulfillmentDeps {
  return {
    fetchPage: (requestId) => getFulfillmentRequestPage(options, requestId),
    dbMeta: (requestId) => fulfillmentDbMeta(requestId),
    callAction: (requestId, action, args) =>
      callServerAction<AdminActionResult>(
        options,
        `/admin/fulfillment/${encodeURIComponent(requestId)}`,
        action,
        args,
      ),
    log: (line) => console.error(line),
    sleep,
  };
}

async function loadFulfillmentMeta(deps: FulfillmentDeps, requestId: string): Promise<{ meta: FulfillmentDbMeta | null; warning: string | null }> {
  try {
    const meta = await deps.dbMeta(requestId);
    if (!meta) return { meta: null, warning: `V2 DB (replica) has no fulfillment_requests row for ${requestId}; it may lag a just-created request.` };
    return { meta, warning: null };
  } catch (error) {
    return { meta: null, warning: `V2 DB unavailable (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); Slack-ping prediction and page/DB cross-check are degraded.` };
  }
}

function readbackMatches(plan: FulfillmentWritePlan, page: FulfillmentRequestPage): boolean {
  if (plan.kind === "store-details") return (page.store_details_confirmed_at != null) === (plan.args[1] as boolean);
  if (plan.kind === "branding") return (page.digital_fulfilled_at != null) === (plan.args[1] as boolean);
  if (plan.kind === "ship-to") {
    const want = plan.args[1] as ShipToInput;
    return SHIP_TO_FIELDS.every((f) => (page[f] ?? null) === want[f]);
  }
  if (plan.kind === "note") return (page.notes ?? null) === (plan.after.notes as string | null);
  const { text } = plan.args[1] as { text: string };
  return page.offer_text === text && page.offer_promotion_id === null;
}

// `fulfillment get|store-details|branding|offer <requestId>`. Returns the
// object to print; throws CliError on refusal. Exported for tests with fake deps.
export async function runFulfillmentCommand(
  options: Options,
  command: string,
  requestId: string,
  deps: FulfillmentDeps,
): Promise<Record<string, unknown>> {
  const page = await deps.fetchPage(requestId);
  const { meta, warning } = await loadFulfillmentMeta(deps, requestId);
  if (warning) deps.log(`WARNING: ${warning}`);
  assertFulfillmentPageMatches(page, requestId, meta);

  if (command === "get") {
    return optBool(options, "full")
      ? { ...(page as unknown as Record<string, unknown>), db: meta }
      : summarizeFulfillmentRequest(page, meta);
  }

  let kind: FulfillmentWriteKind;
  const input: { confirmed?: boolean; completed?: boolean; text?: string; shipTo?: ShipToInput; notes?: string | null } = {};
  if (command === "store-details") {
    kind = "store-details";
    const confirm = optBool(options, "confirm");
    const unconfirm = optBool(options, "unconfirm");
    if (confirm === unconfirm) throw new CliError("Pass exactly one of --confirm or --unconfirm.", 2);
    input.confirmed = confirm;
  } else if (command === "branding") {
    kind = "branding";
    const complete = optBool(options, "complete");
    const incomplete = optBool(options, "incomplete");
    if (complete === incomplete) throw new CliError("Pass exactly one of --complete or --incomplete.", 2);
    input.completed = complete;
  } else if (command === "offer") {
    kind = "offer";
    input.text = optString(options, "text");
  } else if (command === "ship-to") {
    kind = "ship-to";
    input.shipTo = parseShipToInput({
      recipient: optString(options, "recipient"),
      line1: optString(options, "line1"),
      line2: optString(options, "line2"),
      city: optString(options, "city"),
      state: optString(options, "state"),
      zip: optString(options, "zip"),
    });
  } else if (command === "note") {
    kind = "note";
    input.notes = composeFulfillmentNotes(page.notes, { set: optString(options, "set"), append: optString(options, "append") });
  } else {
    throw new CliError(`Unknown fulfillment command: ${command}`, 2);
  }

  const plan = planFulfillmentWrite(page, kind, input, meta);
  const shared = {
    request: { id: page.id, location: page.location, account: page.account },
    action: plan.action,
    args: plan.args as JsonValue[],
    before: plan.before,
    after: plan.after,
    state_before: plan.state_before,
    state_after: plan.state_after,
    enters_physical_fulfillment: plan.enters_physical_fulfillment,
    reopens_prints: plan.reopens_prints,
    slack_ping: plan.slack_ping,
    noop: plan.noop,
  };

  if (plan.refusal) {
    throw new CliError(`Refusing (server rule): ${plan.refusal}. Request ${requestId} is in ${plan.state_before}.`, 5);
  }
  if (plan.noop) {
    return { ...shared, dry_run: !optBool(options, "apply"), skipped: "no change: the request already has the requested value; nothing will be written" };
  }
  if (!optBool(options, "apply")) {
    return { ...shared, dry_run: true };
  }

  if (!meta) {
    throw new CliError(
      "Refusing --apply: the V2 DB cross-check of the request/location could not be performed. Retry when v2-db is reachable.",
      6,
    );
  }
  if (plan.slack_ping.expected !== false) {
    deps.log(
      `WARNING: this write ${plan.enters_physical_fulfillment ? "moves" : "leaves"} ${page.location.name} (${requestId}) in physical_fulfillment; production will post the "ready for physical fulfillment" Slack ping to #fulfillment${plan.slack_ping.threaded === true ? " (in the request thread)" : plan.slack_ping.threaded === false ? " (no request thread; top-level)" : ""}.`,
    );
  }

  const result = await deps.callAction(requestId, plan.action, plan.args);
  if (!result || typeof result !== "object" || result.success !== true) {
    const message = result && typeof result === "object" && "error" in result ? String(result.error) : JSON.stringify(result);
    throw new CliError(`Server action ${plan.action} rejected the write: ${message}`, 5);
  }

  const readbackPage = await deps.fetchPage(requestId);
  assertFulfillmentPageMatches(readbackPage, requestId, meta);
  const readbackOk = readbackMatches(plan, readbackPage);
  const readback: Record<string, JsonValue> = {
    ...(plan.kind === "ship-to" ? Object.fromEntries(SHIP_TO_FIELDS.map((f) => [f, readbackPage[f]])) : {}),
    ...(plan.kind === "note" ? { notes: readbackPage.notes } : {}),
    offer_text: readbackPage.offer_text,
    offer_promotion_id: readbackPage.offer_promotion_id,
    store_details_confirmed_at: readbackPage.store_details_confirmed_at,
    digital_fulfilled_at: readbackPage.digital_fulfilled_at,
    state: readbackPage.state,
    unprinted_offer_items: readbackPage.items.filter((i) => OFFER_BEARING_ITEM_TYPES.includes(i.item_type) && !i.printed_at).length,
  };

  // The Slack ping runs in Next's after() and stamps
  // physical_fulfillment_notified_at; the replica lags a few seconds.
  let observedNotifiedAt: string | null | "unknown" = "unknown";
  if (plan.slack_ping.expected !== false) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const fresh = await deps.dbMeta(requestId);
        observedNotifiedAt = fresh?.physical_fulfillment_notified_at ?? null;
      } catch {
        observedNotifiedAt = "unknown";
      }
      if (observedNotifiedAt || Date.now() > deadline) break;
      await deps.sleep(2000);
    }
  }

  const output = {
    ...shared,
    applied: true,
    result,
    readback,
    readback_ok: readbackOk,
    slack_ping_observed: {
      physical_fulfillment_notified_at: observedNotifiedAt,
      note:
        plan.slack_ping.expected === false
          ? "no ping expected; not polled"
          : observedNotifiedAt && observedNotifiedAt !== "unknown"
            ? "stamp set: production posted (or claimed) the ping"
            : "stamp not visible within 20s: replica lag or the ping did not fire; check #fulfillment",
    },
  };
  if (!readbackOk) {
    console.log(JSON.stringify(output, null, 2));
    throw new CliError(`Readback after apply does not show the requested change on ${requestId}.`, 5);
  }
  return output;
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [resource, command, idOrSelector, maybeSelector] = positionals;
  // Most commands take a location id; the self-heal derivation uses it to
  // reach the account-scoped pages (in-store links, location settings,
  // signage, objectives) for the current session account.
  if (idOrSelector && /^[a-z0-9]{20,32}$/i.test(idOrSelector)) {
    if (resource === "fulfillment") healContextRequestId = idOrSelector;
    else healContextLocationId = idOrSelector;
  }

  if (!resource || optBool(options, "help") || resource === "help") {
    printHelp();
    return;
  }

  if (resource === "auth" && command === "check") {
    const response = await boostlyFetch(
      options,
      "/api/jobs/active?type=csv_import",
      {
        headers: { Accept: "application/json" },
      },
    );
    const text = await response.text();
    printOutput(options, {
      ok: response.ok,
      status: response.status,
      authenticated:
        response.ok &&
        response.headers.get("content-type")?.includes("application/json"),
      preview: text.slice(0, 120),
    });
    return;
  }

  if (resource === "auth" && command === "session") {
    printOutput(options, await getAuthSessionAccount(options));
    return;
  }

  if (resource === "auth" && command === "ensure-location" && idOrSelector) {
    printOutput(options, await ensureLocationScope(options, idOrSelector));
    return;
  }

  if (resource === "location" && command === "get" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const location = await getLocation(options, idOrSelector);
    printOutput(
      options,
      optBool(options, "full") ? location : summarizeLocation(location),
    );
    return;
  }

  if (resource === "branding" && command === "get" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const state = await getBrandingState(options, idOrSelector);
    printOutput(options, summarizeBrandingState(state));
    return;
  }

  if (resource === "socials" && command === "set" && idOrSelector) {
    socialLinksPayload(options, "location");
    await maybeEnsureLocationScope(options, idOrSelector);
    await handleSocialsSet(options, idOrSelector);
    return;
  }

  if (resource === "branding" && command === "set" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    await handleBrandingSet(options, idOrSelector);
    return;
  }

  if (resource === "location" && command === "set" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const hasCore = hasCoreLocationOptions(options);
    const hasBranding = hasBrandingOptions(options);
    if (hasCore && hasBranding) {
      throw new CliError(
        "Refusing to mix core location fields with branding/social/app fields in one write. Run location set for website/ordering fields and branding set for branding/social/app fields.",
        2,
      );
    }
    if (hasBranding) {
      await handleBrandingSet(options, idOrSelector);
      return;
    }

    const current = await getLocation(options, idOrSelector);
    const next = mutateLocation(current, options);
    assertFillOnlyLocation(current, next, options);
    if (!optBool(options, "apply")) {
      printOutput(options, {
        dry_run: true,
        before: summarizeLocation(current),
        after: summarizeLocation(next),
      });
      return;
    }
    if (current.__source === "v2-db-core") {
      throw new CliError(
        `Refusing location write from DB fallback payload. ${DB_CORE_LOCATION_WARNING}`,
        5,
      );
    }
    await assertTargetLocationWebPage(options, idOrSelector);
    if (coreLocationFieldsRequested(options).every((field) => current[field] === next[field])) {
      printOutput(options, { success: true, no_op: true, readback: summarizeLocation(current) });
      return;
    }
    const result = await updateLocation(options, idOrSelector, next);
    assertServerActionSucceeded(result, "Location update");
    const readback = await getLocation(options, idOrSelector);
    assertLocationReadback(next, readback, options);
    printOutput(options, { success_result: result, readback: summarizeLocation(readback) });
    return;
  }

  if (resource === "badges" && command === "list" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const [context, session, badges] = await Promise.all([
      getLocationAccountContext(idOrSelector),
      getAuthSessionAccount(options),
      getBadgesForLocation(options, idOrSelector),
    ]);
    assertBadgeSession(context, session);
    printOutput(
      options,
      optBool(options, "full")
        ? badges
        : {
            location_id: badges.location_id,
            active_count: badges.active_count,
            assigned_count: badges.assigned_count,
            unassigned_count: badges.unassigned_count,
            max_issue_id: badges.max_issue_id,
          },
    );
    return;
  }

  if (resource === "badges" && command === "bulk-create" && idOrSelector) {
    await handleBulkBadgeCreate(options, idOrSelector);
    return;
  }

  if (resource === "events" && command === "list" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const events = await getEvents(options, idOrSelector);
    printOutput(
      options,
      optBool(options, "full") ? events : summarizeEvents(events),
    );
    return;
  }

  if (resource === "events" && command === "objectives" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    printOutput(options, await getObjectives(options, idOrSelector));
    return;
  }

  if (
    resource === "events" &&
    command === "enforce-linktree-defaults" &&
    idOrSelector
  ) {
    await enforceLinkTreeDefaults(options, idOrSelector);
    return;
  }

  if (
    resource === "events" &&
    command === "set" &&
    idOrSelector &&
    maybeSelector
  ) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const events = await getEvents(options, idOrSelector);
    assertNonEmptyEventsForWrite(events, idOrSelector, options);
    const event = findEvent(events, maybeSelector);
    const before = structuredClone(event);
    mutateEvent(event, options);
    if (event.type === "custom") {
      Object.assign(event, validateCustomLinkDescription(event));
    }
    if (!optBool(options, "apply")) {
      printOutput(options, { dry_run: true, before, after: event });
      return;
    }
    await assertTargetLocationWebPage(options, idOrSelector);
    const result = await saveEvents(options, idOrSelector, events);
    printOutput(options, result);
    return;
  }

  if (resource === "events" && command === "add-custom" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const events = await getEvents(options, idOrSelector);
    assertNonEmptyEventsForWrite(events, idOrSelector, options);
    const event = buildCustomEvent(events, options);
    const existingMatches = matchingCustomEvents(events, event);
    if (existingMatches.length > 1) {
      throw new CliError(`Custom event URL already has ${existingMatches.length} active records; refusing to add another duplicate.`, 5);
    }
    if (existingMatches.length === 1) {
      const existing = existingMatches[0];
      if (!customEventMatches(event, existing)) {
        if (!optBool(options, "fill-only")) {
          throw new CliError("Custom event URL already exists with conflicting presentation; review the existing event instead of adding a duplicate.", 3);
        }
        const index = events.indexOf(existing);
        const reconciled = {
          ...existing,
          title: event.title,
          display_title: event.display_title,
          description: event.description,
          primary_button_text: event.primary_button_text,
          is_active: event.is_active,
        };
        const next = [...events];
        next[index] = reconciled;
        if (!optBool(options, "apply")) {
          printOutput(options, { dry_run: true, reconcile_existing: true, before: existing, after: reconciled });
          return;
        }
        await assertTargetLocationWebPage(options, idOrSelector);
        const result = await saveEvents(options, idOrSelector, next);
        assertServerActionSucceeded(result, "Custom event reconciliation");
        const readback = await getEvents(options, idOrSelector);
        const matches = matchingCustomEvents(readback, event);
        if (matches.length !== 1 || !customEventMatches(event, matches[0])) {
          throw new CliError("Custom event reconciliation readback did not confirm one exact active event.", 5);
        }
        printOutput(options, { success_result: result, reconciled_existing: true, readback: summarizeEvents(readback) });
        return;
      }
      printOutput(options, {
        success: true,
        no_op: true,
        dry_run: !optBool(options, "apply"),
        readback: summarizeEvents(events),
      });
      return;
    }
    if (optBool(options, "fill-only")) {
      const titleConflict = events.find((candidate) =>
        candidate.type === "custom" &&
        normalize(candidate.title) === normalize(event.title) &&
        canonicalEventUrl(candidate.link) !== canonicalEventUrl(event.link),
      );
      if (titleConflict) {
        throw new CliError(`Fill-only custom event write refused because ${event.title} already points to another URL.`, 3);
      }
    }
    const next = [...events, event];
    if (!optBool(options, "apply")) {
      printOutput(options, {
        dry_run: true,
        add: event,
        resulting_count: next.length,
      });
      return;
    }
    await assertTargetLocationWebPage(options, idOrSelector);
    const result = await saveEvents(options, idOrSelector, next);
    assertServerActionSucceeded(result, "Custom event creation");
    const readback = await getEvents(options, idOrSelector);
    const created = matchingCustomEvents(readback, event);
    if (created.length !== 1 || !customEventMatches(event, created[0])) {
      throw new CliError("Custom event readback did not confirm one exact active event.", 5);
    }
    printOutput(options, { success_result: result, readback: summarizeEvents(readback) });
    return;
  }

  if (
    resource === "events" &&
    command === "delete" &&
    idOrSelector &&
    maybeSelector
  ) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const events = await getEvents(options, idOrSelector);
    assertNonEmptyEventsForWrite(events, idOrSelector, options);
    const event = findEvent(events, maybeSelector);
    const next = events
      .filter((candidate) => candidate !== event)
      .map((candidate, index) => ({
        ...candidate,
        sort_order: index,
      }));
    if (!optBool(options, "apply")) {
      printOutput(options, {
        dry_run: true,
        delete: event,
        resulting_count: next.length,
      });
      return;
    }
    await assertTargetLocationWebPage(options, idOrSelector);
    const result = await saveEvents(options, idOrSelector, next);
    printOutput(options, result);
    return;
  }

  if (resource === "events" && command === "save-json" && idOrSelector) {
    await maybeEnsureLocationScope(options, idOrSelector);
    const file = optString(options, "file");
    if (!file) throw new CliError("save-json requires --file", 2);
    const events = JSON.parse(
      await readFile(file, "utf8"),
    ).map((event: TouchpointEvent) => validateCustomLinkDescription(event)) as TouchpointEvent[];
    assertApply(options, "save-json");
    const current = await getEvents(options, idOrSelector);
    assertNonEmptyEventsForWrite(current, idOrSelector, options);
    await assertTargetLocationWebPage(options, idOrSelector);
    const result = await saveEvents(options, idOrSelector, events);
    printOutput(options, result);
    return;
  }

  if (resource === "instore-init" && command === "status" && idOrSelector) {
    await instoreInitStatus(options, idOrSelector);
    return;
  }

  if (resource === "instore-init" && command === "provision-events" && idOrSelector) {
    await instoreInitProvisionEvents(options, idOrSelector);
    return;
  }

  if (resource === "instore-init" && command === "provision-signage" && idOrSelector) {
    await instoreInitProvisionSignage(options, idOrSelector);
    return;
  }

  if (resource === "promotions" && command === "create" && idOrSelector) {
    await promotionsCreate(options, idOrSelector);
    return;
  }

  if (resource === "offer" && command === "set" && idOrSelector) {
    await offerSet(options, idOrSelector);
    return;
  }

  if (resource === "subscribe-link" && command === "set" && idOrSelector) {
    await subscribeLinkSet(options, idOrSelector);
    return;
  }

  if (resource === "instore-init" && command === "provision-promotions" && idOrSelector) {
    await instoreInitProvisionPromotions(options, idOrSelector);
    return;
  }

  if (resource === "instore-init" && command === "provision-objectives" && idOrSelector) {
    await instoreInitProvisionObjectives(options, idOrSelector);
    return;
  }

  if (resource === "instore-init" && command === "delete-objective" && idOrSelector && maybeSelector) {
    await instoreInitDeleteObjective(options, idOrSelector, maybeSelector);
    return;
  }

  if (resource === "fulfillment" && command && idOrSelector) {
    printOutput(options, await runFulfillmentCommand(options, command, idOrSelector, defaultFulfillmentDeps(options)));
    return;
  }

  throw new CliError(`Unknown command: ${positionals.join(" ")}`, 2);
}

function printHelp() {
  console.log(`boostly-links

Auth:
  Set BOOSTLY_COOKIE to a raw Cookie header, or pass --cookie-file <path>.
  Cookie files are raw header files, not curl/Netscape cookie jars.

Read:
  boostly-links auth check --cookie-file <path>
  boostly-links auth session --cookie-file <path> [--json]
  boostly-links auth ensure-location <locationId> --cookie-file <path> --cookie-out <path> [--json]
  boostly-links location get <locationId> --cookie-file <path> [--json] [--full] [--location-source auto|web|db]
  boostly-links branding get <locationId> --cookie-file <path> [--scope auto|account|location] [--json]
  boostly-links badges list <locationId> --cookie-file <path> --ensure-location-scope [--json] [--full]
  boostly-links events list <locationId> --cookie-file <path> [--json] [--full]
  boostly-links events objectives <locationId> --cookie-file <path> [--json]

Write, dry-run by default:
  boostly-links location set <locationId> --website-url <url> --fill-only --apply
  boostly-links branding set <locationId> --instagram-url <url> --fill-only --apply
  boostly-links badges bulk-create <locationId> --quantity <2-100> --idempotency-key <request-key> --apply
  boostly-links events set <locationId> <event> --active false --apply
  boostly-links events set <locationId> menu --link <url> --button-text "View Menu" --apply
  boostly-links events add-custom <locationId> --title Catering --link <url> --button-text "Order Catering" --apply
  boostly-links events add-custom <locationId> --category careers_jobs --title Careers --link <url> --apply
  boostly-links events enforce-linktree-defaults <locationId> --ensure-location-scope --verified-socials-present true|false [--verified-upcoming-events true|false] [--verified-openings true|false] [--planned-socials-present] [--apply]
  boostly-links events delete <locationId> <event> --apply
  boostly-links events save-json <locationId> --file events.json --apply

Pre-initialization provisioning (locations with touchpoints_initialized_at null):
  boostly-links instore-init status <locationId> --cookie-file <path> --json
  boostly-links instore-init provision-events <locationId> [--promotion-id <id>] [--apply]
  boostly-links instore-init provision-signage <locationId> [--apply]
  boostly-links instore-init provision-promotions <locationId> [--apply]
  boostly-links promotions create <locationId> --title <t> --code <CODE> --value <n> [--description <d>] [--terms <t>] --cookie-file <path> [--apply] [--json]
  boostly-links offer set <locationId> --title '25% OFF' --code SAVE25 --value 25 [--description <d>] [--terms <t>] --cookie-file <path> [--apply] [--json]
    Signage-offer fix in one step: reuse the account promotion with that title
    (or create it via createPromotion), point the text club subscribe event at
    it, then verify keywords.promotion_id for the SUBSCRIBE_ keyword changed
    (exit 5 if not). Dry-run prints existing promos + before/after ids.
    Action ids rotate per deploy; the CLI self-heals from scripts/action-ids.json
    (write actions abort with a rerun instruction, nothing is written twice).
  boostly-links subscribe-link set <locationId> --promotion-text '10% off orders of $30 or more' [--promotion-id <id>] [--subscribe-link-id <id>] --cookie-file <path> --ensure-location-scope [--apply] [--json]
    Edit the location's touchpoint Click to Join link (join-page offer copy and,
    optionally, the promotion the SUBSCRIBE_ keyword pays) via the app's
    updateSubscribeLink action. Whole-form replay of the rendered edit page;
    fails on any untouched-field drift. Use after offer set / events set
    --promotion-id, which do NOT update subscribe_links.promotion_text.
    Completion-mirror default promo catalog for a zero-promotion account (no
    invite_offer recoverable): 6 defaults in order, '20% OFF' earliest. After
    this, activate the CTJ with: events set <loc> subscribe --active true
    --promotion-id <20off-id> --welcome-message <msg> --apply
  boostly-links instore-init provision-objectives <locationId> [--apply]
    Creates 'New Subscriber' + 'Google Review' (reward 0, active) and wires
    them to the subscribe/review location events. Residual gap: is_default and
    is_priority cannot be set through the exposed createObjective action.
  Order matters: provision-events first (creates location events + CTJ when a
  promotion and sender number exist), then provision-signage (7 default signs;
  review-focused signs get touchpoint-scoped overrides). Gaps vs real init:
  objectives/mappings and the initialized_at stamp cannot be written from here.

Admin fulfillment requests (/admin/fulfillment/<requestId>; admin session, no account scoping):
  boostly-links fulfillment get <requestId> --cookie-file <path> [--json] [--full]
  boostly-links fulfillment store-details <requestId> --confirm | --unconfirm [--apply] [--json]
  boostly-links fulfillment branding <requestId> --complete | --incomplete [--apply] [--json]
  boostly-links fulfillment offer <requestId> --text '<offer>' [--apply] [--json]
  boostly-links fulfillment ship-to <requestId> --recipient <name> --line1 <street> [--line2 <unit>] --city <c> --state <XX> --zip <12345> [--apply] [--json]
  boostly-links fulfillment note <requestId> --append '<line>' | --set '<notes>' [--apply] [--json]
    note replays updateNotesAction (the admin page's internal notes textarea).
    --append adds one line under the existing notes (never erases them);
    --set replaces them ('' clears). Trimmed, 2000 chars max, as the schema.
    ship-to replays updateShippingAddressAction: it writes the six shipping_*
    columns on the request's LOCATION row (shared by all requests for that
    location) and does not change the confirmation stamps.
    Replays the page's own actions (setStoreDetailsConfirmedAction,
    setDigitalFulfillmentCompletedAction, updateFulfillmentOfferAction). Reads
    and the post-apply readback come from the rendered page; the V2 replica
    supplies physical_fulfillment_notified_at and must agree with the page on
    request id + location (exit 6 otherwise; --apply refuses without it).
    Dry run prints before/after, state_before/state_after, and slack_ping.
    SLACK: every one of these actions ends with notifyFulfillmentReadyForPhysical.
    When the request's state becomes (or already is) physical_fulfillment and
    physical_fulfillment_notified_at is null, production posts "<location> is
    ready for physical fulfillment" to #fulfillment (threaded when the request
    has a Slack thread). The dry run predicts it and --apply prints a WARNING
    line first. Offer changes reopen printed signage/sticker items (reopens_prints).
    Custom offer text only (promotion_id is written as null), 1-200 chars.

Common event fields:
  --fill-only refuses overwrites and same-title/different-URL custom-event conflicts
  --active true|false
  --title, --display-title, --description, --button-text, --link
  --objective-id, --promotion-id, --welcome-message, --config-json
  --clear description|button-text|link|objective-id|config|promotion-id|welcome-message

Auth/session fields:
  --ensure-location-scope switches/spoofs the authenticated session to the target location account before the command
  --cookie-out <path> writes the updated raw Cookie header after session mutation
  --force-empty-events permits saving from an empty event baseline; do not use from discovery/heartbeat automation

Badge fields:
  --quantity <2-100> matches the Tap Cards Front of House Employee Count
  --idempotency-key <request-key> is required and prevents duplicate automatic creation
  --receipt-file <path> overrides the append-only badge receipt ledger

Location fields:
  --location-source auto|web|db (default auto; db fallback is read-only)
  --website-url, --ordering-url

Branding/social/app fields:
  socials set <locationId> accepts only the five social URL flags below; always fill-only.
    Uses existing save actions while preserving branding. Dry-run returns state_hash;
    --apply requires --expected-state-hash <hash>. No new endpoint or deployment.
  --scope auto|account|location (default auto; General locations are always ignored; account if exactly one non-General enabled/paused location, location override if multiple, refuse if none)
  --facebook-url, --instagram-url, --x-url, --tiktok-url, --youtube-url
  --apple-app-url, --google-app-url
  --web-primary-color, --web-secondary-color, --web-text-color
  --print-primary-color, --print-secondary-color, --print-text-color, --print-text-secondary-color
  --logo-file <path> uploads a PNG, JPEG, or GIF and assigns it at the selected scope
  --logo-attachment-id
  --expect-logo-attachment-id <id|null> refuses the write (exit 6) unless the row about to be replayed carries exactly this logo attachment
  --expect-from-readback <path> derives that expected id from a prior branding get / branding set --apply JSON at the selected scope
    (runners: pass <run-dir>/production-readback.json on every branding set after the first apply; whole-row replay otherwise carries a foreign logo forward)
  --clear <field> clears a branding/social/app override/account field
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    console.error(
      error instanceof Error ? error.stack || error.message : String(error),
    );
    process.exit(1);
  });
}
