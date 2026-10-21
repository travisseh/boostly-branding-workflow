#!/usr/bin/env node
// One publish for one run dir (2026-10-21): review canvas rebuild, site page build + push, Blob
// status + bundle. Replaces the three separate steps the agents used to run.
//
//   publish-location.mjs --run RUN_DIR [--skip-google ...canvas flags] [--allow-stale] [--no-canvas] [--no-site]
//                        [--message "<commit message>"] [--by <agent>] [--site-mode old|next|both] [--no-bundle]
//
// 1. run-progress.mjs check: exit 3 "pull first" when the Blob bundle is newer than the last sync here
//    (--allow-stale bypasses; a run with no Blob bundle is never stale).
// 2. review-canvas.mjs --run RUN_DIR <every flag this script does not own is passed through> (--no-canvas skips).
// 3. The site, exactly as box-fulfillment SKILL.md "Public review site" documents it, from the
//    fulfillment-reviews clone: git pull --ff-only; wait until no other `scripts/buil[d].mjs` runs and the
//    tree is clean; npm run build -- --run-root <parent> --limit 0 --slug <slug>; git add public data;
//    commit; push. Nothing staged = nothing committed. (--no-site skips.)
// 4. run-progress.mjs publish --run RUN_DIR: status/<slug>.json (with the soft claim) + the bundle.
// --site-mode (default BOOSTLY_SITE_MODE, else old): `old` is step 3 above. `next` skips step 3 and feeds the
//    hosted Next.js site instead: site-data.mjs build (review/site-data.json + downsized images to
//    site/assets/<slug>/), then step 4 (the bundle carries site-data.json), then site-data.mjs index (the
//    list page's site/index.json). No git commit per publish. `both` runs the two paths.
// --no-bundle skips step 4: no status/<slug>.json and no bundle push, so a backfill from a pulled copy never
//    overwrites the owner machine's bundle or editing claim. With --site-mode next the page still renders: the
//    site data also goes to site/data/<slug>.json.
// Never prints the Blob token; the site build and run-progress read it from the clone's .env.local.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_PROGRESS = path.join(HERE, "run-progress.mjs");
const REVIEW_CANVAS = path.join(HERE, "review-canvas.mjs");
const REVIEWS_REPO = process.env.BOOSTLY_REVIEWS_REPO_DIR || path.join(os.homedir(), "Programming/repos/fulfillment-reviews");
const SITE = process.env.BOOSTLY_REVIEWS_SITE || "https://fulfillment-reviews.vercel.app";
const TRAILER = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";

const argv = process.argv.slice(2);
const opt = { canvas: true, site: true, bundle: true, allowStale: false, passthrough: [], siteMode: process.env.BOOSTLY_SITE_MODE || "old" };
const SITE_DATA = path.join(HERE, "site-data.mjs");
const NEXT_SITE = process.env.BOOSTLY_SITE_NEXT_URL || null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
  if (a === "--run" || a === "--run-dir") opt.run = take();
  else if (a === "--allow-stale") opt.allowStale = true;
  else if (a === "--no-canvas") opt.canvas = false;
  else if (a === "--no-site") opt.site = false;
  else if (a === "--no-bundle") opt.bundle = false;
  else if (a === "--message") opt.message = take();
  else if (a === "--by") opt.by = take();
  else if (a === "--site-mode") opt.siteMode = take();
  else if (a === "--help" || a === "-h") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 23).join("\n")); process.exit(0); }
  else if (/^--(scale|google-budget-ms|chrome-profile|png-budget-mb|cells)$/.test(a)) opt.passthrough.push(a, take());
  else if (a.startsWith("--")) opt.passthrough.push(a);
  else die(`unknown argument: ${a}`);
}
function die(msg, code = 2) { console.error(`publish-location.mjs: ${msg}`); process.exit(code); }
if (!opt.run) die("usage: publish-location.mjs --run RUN_DIR [--skip-google] [--allow-stale] [--no-canvas] [--no-site] [--message \"...\"] [--by <agent>]");
if (!["old", "next", "both"].includes(opt.siteMode)) die(`--site-mode must be old, next or both (got ${opt.siteMode})`);
const runDir = path.resolve(opt.run);
if (!fs.existsSync(path.join(runDir, "run.json"))) die(`${runDir} has no run.json`);
const slug = path.basename(runDir);
const runRoot = path.dirname(runDir);
const step = (label) => console.log(`\n== ${label}`);
const sh = (cmd, args, { cwd, allowFail = false, capture = false } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) die(`${[cmd, ...args].join(" ")} failed (exit ${r.status})${capture ? ": " + (r.stderr || r.stdout || "").trim().slice(0, 400) : ""}`, 1);
  return r;
};

// 1. freshness
step(`check ${slug}`);
const chk = sh(process.execPath, [RUN_PROGRESS, "check", "--run", runDir, ...(opt.allowStale ? ["--allow-stale"] : [])], { allowFail: true });
if (chk.status === 3) die(`stale: run-progress.mjs pull --slug ${slug} --run-root ${runRoot} first (or pass --allow-stale)`, 3);
if (chk.status) die(`run-progress check failed (exit ${chk.status})`, 1);

// 2. canvas (the check above already ran; --allow-stale stops the canvas repeating it)
if (opt.canvas) {
  step(`review canvas ${slug}`);
  sh(process.execPath, [REVIEW_CANVAS, "--run", runDir, ...opt.passthrough, "--allow-stale"]);
} else step("review canvas skipped (--no-canvas)");

// 3. site (old static path)
const oldSite = opt.siteMode !== "next";
const nextSite = opt.siteMode !== "old";
if (opt.site && nextSite) {
  step(`site data ${slug} (next)`);
  sh(process.execPath, [SITE_DATA, "build", "--run", runDir]);
}
if (opt.site && oldSite) {
  step(`site page ${slug}`);
  if (!fs.existsSync(path.join(REVIEWS_REPO, "scripts", "build.mjs"))) die(`no fulfillment-reviews clone at ${REVIEWS_REPO} (BOOSTLY_REVIEWS_REPO_DIR)`, 1);
  const git = (...args) => sh("git", args, { cwd: REVIEWS_REPO });
  const gitq = (...args) => sh("git", args, { cwd: REVIEWS_REPO, capture: true, allowFail: true });
  git("pull", "--ff-only");
  // Wait for any other build in the shared checkout (the [d] keeps pgrep from matching a waiting shell) and a clean tree.
  const busy = () => spawnSync("pgrep", ["-f", "scripts/buil[d].mjs"], { encoding: "utf8" }).status === 0 || (gitq("status", "--short").stdout || "").trim() !== "";
  for (let waited = 0; busy(); waited += 10) {
    if (waited % 60 === 0) console.log(`waiting: another site build is running or the clone has uncommitted changes (${waited}s)`);
    spawnSync("sleep", ["10"]);
  }
  const existed = fs.existsSync(path.join(REVIEWS_REPO, "public", slug, "index.html"));
  sh("npm", ["run", "build", "--", "--run-root", runRoot, "--limit", "0", "--slug", slug], { cwd: REVIEWS_REPO });
  git("add", "public", "data");
  if (gitq("diff", "--cached", "--quiet").status === 0) console.log("site: nothing changed, no commit");
  else {
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    const name = run.request?.location_name || run.request?.identity?.location_name || slug;
    let stage = null;
    try { stage = JSON.parse(fs.readFileSync(path.join(runDir, "review", "progress.json"), "utf8")).stage; } catch {}
    const message = opt.message || (stage === "closeout" ? `Signage built: ${name} review page` : stage === "closeout-finish" || stage === "done" ? `Close out ${name} review page` : `${existed ? "Update" : "Add"} ${name} review page`);
    git("commit", "-q", "-m", `${message}\n\n${TRAILER}`);
    git("push");
    console.log(`site: committed "${message}" and pushed`);
  }
  console.log(`page: ${SITE}/${slug}/`);
} else if (!opt.site) step("site skipped (--no-site)");

// 4. status + bundle
if (opt.bundle) {
  step(`blob status + bundle ${slug}`);
  sh(process.execPath, [RUN_PROGRESS, "publish", "--run", runDir, ...(opt.by ? ["--by", opt.by] : [])]);
} else step("blob status + bundle skipped (--no-bundle)");

// 5. next site: the list page entry (after the bundle, so the page and the list agree)
if (opt.site && nextSite) {
  step(`site index ${slug} (next)`);
  sh(process.execPath, [SITE_DATA, "index", "--run", runDir]);
  if (NEXT_SITE) console.log(`page: ${NEXT_SITE}/l/${slug}`);
}
