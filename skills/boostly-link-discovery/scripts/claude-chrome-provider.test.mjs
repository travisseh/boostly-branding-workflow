#!/usr/bin/env node
// claude-chrome provider: manifest-only pass, results resume, profile guard, validator rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BROWSER_MANIFEST_FORMAT,
  CLAUDE_CHROME_PROVIDER,
  FixtureStore,
  browserResultKey,
  loadBrowserResults,
  resolveBrowserManifestPath,
  resolveBrowserRuntime,
} from "./discover-links.mjs";
import { addResult, assemblePageParts, initResults, pendingUrls } from "./claude-chrome-browser.mjs";
import { CLAUDE_CHROME_CHUNK_SIZE, claudeChromeChecksum, claudeChromeChunkReadSource, claudeChromeExtractorSource, compactRenderedPage } from "../../boostly-link-verifier/lib/verify-core.mjs";
import { validateBrowserRuntime, validateDiscoveryReport } from "./validate-discovery-report.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claude-chrome-"));
const samplePage = {
  title: "Dogwood Pizza | Lawrenceville",
  meta: { "og:site_name": "Dogwood Pizza" },
  h1: ["Dogwood Pizza"],
  h2: [],
  text: "Dogwood Pizza 850 Dogwood Rd Lawrenceville GA order online",
  links: ["https://order.toasttab.com/online/dogwoodpizza", "https://www.instagram.com/dogwoodpizza/"],
  labeled_links: [{ href: "https://order.toasttab.com/online/dogwoodpizza", label: "Order Online", source: "anchor" }],
  action_labels: ["Order Online"],
};

test("fulfillment mode accepts claude-chrome and requires it once chosen", () => {
  const runtime = resolveBrowserRuntime({ fulfillmentMode: true, "browser-provider": CLAUDE_CHROME_PROVIDER });
  assert.equal(runtime.requiredBrowserProvider, CLAUDE_CHROME_PROVIDER);
  assert.throws(
    () => resolveBrowserRuntime({ fulfillmentMode: true, "browser-provider": "playwright", requiredBrowserProvider: CLAUDE_CHROME_PROVIDER }),
    /fulfillment requires 'claude-chrome'/,
  );
  // The codex path is untouched.
  assert.equal(resolveBrowserRuntime({ fulfillmentMode: true, "browser-provider": "codex-extension" }).requiredBrowserProvider, "codex-extension");
});

test("manifest path defaults next to --out", () => {
  assert.equal(resolveBrowserManifestPath({ out: "/x/y/report.json" }), "/x/y/browser-needed.json");
  assert.equal(resolveBrowserManifestPath({ "browser-manifest": "/m.json", out: "/x/y/report.json" }), "/m.json");
  assert.equal(resolveBrowserManifestPath({}), "");
});

test("manifest-only pass records every missing url and writes the manifest with the extractor", async () => {
  const dir = tmp();
  const manifestFile = path.join(dir, "browser-needed.json");
  const store = new FixtureStore("", "loc-1", {
    browserProvider: CLAUDE_CHROME_PROVIDER,
    chromeProfile: "boostly",
    browserManifestFile: manifestFile,
  });
  await store.preflightBrowserProvider();
  assert.equal(store.browserProviderPreflighted, false);
  assert.equal(store.requestedChromeProfileName, "Boostly.com");
  assert.equal(store.chromeProfileResolved(), null);

  const page = await store.getPage();
  store.currentFetchKind = "website";
  await assert.rejects(() => page.goto("https://www.dogwood.pizza/"), /claude_chrome_result_missing/);
  store.currentFetchKind = "candidate";
  await assert.rejects(() => page.goto("https://www.dogwood.pizza"), /claude_chrome_result_missing/); // same key, deduped
  await assert.rejects(() => page.goto("https://order.toasttab.com/online/dogwoodpizza"), /claude_chrome_result_missing/);

  const runtime = store.claudeChromeRuntime("loc-1");
  assert.equal(runtime.browser_results_file, null);
  assert.equal(runtime.browser_results_count, 0);
  assert.deepEqual(runtime.browser_needed.map((entry) => entry.url), ["https://www.dogwood.pizza/", "https://order.toasttab.com/online/dogwoodpizza"]);
  assert.equal(runtime.browser_needed[0].kind, "website");
  assert.equal(runtime.browser_manifest_file, manifestFile);

  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.format, BROWSER_MANIFEST_FORMAT);
  assert.equal(manifest.chrome_profile_required, "Boostly.com");
  assert.equal(manifest.location_id, "loc-1");
  assert.equal(manifest.urls.length, 2);
  assert.match(manifest.extractor_js, /^\(function \(\) \{/);
  assert.match(manifest.extractor_js, /window\.__boostlyPage = JSON\.stringify\(compact\)/);
  assert.match(manifest.extractor_js, /function renderedPageExtractor\(\)/);
  assert.match(manifest.extractor_js, /function compactRenderedPage\(page\)/);
  assert.equal(manifest.chunk_size, CLAUDE_CHROME_CHUNK_SIZE);
  assert.equal(manifest.chunk_read_js, `window.__boostlyPage.slice(INDEX * ${CLAUDE_CHROME_CHUNK_SIZE}, (INDEX + 1) * ${CLAUDE_CHROME_CHUNK_SIZE})`);
  await store.close();
});

test("results file resumes discovery: preflighted, profile resolved, adapter serves recorded pages", async () => {
  const dir = tmp();
  const resultsFile = path.join(dir, "browser-results.json");
  initResults(resultsFile, { profile: "Boostly.com" });
  assert.throws(() => initResults(resultsFile, { profile: "Boostly.com" }), /already exists/);
  const added = addResult(resultsFile, { url: "https://www.dogwood.pizza", finalUrl: "https://www.dogwood.pizza/", httpStatus: 200, page: samplePage });
  assert.equal(added.count, 1);
  assert.equal(added.key, browserResultKey("https://www.dogwood.pizza/"));

  const store = new FixtureStore("", "loc-1", {
    browserProvider: CLAUDE_CHROME_PROVIDER,
    chromeProfile: "boostly",
    browserResultsFile: resultsFile,
    browserManifestFile: path.join(dir, "browser-needed.json"),
  });
  await store.preflightBrowserProvider();
  assert.equal(store.browserProviderPreflighted, true);
  assert.equal(store.chromeProfileResolved(), "Boostly.com");
  assert.equal(store.usesCustomBrowserProvider(), true);

  const page = await store.getPage();
  const response = await page.goto("https://www.dogwood.pizza/");
  assert.equal(response.status(), 200);
  assert.equal(await page.url(), "https://www.dogwood.pizza/");
  assert.deepEqual(await page.evaluate(() => {}), samplePage);
  await assert.rejects(() => page.goto("https://www.dogwood.pizza/careers"), /claude_chrome_result_missing/);

  const runtime = store.claudeChromeRuntime("loc-1");
  assert.equal(runtime.browser_results_count, 1);
  assert.deepEqual(runtime.browser_needed.map((entry) => entry.url), ["https://www.dogwood.pizza/careers"]);

  const pending = pendingUrls(runtime.browser_manifest_file, resultsFile);
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.recorded, 0);
  await store.close();
});

test("results captured in another Chrome profile are refused", async () => {
  const dir = tmp();
  const resultsFile = path.join(dir, "browser-results.json");
  initResults(resultsFile, { profile: "Travisse" });
  const store = new FixtureStore("", "loc-1", {
    browserProvider: CLAUDE_CHROME_PROVIDER,
    chromeProfile: "boostly",
    browserResultsFile: resultsFile,
  });
  await assert.rejects(() => store.preflightBrowserProvider(), /captured in profile 'Travisse', required 'Boostly.com'/);
});

test("malformed results are rejected by the loader and the helper", () => {
  const dir = tmp();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ format: "nope" }));
  assert.throws(() => loadBrowserResults(bad), /is not a boostly-link-discovery.claude-chrome-results.v1 file/);
  const resultsFile = path.join(dir, "results.json");
  initResults(resultsFile, { profile: "Boostly.com" });
  assert.throws(() => addResult(resultsFile, { url: "https://a.example", page: { title: "x" } }), /missing extractor keys/);
  assert.throws(() => addResult(resultsFile, { url: "", page: samplePage }), /--url is required/);
});

test("validator: claude-chrome fulfillment report needs empty browser_needed and a preflight", () => {
  const base = {
    fulfillment_mode: true,
    browser_provider: CLAUDE_CHROME_PROVIDER,
    required_browser_provider: CLAUDE_CHROME_PROVIDER,
    browser_provider_preflighted: true,
    chrome_profile_requested: "Boostly.com",
    chrome_profile_resolved: "Boostly.com",
    browser_needed: [],
  };
  const options = { requiredBrowserProvider: CLAUDE_CHROME_PROVIDER, requiredChromeProfile: "Boostly.com" };
  assert.deepEqual(validateBrowserRuntime(base, options), []);
  assert.deepEqual(
    validateBrowserRuntime({ ...base, browser_needed: [{ url: "https://a" }, { url: "https://b" }] }, options),
    ["browser_results_pending:2"],
  );
  assert.deepEqual(validateBrowserRuntime({ ...base, browser_needed: undefined }, options), ["missing_runtime.browser_needed"]);
  assert.deepEqual(
    validateBrowserRuntime({ ...base, browser_provider_preflighted: false }, options),
    ["fulfillment_browser_provider_not_preflighted"],
  );
  assert.deepEqual(
    validateBrowserRuntime({ ...base, chrome_profile_resolved: "Travisse" }, options),
    ["chrome_profile_mismatch:expected=Boostly.com:actual=Travisse"],
  );
  // A codex-extension report is still accepted by the fulfillment check.
  assert.deepEqual(validateBrowserRuntime({ ...base, browser_provider: "codex-extension", browser_needed: undefined }, { requiredBrowserProvider: "codex-extension" }), []);
});

test("validator: a diagnostics website override is refused for fulfillment", () => {
  const report = {
    checked_at: "2026-09-21T00:00:00.000Z",
    location_context: { location_id: "loc-1" },
    website_bootstrap: { attempted: false, reason: "website_url_override_unwritten", override_url: "https://www.dogwood.pizza/" },
    runtime: {
      fulfillment_mode: true,
      browser_provider: CLAUDE_CHROME_PROVIDER,
      browser_provider_preflighted: true,
      chrome_profile_resolved: "Boostly.com",
      browser_needed: [],
    },
    discovery_limits: {},
    existing_links: [],
    discovered_candidates: [],
    verified_links: [],
    category_results: [],
    proposed_location_updates: [],
    proposed_touchpoint_events: [],
    rejected_candidates: [],
    manual_review_items: [],
    summary: {},
  };
  const errors = validateDiscoveryReport(report, { expectedLocationId: "loc-1", requiredBrowserProvider: CLAUDE_CHROME_PROVIDER });
  assert.ok(errors.includes("website_url_override_unwritten"), errors.join(","));
  report.website_bootstrap = { attempted: false, reason: "website_already_configured" };
  assert.ok(!validateDiscoveryReport(report, { expectedLocationId: "loc-1", requiredBrowserProvider: CLAUDE_CHROME_PROVIDER }).includes("website_url_override_unwritten"));
});

test("compaction strips query strings, allow-lists meta, drops script-url labels, and bounds sizes", () => {
  const compact = compactRenderedPage({
    title: "Home - Dogwood Pizza",
    meta: { "google-site-verification": "token-like-value", "og:site_name": "Dogwood Pizza", "csrf-token": "abc" },
    h1: ["DOGWOOD PIZZA"],
    h2: [],
    text: "x".repeat(5000),
    links: ["https://order.toasttab.com/online/dogwoodpizza?utm_source=site", "https://order.toasttab.com/online/dogwoodpizza", "https://www.dogwood.pizza/menu#top"],
    labeled_links: [
      { href: "https://order.toasttab.com/online/dogwoodpizza?utm_source=site", label: "Order Online " + "y".repeat(100), source: "anchor" },
      { href: "https://cdn.example/x.js?v=1", label: "", source: "script-url" },
    ],
    action_labels: ["Order Online"],
    event_dates: [],
  });
  assert.deepEqual(Object.keys(compact.meta), ["og:site_name"]);
  assert.deepEqual(compact.links, ["https://order.toasttab.com/online/dogwoodpizza", "https://www.dogwood.pizza/menu#top"]);
  assert.equal(compact.labeled_links.length, 1);
  assert.equal(compact.labeled_links[0].label.length, 60);
  assert.equal(compact.text.length, 1500);
  assert.equal(compact.query_strings_stripped, 1);
  assert.equal(compact.compact, true);
  assert.equal(claudeChromeChunkReadSource(2), `window.__boostlyPage.slice(${2 * CLAUDE_CHROME_CHUNK_SIZE}, ${3 * CLAUDE_CHROME_CHUNK_SIZE})`);
  assert.throws(() => claudeChromeChunkReadSource(-1), /non-negative integer/);
  // The in-page script is a self-contained expression: it must parse on its own.
  assert.doesNotThrow(() => new Function(`return ${claudeChromeExtractorSource()}`));
});

test("page chunks written by the session assemble back into the recorded page", () => {
  const dir = tmp();
  const json = JSON.stringify(samplePage);
  const size = 50;
  const parts = Math.ceil(json.length / size);
  for (let i = 0; i < parts; i += 1) fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(2, "0")}.txt`), json.slice(i * size, (i + 1) * size) + (i % 2 ? "\n" : ""));
  const assembled = assemblePageParts(dir, { chars: json.length, sum: claudeChromeChecksum(json) });
  assert.equal(assembled.parts, parts);
  assert.deepEqual(assembled.page, samplePage);
  assert.throws(() => assemblePageParts(dir, { chars: json.length + 1 }), /extractor reported/);
  assert.throws(() => assemblePageParts(dir, { sum: 1 }), /checksum/);
  fs.writeFileSync(path.join(dir, "99.txt"), "{broken");
  assert.throws(() => assemblePageParts(dir), /do not concatenate to valid JSON/);
  const resultsFile = path.join(dir, "results.json");
  initResults(resultsFile, { profile: "Boostly.com" });
  fs.unlinkSync(path.join(dir, "99.txt"));
  assert.equal(addResult(resultsFile, { url: "https://www.dogwood.pizza/", page: assemblePageParts(dir).page }).count, 1);
});

// 2026-10-22 (Fat Daddy's, Trail Rider): non-web hrefs and pages that never load must not block the validator.
test("non-web hrefs are never queued for the browser and are rejected as not a URL", async () => {
  const { nonHttpScheme, notAUrlDecision, verifyLinks } = await import("./discover-links.mjs");
  for (const href of ["javascript:void(0", "javascript:void(0)", "mailto:hi@x.com", "tel:+18015550100", "data:text/html,hi", "sms:123", "webcal://x.com/a.ics"]) {
    assert.ok(nonHttpScheme(href), href);
  }
  for (const href of ["https://a.com/x", "http://a.com", "a.com/menu", "www.a.com", "a.com:8080/x"]) {
    assert.equal(nonHttpScheme(href), null, href);
  }
  const decision = notAUrlDecision({ input_url: "javascript:void(0", category: "order", link_type: "order" });
  assert.equal(decision.status, "rejected");
  assert.equal(decision.rejection_reason, "not a URL");

  const dir = tmp();
  const manifestFile = path.join(dir, "browser-needed.json");
  const store = new FixtureStore("", "loc-1", { browserProvider: CLAUDE_CHROME_PROVIDER, chromeProfile: "boostly", browserManifestFile: manifestFile });
  await store.preflightBrowserProvider();
  store.noteBrowserNeeded("javascript:void(0", "candidate");
  store.noteBrowserNeeded("mailto:hi@x.com", "candidate");
  const links = await verifyLinks(
    { name: "Dogwood Pizza", website_url: "https://www.dogwood.pizza/" },
    [{ input_url: "javascript:void(0", category: "order", source_type: "website" }, { input_url: "tel:+18015550100", category: "menu", source_type: "website" }],
    store, {}, "candidate");
  assert.deepEqual(links.map((link) => [link.status, link.rejection_reason]), [["rejected", "not a URL"], ["rejected", "not a URL"]]);
  assert.deepEqual(store.claudeChromeRuntime("loc-1").browser_needed, []);
  await store.close();
});

test("a recorded network/TLS failure resolves the browser read and the candidate is unreachable", async () => {
  const { applyRecordedBrowserFailure } = await import("./discover-links.mjs");
  const dir = tmp();
  const resultsFile = path.join(dir, "browser-results.json");
  initResults(resultsFile, { profile: "Boostly.com" });
  const url = "https://order.example-pizza.com/menu#signature";
  assert.throws(() => addResult(resultsFile, { url, error: "  " }), /observed error/);
  assert.throws(() => addResult(resultsFile, { url, error: "x", page: samplePage }), /either a page or --error/);
  assert.throws(() => addResult(resultsFile, { url: "javascript:void(0", error: "x" }), /not a web URL/);
  addResult(resultsFile, { url, error: "curl: (60) SSL: no alternative certificate subject name matches target host name" });

  const manifestFile = path.join(dir, "browser-needed.json");
  fs.writeFileSync(manifestFile, JSON.stringify({ format: BROWSER_MANIFEST_FORMAT, chrome_profile_required: "Boostly.com", urls: [{ url, kind: "candidate" }] }));
  assert.equal(pendingUrls(manifestFile, resultsFile).pending.length, 0);

  const store = new FixtureStore("", "loc-1", { browserProvider: CLAUDE_CHROME_PROVIDER, chromeProfile: "boostly", browserResultsFile: resultsFile, browserManifestFile: manifestFile });
  await store.preflightBrowserProvider();
  assert.equal(store.browserProviderPreflighted, true);
  const page = await store.getPage();
  await assert.rejects(() => page.goto("https://order.example-pizza.com/menu"), /claude_chrome_recorded_failure: curl: \(60\) SSL/);
  assert.deepEqual(store.claudeChromeRuntime("loc-1").browser_needed, []);

  const unknown = { input_url: url, liveness: "unknown", status: "needs_manual_review", validity_evidence: [] };
  const applied = applyRecordedBrowserFailure(unknown, store);
  assert.equal(applied.status, "broken");
  assert.equal(applied.liveness, "broken");
  assert.match(applied.rejection_reason, /^unreachable: curl: \(60\) SSL/);
  const live = { input_url: url, liveness: "live", status: "verified" };
  assert.equal(applyRecordedBrowserFailure(live, store), live);
  assert.equal(applyRecordedBrowserFailure({ input_url: "https://other.example/", liveness: "unknown" }, store).liveness, "unknown");
  await store.close();
});
