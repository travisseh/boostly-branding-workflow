#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_SET, CLAUDE_CHROME_PROVIDER, FULFILLMENT_BROWSER_PROVIDERS } from "./discover-links.mjs";

const REQUIRED_TOP_LEVEL_KEYS = [
  "checked_at",
  "location_context",
  "discovery_limits",
  "existing_links",
  "discovered_candidates",
  "verified_links",
  "category_results",
  "proposed_location_updates",
  "proposed_touchpoint_events",
  "rejected_candidates",
  "manual_review_items",
  "summary",
];

const WRITE_ACTIONS = new Set(["create", "update", "replace"]);
// --require-browser-provider accepts one provider name (unchanged), a comma-separated list
// ("codex-extension,claude-chrome"), or the alias "fulfillment" (added 2026-09-29), which means
// any provider in FULFILLMENT_BROWSER_PROVIDERS and also requires fulfillment_mode true,
// preflight true, and the Boostly.com Chrome profile. Playwright and static reports fail it.
const ANY_FULFILLMENT_PROVIDER = "fulfillment";
const FULFILLMENT_CHROME_PROFILE = "Boostly.com";
// Soft-404 wording widened 2026-09-22 (cbgnevada.com/order/<slug>: HTTP 200/404 body "Oops. This page does not exist!").
const NEGATIVE_WRITE_EVIDENCE = /(?:^|\b)(?:404|410|page not found|not found|page isn['’]?t available|doesn['’]?t exist|does not exist|no longer exists?|no longer available|we can['’]?t find|oops|unavailable|error page)(?:\b|$)|soft_not_found_page_detected=true|platform_unavailable_page_detected=true|security_or_bot_challenge_detected=true|fetch_timeout_soft=true|http_status=(?:4\d\d|5\d\d)/i;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = validateReportFile(args.report, {
      expectedLocationId: args["location-id"],
      requiredBrowserProvider: args["require-browser-provider"],
      requiredChromeProfile: args["require-chrome-profile"],
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      valid: false,
      report_path: args.report || null,
      errors: error.validationErrors || [error.message],
    }, null, 2));
    process.exitCode = 2;
  }
}

function validateReportFile(reportPath, options = {}) {
  if (!reportPath) throw new Error("--report is required");

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read discovery report: ${error.message}`);
  }

  const errors = validateDiscoveryReport(report, options);
  if (errors.length > 0) {
    const error = new Error(`Discovery report validation failed with ${errors.length} error(s)`);
    error.validationErrors = errors;
    throw error;
  }

  return {
    valid: true,
    report_path: path.resolve(reportPath),
    location_id: report.location_context.location_id,
    categories_total: report.category_results.length,
  };
}

function validateDiscoveryReport(report, {
  expectedLocationId,
  requiredBrowserProvider,
  requiredChromeProfile,
} = {}) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["report_must_be_an_object"];
  }

  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in report)) errors.push(`missing_top_level_key:${key}`);
  }

  errors.push(...validateBrowserRuntime(report.runtime, {
    requiredBrowserProvider,
    requiredChromeProfile,
  }));

  // A diagnostics-only website override never reaches production; a fulfillment report must
  // come from a location whose website_url was really bootstrapped or already configured.
  if ((report.runtime?.fulfillment_mode === true || requiredBrowserProvider) &&
    report.website_bootstrap?.reason === "website_url_override_unwritten") {
    errors.push("website_url_override_unwritten");
  }

  const locationId = report.location_context?.location_id;
  if (typeof locationId !== "string" || locationId.length === 0) {
    errors.push("missing_location_context.location_id");
  } else if (expectedLocationId && locationId !== expectedLocationId) {
    errors.push(`location_id_mismatch:expected=${expectedLocationId}:actual=${locationId}`);
  }

  if (!Array.isArray(report.category_results)) {
    errors.push("category_results_must_be_an_array");
    return errors;
  }

  const categoryCounts = new Map();
  for (const [index, result] of report.category_results.entries()) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      errors.push(`category_result_${index}_must_be_an_object`);
      continue;
    }

    const category = result.category;
    if (!CATEGORY_SET.includes(category)) {
      errors.push(`unknown_category:${String(category)}`);
      continue;
    }

    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    if (typeof result.category_status !== "string" || result.category_status.length === 0) {
      errors.push(`missing_category_status:${category}`);
    }
    if (typeof result.proposed_action !== "string" || result.proposed_action.length === 0) {
      errors.push(`missing_proposed_action:${category}`);
    }

    errors.push(...validateWriteAction(result, category));
  }

  for (const category of CATEGORY_SET) {
    const count = categoryCounts.get(category) || 0;
    if (count !== 1) errors.push(`category_count:${category}:${count}`);
  }

  return errors;
}

function resolveRequiredProviders(requiredBrowserProvider) {
  const names = (Array.isArray(requiredBrowserProvider) ? requiredBrowserProvider : String(requiredBrowserProvider ?? "").split(","))
    .map((name) => String(name).trim())
    .filter(Boolean);
  const anyFulfillment = names.includes(ANY_FULFILLMENT_PROVIDER);
  const accepted = [...new Set(names.flatMap((name) => (name === ANY_FULFILLMENT_PROVIDER ? FULFILLMENT_BROWSER_PROVIDERS : [name])))];
  return { accepted, anyFulfillment };
}

function validateBrowserRuntime(runtime, {
  requiredBrowserProvider,
  requiredChromeProfile,
} = {}) {
  const { accepted: acceptedProviders, anyFulfillment } = resolveRequiredProviders(requiredBrowserProvider);
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    return acceptedProviders.length > 0 || requiredChromeProfile ? ["runtime_must_be_an_object"] : [];
  }

  const errors = [];
  const provider = runtime.browser_provider;
  if (typeof provider !== "string" || provider.length === 0) {
    errors.push("missing_runtime.browser_provider");
  }
  if (typeof runtime.fulfillment_mode !== "boolean") {
    errors.push("missing_runtime.fulfillment_mode");
  }
  if (typeof runtime.browser_provider_preflighted !== "boolean") {
    errors.push("missing_runtime.browser_provider_preflighted");
  }

  if (runtime.fulfillment_mode === true && !FULFILLMENT_BROWSER_PROVIDERS.includes(provider)) {
    errors.push(`fulfillment_browser_provider_mismatch:expected=${FULFILLMENT_BROWSER_PROVIDERS.join("|")}:actual=${String(provider)}`);
  }
  // claude-chrome: the report is final only when every browser escalation has a recorded
  // result. A manifest-only pass leaves browser_needed populated and is never fulfillable.
  if (provider === CLAUDE_CHROME_PROVIDER && (runtime.fulfillment_mode === true || acceptedProviders.includes(CLAUDE_CHROME_PROVIDER))) {
    if (!Array.isArray(runtime.browser_needed)) {
      errors.push("missing_runtime.browser_needed");
    } else if (runtime.browser_needed.length > 0) {
      errors.push(`browser_results_pending:${runtime.browser_needed.length}`);
    }
  }
  if (runtime.fulfillment_mode === true && runtime.browser_provider_preflighted !== true) {
    errors.push("fulfillment_browser_provider_not_preflighted");
  }
  if (acceptedProviders.length > 0 && !acceptedProviders.includes(provider)) {
    errors.push(`browser_provider_mismatch:expected=${acceptedProviders.join("|")}:actual=${String(provider)}`);
  }
  if (requiredChromeProfile && runtime.chrome_profile_resolved !== requiredChromeProfile) {
    errors.push(`chrome_profile_mismatch:expected=${requiredChromeProfile}:actual=${String(runtime.chrome_profile_resolved)}`);
  }
  if (anyFulfillment) {
    // The alias is the write gate: it never passes a report that was not a live fulfillment run.
    if (runtime.fulfillment_mode !== true) errors.push("fulfillment_mode_required");
    if (runtime.browser_provider_preflighted !== true && !errors.includes("fulfillment_browser_provider_not_preflighted")) {
      errors.push("fulfillment_browser_provider_not_preflighted");
    }
    if (requiredChromeProfile !== FULFILLMENT_CHROME_PROFILE && runtime.chrome_profile_resolved !== FULFILLMENT_CHROME_PROFILE) {
      errors.push(`chrome_profile_mismatch:expected=${FULFILLMENT_CHROME_PROFILE}:actual=${String(runtime.chrome_profile_resolved)}`);
    }
  }
  return errors;
}

function validateWriteAction(result, category) {
  if (!WRITE_ACTIONS.has(result.proposed_action)) return [];

  const selected = result.selected_link;
  if (!selected || typeof selected !== "object") {
    return [`write_action_missing_selected_link:${category}`];
  }

  const errors = [];
  if (selected.status !== "verified") errors.push(`write_action_selected_link_not_verified:${category}`);
  if (selected.liveness !== "live") errors.push(`write_action_selected_link_not_live:${category}`);
  if (selected.relevance !== "match") errors.push(`write_action_selected_link_not_relevant:${category}`);
  if (typeof selected.final_url !== "string" || !/^https?:\/\//.test(selected.final_url)) {
    errors.push(`write_action_missing_http_url:${category}`);
  }
  if (hasNegativeWriteEvidence(selected)) errors.push(`write_action_has_negative_evidence:${category}`);
  if (category === "events" && !hasUpcomingEventEvidence(selected)) {
    errors.push("write_action_events_missing_upcoming_event_evidence");
  }
  return errors;
}

function hasUpcomingEventEvidence(selected) {
  const timing = selected.event_timing;
  if (!(timing?.has_upcoming_event === true &&
    Array.isArray(selected.event_timing?.upcoming_event_dates) &&
    selected.event_timing.upcoming_event_dates.length > 0)) return false;
  if (timing.source !== "gpt-5.6-luna") return true;
  const review = timing.luna_review;
  return review?.status === "accepted" &&
    review.model === "gpt-5.6-luna" &&
    review.verdict === "upcoming_events_verified" &&
    typeof review.confidence === "number" && review.confidence >= 0.9 && review.confidence <= 1 &&
    typeof review.evidence_hash === "string" && /^[a-f0-9]{64}$/.test(review.evidence_hash) &&
    Array.isArray(review.events) &&
    review.events.some((event) => /^\d{4}-\d{2}-\d{2}$/.test(String(event?.normalized_start_date || "")));
}

function hasNegativeWriteEvidence(selected) {
  const evidence = [
    ...asArray(selected.validity_evidence),
    ...asArray(selected.location_match_evidence),
    selected.rejection_reason,
    selected.page_evidence?.title,
    ...asArray(selected.page_evidence?.h1),
    selected.page_evidence?.error,
  ].filter(Boolean).join(" ");
  return NEGATIVE_WRITE_EVIDENCE.test(evidence);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

export {
  ANY_FULFILLMENT_PROVIDER,
  hasNegativeWriteEvidence,
  REQUIRED_TOP_LEVEL_KEYS,
  validateBrowserRuntime,
  validateDiscoveryReport,
  validateReportFile,
};
