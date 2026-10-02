#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchLocationExactly,
  type FulfillmentRequestIdentity,
  type LocationCandidate,
} from "./location-match.ts";

import { MESSAGE_ME } from "./paths.ts";

export type BatchPreflightRequest = {
  request_key: string;
  canonical_thread_ts: string;
  fields: FulfillmentRequestIdentity;
  location_candidates: LocationCandidate[];
  // Present when intake came from v2-db (list-branding-requests.ts): the request's own
  // location_id foreign key. Exact matching then verifies the row instead of searching for it.
  fulfillment_request_id?: string;
  expected_location_id?: string;
};

export type MissingPlaceIdBlocker = {
  request_key: string;
  canonical_thread_ts: string;
  account_name: string;
  location_name: string;
  location_id: string;
};

export type BatchPreflightResult = {
  status: "ready" | "blocked_missing_google_place_id";
  checked_requests: number;
  matched_requests: number;
  unresolved_requests: Array<{
    request_key: string;
    canonical_thread_ts: string;
    reason: "no_exact_match" | "ambiguous_exact_match" | "foreign_key_mismatch";
  }>;
  blockers: MissingPlaceIdBlocker[];
};

export function preflightFulfillmentBatch(
  requests: BatchPreflightRequest[],
): BatchPreflightResult {
  const blockers: MissingPlaceIdBlocker[] = [];
  const unresolvedRequests: BatchPreflightResult["unresolved_requests"] = [];
  let matchedRequests = 0;

  for (const request of requests) {
    const match = matchLocationExactly(request.fields, request.location_candidates);
    if (match.status !== "matched") {
      unresolvedRequests.push({
        request_key: request.request_key,
        canonical_thread_ts: request.canonical_thread_ts,
        reason: match.reason,
      });
      continue;
    }
    if (request.expected_location_id && match.location.location_id !== request.expected_location_id) {
      unresolvedRequests.push({
        request_key: request.request_key,
        canonical_thread_ts: request.canonical_thread_ts,
        reason: "foreign_key_mismatch",
      });
      continue;
    }
    matchedRequests += 1;
    if (!nonEmptyString(match.location.google_place_id)) {
      blockers.push({
        request_key: request.request_key,
        canonical_thread_ts: request.canonical_thread_ts,
        account_name: match.location.account_name,
        location_name: match.location.location_name,
        location_id: match.location.location_id,
      });
    }
  }

  return {
    status: blockers.length ? "blocked_missing_google_place_id" : "ready",
    checked_requests: requests.length,
    matched_requests: matchedRequests,
    unresolved_requests: unresolvedRequests,
    blockers,
  };
}

export function missingPlaceIdMessage(blockers: MissingPlaceIdBlocker[]): string {
  const locations = blockers
    .map((blocker) =>
      `- ${blocker.account_name} / ${blocker.location_name} (V2 ${blocker.location_id})`,
    )
    .join("\n");
  return [
    "Boosted Box fulfillment stopped before discovery or writes.",
    "These matched V2 locations are missing google_place_id:",
    locations,
    "Add the Place ID, then rerun the batch. No request state was advanced.",
  ].join("\n");
}

function notifyTravisse(message: string): void {
  const result = spawnSync("python3", [MESSAGE_ME, "-"], {
    input: message,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "Failed to text missing Place ID blocker").trim(),
    );
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) args[key] = true;
    else {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.input !== "string" || typeof args.out !== "string") {
    throw new Error(
      "Usage: --input <batch-preflight.json> --out <batch-preflight-result.json> [--notify]",
    );
  }
  const input = JSON.parse(
    fs.readFileSync(path.resolve(args.input), "utf8"),
  ) as { requests: BatchPreflightRequest[] };
  if (!Array.isArray(input.requests)) throw new Error("Input must contain requests[]");

  const result = preflightFulfillmentBatch(input.requests);
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "blocked_missing_google_place_id") {
    if (args.notify === true) notifyTravisse(missingPlaceIdMessage(result.blockers));
    process.exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
