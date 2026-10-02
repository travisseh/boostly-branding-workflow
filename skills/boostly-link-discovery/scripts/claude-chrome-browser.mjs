#!/usr/bin/env node
// Session-side helper for the claude-chrome browser provider.
//
// discover-links.mjs cannot call the claude-in-chrome MCP tools from Node. The flow is:
//   1. `results init --out <results.json> --profile Boostly.com`  (profile from tabs_context/list_connected_browsers, never guessed)
//   2. discovery with `--browser-provider claude-chrome --browser-results <results.json>` writes browser-needed.json
//   3. for each manifest url: navigate in the live tab, run the manifest's extractor_js with
//      javascript_tool (it parks compact JSON on window.__boostlyPage and returns the chunk
//      count; the tool returns at most 1000 chars per call), read each chunk with chunk_read_js
//      (`chunk --index i` prints it), write the chunks as 01.txt, 02.txt ... into one directory,
//      then `results add --file <results.json> --url <u> --final-url <landed> --page-parts <dir>`
//   4. rerun discovery with the same flags; the report is preflighted when browser_needed is empty.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_MANIFEST_FORMAT,
  BROWSER_RESULTS_FORMAT,
  CLAUDE_CHROME_PROVIDER,
  browserResultKey,
  parseArgs,
} from "./discover-links.mjs";
import { claudeChromeChecksum, claudeChromeChunkReadSource, claudeChromeExtractorSource } from "../../boostly-link-verifier/lib/verify-core.mjs";

const PAGE_KEYS = ["title", "meta", "h1", "h2", "text", "links", "labeled_links", "action_labels"];

// Chunks written by the session (01.txt, 02.txt, ...) concatenate to the page JSON. Lexical
// order is the read order, so two-digit names are required past nine chunks.
function assemblePageParts(dir, expect = {}) {
  const names = fs.readdirSync(dir).filter((name) => /^\d+\.txt$/.test(name)).sort();
  if (!names.length) throw new Error(`no NN.txt chunk files under ${dir}`);
  const raw = names.map((name) => fs.readFileSync(path.join(dir, name), "utf8").replace(/\n$/, "")).join("");
  // The extractor reported chars and sum for the page it parked; a mismatch means a chunk was
  // copied wrong or skipped, and the page must not become evidence.
  if (expect.chars != null && Number(expect.chars) !== raw.length) {
    throw new Error(`page chunks under ${dir} total ${raw.length} chars, extractor reported ${expect.chars}`);
  }
  if (expect.sum != null && Number(expect.sum) !== claudeChromeChecksum(raw)) {
    throw new Error(`page chunks under ${dir} checksum ${claudeChromeChecksum(raw)} does not match the extractor's ${expect.sum}`);
  }
  try {
    return { page: JSON.parse(raw), parts: names.length, chars: raw.length, sum: claudeChromeChecksum(raw) };
  } catch (error) {
    throw new Error(`page chunks under ${dir} do not concatenate to valid JSON (${names.length} parts, ${raw.length} chars): ${error.message}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function initResults(file, { profile, capturedBy = "claude-in-chrome" } = {}) {
  if (!profile) throw new Error("--profile is required (the connected Chrome profile name, e.g. Boostly.com)");
  if (fs.existsSync(file)) throw new Error(`${file} already exists; add results to it instead of re-initializing`);
  const results = {
    format: BROWSER_RESULTS_FORMAT,
    provider: CLAUDE_CHROME_PROVIDER,
    chrome_profile_resolved: profile,
    captured_by: capturedBy,
    created_at: new Date().toISOString(),
    results: {},
  };
  writeJson(file, results);
  return results;
}

function validatePage(page) {
  if (!page || typeof page !== "object" || Array.isArray(page)) throw new Error("page must be the JSON object returned by the extractor");
  const missing = PAGE_KEYS.filter((key) => !(key in page));
  if (missing.length) throw new Error(`page is missing extractor keys: ${missing.join(", ")}`);
  if (!Array.isArray(page.links) || !Array.isArray(page.h1)) throw new Error("page.links and page.h1 must be arrays");
}

function addResult(file, { url, finalUrl, httpStatus, page }) {
  if (!url) throw new Error("--url is required");
  validatePage(page);
  const results = readJson(file);
  if (results.format !== BROWSER_RESULTS_FORMAT) throw new Error(`${file} is not a ${BROWSER_RESULTS_FORMAT} file`);
  const key = browserResultKey(url);
  results.results[key] = {
    url,
    final_url: finalUrl || url,
    http_status: Number.isFinite(httpStatus) ? httpStatus : null,
    captured_at: new Date().toISOString(),
    page,
  };
  writeJson(file, results);
  return { key, count: Object.keys(results.results).length };
}

function pendingUrls(manifestFile, resultsFile) {
  const manifest = readJson(manifestFile);
  if (manifest.format !== BROWSER_MANIFEST_FORMAT) throw new Error(`${manifestFile} is not a ${BROWSER_MANIFEST_FORMAT} file`);
  const recorded = resultsFile && fs.existsSync(resultsFile) ? readJson(resultsFile).results || {} : {};
  return {
    chrome_profile_required: manifest.chrome_profile_required,
    pending: manifest.urls.filter((entry) => !recorded[browserResultKey(entry.url)]),
    recorded: manifest.urls.filter((entry) => recorded[browserResultKey(entry.url)]).length,
  };
}

function main(argv) {
  const [command, subcommand, ...rest] = argv;
  const args = parseArgs(subcommand && subcommand.startsWith("--") ? [subcommand, ...rest] : rest);
  if (command === "extractor") {
    process.stdout.write(`${claudeChromeExtractorSource()}\n`);
    return;
  }
  if (command === "chunk") {
    if (args.index === undefined) throw new Error("--index <n> is required");
    process.stdout.write(`${claudeChromeChunkReadSource(args.index)}\n`);
    return;
  }
  if (command === "manifest" && subcommand === "pending") {
    if (!args.manifest) throw new Error("--manifest <browser-needed.json> is required");
    console.log(JSON.stringify(pendingUrls(args.manifest, args.results), null, 2));
    return;
  }
  if (command === "results" && subcommand === "init") {
    if (!args.out) throw new Error("--out <results.json> is required");
    initResults(args.out, { profile: args.profile, capturedBy: args["captured-by"] });
    console.log(JSON.stringify({ ok: true, file: path.resolve(args.out), chrome_profile_resolved: args.profile }));
    return;
  }
  if (command === "results" && subcommand === "add") {
    if (!args.file) throw new Error("--file <results.json> is required");
    const page = args.page ? readJson(args.page)
      : args["page-json"] ? JSON.parse(args["page-json"])
      : args["page-parts"] ? assemblePageParts(args["page-parts"], { chars: args["expect-chars"], sum: args["expect-sum"] }).page
      : null;
    const added = addResult(args.file, {
      url: args.url,
      finalUrl: args["final-url"],
      httpStatus: args.status ? Number(args.status) : null,
      page,
    });
    console.log(JSON.stringify({ ok: true, ...added }));
    return;
  }
  throw new Error([
    "Usage:",
    "  claude-chrome-browser.mjs extractor            # in-page script for javascript_tool; parks JSON on window.__boostlyPage",
    "  claude-chrome-browser.mjs chunk --index <n>    # javascript_tool expression that reads chunk n",
    "  claude-chrome-browser.mjs manifest pending --manifest <browser-needed.json> [--results <results.json>]",
    "  claude-chrome-browser.mjs results init --out <results.json> --profile <Chrome profile name>",
    "  claude-chrome-browser.mjs results add --file <results.json> --url <url> [--final-url <url>] [--status <n>] (--page <page.json> | --page-json '<json>' | --page-parts <dir of 01.txt,02.txt,...> [--expect-chars <n> --expect-sum <n>])",
  ].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { addResult, assemblePageParts, initResults, pendingUrls, validatePage };
