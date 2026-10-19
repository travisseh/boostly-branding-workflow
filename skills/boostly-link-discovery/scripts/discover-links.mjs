#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataForSeoCredentials } from "./dataforseo-credentials.mjs";
import {
  classifyLink,
  collectEvidence,
  domain,
  ensureProtocol,
  normalizeLocation,
  normalizeUrlForCompare,
  CLAUDE_CHROME_CHUNK_SIZE,
  claudeChromeExtractorSource,
  verifyCandidateLinks,
  validityDecision,
  writeJson
} from "../../boostly-link-verifier/lib/verify-core.mjs";

// Sibling skills resolve relative to this file so the same code runs from either skills root
// (~/.claude/skills is canonical; ~/.codex/skills is the daily mirror).
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_ROOT = path.resolve(SKILL_DIR, "..");
const V2_DB = path.join(SKILLS_ROOT, "v2-database", "bin", "v2-db");
const BOOSTLY_LINK_SETTINGS = path.join(SKILLS_ROOT, "boostly-instore-link-settings", "scripts", "boostly-links");
// Browser providers. codex-extension drives the Codex Chrome extension in-process. claude-chrome
// is the Claude Code flow: discovery cannot call the claude-in-chrome MCP tools from Node, so it
// emits a browser-needed manifest, the session visits those URLs with the MCP tools and records
// results (claude-chrome-browser.mjs), and discovery resumes with --browser-results <file>.
const CODEX_EXTENSION_PROVIDER = "codex-extension";
const CLAUDE_CHROME_PROVIDER = "claude-chrome";
const FULFILLMENT_BROWSER_PROVIDERS = [CODEX_EXTENSION_PROVIDER, CLAUDE_CHROME_PROVIDER];
const BROWSER_RESULTS_FORMAT = "boostly-link-discovery.claude-chrome-results.v1";
const BROWSER_MANIFEST_FORMAT = "boostly-link-discovery.claude-chrome-manifest.v1";
const GOOGLE_PLACES_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const GOOGLE_PLACES_ENV_FILES = [
  `${process.env.HOME}/.config/boostly-branding/.env`
];
const CATEGORY_SET = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "x_twitter",
  "ios_app",
  "android_app",
  "ordering",
  "order",
  "menu",
  "app_downloads",
  "catering",
  "careers_jobs",
  "events",
  "reservations",
  "gift_cards",
  "loyalty_rewards",
  "other_custom"
];
const LOCATION_FIELD_BY_CATEGORY = {
  instagram: "branding.instagram_url",
  facebook: "branding.facebook_url",
  tiktok: "branding.tiktok_url",
  youtube: "branding.youtube_url",
  x_twitter: "branding.x_url",
  ios_app: "branding.apple_app_url",
  android_app: "branding.google_app_url",
  ordering: "locations.ordering_url"
};
const TOUCHPOINT_ORDER = [
  "order",
  "menu",
  "app_downloads",
  "reservations",
  "catering",
  "events",
  "gift_cards",
  "loyalty_rewards",
  "careers_jobs",
  "other_custom"
];
const DISCOVERY_LIMITS = {
  same_domain_pages: 12,
  external_link_in_bio_pages: 2,
  search_queries: 18,
  verify_candidates_per_category: 4
};
const CUSTOM_DESTINATION_CATEGORIES = new Set(["catering", "events", "reservations"]);
const SOCIAL_CATEGORIES = new Set(["instagram", "facebook", "youtube", "x_twitter", "tiktok"]);
const DEAD_PAGE_EVIDENCE = /couldn.t find this (?:account|page)|page isn.t available|sorry this page|not found|unavailable|doesn.t exist|does not exist|no longer exists?|we can.t find (?:that|this|the) page|soft_not_found_page_detected=true|platform_unavailable_page_detected=true/i;
const UNVERIFIED_FETCH_EVIDENCE = /security_or_bot_challenge_detected=true|fetch_timeout_soft=true/i;
const BAD_HTTP_EVIDENCE = /http_status=(?:4\d\d|5\d\d)/i;
// Official-site crawl politeness + resilience. The official website is the single
// highest-confidence source for socials/ordering, so a failed homepage fetch must be
// retried (hosts like GoDaddy DPS rate-limit bursts across sibling-location domains
// on shared infrastructure) instead of silently degrading discovery to search-only.
const WEBSITE_CRAWL_PAGE_DELAY_MS = 1000;
const WEBSITE_CRAWL_RETRY_DELAYS_MS = [4000, 10000];
const JUNK_LINK_RE = /\b(privacy|terms|login|sign\s*in|account|profile|cart|checkout|accessibility|cookie|sitemap|unsubscribe)\b/i;
const LINK_IN_BIO_HOSTS = ["linktr.ee", "bio.site", "lnk.bio", "beacons.ai", "bento.me", "taplink.cc"];
const DEFAULT_SEARCH_PROVIDER = "dataforseo";
const DATAFORSEO_SERP_ENDPOINT = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const DEV_BROWSER_CHROME_HELPER = path.join(SKILLS_ROOT, "dev-browser", "scripts", "launch-profile-debug-chrome.sh");
const DEFAULT_CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runs", "cache", "link-evidence");
const EVENT_LUNA_MODEL = "gpt-5.6-luna";
const EVENT_LUNA_MIN_CONFIDENCE = 0.9;
const EVENT_LUNA_SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema", "event-luna-review.schema.json");
const EXTERNAL_SEARCH_CATEGORIES = new Set([
  "ordering", "order", "menu", "events", "careers_jobs", "catering",
  "instagram", "facebook", "tiktok", "youtube", "x_twitter"
]);

class StageMetrics {
  constructor() {
    this.stages = [];
  }

  async measure(stage, operation) {
    const startedAt = checkedAt();
    const startedMs = performance.now();
    try {
      const value = await operation();
      this.stages.push({ stage, started_at: startedAt, duration_ms: Number((performance.now() - startedMs).toFixed(3)), outcome: "ok", counters: {} });
      return value;
    } catch (error) {
      this.stages.push({ stage, started_at: startedAt, duration_ms: Number((performance.now() - startedMs).toFixed(3)), outcome: "error", counters: {}, error_code: error?.code || error?.name || "error" });
      throw error;
    }
  }

  increment(stage, counter, amount = 1) {
    const metric = [...this.stages].reverse().find((item) => item.stage === stage);
    if (!metric) return;
    metric.counters[counter] = (metric.counters[counter] || 0) + amount;
  }

  snapshot() {
    return {
      total_duration_ms: Number(this.stages.reduce((total, stage) => total + stage.duration_ms, 0).toFixed(3)),
      stages: this.stages
    };
  }
}

async function main(args) {
  if (!args["location-id"]) throw new Error("--location-id is required");
  const report = await discoverLocation(args["location-id"], args);
  if (args.out) writeJson(args.out, report);
  else console.log(JSON.stringify(report, null, 2));
}

async function discoverLocation(locationId, args = {}) {
  if (args.replay && args.record) throw new Error("Use only one of --record or --replay");
  if (args.replay && !args["fixtures-dir"]) throw new Error("--fixtures-dir is required with --replay");
  if (args.record && !args["fixtures-dir"]) throw new Error("--fixtures-dir is required with --record");
  if (!args["skip-schema-check"] && !args.replay) assertSchema();

  const browserRuntime = resolveBrowserRuntime(args);
  const metrics = new StageMetrics();
  const fixtureStore = new FixtureStore(args["fixtures-dir"], locationId, {
    record: Boolean(args.record),
    replay: Boolean(args.replay),
    browserProvider: browserRuntime.browserProvider,
    chromeCdpUrl: args["chrome-cdp-url"] || (typeof process !== "undefined" ? process.env.BOOSTLY_LINK_DISCOVERY_CHROME_CDP_URL || process.env.CHROME_CDP_URL : "") || "",
    chromeProfile: args["chrome-profile"] || "",
    codexAgent: args.codexAgent || null,
    browserResultsFile: args["browser-results"] || args.browserResults || "",
    browserManifestFile: resolveBrowserManifestPath(args),
    cacheDir: args["cache-dir"] || DEFAULT_CACHE_DIR,
    cacheTtlDays: Number(args["cache-ttl-days"] || 5),
    cacheEnabled: !args.replay && !args.record && !args["no-cache"]
  });
  await fixtureStore.preflightBrowserProvider();
  const searchProvider = createSearchProvider(args, fixtureStore);
  const loaded = await metrics.measure("production_read", async () => loadLocationContext(locationId, fixtureStore, args));
  metrics.increment("production_read", "locations_read", 1);
  metrics.increment("production_read", "touchpoint_events_read", loaded.touchpoint_events.length);
  const identityContext = args.fulfillmentMode || args["fulfillment-mode"]
    ? fulfillmentLocationContext(loaded.location_context)
    : loaded.location_context;
  const websiteBootstrap = await bootstrapMissingWebsite(identityContext, args, searchProvider);
  const location_context = websiteBootstrap.location;
  const touchpoint_events = loaded.touchpoint_events;
  const existingLinks = buildExistingLinks(location_context, touchpoint_events).map((link) => ({
    ...link,
    hidden_for_discovery: Boolean(args["hide-existing"] && link.category !== "website")
  }));
  const visibleExisting = existingLinks.filter((link) => !link.hidden_for_discovery);
  const existingToVerify = visibleExisting.filter((link) => link.category !== "website");

  const existingVerifiedRaw = existingToVerify.length
    ? await metrics.measure("candidate_verification", async () => verifyLinks(location_context, withWebsiteContext(location_context, existingToVerify), fixtureStore, args, "candidate"))
    : [];
  if (existingToVerify.length) {
    metrics.increment("candidate_verification", "candidates_input", existingToVerify.length);
    metrics.increment("candidate_verification", "verified", existingVerifiedRaw.filter((link) => link.status === "verified").length);
  }
  const existingLunaReview = await metrics.measure("event_luna_review", async () =>
    reviewAmbiguousEventsWithLuna(existingVerifiedRaw, location_context, args));
  metrics.increment("event_luna_review", "candidates_reviewed", existingLunaReview.reviewed);
  metrics.increment("event_luna_review", "reviews_accepted", existingLunaReview.accepted);
  metrics.increment("event_luna_review", "reviews_unavailable", existingLunaReview.unavailable);
  const existingVerified = existingLunaReview.links;
  const existingByCategory = chooseBestByCategory(existingVerified
    .filter((link) => link.category !== "website")
    .map(reclassifyVerifiedFunction));

  const categoryFilter = csvArgSet(args["discover-categories"]);
  const categoriesToDiscover = CATEGORY_SET.filter((category) => {
    if (categoryFilter && !categoryFilter.has(category)) return false;
    if (args["hide-existing"]) return true;
    return existingByCategory.get(category)?.status !== "verified";
  });

  const sourcePages = [];
  const discoveredCandidates = await discoverCandidates(location_context, categoriesToDiscover, fixtureStore, { ...args, stageMetrics: metrics }, sourcePages, searchProvider);
  // A dead stored host whose apex/www sibling answered is a standing website write (Link write gate).
  const siblingRecovery = websiteSiblingRecoveryFromSourcePages(location_context, sourcePages);
  if (siblingRecovery) {
    websiteBootstrap.audit = { ...websiteBootstrap.audit, attempted: true, verdict: "ready", reason: "apex_www_sibling_live", source: "website_crawl", stored_website_url: siblingRecovery.from, website_url: siblingRecovery.to, persisted: false };
    if (!args.replay && !args["skip-website-bootstrap"]) {
      const persisted = persistWebsiteUrl(location_context, siblingRecovery.to, args);
      websiteBootstrap.audit = { ...websiteBootstrap.audit, website_url: persisted, persisted: true, readback_verified: true };
      location_context.website_url = persisted;
    }
  }
  const dedupedCandidates = dedupeCandidates(discoveredCandidates)
    .filter((candidate) => candidateRelevantForDiscovery(candidate.category, categoriesToDiscover));
  const candidatesToVerify = rankCandidatesForVerification(dedupedCandidates, location_context, args);
  const verifiedCandidatesRaw = candidatesToVerify.length
    ? await metrics.measure("candidate_verification", async () => verifyLinks(location_context, withWebsiteContext(location_context, candidatesToVerify), fixtureStore, args, "candidate"))
    : [];
  if (candidatesToVerify.length) {
    metrics.increment("candidate_verification", "candidates_input", candidatesToVerify.length);
    metrics.increment("candidate_verification", "verified", verifiedCandidatesRaw.filter((link) => link.status === "verified").length);
    metrics.increment("candidate_verification", "manual_review", verifiedCandidatesRaw.filter((link) => link.status === "needs_manual_review").length);
  }
  const candidateLunaReview = await metrics.measure("event_luna_review", async () =>
    reviewAmbiguousEventsWithLuna(verifiedCandidatesRaw, location_context, args));
  metrics.increment("event_luna_review", "candidates_reviewed", candidateLunaReview.reviewed);
  metrics.increment("event_luna_review", "reviews_accepted", candidateLunaReview.accepted);
  metrics.increment("event_luna_review", "reviews_unavailable", candidateLunaReview.unavailable);
  const candidateLinks = candidateLunaReview.links
    .filter((link) => link.category !== "website")
    .map(reclassifyVerifiedFunction);

  const { categoryResults, proposals } = await metrics.measure("plan_build", async () => {
    const categoryResults = resolveCategories({
      location: location_context,
      existingByCategory,
      candidatesByCategory: groupCandidates(candidateLinks),
      hiddenExisting: Boolean(args["hide-existing"]),
      touchpoint_events
    });
    return { categoryResults, proposals: buildProposals(categoryResults, touchpoint_events, args) };
  });
  metrics.increment("plan_build", "category_results", categoryResults.length);
  metrics.increment("plan_build", "location_proposals", proposals.locationUpdates.length);
  metrics.increment("plan_build", "touchpoint_proposals", proposals.touchpointEvents.length);
  const manualReviewItems = categoryResults
    .filter((result) => result.category_status === "needs_manual_review" || result.category_status === "existing_needs_manual_review")
    .map((result) => ({
      category: result.category,
      reason: manualReviewReason(result),
      candidate_url: result.selected_link?.input_url || result.existing_link?.input_url || null
    }));

  // Surface EVERY held needs_manual_review candidate, not just the per-category
  // selected one. Bot-challenge / timeout links (Yelp 403, DoorDash, slow official
  // sites) verify to needs_manual_review; if they are not the selected best they would
  // otherwise vanish from the report entirely (rejected_candidates only carries
  // rejected|broken). A heartbeat operator must be able to see these held links.
  const flaggedManualUrls = new Set(manualReviewItems.map((item) => item.candidate_url).filter(Boolean));
  for (const link of candidateLinks) {
    if (link.status !== "needs_manual_review") continue;
    if (flaggedManualUrls.has(link.input_url)) continue;
    flaggedManualUrls.add(link.input_url);
    const evidence = allEvidence(link);
    const blockReason = /security_or_bot_challenge_detected=true/.test(evidence) ? "bot_or_security_challenge"
      : /fetch_timeout_soft=true/.test(evidence) ? "fetch_timeout"
      : "uncertain_evidence";
    manualReviewItems.push({
      category: link.category,
      reason: link.rejection_reason || "Candidate could not be auto-verified and needs a human check.",
      candidate_url: link.input_url,
      held: true,
      block_reason: blockReason
    });
  }

  // The official site is the only source that can auto-propose socials, so a failed
  // crawl must be surfaced instead of quietly reporting "no facebook/instagram found".
  const websiteCrawlStatus = websiteCrawlStatusFromSourcePages(location_context, sourcePages, args);
  if (websiteCrawlStatus === "failed") {
    manualReviewItems.push({
      category: "website",
      reason: "Official website fetch failed for every crawled page (timeout or rate limiting); social/ordering discovery degraded to search-only. Re-run discovery before trusting missing social results.",
      candidate_url: location_context.website_url || null
    });
  }

  const claudeChromeRuntime = fixtureStore.browserProvider === CLAUDE_CHROME_PROVIDER
    ? fixtureStore.claudeChromeRuntime(locationId)
    : {};
  const report = {
    checked_at: checkedAt(),
    location_context,
    website_bootstrap: websiteBootstrap.audit,
    runtime: {
      fulfillment_mode: browserRuntime.fulfillmentMode,
      browser_provider: fixtureStore.browserProvider,
      required_browser_provider: browserRuntime.requiredBrowserProvider,
      browser_provider_preflighted: fixtureStore.browserProviderPreflighted,
      chrome_profile_requested: fixtureStore.requestedChromeProfileName,
      chrome_profile_resolved: fixtureStore.chromeProfileResolved(),
      chrome_profile_resolution: fixtureStore.chromeProfileResolution(),
      ...claudeChromeRuntime,
    },
    discovery_limits: {
      ...DISCOVERY_LIMITS,
      replay: Boolean(args.replay),
      record: Boolean(args.record),
      hide_existing: Boolean(args["hide-existing"]),
      search_provider: searchProvider.name,
      source_pages_fetched: sourcePages.length
    },
    existing_links: existingLinks,
    discovered_candidates: dedupedCandidates,
    verified_links: [...existingVerified, ...candidateLinks].map(toCandidateRecord),
    category_results: categoryResults,
    proposed_location_updates: proposals.locationUpdates,
    proposed_touchpoint_events: proposals.touchpointEvents,
    source_pages: sourcePages,
    rejected_candidates: candidateLinks.filter((link) => link.status === "rejected" || link.status === "broken").map(toCandidateRecord),
    manual_review_items: manualReviewItems,
    summary: {
      categories_total: CATEGORY_SET.length,
      proposed_location_updates: proposals.locationUpdates.filter((item) => item.action !== "noop").length,
      proposed_touchpoint_events: proposals.touchpointEvents.filter((item) => item.action !== "noop").length,
      manual_review_items: manualReviewItems.length,
      candidates_discovered: dedupedCandidates.length,
      candidates_verified_input: candidatesToVerify.length,
      candidates_skipped_before_verify: Math.max(0, dedupedCandidates.length - candidatesToVerify.length),
      verified_candidates: candidateLinks.filter((link) => link.status === "verified").length,
      website_crawl_status: websiteCrawlStatus,
      search_failures: sourcePages.filter((page) => page.source_type === "search" && ["blocked", "error"].includes(page.search_status)).length,
      empty_searches: sourcePages.filter((page) => page.source_type === "search" && page.search_status === "empty").length,
      missing_fixtures: fixtureStore.missingFixtures,
      attempted_live_fetches_in_replay: fixtureStore.attemptedLiveFetches,
      cache_hits: fixtureStore.cacheHits,
      cache_misses: fixtureStore.cacheMisses,
      external_search_categories: sourcePages.filter((page) => page.source_type === "search").map((page) => page.category_hint).filter(Boolean)
    },
    stage_metrics: metrics.snapshot()
  };

  if (args.replay && fixtureStore.attemptedLiveFetches.length) {
    report.summary.replay_violation = true;
  }
  await fixtureStore.close();
  return report;
}

// Website bootstrap verdicts (box-fulfillment SKILL "Link write gate", 2026-10-19). These are standing
// defaults the agent reports as written or skipped, never as a question: `ready` writes (or accepts a
// null website), `hold` is only for sources that disagree, `noop` leaves a configured site alone.
const WEBSITE_BOOTSTRAP_VERDICTS = Object.freeze({ ready: "ready", hold: "hold", noop: "noop" });
const TRACKING_QUERY_PARAM = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_.+|_ga|_gl)$/i;
const NON_OFFICIAL_SEARCH_HOSTS = ["facebook.com", "instagram.com", "tiktok.com", "youtube.com", "x.com", "twitter.com", "linkedin.com", "google.com", "yelp.com", "doordash.com", "ubereats.com", "grubhub.com", "toasttab.com", "slicelife.com", "seamless.com", "postmates.com", "opentable.com", "resy.com", "tripadvisor.com", "mapquest.com", "foursquare.com", "zomato.com", "menupages.com", "allmenus.com", "restaurantji.com", "wikipedia.org", ...LINK_IN_BIO_HOSTS];

function stripTrackingParams(url) {
  try {
    const u = new URL(ensureProtocol(url));
    for (const key of [...u.searchParams.keys()]) if (TRACKING_QUERY_PARAM.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return String(url || "");
  }
}

/**
 * Pure verdict for the website bootstrap. `stored` is the V2 website_url, `places` the Places websiteUri
 * (or null), `searchWebsite` is { status: "none" | "found" | "unavailable", url } from searchOfficialWebsite.
 */
function websiteBootstrapVerdict({ stored = "", places = null, searchWebsite = null } = {}) {
  if (stored) {
    const stripped = stripTrackingParams(stored);
    if (stripped !== stored && normalizeUrlForCompare(stripped) === normalizeUrlForCompare(stored)) {
      return { verdict: WEBSITE_BOOTSTRAP_VERDICTS.ready, reason: "tracking_params_only", website_url: stripped };
    }
    return { verdict: WEBSITE_BOOTSTRAP_VERDICTS.noop, reason: "website_already_configured", website_url: stored };
  }
  if (places) return { verdict: WEBSITE_BOOTSTRAP_VERDICTS.ready, reason: "google_places_api", website_url: places };
  if (searchWebsite?.status === "none") {
    return { verdict: WEBSITE_BOOTSTRAP_VERDICTS.ready, reason: "no_website_places_and_search_agree", website_url: null };
  }
  if (searchWebsite?.status === "found") {
    return { verdict: WEBSITE_BOOTSTRAP_VERDICTS.hold, reason: "website_sources_disagree", website_url: null, search_website_url: searchWebsite.url };
  }
  return { verdict: WEBSITE_BOOTSTRAP_VERDICTS.hold, reason: "no_website_unconfirmed", website_url: null };
}

/** Does the search provider surface a plausible official site for this business? Agreement with Places' null answer makes the null website `ready`. */
async function searchOfficialWebsite(location, searchProvider) {
  if (!searchProvider || typeof searchProvider.search !== "function") return { status: "unavailable", url: null };
  const name = cleanSearchName(location.location_name) || location.account_name || "";
  if (!name) return { status: "unavailable", url: null };
  const query = normalizedSearchQuery(`${name} ${location.shipping_city || ""} ${location.shipping_state || ""}`);
  let result;
  try {
    result = await searchProvider.search(query);
  } catch {
    return { status: "unavailable", url: null, query };
  }
  if (!result || result.error || !["ok", "empty"].includes(result.status)) return { status: "unavailable", url: null, query };
  const nameTokens = normalizeText(`${name} ${location.account_name || ""}`).split(" ").filter((token) => token.length >= 4 && !/^(?:restaurant|pizza|pizzeria|grill|kitchen|cafe|the|and)$/.test(token));
  for (const item of (result.results || []).slice(0, 10)) {
    const host = domain(item.url);
    if (!host || NON_OFFICIAL_SEARCH_HOSTS.some((needle) => host === needle || host.endsWith(`.${needle}`)) || isAggregatorDomain(host)) continue;
    const label = host.split(".").slice(0, -1).join("");
    if (nameTokens.some((token) => label.includes(token))) return { status: "found", url: cleanCandidateUrl(item.url), query };
  }
  return { status: "none", url: null, query };
}

/** A stored host that never answered, followed by its www/apex sibling answering, inside the website crawl. */
function websiteSiblingRecoveryFromSourcePages(location, sourcePages) {
  const stored = location.website_url;
  if (!stored) return null;
  let storedHost;
  try { storedHost = new URL(ensureProtocol(stored)).hostname.toLowerCase(); } catch { return null; }
  const sibling = storedHost.startsWith("www.") ? storedHost.slice(4) : `www.${storedHost}`;
  const hostOf = (value) => { try { return new URL(ensureProtocol(value)).hostname.toLowerCase(); } catch { return ""; } };
  const pages = sourcePages.filter((page) => page.source_type === "website");
  const deadIndex = pages.findIndex((page) => hostOf(page.url) === storedHost && page.http_status == null && !(page.links_extracted > 0));
  if (deadIndex < 0 || pages.some((page) => hostOf(page.url) === storedHost && (page.http_status != null || page.links_extracted > 0))) return null;
  const live = pages.slice(deadIndex + 1).find((page) => hostOf(page.url) === sibling &&
    ((page.http_status != null && page.http_status !== 429 && page.http_status < 500) || page.links_extracted > 0));
  if (!live) return null;
  const to = (() => { try { const u = new URL(ensureProtocol(stored)); u.hostname = sibling; return u.toString(); } catch { return `https://${sibling}/`; } })();
  return { from: stored, to };
}

/** boostly-instore-link-settings location set: dry run, apply, readback. Returns the persisted website_url. */
function persistWebsiteUrl(location, websiteUrl, args = {}) {
  const runSettings = args.runLinkSettingsCommand || runLinkSettingsCommand;
  const commonArgs = ["location", "set", location.location_id, "--website-url", websiteUrl, "--ensure-location-scope", "--json"];
  if (args["cookie-file"]) commonArgs.push("--cookie-file", args["cookie-file"]);
  const dryRun = runSettings(commonArgs, args);
  if (normalizeUrlForCompare(dryRun?.after?.website_url) !== normalizeUrlForCompare(websiteUrl)) {
    throw new Error("Boostly location-settings dry run did not produce the expected website URL; refusing to apply.");
  }
  runSettings([...commonArgs, "--apply"], args);
  const readArgs = ["location", "get", location.location_id, "--ensure-location-scope", "--json"];
  if (args["cookie-file"]) readArgs.push("--cookie-file", args["cookie-file"]);
  const persisted = runSettings(readArgs, args);
  if (normalizeUrlForCompare(persisted?.website_url) !== normalizeUrlForCompare(websiteUrl)) {
    throw new Error("Boostly location-settings readback did not match the written website URL; discovery stopped before verification.");
  }
  return persisted.website_url;
}

async function bootstrapMissingWebsite(location, args = {}, searchProvider = null) {
  const overrideUrl = args["website-url-override"] || args.websiteUrlOverride || "";
  if (!location.website_url && overrideUrl) {
    // Supervised diagnostics only: crawl a known site without the Places bootstrap write.
    // The validator refuses this audit reason in fulfillment mode; the website must still be
    // written through boostly-instore-link-settings before links are fulfilled.
    if (!/^https?:\/\//i.test(overrideUrl)) throw new Error("--website-url-override must be an http(s) URL");
    return {
      location: { ...location, website_url: overrideUrl },
      audit: { attempted: false, reason: "website_url_override_unwritten", override_url: overrideUrl, persisted: false }
    };
  }
  if (args.replay || args["skip-website-bootstrap"]) {
    return { location, audit: { attempted: false, reason: args.replay ? "replay_mode" : "explicitly_skipped" } };
  }
  if (location.website_url) {
    const verdict = websiteBootstrapVerdict({ stored: location.website_url });
    if (verdict.verdict !== WEBSITE_BOOTSTRAP_VERDICTS.ready) return { location, audit: { attempted: false, reason: verdict.reason } };
    // The stored site differs from its canonical form only by tracking params: write the clean URL.
    const persisted = persistWebsiteUrl(location, verdict.website_url, args);
    return {
      location: { ...location, website_url: persisted },
      audit: { attempted: true, verdict: verdict.verdict, reason: verdict.reason, source: "stored_website_url", stored_website_url: location.website_url, website_url: persisted, persisted: true, readback_verified: true }
    };
  }
  if (!location.google_place_id) {
    throw new Error(`Location ${location.location_id} has no website_url and no google_place_id; cannot bootstrap the official website before discovery.`);
  }

  const place = await fetchGooglePlaceWebsite(location.google_place_id, args);
  const placesUrl = cleanCandidateUrl(place.websiteUri);
  const places = placesUrl && /^https?:\/\//i.test(placesUrl) ? placesUrl : null;
  const searchWebsite = places ? null : await searchOfficialWebsite(location, searchProvider);
  const verdict = websiteBootstrapVerdict({ stored: "", places, searchWebsite });
  const audit = {
    attempted: true,
    verdict: verdict.verdict,
    reason: verdict.reason,
    source: "google_places_api",
    google_place_id: location.google_place_id,
    website_url: verdict.website_url,
    ...(searchWebsite ? { search_website: searchWebsite } : {}),
    persisted: false
  };
  if (!places) {
    // Null website: `ready` when Places and the search provider agree there is none (discovery goes
    // on search-only); `hold` when they disagree or the search provider is unavailable. No throw.
    return { location, audit };
  }
  const persisted = persistWebsiteUrl(location, places, args);
  return {
    location: { ...location, website_url: persisted },
    audit: { ...audit, website_url: persisted, persisted: true, readback_verified: true }
  };
}

async function fetchGooglePlaceWebsite(placeId, args = {}) {
  const apiKey = args.googlePlacesApiKey || runtimeEnvironment()?.GOOGLE_PLACES_API_KEY || loadEnvValue("GOOGLE_PLACES_API_KEY", GOOGLE_PLACES_ENV_FILES);
  if (!apiKey) throw new Error("Missing GOOGLE_PLACES_API_KEY; cannot bootstrap website_url from Google Places.");
  const request = args.googlePlacesFetch || fetch;
  const response = await request(`${GOOGLE_PLACES_DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "id,websiteUri,businessStatus"
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Google Places details failed with HTTP ${response.status}.`);
  if (body.id && body.id !== placeId) throw new Error("Google Places details returned a different place ID; refusing website bootstrap.");
  if (body.businessStatus === "CLOSED_PERMANENTLY") throw new Error("Google Places reports the location permanently closed; refusing website bootstrap.");
  return body;
}

function runLinkSettingsCommand(commandArgs, args = {}) {
  const cliArgs = [...commandArgs];
  if (args["cookie-file"] && !cliArgs.includes("--cookie-file")) cliArgs.push("--cookie-file", args["cookie-file"]);
  const raw = execFileSync(BOOSTLY_LINK_SETTINGS, cliArgs, {
    encoding: "utf8",
    env: runtimeEnvironment(),
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(raw);
}

function loadEnvValue(key, files) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((candidate) => candidate.match(new RegExp(`^\\s*${key}=`)));
    if (!line) continue;
    return line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

function defaultBrowserProvider(args = {}) {
  if (args["browser-provider"]) return args["browser-provider"];
  if (args.browser) return args.browser;
  if (typeof process !== "undefined" && process.env.BOOSTLY_LINK_DISCOVERY_BROWSER_PROVIDER) return process.env.BOOSTLY_LINK_DISCOVERY_BROWSER_PROVIDER;
  if (args.replay) return "playwright";
  if (args.codexAgent || globalThis.agent?.browsers) return "codex-extension";
  return "playwright";
}

function resolveBrowserRuntime(args = {}) {
  const browserProvider = defaultBrowserProvider(args);
  const fulfillmentMode = Boolean(args.fulfillmentMode || args["fulfillment-mode"]);
  const requiredBrowserProvider = args.requiredBrowserProvider || args["required-browser-provider"] ||
    (fulfillmentMode ? (browserProvider === CLAUDE_CHROME_PROVIDER ? CLAUDE_CHROME_PROVIDER : CODEX_EXTENSION_PROVIDER) : null);
  if (requiredBrowserProvider && browserProvider !== requiredBrowserProvider) {
    const hint = requiredBrowserProvider === CLAUDE_CHROME_PROVIDER
      ? "Pass --browser-provider claude-chrome and supply --browser-results from the claude-in-chrome session."
      : "Run discoverLocation() inside the Codex Chrome extension runtime.";
    throw new Error(`Browser provider mismatch: fulfillment requires '${requiredBrowserProvider}', resolved '${browserProvider}'. ${hint}`);
  }
  if (fulfillmentMode && !FULFILLMENT_BROWSER_PROVIDERS.includes(browserProvider)) {
    throw new Error(`Fulfillment discovery requires browser-provider=${FULFILLMENT_BROWSER_PROVIDERS.join(" or ")}, resolved '${browserProvider}'.`);
  }
  return { browserProvider, fulfillmentMode, requiredBrowserProvider };
}

async function verifyLinks(location, links, fixtureStore, args, fixtureKind) {
  const decorated = decorateLinksForVerification(location, links);
  const useCustomEvidence = Boolean(args.record || args.replay || fixtureStore.usesCustomBrowserProvider());
  const verified = await verifyCandidateLinks(normalizeLocation(location), decorated, useCustomEvidence ? {
    fetchEvidence: async (url) => fixtureStore.fetchEvidence(url, fixtureKind)
  } : {});
  return verified.map((link) => {
    const original = decorated.find((candidate) => sameUrl(candidate.input_url, link.input_url));
    return {
      ...link,
      category: link.category || original?.category || categoryForVerifierLinkType(link.link_type, link.input_url),
      source_type: original?.source_type || original?.source_table || link.source?.source_table || "candidate",
      source_url: original?.source_url || null,
      source_evidence: original?.source_evidence || []
    };
  });
}

function decorateLinksForVerification(location, links) {
  const officialHost = domain(location.website_url);
  return links.map((link) => {
    const sourceHost = domain(link.source_url);
    const extractedFromOfficialWebsite = link.source_type === "website" &&
      officialHost &&
      sameWebsiteDomain(sourceHost, officialHost);
    return {
      ...link,
      link_type: link.link_type || verifierLinkTypeForCategory(link.category),
      officialWebsiteLinksCandidate: Boolean(
        link.officialWebsiteLinksCandidate || extractedFromOfficialWebsite
      )
    };
  });
}

async function discoverCandidates(location, categoriesToDiscover, fixtureStore, args, sourcePages, searchProvider) {
  const candidates = [];
  if (args["search-only"]) {
    const searchable = categoriesToDiscover.filter((category) => EXTERNAL_SEARCH_CATEGORIES.has(category));
    const found = await args.stageMetrics.measure("external_search", async () => discoverSearchCandidates(location, searchable, fixtureStore, sourcePages, searchProvider));
    candidates.push(...found);
    args.stageMetrics.increment("external_search", "categories_requested", searchable.length);
    args.stageMetrics.increment("external_search", "queries", sourcePages.filter((page) => page.source_type === "search").length);
    args.stageMetrics.increment("external_search", "candidates", found.length);
    candidates.push(...directPlatformCandidates(location, categoriesToDiscover, args));
    return candidates;
  }

  const website = location.website_url;
  if (!website) return candidates;

  const rootHost = domain(website);
  const queue = seedWebsiteUrls(location, categoriesToDiscover);
  const seen = new Set();
  const externalSources = [];
  const crawlStartedAt = checkedAt();
  const crawlStartedMs = performance.now();

  let fetchedAnyWebsitePage = false;
  while (queue.length && seen.size < DISCOVERY_LIMITS.same_domain_pages) {
    const url = queue.shift();
    const key = normalizeUrlForCompare(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // Pace same-domain fetches so bursts across seeded paths (and sibling-location
    // runs on shared hosting) do not trip host rate limiting (observed 429 -> full block).
    if (fetchedAnyWebsitePage && !fixtureStore.replay) await sleep(WEBSITE_CRAWL_PAGE_DELAY_MS);
    const page = await fetchWebsitePageWithRetry(fixtureStore, url);
    fetchedAnyWebsitePage = true;
    sourcePages.push({
      url,
      final_url: page.final_url,
      http_status: page.http_status,
      source_type: "website",
      links_extracted: pageLinkEntries(page).length,
      fetch_attempts: page.fetch_attempts || 1
    });
    candidates.push(...candidatesFromPage(page, "website", url, categoriesToDiscover, location));

    // Recover from a common stale V2 configuration where the www host is dead
    // but the apex host is live. Otherwise, stop before every seeded path pays
    // the same browser and static-fetch timeout.
    if (page.http_status == null && pageLinkEntries(page).length === 0) {
      const failedUrl = new URL(ensureProtocol(url));
      if (seen.size === 1) {
        failedUrl.hostname = failedUrl.hostname.startsWith("www.") ? failedUrl.hostname.slice(4) : `www.${failedUrl.hostname}`;
        queue.length = 0;
        queue.push(failedUrl.toString());
        continue;
      }
      break;
    }

    for (const link of pageLinkEntries(page)) {
      const linkHost = domain(link.href);
      if (!linkHost) continue;
      if (sameWebsiteDomain(linkHost, rootHost) && seen.size + queue.length < DISCOVERY_LIMITS.same_domain_pages && shouldCrawlSameDomain(link.href, link.label)) {
        if (highSignalLocationCrawlLink(link.href, link.label, location)) queue.unshift(link.href);
        else queue.push(link.href);
      } else if (LINK_IN_BIO_HOSTS.some((host) => linkHost.endsWith(host)) && externalSources.length < DISCOVERY_LIMITS.external_link_in_bio_pages) {
        externalSources.push(link.href);
      }
    }
  }

  if (!fixtureStore.replay) {
    const sitemapUrl = new URL("/sitemap.xml", ensureProtocol(website)).toString();
    const sitemap = await fetchWebsitePageWithRetry(fixtureStore, sitemapUrl);
    const sitemapEntries = pageLinkEntries(sitemap);
    sourcePages.push({
      url: sitemapUrl,
      final_url: sitemap.final_url,
      http_status: sitemap.http_status,
      source_type: "sitemap",
      links_extracted: sitemapEntries.length,
      fetch_attempts: sitemap.fetch_attempts || 1
    });
    candidates.push(...candidatesFromPage(sitemap, "website", sitemapUrl, categoriesToDiscover, location));
  }

  for (const externalUrl of externalSources.slice(0, DISCOVERY_LIMITS.external_link_in_bio_pages)) {
    const page = await fixtureStore.fetchEvidence(externalUrl, "external-link-in-bio");
    sourcePages.push({ url: externalUrl, final_url: page.final_url, http_status: page.http_status, source_type: "external_link_in_bio" });
    candidates.push(...candidatesFromPage(page, "external_link_in_bio", externalUrl, categoriesToDiscover, location));
  }
  args.stageMetrics.stages.push({
    stage: "official_site_crawl",
    started_at: crawlStartedAt,
    duration_ms: Number((performance.now() - crawlStartedMs).toFixed(3)),
    outcome: "ok",
    counters: {
      pages_fetched: sourcePages.filter((page) => ["website", "sitemap", "external_link_in_bio"].includes(page.source_type)).length,
      candidates_extracted: candidates.length
    }
  });

  const officialCategories = new Set(candidates
    .filter((candidate) => candidate.source_type === "website")
    .map((candidate) => candidate.category));
  const searchCategories = categoriesToDiscover.filter((category) =>
    EXTERNAL_SEARCH_CATEGORIES.has(category) &&
    !officialCategories.has(category) &&
    !(category === "ordering" && officialCategories.has("order")) &&
    !(category === "order" && officialCategories.has("ordering"))
  );
  if (searchCategories.length) {
    const beforeSearchPages = sourcePages.length;
    const found = await args.stageMetrics.measure("external_search", async () => discoverSearchCandidates(location, searchCategories, fixtureStore, sourcePages, searchProvider));
    candidates.push(...found);
    args.stageMetrics.increment("external_search", "categories_requested", searchCategories.length);
    args.stageMetrics.increment("external_search", "queries", sourcePages.slice(beforeSearchPages).filter((page) => page.source_type === "search").length);
    args.stageMetrics.increment("external_search", "candidates", found.length);
  }
  candidates.push(...directPlatformCandidates(location, searchCategories, args));
  return candidates;
}

function websiteCrawlStatusFromSourcePages(location, sourcePages, args = {}) {
  if (!location.website_url) return "no_website";
  if (args["search-only"]) return "search_only";
  const websitePages = sourcePages.filter((page) => page.source_type === "website");
  if (!websitePages.length) return "not_attempted";
  const anyUseful = websitePages.some((page) =>
    (page.http_status != null && page.http_status !== 429 && page.http_status < 500) ||
    (page.links_extracted || 0) > 0);
  return anyUseful ? "ok" : "failed";
}

// The official site is the highest-confidence source for socials (see the socials
// write contract in blindWriteEligible). Retry total fetch failures and 429s with
// backoff before conceding, so transient rate limiting cannot silently reduce a
// location to search-only social discovery. Replay mode never retries: fixtures
// are deterministic and a recorded failure should replay as a failure.
async function fetchWebsitePageWithRetry(fixtureStore, url) {
  let page = await fixtureStore.fetchEvidence(url, "website");
  if (fixtureStore.replay) return page;
  let attempts = 1;
  for (const delayMs of WEBSITE_CRAWL_RETRY_DELAYS_MS) {
    const totalFailure = page.http_status == null && pageLinkEntries(page).length === 0;
    const rateLimited = page.http_status === 429;
    if (!totalFailure && !rateLimited) break;
    await sleep(delayMs);
    page = await fixtureStore.fetchEvidence(url, "website");
    attempts += 1;
  }
  page.fetch_attempts = attempts;
  return page;
}

async function discoverSearchCandidates(location, categoriesToDiscover, fixtureStore, sourcePages, searchProvider) {
  const searchTerms = buildSearchTerms(categoriesToDiscover, location);
  const out = [];
  const jobs = searchTerms.map((searchTerm) => ({
    searchTerm,
    query: searchQueryForTerm(location, searchTerm)
  }));
  const batched = typeof searchProvider.searchMany === "function"
    ? await searchProvider.searchMany(jobs.map((job) => job.query))
    : await Promise.all(jobs.map(async (job) => {
        try {
          return await searchProvider.search(job.query);
        } catch (error) {
          return { error_object: error };
        }
      }));
  for (let index = 0; index < jobs.length; index++) {
    const { searchTerm, query } = jobs[index];
    const { categoryHint } = searchTerm;
    const sourceKey = googleSearchSourceKey(query);
    const result = batched[index];
    if (result?.error_object) {
      const error = result.error_object;
      if (error.code === "missing_fixture") {
        sourcePages.push({
          url: sourceKey,
          source_type: "search",
          query,
          search_provider: searchProvider.name,
          search_status: "missing_fixture",
          organic_results: 0,
          organic_candidates: 0,
          error: error.message
        });
        continue;
      }
      throw error;
    }
    const extracted = extractSearchProviderCandidates(result, sourceKey, query, categoryHint, categoriesToDiscover, location);
    sourcePages.push({
      url: sourceKey,
      source_type: "search",
      query,
      category_hint: categoryHint,
      search_provider: searchProvider.name,
      search_status: result.status,
      organic_results: result.results?.length || 0,
      organic_candidates: extracted.length,
      error: result.error || null
    });
    if (result.status !== "ok") {
      if (fixtureStore.record && !fixtureStore.replay && ["blocked", "error"].includes(result.status)) fixtureStore.deleteEvidence("search", sourceKey);
      continue;
    }
    out.push(...extracted);
    if (searchProvider.name === "browser-google" && !fixtureStore.replay) await sleep(600);
  }
  return out;
}

function directPlatformCandidates(location, categoriesToDiscover, args = {}) {
  const out = [];
  if (categoriesToDiscover.includes("tiktok") && args["include-handle-guesses"]) {
    for (const handle of tiktokHandleGuesses(location)) {
      const item = candidate("tiktok", `https://www.tiktok.com/@${handle}`, "handle_guess", "tiktok-handle-pattern", [
        `handle_guess=${handle}`,
        "platform=tiktok"
      ]);
      if (item) out.push(item);
    }
  }
  return out;
}

function seedWebsiteUrls(location, categoriesToDiscover) {
  const website = ensureProtocol(location.website_url);
  if (!website) return [];
  const seeds = [website];
  const needsOrderOrMenu = categoriesToDiscover.some((category) => ["order", "ordering", "menu"].includes(category));
  const needsCareers = categoriesToDiscover.includes("careers_jobs");
  // Reservations/gift/loyalty/apps are discovered only when the official site
  // exposes them; never seed or search those review-only categories broadly.
  const needsCustomCategory = categoriesToDiscover.some((category) => ["catering", "events"].includes(category));
  if (!needsOrderOrMenu && !needsCareers && !needsCustomCategory) return seeds;
  try {
    const u = new URL(website);
    const base = u.origin;
    if (needsOrderOrMenu) {
      for (const pathPart of [
        "/menu",
        "/menu/",
        "/locations",
        "/locations/",
        "/order"
      ]) {
        seeds.push(new URL(pathPart, base).toString());
      }
      for (const pathPart of locationSpecificSeedPaths(location).slice(0, 5)) {
        seeds.push(new URL(pathPart, base).toString());
      }
    }
    if (needsCareers) {
      for (const pathPart of careerSeedPaths()) {
        seeds.push(new URL(pathPart, base).toString());
      }
    }
    if (needsCustomCategory) {
      for (const pathPart of customCategorySeedPaths(categoriesToDiscover)) {
        seeds.push(new URL(pathPart, base).toString());
      }
    }
  } catch {
    return seeds;
  }
  return [...new Set(seeds)];
}

function customCategorySeedPaths(categoriesToDiscover) {
  const out = [];
  if (categoriesToDiscover.includes("catering")) {
    out.push("/catering", "/catering/", "/order-catering", "/order-catering/", "/group-orders", "/group-orders/");
  }
  if (categoriesToDiscover.includes("events")) {
    out.push("/events", "/events/", "/private-events", "/private-events/", "/classes", "/classes/");
  }
  return out;
}

function careerSeedPaths() {
  return [
    "/careers",
    "/careers/",
    "/jobs",
    "/jobs/",
    "/employment",
    "/employment/",
    "/hiring",
    "/hiring/",
    "/now-hiring",
    "/now-hiring/",
    "/join-our-team",
    "/join-our-team/",
    "/join-the-team",
    "/join-the-team/",
    "/work-with-us",
    "/work-with-us/"
  ];
}

function locationSpecificSeedPaths(location) {
  const accountSlug = slugWords(cleanSearchName(location.account_name)).join("-");
  const locationSlug = slugWords(cleanSearchName(location.location_name)).join("-");
  const modifierSlug = locationModifierSlug(location);
  const citySlug = slugWords(location.shipping_city || cityFromFullAddress(location.address)).join("-");
  const streetSlug = streetSlugFromAddress(location.address || location.shipping_address_line1);
  const addressSlug = [citySlug, streetSlug].filter(Boolean).join("-");
  const directionalSlug = directionalLocationSlug(location);
  const out = new Set();
  for (const slug of [
    modifierSlug,
    directionalSlug,
    citySlug && modifierSlug && citySlug !== modifierSlug ? `${citySlug}-${modifierSlug}` : "",
    citySlug,
    addressSlug,
    streetSlug,
    locationSlug,
    accountSlug && modifierSlug && !accountSlug.includes(modifierSlug) ? `${accountSlug}-${modifierSlug}` : "",
    accountSlug
  ].filter(Boolean)) {
    out.add(`/${slug}-menus/`);
    out.add(`/${slug}-menu/`);
    out.add(`/menu/main-menu-${slug}/`);
    out.add(`/menu/${slug}/`);
    out.add(`/location/${slug}/`);
    out.add(`/locations/${slug}/`);
  }
  return [...out];
}

function locationModifierSlug(location) {
  const parenthetical = String(location.location_name || "").match(/\(([^)]+)\)/)?.[1] || "";
  const city = location.shipping_city || cityFromFullAddress(location.address) || "";
  const candidate = parenthetical || city;
  return slugWords(candidate).join("-");
}

function slugWords(value) {
  return normalizeText(value)
    .split(" ")
    .filter((word) => word.length > 1 && !["the", "and", "restaurant", "grill", "bar", "pizza", "pizzeria"].includes(word));
}

function streetSlugFromAddress(address) {
  const normalized = normalizeText(address)
    .replace(/\b(usa|united states)\b/g, " ")
    .replace(/\b(ste|suite|unit|apt|apartment|bldg|building|floor|fl)\b\s+\w+/g, " ")
    .replace(/\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl|circle|cir)\b/g, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  const stateIndex = words.findIndex((word, index) => /^[a-z]{2}$/.test(word) && words[index + 1]?.match(/^\d{5}$/));
  const addressWords = (stateIndex > 0 ? words.slice(0, stateIndex) : words).filter((word) => !["usa"].includes(word));
  return addressWords.slice(0, 5).join("-");
}

function directionalLocationSlug(location) {
  const city = slugWords(location.shipping_city || cityFromFullAddress(location.address)).join("-");
  if (!city) return "";
  const text = normalizeText(`${location.location_name} ${location.account_name} ${location.address}`);
  if (/\b(n|north)\b/.test(text)) return `${city}-north`;
  if (/\b(s|south)\b/.test(text)) return `${city}-south`;
  if (/\b(e|east)\b/.test(text)) return `${city}-east`;
  if (/\b(w|west)\b/.test(text)) return `${city}-west`;
  return "";
}

function buildSearchTerms(categoriesToDiscover, location = {}) {
  const hasAny = (categories) => categories.some((category) => categoriesToDiscover.includes(category));
  const needsApps = hasAny(["ios_app", "android_app", "app_downloads"]);
  const needsTikTok = categoriesToDiscover.includes("tiktok");
  const needsCustom = hasAny(["catering", "careers_jobs", "events", "reservations", "gift_cards", "loyalty_rewards", "other_custom"]);
  const websiteHost = domain(location.website_url);
  const terms = [
    hasAny(["instagram", "facebook", "youtube", "x_twitter"]) ? { categoryHint: null, term: "instagram facebook youtube" } : null,
    ...buildTikTokSearchTerms(needsTikTok, websiteHost),
    hasAny(["order", "ordering"]) ? { categoryHint: "order", term: "order online" } : null,
    categoriesToDiscover.includes("menu") ? { categoryHint: "menu", term: "menu" } : null,
    categoriesToDiscover.includes("careers_jobs") ? { categoryHint: "careers_jobs", term: "careers jobs" } : null,
    needsApps ? { categoryHint: "ios_app", term: "\"App Store\"" } : null,
    needsApps ? { categoryHint: "android_app", term: "\"Google Play\"" } : null,
    needsApps ? { categoryHint: "ios_app", term: "\"App Store\"", includeGeo: false, nameMode: "account" } : null,
    needsApps ? { categoryHint: "android_app", term: "\"Google Play\"", includeGeo: false, nameMode: "account" } : null,
    needsApps && websiteHost ? { categoryHint: "ios_app", term: `${websiteHost} "App Store"`, includeGeo: false, nameMode: "account" } : null,
    needsApps && websiteHost ? { categoryHint: "android_app", term: `${websiteHost} "Google Play"`, includeGeo: false, nameMode: "account" } : null,
    categoriesToDiscover.includes("catering") ? { categoryHint: "catering", term: "catering" } : null,
    categoriesToDiscover.includes("events") ? { categoryHint: "events", term: "events" } : null,
    categoriesToDiscover.includes("reservations") ? { categoryHint: "reservations", term: "reservations" } : null,
    needsCustom && categoriesToDiscover.includes("gift_cards") ? { categoryHint: "gift_cards", term: "gift cards" } : null,
    needsCustom && categoriesToDiscover.includes("loyalty_rewards") ? { categoryHint: "loyalty_rewards", term: "loyalty rewards" } : null,
    needsApps ? { categoryHint: "ios_app", term: "site:apps.apple.com app" } : null,
    needsApps ? { categoryHint: "android_app", term: "site:play.google.com/store/apps app" } : null,
  ];
  return uniqueSearchTerms(terms.filter(Boolean)).slice(0, DISCOVERY_LIMITS.search_queries);
}

function buildTikTokSearchTerms(needsTikTok, websiteHost) {
  if (!needsTikTok) return [];
  return [
    { categoryHint: "tiktok", term: "TikTok site:tiktok.com/@" },
    { categoryHint: "tiktok", term: "TikTok site:tiktok.com/@", includeGeo: false, nameMode: "account" },
    websiteHost ? { categoryHint: "tiktok", term: `${websiteHost} TikTok site:tiktok.com/@`, includeGeo: false, nameMode: "account" } : null
  ].filter(Boolean);
}

function uniqueSearchTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const key = [
      term.categoryHint || "",
      term.term || "",
      term.includeGeo === false ? "no-geo" : "geo",
      term.nameMode || ""
    ].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

function searchQueryForTerm(location, searchTerm) {
  const name = searchNameForTerm(location, searchTerm);
  const geo = searchTerm.includeGeo === false ? "" : `${location.shipping_city || ""} ${location.shipping_state || ""}`;
  return normalizedSearchQuery(`${name} ${geo} ${searchTerm.term}`);
}

function searchNameForTerm(location, searchTerm) {
  if (searchTerm.nameMode === "account") return location.account_name || cleanSearchName(location.location_name) || "";
  if (searchTerm.nameMode === "clean") return cleanSearchName(location.location_name) || location.account_name || "";
  return location.location_name || location.account_name || "";
}

function cleanSearchName(value) {
  return String(value || "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

function candidateRelevantForDiscovery(category, categoriesToDiscover) {
  if (categoriesToDiscover.includes(category)) return true;
  return (category === "order" && categoriesToDiscover.includes("ordering")) ||
    (category === "ordering" && categoriesToDiscover.includes("order"));
}

function candidateGroupsForCategory(candidatesByCategory, category) {
  const exact = candidatesByCategory.get(category) || [];
  if (category === "order") return [...exact, ...(candidatesByCategory.get("ordering") || [])];
  if (category === "ordering") return [...(candidatesByCategory.get("order") || []), ...exact];
  return exact;
}

function existingForCategory(existingByCategory, category) {
  const exact = existingByCategory.get(category);
  if (category === "order") return exact || existingByCategory.get("ordering") || null;
  if (category === "ordering") return existingByCategory.get("order") || exact || null;
  if (exact) return exact;
  return null;
}

function extractSearchProviderCandidates(searchResult, sourceKey, query, categoryHint, categoriesToDiscover, location = {}) {
  const out = [];
  const seen = new Set();
  const results = searchResult.results || [];
  for (const item of results) {
    const href = unwrapGoogleResultUrl(item.url);
    if (!href || isGoogleInternalUrl(href)) continue;
    if (isAdUrl(href) || isJunkLink(href, "")) continue;
    const category = categoryForSearchResult(href, item, categoryHint);
    if (!category || !candidateRelevantForDiscovery(category, categoriesToDiscover)) continue;
    if (category === "tiktok" && !tiktokSearchResultLooksRelevant(href, item, location)) continue;
    const key = `${category}:${normalizeUrlForCompare(href)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidateItem = candidate(category, href, "search", sourceKey, [
      `query=${query}`,
      `search_provider=${searchResult.provider || "unknown"}`,
      "google_organic_candidate=true",
      item.rank ? `rank=${item.rank}` : null,
      item.title ? `title=${item.title}` : null
    ].filter(Boolean));
    if (candidateItem) out.push(candidateItem);
    if (out.length >= 8) break;
  }
  return out;
}

function tiktokSearchResultLooksRelevant(href, item, location) {
  const canonical = canonicalSocialCandidateUrl("tiktok", href);
  if (canonical === null) return false;
  const compactHaystack = compactText([canonical || href, item?.title, item?.snippet].filter(Boolean).join(" "));
  if (!compactHaystack) return false;
  return tiktokIdentityNeedles(location).some((needle) => compactHaystack.includes(needle));
}

function tiktokIdentityNeedles(location) {
  const names = [
    location.account_name,
    location.location_name,
    cleanSearchName(location.location_name),
    domain(location.website_url)?.replace(/\.[a-z]{2,}$/i, "")
  ];
  const needles = new Set();
  for (const name of names) {
    const compact = compactText(name);
    if (compact.length >= 5) needles.add(compact);
  }
  return [...needles].filter((needle) => needle.length >= 4);
}

function tiktokHandleGuesses(location) {
  const guesses = new Set();
  for (const name of [location.account_name, cleanSearchName(location.location_name)]) {
    const words = handleWords(name);
    if (words.length < 2) continue;
    guesses.add(words.join("."));
    guesses.add(words.join(""));
    guesses.add(words.join("_"));
  }
  const host = domain(location.website_url);
  if (host) {
    const stem = host.replace(/\.[a-z]{2,}$/i, "");
    const words = handleWords(stem);
    if (words.length) {
      guesses.add(words.join(""));
      guesses.add(words.join("."));
      guesses.add(words.join("_"));
    }
  }
  return [...guesses].filter((handle) => handle.length >= 4 && handle.length <= 24);
}

function handleWords(value) {
  return normalizeText(value)
    .split(" ")
    .map((word) => word.replace(/[^a-z0-9._]/g, ""))
    .filter(Boolean);
}

function createSearchProvider(args, fixtureStore) {
  const provider = args["search-provider"] || DEFAULT_SEARCH_PROVIDER;
  if (provider === "dataforseo") return new DataForSeoSearchProvider(fixtureStore, args);
  if (provider === "browser-google") return new BrowserGoogleSearchProvider(fixtureStore);
  throw new Error(`Unsupported --search-provider '${provider}'. Use dataforseo or browser-google.`);
}

function categoryForSearchResult(href, item, categoryHint) {
  const category = categoryForUrl(href, [item?.title, item?.snippet].filter(Boolean).join(" "));
  if (category) return category;
  return fallbackCategoryHint(href, categoryHint);
}

class DataForSeoSearchProvider {
  constructor(fixtureStore, args = {}) {
    this.fixtureStore = fixtureStore;
    this.credentialArgs = args;
    this.credentials = null;
    this.name = "dataforseo";
  }

  async search(query) {
    const sourceKey = googleSearchSourceKey(query);
    if (this.fixtureStore.replay) return readSearchFixture(this.fixtureStore, sourceKey);

    const liveResult = await this.fetchLive(query);
    const normalized = {
      provider: this.name,
      query: normalizedSearchQuery(query),
      status: liveResult.status,
      results: liveResult.results || [],
      raw: liveResult.raw || null,
      error: liveResult.error || null
    };
    if (this.fixtureStore.record && ["ok", "empty"].includes(normalized.status)) {
      this.fixtureStore.writeEvidence("search", sourceKey, normalized);
    }
    return normalized;
  }

  async searchMany(queries) {
    if (this.fixtureStore.replay) {
      return Promise.all(queries.map(async (query) => {
        try {
          return await this.search(query);
        } catch (error) {
          return { error_object: error };
        }
      }));
    }
    // The SERP Live endpoint accepts exactly one task per request. Keep the
    // multi-query API for callers, but pace individual live requests so one
    // invalid batch cannot erase every fallback category in a run.
    const results = [];
    for (const query of queries) {
      try {
        results.push(await this.search(query));
      } catch (error) {
        results.push({ error_object: error });
      }
    }
    return results;
  }

  async fetchLive(query) {
    const credentials = this.credentials ??= dataForSeoCredentials(this.credentialArgs);
    if (!credentials) {
      throw new Error("Boostly DataForSEO Keychain credentials are required for live search. Replay mode does not require credentials.");
    }
    const auth = Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64");
    const body = [{
      keyword: normalizedSearchQuery(query),
      location_code: 2840,
      language_code: "en",
      device: "desktop",
      depth: 10
    }];

    const response = await fetchDataForSeoWithRetry(body, auth);
    if (response.status === "error") return response;

    const raw = response.raw;
    if (raw?.status_code !== 20000) {
      return { status: "error", results: [], raw, error: `DataForSEO ${raw?.status_code || "unknown"}: ${raw?.status_message || "top-level error"}` };
    }
    const task = raw.tasks?.[0];
    if (!task || task.status_code !== 20000) {
      if (task?.status_code === 40102) {
        return { status: "empty", results: [], raw, error: task.status_message || "No Search Results." };
      }
      return { status: "error", results: [], raw, error: `DataForSEO task ${task?.status_code || "missing"}: ${task?.status_message || "task error"}` };
    }

    const items = task.result?.[0]?.items || [];
    const results = items
      .filter((item) => item?.type === "organic" && item.url)
      .map((item) => ({
        url: item.url,
        title: item.title || "",
        snippet: item.description || "",
        rank: item.rank_absolute || item.rank_group || null
      }));
    return { status: results.length ? "ok" : "empty", results, raw, error: null };
  }
}

function normalizeDataForSeoTask(provider, query, raw, task) {
  if (raw?.status_code !== 20000) {
    return { provider, query, status: "error", results: [], raw, error: `DataForSEO ${raw?.status_code || "unknown"}: ${raw?.status_message || "top-level error"}` };
  }
  if (!task || task.status_code !== 20000) {
    if (task?.status_code === 40102) return { provider, query, status: "empty", results: [], raw: task || raw, error: task?.status_message || "No Search Results." };
    return { provider, query, status: "error", results: [], raw: task || raw, error: `DataForSEO task ${task?.status_code || "missing"}: ${task?.status_message || "task error"}` };
  }
  const items = task.result?.[0]?.items || [];
  const results = items
    .filter((item) => item?.type === "organic" && item.url)
    .map((item) => ({ url: item.url, title: item.title || "", snippet: item.description || "", rank: item.rank_absolute || item.rank_group || null }));
  return { provider, query: normalizedSearchQuery(query), status: results.length ? "ok" : "empty", results, raw: task, error: null };
}

class BrowserGoogleSearchProvider {
  constructor(fixtureStore) {
    this.fixtureStore = fixtureStore;
    this.name = "browser-google";
  }

  async search(query) {
    const sourceKey = googleSearchSourceKey(query);
    if (this.fixtureStore.replay) return readSearchFixture(this.fixtureStore, sourceKey);
    try {
      const page = await this.fixtureStore.fetchEvidence(googleSearchUrl(query), "search", sourceKey);
      if (isBlockedSearchPage(page)) return browserSearchFailure("blocked", query, page);
      const result = searchResultFromBrowserPage(query, page, this.name);
      if (this.fixtureStore.record && result.status !== "ok") this.fixtureStore.deleteEvidence("search", sourceKey);
      return result;
    } catch (error) {
      if (error instanceof SearchBlockedError || error.code === "search_blocked") {
        return { provider: this.name, query: normalizedSearchQuery(query), status: "blocked", results: [], raw: error.page || null, error: error.message };
      }
      throw error;
    }
  }
}

function readSearchFixture(fixtureStore, sourceKey) {
  const evidence = fixtureStore.readEvidence("search", sourceKey);
  if (evidence.provider && Array.isArray(evidence.results)) return evidence;
  if (Array.isArray(evidence.results)) {
    return {
      provider: evidence.provider || "unknown",
      query: normalizedSearchQuery(evidence.query || sourceKey.replace(/^google-search:/, "")),
      status: evidence.status || (evidence.results.length ? "ok" : "empty"),
      results: evidence.results,
      raw: evidence.raw || evidence,
      error: evidence.error || null
    };
  }
  return searchResultFromBrowserPage(sourceKey.replace(/^google-search:/, ""), evidence, "browser-google");
}

function searchResultFromBrowserPage(query, page, provider) {
  if (isBlockedSearchPage(page)) return browserSearchFailure("blocked", query, page);
  const results = [];
  const seen = new Set();
  for (const rawHref of page.links || []) {
    const href = unwrapGoogleResultUrl(rawHref);
    if (!href || isGoogleInternalUrl(href)) continue;
    if (isAdUrl(href) || isJunkLink(href, "")) continue;
    const key = normalizeUrlForCompare(href);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push({ url: href, title: "", snippet: "", rank: results.length + 1 });
    if (results.length >= 10) break;
  }
  return {
    provider,
    query: normalizedSearchQuery(query),
    status: results.length ? "ok" : "empty",
    results,
    raw: page,
    error: results.length ? null : "No organic search result links extracted."
  };
}

function browserSearchFailure(status, query, page) {
  return {
    provider: "browser-google",
    query: normalizedSearchQuery(query),
    status,
    results: [],
    raw: page,
    error: status === "blocked" ? "Google search page blocked or consent-gated." : "No organic search result links extracted."
  };
}

async function fetchDataForSeoWithRetry(body, auth, { request = fetch, pause = sleep } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await request(DATAFORSEO_SERP_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "authorization": `Basic ${auth}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      }).finally(() => clearTimeout(timeout));
      const text = await response.text();
      let raw;
      try {
        raw = text ? JSON.parse(text) : null;
      } catch {
        raw = { status_message: text.slice(0, 500) };
      }
      if (response.status >= 500 && attempt === 0) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        await pause(1000);
        continue;
      }
      if (attempt === 0 && raw?.status_code === 20000 && raw.tasks?.length === 1 && raw.tasks[0].status_code === 40101) {
        lastError = "DataForSEO internal search-engine error";
        await pause(1000);
        continue;
      }
      if (!response.ok && !raw?.status_code) {
        return { status: "error", results: [], raw, error: `HTTP ${response.status}: ${raw?.status_message || response.statusText}` };
      }
      return { status: "ok", raw };
    } catch (error) {
      lastError = error.name === "AbortError" ? "DataForSEO request timed out" : String(error.message || error);
      if (attempt === 0) {
        await pause(1000);
        continue;
      }
    }
  }
  return { status: "error", results: [], raw: null, error: lastError || "DataForSEO request failed" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function googleSearchUrl(query) {
  const normalized = normalizedSearchQuery(query);
  const params = new URLSearchParams();
  params.set("q", normalized);
  params.set("hl", "en");
  params.set("gl", "us");
  params.set("udm", "14");
  params.set("num", "10");
  return `https://www.google.com/search?${params.toString()}`;
}

function googleSearchSourceKey(query) {
  return `google-search:${normalizedSearchQuery(query)}`;
}

function normalizedSearchQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unwrapGoogleResultUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, "https://www.google.com");
    if ((url.hostname.endsWith("google.com") || url.hostname.endsWith("googleusercontent.com")) && url.pathname === "/url") {
      return url.searchParams.get("q") || url.searchParams.get("url") || "";
    }
    if (url.hostname.endsWith("google.com") && url.pathname === "/aclk") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function isGoogleInternalUrl(value) {
  const host = domain(value);
  if (!host) return true;
  if (host === "play.google.com") return false;
  return host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "googleusercontent.com" ||
    host.endsWith(".googleusercontent.com") ||
    host === "gstatic.com" ||
    host.endsWith(".gstatic.com");
}

function isAdUrl(value) {
  const host = domain(value);
  const text = String(value || "").toLowerCase();
  return host.includes("googleadservices.com") ||
    host.includes("syndicatedsearch") ||
    text.includes("/aclk?") ||
    text.includes("adurl=");
}

function isBlockedSearchPage(page) {
  const host = domain(page.final_url || page.input_url);
  const text = normalizeText([page.final_url, page.title, page.text, page.h1?.join(" "), page.h2?.join(" ")].filter(Boolean).join(" "));
  return host === "consent.google.com" ||
    /google\.com\/sorry/.test(String(page.final_url || "")) ||
    /unusual traffic|our systems have detected|before you continue to google|consent|captcha/.test(text);
}

class SearchBlockedError extends Error {
  constructor(query, page) {
    const status = page?.status || "blocked";
    const detail = page?.final_url || page?.input_url || page?.error || status || "no_url";
    super(`search_blocked_or_empty: ${query} (${detail})`);
    this.code = status === "error" ? "search_error" : "search_blocked";
    this.query = query;
    this.status = status;
    this.page = page || null;
  }
}

function candidatesFromPage(page, sourceType, sourceUrl, categoriesToDiscover, location = {}) {
  const out = [];
  const pageCategory = categoryForUrl(sourceUrl, [page.title, ...(page.h1 || [])].filter(Boolean).join(" "));
  if (pageCategory && candidateRelevantForDiscovery(pageCategory, categoriesToDiscover)) {
    if (pageCategory !== "order") {
      const item = candidate(pageCategory, sourceUrl, sourceType, sourceUrl, [
        `page_url_matches_${pageCategory}`,
        page.title
      ].filter(Boolean));
      if (item) out.push(item);
    } else {
      // Seeded official-site paths like /order and /online-order are useful crawl targets, but
      // should not become write candidates merely because the guessed path loaded or bot-gated.
      // Actual order candidates should come from extracted official-site links/buttons or known providers.
    }
  }

  for (const link of pageLinkEntries(page)) {
    const href = link.href;
    const rawLabel = link.label || "";
    const label = rawLabel || linkLabelFromUrl(href);
    const category = categoryForUrl(href, label);
    if (!category || !candidateRelevantForDiscovery(category, categoriesToDiscover)) continue;
    if (isJunkLink(href, label)) continue;
    if (category === "order") {
      if (!isOfficialWebsiteOrderSource(sourceType)) continue;
      if (isOrderTrapUrl(href, label)) continue;
      if (sameUrl(href, sourceUrl) && categoryForUrl(sourceUrl, "") === "order") continue;
    }
    if (category === "careers_jobs" && isCareersTrapUrl(href, label)) continue;
    const item = candidate(category, href, sourceType, sourceUrl, [
      `anchor_or_url=${label || href}`,
      link.source ? `link_source=${link.source}` : null,
      ...orderDiscoveryEvidence(category, href, rawLabel, sourceUrl, location),
      ...careerDiscoveryEvidence(category, href, rawLabel, sourceType, sourceUrl)
    ].filter(Boolean));
    if (item) out.push(item);
  }
  return out;
}

function pageLinkEntries(page) {
  if (Array.isArray(page.labeled_links) && page.labeled_links.length) {
    return page.labeled_links
      .map((link) => ({
        href: typeof link === "string" ? link : link.href,
        label: typeof link === "string" ? "" : link.label || "",
        source: typeof link === "string" ? "" : link.source || ""
      }))
      .filter((link) => link.href);
  }
  return (page.links || []).map((href) => ({ href, label: "", source: "" }));
}

function candidate(category, url, sourceType, sourceUrl, evidence = []) {
  const canonical = canonicalCandidateUrl(category, url);
  if (canonical === null) return null;
  const inputUrl = canonical || cleanCandidateUrl(url);
  return {
    category,
    input_url: inputUrl,
    final_url: null,
    source_type: sourceType,
    source_url: sourceUrl,
    source_evidence: inputUrl !== cleanCandidateUrl(url)
      ? [`canonicalized_candidate_from=${cleanCandidateUrl(url)}`, ...evidence]
      : evidence,
    link_type: verifierLinkTypeForCategory(category),
    title: categoryTitle(category)
  };
}

function fallbackCategoryHint(value, categoryHint) {
  if (!categoryHint) return null;
  const host = domain(value);
  if (categoryHint === "order" && isKnownOrderProviderHost(host)) return "order";
  if (categoryHint === "careers_jobs" && !isAggregatorDomain(host)) return "careers_jobs";
  if (categoryHint === "ios_app" && host === "apps.apple.com") return "ios_app";
  if (categoryHint === "android_app" && host === "play.google.com") return "android_app";
  if (categoryHint === "tiktok" && isTikTokHost(host)) return "tiktok";
  return null;
}

function canonicalCandidateUrl(category, value) {
  const social = canonicalSocialCandidateUrl(category, value);
  if (social !== "") return social;
  if (category === "order" || category === "ordering") return canonicalOrderCandidateUrl(value);
  return "";
}

function canonicalSocialCandidateUrl(category, value) {
  if (!["instagram", "facebook", "tiktok", "youtube", "x_twitter"].includes(category)) return "";
  try {
    const u = new URL(ensureProtocol(value));
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);

    if (host === "instagram.com") {
      const handle = parts[0] || "";
      if (!handle || ["p", "reel", "reels", "stories", "explore", "accounts"].includes(handle.toLowerCase())) return null;
      return `https://www.instagram.com/${handle}/`;
    }

    if (isTikTokHost(host)) {
      const handle = parts.find((part) => part.startsWith("@"));
      return handle ? `https://www.tiktok.com/${handle.toLowerCase()}` : null;
    }

    if (host === "facebook.com") {
      if (u.pathname === "/profile.php") {
        const id = cleanQueryValue(u.searchParams.get("id"));
        return id ? `https://www.facebook.com/profile.php?id=${id}` : null;
      }
      if (["people", "pages"].includes(parts[0]?.toLowerCase())) {
        const id = [...parts].reverse().find((part) => /^\d{8,}$/.test(part));
        return id ? `https://www.facebook.com/profile.php?id=${id}` : null;
      }
      const pIndex = parts.findIndex((part) => part.toLowerCase() === "p");
      const pageId = pIndex >= 0 ? parts[pIndex + 1]?.match(/(?:^|-)(\d{8,})$/)?.[1] : "";
      if (pageId) return `https://www.facebook.com/profile.php?id=${pageId}`;
      const page = parts[0] || "";
      if (!page || ["groups", "watch", "reel", "share", "sharer", "events", "marketplace"].includes(page.toLowerCase())) return null;
      return `https://www.facebook.com/${page}`;
    }

    if (host === "youtube.com") {
      const [prefix, identifier] = parts;
      if (prefix?.startsWith("@")) return `https://www.youtube.com/${prefix.toLowerCase()}`;
      if (["channel", "c", "user"].includes(prefix?.toLowerCase()) && identifier) {
        return `https://www.youtube.com/${prefix.toLowerCase()}/${identifier}`;
      }
      if (["watch", "shorts", "playlist", "embed", "feed", "results"].includes(prefix?.toLowerCase())) return null;
      return null;
    }

    if (host === "youtu.be") return null;

    if (host === "x.com" || host === "twitter.com") {
      const handle = parts[0] || "";
      if (!handle || ["i", "intent", "share", "search"].includes(handle.toLowerCase())) return null;
      return `https://x.com/${handle}`;
    }
  } catch {
    return "";
  }
  return "";
}

function canonicalOrderCandidateUrl(value) {
  try {
    const u = new URL(ensureProtocol(value));
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);

    if (host === "order.toasttab.com" && parts[0] === "online" && parts[1]) {
      return `https://order.toasttab.com/online/${parts[1]}`;
    }

    if (host === "toasttab.com" && parts[0] === "local" && parts[1] === "order" && parts[2]) {
      return `https://order.toasttab.com/online/${parts[2]}`;
    }

    if (host === "online.skytab.com" && parts[0]) {
      return `https://online.skytab.com/${parts[0]}`;
    }

    if (host === "order.online") {
      const storeIndex = parts.findIndex((part) => part.toLowerCase() === "store");
      if (storeIndex >= 0 && /^\d+$/.test(parts[storeIndex + 1] || "")) {
        return `https://order.online/store/${parts[storeIndex + 1]}`;
      }
    }

    if (host === "order.spoton.com") {
      const id = [...parts].reverse().find((part) => /^[a-z0-9]{16,}$/i.test(part));
      if (id) return `https://order.spoton.com/${id}`;
    }

    if (host.endsWith("ordercounter.com")) {
      return `https://${host}${parts[0] ? `/${parts[0]}` : ""}`;
    }
  } catch {
    return "";
  }
  return "";
}

function isKnownOrderProviderHost(host) {
  return ["order.online", "order.toasttab.com", "toasttab.com", "order.spoton.com", "online.skytab.com", "chownow.com", "doordash.com", "ubereats.com", "ordercounter.com", "hrpos.heartland.us"].some((provider) => host === provider || host.endsWith(`.${provider}`)) ||
    host.endsWith("cloveronline.com") ||
    host.endsWith("zenpepper.com");
}

function isOfficialWebsiteOrderSource(sourceType) {
  return sourceType === "website";
}

function isOrderTrapUrl(href, label = "") {
  const raw = String(`${href} ${label}`).toLowerCase();
  if (/https?:\/\/(?:www\.)?online\.skytab\.com\/[^/\s?#]+\/order-settings/i.test(raw)) return false;
  if (/\/(?:tag|tags|category|categories|blog|posts?|articles?|news)\//i.test(raw)) return true;
  if (/\/(?:faqs?|help|support)(?:[-/]|$)/i.test(raw)) return true;
  const text = normalizeText(raw);
  return /(gift|egift|giftcard|gift-card|giftcards|egiftcards|cardfoundry|marketing-signup|newsletter|order-settings|ordering-unavailable|menu-item|item=|product=|download-app|app-download)/i.test(raw) ||
    /\b(admin|settings|login|account|tracking|track order|order status|unavailable|closed|locator|our locator|find us|download app|with app)\b/.test(text);
}

function orderDiscoveryEvidence(category, href, label, sourceUrl, location) {
  if (category !== "order" && category !== "ordering") return [];
  const evidence = ["official_site_order_candidate=true"];
  const candidateHost = domain(href);
  const websiteHost = domain(location.website_url);
  if (isKnownOrderProviderHost(candidateHost)) evidence.push(`known_order_provider=${candidateHost}`);
  if (isOrderingSubdomain(candidateHost, websiteHost)) evidence.push("ordering_subdomain=true");
  if (/\b(order|order online|online order|ordering|pickup|delivery|start order|order now|olo)\b/.test(normalizeText(label))) evidence.push("order_cta_text=true");
  const locationScore = orderLocationScore([href, label, sourceUrl].join(" "), location);
  if (locationScore) evidence.push(`order_location_score=${locationScore}`);
  const sourcePageScore = orderLocationScore(sourceUrl, location);
  if (sourcePageScore) evidence.push(`source_page_location_score=${sourcePageScore}`);
  evidence.push(`order_candidate_score=${orderDiscoveryScore({ href, label, sourceUrl, location })}`);
  return evidence;
}

function orderDiscoveryScore({ href, label, sourceUrl, location }) {
  const candidateHost = domain(href);
  const websiteHost = domain(location.website_url);
  let score = 0;
  if (isKnownOrderProviderHost(candidateHost)) score += 130;
  if (isOrderingSubdomain(candidateHost, websiteHost)) score += 130;
  score += orderProviderPreferenceScore(candidateHost);
  if (sameWebsiteDomain(candidateHost, websiteHost)) score += 35;
  if (/\b(order now|order online|online order|ordering|pickup|delivery|start order)\b/.test(normalizeText(label))) score += 60;
  score += orderLocationScore([href, sourceUrl, label].join(" "), location);
  if (/(doordash|ubereats|grubhub)/i.test(href)) score -= 25;
  if (isOrderTrapUrl(href, label)) score -= 500;
  return score;
}

function isOrderingSubdomain(candidateHost, websiteHost) {
  if (!candidateHost || !websiteHost) return false;
  if (!sameWebsiteDomain(candidateHost, websiteHost)) return false;
  return /^(order|orders|online|ordering|olo|direct)\./i.test(candidateHost);
}

function sameWebsiteDomain(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`) || registrableDomain(a) === registrableDomain(b);
}

function registrableDomain(host) {
  return String(host || "").replace(/^www\./, "").split(".").filter(Boolean).slice(-2).join(".");
}

function orderLocationScore(value, location) {
  const haystack = normalizeText(value);
  const tokens = orderLocationTokens(location);
  let score = 0;
  for (const token of tokens.exact) {
    if (token && haystack.includes(token)) score += 40;
  }
  for (const token of tokens.strong) {
    if (token && haystack.includes(token)) score += 30;
  }
  for (const token of tokens.medium) {
    if (token && haystack.includes(token)) score += 12;
  }
  for (const token of tokens.weak) {
    if (token && haystack.includes(token)) score += 5;
  }
  return score;
}

function orderLocationTokens(location) {
  const address = normalizeText(location.address || location.shipping_address_line1 || "");
  const name = normalizeText(location.location_name);
  const account = normalizeText(location.account_name);
  const streetNumberToken = address.match(/\b\d{2,6}\b/)?.[0] || "";
  const streetWords = address
    .replace(/\b(usa|united states|st|street|ave|avenue|rd|road|blvd|boulevard|unit|ste|suite|w|e|n|s)\b/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .slice(0, 4);
  const parenthetical = normalizeText(name.match(/\(([^)]+)\)/)?.[1] || "");
  const city = normalizeText(location.shipping_city || cityFromFullAddress(location.address) || parenthetical);
  const state = normalizeText(location.shipping_state || stateFromFullAddress(location.address));
  const locationNameWords = name
    .replace(account, " ")
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4);
  return {
    exact: [...new Set([streetNumberToken, parenthetical, `${streetNumberToken} ${streetWords[0] || ""}`].map(normalizeText).filter((token) => token.length >= 3))],
    strong: [...new Set([...streetWords, ...locationNameWords].map(normalizeText).filter(Boolean))],
    medium: [...new Set([city, state].map(normalizeText).filter(Boolean))],
    weak: [...new Set(account.split(/\s+/).filter((word) => word.length >= 5))]
  };
}

function cityFromFullAddress(address) {
  const parts = String(address || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return parts.at(-2) || "";
  return "";
}

function fulfillmentLocationContext(row) {
  if (!String(row.address || "").trim()) throw new Error("Fulfillment discovery requires the database location address");
  const physical = { ...row, shipping_address_line1: "", shipping_city: "", shipping_state: "", shipping_zip: "" };
  // The verifier's legacy shipping_* fields carry normalized geographic hints.
  // Derive those hints from the restaurant address, never its shipping destination.
  return { ...physical, ...normalizeLocation(physical), identity_address_source: "locations.address" };
}

function stateFromFullAddress(address) {
  return String(address || "").match(/,\s*([A-Z]{2})\s+\d{5}/)?.[1] || "";
}

function isTikTokHost(host) {
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

function resolveCategories({ location, existingByCategory, candidatesByCategory, hiddenExisting, touchpoint_events }) {
  const results = [];
  const menu = bestByStatus(candidateGroupsForCategory(candidatesByCategory, "menu"), "menu", location);
  const order = bestByStatus(candidateGroupsForCategory(candidatesByCategory, "order"), "order", location);
  const menuSameAsOrder = menu?.status === "verified" && order?.status === "verified" && sameUrl(menu.final_url || menu.input_url, order.final_url || order.input_url);

  for (const category of CATEGORY_SET) {
    const existing = hiddenExisting ? null : existingForCategory(existingByCategory, category);
    const candidates = candidateGroupsForCategory(candidatesByCategory, category);
    const selected = bestByStatus(candidates, category, location);
    const candidateConflict = conflictingTopCandidates(candidates, category, location);
    let status = "not_found";
    let action = "noop";
    let replaces = null;

    if (existing) {
      if (existing.status === "verified") {
        status = "existing_verified";
      } else if (existing.status === "needs_manual_review") {
        status = "existing_needs_manual_review";
      } else {
        const replacement = category === "careers_jobs" && selected?.status === "verified"
          ? selected
          : candidates.find((link) => link.status === "verified");
        if (replacement) {
          if (!blindWriteEligible(category, replacement, location, existing)) {
            status = shouldManualReviewCandidate(category, replacement, location) ? "needs_manual_review" : existing.status === "broken" ? "existing_broken" : "existing_rejected";
          } else {
            status = "found_verified";
            action = "update";
            replaces = existing.status === "broken" ? "existing_broken" : "existing_rejected";
          }
        } else {
          status = existing.status === "broken" ? "existing_broken" : "existing_rejected";
        }
      }
    } else if (selected) {
      if (selected.status === "verified") {
        if (!blindWriteEligible(category, selected, location, existing)) {
          status = shouldManualReviewCandidate(category, selected, location) ? "needs_manual_review" : "found_rejected";
        } else if (hasConfiguredUrlInOtherTouchpoint(category, selected, touchpoint_events)) {
          status = "needs_manual_review";
        } else {
          status = "found_verified";
          action = hasConfiguredCategory(category, touchpoint_events) ? "noop" : "create";
        }
      } else if (selected.status === "needs_manual_review") {
        status = shouldManualReviewCandidate(category, selected, location) ? "needs_manual_review" : "found_rejected";
      } else if (selected.status === "broken") {
        status = "found_broken";
      } else {
        status = "found_rejected";
      }
    } else if (!location.website_url && !hiddenExisting) {
      status = "blocked_by_missing_context";
    }

    if (menuSameAsOrder && category === "menu" && status === "found_verified") action = "noop";
    if (candidateConflict && status === "found_verified") {
      status = "needs_manual_review";
      action = "noop";
    }

    results.push({
      category,
      category_status: status,
      proposed_action: action,
      selected_link: selected ? toCandidateRecord(selected) : null,
      existing_link: existing ? toCandidateRecord(existing) : null,
      replaces_existing_status: replaces,
      candidate_conflict: candidateConflict,
      evidence: menuSameAsOrder && (category === "menu" || category === "order") ? ["menu_same_as_order=true"] : []
    });
  }
  return results;
}

function buildProposals(categoryResults, touchpointEvents, args = {}) {
  const locationUpdates = [];
  const touchpointEventsOut = [];
  const maxSort = Math.max(0, ...touchpointEvents.map((event) => Number(event.sort_order) || 0));
  let nextSortOffset = 1;
  const plannedTouchpointUrls = new Set();

  for (const result of categoryResults) {
    const link = result.selected_link;
    if (!link || link.status !== "verified" || result.proposed_action === "noop") continue;
    if (!blindWriteEligible(result.category, link, null, result.existing_link)) continue;
    if (hasConfiguredUrlInOtherTouchpoint(result.category, link, touchpointEvents)) continue;
    if (!args["allow-updates"] && result.existing_link?.input_url) continue;
    if (LOCATION_FIELD_BY_CATEGORY[result.category]) {
      locationUpdates.push({
        field_name: LOCATION_FIELD_BY_CATEGORY[result.category],
        current_value: result.existing_link?.input_url || null,
        proposed_value: proposalUrlForLink(result.category, link),
        action: result.proposed_action,
        verification: link,
        write_gate: writeGateDetails(result.category, link)
      });
    }
    if (TOUCHPOINT_ORDER.includes(result.category)) {
      const proposedUrl = proposalUrlForLink(result.category, link);
      const proposedUrlKey = normalizeTouchpointUrlForCompare(proposedUrl);
      if (proposedUrlKey && plannedTouchpointUrls.has(proposedUrlKey)) continue;
      if (proposedUrlKey) plannedTouchpointUrls.add(proposedUrlKey);
      touchpointEventsOut.push({
        touchpoint_category: result.category,
        title: categoryTitle(result.category),
        display_title: result.category === "careers_jobs" ? "Join Our Team" : categoryTitle(result.category),
        description: "",
        primary_button_text: result.category === "careers_jobs" ? "Apply Now" : "",
        url: proposedUrl,
        sort_order: maxSort + nextSortOffset++,
        action: result.proposed_action,
        verification: link,
        write_gate: writeGateDetails(result.category, link)
      });
    }
  }
  touchpointEventsOut.sort((a, b) => TOUCHPOINT_ORDER.indexOf(a.touchpoint_category) - TOUCHPOINT_ORDER.indexOf(b.touchpoint_category));
  return { locationUpdates, touchpointEvents: touchpointEventsOut };
}

function writeGateDetails(category, link) {
  const customDestinationSpecific = CUSTOM_DESTINATION_CATEGORIES.has(category)
    ? customCategoryDestinationSpecific(category, link)
    : false;
  return {
    fill_only_default: true,
    verified_via: "content_or_link_evidence",
    order_challenge_carveout: false,
    custom_destination_specific: customDestinationSpecific,
    upcoming_event_evidence: category === "events" ? hasUpcomingEventEvidence(link) : null
  };
}

function proposalUrlForLink(category, link) {
  if (SOCIAL_CATEGORIES.has(category)) {
    return link.input_url;
  }
  if ((category === "order" || category === "ordering") && (
    isSkytabOrderSettingsRedirect(link.input_url, link.final_url) ||
    link.source_type === "website"
  )) {
    return link.input_url;
  }
  if (category === "menu" && link.source_type === "website") return link.input_url;
  return canonicalProposalUrl(category, link.final_url || link.input_url);
}

function canonicalProposalUrl(category, value) {
  try {
    const u = new URL(ensureProtocol(value));
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (isDisposableQueryParam(key, category)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return value;
  }
}

function isDisposableQueryParam(key, category) {
  const normalized = String(key || "").toLowerCase();
  if (/^utm_/.test(normalized)) return true;
  if (["fbclid", "gclid", "msclkid", "igshid", "srsltid", "mc_cid", "mc_eid", "_branch_match_id"].includes(normalized)) return true;
  if (["source", "src", "ref", "referrer", "campaign", "promotion", "destination"].includes(normalized)) return true;
  if (category === "reservations" && ["date", "datetime", "party_size", "covers"].includes(normalized)) return true;
  return false;
}

function isSkytabOrderSettingsRedirect(inputUrl, finalUrl) {
  const inputHost = domain(inputUrl);
  if (inputHost !== "online.skytab.com") return false;
  return /\/order-settings(?:[/?#]|$)/i.test(String(finalUrl || ""));
}

function loadLocationContext(locationId, fixtureStore, args) {
  if (args.replay) {
    const fixture = fixtureStore.readJson("v2.json");
    if (!fixture) throw new MissingFixtureError("v2", "v2.json");
    return fixture;
  }

  const escapedId = sqlEscape(locationId);
  const locSql = `
SELECT
  l.id AS location_id, l.name AS location_name, l.status AS location_status,
  l.account_id, a.name AS account_name, a.status AS account_status,
  l.is_general,
  l.address, l.shipping_address_line1, l.shipping_city, l.shipping_state, l.shipping_zip,
  l.ordering_phone_number, l.google_place_id, l.website_url, l.ordering_url,
  COALESCE(NULLIF(loc_br.facebook_url, ''), acc_br.facebook_url) AS facebook_url,
  COALESCE(NULLIF(loc_br.instagram_url, ''), acc_br.instagram_url) AS instagram_url,
  COALESCE(NULLIF(loc_br.x_url, ''), acc_br.x_url) AS x_url,
  COALESCE(NULLIF(loc_br.tiktok_url, ''), acc_br.tiktok_url) AS tiktok_url,
  COALESCE(NULLIF(loc_br.youtube_url, ''), acc_br.youtube_url) AS youtube_url,
  COALESCE(NULLIF(loc_br.apple_app_url, ''), acc_br.apple_app_url) AS apple_app_url,
  COALESCE(NULLIF(loc_br.google_app_url, ''), acc_br.google_app_url) AS google_app_url
FROM locations l
JOIN accounts a ON a.id = l.account_id
LEFT JOIN LATERAL (
  SELECT b.* FROM branding b
  WHERE b.location_id = l.id
  ORDER BY b.updated_at DESC
  LIMIT 1
) loc_br ON true
LEFT JOIN LATERAL (
  SELECT b.* FROM branding b
  WHERE b.account_id = l.account_id AND b.location_id IS NULL
  ORDER BY b.updated_at DESC
  LIMIT 1
) acc_br ON true
WHERE l.id = '${escapedId}'
  AND l.is_general = false`;
  let locationRows;
  try {
    locationRows = queryJson(locSql);
  } catch (error) {
    const fixture = args.record ? fixtureStore.readJson("v2.json") : null;
    if (fixture) return fixture;
    throw error;
  }
  if (!locationRows.length) throw new Error(`No non-General V2 location found for ${locationId}`);

  const eventSql = `
SELECT te.id, te.account_id, te.location_id, te.touchpoint_event_default_id, te.title, te.display_title,
  te.description, te.primary_button_text, te.sort_order, te.is_active, te.config, te.link, te.updated_at
FROM touchpoint_events te
WHERE te.location_id = '${escapedId}'
  AND te.deleted_at IS NULL
  AND te.is_active = true
ORDER BY te.sort_order NULLS LAST, te.title NULLS LAST`;
  let touchpointEvents;
  try {
    touchpointEvents = queryJson(eventSql);
  } catch (error) {
    const fixture = args.record ? fixtureStore.readJson("v2.json") : null;
    if (fixture) return fixture;
    throw error;
  }
  const payload = { location_context: locationRows[0], touchpoint_events: touchpointEvents };
  if (args.record) fixtureStore.writeJson("v2.json", payload);
  return payload;
}

function buildExistingLinks(location, touchpointEvents) {
  const links = [];
  const fields = [
    ["website", "website_url", location.website_url],
    ["ordering", "ordering_url", location.ordering_url],
    ["facebook", "facebook_url", location.facebook_url],
    ["instagram", "instagram_url", location.instagram_url],
    ["x_twitter", "x_url", location.x_url],
    ["tiktok", "tiktok_url", location.tiktok_url],
    ["youtube", "youtube_url", location.youtube_url],
    ["ios_app", "apple_app_url", location.apple_app_url],
    ["android_app", "google_app_url", location.google_app_url]
  ];
  for (const [category, field, value] of fields) {
    if (!value) continue;
    links.push({
      category,
      input_url: value,
      source_type: "v2_existing",
      source_table: category === "website" || category === "ordering" ? "locations" : "branding",
      source_field: field,
      source_id: location.location_id,
      link_type: verifierLinkTypeForCategory(category),
      title: field
    });
  }
  for (const event of touchpointEvents) {
    if (!event.link) continue;
    const category = categoryForTouchpoint(event);
    if (!category) continue;
    links.push({
      category,
      input_url: event.link,
      source_type: "v2_existing",
      source_table: "touchpoint_events",
      source_field: "link",
      source_id: event.id,
      link_type: verifierLinkTypeForCategory(category),
      title: event.title || event.display_title || category,
      display_title: event.display_title || null,
      sort_order: event.sort_order
    });
  }
  return links;
}

function assertSchema() {
  const required = {
    locations: ["id", "account_id", "name", "address", "shipping_address_line1", "shipping_city", "shipping_state", "shipping_zip", "ordering_phone_number", "google_place_id", "website_url", "ordering_url"],
    branding: ["account_id", "location_id", "facebook_url", "instagram_url", "x_url", "tiktok_url", "youtube_url", "apple_app_url", "google_app_url"],
    touchpoint_events: ["id", "location_id", "touchpoint_event_default_id", "title", "display_title", "description", "primary_button_text", "sort_order", "is_active", "config", "link", "deleted_at"]
  };
  const missing = [];
  for (const [table, columns] of Object.entries(required)) {
    const rows = queryJson(`select column_name from information_schema.columns where table_schema='public' and table_name='${table}'`);
    const available = new Set(rows.map((row) => row.column_name));
    for (const column of columns) {
      if (!available.has(column)) missing.push(`${table}.${column}`);
    }
  }
  if (missing.length) throw new Error(`V2 schema drift: missing required columns ${missing.join(", ")}`);
}

class FixtureStore {
  constructor(root, locationId, options = {}) {
    this.root = root || "";
    this.locationId = locationId;
    this.record = options.record;
    this.replay = options.replay;
    this.browserProvider = options.browserProvider || "playwright";
    this.chromeCdpUrl = options.chromeCdpUrl || "";
    this.chromeProfile = options.chromeProfile || "";
    this.codexAgent = options.codexAgent || null;
    this.cacheDir = options.cacheDir || "";
    this.cacheTtlMs = Math.min(7, Math.max(3, Number(options.cacheTtlDays) || 5)) * 24 * 60 * 60 * 1000;
    this.cacheEnabled = Boolean(options.cacheEnabled && this.cacheDir);
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.missingFixtures = [];
    this.attemptedLiveFetches = [];
    this.browserProviderPreflighted = false;
    this.requestedChromeProfileName = FULFILLMENT_BROWSER_PROVIDERS.includes(this.browserProvider)
      ? profileNameForKey(this.chromeProfile || "boostly")
      : null;
    // claude-chrome state: recorded results (url -> result), URLs still needing a visit,
    // and the profile the results were captured in.
    this.chromeLocalStateFile = options.chromeLocalStateFile || "";
    this.browserResultsFile = options.browserResultsFile || "";
    this.browserManifestFile = options.browserManifestFile || "";
    this.browserResults = null;
    this.browserNeeded = [];
    this.claudeChromeProfileName = null;
    this.claudeChromeProfileResolution = null;
    this.codexExtensionProfileResolution = null;
    this.currentFetchKind = null;
  }

  chromeProfileResolved() {
    return this.codexExtensionProfileName ?? this.claudeChromeProfileName ?? null;
  }

  chromeProfileResolution() {
    return this.codexExtensionProfileResolution ?? this.claudeChromeProfileResolution ?? null;
  }

  noteBrowserNeeded(url, kind) {
    const key = browserResultKey(url);
    if (this.browserNeeded.some((entry) => entry.key === key)) return;
    this.browserNeeded.push({ key, url, kind: kind || this.currentFetchKind || null });
  }

  preflightClaudeChrome() {
    // Without a results file this is the manifest-only pass: discovery runs static-first,
    // every browser escalation is recorded in browser_needed, and the report stays
    // unpreflighted (the validator refuses it for fulfillment) until results are supplied.
    if (!this.browserResultsFile) return;
    const results = loadBrowserResults(this.browserResultsFile);
    if (!sameProfileName(results.chrome_profile_resolved, this.requestedChromeProfileName)) {
      throw new Error(`Claude Chrome browser results were captured in profile '${results.chrome_profile_resolved}', required '${this.requestedChromeProfileName}'. Refusing to use another profile's evidence.`);
    }
    const resolutionErrors = chromeProfileResolutionErrors(results.chrome_profile_resolution);
    if (resolutionErrors.length) {
      throw new Error(`Claude Chrome browser results carry an incomplete chrome_profile_resolution (${resolutionErrors.join(", ")}). Refusing evidence whose profile check cannot be shown.`);
    }
    this.browserResults = results;
    this.claudeChromeProfileName = results.chrome_profile_resolved;
    this.claudeChromeProfileResolution = results.chrome_profile_resolution ?? { method: PROFILE_RESOLUTION_EXTENSION };
    this.browserProviderPreflighted = true;
  }

  claudeChromeRuntime(locationId) {
    const browserNeeded = this.browserNeeded.map((entry) => ({ url: entry.url, kind: entry.kind }));
    const manifestFile = this.writeBrowserManifest(locationId, browserNeeded);
    return {
      browser_results_file: this.browserResultsFile ? path.resolve(this.browserResultsFile) : null,
      browser_results_count: this.browserResults ? Object.keys(this.browserResults.results).length : 0,
      browser_manifest_file: manifestFile,
      browser_needed: browserNeeded
    };
  }

  writeBrowserManifest(locationId, browserNeeded) {
    if (!this.browserManifestFile) return null;
    const manifest = {
      format: BROWSER_MANIFEST_FORMAT,
      provider: CLAUDE_CHROME_PROVIDER,
      location_id: locationId,
      generated_at: checkedAt(),
      chrome_profile_required: this.requestedChromeProfileName,
      results_file: this.browserResultsFile ? path.resolve(this.browserResultsFile) : null,
      urls: browserNeeded,
      instructions: browserNeeded.length
        ? "For each url: navigate in the required Chrome profile with the claude-in-chrome tools, run extractor_js with javascript_tool (it parks compact JSON on the page and returns the chunk count), read chunk i with chunk_read_js (replace INDEX; the tool returns at most 1000 chars per call, browser_batch reads several at once), write the chunks as 01.txt, 02.txt ... under one directory, then run claude-chrome-browser.mjs results add --file <results_file> --url <url> --final-url <landed url> --page-parts <dir>. Rerun discovery with --browser-results <results_file> when every url is recorded."
        : "No browser escalation was needed. Rerun with --browser-results pointing at an initialized results file to mark the report preflighted.",
      chunk_size: CLAUDE_CHROME_CHUNK_SIZE,
      chunk_read_js: "window.__boostlyPage.slice(INDEX * " + CLAUDE_CHROME_CHUNK_SIZE + ", (INDEX + 1) * " + CLAUDE_CHROME_CHUNK_SIZE + ")",
      extractor_js: claudeChromeExtractorSource()
    };
    fs.mkdirSync(path.dirname(path.resolve(this.browserManifestFile)), { recursive: true });
    fs.writeFileSync(this.browserManifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    return path.resolve(this.browserManifestFile);
  }

  readJson(relativePath) {
    if (!this.root) return null;
    const file = path.join(this.root, this.locationId, relativePath);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  writeJson(relativePath, value) {
    if (!this.root) return;
    const file = path.join(this.root, this.locationId, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  }

  evidencePath(kind, fixtureKey) {
    return `${kind}/${hashUrl(fixtureKey)}.json`;
  }

  readEvidence(kind, fixtureKey) {
    const relativePath = this.evidencePath(kind, fixtureKey);
    const fixture = this.readJson(relativePath);
    if (!fixture) {
      this.missingFixtures.push({ kind, url: fixtureKey, relativePath });
      throw new MissingFixtureError(kind, relativePath);
    }
    return fixture.evidence || fixture;
  }

  writeEvidence(kind, fixtureKey, evidence) {
    this.writeJson(this.evidencePath(kind, fixtureKey), {
      input_url: fixtureKey,
      kind,
      recorded_at: checkedAt(),
      evidence
    });
  }

  async fetchEvidence(url, kind, fixtureKey = url) {
    if (this.replay) {
      return this.readEvidence(kind, fixtureKey);
    }
    const cached = this.readCache(kind, fixtureKey);
    if (cached) {
      this.cacheHits += 1;
      return { ...cached, cache_hit: true };
    }
    if (this.cacheEnabled && kind !== "search") this.cacheMisses += 1;
    const browserLabel = this.browserProvider === "codex-extension" ? "codex_extension" :
      this.browserProvider === CLAUDE_CHROME_PROVIDER ? "claude_chrome" :
      this.browserProvider === "local-chrome" ? "local_chrome" : "playwright";
    this.currentFetchKind = kind;
    let evidence;
    try {
      evidence = await collectEvidence(url, () => this.getPage(), { browserLabel });
    } catch (error) {
      evidence = fetchFailureEvidence(url, `${browserLabel}_error`, error);
    }
    if (kind === "website" || kind === "external-link-in-bio") {
      await enrichDiscoveryPageEvidence(evidence);
    }
    if (kind === "search" && isBlockedSearchPage(evidence)) {
      throw new SearchBlockedError(String(fixtureKey).replace(/^google-search:/, ""), evidence);
    }
    if (this.record) this.writeEvidence(kind, fixtureKey, evidence);
    this.writeCache(kind, fixtureKey, evidence);
    return evidence;
  }

  readCache(kind, fixtureKey) {
    if (!this.cacheEnabled || kind === "search") return null;
    const aliasPath = path.join(this.cacheDir, "aliases", `${hashUrl(`${kind}:${fixtureKey}`)}.json`);
    if (!fs.existsSync(aliasPath)) return null;
    try {
      const alias = JSON.parse(fs.readFileSync(aliasPath, "utf8"));
      const age = Date.now() - new Date(alias.cached_at).getTime();
      if (!Number.isFinite(age) || age < 0 || age > this.cacheTtlMs) return null;
      const contentPath = path.join(this.cacheDir, "content", `${alias.content_key || alias.content_hash}.json`);
      if (!fs.existsSync(contentPath)) return null;
      return JSON.parse(fs.readFileSync(contentPath, "utf8")).evidence;
    } catch {
      return null;
    }
  }

  writeCache(kind, fixtureKey, evidence) {
    if (!this.cacheEnabled || kind === "search") return;
    if (!evidence || evidence.error || evidence.http_status >= 400) return;
    // Chrome may omit HTTP status. Cache real live DOM evidence, not challenges
    // or thin responses; candidate identity is still verified on every use.
    if (evidence.http_status == null && validityDecision(evidence).liveness !== "live") return;
    const stableEvidence = {
      ...evidence,
      cache_hit: undefined,
      checked_at: undefined
    };
    const contentHash = evidence.content_hash || crypto.createHash("sha256").update(JSON.stringify(stableEvidence)).digest("hex");
    // Relative links and redirects make identical bytes context-sensitive. Keep the
    // source content hash for reuse decisions while keying cached evidence by both
    // content and resolved URL so one path can never inherit another path's links.
    const contentKey = crypto.createHash("sha256").update(`${contentHash}|${normalizeUrlForCompare(evidence.final_url || fixtureKey)}|${JSON.stringify(stableEvidence)}`).digest("hex");
    const aliasDir = path.join(this.cacheDir, "aliases");
    const contentDir = path.join(this.cacheDir, "content");
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.mkdirSync(contentDir, { recursive: true });
    const contentPath = path.join(contentDir, `${contentKey}.json`);
    if (!fs.existsSync(contentPath)) {
      fs.writeFileSync(contentPath, JSON.stringify({ content_hash: contentHash, evidence }, null, 2));
    }
    fs.writeFileSync(path.join(aliasDir, `${hashUrl(`${kind}:${fixtureKey}`)}.json`), JSON.stringify({
      kind,
      fixture_key: fixtureKey,
      content_hash: contentHash,
      content_key: contentKey,
      cached_at: checkedAt()
    }, null, 2));
  }

  deleteEvidence(kind, fixtureKey) {
    if (!this.root) return;
    const file = path.join(this.root, this.locationId, `${kind}/${hashUrl(fixtureKey)}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  hasKind(kind) {
    if (!this.root) return false;
    const dir = path.join(this.root, this.locationId, kind);
    return fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name.endsWith(".json"));
  }

  usesCustomBrowserProvider() {
    return this.browserProvider === "local-chrome" || this.browserProvider === "codex-extension" || this.browserProvider === CLAUDE_CHROME_PROVIDER;
  }

  async preflightBrowserProvider() {
    if (this.browserProvider === CLAUDE_CHROME_PROVIDER) {
      this.preflightClaudeChrome();
      return;
    }
    if (this.browserProvider !== "codex-extension") return;
    const agent = this.codexAgent || globalThis.agent;
    if (!agent?.browsers) {
      throw new Error("browser-provider=codex-extension requires the Codex Chrome extension runtime. Run discovery from the Chrome plugin Node runtime; fulfillment must not fall back to Playwright.");
    }
    this.codexExtensionBrowser = await this.selectCodexExtensionBrowser(agent);
    this.browserProviderPreflighted = true;
  }

  async getPage() {
    if (this.page) return this.page;
    if (this.browserProvider === CLAUDE_CHROME_PROVIDER) {
      this.page = new ClaudeChromePageAdapter(this);
      return this.page;
    }
    if (this.browserProvider === "codex-extension") {
      this.page = await this.createCodexExtensionPage();
      return this.page;
    }
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { chromium } = require(process.env.BOOSTLY_PLAYWRIGHT_MODULE || path.join(SKILLS_ROOT, "boostly-brand-design", "harness", "node_modules", "playwright"));
    if (this.browserProvider === "local-chrome") {
      const cdpUrl = this.chromeCdpUrl || this.launchLocalChrome();
      this.browser = await chromium.connectOverCDP(cdpUrl);
      this.connectedToExternalBrowser = true;
      this.context = this.browser.contexts()[0];
      if (!this.context) {
        this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
        this.createdContext = true;
      }
    } else {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    }
    this.page = await this.context.newPage();
    await this.page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    return this.page;
  }

  launchLocalChrome() {
    const profile = this.chromeProfile || "personal";
    if (!fs.existsSync(DEV_BROWSER_CHROME_HELPER)) {
      throw new Error(`local Chrome helper not found: ${DEV_BROWSER_CHROME_HELPER}`);
    }
    const raw = execFileSync(DEV_BROWSER_CHROME_HELPER, [profile, "about:blank"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const info = JSON.parse(raw);
    this.launchedChromeProfile = profile;
    return info.endpoint || `http://127.0.0.1:${info.port}`;
  }

  async createCodexExtensionPage() {
    const agent = this.codexAgent || globalThis.agent;
    if (!agent?.browsers) {
      throw new Error("browser-provider=codex-extension requires the Codex Chrome extension runtime. Use the Chrome plugin Node runtime, or pass --browser-provider playwright for terminal-only runs.");
    }
    const browser = this.codexExtensionBrowser || await this.selectCodexExtensionBrowser(agent);
    await browser.nameSession("🔎 Boostly link discovery");
    this.codexExtensionBrowser = browser;
    this.codexExtensionTab = await browser.tabs.new();
    return new CodexExtensionPageAdapter(this.codexExtensionTab);
  }

  async selectCodexExtensionBrowser(agent) {
    const requestedProfile = profileNameForKey(this.chromeProfile || "boostly");
    const browsers = await agent.browsers.list();
    const extensionBrowsers = browsers.filter((browser) => browser.type === "extension");
    const selected = extensionBrowsers.find((browser) => sameProfileName(browser.profileName ?? browser.metadata?.profileName, requestedProfile));
    if (selected) {
      this.codexExtensionProfileName = selected.profileName ?? selected.metadata?.profileName ?? null;
      this.codexExtensionProfileResolution = { method: PROFILE_RESOLUTION_EXTENSION };
      return agent.browsers.get(selected.id);
    }
    // Fallback: the extension reports no profile name at all. Exactly one browser on this computer
    // plus exactly one Chrome profile in Local State named like the requested one.
    const fallback = this.selectLocalStateExtensionBrowser(extensionBrowsers, requestedProfile);
    if (fallback) {
      this.codexExtensionProfileName = requestedProfile;
      this.codexExtensionProfileResolution = fallback.resolution;
      return agent.browsers.get(fallback.browser.id);
    }
    const available = extensionBrowsers.map((browser) => browser.profileName ?? browser.metadata?.profileName).filter(Boolean).join(", ") || "none";
    throw new Error(`No Codex Chrome extension session matches required profile '${requestedProfile}' (available: ${available}). Refusing to bind a random profile.`);
  }

  // Returns { browser, resolution } when both fallback checks hold, null when the fallback does not
  // apply (a browser reports a profile name), and throws when it applies but a check fails.
  selectLocalStateExtensionBrowser(extensionBrowsers, requestedProfile) {
    const named = extensionBrowsers.some((browser) => browser.profileName ?? browser.metadata?.profileName);
    if (named) return null;
    const local = extensionBrowsers.filter((browser) => browser.onThisComputer === true || browser.isLocal === true);
    if (local.length !== 1) {
      throw new Error(`No Codex Chrome extension session reports a profile name and ${local.length} of ${extensionBrowsers.length} are on this computer (the Local State fallback needs exactly one). Refusing to bind a random profile.`);
    }
    const browser = local[0];
    const deviceId = browser.deviceId ?? browser.id ?? null;
    const resolution = resolveChromeProfileViaLocalState({
      expected: requestedProfile,
      browsers: [{ ...browser, deviceId, type: "extension" }],
      localStateFile: this.chromeLocalStateFile || undefined,
    });
    return { browser, resolution };
  }

  async close() {
    if (this.page) await this.page.close().catch(() => {});
    if (typeof this.codexExtensionBrowser?.tabs?.finalize === "function") {
      await this.codexExtensionBrowser.tabs.finalize({ keep: [] }).catch(() => {});
    }
    if (this.context && this.createdContext) await this.context.close().catch(() => {});
    if (this.browser && !this.connectedToExternalBrowser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.connectedToExternalBrowser = false;
    this.createdContext = false;
    this.codexExtensionBrowser = null;
    this.codexExtensionTab = null;
  }
}

class CodexExtensionPageAdapter {
  constructor(tab) {
    this.tab = tab;
  }

  async goto(url, options = {}) {
    await this.tab.goto(url);
    const state = options.waitUntil || "domcontentloaded";
    await this.tab.playwright.waitForLoadState({ state, timeoutMs: options.timeout || 20000 }).catch(() => {});
    return { status: () => null };
  }

  async waitForTimeout(timeoutMs) {
    await this.tab.playwright.waitForTimeout(timeoutMs);
  }

  async url() {
    return await this.tab.url();
  }

  async evaluate(pageFunction) {
    return await this.tab.playwright.evaluate(pageFunction, undefined, { timeoutMs: 20000 });
  }

  async setExtraHTTPHeaders() {
    return undefined;
  }

  async close() {
    return undefined;
  }
}

// Page adapter for the claude-chrome provider. It serves results recorded by the Claude
// session (claude-chrome-browser.mjs) and records every URL it has no result for, so the
// manifest-only pass produces the exact list the session must visit.
class ClaudeChromePageAdapter {
  constructor(store) {
    this.store = store;
    this.current = null;
  }

  async goto(url) {
    const result = this.store.browserResults?.results?.[browserResultKey(url)] || null;
    if (!result) {
      this.store.noteBrowserNeeded(url);
      throw new Error(`claude_chrome_result_missing: ${url}`);
    }
    this.current = result;
    return { status: () => (Number.isFinite(result.http_status) ? result.http_status : null) };
  }

  async waitForTimeout() {
    return undefined;
  }

  async url() {
    return this.current?.final_url || this.current?.url || "";
  }

  async evaluate() {
    return this.current?.page || {};
  }

  async setExtraHTTPHeaders() {
    return undefined;
  }

  async close() {
    this.current = null;
  }
}

function browserResultKey(url) {
  return normalizeUrlForCompare(ensureProtocol(String(url || "")));
}

function loadBrowserResults(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read claude-chrome browser results ${file}: ${error.message}`);
  }
  if (parsed?.format !== BROWSER_RESULTS_FORMAT || parsed.provider !== CLAUDE_CHROME_PROVIDER) {
    throw new Error(`${file} is not a ${BROWSER_RESULTS_FORMAT} file`);
  }
  if (typeof parsed.chrome_profile_resolved !== "string" || !parsed.chrome_profile_resolved) {
    throw new Error(`${file} does not declare chrome_profile_resolved`);
  }
  const resolutionErrors = chromeProfileResolutionErrors(parsed.chrome_profile_resolution);
  if (resolutionErrors.length) {
    throw new Error(`${file} has an invalid chrome_profile_resolution: ${resolutionErrors.join(", ")}`);
  }
  const results = {};
  for (const [key, value] of Object.entries(parsed.results || {})) {
    if (!value || typeof value !== "object" || !value.page || typeof value.page !== "object") {
      throw new Error(`browser result for ${key} has no page object`);
    }
    results[browserResultKey(value.url || key)] = value;
  }
  return { ...parsed, results };
}

function resolveBrowserManifestPath(args = {}) {
  if (args["browser-manifest"]) return args["browser-manifest"];
  if (args.browserManifest) return args.browserManifest;
  if (args.out) return path.join(path.dirname(path.resolve(args.out)), "browser-needed.json");
  return "";
}

// Chrome profile names compare case-insensitively (Karissa's profile is spelled "boostly.com", 2026-10-14).
function sameProfileName(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function profileNameForKey(profile) {
  const key = String(profile || "").toLowerCase();
  if (["boostly", "work", "work chrome", "boostly chrome"].includes(key)) return "Boostly.com";
  if (["personal", "travisse", "my chrome", "personal chrome"].includes(key)) return "Travisse";
  if (["denada", "denada.design"].includes(key)) return "denada.design";
  if (["gmr", "getmorereviews"].includes(key)) return "GMR";
  return profile || "Boostly.com";
}

// Chrome profile resolution methods recorded in results files and reports.
//   extension-profile-name: the extension reported metadata.profileName and it matched (the first path).
//   local-state-single-profile: the extension reported no profile name (Karissa's Mac, 2026-10-14);
//     exactly one connected browser is on this computer and this Mac's Chrome Local State has exactly
//     one profile whose name matches the required one. Both halves must hold or the run stops.
//   user-confirmed-device: the extension reports no profile name and this Mac has many Chrome
//     profiles (Travisse's Mac, 16), so Travisse confirmed in chat which connected device id is the
//     Boostly.com profile (2026-10-15). Valid only for that exact device id; the confirmation lives in
//     ~/.config/boostly-branding/chrome-confirmed-device.json (0600), one per machine and person.
const PROFILE_RESOLUTION_EXTENSION = "extension-profile-name";
const PROFILE_RESOLUTION_LOCAL_STATE = "local-state-single-profile";
const PROFILE_RESOLUTION_USER_CONFIRMED = "user-confirmed-device";
const PROFILE_RESOLUTION_METHODS = [PROFILE_RESOLUTION_EXTENSION, PROFILE_RESOLUTION_LOCAL_STATE, PROFILE_RESOLUTION_USER_CONFIRMED];

function defaultChromeConfirmedDevicePath(env = process.env) {
  if (env.BOOSTLY_CHROME_CONFIRMED_DEVICE) return env.BOOSTLY_CHROME_CONFIRMED_DEVICE;
  return path.join(os.homedir(), ".config", "boostly-branding", "chrome-confirmed-device.json");
}

function readChromeConfirmedDevice(file = defaultChromeConfirmedDevicePath()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`chrome_profile_confirmation_refused: unable to read the confirmation file ${file}: ${error.message}`);
  }
  for (const key of ["device_id", "browser_label", "profile", "confirmed_by", "confirmed_at"]) {
    if (typeof parsed?.[key] !== "string" || !parsed[key]) {
      throw new Error(`chrome_profile_confirmation_refused: ${file} is missing ${key}`);
    }
  }
  return parsed;
}

// The third path. The caller passes the device id it selected (or none, and the machine-local
// confirmation file supplies it). When a confirmation file exists, the device id must equal the one
// Travisse confirmed there; a different id refuses. With --browsers the id must also be a connected
// browser on this computer.
function resolveChromeProfileViaUserConfirmation({
  expected,
  browsers,
  deviceId,
  browserLabel,
  confirmedBy,
  confirmedNote,
  confirmedAt,
  confirmationFile,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  if (!expected) throw new Error("expected profile name is required");
  const file = confirmationFile || defaultChromeConfirmedDevicePath(env);
  const confirmation = fs.existsSync(file) ? readChromeConfirmedDevice(file) : null;
  if (!deviceId && !confirmation) {
    throw new Error(`chrome_profile_confirmation_refused: no --device-id and no confirmation file at ${file}`);
  }
  if (confirmation) {
    if (!sameProfileName(confirmation.profile, expected)) {
      throw new Error(`chrome_profile_confirmation_refused: ${file} confirms profile '${confirmation.profile}', required '${expected}'`);
    }
    if (deviceId && deviceId !== confirmation.device_id) {
      throw new Error(`chrome_profile_confirmation_refused: device id '${deviceId}' is not the confirmed device '${confirmation.device_id}' in ${file}`);
    }
  }
  const resolvedDeviceId = deviceId || confirmation.device_id;
  const label = browserLabel || confirmation?.browser_label || null;
  const by = confirmedBy || confirmation?.confirmed_by || null;
  if (!label) throw new Error("chrome_profile_confirmation_refused: --browser-label is required");
  if (!by) throw new Error("chrome_profile_confirmation_refused: --confirmed-by is required");
  if (browsers !== undefined && browsers !== null) {
    const row = connectedBrowserRows(browsers).find((candidate) => candidate.deviceId === resolvedDeviceId);
    if (!row) throw new Error(`chrome_profile_confirmation_refused: device '${resolvedDeviceId}' is not among the connected browsers`);
    if (!row.onThisComputer) throw new Error(`chrome_profile_confirmation_refused: device '${resolvedDeviceId}' is connected but not on this computer`);
  }
  const resolution = {
    method: PROFILE_RESOLUTION_USER_CONFIRMED,
    device_id: resolvedDeviceId,
    browser_label: label,
    confirmed_by: by,
    confirmed_note: confirmedNote || confirmation?.confirmed_note || null,
    confirmed_at: confirmedAt || confirmation?.confirmed_at || now(),
  };
  if (confirmation) resolution.confirmation_file = file;
  return resolution;
}

function defaultChromeLocalStatePath(env = process.env) {
  if (env.BOOSTLY_CHROME_LOCAL_STATE) return env.BOOSTLY_CHROME_LOCAL_STATE;
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "Local State");
}

// Reads profile.info_cache from Chrome's Local State file: [{ directory, name }], never anything else
// (the file also holds account emails; those are not read or printed).
function readChromeLocalStateProfiles(file = defaultChromeLocalStatePath()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Chrome Local State ${file}: ${error.message}`);
  }
  const cache = parsed?.profile?.info_cache;
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    throw new Error(`${file} has no profile.info_cache`);
  }
  return Object.entries(cache).map(([directory, info]) => ({
    directory,
    name: typeof info?.name === "string" ? info.name : "",
  }));
}

// list_connected_browsers rows in any of the shapes the tool has used; profile name is read the same
// way selectCodexExtensionBrowser reads it.
function connectedBrowserRows(browsers) {
  const rows = Array.isArray(browsers) ? browsers : Array.isArray(browsers?.browsers) ? browsers.browsers : null;
  if (!rows) throw new Error("connected browsers must be an array or an object with a browsers array");
  return rows
    .filter((browser) => !browser?.type || browser.type === "extension")
    .map((browser) => ({
      deviceId: browser.deviceId ?? browser.device_id ?? browser.id ?? null,
      label: browser.label ?? browser.name ?? browser.browserName ?? browser.browser_name ?? null,
      onThisComputer: browser.onThisComputer === true || browser.on_this_computer === true || browser.isLocal === true || browser.is_local === true,
      profileName: browser.profileName ?? browser.metadata?.profileName ?? null,
    }));
}

// Half one of the fallback: no browser reports a profile name and exactly one is on this computer.
function selectSingleLocalBrowser(browsers) {
  const rows = connectedBrowserRows(browsers);
  const named = rows.filter((row) => row.profileName);
  if (named.length) {
    throw new Error(`chrome_profile_fallback_refused: a connected browser reports a profile name (${named.map((row) => row.profileName).join(", ")}); the name match is the only path then`);
  }
  const local = rows.filter((row) => row.onThisComputer);
  if (local.length !== 1) {
    throw new Error(`chrome_profile_fallback_refused: expected exactly one connected browser on this computer, found ${local.length} of ${rows.length}`);
  }
  if (!local[0].deviceId) throw new Error("chrome_profile_fallback_refused: the connected browser has no deviceId");
  return local[0];
}

// Half two of the fallback: this Mac's Chrome has exactly one profile, named like the required one,
// and BOOSTLY_CHROME_PROFILE (the profile directory, when set) points at it.
function resolveLocalStateProfile({ expected, profileDir, localStateFile, env = process.env } = {}) {
  if (!expected) throw new Error("expected profile name is required");
  const file = localStateFile || defaultChromeLocalStatePath(env);
  const profiles = readChromeLocalStateProfiles(file);
  if (profiles.length !== 1) {
    throw new Error(`chrome_profile_fallback_refused: Chrome Local State lists ${profiles.length} profiles (${profiles.map((p) => `${p.directory}=${p.name || "?"}`).join(", ") || "none"}); the fallback needs exactly one, named ${expected}`);
  }
  const [only] = profiles;
  if (!sameProfileName(only.name, expected)) {
    throw new Error(`chrome_profile_fallback_refused: the only Chrome profile is named '${only.name}' (${only.directory}), required '${expected}'`);
  }
  const requiredDir = profileDir || env.BOOSTLY_CHROME_PROFILE || "";
  if (requiredDir && requiredDir !== only.directory) {
    throw new Error(`chrome_profile_fallback_refused: BOOSTLY_CHROME_PROFILE is '${requiredDir}' but the only Chrome profile directory is '${only.directory}'`);
  }
  return { directory: only.directory, local_state_name: only.name, local_state_file: file };
}

// Builds the chrome_profile_resolution object for a results file or report. The resolved name
// stays the canonical requested name so every name compare keeps working.
function resolveChromeProfileViaLocalState({ expected, browsers, deviceId, browserLabel, profileDir, localStateFile, env } = {}) {
  let browser = null;
  if (browsers !== undefined && browsers !== null) {
    browser = selectSingleLocalBrowser(browsers);
    if (deviceId && browser.deviceId !== deviceId) {
      throw new Error(`chrome_profile_fallback_refused: --device-id '${deviceId}' is not the connected browser on this computer ('${browser.deviceId}')`);
    }
  } else if (!deviceId) {
    throw new Error("chrome_profile_fallback_refused: the local-state fallback needs the selected browser's device id (--device-id) or the list_connected_browsers output (--browsers)");
  }
  const profile = resolveLocalStateProfile({ expected, profileDir, localStateFile, env });
  return {
    method: PROFILE_RESOLUTION_LOCAL_STATE,
    directory: profile.directory,
    local_state_name: profile.local_state_name,
    device_id: browser?.deviceId ?? deviceId,
    browser_label: browser?.label ?? browserLabel ?? null,
  };
}

// Shape check shared by the results loader and the validator: a local-state resolution without the
// device id and directory is not evidence that both halves were checked.
function chromeProfileResolutionErrors(resolution) {
  if (resolution == null) return [];
  if (typeof resolution !== "object" || Array.isArray(resolution)) return ["chrome_profile_resolution_invalid"];
  if (!PROFILE_RESOLUTION_METHODS.includes(resolution.method)) return [`chrome_profile_resolution_unknown_method:${String(resolution.method)}`];
  const errors = [];
  if (resolution.method === PROFILE_RESOLUTION_LOCAL_STATE) {
    if (typeof resolution.device_id !== "string" || !resolution.device_id) errors.push("chrome_profile_resolution_missing:device_id");
    if (typeof resolution.directory !== "string" || !resolution.directory) errors.push("chrome_profile_resolution_missing:directory");
  }
  if (resolution.method === PROFILE_RESOLUTION_USER_CONFIRMED) {
    for (const key of ["device_id", "browser_label", "confirmed_by", "confirmed_at"]) {
      if (typeof resolution[key] !== "string" || !resolution[key]) errors.push(`chrome_profile_resolution_missing:${key}`);
    }
  }
  return errors;
}

function fetchFailureEvidence(inputUrl, fetchMethod, error) {
  const url = ensureProtocol(inputUrl);
  return {
    input_url: inputUrl,
    final_url: url,
    fetch_method: fetchMethod,
    http_status: null,
    ok: false,
    title: "",
    meta: {},
    h1: [],
    h2: [],
    text: "",
    links: [],
    labeled_links: [],
    error: String(error?.message || error || "unknown_error").split("\n")[0]
  };
}

async function enrichDiscoveryPageEvidence(evidence) {
  const enriched = await staticFetchEvidence(evidence.final_url || evidence.input_url);
  const labeledLinks = uniqueLabeledLinks([
    ...pageLinkEntries(evidence),
    ...pageLinkEntries(enriched)
  ]);
  if (enriched.content_hash) evidence.content_hash = enriched.content_hash;
  if (!labeledLinks.length) return;
  evidence.labeled_links = labeledLinks;
  evidence.links = [...new Set(labeledLinks.map((link) => link.href))];
}

class MissingFixtureError extends Error {
  constructor(kind, fixturePath) {
    super(`missing_fixture ${kind}: ${fixturePath}`);
    this.code = "missing_fixture";
    this.kind = kind;
    this.fixturePath = fixturePath;
  }
}

async function staticFetchEvidence(inputUrl) {
  const url = ensureProtocol(inputUrl);
  const evidence = {
    input_url: inputUrl,
    final_url: url,
    fetch_method: "static_fetch",
    http_status: null,
    ok: false,
    title: "",
    meta: {},
    h1: [],
    h2: [],
    text: "",
    links: [],
    error: null
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    }).finally(() => clearTimeout(timeout));
    evidence.http_status = res.status;
    evidence.final_url = res.url;
    evidence.ok = res.ok || (res.status >= 300 && res.status < 400);
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html") || contentType.includes("text/plain") || contentType.includes("xml")) {
      const html = await res.text();
      evidence.content_hash = crypto.createHash("sha256").update(html).digest("hex");
      Object.assign(evidence, contentType.includes("xml") ? extractXmlLinks(html, res.url) : extractHtml(html, res.url));
    }
  } catch (error) {
    evidence.error = error.name === "AbortError" ? "timeout" : String(error.message || error);
  }
  return evidence;
}

function extractHtml(html, finalUrl) {
  const meta = {};
  for (const match of html.matchAll(/<meta\s+([^>]+)>/gi)) {
    const attrs = match[1];
    const key = attr(attrs, "property") || attr(attrs, "name");
    const value = attr(attrs, "content");
    if (key && value) meta[key] = decodeHtml(value);
  }
  const anchorLinks = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      href: toAbsolute(match[1], finalUrl),
      label: stripHtml(match[2]),
      source: "anchor"
    }))
    .filter((link) => link.href);
  const dataLinks = [...html.matchAll(/\s(?:data-url|data-href|href)=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => ({
      href: toAbsolute(match[1], finalUrl),
      label: "",
      source: "data-or-href-attr"
    }))
    .filter((link) => link.href);
  const onclickLinks = [...html.matchAll(/onclick=["'][^"']*(?:location\.href|window\.open|open)\(['"]([^'"]+)/gi)]
    .map((match) => ({
      href: toAbsolute(match[1], finalUrl),
      label: "",
      source: "onclick"
    }))
    .filter((link) => link.href);
  const scriptLinks = [...html.matchAll(/https?:\/\/[^"'\s<>)]+/g)]
    .map((match) => ({
      href: toAbsolute(match[0], finalUrl),
      label: "",
      source: "script-url"
    }))
    .filter((link) => link.href);
  const labeledLinks = uniqueLabeledLinks([
    ...extractSectionLinks(html, finalUrl, "nav"),
    ...extractSectionLinks(html, finalUrl, "footer"),
    ...anchorLinks,
    ...dataLinks,
    ...onclickLinks,
    ...scriptLinks,
    ...extractSquarespaceContextLinks(html, finalUrl),
    ...extractJsonLdLinks(html, finalUrl)
  ]).slice(0, 300);
  const links = labeledLinks.map((link) => link.href);
  return {
    title: decodeHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim()),
    meta,
    h1: [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => stripHtml(match[1])).slice(0, 8),
    h2: [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((match) => stripHtml(match[1])).slice(0, 8),
    text: stripHtml(html).replace(/\s+/g, " ").slice(0, 6000),
    links,
    labeled_links: labeledLinks
  };
}

function extractSectionLinks(html, finalUrl, tag) {
  const out = [];
  const sectionPattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  for (const section of html.matchAll(sectionPattern)) {
    for (const match of section[1].matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = toAbsolute(match[1], finalUrl);
      if (href) out.push({ href, label: stripHtml(match[2]), source: tag });
    }
  }
  return out;
}

function extractXmlLinks(xml, finalUrl) {
  const labeledLinks = uniqueLabeledLinks(
    [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
      .map((match) => ({ href: toAbsolute(decodeHtml(match[1]), finalUrl), label: "sitemap", source: "sitemap" }))
      .filter((link) => link.href)
  ).slice(0, 300);
  return {
    title: "",
    meta: {},
    h1: [],
    h2: [],
    text: "",
    links: labeledLinks.map((link) => link.href),
    labeled_links: labeledLinks
  };
}

function extractJsonLdLinks(html, finalUrl) {
  const out = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectJsonLdLinks(JSON.parse(decodeHtml(match[1])), out, finalUrl);
    } catch {
      // Invalid JSON-LD is common and should not fail the crawl.
    }
  }
  return out;
}

function collectJsonLdLinks(value, out, finalUrl, label = "json-ld") {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdLinks(item, out, finalUrl, label);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const nextLabel = typeof value.name === "string" ? value.name : label;
    if (["url", "sameAs", "target", "contentUrl", "downloadUrl"].includes(key)) {
      for (const raw of Array.isArray(item) ? item : [item]) {
        const href = typeof raw === "string" ? toAbsolute(raw, finalUrl) : null;
        if (href) out.push({ href, label: nextLabel, source: `json-ld:${key}` });
      }
    }
    collectJsonLdLinks(item, out, finalUrl, nextLabel);
  }
}

function extractSquarespaceContextLinks(html, finalUrl) {
  const context = parseSquarespaceContext(html);
  const announcement = context?.websiteSettings?.announcementBarSettings;
  const url = announcement?.clickthroughUrl?.url;
  if (!url) return [];
  const href = toAbsolute(url, finalUrl);
  if (!href) return [];
  return [{
    href,
    label: stripHtml(announcement.text || ""),
    source: "squarespace_announcement_bar"
  }];
}

function parseSquarespaceContext(html) {
  const script = html.match(/<script[^>]*data-name=["']static-context["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!script) return null;
  const json = script.match(/Static\.SQUARESPACE_CONTEXT\s*=\s*({[\s\S]*})\s*;?\s*$/)?.[1];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function uniqueLabeledLinks(links) {
  const seen = new Set();
  const out = [];
  for (const link of links) {
    const key = `${normalizeUrlForCompare(link.href)}:${normalizeText(link.label)}:${link.source || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function categoryForUrl(url, label = "") {
  const host = domain(url);
  const cleanUrl = urlWithoutHash(url);
  const urlText = normalizeText(cleanUrl);
  const text = normalizeText(`${cleanUrl} ${label}`);
  if (host.endsWith("instagram.com")) return "instagram";
  if (host.endsWith("facebook.com")) return "facebook";
  if (host.endsWith("tiktok.com")) return "tiktok";
  if (host.endsWith("youtube.com") || host.endsWith("youtu.be")) return "youtube";
  if (host.endsWith("x.com") || host.endsWith("twitter.com")) return "x_twitter";
  if (host === "apps.apple.com") return "ios_app";
  if (host === "play.google.com") return "android_app";
  if (/\b(order|ordering|online order|olo|toast|chownow|ordercounter|doordash|ubereats|skytab|spoton|cloveronline|zenpepper)\b/.test(urlText) ||
    ["order.online", "order.toasttab.com", "order.spoton.com", "online.skytab.com", "hrpos.heartland.us"].some((provider) => host === provider || host.endsWith(`.${provider}`))) return "order";
  if (/\bmenu\b/.test(urlText) && /\b(order|order now|order online|online order|pickup|delivery)\b/.test(normalizeText(label))) return "order";
  if (/\bmenu\b/.test(urlText)) return "menu";
  if (isCareersText(urlText)) return "careers_jobs";
  if (/\b(catering|cater)\b/.test(urlText)) return "catering";
  if (/\b(event|events|class|classes)\b/.test(urlText)) return "events";
  if (/\b(reservation|reservations|reserve|opentable|resy)\b/.test(urlText)) return "reservations";
  if (/\b(gift card|gift cards|egift)\b/.test(urlText)) return "gift_cards";
  if (/\b(loyalty|reward|rewards)\b/.test(urlText)) return "loyalty_rewards";
  if (/\b(order|ordering|online order|olo|toast|chownow|ordercounter|doordash|ubereats|skytab|spoton|cloveronline|zenpepper)\b/.test(text)) return "order";
  if (/\bmenu\b/.test(text)) return "menu";
  if (isCareersText(text)) return "careers_jobs";
  if (/\b(catering|cater)\b/.test(text)) return "catering";
  if (/\b(event|events|class|classes)\b/.test(text)) return "events";
  if (/\b(reservation|reservations|reserve|opentable|resy)\b/.test(text)) return "reservations";
  if (/\b(gift card|gift cards|egift)\b/.test(text)) return "gift_cards";
  if (/\b(loyalty|reward|rewards)\b/.test(text)) return "loyalty_rewards";
  return null;
}

function categoryForTouchpoint(event) {
  const text = normalizeText([event.title, event.display_title, event.description, event.primary_button_text, event.link].filter(Boolean).join(" "));
  if (/\bmenu\b/.test(text)) return "menu";
  if (/\b(order|ordering|olo|online order)\b/.test(text)) return "order";
  if (/\b(app|download)\b/.test(text)) return "app_downloads";
  if (/\b(catering|cater)\b/.test(text)) return "catering";
  if (isCareersText(text)) return "careers_jobs";
  if (/\b(event|events|class|classes)\b/.test(text)) return "events";
  if (/\b(reservation|reservations|reserve)\b/.test(text)) return "reservations";
  if (/\b(gift card|gift cards|egift)\b/.test(text)) return "gift_cards";
  if (/\b(loyalty|reward|rewards)\b/.test(text)) return "loyalty_rewards";
  return "other_custom";
}

function isCareersText(text) {
  return /\b(career|careers|job|jobs|employment|apply|hiring|join our team|join the team|work with us|work for us)\b/.test(text);
}

function careerDiscoveryEvidence(category, href, label, sourceType, sourceUrl) {
  if (category !== "careers_jobs") return [];
  const evidence = [];
  if (sourceType === "website") evidence.push("official_site_careers_candidate=true");
  if (isCareersPageLevelUrl(href, label)) evidence.push("careers_page_level=true");
  if (isIndividualJobPostingUrl(href, label)) evidence.push("individual_job_posting=true");
  evidence.push(`career_candidate_score=${careerDiscoveryScore({ href, label, sourceType, sourceUrl })}`);
  return evidence;
}

function careerDiscoveryScore({ href, label, sourceType, sourceUrl }) {
  let score = 0;
  if (sourceType === "website") score += 200;
  if (isCareersPageLevelUrl(href, label)) score += 80;
  if (isIndividualJobPostingUrl(href, label)) score -= 100;
  if (isCareersTrapUrl(href, label)) score -= 500;
  const sourceHost = domain(sourceUrl);
  const candidateHost = domain(href);
  if (sameWebsiteDomain(candidateHost, sourceHost)) score += 40;
  return score;
}

function isCareersPageLevelUrl(href, label = "") {
  const text = normalizeText(`${href} ${label}`);
  if (isIndividualJobPostingUrl(href, label)) return false;
  return /\b(career|careers|jobs|employment|hiring|now hiring|join our team|join the team|work with us|work for us)\b/.test(text);
}

function isIndividualJobPostingUrl(href, label = "") {
  const text = normalizeText(`${href} ${label}`);
  return /\b(job detail|job details|job posting|posting|position|positions|opening|apply now|apply for|application|requisition|req id|job id)\b/.test(text) ||
    /\/(?:job|jobs|posting|postings|position|positions|apply)\/[a-z0-9-]{8,}/i.test(String(href || "")) ||
    /[?&](?:jobid|job_id|jid|postingid|posting_id|gh_jid|reqid|req_id)=/i.test(String(href || ""));
}

function isCareersTrapUrl(href, label = "") {
  const text = normalizeText(`${href} ${label}`);
  return /\b(login|sign in|account|profile|privacy|terms|benefits portal|employee portal)\b/.test(text) ||
    isAggregatorDomain(domain(href));
}

function verifierLinkTypeForCategory(category) {
  if (category === "instagram") return "social_instagram";
  if (category === "facebook") return "social_facebook";
  if (category === "tiktok") return "social_tiktok";
  if (category === "youtube") return "social_youtube";
  if (category === "x_twitter") return "social_x_twitter";
  if (category === "ios_app" || category === "android_app" || category === "app_downloads") return "app_download";
  if (category === "ordering" || category === "order" || category === "menu") return "ordering_menu";
  if (category === "website") return "website";
  return "other";
}

function categoryForVerifierLinkType(linkType, url) {
  if (linkType === "social_instagram") return "instagram";
  if (linkType === "social_facebook") return "facebook";
  if (linkType === "social_tiktok") return "tiktok";
  if (linkType === "social_youtube") return "youtube";
  if (linkType === "social_x_twitter") return "x_twitter";
  if (linkType === "app_download") return domain(url) === "apps.apple.com" ? "ios_app" : "android_app";
  if (linkType === "ordering_menu") return "order";
  return "other_custom";
}

function withWebsiteContext(location, links) {
  if (!location.website_url) return links;
  const hasWebsite = links.some((link) => link.category === "website");
  if (hasWebsite) return links;
  return [{
    category: "website",
    input_url: location.website_url,
    source_type: "v2_existing",
    source_table: "locations",
    source_field: "website_url",
    link_type: "website",
    title: "website_url"
  }, ...links];
}

function groupCandidates(links) {
  const out = new Map();
  for (const link of links) {
    if (!out.has(link.category)) out.set(link.category, []);
    out.get(link.category).push(link);
  }
  return out;
}

function rankCandidatesForVerification(candidates, location, args = {}) {
  if (args["verify-all-candidates"]) return candidates;
  const grouped = groupCandidates(candidates);
  const out = [];
  for (const [category, values] of grouped.entries()) {
    const limit = verifyLimitForCategory(category);
    const sorted = [...values].sort((a, b) => preVerificationScore(b, location) - preVerificationScore(a, location));
    if (category === "order" || category === "ordering") {
      const mustVerify = sorted.filter((candidate) => isOfficialWebsiteKnownOrderProviderCandidate(candidate));
      out.push(...dedupeCandidates([...mustVerify, ...sorted]).slice(0, Math.max(limit, mustVerify.length)));
    } else {
      out.push(...sorted.slice(0, limit));
    }
  }
  return out;
}

function verifyLimitForCategory(category) {
  if (category === "order" || category === "ordering") return 8;
  if (["menu", "catering", "events", "reservations", "careers_jobs"].includes(category)) return 4;
  if (["instagram", "facebook", "x_twitter", "youtube"].includes(category)) return 3;
  if (["tiktok", "ios_app", "android_app", "app_downloads"].includes(category)) return 2;
  return DISCOVERY_LIMITS.verify_candidates_per_category;
}

function isOfficialWebsiteKnownOrderProviderCandidate(candidate) {
  if (!candidate || candidate.source_type !== "website") return false;
  return isKnownOrderProviderHost(domain(candidate.input_url));
}

function preVerificationScore(candidate, location = {}) {
  const evidence = (candidate.source_evidence || []).join(" ");
  let score = 0;
  if (candidate.source_type === "website") score += 500;
  if (candidate.source_type === "external_link_in_bio") score += 220;
  if (candidate.source_type === "search") score += 80;
  if (candidate.source_type === "handle_guess") score -= 300;
  if (/official_site_order_candidate=true|official_site_careers_candidate=true/.test(evidence)) score += 200;
  if (/order_cta_text=true|careers_page_level=true/.test(evidence)) score += 90;
  if (/individual_job_posting=true/.test(evidence)) score -= 90;
  if (candidate.category === "order" || candidate.category === "ordering") score += orderDiscoveryScore({ href: candidate.input_url, label: evidence, sourceUrl: candidate.source_url, location });
  if (candidate.category === "careers_jobs") score += careerDiscoveryScore({ href: candidate.input_url, label: evidence, sourceType: candidate.source_type, sourceUrl: candidate.source_url });
  score += urlSpecificityScore(candidate.category, candidate.input_url);
  return score;
}

function urlSpecificityScore(category, value) {
  const text = normalizeText(value);
  let score = 0;
  if (category === "careers_jobs") {
    if (/\b(careers|career|jobs|employment|hiring|join our team|work with us)\b/.test(text)) score += 160;
    if (/\b(locations|location)\b/.test(text)) score -= 120;
  }
  if (category === "menu") {
    if (/\b(menu|menus|food menu|main menu)\b/.test(text)) score += 120;
    if (/\b(locations|location|home)\b/.test(text)) score -= 80;
  }
  if (category === "order" || category === "ordering") {
    if (/\b(order|ordering|online order|weborder|groups|items)\b/.test(text)) score += 120;
    if (/\b(tracking|track order|order status)\b/.test(text)) score -= 300;
  }
  if (category === "loyalty_rewards") {
    if (/\b(loyalty|reward|rewards|points|club)\b/.test(text)) score += 140;
    if (/\b(locations|location)\b/.test(text)) score -= 120;
  }
  if (["catering", "events", "reservations"].includes(category)) {
    if (customCategoryUrlSpecific(category, value)) score += 180;
    if (isGenericLocationPage(value)) score -= 180;
  }
  return score;
}

function chooseBestByCategory(links) {
  const grouped = groupCandidates(links);
  const out = new Map();
  for (const [category, values] of grouped.entries()) out.set(category, bestByStatus(values, category));
  return out;
}

function reclassifyVerifiedFunction(link) {
  if (link?.status !== "verified" || link.destination_state !== "functional") {
    return link;
  }
  const finalCategory = categoryForUrl(link.final_url || "", "");
  if (finalCategory === "reservations" && link.category !== "reservations") {
    return {
      ...link,
      category: "reservations",
      original_category: link.category,
      classification_evidence: [
        ...(link.classification_evidence || []),
        "reclassified_by_verified_function=destination_url_to_reservations",
      ],
    };
  }
  if (link.category !== "menu") return link;
  const signal = (link.destination_state_evidence || [])
    .map(String)
    .find((line) => line.startsWith("ordering_action_signal="))
    ?.slice("ordering_action_signal=".length);
  if (!["ordering_action_control", "ordering_action_page_copy", "provider_destination_url"].includes(signal)) {
    return link;
  }
  return {
    ...link,
    category: "order",
    original_category: "menu",
    classification_evidence: [
      ...(link.classification_evidence || []),
      `reclassified_by_verified_function=menu_to_order`,
      `ordering_action_signal=${signal}`,
    ],
  };
}

function bestByStatus(links, category = "", location = {}) {
  const eligibleLinks = (category === "order" || category === "ordering")
    ? links.filter((link) => orderSelectionScore(link, location) > -10000)
    : category === "careers_jobs"
      ? links.filter((link) => careerSelectionScore(link, location) > -10000)
      : links;
  const order = { verified: 0, needs_manual_review: 1, rejected: 2, broken: 3 };
  return [...eligibleLinks].sort((a, b) => {
    const statusDelta = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (statusDelta) return statusDelta;
    if (category === "order" || category === "ordering") {
      const delta = orderSelectionScore(b, location) - orderSelectionScore(a, location);
      return delta || stableVerifiedCandidateTieBreak(a, b, category, location);
    }
    if (category === "careers_jobs") {
      const delta = careerSelectionScore(b, location) - careerSelectionScore(a, location);
      return delta || stableVerifiedCandidateTieBreak(a, b, category, location);
    }
    if (category === "menu") {
      const delta = menuSelectionScore(b, location) - menuSelectionScore(a, location);
      return delta || stableVerifiedCandidateTieBreak(a, b, category, location);
    }
    if (["catering", "events", "reservations"].includes(category)) {
      const delta = customCategorySelectionScore(b, category) - customCategorySelectionScore(a, category);
      return delta || stableVerifiedCandidateTieBreak(a, b, category, location);
    }
    if (["instagram", "facebook", "tiktok", "youtube", "x_twitter"].includes(category)) {
      // Socials Discovery Contract: a social link published on the location's own
      // official website outranks any search-sourced candidate of the same verifier
      // status. This was previously an implicit insertion-order tie-break.
      return socialSourceRank(a) - socialSourceRank(b);
    }
    return stableVerifiedCandidateTieBreak(a, b, category, location);
  })[0] || null;
}

function stableVerifiedCandidateTieBreak(a, b, category, location = {}) {
  const locationDelta = orderLocationScore(
    [b.input_url, b.final_url, b.source_url].filter(Boolean).join(" "),
    location,
  ) - orderLocationScore(
    [a.input_url, a.final_url, a.source_url].filter(Boolean).join(" "),
    location,
  );
  if (locationDelta) return locationDelta;

  const directDelta = Number(customCategoryUrlSpecific(category, b.final_url || b.input_url)) -
    Number(customCategoryUrlSpecific(category, a.final_url || a.input_url));
  if (directDelta) return directDelta;

  return String(a.final_url || a.input_url || "").localeCompare(String(b.final_url || b.input_url || ""));
}

function socialSourceRank(link) {
  if (link.source_type === "website") return 0;
  if (/official_website_links_to_candidate=true/.test(allEvidence(link))) return 1;
  if (link.source_type === "external_link_in_bio") return 2;
  if (link.source_type === "search") return 3;
  if (link.source_type === "handle_guess") return 5;
  return 4;
}

function customCategorySelectionScore(link, category) {
  let score = 0;
  if (customCategoryDestinationSpecific(category, link)) score += 500;
  if (link.source_type === "website") score += 180;
  if (link.source_type === "v2_existing") score -= 160;
  if (isGenericLocationPage(link.input_url)) score -= 250;
  if (trustedCustomPlatform(category, domain(link.final_url || link.input_url))) score += 80;
  score += urlSpecificityScore(category, link.input_url);
  return score;
}

function menuSelectionScore(link, location = {}) {
  let score = link.source_type === "website" ? 100 : 0;
  const evidence = (link.source_evidence || []).join(" ");
  if (/link_source=(?:anchor|nav)/.test(evidence)) score += 120;
  if (/link_source=script-url/.test(evidence)) score -= 120;
  try {
    const pathParts = new URL(ensureProtocol(link.input_url)).pathname
      .split("/")
      .filter(Boolean);
    if (pathParts.length === 1 && /^menus?$/i.test(pathParts[0])) score += 500;
    if (pathParts.length > 1 && /^menus?$/i.test(pathParts[0])) {
      score -= (pathParts.length - 1) * 60;
    }
  } catch {
    // URL validation happens elsewhere; an invalid candidate receives no path preference.
  }
  score += orderLocationScore(
    [link.input_url, link.final_url, link.source_url].filter(Boolean).join(" "),
    location,
  ) * 100;
  return score;
}

function careersAutoWriteEligible(link) {
  if (!link || link.status !== "verified") return false;
  if (link.source_type === "website") return true;
  const evidence = [...(link.source_evidence || []), ...(link.location_match_evidence || []), ...(link.validity_evidence || [])].join(" ");
  return /official_website_links_to_candidate=true/.test(evidence);
}

function blindWriteEligible(category, link, location = null, existing = null) {
  if (!link || link.status !== "verified") return false;
  if (existing?.status === "verified") return false;
  const evidence = allEvidence(link);
  const url = [link.input_url, link.final_url].filter(Boolean).join(" ");
  const host = domain(link.final_url || link.input_url);

  if (category === "ordering" || category === "order") {
    return link.source_type === "website" &&
      !hasNegativeWriteEvidence(link) &&
      !isOrderTrapUrl(url, evidence) &&
      !isPlainMenuUrl(link.input_url) &&
      !orderGeoConflict(link, location) &&
      (/official_site_order_candidate=true/.test(evidence) || isKnownOrderProviderHost(host) || /order_cta_text=true/.test(evidence));
  }

  if (CUSTOM_DESTINATION_CATEGORIES.has(category)) {
    return link.source_type === "website" &&
      !hasNegativeWriteEvidence(link) &&
      customCategoryDestinationSpecific(category, link) &&
      (category !== "events" || hasUpcomingEventEvidence(link)) &&
      /official_website_links_to_candidate=true/.test(evidence);
  }

  if (hasNegativeWriteEvidence(link)) return false;

  if (SOCIAL_CATEGORIES.has(category)) {
    return link.source_type === "website" || /official_website_links_to_candidate=true/.test(evidence);
  }
  if (["ios_app", "android_app", "app_downloads"].includes(category)) {
    return /official_website_links_to_candidate=true/.test(evidence);
  }
  if (category === "menu") {
    return link.source_type === "website" && !hasBadHttpEvidence(link) && !isGenericLocationPage(link.input_url);
  }
  if (category === "careers_jobs") {
    return careersAutoWriteEligible(link) &&
      !isAggregatorDomain(host) &&
      /careers_page_level=true|career|careers|jobs|employment|hiring|join/i.test(`${link.input_url} ${evidence}`) &&
      !isGenericLocationPage(link.input_url);
  }
  if (category === "gift_cards") {
    return link.source_type === "website" && /\b(gift|egift|gift card|gift cards)\b/i.test(`${link.input_url} ${evidence}`);
  }
  if (category === "loyalty_rewards") {
    return link.source_type === "website" && /\b(loyalty|reward|rewards|points|club)\b/i.test(`${link.input_url} ${evidence}`) && !isGenericLocationPage(link.input_url);
  }
  return false;
}

function shouldManualReviewCandidate(category, link, location = null) {
  if (!link) return false;
  // Use the HARD-negative gate here (not hasNegativeWriteEvidence): a bot/security
  // challenge or a soft fetch timeout must NOT bar a candidate from manual review.
  // Those blocks are not evidence the page is dead, so a location-matched /
  // official-site-linked link (e.g. Yelp 403, a slow official order page) should be
  // held for a human, not silently dropped to found_rejected. Genuinely dead pages
  // (404/410, "page not found", real 5xx) are still hard-negative and excluded.
  if (hasHardNegativeWriteEvidence(link)) return false;
  const evidence = allEvidence(link);
  const url = [link.input_url, link.final_url].filter(Boolean).join(" ");
  const host = domain(link.final_url || link.input_url);
  const officialWebsiteEvidence = link.source_type === "website" || /official_website_links_to_candidate=true/.test(evidence);

  if (SOCIAL_CATEGORIES.has(category)) {
    // A verified search result still needs ownership review without an official-site link.
    return officialWebsiteEvidence ||
      (link.status === "verified" && link.liveness === "live" && link.relevance === "match");
  }
  if (["ios_app", "android_app", "app_downloads"].includes(category)) {
    return officialWebsiteEvidence;
  }
  if (category === "ordering" || category === "order") {
    return link.source_type === "website" && !isOrderTrapUrl(url, evidence) && !isPlainMenuUrl(link.input_url) && !orderGeoConflict(link, location);
  }
  if (category === "menu") {
    return link.source_type === "website" && !isGenericLocationPage(link.input_url);
  }
  if (category === "careers_jobs") {
    return officialWebsiteEvidence &&
      !isAggregatorDomain(host) &&
      !isGenericLocationPage(link.input_url) &&
      /careers_page_level=true|career|careers|jobs|employment|hiring|join/i.test(`${link.input_url} ${evidence}`);
  }
  if (CUSTOM_DESTINATION_CATEGORIES.has(category)) {
    return (link.source_type === "website" || trustedCustomPlatform(category, host)) &&
      !/security_or_bot_challenge_detected=true/.test(evidence);
  }
  if (category === "gift_cards") {
    return link.source_type === "website" &&
      !isAggregatorDomain(host) &&
      /\b(gift|egift|gift card|gift cards)\b/i.test(`${link.input_url} ${evidence}`);
  }
  if (category === "loyalty_rewards") {
    return link.source_type === "website" &&
      !isGenericLocationPage(link.input_url) &&
      /\b(loyalty|reward|rewards|points|club)\b/i.test(`${link.input_url} ${evidence}`);
  }
  return false;
}

function hasUpcomingEventEvidence(link) {
  return link?.event_timing?.has_upcoming_event === true &&
    Array.isArray(link.event_timing.upcoming_event_dates) &&
    link.event_timing.upcoming_event_dates.length > 0;
}

function eventNeedsLunaReview(link, location = {}) {
  if (link?.category !== "events" || hasUpcomingEventEvidence(link)) return false;
  if (link.status !== "verified" || link.liveness !== "live" || link.relevance !== "match") return false;
  if (link.destination_state !== "functional") return false;
  const candidateHost = domain(link.final_url || link.input_url);
  const officialHost = domain(location.website_url);
  if (!candidateHost || !officialHost || (candidateHost !== officialHost && !candidateHost.endsWith(`.${officialHost}`))) return false;
  return String(link.page_evidence?.text_sample || "").trim().length >= 40;
}

function buildEventLunaPacket(link, location = {}, referenceTime = checkedAt()) {
  const packet = {
    schema_version: 1,
    model: EVENT_LUNA_MODEL,
    reference_time: referenceTime,
    location: {
      location_id: location.location_id || null,
      name: location.location_name || location.name || null,
      account_name: location.account_name || null,
      address: location.address || location.full_address || [
        location.shipping_address_line1,
        location.shipping_city,
        location.shipping_state,
        location.shipping_zip,
      ].filter(Boolean).join(", ") || null,
      official_website: location.website_url || null,
    },
    candidate: {
      category: "events",
      input_url: link.input_url,
      final_url: link.final_url || link.input_url,
      source_type: link.source_type || link.source?.source_table || null,
      liveness: link.liveness,
      relevance: link.relevance,
      page_evidence: link.page_evidence || null,
      deterministic_event_timing: link.event_timing || null,
    },
  };
  return {
    ...packet,
    evidence_hash: crypto.createHash("sha256").update(JSON.stringify(packet)).digest("hex"),
  };
}

async function reviewAmbiguousEventsWithLuna(links, location = {}, args = {}) {
  if (args.replay || args["event-luna"] === "off" || args["no-event-luna"]) {
    return { links, reviewed: 0, accepted: 0, unavailable: 0 };
  }
  const referenceTime = args["event-reference-time"] || checkedAt();
  let reviewed = 0;
  let accepted = 0;
  let unavailable = 0;
  const out = [];
  for (const link of links) {
    if (!eventNeedsLunaReview(link, location)) {
      out.push(link);
      continue;
    }
    reviewed += 1;
    const packet = buildEventLunaPacket(link, location, referenceTime);
    try {
      const review = typeof args.eventLunaReviewer === "function"
        ? await args.eventLunaReviewer(packet)
        : invokeEventLuna(packet, args);
      const applied = applyLunaEventReview(link, review, packet);
      if (applied.event_timing?.source === EVENT_LUNA_MODEL && applied.event_timing?.has_upcoming_event === true) {
        accepted += 1;
      }
      out.push(applied);
    } catch (error) {
      unavailable += 1;
      out.push({
        ...link,
        event_timing: {
          ...(link.event_timing || {}),
          luna_review: {
            status: "unavailable",
            model: EVENT_LUNA_MODEL,
            candidate_url: packet.candidate.final_url,
            evidence_hash: packet.evidence_hash,
            reason: safeLunaError(error),
            reviewed_at: checkedAt(),
          },
          evidence: [
            ...(link.event_timing?.evidence || []),
            "event_luna_review=unavailable",
          ],
        },
      });
    }
  }
  return { links: out, reviewed, accepted, unavailable };
}

function runtimeEnvironment() {
  // The extension REPL omits process; undefined preserves the child host environment.
  return typeof process === "undefined" ? undefined : process.env;
}

function invokeEventLuna(packet, args = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-event-luna-"));
  const outputPath = path.join(tempDir, "review.json");
  const codexBin = args["codex-bin"] || runtimeEnvironment()?.CODEX_BIN || "codex";
  const prompt = [
    "You are the declared GPT-5.6 Luna exception reviewer for Boostly event links.",
    "Judge only the validated page evidence packet below. Do not use tools, browse, or modify anything.",
    "Determine whether the official first-party page visibly proves at least one genuinely upcoming customer event as of reference_time.",
    "Visible event cards and recurring-event copy are valid evidence even when the page omits JSON-LD or time[datetime].",
    "Do not count generic private-event marketing, past-only events, undated announcements, or ambiguous stale content.",
    "For a yearless month/day, infer the current or next year only when the displayed weekday, current date, ordering, and recurrence make that inference unambiguous.",
    "normalized_start_date must be YYYY-MM-DD. Copy title, date_text, time_text, and recurrence_text from the packet, using an empty string when absent.",
    "Echo candidate_url and evidence_hash exactly. Return only JSON matching the supplied schema.",
    JSON.stringify(packet),
  ].join("\n\n");
  try {
    execFileSync(codexBin, [
      "exec",
      "--model", EVENT_LUNA_MODEL,
      "--sandbox", "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color", "never",
      "--output-schema", EVENT_LUNA_SCHEMA,
      "--output-last-message", outputPath,
      "--cd", os.tmpdir(),
      prompt,
    ], {
      encoding: "utf8",
      timeout: Number(args["event-luna-timeout-ms"] || 120000),
      maxBuffer: 12 * 1024 * 1024,
      env: runtimeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function applyLunaEventReview(link, review, packet) {
  const validation = validateLunaEventReview(review, packet);
  if (!validation.valid) {
    throw new Error(`invalid_luna_event_review:${validation.errors.join(",")}`);
  }
  const reviewedAt = checkedAt();
  const acceptedEvents = validation.acceptedEvents;
  const accepted = review.verdict === "upcoming_events_verified" &&
    review.confidence >= EVENT_LUNA_MIN_CONFIDENCE && acceptedEvents.length > 0;
  const lunaReview = {
    ...review,
    events: acceptedEvents,
    status: accepted ? "accepted" : "reviewed_no_override",
    reviewed_at: reviewedAt,
  };
  if (!accepted) {
    return {
      ...link,
      event_timing: {
        ...(link.event_timing || {}),
        luna_review: lunaReview,
        evidence: [
          ...(link.event_timing?.evidence || []),
          `event_luna_review=${review.verdict}`,
          `event_luna_confidence=${review.confidence}`,
        ],
      },
    };
  }
  const upcomingDates = [...new Set(acceptedEvents.map((event) => event.normalized_start_date))];
  const priorEvidence = (link.event_timing?.evidence || []).filter((item) =>
    !/upcoming_event_evidence=false|No future structured Event startDate/i.test(String(item)));
  return {
    ...link,
    event_timing: {
      ...(link.event_timing || {}),
      source: EVENT_LUNA_MODEL,
      has_upcoming_event: true,
      upcoming_event_dates: upcomingDates,
      inspected_event_dates: upcomingDates,
      luna_review: lunaReview,
      evidence: [
        ...priorEvidence,
        "structured_upcoming_event_evidence=false",
        "upcoming_event_evidence=true",
        `upcoming_event_evidence_source=${EVENT_LUNA_MODEL}`,
        `event_luna_evidence_hash=${packet.evidence_hash}`,
        ...upcomingDates.slice(0, 4).map((date) => `upcoming_event_date=${date}`),
      ],
    },
  };
}

function validateLunaEventReview(review, packet) {
  const errors = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return { valid: false, errors: ["review_must_be_object"], acceptedEvents: [] };
  }
  if (review.schema_version !== 1) errors.push("schema_version");
  if (review.model !== EVENT_LUNA_MODEL) errors.push("model");
  if (review.candidate_url !== packet.candidate.final_url) errors.push("candidate_url");
  if (review.evidence_hash !== packet.evidence_hash) errors.push("evidence_hash");
  if (!["upcoming_events_verified", "no_upcoming_events", "insufficient_evidence"].includes(review.verdict)) errors.push("verdict");
  if (!Number.isFinite(review.confidence) || review.confidence < 0 || review.confidence > 1) errors.push("confidence");
  if (typeof review.reason !== "string" || !review.reason.trim()) errors.push("reason");
  if (!Array.isArray(review.events)) errors.push("events");
  const acceptedEvents = Array.isArray(review.events)
    ? review.events.filter((event) => validLunaEventEvidence(event, packet))
    : [];
  if (review.verdict === "upcoming_events_verified") {
    if (review.confidence < EVENT_LUNA_MIN_CONFIDENCE) errors.push("confidence_below_write_gate");
    if (!acceptedEvents.length) errors.push("no_grounded_upcoming_event");
  }
  return { valid: errors.length === 0, errors, acceptedEvents };
}

function validLunaEventEvidence(event, packet) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event.normalized_start_date || ""))) return false;
  const corpus = normalizeText([
    packet.candidate.page_evidence?.text_sample,
    ...(packet.candidate.page_evidence?.h1 || []),
    ...(packet.candidate.page_evidence?.h2 || []),
  ].filter(Boolean).join(" "));
  const title = normalizeText(event.title);
  const dateText = normalizeText(event.date_text);
  if (!dateText || !corpus.includes(dateText)) return false;
  if (title && !corpus.includes(title)) return false;
  const normalizedDate = new Date(`${event.normalized_start_date}T12:00:00Z`);
  const referenceDate = new Date(packet.reference_time);
  if (!Number.isFinite(normalizedDate.getTime()) || !Number.isFinite(referenceDate.getTime())) return false;
  const deltaDays = (normalizedDate.getTime() - referenceDate.getTime()) / 86400000;
  if (deltaDays < -1 || deltaDays > 370) return false;
  const monthName = normalizedDate.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
  if (!dateText.includes(monthName) || !new RegExp(`\\b${normalizedDate.getUTCDate()}(?:st|nd|rd|th)?\\b`).test(dateText)) return false;
  const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const statedWeekday = weekdayNames.find((weekday) => dateText.includes(weekday));
  if (statedWeekday && statedWeekday !== weekdayNames[normalizedDate.getUTCDay()]) return false;
  return true;
}

function safeLunaError(error) {
  const stderr = String(error?.stderr || "");
  const apiMessage = stderr.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  const message = apiMessage || error?.code || String(error?.message || error || "unknown_error").split("\n")[0];
  return message.replace(/(?:sk|sess)-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 240);
}

function manualReviewReason(result) {
  const selected = result.selected_link;
  if (result.candidate_conflict) {
    return `Deterministic candidate tie has conflicting evidence: ${result.candidate_conflict.urls.join(" vs ")}`;
  }
  if (SOCIAL_CATEGORIES.has(result.category) && selected?.status === "verified" &&
      selected.source_type !== "website" && !/official_website_links_to_candidate=true/.test(allEvidence(selected))) {
    return "Social profile matches the business, but lacks official-site backing. Confirm brand ownership before saving.";
  }
  if (result.category === "events" && selected?.status === "verified" && !hasUpcomingEventEvidence(selected)) {
    const lunaReview = selected.event_timing?.luna_review;
    if (lunaReview?.status === "unavailable") {
      return `Events page is live, but ${EVENT_LUNA_MODEL} verification was unavailable: ${lunaReview.reason}`;
    }
    if (lunaReview?.reason) {
      return `${EVENT_LUNA_MODEL} did not verify an upcoming event: ${lunaReview.reason}`;
    }
    return "Events page is live, but no concrete future Event startDate or time[datetime] evidence was found.";
  }
  return selected?.rejection_reason || result.existing_link?.rejection_reason || "Selected link needs manual review.";
}

function conflictingTopCandidates(candidates, category, location = {}) {
  const verified = candidates.filter((candidate) => candidate.status === "verified");
  if (verified.length < 2) return null;
  const ranked = [...verified].sort((left, right) => selectionScore(right, category, location) - selectionScore(left, category, location));
  const first = ranked[0];
  const second = ranked[1];
  if (selectionScore(first, category, location) !== selectionScore(second, category, location)) return null;
  if (sameUrl(first.input_url, second.input_url) || sameUrl(first.final_url, second.final_url)) return null;
  if (sameVerifiedFirstPartyDestinationFamily(first, second)) return null;
  return {
    reason: "equal_deterministic_score_with_distinct_verified_destinations",
    score: selectionScore(first, category, location),
    urls: [first.input_url, second.input_url].filter(Boolean)
  };
}

function sameVerifiedFirstPartyDestinationFamily(first, second) {
  if (first.status !== "verified" || second.status !== "verified") return false;
  if (first.relevance !== "match" || second.relevance !== "match") return false;
  if (hasNegativeWriteEvidence(first) || hasNegativeWriteEvidence(second)) return false;
  const firstHost = domain(first.final_url || first.input_url);
  const secondHost = domain(second.final_url || second.input_url);
  if (!firstHost || !secondHost || registrableDomain(firstHost) !== registrableDomain(secondHost)) return false;
  return first.source_type === "website" && second.source_type === "website";
}

function selectionScore(link, category, location) {
  if (category === "order" || category === "ordering") return orderSelectionScore(link, location);
  if (category === "careers_jobs") return careerSelectionScore(link, location);
  if (category === "menu") return menuSelectionScore(link, location);
  if (["catering", "events", "reservations"].includes(category)) return customCategorySelectionScore(link, category);
  if (["instagram", "facebook", "tiktok", "youtube", "x_twitter"].includes(category)) return 100 - socialSourceRank(link);
  return urlSpecificityScore(category, link.input_url) + (link.source_type === "website" ? 100 : 0);
}

function hasNegativeWriteEvidence(link) {
  // This is the AUTO-WRITE gate: a bot/security challenge OR a soft fetch timeout must
  // never auto-write (the page could not actually be inspected). These are deliberately
  // absent from hasHardNegativeWriteEvidence so they still route to manual review.
  return hasHardNegativeWriteEvidence(link) || UNVERIFIED_FETCH_EVIDENCE.test(allEvidence(link));
}

function hasHardNegativeWriteEvidence(link) {
  if (DEAD_PAGE_EVIDENCE.test(allEvidence(link))) return true;
  return hasBadHttpEvidenceIgnoringBotChallenge(link);
}

function hasBadHttpEvidence(link) {
  return BAD_HTTP_EVIDENCE.test(allEvidence(link));
}

function hasBadHttpEvidenceIgnoringBotChallenge(link) {
  const evidence = allEvidence(link);
  return !/security_or_bot_challenge_detected=true/.test(evidence) && BAD_HTTP_EVIDENCE.test(evidence);
}

function allEvidence(link) {
  return [
    link.input_url,
    link.final_url,
    link.source_url,
    ...(link.source_evidence || []),
    ...(link.location_match_evidence || []),
    ...(link.validity_evidence || [])
  ].filter(Boolean).join(" ");
}

function trustedCustomPlatform(category, host) {
  if (!host) return false;
  if (category === "reservations") return ["opentable.com", "resy.com", "exploretock.com", "tockify.com"].some((provider) => host === provider || host.endsWith(`.${provider}`));
  if (category === "catering") return ["ezcater.com", "perfectvenue.com"].some((provider) => host === provider || host.endsWith(`.${provider}`));
  return false;
}

function customCategoryDestinationSpecific(category, link) {
  if (!["catering", "events", "reservations"].includes(category) || !link) return false;
  const finalUrl = link.final_url || link.input_url;
  if (!customCategoryUrlSpecific(category, finalUrl)) return false;
  if (!link.final_url) return true;
  const inputHost = domain(link.input_url);
  const finalHost = domain(link.final_url);
  return !inputHost || !finalHost || sameWebsiteDomain(inputHost, finalHost);
}

function customCategoryUrlSpecific(category, value) {
  try {
    const u = new URL(ensureProtocol(value));
    const pathText = normalizeText(decodeURIComponent(u.pathname || ""));
    if (!pathText) return false;
    if (category === "catering") return /\b(catering|cater|group order|group orders|party trays|party tray|banquet|banquets)\b/.test(pathText);
    if (category === "events") return /\b(event|events|class|classes|private event|private events|party|parties|calendar)\b/.test(pathText);
    if (category === "reservations") return /\b(reservation|reservations|reserve|booking|book table|book a table|waitlist|wait list)\b/.test(pathText);
    return false;
  } catch {
    return false;
  }
}

function hasConfiguredUrlInOtherTouchpoint(category, link, touchpointEvents = []) {
  if (LOCATION_FIELD_BY_CATEGORY[category] || !link) return false;
  const proposed = normalizeTouchpointUrlForCompare(proposalUrlForLink(category, link));
  if (!proposed) return false;
  return touchpointEvents.some((event) => {
    if (!event?.link || event.deleted_at) return false;
    if (categoryForTouchpoint(event) === category) return false;
    return normalizeTouchpointUrlForCompare(event.link) === proposed;
  });
}

function normalizeTouchpointUrlForCompare(value) {
  try {
    const u = new URL(ensureProtocol(value));
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (isDisposableQueryParam(key, "")) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    u.protocol = "https:";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return normalizeUrlForCompare(value);
  }
}

function isAggregatorDomain(host) {
  return ["mapquest.com", "yelp.com", "tripadvisor.com", "indeed.com", "glassdoor.com", "ziprecruiter.com"].some((provider) => host === provider || host.endsWith(`.${provider}`));
}

function isGenericLocationPage(value) {
  try {
    const u = new URL(ensureProtocol(value));
    const pathName = u.pathname.replace(/\/+$/, "").toLowerCase();
    return pathName === "/locations" || pathName === "/location" || pathName === "";
  } catch {
    return false;
  }
}

function isPlainMenuUrl(value) {
  try {
    const u = new URL(ensureProtocol(value));
    const host = domain(u.toString());
    if (isKnownOrderProviderHost(host)) return false;
    const pathName = normalizeText(u.pathname);
    return /\bmenus?\b/.test(pathName) && !/\b(order|ordering|online order|weborder|pickup|delivery)\b/.test(pathName);
  } catch {
    return false;
  }
}

function orderGeoConflict(link, location = {}) {
  if (!link || !location) return false;
  const text = normalizeText([link.input_url, link.final_url].filter(Boolean).join(" "));
  if (!text) return false;
  const currentCity = normalizeText(location.shipping_city || cityFromFullAddress(location.address));
  const currentStreetNumber = normalizeText(String(location.address || location.shipping_address_line1 || "").match(/\b\d{2,6}\b/)?.[0] || "");
  const currentStreetWords = streetWordsForConflict(location.address || location.shipping_address_line1);
  const currentGeoTokens = [currentCity, currentStreetNumber, ...currentStreetWords].filter(Boolean);
  const hasCurrentGeo = currentGeoTokens.some((token) => token.length >= 3 && text.includes(token));
  const candidateHost = domain(link.final_url || link.input_url);

  const urlNumbers = [...text.matchAll(/\b\d{2,6}\b/g)].map((match) => match[0]);
  if (candidateHost.includes("toasttab.com") && currentStreetNumber && urlNumbers.some((number) => number !== currentStreetNumber) && !text.includes(currentStreetNumber)) return true;

  const conflictingCities = ["denver", "fort collins", "sacramento", "santa ana", "costa mesa", "idaho falls", "morgantown", "newport", "columbus", "downers grove", "ormond beach", "napa", "hapeville"]
    .map(normalizeText)
    .filter((city) => city && city !== currentCity);
  if (currentCity && conflictingCities.some((city) => text.includes(city)) && !hasCurrentGeo) return true;
  return false;
}

function streetWordsForConflict(address) {
  return normalizeText(address)
    .replace(/\b(usa|united states|st|street|ave|avenue|rd|road|blvd|boulevard|unit|ste|suite|w|e|n|s|north|south|east|west)\b/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .slice(0, 3);
}

function careerSelectionScore(link, location = {}) {
  const url = [link.input_url, link.final_url, link.source_url].filter(Boolean).join(" ");
  const evidence = [...(link.source_evidence || []), ...(link.location_match_evidence || []), ...(link.validity_evidence || [])].join(" ");
  let score = 0;
  if (isGenericLocationPage(link.input_url)) return -10000;
  if (isCareersTrapUrl(url, evidence)) return -10000;
  if (link.status === "verified") score += 1000;
  if (careersAutoWriteEligible(link)) score += 500;
  if (link.source_type === "website") score += 250;
  if (link.source_type === "search") score -= 150;
  if (/official_site_careers_candidate=true/.test(evidence)) score += 160;
  if (/official_website_links_to_candidate=true/.test(evidence)) score += 140;
  if (/careers_page_level=true/.test(evidence)) score += 80;
  if (/individual_job_posting=true/.test(evidence)) score -= 120;
  const candidateHost = domain(link.final_url || link.input_url);
  const websiteHost = domain(location.website_url);
  if (sameWebsiteDomain(candidateHost, websiteHost)) score += 80;
  score += numericEvidenceValue(evidence, "career_candidate_score");
  return score;
}

function orderSelectionScore(link, location = {}) {
  const url = [link.input_url, link.final_url, link.source_url].filter(Boolean).join(" ");
  const evidence = [...(link.source_evidence || []), ...(link.location_match_evidence || []), ...(link.validity_evidence || [])].join(" ");
  let score = 0;
  if (isOrderTrapUrl(url, evidence)) return -10000;
  if (isPlainMenuUrl(link.input_url)) return -10000;
  if (orderGeoConflict(link, location)) return -10000;
  if (link.source_type === "website") score += 120;
  if (link.source_type === "search") score -= 300;
  const candidateHost = domain(link.final_url || link.input_url);
  const websiteHost = domain(location.website_url);
  if (isKnownOrderProviderHost(candidateHost)) score += 130;
  if (isOrderingSubdomain(candidateHost, websiteHost)) score += 130;
  score += orderProviderPreferenceScore(candidateHost);
  if (sameWebsiteDomain(candidateHost, websiteHost)) score += 35;
  if (/official_site_order_candidate=true/.test(evidence)) score += 80;
  if (/order_cta_text=true/.test(evidence)) score += 60;
  score += numericEvidenceValue(evidence, "order_candidate_score");
  score += numericEvidenceValue(evidence, "order_location_score");
  score += orderLocationScore(url, location);
  if (/(gift|egift|giftcard|gift-card|giftcards|cardfoundry|marketing-signup|newsletter|order-settings|admin|settings|login|account|ordering-unavailable|unavailable|closed|locator|our-locator|find-us)/i.test(url)) score -= 500;
  if (/(doordash|ubereats|grubhub)/i.test(url)) score -= 25;
  return score;
}

function numericEvidenceValue(evidence, key) {
  const match = String(evidence || "").match(new RegExp(`${key}=(-?\\d+)`));
  return match ? Number(match[1]) || 0 : 0;
}

function orderProviderPreferenceScore(host) {
  if (!host) return 0;
  if (host === "online.skytab.com") return 25;
  if (host.endsWith("cloveronline.com")) return 20;
  if (host === "order.spoton.com") return 20;
  if (host === "order.toasttab.com" || host === "toasttab.com") return 20;
  if (host.endsWith("ordercounter.com")) return 20;
  if (host.endsWith("zenpepper.com")) return 20;
  if (host === "order.online") return 5;
  if (host.endsWith("doordash.com") || host.endsWith("ubereats.com") || host.endsWith("grubhub.com")) return -25;
  return 0;
}

function dedupeCandidates(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.category}:${normalizeUrlForCompare(candidate.input_url)}`;
    if (!seen.has(key)) seen.set(key, candidate);
  }
  return [...seen.values()];
}

function hasConfiguredCategory(category, touchpointEvents) {
  if (LOCATION_FIELD_BY_CATEGORY[category]) return false;
  return touchpointEvents.some((event) => categoryForTouchpoint(event) === category && event.link);
}

function toCandidateRecord(link) {
  return {
    category: link.category,
    input_url: link.input_url,
    final_url: link.final_url,
    source_type: link.source_type || link.source?.source_table || null,
    source_url: link.source_url || null,
    source_evidence: link.source_evidence || [],
    fetch_method: link.fetch_method,
    liveness: link.liveness,
    relevance: link.relevance,
    status: link.status,
    status_basis: link.status_basis || "evidence",
    validity_evidence: link.validity_evidence || [],
    location_match_evidence: link.location_match_evidence || [],
    rejection_reason: link.rejection_reason,
    event_timing: link.event_timing || null,
    page_evidence: link.page_evidence || null,
    checked_at: link.checked_at
  };
}

function shouldCrawlSameDomain(url, label = "") {
  const text = normalizeText(`${url} ${label}`);
  return isCareersText(text) || /\b(menu|menus|order|cater|event|reservation|gift|reward|contact|about|location|locations)\b/.test(text);
}

function highSignalLocationCrawlLink(url, label = "", location = {}) {
  const text = normalizeText(`${url} ${label}`);
  if (!/\b(menu|order|location|locations)\b/.test(text)) return false;
  const tokens = orderLocationTokens(location);
  return [...tokens.exact, ...tokens.strong, ...tokens.medium]
    .filter((token) => token.length >= 3)
    .some((token) => text.includes(token));
}

function isJunkLink(href, label) {
  const text = `${href} ${label}`;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return true;
  if (/\.(?:png|jpe?g|webp|gif|svg|ico|css|js|woff2?|ttf)(?:[?#].*)?$/i.test(href)) return true;
  if (isFacebookProfileUrl(href)) return false;
  return JUNK_LINK_RE.test(text);
}

function linkLabelFromUrl(url) {
  try {
    const u = new URL(ensureProtocol(url));
    return decodeURIComponent(`${u.hostname} ${u.pathname}`).replace(/[-_/]+/g, " ").trim();
  } catch {
    return String(url || "");
  }
}

function cleanCandidateUrl(url) {
  try {
    const raw = decodeHtml(String(url || "").trim())
      .replace(/\\+["']?$/g, "")
      .replace(/[\\s\"'),;]+$/g, "");
    const u = new URL(ensureProtocol(raw));
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "").trim();
  }
}

function urlWithoutHash(url) {
  try {
    const u = new URL(ensureProtocol(url));
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "");
  }
}

function isFacebookProfileUrl(value) {
  try {
    const u = new URL(ensureProtocol(value));
    return u.hostname.replace(/^www\./, "").toLowerCase() === "facebook.com" &&
      u.pathname === "/profile.php" &&
      Boolean(u.searchParams.get("id"));
  } catch {
    return false;
  }
}

function cleanQueryValue(value) {
  return String(value || "").trim().replace(/^"+|"+$/g, "");
}

function csvArgSet(value) {
  if (!value) return null;
  const values = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? new Set(values) : null;
}

function categoryTitle(category) {
  return {
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
    youtube: "YouTube",
    x_twitter: "X",
    ios_app: "iOS App",
    android_app: "Android App",
    ordering: "Online Ordering",
    order: "Order Online",
    menu: "Menu",
    app_downloads: "Download App",
    catering: "Catering",
    careers_jobs: "Careers",
    events: "Events",
    reservations: "Reservations",
    gift_cards: "Gift Cards",
    loyalty_rewards: "Rewards",
    other_custom: "Learn More"
  }[category] || category;
}

function queryJson(sql) {
  const raw = execFileSync(V2_DB, ["query", "--json", "--sql", sql], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw);
}

function sameUrl(a, b) {
  return normalizeUrlForCompare(a) === normalizeUrlForCompare(b);
}

function hashUrl(url) {
  return crypto.createHash("sha1").update(normalizeUrlForCompare(url) || String(url)).digest("hex");
}

function attr(attrs, name) {
  return attrs.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] || "";
}

function toAbsolute(href, base) {
  try { return new URL(href, base).toString(); }
  catch { return ""; }
}

function stripHtml(html) {
  return decodeHtml(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function normalizeText(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function sqlEscape(value) {
  return String(value || "").replaceAll("'", "''");
}

function checkedAt() {
  return new Date().toISOString();
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

if (typeof process !== "undefined" && process.argv?.[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  main(args).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

export {
  BROWSER_MANIFEST_FORMAT,
  BROWSER_RESULTS_FORMAT,
  CATEGORY_SET,
  CLAUDE_CHROME_PROVIDER,
  CODEX_EXTENSION_PROVIDER,
  ClaudeChromePageAdapter,
  FULFILLMENT_BROWSER_PROVIDERS,
  FixtureStore,
  MissingFixtureError,
  PROFILE_RESOLUTION_EXTENSION,
  PROFILE_RESOLUTION_LOCAL_STATE,
  PROFILE_RESOLUTION_USER_CONFIRMED,
  browserResultKey,
  chromeProfileResolutionErrors,
  connectedBrowserRows,
  defaultChromeConfirmedDevicePath,
  defaultChromeLocalStatePath,
  readChromeConfirmedDevice,
  resolveChromeProfileViaUserConfirmation,
  loadBrowserResults,
  profileNameForKey,
  readChromeLocalStateProfiles,
  resolveBrowserManifestPath,
  resolveChromeProfileViaLocalState,
  resolveLocalStateProfile,
  sameProfileName,
  selectSingleLocalBrowser,
  applyLunaEventReview,
  bestByStatus,
  buildEventLunaPacket,
  reclassifyVerifiedFunction,
  buildSearchTerms,
  buildExistingLinks,
  buildProposals,
  bootstrapMissingWebsite,
  WEBSITE_BOOTSTRAP_VERDICTS,
  websiteBootstrapVerdict,
  websiteSiblingRecoveryFromSourcePages,
  searchOfficialWebsite,
  stripTrackingParams,
  persistWebsiteUrl,
  candidatesFromPage,
  categoryForTouchpoint,
  categoryForUrl,
  decorateLinksForVerification,
  defaultBrowserProvider,
  discoverLocation,
  extractHtml,
  extractXmlLinks,
  fetchGooglePlaceWebsite,
  fetchDataForSeoWithRetry,
  fulfillmentLocationContext,
  eventNeedsLunaReview,
  isKnownOrderProviderHost,
  parseArgs,
  proposalUrlForLink,
  queryJson,
  reviewAmbiguousEventsWithLuna,
  resolveBrowserRuntime,
  resolveCategories,
  manualReviewReason,
  runtimeEnvironment,
  seedWebsiteUrls,
  staticFetchEvidence,
  validateLunaEventReview,
  conflictingTopCandidates,
  verifierLinkTypeForCategory,
  websiteCrawlStatusFromSourcePages
};
