#!/usr/bin/env node

import assert from "node:assert/strict";
import { CATEGORY_SET } from "./discover-links.mjs";
import { validateDiscoveryReport } from "./validate-discovery-report.mjs";

function validReport() {
  return {
    checked_at: "2026-07-13T20:21:12.283Z",
    location_context: { location_id: "location-1" },
    runtime: {
      fulfillment_mode: true,
      browser_provider: "codex-extension",
      required_browser_provider: "codex-extension",
      browser_provider_preflighted: true,
      chrome_profile_requested: "Boostly.com",
      chrome_profile_resolved: "Boostly.com",
    },
    discovery_limits: {},
    existing_links: [],
    discovered_candidates: [],
    verified_links: [],
    category_results: CATEGORY_SET.map((category) => ({
      category,
      category_status: "not_found",
      proposed_action: "noop",
      selected_link: null,
    })),
    proposed_location_updates: [],
    proposed_touchpoint_events: [],
    rejected_candidates: [],
    manual_review_items: [],
    summary: {},
  };
}

function addWriteCandidate(report, category, selectedLink = {}) {
  const result = report.category_results.find((item) => item.category === category);
  result.category_status = "found_verified";
  result.proposed_action = "create";
  result.selected_link = selectedLink === null ? null : {
    status: "verified",
    liveness: "live",
    relevance: "match",
    final_url: `https://example.com/${category}`,
    ...selectedLink,
  };
  return result;
}

const valid = validReport();
addWriteCandidate(valid, "careers_jobs", {
  final_url: "https://example.com/join-our-team",
});
assert.deepEqual(validateDiscoveryReport(valid, { expectedLocationId: "location-1" }), []);
assert.deepEqual(validateDiscoveryReport(valid, {
  requiredBrowserProvider: "codex-extension",
  requiredChromeProfile: "Boostly.com",
}), []);

const playwrightFulfillment = validReport();
playwrightFulfillment.runtime.browser_provider = "playwright";
playwrightFulfillment.runtime.browser_provider_preflighted = false;
assert(
  validateDiscoveryReport(playwrightFulfillment).includes(
    "fulfillment_browser_provider_mismatch:expected=codex-extension|claude-chrome:actual=playwright",
  ),
);

const wrongChromeProfile = validReport();
wrongChromeProfile.runtime.chrome_profile_resolved = "Travisse";
assert(
  validateDiscoveryReport(wrongChromeProfile, { requiredChromeProfile: "Boostly.com" }).includes(
    "chrome_profile_mismatch:expected=Boostly.com:actual=Travisse",
  ),
);

const missingRuntime = validReport();
delete missingRuntime.runtime;
assert(
  validateDiscoveryReport(missingRuntime, { requiredBrowserProvider: "codex-extension" }).includes(
    "runtime_must_be_an_object",
  ),
);

const eventsWithoutFutureDate = validReport();
addWriteCandidate(eventsWithoutFutureDate, "events", {
  final_url: "https://example.com/events",
  event_timing: {
    has_upcoming_event: false,
    upcoming_event_dates: [],
  },
});
assert(
  validateDiscoveryReport(eventsWithoutFutureDate).includes(
    "write_action_events_missing_upcoming_event_evidence",
  ),
);

const eventsWithFutureDate = validReport();
addWriteCandidate(eventsWithFutureDate, "events", {
  final_url: "https://example.com/events",
  event_timing: {
    has_upcoming_event: true,
    upcoming_event_dates: ["2099-08-12T19:00:00-06:00"],
  },
});
assert.deepEqual(validateDiscoveryReport(eventsWithFutureDate), []);

const eventsWithLunaDate = validReport();
addWriteCandidate(eventsWithLunaDate, "events", {
  final_url: "https://example.com/events",
  event_timing: {
    source: "gpt-5.6-luna",
    has_upcoming_event: true,
    upcoming_event_dates: ["2026-08-04"],
    luna_review: {
      status: "accepted",
      model: "gpt-5.6-luna",
      verdict: "upcoming_events_verified",
      confidence: 0.99,
      evidence_hash: "a".repeat(64),
      events: [{ normalized_start_date: "2026-08-04" }],
    },
  },
});
assert.deepEqual(validateDiscoveryReport(eventsWithLunaDate), []);

const eventsWithInvalidLunaDate = structuredClone(eventsWithLunaDate);
eventsWithInvalidLunaDate.category_results.find((item) => item.category === "events").selected_link.event_timing.luna_review.evidence_hash = "bad";
assert(
  validateDiscoveryReport(eventsWithInvalidLunaDate).includes(
    "write_action_events_missing_upcoming_event_evidence",
  ),
);

const missingCareers = validReport();
missingCareers.category_results = missingCareers.category_results.filter(
  (result) => result.category !== "careers_jobs",
);
assert(validateDiscoveryReport(missingCareers).includes("category_count:careers_jobs:0"));

const duplicateCareers = validReport();
duplicateCareers.category_results.push({
  category: "careers_jobs",
  category_status: "not_found",
  proposed_action: "noop",
  selected_link: null,
});
assert(validateDiscoveryReport(duplicateCareers).includes("category_count:careers_jobs:2"));

const unsafeWrite = validReport();
addWriteCandidate(unsafeWrite, "careers_jobs", null);
assert(
  validateDiscoveryReport(unsafeWrite).includes(
    "write_action_missing_selected_link:careers_jobs",
  ),
);

const unsafeEvidenceCases = [
  ["soft 404", "events", "live", "title=404: Page not found"],
  ["soft 404 body, does not exist", "ordering", "live", "soft_not_found_page_detected=true"],
  ["soft 404 title, page not found", "order", "live", "title=Page not found"],
  ["soft 404 wording, we can't find", "menu", "live", "title=We can't find that page"],
  ["soft 404 wording, no longer available", "catering", "live", "h1=This page is no longer available"],
  ["platform unavailable", "facebook", "live", "platform_unavailable_page_detected=true"],
  ["bot challenge", "menu", "challenge", "security_or_bot_challenge_detected=true"],
  ["timeout", "careers_jobs", "challenge", "fetch_timeout_soft=true"],
  ["HTTP error", "catering", "broken", "http_status=503"],
];

for (const [name, category, liveness, evidence] of unsafeEvidenceCases) {
  const report = validReport();
  addWriteCandidate(report, category, {
    liveness,
    validity_evidence: [evidence],
  });
  const errors = validateDiscoveryReport(report);
  assert(errors.includes(`write_action_has_negative_evidence:${category}`), name);
  if (liveness !== "live") {
    assert(errors.includes(`write_action_selected_link_not_live:${category}`), name);
  }
}

assert(
  validateDiscoveryReport(validReport(), { expectedLocationId: "wrong-location" }).some(
    (error) => error.startsWith("location_id_mismatch:"),
  ),
);

// The exact cbgnevada.com body (2026-09-22): a 200 with "Oops. This page does not exist!" can never be written.
const cbgnevada = validReport();
addWriteCandidate(cbgnevada, "ordering", {
  final_url: "https://cbgnevada.com/order/chuys-baja-grill-henderson-2560-saint-rose-parkway-suite-150",
  validity_evidence: ["http_status=200"],
  page_evidence: { http_status: 200, title: "Page not found", h1: ["Oops. This page does not exist!"], text_sample: "Oops. This page does not exist! Home" },
});
assert(validateDiscoveryReport(cbgnevada).includes("write_action_has_negative_evidence:ordering"), "cbgnevada oops body");
const cbgnevadaH1Only = validReport();
addWriteCandidate(cbgnevadaH1Only, "ordering", {
  validity_evidence: ["http_status=200", "title=CHUY\u2019S"],
  page_evidence: { http_status: 200, title: "CHUY\u2019S", h1: ["Oops. This page does not exist!"] },
});
assert(validateDiscoveryReport(cbgnevadaH1Only).includes("write_action_has_negative_evidence:ordering"), "cbgnevada oops H1 only");

// 2026-09-29: the write gate accepts EITHER live-session provider (a list or the "fulfillment"
// alias), always with the Boostly.com profile and preflight true. Playwright and static fail.
const BOTH = "codex-extension,claude-chrome";
const gate = { requiredBrowserProvider: "fulfillment", requiredChromeProfile: "Boostly.com" };
const codexReport = validReport();
assert.deepEqual(validateDiscoveryReport(codexReport, gate), []);
assert.deepEqual(validateDiscoveryReport(codexReport, { requiredBrowserProvider: BOTH, requiredChromeProfile: "Boostly.com" }), []);
assert.deepEqual(validateDiscoveryReport(codexReport, { requiredBrowserProvider: ["codex-extension", "claude-chrome"] }), []);

const claudeReport = validReport();
claudeReport.runtime.browser_provider = "claude-chrome";
claudeReport.runtime.required_browser_provider = "claude-chrome";
claudeReport.runtime.browser_needed = [];
assert.deepEqual(validateDiscoveryReport(claudeReport, gate), []);
assert.deepEqual(validateDiscoveryReport(claudeReport, { requiredBrowserProvider: BOTH, requiredChromeProfile: "Boostly.com" }), []);

// A claude-chrome report with browser results pending still fails under the list and the alias.
const claudePending = structuredClone(claudeReport);
claudePending.runtime.browser_needed = [{ url: "https://example.com/", kind: "website" }];
assert(validateDiscoveryReport(claudePending, gate).includes("browser_results_pending:1"));
assert(validateDiscoveryReport(claudePending, { requiredBrowserProvider: BOTH }).includes("browser_results_pending:1"));

// The single-provider form is unchanged: a codex report fails a claude-chrome requirement.
assert(
  validateDiscoveryReport(codexReport, { requiredBrowserProvider: "claude-chrome" }).includes(
    "browser_provider_mismatch:expected=claude-chrome:actual=codex-extension",
  ),
);

for (const provider of ["playwright", "static", "local-chrome"]) {
  const report = validReport();
  report.runtime.browser_provider = provider;
  for (const required of ["fulfillment", BOTH]) {
    const errors = validateDiscoveryReport(report, { requiredBrowserProvider: required, requiredChromeProfile: "Boostly.com" });
    assert(errors.includes(`browser_provider_mismatch:expected=codex-extension|claude-chrome:actual=${provider}`), `${provider} under ${required}`);
  }
  // Even when the report does not claim fulfillment mode, the gate refuses the provider.
  const diagnostics = structuredClone(report);
  diagnostics.runtime.fulfillment_mode = false;
  diagnostics.runtime.browser_provider_preflighted = false;
  const errors = validateDiscoveryReport(diagnostics, gate);
  assert(errors.includes(`browser_provider_mismatch:expected=codex-extension|claude-chrome:actual=${provider}`), `${provider} diagnostics`);
  assert(errors.includes("fulfillment_mode_required"), `${provider} fulfillment mode`);
}

// The alias always requires preflight, fulfillment mode, and the Boostly.com profile, even
// when --require-chrome-profile is omitted or names another profile.
const notPreflighted = validReport();
notPreflighted.runtime.browser_provider_preflighted = false;
assert(validateDiscoveryReport(notPreflighted, gate).includes("fulfillment_browser_provider_not_preflighted"));
const notFulfillment = validReport();
notFulfillment.runtime.fulfillment_mode = false;
assert(validateDiscoveryReport(notFulfillment, gate).includes("fulfillment_mode_required"));
const otherProfile = validReport();
otherProfile.runtime.chrome_profile_resolved = "Travisse";
assert(
  validateDiscoveryReport(otherProfile, { requiredBrowserProvider: "fulfillment" }).includes(
    "chrome_profile_mismatch:expected=Boostly.com:actual=Travisse",
  ),
);
assert(
  validateDiscoveryReport(otherProfile, { requiredBrowserProvider: "fulfillment", requiredChromeProfile: "Travisse" }).includes(
    "chrome_profile_mismatch:expected=Boostly.com:actual=Travisse",
  ),
);
const missingRuntimeUnderGate = validReport();
delete missingRuntimeUnderGate.runtime;
assert(validateDiscoveryReport(missingRuntimeUnderGate, gate).includes("runtime_must_be_an_object"));

console.log("validate-discovery-report: ok");
