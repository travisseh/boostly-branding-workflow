#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_SET, categoryForTouchpoint, categoryForUrl } from "./discover-links.mjs";
import { canonicalEvalUrl } from "./eval-url-canonicalization.mjs";
import { writeJson } from "../../boostly-link-verifier/lib/verify-core.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  main(args).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

async function main(args) {
  const matrix = buildGoldMatrix(args);
  if (args.out) writeJson(args.out, matrix);
  else console.log(JSON.stringify(matrix, null, 2));
}

function buildGoldMatrix(args) {
  const rows = [];
  for (const [label, csvPath] of [
    ["success_csv", args["success-csv"]],
    ["link_settings_csv", args["link-settings-csv"]],
    ["verifier_gold_csv", args["verifier-gold-csv"]]
  ]) {
    if (!csvPath) continue;
    rows.push(...parseCsv(fs.readFileSync(csvPath, "utf8")).map((row) => ({ ...row, source_csv: label })));
  }

  const expectations = rows
    .filter((row) => row.location_id && row.url)
    .map((row) => {
      const category = categoryForGoldRow(row);
      const expectedStatus = row.expected_status || "verified";
      const acceptableAlternateUrls = parseList(row.acceptable_alternate_urls);
      return {
        location_id: row.location_id,
        account_id: row.account_id || "",
        account_name: row.account_name || "",
        location_name: row.location_name || "",
        expected_category: category,
        expected_url: row.url,
        expected_canonical_url: canonicalEvalUrl(row.url),
        acceptable_alternate_urls: acceptableAlternateUrls,
        acceptable_alternate_canonical_urls: acceptableAlternateUrls.map(canonicalEvalUrl).filter(Boolean),
        expected_link_level_status: expectedStatus,
        expected_category_status: row.expected_category_status || "",
        source_csv: row.source_csv,
        source_table: row.source_table || "",
        link_type: row.link_type || "",
        link_settings_field: row.link_settings_field || "",
        custom_link_category: row.custom_link_category || "",
        verify_eligible: isVerifyEligible(expectedStatus),
        ungraded: !category || !CATEGORY_SET.includes(category),
        idempotence_fixture: row.idempotence_fixture === "true" || row.fixture_class === "idempotence"
      };
    });

  return {
    generated_at: new Date().toISOString(),
    source_files: {
      success_csv: args["success-csv"] || null,
      link_settings_csv: args["link-settings-csv"] || null,
      verifier_gold_csv: args["verifier-gold-csv"] || null
    },
    categories: CATEGORY_SET,
    expectations
  };
}

function categoryForGoldRow(row) {
  if (row.link_settings_field === "menu") return "menu";
  if (row.link_settings_field === "order") return "order";
  if (row.link_settings_field === "custom") return customCategory(row.custom_link_category) || categoryForTouchpoint(row) || "other_custom";
  const sourceField = row.source_field || row.link_type || "";
  if (sourceField === "instagram_url") return "instagram";
  if (sourceField === "facebook_url") return "facebook";
  if (sourceField === "tiktok_url") return "tiktok";
  if (sourceField === "youtube_url") return "youtube";
  if (sourceField === "x_url") return "x_twitter";
  if (sourceField === "apple_app_url") return "ios_app";
  if (sourceField === "google_app_url") return "android_app";
  if (sourceField === "ordering_url") return "order";
  if (sourceField === "website_url") return "website";
  return customCategory(row.custom_link_category) || categoryForUrl(row.url, [row.title, row.display_title, row.link_type].filter(Boolean).join(" "));
}

function customCategory(value) {
  const s = normalizeText(value);
  if (!s) return null;
  if (s === "catering") return "catering";
  if (s === "events" || s === "classes") return "events";
  if (s === "careers jobs" || s === "careers_jobs") return "careers_jobs";
  if (s === "gift cards" || s === "gift_cards") return "gift_cards";
  if (s === "reservations") return "reservations";
  if (s === "loyalty rewards" || s === "loyalty_rewards") return "loyalty_rewards";
  if (s === "other custom" || s === "other_custom") return "other_custom";
  return null;
}

function isVerifyEligible(status) {
  const allowed = String(status || "").split("|").map((item) => item.trim());
  return allowed.includes("verified") && !allowed.some((item) => ["missing", "needs_manual_review", "blocked_by_missing_context", "not_found", "rejected", "broken"].includes(item));
}

function parseCsv(text) {
  const parsed = [];
  let row = [], cell = "", quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (quote && c === "\"" && n === "\"") { cell += "\""; i++; continue; }
    if (c === "\"") { quote = !quote; continue; }
    if (!quote && c === ",") { row.push(cell); cell = ""; continue; }
    if (!quote && (c === "\n" || c === "\r")) {
      if (c === "\r" && n === "\n") i++;
      row.push(cell); parsed.push(row); row = []; cell = ""; continue;
    }
    cell += c;
  }
  if (cell || row.length) { row.push(cell); parsed.push(row); }
  const headers = parsed.shift() || [];
  return parsed.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseList(value) {
  return String(value || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else out[key] = next, i++;
  }
  return out;
}

export { buildGoldMatrix, categoryForGoldRow, parseCsv };
