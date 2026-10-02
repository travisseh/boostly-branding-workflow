#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REPLICA_HOST = "34.182.101.126";
// MCP read path (boostly-branding-workflow): when BOOSTLY_ADMIN_MCP_KEY is set and no V2_DB_* replica
// credentials are, read-only SQL goes through the Boostly admin MCP server's run_read_query tool
// (5 s statement timeout, 1000 rows by default, 5000 max, credential tables blocked). Same CLI surface.
const MCP_URL_DEFAULT = "https://new.boostly.com/api/mcp";
const ENV_PATHS = [
  `${process.cwd()}/.local/v2-db.env`,
  `${process.env.HOME}/.config/boostly-branding/.env`,
  `${process.env.HOME}/.config/boostly/v2-db.env`,
];

type Args = {
  command: string;
  flags: Map<string, string | boolean>;
};

type DbConfig = {
  host: string;
  port: string;
  name: string;
  user: string;
  password: string;
  envPath: string;
  mode: "replica";
};

function printHelp(): void {
  console.log(`Usage: v2-db <command> [options]

Commands:
  doctor               Check psql and resolved DB config without printing secrets
  conn-info            Print redacted connection info
  query                Run read-only SQL from --sql or --file
  tables               List tables in a schema
  describe             Describe table columns
  active-accounts      Canonical active account count
  badge-overview       Badge setup/assignment summary
  touchpoint-event-mix Last-N-days touchpoint event mix
  mcp-usage            Current teammate MCP key/activity overview

Common options:
  --json               JSON output where supported
  --csv                CSV output for query
  --replica            Use the configured read replica; default and only mode
  --schema <name>      Schema for tables/describe; default public
  --table <name>       Table for describe
  --sql <sql>          SQL string for query
  --file <path>        SQL file for query
  --days <n>           Window for touchpoint-event-mix; default 30
  --limit <n>          Row limit for query wrapper or named reports

Examples:
  v2-db doctor
  v2-db query --sql "select count(*) from accounts" --json
  v2-db tables --schema public
  v2-db describe --table campaigns
  v2-db active-accounts --json`);
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

function flag(args: Args, name: string, fallback = ""): string {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : fallback;
}

function hasFlag(args: Args, name: string): boolean {
  return args.flags.has(name);
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}

function loadSharedEnv(): void {
  if (process.env.V2_DB_HOST || process.env.BOOSTLY_ADMIN_MCP_KEY) return;
  for (const path of ENV_PATHS) {
    if (existsSync(path)) {
      loadEnvFile(path);
      break;
    }
  }
}

function mcpMode(): boolean {
  return Boolean(process.env.BOOSTLY_ADMIN_MCP_KEY) && !process.env.V2_DB_HOST;
}

async function mcpRows(sql: string, maxRows?: number): Promise<Array<Record<string, unknown>>> {
  assertSafeSql(sql);
  const url = process.env.BOOSTLY_ADMIN_MCP_URL || MCP_URL_DEFAULT;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "run_read_query", arguments: { sql: stripTrailingSemicolon(sql), ...(maxRows ? { max_rows: maxRows } : {}) } },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.BOOSTLY_ADMIN_MCP_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status} from ${url}`);
  const payload = (await response.json()) as { error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } };
  if (payload.error) throw new Error(`MCP error: ${payload.error.message || "unknown"}`);
  const text = payload.result?.content?.find((c) => c.type === "text")?.text || "";
  if (payload.result?.isError) throw new Error(`run_read_query failed: ${text.slice(0, 500)}`);
  let parsed: { rows?: Array<Record<string, unknown>>; truncated?: boolean; error?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`run_read_query returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (parsed.error) throw new Error(`run_read_query: ${parsed.error}`);
  if (parsed.truncated) console.error("v2-db: MCP result truncated (row cap); narrow the query or pass --limit up to 5000.");
  return parsed.rows || [];
}

function printRows(rows: Array<Record<string, unknown>>, opts: { json?: boolean; csv?: boolean }): void {
  if (opts.json) {
    console.log(JSON.stringify(rows));
    return;
  }
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const sep = opts.csv ? "," : "|";
  console.log(cols.join(sep));
  for (const row of rows) console.log(cols.map((c) => cell(row[c])).join(sep));
}

function resolveConfig(args: Args): DbConfig {
  for (const forbiddenFlag of ["primary", "reporting-write", "apply", "host"]) {
    if (hasFlag(args, forbiddenFlag)) {
      throw new Error(`Refusing --${forbiddenFlag}. This local CLI is permanently read-replica-only.`);
    }
  }
  let envPath = "shell";
  if (!process.env.V2_DB_HOST || !process.env.V2_DB_PASSWORD) {
    for (const path of ENV_PATHS) {
      if (existsSync(path)) {
        loadEnvFile(path);
        envPath = path;
        break;
      }
    }
  }
  const missing = ["V2_DB_HOST", "V2_DB_NAME", "V2_DB_USER", "V2_DB_PASSWORD"].filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. Set BOOSTLY_ADMIN_MCP_KEY (MCP read path) or V2_DB_* in ~/.config/boostly-branding/.env.`);
  }
  const host = process.env.V2_DB_HOST || "";
  if (host !== REPLICA_HOST) {
    throw new Error(`Refusing database host ${host || "<missing>"}. This local CLI only permits the read replica.`);
  }
  return {
    host,
    port: flag(args, "port", process.env.V2_DB_PORT || "5432"),
    name: flag(args, "db", process.env.V2_DB_NAME || ""),
    user: flag(args, "user", process.env.V2_DB_USER || ""),
    password: process.env.V2_DB_PASSWORD || "",
    envPath,
    mode: "replica",
  };
}

function connectionString(config: DbConfig): string {
  return `postgresql://${encodeURIComponent(config.user)}@${config.host}:${config.port}/${encodeURIComponent(config.name)}?sslmode=require&target_session_attrs=read-only&application_name=v2_db_replica_only&options=-c%20default_transaction_read_only%3Don%20-c%20statement_timeout%3D60000`;
}

function runPsql(config: DbConfig, sql: string, opts: { json?: boolean; csv?: boolean } = {}): string {
  const args = ["-v", "ON_ERROR_STOP=1", connectionString(config)];
  if (opts.csv) args.push("-A", "-F", ",");
  else if (opts.json) args.push("-t", "-A");
  const result = spawnSync("psql", [...args, "-c", sql], {
    encoding: "utf8",
    env: {
      ...process.env,
      PGPASSWORD: config.password,
      PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=60000",
    },
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isReadOnlySql(sql: string): boolean {
  const normalized = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
  return /^(select|with|show|explain)\b/.test(normalized);
}

function assertSafeSql(sql: string): void {
  if (isReadOnlySql(sql)) return;
  throw new Error("Refusing write SQL. This local CLI is permanently read-replica-only.");
}

function jsonWrap(sql: string): string {
  return `SELECT COALESCE(json_agg(row_to_json(v2_db_q)), '[]'::json) FROM (${stripTrailingSemicolon(sql)}) v2_db_q`;
}

async function commandDoctor(args: Args): Promise<void> {
  if (mcpMode()) {
    const probe = await mcpRows("SELECT current_database() AS database, current_user AS user_name, pg_is_in_recovery() AS is_replica", 1);
    console.log(JSON.stringify({ ok: true, mode: "mcp", url: process.env.BOOSTLY_ADMIN_MCP_URL || MCP_URL_DEFAULT, key: "<redacted>", probe }, null, 2));
    return;
  }
  const config = resolveConfig(args);
  const version = spawnSync("psql", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error("psql is not available on PATH.");
  const probeSql = "SELECT current_database() AS database, current_user AS user_name, inet_server_addr()::text AS server_addr, pg_is_in_recovery() AS is_replica";
  const probe = runPsql(config, jsonWrap(probeSql), { json: true });
  const probeRows = JSON.parse(probe || "[]");
  if (probeRows[0]?.is_replica !== true) {
    throw new Error("Refusing connection because PostgreSQL did not identify itself as a read replica.");
  }
  console.log(JSON.stringify({ ok: true, psql: version.stdout.trim(), config: redactedConfig(config), probe: probeRows }, null, 2));
}

function redactedConfig(config: DbConfig): Record<string, string> {
  return {
    mode: config.mode,
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    envPath: config.envPath,
    password: "<redacted>",
  };
}

function commandConnInfo(args: Args): void {
  if (mcpMode()) {
    console.log(JSON.stringify({ mode: "mcp", url: process.env.BOOSTLY_ADMIN_MCP_URL || MCP_URL_DEFAULT, key: "<redacted>" }, null, 2));
    return;
  }
  console.log(JSON.stringify(redactedConfig(resolveConfig(args)), null, 2));
}

async function commandQuery(args: Args): Promise<void> {
  const sql = flag(args, "sql") || (flag(args, "file") ? readFileSync(flag(args, "file"), "utf8") : "");
  if (!sql.trim()) throw new Error("query requires --sql or --file.");
  assertSafeSql(sql);
  if (mcpMode()) {
    const limit = flag(args, "limit");
    printRows(await mcpRows(sql, limit ? parseBoundedInt(limit, "--limit", 1, 5000) : undefined), { json: hasFlag(args, "json"), csv: hasFlag(args, "csv") });
    return;
  }
  const config = resolveConfig(args);
  if (hasFlag(args, "json") && isReadOnlySql(sql)) {
    console.log(runPsql(config, jsonWrap(sql), { json: true }));
    return;
  }
  console.log(runPsql(config, sql, { csv: hasFlag(args, "csv") }));
}

function commandTables(args: Args): Promise<void> {
  const schema = flag(args, "schema", "public");
  const sql = `SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = '${sqlLiteral(schema)}'
  AND table_type = 'BASE TABLE'
ORDER BY table_name`;
  return runNamedRead(args, sql);
}

function commandDescribe(args: Args): Promise<void> {
  const schema = flag(args, "schema", "public");
  const table = flag(args, "table");
  if (!table) throw new Error("describe requires --table <name>.");
  const sql = `SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = '${sqlLiteral(schema)}'
  AND table_name = '${sqlLiteral(table)}'
ORDER BY ordinal_position`;
  return runNamedRead(args, sql);
}

function commandActiveAccounts(args: Args): Promise<void> {
  return runNamedRead(args, `WITH active_accounts AS (
  SELECT a.id, a.name, a.created_at
  FROM accounts a
  WHERE a.deleted_at IS NULL
    AND a.status = 'enabled'
    AND EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.account_id = a.id
        AND c.status = 'completed'
        AND c.sent_at >= NOW() - INTERVAL '90 days'
    )
)
SELECT COUNT(*)::int AS active_accounts FROM active_accounts`);
}

function commandBadgeOverview(args: Args): Promise<void> {
  return runNamedRead(args, `WITH badge_base AS (
  SELECT tp.*, l.account_id, l.name AS location_name, a.name AS account_name
  FROM touchpoints tp
  JOIN locations l ON l.id = tp.location_id
  JOIN accounts a ON a.id = l.account_id
  WHERE tp.type = 'badge'
    AND tp.deleted_at IS NULL
    AND a.deleted_at IS NULL
    AND a.name NOT IN ('Boostly', 'Boostly Pizza', 'Test Co')
)
SELECT
  COUNT(*)::int AS total_badges,
  COUNT(*) FILTER (WHERE account_user_id IS NOT NULL)::int AS assigned_badges,
  COUNT(DISTINCT account_user_id) FILTER (WHERE account_user_id IS NOT NULL)::int AS staff_with_badge,
  COUNT(DISTINCT account_id) FILTER (WHERE account_user_id IS NOT NULL)::int AS accounts_with_assigned_badges,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS badges_created_30d,
  COUNT(*) FILTER (WHERE account_user_id IS NOT NULL AND updated_at >= NOW() - INTERVAL '30 days')::int AS assigned_badges_updated_30d
FROM badge_base`);
}

function commandTouchpointEventMix(args: Args): Promise<void> {
  const days = parseBoundedInt(flag(args, "days", "30"), "--days", 1, 365);
  return runNamedRead(args, `SELECT
  event_type,
  COUNT(*)::int AS events,
  COUNT(DISTINCT account_user_id) FILTER (WHERE account_user_id IS NOT NULL)::int AS staff,
  COUNT(DISTINCT location_id)::int AS locations
FROM touchpoint_event_logs
WHERE created_at >= NOW() - INTERVAL '${days} days'
GROUP BY event_type
ORDER BY events DESC`);
}

function commandMcpUsage(args: Args): Promise<void> {
  return runNamedRead(args, `WITH key_users AS (
  SELECT DISTINCT user_id FROM mcp_api_keys WHERE revoked_at IS NULL
),
activity_users AS (
  SELECT DISTINCT user_id FROM mcp_activity_logs
  WHERE created_at >= NOW() - INTERVAL '90 days'
),
combined AS (
  SELECT user_id FROM key_users
  UNION
  SELECT user_id FROM activity_users
)
SELECT
  u.name,
  u.email,
  EXISTS (SELECT 1 FROM key_users ku WHERE ku.user_id = u.id) AS has_active_key,
  COUNT(mal.id)::int AS calls_90d,
  MAX(mal.created_at) AS last_call_at
FROM combined c
JOIN users u ON u.id = c.user_id
LEFT JOIN mcp_activity_logs mal
  ON mal.user_id = u.id
 AND mal.created_at >= NOW() - INTERVAL '90 days'
WHERE COALESCE(u.email, '') NOT IN ('kassidy.farrer@boostly.com', 'chris@boostly.com')
GROUP BY u.id, u.name, u.email
ORDER BY calls_90d DESC, has_active_key DESC, u.name`);
}

function parseBoundedInt(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be between ${min} and ${max}.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return parsed;
}

async function runNamedRead(args: Args, sql: string): Promise<void> {
  if (mcpMode()) {
    printRows(await mcpRows(sql), { json: hasFlag(args, "json") });
    return;
  }
  const config = resolveConfig(args);
  const output = hasFlag(args, "json") ? runPsql(config, jsonWrap(sql), { json: true }) : runPsql(config, sql);
  console.log(output);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadSharedEnv();
  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "doctor":
      await commandDoctor(args);
      return;
    case "conn-info":
      commandConnInfo(args);
      return;
    case "query":
      await commandQuery(args);
      return;
    case "tables":
      await commandTables(args);
      return;
    case "describe":
      await commandDescribe(args);
      return;
    case "active-accounts":
      await commandActiveAccounts(args);
      return;
    case "badge-overview":
      await commandBadgeOverview(args);
      return;
    case "touchpoint-event-mix":
      await commandTouchpointEventMix(args);
      return;
    case "mcp-usage":
      await commandMcpUsage(args);
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
