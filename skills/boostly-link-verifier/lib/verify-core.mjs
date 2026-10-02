import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { fileURLToPath } from "node:url";

// Sibling skills resolve relative to this file so the same code runs from either skills root
// (~/.claude/skills is canonical; ~/.codex/skills is the daily mirror).
const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const V2_DB = path.join(SKILLS_ROOT, "v2-database", "bin", "v2-db");
const NODE_PLAYWRIGHT = process.env.BOOSTLY_PLAYWRIGHT_MODULE || path.join(SKILLS_ROOT, "boostly-brand-design", "harness", "node_modules", "playwright");
const require = createRequire(import.meta.url);
let chromiumModule = null;
// Playwright is only needed for the headless verification path; load it lazily so the
// verifier core can be imported (claude-chrome results, replay, tests) without it.
function chromium() {
  if (chromiumModule) return chromiumModule;
  try {
    chromiumModule = require(NODE_PLAYWRIGHT).chromium;
  } catch {
    chromiumModule = require("playwright").chromium;
  }
  return chromiumModule;
}

const checkedAt = () => new Date().toISOString();
const SOCIAL_HOSTS = ["instagram.com", "facebook.com", "tiktok.com", "youtube.com", "youtu.be", "x.com", "twitter.com"];
const BROWSER_HOSTS = [...SOCIAL_HOSTS, "google.com", "apps.apple.com", "play.google.com", "toasttab.com", "chownow.com", "order.online", "doordash.com", "ubereats.com", "spoton.com", "skytab.com", "olo.com", "square.site"];
// Hosts that routinely serve DataDome/Cloudflare-style bot challenges (403/429) to
// automated fetchers even when the underlying page is live. A block from these hosts
// is never evidence the page is dead.
const CHALLENGE_PRONE_HOSTS = ["yelp.com", "doordash.com", "ubereats.com", "grubhub.com", "seamless.com", "opentable.com", "tripadvisor.com"];
const STOP_NAME_TOKENS = new Set(["the", "and", "restaurant", "cafe", "cantina", "grill", "bar", "pizzeria", "pizza", "authentic", "cuisine", "llc", "inc", "smokehouse"]);
const SOFT_NOT_FOUND_TEXT = /(?:^|\b)(?:(?:error )?(?:404|410)(?:\b|$)|(?:page )?not found\b)/;
// Soft 404 bodies (a 200 whose copy says the page is gone). Widened 2026-09-22 after
// cbgnevada.com/order/<slug> served "Oops. This page does not exist!" for a Toast redirect.
const SOFT_NOT_FOUND_BODY_TEXT = /(?:the page (?:you requested|you are looking for|you re looking for) (?:could not be found|doesn t exist|does not exist|is no longer available)|sorry (?:we )?(?:(?:couldn t|cannot|can t) find|were not able to find) (?:that|this|the) page|we can t find (?:that|this|the) page|(?:this |that |the )?page (?:doesn t|does not|no longer) exists?|(?:this |that |the )?page (?:is )?no longer available|(?:this |the )?content is no longer available|oops (?:this|that|the) page (?:doesn t|does not) exist|404 (?:error )?page not found)/;
// Title/H1/H2 variants of the same thing ("Oops. This page does not exist!", "We can't find that page").
const SOFT_NOT_FOUND_HEADING_TEXT = /^(?:oops+ |sorry |whoops |uh oh )?(?:(?:this |that |the )?page (?:doesn t|does not|no longer) exists?|(?:this |that |the )?page (?:is )?no longer available|(?:we )?(?:can t|couldn t|cannot) find (?:that|this|the) page|(?:this |that |the )?page (?:you requested |you are looking for )?(?:could not be found|was not found|cannot be found))[ !.]*$/;
const SOFT_ERROR_HEADING_TEXT = /^(?:(?:oops|sorry) )?(?:something went wrong|an unexpected error occurred|internal server error|service unavailable)(?: please try again)?$/;
const TRACKING_QUERY_PARAM = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_.+|_ga|_gl)$/i;
const ORDERING_UNAVAILABLE_TEXT = /(?:online ordering (?:is |isn t |is not )?(?:currently |temporarily )?(?:unavailable|offline|closed|disabled)|(?:not|isn t|is not) (?:currently )?accepting (?:online )?orders|(?:online )?orders? (?:are |is )?(?:currently |temporarily )?unavailable|this location (?:is )?(?:currently )?unavailable for (?:online )?ordering)/;
const CAREERS_DISABLED_TEXT = /(?:no (?:current |open )?(?:positions|openings|jobs)(?: are )?(?:available|open)?|there are (?:currently )?no (?:open )?(?:positions|openings|jobs)|not currently hiring|0 (?:open )?(?:positions|openings|jobs)|we don t have any (?:open )?(?:positions|openings|jobs))/;
const DORMANT_SOCIAL_TEXT = /(?:no posts yet|hasn t posted yet|no videos yet|no content yet|nothing to see here yet|this account is private)/;

async function evaluateCsv(csvPath, outDir) {
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const expectedRows = rows.filter((row) => row.location_id && row.url);
  const byLocation = groupBy(expectedRows, (row) => row.location_id);
  fs.mkdirSync(path.join(outDir, "locations"), { recursive: true });

  const failures = [];
  const locationSummaries = [];
  for (const [locationId, expected] of byLocation.entries()) {
    const report = await verifyLocation(locationId);
    writeJson(path.join(outDir, "locations", `${locationId}.json`), report);
    const checks = expected.map((row) => {
      const match = findMatchingReportLink(report.links, row.url);
      const expectedStatus = row.expected_status || "verified";
      const acceptableStatuses = expectedStatus.split("|").map((status) => status.trim()).filter(Boolean);
      const ok = acceptableStatuses.includes("missing") && !match ? true : Boolean(match && acceptableStatuses.includes(match.status));
      const result = {
        location_id: locationId,
        account_name: row.account_name,
        location_name: row.location_name,
        expected_url: row.url,
        expected_link_type: row.link_type,
        expected_status: expectedStatus,
        matched_url: match?.input_url || null,
        status: match?.status || "missing",
        liveness: match?.liveness || null,
        relevance: match?.relevance || null,
        ok,
        evidence: match ? [...match.location_match_evidence, ...match.validity_evidence].slice(0, 4).join(" | ") : ""
      };
      if (!ok) failures.push(result);
      return result;
    });
    locationSummaries.push({
      location_id: locationId,
      account_name: expected[0]?.account_name || report.location.account_name,
      location_name: expected[0]?.location_name || report.location.location_name,
      expected_links: expected.length,
      verified_expected_links: checks.filter((check) => check.ok).length,
      failures: checks.filter((check) => !check.ok).length,
      report_summary: report.summary
    });
  }

  const summary = {
    checked_at: checkedAt(),
    csv_path: csvPath,
    locations_tested: byLocation.size,
    expected_links: expectedRows.length,
    verified_expected_links: expectedRows.length - failures.length,
    failures,
    location_summaries: locationSummaries
  };
  writeJson(path.join(outDir, "evaluation-summary.json"), summary);
  fs.writeFileSync(path.join(outDir, "evaluation-summary.csv"), toCsv(flattenEvaluation(summary)), "utf8");
  console.log(JSON.stringify({
    locations_tested: summary.locations_tested,
    expected_links: summary.expected_links,
    verified_expected_links: summary.verified_expected_links,
    failures: summary.failures.length,
    out_dir: outDir
  }, null, 2));
  if (failures.length) process.exitCode = 2;
}

async function verifyLocation(locationId) {
  const rows = queryLocationLinks(locationId);
  if (!rows.length) throw new Error(`No location found for ${locationId}`);
  const location = normalizeLocation(rows[0]);
  const configuredLinks = dedupeLinks(rows.filter((row) => row.url).map((row) => ({
    source_table: row.source_table,
    source_id: row.source_id,
    source_field: row.source_field,
    title: row.title,
    display_title: row.display_title,
    input_url: cleanInputUrl(row.url),
    link_type: classifyLink(row.link_type || row.source_field || row.title || row.url)
  })));

  let browser = null;
  let context = null;
  let page = null;
  const getPage = async () => {
    if (page) return page;
    browser = await chromium().launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    return page;
  };
  try {
    const evidenceByUrl = new Map();
    for (const link of configuredLinks) {
      const evidence = await collectEvidence(link.input_url, getPage);
      evidenceByUrl.set(normalizeUrlForCompare(link.input_url), evidence);
    }
    addOfficialCrossLinks(configuredLinks, evidenceByUrl);
    addSiblingProviderEvidence(configuredLinks);

    const links = configuredLinks.map((link) => {
      const evidence = evidenceByUrl.get(normalizeUrlForCompare(link.input_url));
      return decide(link, location, evidence, evidenceByUrl);
    });
    return {
      checked_at: checkedAt(),
      location,
      summary: summarize(links),
      links
    };
  } finally {
    if (browser) await browser.close();
  }
}

function queryLocationLinks(locationId) {
  const escapedId = locationId.replaceAll("'", "''");
  const sql = `
WITH loc AS (
  SELECT
    l.id AS location_id, l.name AS location_name, l.status AS location_status,
    l.account_id, a.name AS account_name, a.status AS account_status,
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
    SELECT b.*
    FROM branding b
    WHERE b.location_id = l.id
    ORDER BY b.updated_at DESC
    LIMIT 1
  ) loc_br ON true
  LEFT JOIN LATERAL (
    SELECT b.*
    FROM branding b
    WHERE b.account_id = l.account_id AND b.location_id IS NULL
    ORDER BY b.updated_at DESC
    LIMIT 1
  ) acc_br ON true
  WHERE l.id = '${escapedId}'
    AND l.is_general = false
),
field_links AS (
  SELECT location_id, account_name, account_status, location_name, location_status, account_id,
    address, shipping_address_line1, shipping_city, shipping_state, shipping_zip,
    ordering_phone_number, google_place_id, website_url,
    'location_field'::text AS source_table, NULL::text AS source_id,
    key AS source_field, key AS link_type, key AS title, NULL::text AS display_title, value AS url
  FROM loc
  CROSS JOIN LATERAL (VALUES
    ('website_url', website_url),
    ('ordering_url', ordering_url),
    ('facebook_url', facebook_url),
    ('instagram_url', instagram_url),
    ('x_url', x_url),
    ('tiktok_url', tiktok_url),
    ('youtube_url', youtube_url),
    ('apple_app_url', apple_app_url),
    ('google_app_url', google_app_url)
  ) AS v(key, value)
  WHERE value IS NOT NULL AND btrim(value) <> ''
),
event_links AS (
  SELECT loc.location_id, loc.account_name, loc.account_status, loc.location_name, loc.location_status, loc.account_id,
    loc.address, loc.shipping_address_line1, loc.shipping_city, loc.shipping_state, loc.shipping_zip,
    loc.ordering_phone_number, loc.google_place_id, loc.website_url,
    'touchpoint_events'::text AS source_table, te.id AS source_id,
    'link'::text AS source_field, COALESCE(te.title, te.display_title, 'custom') AS link_type,
    te.title, te.display_title, te.link AS url
  FROM loc
  JOIN touchpoint_events te ON te.location_id = loc.location_id
  WHERE te.deleted_at IS NULL AND te.is_active = true AND te.link IS NOT NULL AND btrim(te.link) <> ''
)
SELECT * FROM field_links
UNION ALL
SELECT * FROM event_links
ORDER BY source_table, source_field, title;`;
  const raw = execFileSync(V2_DB, ["query", "--json", "--sql", sql], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw);
}

async function verifyCandidateLinks(location, candidateLinks, options = {}) {
  const normalizedLinks = dedupeLinks(candidateLinks.filter((link) => link?.input_url || link?.url).map((link) => ({
    source_table: link.source_table || link.source_type || "candidate",
    source_id: link.source_id || null,
    source_field: link.source_field || link.category || link.link_type || "candidate",
    title: link.title || link.display_title || link.category || link.link_type || "",
    display_title: link.display_title || null,
    input_url: cleanInputUrl(link.input_url || link.url),
    link_type: link.link_type || verifierLinkTypeForCategory(link.category || link.source_field || link.title || link.input_url || link.url),
    category: link.category || null,
    source_url: link.source_url || null,
    source_evidence: link.source_evidence || []
  })));

  let browser = null;
  let context = null;
  let page = null;
  const getPage = async () => {
    if (page) return page;
    browser = await chromium().launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    return page;
  };
  try {
    const evidenceByUrl = new Map();
    for (const link of normalizedLinks) {
      const evidence = options.fetchEvidence
        ? await options.fetchEvidence(link.input_url, link)
        : await collectEvidence(link.input_url, getPage);
      evidenceByUrl.set(normalizeUrlForCompare(link.input_url), evidence);
    }
    addOfficialCrossLinks(normalizedLinks, evidenceByUrl);
    addSiblingProviderEvidence(normalizedLinks);

    return normalizedLinks.map((link) => {
      const evidence = evidenceByUrl.get(normalizeUrlForCompare(link.input_url));
      return decide(link, location, evidence, evidenceByUrl);
    });
  } finally {
    if (browser) await browser.close();
  }
}

function verifierLinkTypeForCategory(category) {
  const normalized = normalizeText(category);
  if (normalized === "website" || normalized === "website url") return "website";
  if (/(ordering|order|menu|olo)/.test(normalized)) return "ordering_menu";
  if (/facebook/.test(normalized)) return "social_facebook";
  if (/instagram/.test(normalized)) return "social_instagram";
  if (/youtube/.test(normalized)) return "social_youtube";
  if (/x twitter|twitter|x url/.test(normalized)) return "social_x_twitter";
  if (/tiktok/.test(normalized)) return "social_tiktok";
  if (/ios app|android app|apple app|google app|app download/.test(normalized)) return "app_download";
  return classifyLink(category);
}

async function collectEvidence(inputUrl, page, options = {}) {
  const url = ensureProtocol(inputUrl);
  const staticEvidence = await staticFetch(url);
  const shouldBrowser = shouldUseBrowser(url, staticEvidence);
  if (!shouldBrowser) return staticEvidence;
  const browserPage = typeof page === "function" ? await page() : page;
  if (!browserPage) throw new Error("Browser escalation was required, but no browser page provider was available.");
  const browserEvidence = await browserFetch(url, browserPage, options);
  // If the browser render errored (e.g. a slow site hit the goto timeout) but the
  // static fetch already returned a healthy page with identity evidence, keep the
  // static evidence instead of letting the empty browser result clobber it.
  if (browserEvidence.error && staticEvidence.ok && hasIdentityText(staticEvidence)) {
    return { ...staticEvidence, fetch_method: "static_fetch_browser_failed", browser_error: browserEvidence.error };
  }
  return mergeEvidence(staticEvidence, browserEvidence, options.browserLabel || "playwright");
}

async function staticFetch(url) {
  const evidence = baseEvidence(url, "static_fetch");
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
    if (contentType.includes("text/html") || contentType.includes("text/plain")) {
      const html = await res.text();
      Object.assign(evidence, extractHtml(html, res.url));
    }
  } catch (error) {
    evidence.error = error.name === "AbortError" ? "timeout" : String(error.message || error);
  }
  return evidence;
}

// The in-page extractor. It runs inside the target page (Playwright `page.evaluate`, the
// Codex extension tab, or a Claude session pasting `renderedPageExtractorSource()` into the
// claude-in-chrome javascript tool). It must stay self-contained: no closures, no imports.
function renderedPageExtractor() {
  const meta = {};
  document.querySelectorAll("meta").forEach((node) => {
    const key = node.getAttribute("property") || node.getAttribute("name");
    const value = node.getAttribute("content");
    if (key && value) meta[key] = value;
  });
  const labeledLinks = [];
  const actionLabels = [];
  const eventDates = [];
  const seenLinks = new Set();
  const pushLink = (rawHref, element, source) => {
    if (!rawHref) return;
    let href = "";
    try {
      href = new URL(rawHref, window.location.href).toString();
    } catch {
      return;
    }
    const label = [
      element?.innerText,
      element?.textContent,
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("alt"),
      element?.getAttribute?.("class"),
      element?.id
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const key = `${href}|${label}|${source}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    labeledLinks.push({ href, label, source });
  };
  document.querySelectorAll("a[href]").forEach((element) => pushLink(element.getAttribute("href"), element, "anchor"));
  document.querySelectorAll("button,[role=button],[onclick],[data-url],[data-href]").forEach((element) => {
    pushLink(element.getAttribute("href") || element.getAttribute("data-url") || element.getAttribute("data-href"), element, "buttonish");
    const onclick = element.getAttribute("onclick") || "";
    const match = onclick.match(/(?:location\.href|window\.open|open)\(['"]([^'"]+)/i);
    if (match) pushLink(match[1], element, "onclick");
  });
  document.querySelectorAll("a,button,[role=button],input[type=submit],input[type=button]").forEach((element) => {
    const label = [
      element.innerText,
      element.textContent,
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (label && /\b(order|ordering|pickup|delivery|checkout)\b/i.test(label)) actionLabels.push(label);
  });
  document.querySelectorAll("script").forEach((script) => {
    const text = script.textContent || "";
    for (const match of text.matchAll(/https?:\/\/[^"'\s<>)]+/g)) {
      pushLink(match[0], null, "script-url");
    }
  });
  document.querySelectorAll("time[datetime],[data-event-date],[data-start-date]").forEach((element) => {
    const value = element.getAttribute("datetime") || element.getAttribute("data-event-date") || element.getAttribute("data-start-date");
    if (value) eventDates.push(value);
  });
  const collectJsonLdEventDates = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collectJsonLdEventDates);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some((type) => String(type || "").toLowerCase() === "event") && value.startDate) {
      eventDates.push(String(value.startDate));
    }
    Object.values(value).forEach(collectJsonLdEventDates);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      collectJsonLdEventDates(JSON.parse(script.textContent || "null"));
    } catch {
      // Ignore malformed third-party structured data.
    }
  });
  return {
    title: document.title || "",
    meta,
    h1: [...document.querySelectorAll("h1")].map((n) => n.innerText.trim()).filter(Boolean).slice(0, 8),
    h2: [...document.querySelectorAll("h2")].map((n) => n.innerText.trim()).filter(Boolean).slice(0, 8),
    text: document.body ? document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 6000) : "",
    links: [...new Set(labeledLinks.map((link) => link.href))].slice(0, 300),
    labeled_links: labeledLinks.slice(0, 300),
    action_labels: [...new Set(actionLabels)].slice(0, 80),
    event_dates: [...new Set(eventDates)].slice(0, 40)
  };
}

// Source text of the extractor for runtimes that cannot pass a function. Wrap as
// `(<source>)()` and JSON-serialize the return value.
function renderedPageExtractorSource() {
  return renderedPageExtractor.toString();
}

// Compaction for the claude-chrome provider. The claude-in-chrome javascript tool returns at
// most 1000 characters per call and refuses any result carrying token-like data (query
// strings, verification metas), so the page evidence is reduced to what verification needs:
// allow-listed meta, query-stripped links (path and fragment kept; discovery strips tracking
// params from first-party links anyway), short labels, bounded text. Self-contained: it is
// serialized into the page alongside renderedPageExtractor.
const CLAUDE_CHROME_CHUNK_SIZE = 900;
function compactRenderedPage(page) {
  const metaAllow = /^(og:(title|site_name|url|description|type|locale)|description|keywords|twitter:(site|title|description)|geo\.(placename|region|position)|icbm|apple-itunes-app|google-play-app|author|application-name)$/i;
  const stripQuery = (raw) => {
    try {
      const url = new URL(raw);
      const had = url.search.length > 0;
      url.search = "";
      return { url: url.toString(), had };
    } catch {
      return { url: String(raw || ""), had: false };
    }
  };
  let stripped = 0;
  const meta = {};
  for (const [key, value] of Object.entries(page.meta || {})) {
    if (metaAllow.test(key)) meta[key] = String(value).slice(0, 200);
  }
  const links = [];
  const seenLinks = new Set();
  for (const raw of page.links || []) {
    const { url, had } = stripQuery(raw);
    if (had) stripped += 1;
    if (!seenLinks.has(url)) {
      seenLinks.add(url);
      links.push(url);
    }
  }
  const labeled = [];
  const seenLabeled = new Set();
  for (const entry of page.labeled_links || []) {
    if (!entry || entry.source === "script-url") continue;
    const { url } = stripQuery(entry.href);
    const label = String(entry.label || "").slice(0, 60);
    const key = url + "|" + label;
    if (seenLabeled.has(key)) continue;
    seenLabeled.add(key);
    labeled.push({ href: url, label, source: entry.source });
  }
  return {
    title: String(page.title || "").slice(0, 200),
    meta,
    h1: (page.h1 || []).slice(0, 8),
    h2: (page.h2 || []).slice(0, 8),
    text: String(page.text || "").slice(0, 1500),
    links: links.slice(0, 150),
    labeled_links: labeled.slice(0, 80),
    action_labels: (page.action_labels || []).slice(0, 20),
    event_dates: (page.event_dates || []).slice(0, 20),
    compact: true,
    query_strings_stripped: stripped
  };
}

// In-page script for the claude-chrome provider: extracts, compacts, parks the JSON on
// window.__boostlyPage, and returns only the chunk count. Read chunk i with
// claudeChromeChunkReadSource(i). Both are plain expressions for the javascript tool.
// Cheap rolling checksum shared by the in-page script and the results helper, so chunks the
// session copied by hand are verified byte-for-byte before they become evidence.
function claudeChromeChecksum(text) {
  let sum = 7;
  for (const char of String(text)) sum = (sum * 31 + char.charCodeAt(0)) % 1000000007;
  return sum;
}

function claudeChromeExtractorSource() {
  return [
    "(function () {",
    "  const page = (" + renderedPageExtractor.toString() + ")();",
    "  const compact = (" + compactRenderedPage.toString() + ")(page);",
    "  const checksum = " + claudeChromeChecksum.toString() + ";",
    "  window.__boostlyPage = JSON.stringify(compact);",
    "  return JSON.stringify({ chars: window.__boostlyPage.length, sum: checksum(window.__boostlyPage), chunk_size: " + CLAUDE_CHROME_CHUNK_SIZE + ", chunks: Math.ceil(window.__boostlyPage.length / " + CLAUDE_CHROME_CHUNK_SIZE + "), links: compact.links.length, title: compact.title });",
    "})()"
  ].join("\n");
}

function claudeChromeChunkReadSource(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) throw new Error("chunk index must be a non-negative integer");
  return "window.__boostlyPage.slice(" + (i * CLAUDE_CHROME_CHUNK_SIZE) + ", " + ((i + 1) * CLAUDE_CHROME_CHUNK_SIZE) + ")";
}

async function browserFetch(url, page, options = {}) {
  const evidence = baseEvidence(url, options.browserLabel || "playwright");
  try {
    // 30s (up from 20s): slow-but-live official restaurant sites were routinely
    // exceeding 20s; a timeout is additionally soft-classified in validityDecision.
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    evidence.http_status = response?.status() || null;
    evidence.final_url = await maybeAsync(page.url());
    evidence.ok = response ? response.status() < 400 : true;
    const data = await page.evaluate(renderedPageExtractor);
    Object.assign(evidence, data);
  } catch (error) {
    evidence.error = String(error.message || error).split("\n")[0];
  }
  return evidence;
}

async function maybeAsync(value) {
  return await value;
}

function decide(link, location, evidence, evidenceByUrl) {
  const finalUrl = evidence?.final_url || null;
  const validity = validityDecision(evidence);
  const relevance = relevanceDecision(link, location, evidence, evidenceByUrl);
  const typeMismatch = platformTypeMismatch(link, evidence?.final_url || link.input_url);
  if (typeMismatch) {
    relevance.relevance = "mismatch";
    relevance.evidence = [`link_type_mismatch=${typeMismatch}`, ...relevance.evidence];
    relevance.reason = `Configured link type does not match destination platform: ${typeMismatch}`;
  }
  const destination = destinationStateDecision(link, evidence, validity);
  const status = deriveStatus(validity.liveness, relevance.relevance, destination.state);
  const eventTiming = link.category === "events"
    ? eventTimingDecision(evidence)
    : null;
  const rejection = status === "rejected" ? destination.reason || relevance.reason || "Live URL did not expose strong evidence for this location or parent brand." :
    status === "broken" ? validity.reason :
    // For challenge outcomes the validity reason (bot block / timeout) is the real
    // story; the relevance reason would misleadingly describe the challenge page.
    status === "needs_manual_review" ? (validity.liveness === "challenge" ? validity.reason : relevance.reason || validity.reason || "Evidence was not decisive.") : null;
  return {
    input_url: link.input_url,
    final_url: finalUrl,
    link_type: link.link_type,
    category: link.category || null,
    fetch_method: evidence?.fetch_method || "static_fetch",
    liveness: validity.liveness,
    relevance: relevance.relevance,
    status,
    destination_state: destination.state,
    destination_state_reason: destination.reason,
    destination_state_evidence: destination.evidence,
    validity_evidence: validity.evidence,
    location_match_evidence: relevance.evidence,
    rejection_reason: rejection,
    url_canonicalization: urlCanonicalizationEvidence(link.input_url, finalUrl),
    source: {
      source_table: link.source_table,
      source_id: link.source_id,
      source_field: link.source_field,
      title: link.title,
      display_title: link.display_title
    },
    event_timing: eventTiming,
    page_evidence: compactPageEvidence(evidence, link.category === "events" ? 3000 : 500),
    checked_at: checkedAt()
  };
}

function validityDecision(evidence) {
  if (!evidence) return { liveness: "unknown", reason: "No fetch evidence was collected.", evidence: ["No fetch evidence was collected."] };
  const ev = [];
  if (evidence.final_url) ev.push(`final_url=${evidence.final_url}`);
  if (evidence.http_status) ev.push(`http_status=${evidence.http_status}`);
  if (evidence.title) ev.push(`title=${clip(evidence.title, 120)}`);
  // A fetch timeout means the page was slow, not dead. Classify as a soft
  // "challenge" outcome so it routes to needs_manual_review instead of broken.
  // (Discovery failure mode: slow-but-live official sites like pilonis.com were
  // hard-dropped after "page.goto: Timeout 20000ms exceeded.")
  const timeoutError = evidence.error && /(timeout|timed[ _]?out)/i.test(evidence.error);
  const hardError = evidence.error && !timeoutError && /(ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_CERT|SSL|Invalid URL|net::ERR|404|410)/i.test(evidence.error);
  if (evidence.http_status === 404 || evidence.http_status === 410 || hardError) {
    ev.push(`error=${evidence.error || evidence.http_status}`);
    return { liveness: "broken", reason: evidence.error || `HTTP ${evidence.http_status}`, evidence: ev };
  }
  if (isSoftNotFoundPage(evidence)) {
    ev.push("soft_not_found_page_detected=true");
    return { liveness: "broken", reason: "Destination rendered a not-found error page.", evidence: ev };
  }
  if (isUnavailablePlatformPage(evidence)) {
    ev.push("platform_unavailable_page_detected=true");
    return { liveness: "broken", reason: "Platform page says the account or page is unavailable.", evidence: ev };
  }
  // Bot/anti-automation block (DataDome, Cloudflare, ...): the page is being
  // defended, not dead. Checked before the generic 4xx/5xx branches so a
  // challenge response is never treated as hard-negative evidence.
  const challengeSignal = botChallengeSignal(evidence);
  if (challengeSignal) {
    ev.push("security_or_bot_challenge_detected=true", `challenge_signal=${challengeSignal}`);
    return { liveness: "challenge", reason: "Bot or security challenge blocked automated verification; the page may be live and needs a human check.", evidence: ev };
  }
  if (timeoutError) {
    ev.push("fetch_timeout_soft=true", `error=${evidence.error}`);
    return { liveness: "challenge", reason: "Fetch timed out before the page finished loading; treat as unverified, not dead.", evidence: ev };
  }
  if (evidence.http_status && evidence.http_status >= 500) {
    return { liveness: "broken", reason: `HTTP ${evidence.http_status}`, evidence: ev };
  }
  if (evidence.http_status && evidence.http_status >= 400 && evidence.http_status < 500 && !socialOrApp(evidence.final_url || evidence.input_url)) {
    return { liveness: "broken", reason: `HTTP ${evidence.http_status}`, evidence: ev };
  }
  if (hasIdentityText(evidence)) return { liveness: "live", reason: null, evidence: ev.length ? ev : ["Destination loaded with extractable page evidence."] };
  if (evidence.ok || socialOrApp(evidence.final_url || evidence.input_url)) {
    return { liveness: "unknown", reason: "Destination loaded but did not expose enough identity metadata.", evidence: ev.length ? ev : ["Destination reached but evidence was thin."] };
  }
  return { liveness: "unknown", reason: evidence.error || "No decisive liveness signal.", evidence: ev.length ? ev : ["No decisive liveness signal."] };
}

function isSoftNotFoundPage(evidence) {
  const headings = [evidence?.title, ...(evidence?.h1 || []), ...(evidence?.h2 || [])]
    .map(normalizeText)
    .filter(Boolean);
  if (headings.some((value) => SOFT_NOT_FOUND_TEXT.test(value) || SOFT_ERROR_HEADING_TEXT.test(value) || SOFT_NOT_FOUND_HEADING_TEXT.test(value))) return true;
  const body = normalizeText(evidence?.text);
  return SOFT_NOT_FOUND_BODY_TEXT.test(body);
}

function destinationStateDecision(link, evidence, validity) {
  if (validity.liveness === "challenge") {
    return {
      state: "security_or_bot_challenge",
      reason: validity.reason,
      evidence: validity.evidence.filter((line) => /challenge|timeout/i.test(line)),
    };
  }
  if (validity.liveness === "broken") {
    return {
      state: "hard_rejection",
      reason: validity.reason,
      evidence: ["hard_failure_detected=true", ...validity.evidence],
    };
  }

  const text = destinationText(evidence);
  if (isOrderingLink(link) && ORDERING_UNAVAILABLE_TEXT.test(text)) {
    return {
      state: "configured_but_disabled",
      reason: "The configured ordering destination is not currently accepting online orders.",
      evidence: ["ordering_unavailable_detected=true"],
    };
  }
  if (isCareersLink(link) && CAREERS_DISABLED_TEXT.test(text)) {
    return {
      state: "configured_but_disabled",
      reason: "The configured careers destination reports no open positions.",
      evidence: ["careers_no_openings_detected=true"],
    };
  }
  if (isSocialLink(link) && DORMANT_SOCIAL_TEXT.test(text)) {
    return {
      state: "configured_but_disabled",
      reason: "The configured social destination is present but exposes no public content.",
      evidence: ["dormant_social_profile_detected=true"],
    };
  }
  if (isOrderingLink(link)) {
    const actionSignal = orderingActionSignal(evidence);
    if (!actionSignal) {
      return {
        state: "hard_rejection",
        reason: "The destination loaded, but no ordering action or ordering-specific route was found.",
        evidence: ["ordering_action_evidence=false"],
      };
    }
    return {
      state: validity.liveness === "live" ? "functional" : "unknown",
      reason: null,
      evidence: ["ordering_action_evidence=true", `ordering_action_signal=${actionSignal}`],
    };
  }
  if (validity.liveness === "live") {
    return { state: "functional", reason: null, evidence: ["destination_content_available=true"] };
  }
  return { state: "unknown", reason: validity.reason, evidence: ["destination_state_unknown=true"] };
}

function relevanceDecision(link, location, evidence, evidenceByUrl) {
  const hay = normalizeText([
    evidence?.title,
    evidence?.meta?.description,
    evidence?.meta?.["og:title"],
    evidence?.meta?.["og:description"],
    evidence?.meta?.["og:url"],
    evidence?.h1?.join(" "),
    evidence?.h2?.join(" "),
    evidence?.text
  ].filter(Boolean).join(" "));
  const evidenceLines = [];
  const names = locationNameVariants(location).filter((name) => name.length >= 3);
  const matchedNames = names.filter((name) => matchesName(hay, name)).slice(0, 4);
  const geoTerms = [location.shipping_city, location.shipping_zip, location.ordering_phone_number, location.shipping_address_line1, location.address]
    .filter(Boolean).map(String);
  const matchedGeo = geoTerms.filter((term) => includesLoose(hay, term)).slice(0, 5);
  if (matchedNames.length) evidenceLines.push(`matched_name=${matchedNames.join(", ")}`);
  if (matchedGeo.length) evidenceLines.push(`matched_geo=${matchedGeo.join(", ")}`);

  const officialDomain = domain(location.website_url);
  const candidateDomain = domain(evidence?.final_url || link.input_url);
  const pageLinks = (evidence?.links || []).map(normalizeUrlForCompare);
  const officialDomainMentioned = officialDomain && (
    hay.includes(normalizeText(officialDomain)) ||
    pageLinks.some((href) => decodedLower(href).includes(officialDomain.toLowerCase()))
  );
  if (officialDomain && (pageLinks.some((href) => domain(href) === officialDomain) || officialDomainMentioned)) {
    evidenceLines.push(`candidate_links_to_official_domain=${officialDomain}`);
  }
  if (link.officialWebsiteLinksCandidate) evidenceLines.push("official_website_links_to_candidate=true");
  if (link.link_type === "website" && officialDomain && candidateDomain === officialDomain) {
    evidenceLines.push(`configured_official_domain=${officialDomain}`);
  }
  const appNameMatch = link.link_type === "app_download" && matchedNames.length > 0;
  if (appNameMatch) evidenceLines.push("app_store_metadata_names_business");
  const urlSlug = normalizeText(decodeURIComponent(`${evidence?.final_url || link.input_url} ${link.input_url}`));
  const urlSlugName = names.some((name) => matchesName(urlSlug, name));
  const urlSlugGeo = [location.shipping_city, location.shipping_zip, streetNumber(location.address)].filter(Boolean).some((term) => includesLoose(urlSlug, term));
  const providerOrCustomUrl = link.link_type === "ordering_menu" || link.link_type === "other";
  const urlSlugMatch = providerOrCustomUrl && (urlSlugName || plausibleDomainBrand(candidateDomain, names)) && (urlSlugGeo || candidateDomain === officialDomain || knownProviderDomain(candidateDomain));
  if (urlSlugMatch) evidenceLines.push("url_slug_or_provider_domain_matches_location=true");
  if (link.siblingProviderEvidence) evidenceLines.push(`sibling_provider_evidence=${link.siblingProviderEvidence}`);

  const strongNameAndGeo = matchedNames.length > 0 && matchedGeo.length > 0;
  const socialLink = link.link_type.startsWith("social_");
  const candidateLinksToOfficialDomain = Boolean(officialDomain && (
    pageLinks.some((href) => domain(href) === officialDomain) || officialDomainMentioned
  ));
  const crossLinked = link.officialWebsiteLinksCandidate || candidateLinksToOfficialDomain;
  const officialWebsite = link.link_type === "website" && officialDomain && candidateDomain === officialDomain && (matchedNames.length || matchedGeo.length || plausibleDomainBrand(officialDomain, names));
  const officialDomainLink = officialDomain && candidateDomain === officialDomain && ["website", "ordering_menu", "other"].includes(link.link_type) && (matchedNames.length || matchedGeo.length || plausibleDomainBrand(officialDomain, names) || isBotOrSecurityBlock(evidence));
  const socialDestinationIdentity = socialLink && Boolean(
    matchedNames.length || matchedGeo.length || candidateLinksToOfficialDomain
  );
  if (socialDestinationIdentity) evidenceLines.push("social_destination_identity_signal=true");
  const sharedBrand = matchedNames.length && socialLink && (crossLinked || likelySharedBrand(location, hay));
  const socialHandleInOfficial = socialLink && link.officialWebsiteLinksCandidate && socialDestinationIdentity;
  const socialHandleMatch = socialLink && socialHandleMatchesName(link.input_url, names);
  const socialTitlePlusHandle = socialHandleMatch && socialDestinationIdentity;
  const nonSocialCrossLinked = !socialLink && crossLinked;

  // A readable social profile with no business signal at all is a reject, not a hold (2026-09-22,
  // instagram.com/Chuys: nameless 32-follower personal account linked from cbgnevada.com). Holds are
  // reserved for login walls (nothing readable) and real business pages with ambiguous identity.
  const socialSignals = socialLink ? socialProfileSignals(link, location, evidence, { matchedNames, matchedGeo, candidateLinksToOfficialDomain }) : null;
  if (socialSignals?.reject) {
    return {
      relevance: "mismatch",
      reason: socialSignals.reason,
      evidence: [...evidenceLines, ...socialSignals.evidence]
    };
  }
  if (socialSignals) evidenceLines.push(...socialSignals.evidence);

  if (socialLink && crossLinked && !socialDestinationIdentity) {
    return {
      relevance: "uncertain",
      reason: "The official website links to this social profile, but the destination did not independently confirm the exact business or location.",
      evidence: evidenceLines
    };
  }

  if (officialWebsite || officialDomainLink || strongNameAndGeo || nonSocialCrossLinked || appNameMatch || sharedBrand || socialHandleInOfficial || socialTitlePlusHandle || urlSlugMatch || link.siblingProviderEvidence) {
    return { relevance: "match", reason: null, evidence: evidenceLines.length ? evidenceLines : ["Loaded page exposed strong location or parent-brand evidence."] };
  }
  if (!hasIdentityText(evidence)) {
    return { relevance: "uncertain", reason: "Loaded destination exposed little or no business identity evidence.", evidence: evidenceLines };
  }
  if (matchedNames.length && link.link_type.startsWith("social_")) {
    return { relevance: "uncertain", reason: "Name matched but no geo or official cross-link evidence was found.", evidence: evidenceLines };
  }
  if (link.link_type.startsWith("social_") && socialHandleMatchesName(link.input_url, names)) {
    return { relevance: "uncertain", reason: "Social handle matches the restaurant name, but the loaded page did not expose geo or official cross-link evidence.", evidence: ["social_handle_matches_name=true", ...evidenceLines] };
  }
  return { relevance: "mismatch", reason: "No strong location or parent-brand match evidence found.", evidence: evidenceLines.length ? evidenceLines : ["No name, geo, official-domain, or official cross-link match found."] };
}

// ---------------------------------------------------------------------------------------------
// Social business-signal gate. Thresholds are data; the verdict reason names the signals that were
// absent. A profile is auto-REJECTED (identity_mismatch) when the page was readable and shows none
// of: business/location name match, geo/phone match, backlink to the official domain, any external
// website link, a bio, a business category; and its follower count is under the floor (or unknown
// with an empty display name). A readable profile that names a *different* own-brand website with
// no geo match is also rejected (the Chuy's Tex-Mex chain vs. Chuy's Henderson case). Everything
// else falls through to the existing uncertain/match logic (held when ambiguous).
// ---------------------------------------------------------------------------------------------
const SOCIAL_BUSINESS_SIGNAL_THRESHOLDS = {
  min_followers: 100,
  // Any one of these present means the profile has a business signal and is never auto-rejected here.
  business_signals: ["name_match", "geo_match", "official_domain_backlink", "external_website_link", "bio", "business_category"],
  business_category_words: /\b(?:restaurant|bar(?: and grill| & grill)?|cafe|coffee shop|bakery|pizzeria|pizza place|grill|taqueria|cantina|brewery|winery|diner|bistro|eatery|food (?:and|&) (?:beverage|drink)|mexican restaurant|italian restaurant|fast food|food truck|catering|business|shop|store)\b/,
  link_hub_or_provider_domains: ["linktr.ee", "linkin.bio", "beacons.ai", "bio.site", "lnk.bio", "later.com", "toasttab.com", "toast.app", "chownow.com", "order.online", "doordash.com", "ubereats.com", "grubhub.com", "spoton.com", "spotapps.co", "skytab.com", "olo.com", "square.site", "squareup.com", "clover.com", "slicelife.com", "opentable.com", "resy.com", "yelp.com", "google.com", "goo.gl", "apple.com", "wa.me", "bit.ly", "t.co", "l.instagram.com", "lm.facebook.com", "l.facebook.com", "threads.net", "threads.com", "whatsapp.com", "messenger.com", "meta.com", "about.meta.com", "help.instagram.com", "about.instagram.com"],
};

function parseFollowerCount(text) {
  const m = /([\d][\d.,]*)\s*([kKmM])?\s*followers?\b/i.exec(text || "");
  if (!m) return null;
  let n = Number(String(m[1]).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (/k/i.test(m[2] || "")) n *= 1000;
  if (/m/i.test(m[2] || "")) n *= 1000000;
  return Math.round(n);
}

function socialDisplayName(evidence) {
  const og = String(evidence?.meta?.["og:title"] || evidence?.title || "");
  // "Name (@handle) • Instagram photos and videos", "Name (@handle) | TikTok", "Name | Facebook", "Name (@handle) / X"
  const before = og.split(/\s*\(@/)[0].split(/\s*[|•]\s*/)[0].trim();
  if (!before || /^(?:instagram|facebook|tiktok|x|twitter|youtube|log in|login)$/i.test(before)) return "";
  return before;
}

function socialBio(evidence) {
  const desc = String(evidence?.meta?.description || evidence?.meta?.["og:description"] || "");
  // Instagram: '32 Followers, 0 Following, 42 Posts - @handle on Instagram: "bio"'
  const ig = /on instagram:\s*"([^"]*)"\s*$/i.exec(desc);
  if (ig) return ig[1].trim();
  // TikTok: 'name (@handle) on TikTok | 16.2K Likes. 163 Followers. bio.Watch the latest video...'
  const tt = /followers\.\s*(.*?)(?:watch the latest video|$)/i.exec(desc);
  if (tt) return tt[1].trim();
  return desc.replace(/[\d.,]+\s*[kKmM]?\s*(?:followers?|following|posts?|likes?)[,.]?/gi, "").replace(/see instagram photos and videos from.*$/i, "").trim();
}

function socialProfileSignals(link, location, evidence, { matchedNames, matchedGeo, candidateLinksToOfficialDomain }) {
  const t = SOCIAL_BUSINESS_SIGNAL_THRESHOLDS;
  const readable = hasIdentityText(evidence);
  const allText = [evidence?.title, evidence?.meta?.description, evidence?.meta?.["og:description"], evidence?.text].filter(Boolean).join(" ");
  const followers = parseFollowerCount(allText);
  // Nothing readable (login wall, challenge, empty shell) → not this gate's call; the hold logic runs.
  if (!readable && followers === null) return null;
  const officialDomain = domain(location.website_url);
  const candidateHost = domain(evidence?.final_url || link.input_url);
  const isPlatformOrHub = (host) => !host || SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || host === candidateHost ||
    t.link_hub_or_provider_domains.some((h) => host === h || host.endsWith(`.${h}`));
  const externalLinks = (evidence?.links || []).map((href) => domain(href)).filter((host) => host && !isPlatformOrHub(host));
  const externalWebsiteLink = externalLinks.length > 0 || Boolean(candidateLinksToOfficialDomain);
  const bio = socialBio(evidence);
  const displayName = socialDisplayName(evidence);
  const category = t.business_category_words.test(normalizeText(allText));
  const present = {
    name_match: matchedNames.length > 0,
    geo_match: matchedGeo.length > 0,
    official_domain_backlink: Boolean(candidateLinksToOfficialDomain),
    external_website_link: externalWebsiteLink,
    bio: bio.length > 0,
    business_category: category,
  };
  const found = t.business_signals.filter((key) => present[key]);
  const missing = t.business_signals.filter((key) => !present[key]);
  const evidenceLines = [
    `social_business_signals=${found.length ? found.join("+") : "none"}`,
    ...(followers !== null ? [`social_followers=${followers}`] : []),
    ...(displayName ? [] : ["social_display_name_empty=true"]),
  ];
  // Reject 1: no business signal at all, and a tiny (or unknown, nameless) audience.
  if (found.length === 0 && ((followers !== null && followers < t.min_followers) || (followers === null && !displayName))) {
    const reason = `Social profile shows no business signal (${followers !== null ? `${followers} followers, under the ${t.min_followers} floor; ` : ""}${displayName ? "" : "no display name; "}no ${missing.map((k) => k.replace(/_/g, " ")).join(", ")}). Not a business page for this location.`;
    return { reject: true, reason, evidence: [...evidenceLines, "social_no_business_signal=true", "social_reject_reason=identity_mismatch"] };
  }
  // Reject 2: the profile names a different own-brand website and nothing ties it to this location.
  const otherBrandDomains = externalLinks.filter((host) => host !== officialDomain && !(officialDomain && host.endsWith(`.${officialDomain}`)) && !(officialDomain && officialDomain.endsWith(`.${host}`)));
  // A name match alone does not rescue it: a same-name page that publishes a different own-brand
  // website with no address or phone match is a different business (facebook.com/Chuys.Restaurants).
  if (officialDomain && !present.geo_match && !present.official_domain_backlink && otherBrandDomains.length) {
    const reason = `Social profile links a different business website (${[...new Set(otherBrandDomains)].slice(0, 3).join(", ")}), not ${officialDomain}, with no address or phone match for this location.`;
    return { reject: true, reason, evidence: [...evidenceLines, `social_links_other_domain=${[...new Set(otherBrandDomains)].slice(0, 3).join(",")}`, "social_reject_reason=identity_mismatch"] };
  }
  return { reject: false, reason: null, evidence: evidenceLines };
}

function addOfficialCrossLinks(configuredLinks, evidenceByUrl) {
  const websiteLinks = configuredLinks.filter((link) => link.link_type === "website");
  const officialOutbounds = [];
  for (const link of websiteLinks) {
    const ev = evidenceByUrl.get(normalizeUrlForCompare(link.input_url));
    officialOutbounds.push(...(ev?.links || []));
  }
  const normalizedOutbounds = officialOutbounds.map(normalizeUrlForCompare);
  for (const link of configuredLinks) {
    const target = normalizeUrlForCompare(link.input_url);
    const targetHost = domain(target);
    link.officialWebsiteLinksCandidate = normalizedOutbounds.some((href) => {
      if (!href) return false;
      if (href === target || href.startsWith(target)) return true;
      if (SOCIAL_HOSTS.some((host) => targetHost?.endsWith(host))) return sameSocialHandle(href, target);
      return false;
    });
  }
}

function addSiblingProviderEvidence(configuredLinks) {
  const providerSignals = new Map();
  for (const link of configuredLinks) {
    const host = domain(link.input_url);
    if (!knownProviderDomain(host)) continue;
    const names = configuredLinks.filter((candidate) => candidate !== link && domain(candidate.input_url) === host);
    const descriptiveSibling = names.find((candidate) => {
      try {
        return /[a-z]/i.test(new URL(ensureProtocol(candidate.input_url)).pathname) && candidate.input_url !== link.input_url;
      } catch {
        return false;
      }
    });
    if (descriptiveSibling) providerSignals.set(link.input_url, `same_provider_as_${descriptiveSibling.input_url}`);
  }
  for (const link of configuredLinks) {
    if (providerSignals.has(link.input_url)) link.siblingProviderEvidence = providerSignals.get(link.input_url);
  }
}


function shouldUseBrowser(url, staticEvidence) {
  const host = domain(url) || "";
  if (BROWSER_HOSTS.some((needle) => host.endsWith(needle) || host.includes(needle))) return true;
  if (!staticEvidence.ok) return true;
  if (!hasIdentityText(staticEvidence)) return true;
  if (staticEvidence.http_status && staticEvidence.http_status >= 300) return true;
  return false;
}

function mergeEvidence(staticEvidence, browserEvidence, browserLabel = "playwright") {
  return {
    ...staticEvidence,
    ...browserEvidence,
    fetch_method: `static_fetch_then_${browserLabel}`,
    static_http_status: staticEvidence.http_status,
    static_error: staticEvidence.error || null
  };
}

function baseEvidence(inputUrl, fetchMethod) {
  return {
    input_url: inputUrl,
    final_url: inputUrl,
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
    action_labels: [],
    error: null
  };
}

function extractHtml(html, finalUrl) {
  const meta = {};
  for (const match of html.matchAll(/<meta\s+([^>]+)>/gi)) {
    const attrs = match[1];
    const key = attr(attrs, "property") || attr(attrs, "name");
    const value = attr(attrs, "content");
    if (key && value) meta[key] = decodeHtml(value);
  }
  const labeledLinks = [...html.matchAll(/<a\s+([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      href: toAbsolute(attr(match[1], "href"), finalUrl),
      label: stripHtml(match[2]).replace(/\s+/g, " ").trim(),
      source: "anchor",
    }))
    .filter((link) => link.href)
    .slice(0, 250);
  const actionLabels = [
    ...labeledLinks.map((link) => link.label),
    ...[...html.matchAll(/<(?:button|input)\b([^>]*)>([\s\S]*?)<\/(?:button|input)>/gi)]
      .map((match) => `${attr(match[1], "value")} ${attr(match[1], "aria-label")} ${stripHtml(match[2])}`.replace(/\s+/g, " ").trim()),
  ].filter((label) => /\b(order|ordering|pickup|delivery|checkout)\b/i.test(label));
  return {
    title: decodeHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim()),
    meta,
    h1: [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripHtml(m[1])).slice(0, 8),
    h2: [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripHtml(m[1])).slice(0, 8),
    text: stripHtml(html).replace(/\s+/g, " ").slice(0, 6000),
    links: labeledLinks.map((link) => link.href),
    labeled_links: labeledLinks,
    action_labels: [...new Set(actionLabels)].slice(0, 80),
    event_dates: extractStructuredEventDates(html)
  };
}

function extractStructuredEventDates(html) {
  const dates = [];
  for (const match of html.matchAll(/<(?:time|[^>]+\sdata-(?:event|start)-date=["'][^"']+["'])[^>]*>/gi)) {
    const tag = match[0];
    const value = attr(tag, "datetime") || attr(tag, "data-event-date") || attr(tag, "data-start-date");
    if (value) dates.push(value);
  }
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectJsonLdEventDates(JSON.parse(match[1]), dates);
    } catch {
      // Ignore malformed third-party structured data.
    }
  }
  return [...new Set(dates)].slice(0, 40);
}

function collectJsonLdEventDates(value, dates) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdEventDates(item, dates);
    return;
  }
  if (!value || typeof value !== "object") return;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => String(type || "").toLowerCase() === "event") && value.startDate) {
    dates.push(String(value.startDate));
  }
  for (const item of Object.values(value)) collectJsonLdEventDates(item, dates);
}

function eventTimingDecision(evidence, now = new Date()) {
  const parsed = (evidence?.event_dates || [])
    .map((raw) => ({ raw: String(raw), timestamp: eventTimestamp(raw) }))
    .filter((item) => Number.isFinite(item.timestamp));
  const upcoming = parsed.filter((item) => item.timestamp >= now.getTime());
  return {
    has_upcoming_event: upcoming.length > 0,
    upcoming_event_dates: upcoming.map((item) => item.raw).slice(0, 10),
    inspected_event_dates: parsed.map((item) => item.raw).slice(0, 20),
    evidence: upcoming.length > 0
      ? ["upcoming_event_evidence=true", ...upcoming.slice(0, 4).map((item) => `upcoming_event_date=${item.raw}`)]
      : ["upcoming_event_evidence=false", "No future structured Event startDate or time[datetime] value was found."],
  };
}

function eventTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  return Date.parse(dateOnly ? `${text}T23:59:59.999Z` : text);
}

function attr(attrs, name) {
  return attrs.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] || "";
}

function normalizeLocation(row) {
  return {
    location_id: row.location_id,
    account_id: row.account_id,
    account_name: row.account_name,
    account_status: row.account_status,
    location_name: row.location_name,
    location_status: row.location_status,
    address: row.address || row.shipping_address_line1 || "",
    shipping_address_line1: row.shipping_address_line1 || "",
    shipping_city: row.shipping_city || cityFromAddress(row.address) || "",
    shipping_state: row.shipping_state || stateFromAddress(row.address) || "",
    shipping_zip: row.shipping_zip || zipFromAddress(row.address) || "",
    ordering_phone_number: row.ordering_phone_number || "",
    google_place_id: row.google_place_id || "",
    website_url: row.website_url || ""
  };
}

function dedupeLinks(links) {
  const seen = new Map();
  for (const link of links) {
    const urlKey = normalizeUrlForCompare(link.input_url);
    const categoryKey = normalizeText(link.category || link.source_field || link.link_type || link.title || "");
    if (!urlKey || isSubscribeOrReview(link)) continue;
    const key = `${urlKey}::${categoryKey}`;
    if (!seen.has(key)) seen.set(key, link);
  }
  return [...seen.values()];
}

function isSubscribeOrReview(link) {
  const label = normalizeText([link.link_type, link.title, link.display_title, link.input_url].join(" "));
  return /\b(subscribe|review|feedback)\b/.test(label) && !/(facebook|instagram|tiktok|youtube|twitter|x\.com|menu|order|career|cater|event|app)/.test(label);
}

function classifyLink(raw) {
  const rawText = String(raw || "").toLowerCase();
  const s = normalizeText(rawText);
  if (/website/.test(s)) return "website";
  if (/ordering|order|menu|olo|toast|chownow|doordash|ubereats|skytab|spoton/.test(s)) return "ordering_menu";
  if (/facebook/.test(s)) return "social_facebook";
  if (/instagram/.test(s)) return "social_instagram";
  if (/youtube|youtu\.be/.test(s)) return "social_youtube";
  if (/twitter|x url|x_url|x\.com/.test(`${s} ${rawText}`)) return "social_x_twitter";
  if (/tiktok/.test(s)) return "social_tiktok";
  if (/apple app|google app|apple_app|google_app|app store|play\.google|apps\.apple|download/.test(s)) return "app_download";
  return "other";
}

function deriveStatus(liveness, relevance, destinationState = null) {
  if (liveness === "broken") return "broken";
  // A bot challenge or timeout means the page could not be inspected at all, so
  // relevance is unknowable: never hard-negative, always surface for a human.
  if (liveness === "challenge" || destinationState === "security_or_bot_challenge") return "needs_manual_review";
  if (destinationState === "hard_rejection" || destinationState === "configured_but_disabled") return "rejected";
  if (liveness === "live" && relevance === "mismatch") return "rejected";
  if (liveness === "unknown" || relevance === "uncertain") return "needs_manual_review";
  return "verified";
}

function summarize(links) {
  const counts = { verified: 0, rejected: 0, needs_manual_review: 0, broken: 0 };
  for (const link of links) counts[link.status] += 1;
  return {
    total_links: links.length,
    counts_by_status: counts,
    human_review_urls: links.filter((link) => link.status === "needs_manual_review").map((link) => link.input_url)
  };
}

function findMatchingReportLink(links, expectedUrl) {
  const expected = normalizeUrlForCompare(expectedUrl);
  return links.find((link) => normalizeUrlForCompare(link.input_url) === expected || normalizeUrlForCompare(link.final_url) === expected)
    || links.find((link) => sameSocialHandle(link.input_url, expectedUrl))
    || null;
}

function normalizeUrlForCompare(value) {
  if (!value) return "";
  try {
    const u = new URL(ensureProtocol(value));
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (isRemovableTrackingParam(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(value).trim().replace(/\/+$/, "");
  }
}

function ensureProtocol(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function cleanInputUrl(value) {
  return String(value || "").trim();
}

function urlCanonicalizationEvidence(inputUrl, finalUrl) {
  const input = inspectUrlQuery(inputUrl);
  const final = inspectUrlQuery(finalUrl);
  return {
    has_removable_tracking_params: input.removable.length > 0 || final.removable.length > 0,
    removable_tracking_params: [...new Set([...input.removable, ...final.removable])],
    retained_input_query_params: input.retained,
    retained_final_query_params: final.retained,
    canonical_input_url: normalizeUrlForCompare(inputUrl) || null,
    canonical_final_url: normalizeUrlForCompare(finalUrl) || null,
  };
}

function inspectUrlQuery(value) {
  if (!value) return { removable: [], retained: [] };
  try {
    const url = new URL(ensureProtocol(value));
    const keys = [...new Set([...url.searchParams.keys()])];
    return {
      removable: keys.filter(isRemovableTrackingParam),
      retained: keys.filter((key) => !isRemovableTrackingParam(key)),
    };
  } catch {
    return { removable: [], retained: [] };
  }
}

function isRemovableTrackingParam(key) {
  return TRACKING_QUERY_PARAM.test(String(key || ""));
}

function domain(value) {
  if (!value) return "";
  try { return new URL(ensureProtocol(value)).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function toAbsolute(href, base) {
  try { return new URL(href, base).toString(); }
  catch { return ""; }
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

function parseCsv(text) {
  const rows = [];
  const parsed = [];
  let row = [], cell = "", quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (quote && c === '"' && n === '"') { cell += '"'; i++; continue; }
    if (c === '"') { quote = !quote; continue; }
    if (!quote && c === ",") { row.push(cell); cell = ""; continue; }
    if (!quote && (c === "\n" || c === "\r")) {
      if (c === "\r" && n === "\n") i++;
      row.push(cell); parsed.push(row); row = []; cell = ""; continue;
    }
    cell += c;
  }
  if (cell || row.length) { row.push(cell); parsed.push(row); }
  const headers = parsed.shift() || [];
  for (const values of parsed) {
    if (!values.some(Boolean)) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","))].join("\n") + "\n";
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function flattenEvaluation(summary) {
  if (summary.failures.length) return summary.failures;
  return summary.location_summaries.map((row) => ({
    location_id: row.location_id,
    account_name: row.account_name,
    location_name: row.location_name,
    expected_links: row.expected_links,
    verified_expected_links: row.verified_expected_links,
    failures: row.failures
  }));
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function locationNameVariants(location) {
  const raw = [location.location_name, location.account_name].filter(Boolean);
  const expanded = [];
  for (const name of raw) {
    expanded.push(name);
    expanded.push(name.replace(/\([^)]*\)/g, " "));
    expanded.push(name.replace(/\b(restaurant|cafe|cantina|grill|bar|pizzeria|pizza|authentic|cuisine|llc|inc)\b/gi, " "));
  }
  return [...new Set(expanded.map((name) => normalizeText(name).replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function includesLoose(hay, needle) {
  const n = normalizeText(needle);
  if (!n) return false;
  if (n.length <= 2) return false;
  if (hay.includes(n)) return true;
  const compactNeedle = n.replace(/[^a-z0-9]/g, "");
  if (compactNeedle.length >= 6 && hay.replace(/[^a-z0-9]/g, "").includes(compactNeedle)) return true;
  return hay.includes(n);
}

function matchesName(hay, needle) {
  const normalized = normalizeText(needle);
  if (!normalized || normalized.length < 3) return false;
  if (hay.includes(normalized)) return true;
  const compactHay = hay.replace(/[^a-z0-9]/g, "");
  const compactNeedle = normalized.replace(/[^a-z0-9]/g, "");
  if (compactNeedle.length >= 8 && compactHay.includes(compactNeedle)) return true;
  const tokens = normalized.split(" ").filter((token) => token.length > 2 && !STOP_NAME_TOKENS.has(token));
  if (tokens.length >= 2) return tokens.every((token) => hay.includes(token));
  return false;
}

function stripHtml(html) {
  return decodeHtml(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function decodedLower(value) {
  try {
    return decodeURIComponent(String(value || "")).toLowerCase();
  } catch {
    return String(value || "").toLowerCase();
  }
}

function clip(value, length) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s.length > length ? `${s.slice(0, length - 1)}...` : s;
}

function hasIdentityText(evidence) {
  if (!evidence) return false;
  return Boolean(clip([evidence.title, evidence.meta?.description, evidence.meta?.["og:title"], evidence.meta?.["og:description"], evidence.h1?.join(" "), evidence.text].filter(Boolean).join(" "), 400).length > 20);
}

function socialOrApp(value) {
  const host = domain(value);
  return BROWSER_HOSTS.some((needle) => host.endsWith(needle) || host.includes(needle));
}

function destinationText(evidence) {
  return normalizeText([
    evidence?.title,
    evidence?.meta?.description,
    evidence?.meta?.["og:title"],
    evidence?.meta?.["og:description"],
    evidence?.h1?.join(" "),
    evidence?.h2?.join(" "),
    evidence?.text,
  ].filter(Boolean).join(" "));
}

function linkPurposeText(link) {
  return normalizeText([
    link?.link_type,
    link?.category,
    link?.source_field,
    link?.title,
    link?.display_title,
    link?.input_url,
  ].filter(Boolean).join(" "));
}

function isOrderingLink(link) {
  return link?.link_type === "ordering_menu" || /\b(order|ordering|menu|olo)\b/.test(linkPurposeText(link));
}

function isCareersLink(link) {
  return /\b(career|careers|job|jobs|employment|hiring)\b|join our team|work with us/.test(linkPurposeText(link));
}

function isSocialLink(link) {
  return String(link?.link_type || "").startsWith("social_") || SOCIAL_HOSTS.some((host) => domain(link?.input_url).endsWith(host));
}

function orderingActionSignal(evidence) {
  const rawUrl = evidence?.final_url || evidence?.input_url;
  const host = domain(rawUrl);
  try {
    const url = new URL(ensureProtocol(rawUrl));
    const normalizedPath = normalizeText(decodedLower(url.pathname));
    const retainedQueryParams = [...url.searchParams.keys()].filter((key) => !isRemovableTrackingParam(key));
    if (knownProviderDomain(host) && (normalizedPath || retainedQueryParams.length > 0)) return "provider_destination_url";
    if (/\b(order|ordering|menu|checkout|pickup|delivery)\b/.test(normalizedPath)) return "ordering_specific_route";
  } catch {
    // The validity decision owns malformed URL handling.
  }

  const actionLabels = [
    ...(evidence?.action_labels || []),
    ...(evidence?.labeled_links || []).map((link) => link?.label),
  ].map(normalizeText).filter(Boolean);
  if (actionLabels.some((label) => /\b(order|ordering|checkout|pickup|delivery)\b/.test(label))) {
    return "ordering_action_control";
  }
  const primaryText = normalizeText([
    evidence?.title,
    evidence?.meta?.["og:title"],
    evidence?.h1?.join(" "),
    evidence?.h2?.join(" "),
  ].filter(Boolean).join(" "));
  if (/(?:start|begin|place) (?:an |your )?order|choose (?:a )?(?:location|pickup|delivery)|order online/.test(primaryText)) {
    return "ordering_action_page_copy";
  }
  return null;
}

// Detects anti-automation blocks. Returns a short signal string (for evidence
// lines) or null. A challenge is NOT liveness evidence either way: the verifier
// maps it to liveness=challenge -> status=needs_manual_review.
function botChallengeSignal(evidence) {
  const status = evidence?.http_status;
  const headings = [evidence?.title, ...(evidence?.h1 || [])].map(normalizeText);
  if (headings.some(text => /^(just a moment|attention required|security verification|verification required|verify (?:that )?you are (?:human|not a bot)|are you a human|checking your browser|access denied|request blocked|captcha)\b/.test(text))) {
    return "challenge_heading";
  }
  if (![403, 429, 503].includes(status)) return null;
  const text = normalizeText([evidence?.title, evidence?.h1?.join(" "), evidence?.h2?.join(" "), evidence?.text].filter(Boolean).join(" "));
  if (/(just a moment|attention required|security verification|verification required|cloudflare|datadome|verify you are not a bot|are you a human|press and hold|access denied|request blocked|captcha|enable javascript and cookies)/.test(text)) {
    return "challenge_text";
  }
  const host = domain(evidence?.final_url || evidence?.input_url);
  if (CHALLENGE_PRONE_HOSTS.some((needle) => host === needle || host.endsWith(`.${needle}`))) {
    return "challenge_prone_host";
  }
  // DataDome-style 403/429 interstitials often expose no real page content, or
  // just a bare-hostname title (e.g. Yelp returns 403 + title "yelp.com").
  // A genuine dead page would still render some content, so treat a contentless
  // block as suspected challenge rather than hard-negative. 503 is excluded
  // here because a contentless 503 usually is a real outage.
  if ((status === 403 || status === 429) && !hasIdentityText(evidence)) {
    return "blocked_without_page_content";
  }
  return null;
}

function isBotOrSecurityBlock(evidence) {
  return Boolean(botChallengeSignal(evidence));
}

function isUnavailablePlatformPage(evidence) {
  const host = domain(evidence?.final_url || evidence?.input_url);
  if (!socialOrApp(host || "")) return false;
  const text = normalizeText([evidence?.title, evidence?.meta?.description, evidence?.meta?.["og:title"], evidence?.h1?.join(" "), evidence?.h2?.join(" "), evidence?.text].filter(Boolean).join(" "));
  return /couldn t find this account|couldn t find this page|this account doesn t exist|this (?:page|content) isn t available(?: right now)?|sorry this (?:page|content) isn t available|owner only shared it with a small group|changed who can see it|it s been deleted|page not found|not found/.test(text);
}

function compactPageEvidence(evidence, textLimit = 500) {
  return {
    http_status: evidence?.http_status || null,
    title: clip(evidence?.title, 180),
    meta_description: clip(evidence?.meta?.description || evidence?.meta?.["og:description"], 260),
    og_title: clip(evidence?.meta?.["og:title"], 180),
    og_url: clip(evidence?.meta?.["og:url"], 220),
    h1: (evidence?.h1 || []).slice(0, 4),
    h2: (evidence?.h2 || []).slice(0, 4),
    text_sample: clip(evidence?.text, textLimit),
    links_sample: (evidence?.links || []).slice(0, 12),
    action_labels: (evidence?.action_labels || []).slice(0, 12),
    event_dates: (evidence?.event_dates || []).slice(0, 20),
    error: evidence?.error || null
  };
}

function sameSocialHandle(a, b) {
  const da = domain(a), db = domain(b);
  if (!da || !db) return false;
  const social = SOCIAL_HOSTS.find((host) => da.endsWith(host) && db.endsWith(host));
  if (!social) return false;
  return socialPath(a) && socialPath(a) === socialPath(b);
}

function socialHandleMatchesName(value, names) {
  const handle = normalizeText(socialPath(value));
  if (!handle) return false;
  return names.some((name) => {
    const tokens = normalizeText(name).split(" ").filter((token) => token.length > 2 && !STOP_NAME_TOKENS.has(token));
    return tokens.length >= 2 && tokens.every((token) => handle.includes(token));
  });
}

function platformTypeMismatch(link, value) {
  const host = domain(value || link.input_url);
  if (!host) return null;
  const type = link.link_type;
  if (type === "social_instagram" && !host.endsWith("instagram.com")) return `${type}_to_${host}`;
  if (type === "social_facebook" && !host.endsWith("facebook.com")) return `${type}_to_${host}`;
  if (type === "social_tiktok" && !host.endsWith("tiktok.com")) return `${type}_to_${host}`;
  if (type === "social_youtube" && !(host.endsWith("youtube.com") || host.endsWith("youtu.be"))) return `${type}_to_${host}`;
  if (type === "social_x_twitter" && !(host.endsWith("x.com") || host.endsWith("twitter.com"))) return `${type}_to_${host}`;
  if (type === "app_download" && !(host === "apps.apple.com" || host === "play.google.com")) return `${type}_to_${host}`;
  return null;
}

function knownProviderDomain(host) {
  return ["toasttab.com", "order.online", "doordash.com", "ordercounter.com", "zenpepper.com", "chownow.com", "skytab.com", "spoton.com", "olo.com"].some((provider) => host === provider || host.endsWith(`.${provider}`));
}

function socialPath(value) {
  try {
    const u = new URL(ensureProtocol(value));
    const parts = u.pathname.split("/").filter(Boolean).filter((part) => !["p", "pages", "reel", "videos", "watch", "channel", "c"].includes(part.toLowerCase()));
    return parts[0]?.toLowerCase().replace(/^@/, "") || "";
  } catch {
    return "";
  }
}

function plausibleDomainBrand(host, names) {
  const compactHost = host.split(".")[0].replace(/[^a-z0-9]/g, "");
  return names.some((name) => compactHost.includes(name.replace(/[^a-z0-9]/g, "").slice(0, 8)));
}

function likelySharedBrand(location, hay) {
  const city = normalizeText(location.shipping_city);
  return Boolean(location.account_name && location.location_name && normalizeText(location.location_name).includes(normalizeText(location.account_name)) && (!city || hay.includes(city) || hay.includes("locations")));
}

function cityFromAddress(address) {
  return String(address || "").split(",").at(-3)?.trim() || "";
}

function stateFromAddress(address) {
  return String(address || "").match(/,\s*([A-Z]{2})\s+\d{5}/)?.[1] || "";
}

function zipFromAddress(address) {
  return String(address || "").match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || "";
}

function streetNumber(address) {
  return String(address || "").match(/^\s*\d+/)?.[0] || "";
}

export { socialProfileSignals, parseFollowerCount, SOCIAL_BUSINESS_SIGNAL_THRESHOLDS, evaluateCsv, verifyLocation, queryLocationLinks, verifyCandidateLinks, collectEvidence, renderedPageExtractor, renderedPageExtractorSource, compactRenderedPage, claudeChromeExtractorSource, claudeChromeChunkReadSource, claudeChromeChecksum, CLAUDE_CHROME_CHUNK_SIZE, decide, classifyLink, normalizeLocation, dedupeLinks, cleanInputUrl, normalizeUrlForCompare, ensureProtocol, domain, parseCsv, toCsv, writeJson, deriveStatus, summarize, checkedAt, extractStructuredEventDates, validityDecision };
