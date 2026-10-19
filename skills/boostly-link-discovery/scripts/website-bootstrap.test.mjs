#!/usr/bin/env node
// Website bootstrap verdicts (box-fulfillment SKILL "Link write gate", 2026-10-19).

import assert from "node:assert/strict";
import test from "node:test";

import {
  WEBSITE_BOOTSTRAP_VERDICTS,
  bootstrapMissingWebsite,
  searchOfficialWebsite,
  stripTrackingParams,
  websiteBootstrapVerdict,
  websiteSiblingRecoveryFromSourcePages,
} from "./discover-links.mjs";

const location = {
  location_id: "loc_1",
  account_name: "Piloni's",
  location_name: "Piloni's Italian Restaurant (Terre Haute)",
  shipping_city: "Terre Haute",
  shipping_state: "IN",
  google_place_id: "ChIJ-pilonis",
  website_url: "",
};

function settingsDouble(calls) {
  return (commandArgs) => {
    calls.push(commandArgs);
    const url = commandArgs.includes("--website-url") ? commandArgs[commandArgs.indexOf("--website-url") + 1] : null;
    if (commandArgs[1] === "set") return { after: { website_url: url } };
    const lastSet = [...calls].reverse().find((call) => call[1] === "set");
    return { website_url: lastSet ? lastSet[lastSet.indexOf("--website-url") + 1] : null };
  };
}

function placesDouble(websiteUri) {
  return async () => ({ ok: true, status: 200, json: async () => ({ id: location.google_place_id, websiteUri, businessStatus: "OPERATIONAL" }) });
}

test("verdicts: tracking-only diff and a Places site are ready; a configured site is a noop", () => {
  assert.equal(stripTrackingParams("https://pilonis.com/?utm_source=google&page=2"), "https://pilonis.com/?page=2");
  assert.deepEqual(websiteBootstrapVerdict({ stored: "https://pilonis.com/?utm_source=google" }),
    { verdict: "ready", reason: "tracking_params_only", website_url: "https://pilonis.com/" });
  assert.equal(websiteBootstrapVerdict({ stored: "https://pilonis.com/?store=12" }).verdict, WEBSITE_BOOTSTRAP_VERDICTS.noop);
  assert.deepEqual(websiteBootstrapVerdict({ stored: "", places: "https://pilonis.com/" }),
    { verdict: "ready", reason: "google_places_api", website_url: "https://pilonis.com/" });
});

test("verdicts: a null website is ready only when Places and search agree, otherwise a hold", () => {
  assert.deepEqual(websiteBootstrapVerdict({ stored: "", places: null, searchWebsite: { status: "none", url: null } }),
    { verdict: "ready", reason: "no_website_places_and_search_agree", website_url: null });
  const disagree = websiteBootstrapVerdict({ stored: "", places: null, searchWebsite: { status: "found", url: "https://pilonis.com/" } });
  assert.equal(disagree.verdict, "hold");
  assert.equal(disagree.reason, "website_sources_disagree");
  assert.equal(disagree.search_website_url, "https://pilonis.com/");
  assert.equal(websiteBootstrapVerdict({ stored: "", places: null, searchWebsite: { status: "unavailable", url: null } }).reason, "no_website_unconfirmed");
  assert.equal(websiteBootstrapVerdict({ stored: "", places: null, searchWebsite: null }).verdict, "hold");
});

test("searchOfficialWebsite ignores socials, aggregators and providers and needs a name-bearing host", async () => {
  const provider = (results) => ({ search: async () => ({ status: "ok", results }) });
  const none = await searchOfficialWebsite(location, provider([
    { url: "https://www.facebook.com/pilonis" },
    { url: "https://www.yelp.com/biz/pilonis-terre-haute" },
    { url: "https://www.doordash.com/store/pilonis" },
    { url: "https://www.tribstar.com/news/pilonis-reopens" },
  ]));
  assert.equal(none.status, "none");
  const found = await searchOfficialWebsite(location, provider([{ url: "https://www.facebook.com/pilonis" }, { url: "https://pilonisrestaurant.com/menu" }]));
  assert.equal(found.status, "found");
  assert.equal(found.url, "https://pilonisrestaurant.com/menu");
  assert.equal((await searchOfficialWebsite(location, { search: async () => { throw new Error("quota"); } })).status, "unavailable");
  assert.equal((await searchOfficialWebsite(location, null)).status, "unavailable");
});

test("bootstrap: Places null plus search agreement is ready with a null website and no throw", async () => {
  const calls = [];
  const out = await bootstrapMissingWebsite(location, { googlePlacesApiKey: "k", googlePlacesFetch: placesDouble(null), runLinkSettingsCommand: settingsDouble(calls) }, { search: async () => ({ status: "ok", results: [{ url: "https://www.facebook.com/pilonis" }] }) });
  assert.equal(out.audit.verdict, "ready");
  assert.equal(out.audit.reason, "no_website_places_and_search_agree");
  assert.equal(out.audit.website_url, null);
  assert.equal(out.audit.persisted, false);
  assert.equal(out.location.website_url, "");
  assert.deepEqual(calls, [], "nothing is written for a null website");
});

test("bootstrap: Places null but search finds a site is a hold, still no throw", async () => {
  const out = await bootstrapMissingWebsite(location, { googlePlacesApiKey: "k", googlePlacesFetch: placesDouble("") , runLinkSettingsCommand: settingsDouble([]) }, { search: async () => ({ status: "ok", results: [{ url: "https://pilonisrestaurant.com/" }] }) });
  assert.equal(out.audit.verdict, "hold");
  assert.equal(out.audit.reason, "website_sources_disagree");
  assert.equal(out.audit.search_website.url, "https://pilonisrestaurant.com/");
});

test("bootstrap: a Places site is written (dry run, apply, readback) and reported ready", async () => {
  const calls = [];
  const out = await bootstrapMissingWebsite(location, { googlePlacesApiKey: "k", googlePlacesFetch: placesDouble("https://pilonis.com/"), runLinkSettingsCommand: settingsDouble(calls) });
  assert.equal(out.audit.verdict, "ready");
  assert.equal(out.audit.reason, "google_places_api");
  assert.equal(out.audit.persisted, true);
  assert.equal(out.location.website_url, "https://pilonis.com/");
  assert.deepEqual(calls.map((call) => call.slice(0, 2).join(" ") + (call.includes("--apply") ? " --apply" : "")), ["location set", "location set --apply", "location get"]);
});

test("bootstrap: a stored site that differs only by tracking params is rewritten clean; other query params stay", async () => {
  const calls = [];
  const out = await bootstrapMissingWebsite({ ...location, website_url: "https://pilonis.com/?utm_source=gbp&utm_medium=organic" }, { runLinkSettingsCommand: settingsDouble(calls) });
  assert.equal(out.audit.reason, "tracking_params_only");
  assert.equal(out.audit.stored_website_url, "https://pilonis.com/?utm_source=gbp&utm_medium=organic");
  assert.equal(out.location.website_url, "https://pilonis.com/");
  assert.equal(calls.length, 3);
  const kept = await bootstrapMissingWebsite({ ...location, website_url: "https://pilonis.com/?store=12" }, { runLinkSettingsCommand: settingsDouble([]) });
  assert.deepEqual(kept.audit, { attempted: false, reason: "website_already_configured" });
  const replay = await bootstrapMissingWebsite({ ...location, website_url: "https://pilonis.com/?utm_source=gbp" }, { replay: true });
  assert.deepEqual(replay.audit, { attempted: false, reason: "replay_mode" });
});

test("sibling recovery: a dead stored host followed by its live apex/www sibling in the crawl", () => {
  const stored = { ...location, website_url: "https://www.pilonis.com/" };
  const pages = [
    { url: "https://www.pilonis.com/", http_status: null, source_type: "website", links_extracted: 0 },
    { url: "https://pilonis.com/", http_status: 200, source_type: "website", links_extracted: 14 },
  ];
  assert.deepEqual(websiteSiblingRecoveryFromSourcePages(stored, pages), { from: "https://www.pilonis.com/", to: "https://pilonis.com/" });
  assert.deepEqual(websiteSiblingRecoveryFromSourcePages({ ...location, website_url: "https://pilonis.com/" }, [
    { url: "https://pilonis.com/", http_status: null, source_type: "website", links_extracted: 0 },
    { url: "https://www.pilonis.com/", http_status: 200, source_type: "website", links_extracted: 3 },
  ]), { from: "https://pilonis.com/", to: "https://www.pilonis.com/" });
  // the stored host answered somewhere, or the sibling never did: no recovery
  assert.equal(websiteSiblingRecoveryFromSourcePages(stored, [pages[0], { ...pages[1], http_status: null, links_extracted: 0 }]), null);
  assert.equal(websiteSiblingRecoveryFromSourcePages(stored, [...pages, { url: "https://www.pilonis.com/menu", http_status: 200, source_type: "website", links_extracted: 2 }]), null);
  assert.equal(websiteSiblingRecoveryFromSourcePages(location, pages), null);
});
