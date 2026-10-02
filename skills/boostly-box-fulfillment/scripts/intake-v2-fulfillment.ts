#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PreparationInput } from "./prepare-fulfillment-plan.ts";
import type { LocationCandidate } from "./location-match.ts";
import { V2_DB } from "./paths.ts";

const DB = V2_DB;
export type DatabaseRequest = LocationCandidate & {
  request_id: string;
  created_at: string;
  order_type: string;
  canceled_at: string | null;
  digital_fulfilled_at: string | null;
};

function query(sql: string): any[] {
  return JSON.parse(execFileSync(DB, ["query", "--sql", sql, "--json"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
}
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function databasePreparation(row: DatabaseRequest, accountLocations: LocationCandidate[], report: Record<string, unknown>): PreparationInput {
  if (!row.request_id || !row.location_id || !row.account_id || !row.address) throw new Error("Incomplete database request identity");
  if (row.order_type !== "full_order" || row.canceled_at || row.is_general) throw new Error("Request is canceled or outside full-order scope");
  const target = accountLocations.filter(l => l.location_id === row.location_id && l.account_id === row.account_id);
  if (target.length !== 1 || target[0].address !== row.address || target[0].location_name !== row.location_name) throw new Error("Database foreign-key identity mismatch");
  return {
    write_policy: "links_only",
    request: {
      request_key: `v2:${row.request_id}`,
      fulfillment_request_id: row.request_id,
      expected_location_id: row.location_id,
      canonical_thread_ts: "",
      fields: { account_name: row.account_name, location_name: row.location_name, street_address: row.address, city: "", state: "", postal_code: "" },
      badge_quantity: null,
      badge_quantity_status: "missing",
    },
    location_candidates: target,
    account_locations: accountLocations,
    discovery_report: report,
    branding: { status: "hold", flags: [], rationale: "Outside link-only scope; no branding operations" },
  };
}

export function loadDatabaseIntake(since: string, extraIds: string[] = []): { requests: DatabaseRequest[]; account_locations: LocationCandidate[] } {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(since)) throw new Error("Invalid intake start date");
  if (extraIds.some(id => !/^[a-z0-9]+$/.test(id))) throw new Error("Invalid fulfillment request ID");
  const fields = `fr.id request_id,fr.created_at,fr.order_type::text,fr.canceled_at,fr.digital_fulfilled_at,l.id location_id,l.account_id,l.name location_name,a.name account_name,l.address,l.website_url,l.google_place_id,l.is_general,l.status::text location_status,a.status::text account_status`;
  const from = `from fulfillment_requests fr join locations l on l.id=fr.location_id join accounts a on a.id=l.account_id`;
  const requests: DatabaseRequest[] = [];
  let cursor: DatabaseRequest | undefined;
  while (true) {
    const after = cursor ? `and (fr.created_at,fr.id) > (${literal(cursor.created_at)}::timestamp,${literal(cursor.request_id)})` : "";
    const page = query(`select ${fields} ${from} where fr.created_at >= ${literal(since)}::timestamp ${after} order by fr.created_at,fr.id limit 100`) as DatabaseRequest[];
    requests.push(...page);
    if (page.length < 100) break;
    cursor = page.at(-1);
  }
  if (extraIds.length) {
    for (const row of query(`select ${fields} ${from} where fr.id in (${extraIds.map(literal).join(",")})`) as DatabaseRequest[]) {
      if (!requests.some(existing => existing.request_id === row.request_id)) requests.push(row);
    }
  }
  const accounts = [...new Set(requests.map(row => row.account_id))];
  const account_locations = accounts.length ? query(`select l.id location_id,l.account_id,l.name location_name,a.name account_name,l.address,l.website_url,l.google_place_id,l.is_general,l.status::text location_status,a.status::text account_status from locations l join accounts a on a.id=l.account_id where l.account_id in (${accounts.map(literal).join(",")})`) : [];
  requests.sort((a,b) => Number(/fahrenheit/i.test(b.location_name)) - Number(/fahrenheit/i.test(a.location_name)) || a.created_at.localeCompare(b.created_at) || a.request_id.localeCompare(b.request_id));
  return { requests, account_locations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((pairs, token, i, all) => i % 2 ? pairs : [...pairs, [token, all[i + 1]]], []));
  if (!args["--since"] || !args["--out"]) throw new Error("Usage: --since YYYY-MM-DD --out intake.json [--include-ids id,id]");
  const result = loadDatabaseIntake(args["--since"], args["--include-ids"]?.split(",").filter(Boolean));
  fs.writeFileSync(args["--out"], JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ requests: result.requests.length, eligible: result.requests.filter(r => r.order_type === "full_order" && !r.canceled_at && !r.is_general).length }));
}
