#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoldMatrix } from "./build-gold-matrix.mjs";
import { CATEGORY_SET, discoverLocation } from "./discover-links.mjs";
import { canonicalEvalUrl, sameEvalUrl } from "./eval-url-canonicalization.mjs";
import { writeJson } from "../../boostly-link-verifier/lib/verify-core.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  main(args).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

async function main(args) {
  if (!args["out-dir"]) throw new Error("--out-dir is required");
  const summary = await evaluateSuccessCases(args);
  console.log(JSON.stringify({
    suite: summary.suite,
    locations_tested: summary.locations_tested,
    locations_requested: summary.locations_requested,
    locations_skipped: summary.locations_skipped.length,
    expected_rows: summary.expected_rows,
    verified_matches: summary.verified_matches,
    missing_expected_rows: summary.missing_expected_rows.length,
    false_positives: summary.false_positives.length,
    manual_review_count: summary.manual_review_count,
    order_challenge_carveout_count: summary.order_challenge_carveout_count,
    write_plan_safety_violations: summary.write_plan_safety_violations.length,
    idempotence_failures: summary.idempotence_failures.length,
    missing_fixture_rows: summary.missing_fixture_rows.length,
    out_dir: args["out-dir"]
  }, null, 2));
  if (summary.failures > 0) process.exitCode = 2;
}

async function evaluateSuccessCases(args) {
  const outDir = args["out-dir"];
  fs.mkdirSync(path.join(outDir, "locations"), { recursive: true });
  const matrix = buildGoldMatrix(args);
  writeJson(path.join(outDir, "gold-matrix.json"), matrix);

  const locationFilter = csvArgSet(args["location-ids"]);
  const categoryFilter = csvArgSet(args.categories);
  const expectations = matrix.expectations.filter((row) => {
    if (!row.location_id || row.ungraded) return false;
    if (locationFilter && !locationFilter.has(row.location_id)) return false;
    if (categoryFilter && !categoryFilter.has(canonicalEvalCategory(row.expected_category))) return false;
    return true;
  });
  const byLocation = groupBy(expectations, (row) => row.location_id);
  const requestedLocationIds = locationFilter ? [...locationFilter] : [];
  const locationsSkipped = requestedLocationIds
    .filter((locationId) => !byLocation.has(locationId))
    .map((location_id) => ({
      location_id,
      reason: categoryFilter ? "no_gold_rows_for_requested_categories" : "no_gold_rows"
    }));
  const missingExpected = [];
  const falsePositives = [];
  const writePlanSafetyViolations = [];
  const idempotenceFailures = [];
  const missingFixtureRows = [];
  const schemaFailures = [];
  const locationSummaries = [];
  let verifiedMatches = 0;
  let manualReviewCount = 0;
  let orderChallengeCarveoutCount = 0;

  for (const [locationId, rows] of byLocation.entries()) {
    let report;
    try {
      report = await discoverLocation(locationId, args);
    } catch (error) {
      if (error.code === "missing_fixture") {
        missingFixtureRows.push({ location_id: locationId, error: error.message });
        continue;
      }
      throw error;
    }
    writeJson(path.join(outDir, "locations", `${locationId}.json`), report);
    const schemaErrors = validateReportShape(report);
    if (schemaErrors.length) schemaFailures.push({ location_id: locationId, schema_errors: schemaErrors });

    const eligibleRows = rows.filter((row) => row.verify_eligible);
    for (const row of eligibleRows) {
      const match = findExpectedMatch(report, row);
      if (match?.status === "verified") verifiedMatches += 1;
      else missingExpected.push({
        location_id: locationId,
        expected_category: row.expected_category,
        expected_url: row.expected_url,
        acceptable_alternate_urls: row.acceptable_alternate_urls || [],
        actual_status: match?.status || "missing"
      });
    }

    const expectedKeys = expectedKeySet(rows);
    for (const proposal of report.proposed_location_updates || []) {
      const category = categoryForLocationField(proposal.field_name);
      const key = `${canonicalEvalCategory(category)}:${canonicalEvalUrl(proposal.proposed_value)}`;
      if (category && !expectedKeys.has(key) && proposal.action !== "noop") {
        falsePositives.push({
          location_id: locationId,
          proposal_type: "location_update",
          field_name: proposal.field_name,
          category,
          url: proposal.proposed_value
        });
      }
    }
    for (const proposal of report.proposed_touchpoint_events || []) {
      const key = `${canonicalEvalCategory(proposal.touchpoint_category)}:${canonicalEvalUrl(proposal.url)}`;
      if (!expectedKeys.has(key) && proposal.action !== "noop") {
        falsePositives.push({
          location_id: locationId,
          proposal_type: "touchpoint_event",
          touchpoint_category: proposal.touchpoint_category,
          url: proposal.url
        });
      }
    }

    for (const proposal of [...(report.proposed_location_updates || []), ...(report.proposed_touchpoint_events || [])]) {
      if (proposal.action !== "noop" && proposal.write_gate?.order_challenge_carveout) orderChallengeCarveoutCount += 1;
      if (proposal.action !== "noop" && proposal.verification?.status !== "verified") {
        writePlanSafetyViolations.push({ location_id: locationId, proposal });
      }
    }

    manualReviewCount += report.manual_review_items?.length || 0;
    idempotenceFailures.push(...checkIdempotence(args, locationId, report));
    locationSummaries.push({
      location_id: locationId,
      expected_rows: rows.length,
      verify_eligible_rows: eligibleRows.length,
      manual_review_items: report.manual_review_items?.length || 0,
      proposed_location_updates: report.proposed_location_updates?.filter((item) => item.action !== "noop").length || 0,
      proposed_touchpoint_events: report.proposed_touchpoint_events?.filter((item) => item.action !== "noop").length || 0
    });
  }

  const summary = {
    checked_at: new Date().toISOString(),
    suite: args.suite || (args["hide-existing"] ? "extraction-accuracy" : "idempotence"),
    commands: process.argv.join(" "),
    hide_existing: Boolean(args["hide-existing"]),
    replay: Boolean(args.replay),
    fixtures_dir: args["fixtures-dir"] || null,
    locations_tested: byLocation.size,
    locations_requested: requestedLocationIds.length || null,
    locations_skipped: locationsSkipped,
    expected_rows: expectations.length,
    verify_eligible_rows: expectations.filter((row) => row.verify_eligible).length,
    verified_matches: verifiedMatches,
    missing_expected_rows: missingExpected,
    false_positives: falsePositives,
    manual_review_count: manualReviewCount,
    order_challenge_carveout_count: orderChallengeCarveoutCount,
    write_plan_safety_violations: writePlanSafetyViolations,
    idempotence_failures: idempotenceFailures,
    missing_fixture_rows: missingFixtureRows,
    schema_failures: schemaFailures,
    location_summaries: locationSummaries
  };
  summary.failures = missingExpected.length + falsePositives.length + writePlanSafetyViolations.length + idempotenceFailures.length + missingFixtureRows.length + schemaFailures.length + locationsSkipped.length;
  writeJson(path.join(outDir, "evaluation-summary.json"), summary);
  fs.writeFileSync(path.join(outDir, "evaluation-summary.csv"), toCsv(flattenSummary(summary)), "utf8");
  return summary;
}

function findExpectedMatch(report, row) {
  const links = [
    ...(report.verified_links || []),
    ...(report.discovered_candidates || [])
  ];
  const categoryMatches = links.filter((link) => expectedCategoryMatches(row.expected_category, link.category));
  return categoryMatches.find((link) => expectedUrls(row).some((url) => sameUrl(link.input_url, url) || sameUrl(link.final_url, url))) || null;
}

function canonicalEvalCategory(category) {
  return category === "ordering" ? "order" : category;
}

function expectedCategoryMatches(expectedCategory, actualCategory) {
  const expected = canonicalEvalCategory(expectedCategory);
  const actual = canonicalEvalCategory(actualCategory);
  if (actual === expected) return true;
  return expected === "order" && actual === "menu";
}

function expectedKeySet(rows) {
  const keys = new Set();
  for (const row of rows) {
    for (const url of expectedCanonicalUrls(row)) {
      const category = canonicalEvalCategory(row.expected_category);
      keys.add(`${category}:${url}`);
      if (category === "order") keys.add(`menu:${url}`);
    }
  }
  return keys;
}

function categoryForLocationField(fieldName) {
  const fieldMap = {
    "branding.instagram_url": "instagram",
    "branding.facebook_url": "facebook",
    "branding.tiktok_url": "tiktok",
    "branding.youtube_url": "youtube",
    "branding.x_url": "x_twitter",
    "branding.apple_app_url": "ios_app",
    "branding.google_app_url": "android_app",
    "locations.ordering_url": "order"
  };
  return fieldMap[fieldName] || null;
}

function checkIdempotence(args, locationId, report) {
  if (args["hide-existing"] || !args["fixtures-dir"]) return [];
  const expectedPath = path.join(args["fixtures-dir"], locationId, "expected-category-status.json");
  if (!fs.existsSync(expectedPath)) return [];
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const failures = [];
  const byCategory = new Map((report.category_results || []).map((result) => [result.category, result]));
  for (const category of CATEGORY_SET) {
    const result = byCategory.get(category);
    if (!result) failures.push({ location_id: locationId, category, reason: "missing_category_result" });
    if (expected[category] && result?.category_status !== expected[category]) {
      failures.push({ location_id: locationId, category, expected: expected[category], actual: result?.category_status || null });
    }
  }
  for (const proposal of [...(report.proposed_location_updates || []), ...(report.proposed_touchpoint_events || [])]) {
    if (proposal.action !== "noop") failures.push({ location_id: locationId, reason: "idempotence_non_noop_proposal", proposal });
  }
  return failures;
}

function validateReportShape(report) {
  const errors = [];
  for (const key of ["checked_at", "location_context", "discovery_limits", "existing_links", "discovered_candidates", "verified_links", "category_results", "proposed_location_updates", "proposed_touchpoint_events", "rejected_candidates", "manual_review_items", "summary"]) {
    if (!(key in report)) errors.push(`missing_${key}`);
  }
  const categoryCounts = new Map();
  for (const result of report.category_results || []) {
    categoryCounts.set(result.category, (categoryCounts.get(result.category) || 0) + 1);
    if (!CATEGORY_SET.includes(result.category)) errors.push(`unknown_category_${result.category}`);
    if ((result.category_status === "needs_manual_review" || result.category_status === "existing_needs_manual_review")
      && !(report.manual_review_items || []).some((item) => item.category === result.category)) {
      errors.push(`manual_review_missing_item_${result.category}`);
    }
  }
  for (const category of CATEGORY_SET) {
    if ((categoryCounts.get(category) || 0) !== 1) errors.push(`category_count_${category}_${categoryCounts.get(category) || 0}`);
  }
  return errors;
}

function flattenSummary(summary) {
  if (summary.missing_expected_rows.length) return summary.missing_expected_rows;
  return summary.location_summaries;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","))].join("\n") + "\n";
}

function csvEscape(value) {
  const s = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll("\"", "\"\"")}"` : s;
}

function groupBy(rows, fn) {
  const out = new Map();
  for (const row of rows) {
    const key = fn(row);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

function csvArgSet(value) {
  if (!value) return null;
  const values = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? new Set(values) : null;
}

function sameUrl(a, b) {
  return sameEvalUrl(a, b);
}

function expectedUrls(row) {
  return [row.expected_url, ...(row.acceptable_alternate_urls || [])].filter(Boolean);
}

function expectedCanonicalUrls(row) {
  return [row.expected_canonical_url, ...(row.acceptable_alternate_canonical_urls || [])].filter(Boolean);
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

export { evaluateSuccessCases };
