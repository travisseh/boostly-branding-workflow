#!/usr/bin/env node
// Derive Next.js server-action ids for the boostly-links CLI.
//
// Every server-action id on new.boostly.com rotates on each production deploy.
// This module fetches the owning page for each action with the auth cookie,
// pulls that page's client JS chunks, and matches
// createServerReference("<id>", ..., "<exportName>") to recover the current id.
//
//   derive-actions.ts --check [--cookie-file <path>] [--location <id>] [--json]
//   derive-actions.ts --write [--cookie-file <path>] [--location <id>] [--json]
//
// --check prints which action ids differ from scripts/action-ids.json (names
// and ids; ids are not secrets). --write rewrites action-ids.json. Neither
// mode ever prints the cookie. boostly-links.ts imports deriveActionIds() for
// its self-heal path.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_BASE_URL = "https://new.boostly.com";
const V2_DB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "v2-database", "bin", "v2-db");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export const ACTION_IDS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "action-ids.json",
);

// Page templates take {locationId}, {signageId}, {objectiveId}, {requestId}.
// Account-scoped pages 404 unless the session is scoped to the sample
// location's account. /admin/fulfillment/{requestId} is admin-scoped (any
// admin session, any request id).
export const ACTION_SPECS = {
  getEvents: {
    export: "getTouchpointEventConfigForLocation",
    page: "/in-store/links/location/{locationId}",
  },
  getObjectives: {
    export: "getObjectiveOptionsForLocation",
    page: "/in-store/links/location/{locationId}",
  },
  saveEvents: {
    export: "saveLocationTouchpointEventConfigs",
    page: "/in-store/links/location/{locationId}",
  },
  updateLocation: { export: "updateLocation", page: "/locations/{locationId}" },
  updateAccountBranding: { export: "updateAccountBranding", page: "/account-settings" },
  createBulkBadges: { export: "createBulkBadges", page: "/in-store?tab=badges" },
  switchUserAccount: { export: "switchUserAccount", page: "/account-settings" },
  createSignage: { export: "createSignage", page: "/in-store/signage/new" },
  saveTouchpointEventOverrides: {
    export: "saveTouchpointEventConfigForTouchpoint",
    page: "/in-store/signage/{signageId}?tab=links",
  },
  createPromotion: { export: "createPromotion", page: "/promotions/new" },
  createObjective: { export: "createObjective", page: "/in-store/objectives/new" },
  deleteObjective: {
    export: "deleteObjective",
    page: "/in-store/objectives/{objectiveId}",
  },
  // Admin fulfillment request page (src/app/(main)/(admin)/admin/fulfillment/[requestId]/actions.ts).
  setStoreDetailsConfirmed: {
    export: "setStoreDetailsConfirmedAction",
    page: "/admin/fulfillment/{requestId}",
  },
  setDigitalFulfillmentCompleted: {
    export: "setDigitalFulfillmentCompletedAction",
    page: "/admin/fulfillment/{requestId}",
  },
  updateFulfillmentOffer: {
    export: "updateFulfillmentOfferAction",
    page: "/admin/fulfillment/{requestId}",
  },
  updateShippingAddress: {
    export: "updateShippingAddressAction",
    page: "/admin/fulfillment/{requestId}",
  },
  updateFulfillmentNotes: {
    export: "updateNotesAction",
    page: "/admin/fulfillment/{requestId}",
  },
  // Click to Join edit page (src/app/(main)/(protected)/click-to-join/[subscribeLinkId]/actions.ts).
  // Account-scoped: the session must be scoped to the link's account.
  updateSubscribeLink: {
    export: "updateSubscribeLink",
    page: "/click-to-join/{subscribeLinkId}",
  },
} as const;

export type ActionKey = keyof typeof ACTION_SPECS;
export const ACTION_KEYS = Object.keys(ACTION_SPECS) as ActionKey[];

export type ActionIdsFile = {
  build_id: string | null;
  derived_at: string;
  base_url: string;
  actions: Partial<Record<ActionKey, string>>;
  sources: Partial<Record<ActionKey, { export: string; page: string; chunk: string }>>;
};

export type DeriveResult = {
  build_id: string | null;
  actions: Partial<Record<ActionKey, string>>;
  sources: Partial<Record<ActionKey, { export: string; page: string; chunk: string }>>;
  missing: ActionKey[];
  pages: { page: string; status: number; chunks: number; found: string[] }[];
  sample_ids: {
    locationId: string | null;
    signageId: string | null;
    objectiveId: string | null;
    requestId: string | null;
    subscribeLinkId: string | null;
  };
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// The Next flight payload carries the build id as "b":"<id>" (escaped as \"b\"
// inside the HTML script tags, unescaped in server-action responses).
export function extractBuildId(text: string): string | null {
  const match = text.match(/\\?"b\\?":\\?"([A-Za-z0-9_-]{12,48})\\?"/);
  return match ? match[1] : null;
}

export function extractChunkPaths(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/\/_next\/static\/chunks\/[^"'\\ ]+\.js/g)].map((m) => m[0]),
    ),
  ];
}

// Both shapes seen in production chunks:
//   createServerReference("<id>", callServer, void 0, findSourceMapURL, "<name>")
//   (0,x.createServerReference)("<id>",x.callServer,void 0,x.findSourceMapURL,"<name>")
export function scanChunkForActions(js: string): Map<string, string> {
  const found = new Map<string, string>();
  const patterns = [
    /createServerReference\)?\(\s*"([0-9a-f]{40,44})"[^)]*?"([A-Za-z0-9_$]+)"\s*\)/g,
    /"([0-9a-f]{40,44})",[^,]+,void 0,[^,]+,"([A-Za-z0-9_$]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of js.matchAll(pattern)) {
      const [, id, name] = match;
      if (!found.has(name)) found.set(name, id);
    }
  }
  return found;
}

export function fillPage(
  template: string,
  ids: {
    locationId?: string | null;
    signageId?: string | null;
    objectiveId?: string | null;
    requestId?: string | null;
    subscribeLinkId?: string | null;
  },
): string | null {
  let out = template;
  for (const [key, value] of Object.entries(ids)) {
    const token = `{${key}}`;
    if (out.includes(token)) {
      if (!value) return null;
      out = out.replace(token, encodeURIComponent(value));
    }
  }
  return /\{[a-zA-Z]+\}/.test(out) ? null : out;
}

export function normalizeCookieHeader(value: string): string {
  return value.trim().replace(/^Cookie:\s*/i, "");
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function v2DbRows<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync(V2_DB, ["query", "--sql", sql, "--json"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T[];
}

async function sessionAccountId(fetchImpl: FetchLike, baseUrl: string, cookie: string) {
  const response = await fetchImpl(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: cookie, "User-Agent": USER_AGENT, Accept: "application/json" },
    redirect: "manual",
  });
  if (!response.ok) return null;
  const session = (await response.json()) as { user?: { account?: { id?: string | null } } };
  return session.user?.account?.id ?? null;
}

// Sample ids for the account-scoped page templates. A location in the session's
// current account is required; signage/objective ids come from the V2 DB. The
// fulfillment request id is admin-scoped: any live request works (default: the
// most recently created non-canceled one).
export async function resolveSampleIds(
  opts: {
    fetchImpl: FetchLike;
    baseUrl: string;
    cookie: string;
    locationId?: string | null;
    signageId?: string | null;
    objectiveId?: string | null;
    requestId?: string | null;
    subscribeLinkId?: string | null;
  },
): Promise<DeriveResult["sample_ids"]> {
  let locationId = opts.locationId ?? null;
  if (!locationId) {
    const accountId = await sessionAccountId(opts.fetchImpl, opts.baseUrl, opts.cookie);
    if (accountId) {
      const rows = await v2DbRows<{ id: string }>(`
        select id from locations
        where account_id = ${sqlLiteral(accountId)} and status in ('enabled', 'paused') and is_general = false
        order by created_at asc limit 1
      `);
      locationId = rows[0]?.id ?? null;
    }
  }
  let signageId = opts.signageId ?? null;
  let objectiveId = opts.objectiveId ?? null;
  if (locationId && !signageId) {
    const rows = await v2DbRows<{ id: string }>(`
      select id from touchpoints
      where location_id = ${sqlLiteral(locationId)} and type = 'signage' and deleted_at is null
      order by issue_id asc limit 1
    `);
    signageId = rows[0]?.id ?? null;
  }
  if (locationId && !objectiveId) {
    const rows = await v2DbRows<{ id: string }>(`
      select id from touchpoint_objectives
      where location_id = ${sqlLiteral(locationId)} and deleted_at is null
      order by created_at asc limit 1
    `);
    objectiveId = rows[0]?.id ?? null;
  }
  let requestId = opts.requestId ?? null;
  if (!requestId) {
    try {
      const rows = await v2DbRows<{ id: string }>(`
        select id from fulfillment_requests
        where canceled_at is null
        order by created_at desc limit 1
      `);
      requestId = rows[0]?.id ?? null;
    } catch {
      requestId = null;
    }
  }
  let subscribeLinkId = opts.subscribeLinkId ?? null;
  if (locationId && !subscribeLinkId) {
    const rows = await v2DbRows<{ id: string }>(`
      select id from subscribe_links
      where location_id = ${sqlLiteral(locationId)} and deleted_at is null
      order by (attribution_source = 'touchpoint') desc, created_at asc limit 1
    `);
    subscribeLinkId = rows[0]?.id ?? null;
  }
  return { locationId, signageId, objectiveId, requestId, subscribeLinkId };
}

export async function deriveActionIds(opts: {
  cookie: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  sampleIds: DeriveResult["sample_ids"];
  only?: ActionKey[];
}): Promise<DeriveResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const cookie = normalizeCookieHeader(opts.cookie);
  const headers = {
    Cookie: cookie,
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
  };
  const keys = opts.only ?? ACTION_KEYS;

  // Group keys by concrete page so each page and chunk is fetched once.
  const byPage = new Map<string, ActionKey[]>();
  const missing: ActionKey[] = [];
  for (const key of keys) {
    const page = fillPage(ACTION_SPECS[key].page, opts.sampleIds);
    if (!page) {
      missing.push(key);
      continue;
    }
    byPage.set(page, [...(byPage.get(page) ?? []), key]);
  }

  const result: DeriveResult = {
    build_id: null,
    actions: {},
    sources: {},
    missing,
    pages: [],
    sample_ids: opts.sampleIds,
  };
  const chunkCache = new Map<string, Map<string, string>>();

  for (const [page, pageKeys] of byPage) {
    const response = await fetchImpl(`${baseUrl}${page}`, { headers, redirect: "manual" });
    const html = await response.text();
    const wanted = new Map(pageKeys.map((key) => [ACTION_SPECS[key].export, key]));
    const found: string[] = [];
    const chunks = response.ok ? extractChunkPaths(html) : [];
    if (response.ok && !result.build_id) result.build_id = extractBuildId(html);
    for (const chunk of chunks) {
      if (wanted.size === 0) break;
      let actions = chunkCache.get(chunk);
      if (!actions) {
        const chunkResponse = await fetchImpl(`${baseUrl}${chunk}`, { headers });
        actions = chunkResponse.ok ? scanChunkForActions(await chunkResponse.text()) : new Map();
        chunkCache.set(chunk, actions);
      }
      for (const [exportName, key] of [...wanted]) {
        const id = actions.get(exportName);
        if (!id) continue;
        result.actions[key] = id;
        result.sources[key] = { export: exportName, page, chunk: chunk.split("/").pop() ?? chunk };
        found.push(key);
        wanted.delete(exportName);
      }
    }
    for (const key of wanted.values()) result.missing.push(key);
    result.pages.push({ page, status: response.status, chunks: chunks.length, found });
  }
  return result;
}

export function diffActionIds(
  current: Partial<Record<ActionKey, string>>,
  derived: Partial<Record<ActionKey, string>>,
): { key: ActionKey; from: string | null; to: string }[] {
  const changes: { key: ActionKey; from: string | null; to: string }[] = [];
  for (const key of ACTION_KEYS) {
    const to = derived[key];
    if (!to) continue;
    const from = current[key] ?? null;
    if (from !== to) changes.push({ key, from, to });
  }
  return changes;
}

export async function readActionIdsFile(path = ACTION_IDS_FILE): Promise<ActionIdsFile | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ActionIdsFile;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

// Merges derived ids over the existing file so keys the derivation could not
// reach (page 404 for an unscoped account) keep their previous value.
export function mergeActionIdsFile(
  previous: ActionIdsFile | null,
  derived: DeriveResult,
  baseUrl: string,
  now = new Date(),
): ActionIdsFile {
  return {
    build_id: derived.build_id ?? previous?.build_id ?? null,
    derived_at: now.toISOString(),
    base_url: baseUrl,
    actions: { ...(previous?.actions ?? {}), ...derived.actions },
    sources: { ...(previous?.sources ?? {}), ...derived.sources },
  };
}

export async function writeActionIdsFile(data: ActionIdsFile, path = ACTION_IDS_FILE) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

async function readCookieFromArgs(args: Map<string, string | true>): Promise<string> {
  const inline = process.env.BOOSTLY_COOKIE;
  if (inline) return normalizeCookieHeader(inline);
  const file =
    (typeof args.get("cookie-file") === "string" ? (args.get("cookie-file") as string) : null) ??
    process.env.BOOSTLY_COOKIE_FILE;
  if (!file) {
    throw new Error(
      "Missing auth. Set BOOSTLY_COOKIE, BOOSTLY_COOKIE_FILE, or pass --cookie-file <path> with a raw Cookie header.",
    );
  }
  return normalizeCookieHeader(await readFile(file, "utf8"));
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) args.set(key, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.set(key, argv[++i]);
    else args.set(key, true);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.has("write") ? "write" : args.has("check") ? "check" : null;
  if (!mode || args.has("help")) {
    console.log(`derive-actions.ts --check|--write [--cookie-file <path>] [--location <id>] [--signage <id>] [--objective <id>] [--request <id>] [--only k1,k2] [--json]

  --check  derive current ids from the live site and list keys that differ from action-ids.json (exit 3 when any differ)
  --write  derive and rewrite action-ids.json (build id + derived_at included)
  --location <id> a location in the session's current account (default: first enabled location of the session account via V2 DB)
  --request <id>  a fulfillment request id for the admin /admin/fulfillment/<id> page (default: latest non-canceled request via V2 DB)
  Auth: BOOSTLY_COOKIE, BOOSTLY_COOKIE_FILE, or --cookie-file. The cookie is never printed.`);
    return;
  }
  const cookie = await readCookieFromArgs(args);
  const baseUrl = (
    (typeof args.get("base-url") === "string" ? (args.get("base-url") as string) : null) ??
    process.env.BOOSTLY_BASE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  const str = (key: string) => (typeof args.get(key) === "string" ? (args.get(key) as string) : null);
  const only = str("only")
    ?.split(",")
    .map((k) => k.trim())
    .filter((k): k is ActionKey => (ACTION_KEYS as string[]).includes(k));

  const sampleIds = await resolveSampleIds({
    fetchImpl: fetch,
    baseUrl,
    cookie,
    locationId: str("location"),
    signageId: str("signage"),
    objectiveId: str("objective"),
    requestId: str("request"),
  });
  const derived = await deriveActionIds({ cookie, baseUrl, sampleIds, only });
  const previous = await readActionIdsFile();
  const changes = diffActionIds(previous?.actions ?? {}, derived.actions);
  const json = args.has("json");

  if (mode === "check") {
    const report = {
      mode,
      build_id: { current: previous?.build_id ?? null, live: derived.build_id },
      derived_at: previous?.derived_at ?? null,
      sample_ids: sampleIds,
      changed: changes,
      missing: derived.missing,
      pages: derived.pages,
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`build: file=${report.build_id.current ?? "none"} live=${report.build_id.live ?? "unknown"}`);
      if (changes.length === 0) console.log(`no action id changes (${Object.keys(derived.actions).length} derived)`);
      for (const change of changes) console.log(`CHANGED ${change.key}: ${change.from ?? "none"} -> ${change.to}`);
      if (derived.missing.length) console.log(`not derivable: ${derived.missing.join(", ")} (page 404 or no sample id; scope the session to the sample location's account)`);
    }
    process.exitCode = changes.length ? 3 : 0;
    return;
  }

  const next = mergeActionIdsFile(previous, derived, baseUrl);
  const path = await writeActionIdsFile(next);
  const report = {
    mode,
    wrote: path,
    build_id: next.build_id,
    derived_at: next.derived_at,
    changed: changes,
    missing: derived.missing,
    derived_count: Object.keys(derived.actions).length,
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`wrote ${path} (build ${next.build_id ?? "unknown"}, ${report.derived_count} ids derived)`);
    for (const change of changes) console.log(`CHANGED ${change.key}: ${change.from ?? "none"} -> ${change.to}`);
    if (derived.missing.length) console.log(`not derivable (kept previous): ${derived.missing.join(", ")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
