#!/usr/bin/env node
// Resume state for one Boostly fulfillment run, so a fresh agent on any machine can pick a
// location up mid-stream (Travisse 2026-10-14: status plus a small per-location bundle live
// in the Vercel Blob store behind fulfillment-reviews.vercel.app; no database).
//
//   run-progress.mjs set  --run RUN_DIR --stage <stage> --last "<step done>" --next "<step>"
//                         [--blocked-on "<what Travisse owes>" | --clear-blocked] [--by <agent>]
//                         [--no-publish] [--no-bundle]
//   run-progress.mjs get  --run RUN_DIR
//   run-progress.mjs publish --run RUN_DIR [--no-bundle]      status file + bundle, fields unchanged
//   run-progress.mjs resume --slug <slug> | --run RUN_DIR      print the resume brief (Blob first, local fallback)
//   run-progress.mjs pull --slug <slug> --run-root ROOT [--force]   download the bundle into ROOT/<slug>
//   run-progress.mjs list                                       every status/<slug>.json in the store
//
// Stages: intake, fulfill, review, closeout, closeout-finish, done.
//
// Writes RUN_DIR/review/progress.json. `set` and `publish` then PUT, with the site's
// BLOB_READ_WRITE_TOKEN (env, or the fulfillment-reviews clone's git-ignored .env.local):
//   status/<slug>.json          progress + review status + figma/site urls (60 s edge cache)
//   bundles/<slug>/manifest.json  sha256 per bundled file
//   bundles/<slug>/<relpath>    run.json (ship-to redacted), review/*.json, root *.md, decision.json,
//                               links-block.json, slack-post.json, candidates/**, variants/*.json,
//                               signage/*.svg, signage/shots/*.png, and every image run.json points at
//                               (write, variants, proofs); never review images, evidence, preflight,
//                               print-handoff, website or photo caches (2.5 MB per file, 15 MB total)
// The store is public read: ship-to and request contact data are redacted by key before upload,
// handoff text lines that look like a street address are dropped, and any file whose name or
// contents look like a cookie, token or key is refused. Never prints the token.
// The checklist publisher folds progress.json into the board; the location page also reads
// status/<slug>.json directly, so a step stamped on another machine shows within a minute.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const API = "https://blob.vercel-storage.com";
const STAGES = ["intake", "fulfill", "review", "closeout", "closeout-finish", "done"];
const SITE = process.env.BOOSTLY_REVIEWS_SITE || "https://fulfillment-reviews.vercel.app";
const REVIEWS_REPO = process.env.BOOSTLY_REVIEWS_REPO_DIR || path.join(os.homedir(), "Programming/repos/fulfillment-reviews");
const MAX_FILE = 2.5 * 1024 * 1024;
const MAX_BUNDLE = 15 * 1024 * 1024;
// never bundled: review images are on the site already, evidence and preflight are regenerable, print files carry ship-to
const SKIP_DIR = /^(review\/.*\.(png|jpg|jpeg|webp|html)$|evidence\/|preflight\/|print-handoff\/|searchapi\/|website\/|gbp-photos\/|browser-pages\/|signage\/shots\/.+\/|fix\/live-)/;
const SENSITIVE_KEY = /ship|address|street|zip|postal|phone|email|contact|requested_by|csm/i;
const SECRET_NAME = /cookie|\.env|token|secret|credential|keys\.json/i;
const SECRET_TEXT = /xox[abpr]-[0-9A-Za-z-]{10,}|figd_[0-9A-Za-z_-]{20,}|vercel_blob_rw_[0-9A-Za-z_-]{10,}|\bsk-[0-9A-Za-z_-]{20,}|\bya29\.[0-9A-Za-z_-]{20,}|AIza[0-9A-Za-z_-]{30,}|\bntn_[0-9A-Za-z]{20,}|secret_[0-9A-Za-z]{30,}|__Secure-|better-auth|session_token=/;
const STREET_LINE = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Hwy|Highway|Pkwy|Parkway|Ct|Court|Pl|Place|Ste|Suite|Unit)\b\.?/i;

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  const take = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
  if (a === "--run") opt.run = take();
  else if (a === "--run-root") opt.runRoot = take();
  else if (a === "--slug") opt.slug = take();
  else if (a === "--stage") opt.stage = take();
  else if (a === "--last") opt.last = take();
  else if (a === "--next") opt.next = take();
  else if (a === "--blocked-on") opt.blocked = take();
  else if (a === "--clear-blocked") opt.clearBlocked = true;
  else if (a === "--by") opt.by = take();
  else if (a === "--no-publish") opt.noPublish = true;
  else if (a === "--no-bundle") opt.noBundle = true;
  else if (a === "--force") opt.force = true;
  else if (a === "--json") opt.json = true;
  else die(`unknown argument: ${a}`);
}
function die(msg, code = 2) { console.error(`run-progress.mjs: ${msg}`); process.exit(code); }
function usage() {
  die('usage: run-progress.mjs set --run RUN_DIR --stage <intake|fulfill|review|closeout|closeout-finish|done> --last "..." --next "..." [--blocked-on "..."|--clear-blocked] [--by <agent>] [--no-publish] [--no-bundle]\n' +
      '       run-progress.mjs get|publish --run RUN_DIR\n       run-progress.mjs resume --slug <slug> | --run RUN_DIR\n' +
      '       run-progress.mjs pull --slug <slug> --run-root ROOT [--force]\n       run-progress.mjs list');
}

// ---------- helpers ----------
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const nowIso = () => new Date().toISOString();

function loadToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const envFile = path.join(REVIEWS_REPO, ".env.local");
  if (exists(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  return null;
}

async function publicOrigin(token) {
  if (process.env.BLOB_PUBLIC_ORIGIN) return process.env.BLOB_PUBLIC_ORIGIN.replace(/\/$/, "");
  const idx = path.join(REVIEWS_REPO, "data", "blob-index.json");
  if (exists(idx)) {
    try {
      const first = Object.values(readJson(idx)).find((e) => e?.url);
      if (first) return new URL(first.url).origin;
    } catch {}
  }
  if (token) {
    const blobs = await listBlobs(token, "status/", 1);
    if (blobs[0]?.url) return new URL(blobs[0].url).origin;
  }
  return null;
}

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain" };

async function putBlob(token, pathname, body, maxAge = 60, attempts = 5) {
  const type = TYPES[path.extname(pathname).toLowerCase()] || "application/octet-stream";
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    try {
      const res = await fetch(`${API}/${pathname}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "x-api-version": "7", "x-content-type": type, "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-cache-control-max-age": String(maxAge), "content-length": String(body.length) },
        body,
      });
      if (!res.ok) throw new Error(`blob put ${pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).url;
    } catch (e) {
      lastErr = e;
      if (!/\b(5\d\d|429|fetch failed)\b/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

async function listBlobs(token, prefix, limit = 1000) {
  const out = [];
  let cursor;
  do {
    const u = new URL(API);
    u.searchParams.set("limit", String(limit));
    if (prefix) u.searchParams.set("prefix", prefix);
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}`, "x-api-version": "7" } });
    if (!res.ok) throw new Error(`blob list: ${res.status}`);
    const json = await res.json();
    out.push(...(json.blobs || []));
    cursor = json.hasMore && out.length < limit ? json.cursor : undefined;
  } while (cursor);
  return out;
}

async function delBlobs(token, urls) {
  for (let i = 0; i < urls.length; i += 100) {
    const res = await fetch(`${API}/delete`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-api-version": "7", "content-type": "application/json" }, body: JSON.stringify({ urls: urls.slice(i, i + 100) }) });
    if (!res.ok) throw new Error(`blob delete: ${res.status}`);
  }
}

async function fetchJson(url) {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

// ---------- run dir state ----------
function runPaths(run) {
  const dir = path.resolve(run);
  if (!exists(path.join(dir, "run.json"))) die(`${dir} has no run.json`);
  return { dir, slug: path.basename(dir), progressFile: path.join(dir, "review", "progress.json"), statusFile: path.join(dir, "review", "status.json") };
}
const loadJsonOr = (f, d) => { try { return readJson(f); } catch { return d; } };

function statusPayload(rp) {
  const run = loadJsonOr(path.join(rp.dir, "run.json"), {});
  const progress = loadJsonOr(rp.progressFile, null);
  const review = loadJsonOr(rp.statusFile, null);
  const req = run.request || {};
  const vars = run.variants || {};
  const payload = {
    slug: rp.slug,
    name: req.location_name || null,
    request_id: req.request_id || null,
    generated_at: nowIso(),
    progress,
    review_status: review ? { status: review.status ?? null, waiting_on: review.waiting_on ?? null, ease: review.ease ?? null, updated_at: review.updated_at ?? null, by: review.by ?? null } : null,
    picked_letter: vars.selection?.letter ?? vars.selection ?? null,
    branding_write: run.write?.status ?? null,
    figma_url: run.figma?.section_url ?? null,
    slack_posted: Boolean(run.slack?.message_ts || run.slack?.posted_at),
    hold: exists(path.join(rp.dir, "HOLD.md")) ? holdFirstLine(path.join(rp.dir, "HOLD.md")) : null,
    site_url: `${SITE}/${rp.slug}/`,
    bundle: progress?.bundle ?? null,
  };
  if (typeof payload.picked_letter === "object" && payload.picked_letter) payload.picked_letter = payload.picked_letter.letter ?? null;
  return payload;
}
function holdFirstLine(f) {
  const lines = fs.readFileSync(f, "utf8").split("\n").map((l) => l.replace(/^[#\-*\s]+/, "").trim()).filter(Boolean);
  const l = lines.find((x) => !/^hold/i.test(x)) || lines[0] || "HOLD";
  return STREET_LINE.test(l) ? "HOLD (details in the run dir)" : l.slice(0, 160);
}

function guardPublic(obj, label) {
  const s = JSON.stringify(obj);
  if (/ship_to|street_address|postal_code/.test(s) || STREET_LINE.test(s)) die(`${label} would carry ship-to data; the store is public`);
  if (SECRET_TEXT.test(s)) die(`${label} looks like it carries a token or cookie; refusing to publish`);
}

// ---------- bundle ----------
function redactJson(v, depth = 0) {
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (SENSITIVE_KEY.test(k) && !/^(website|ordering|address_hint_only)$/.test(k)) out[k] = redactValue(val);
      else out[k] = redactJson(val, depth + 1);
    }
    return out;
  }
  return v;
}
function redactValue(val) {
  if (val == null || val === "" || val === false) return val;
  return { redacted: true, note: "read live from Boostly; not stored in the public bundle" };
}
function redactText(text) {
  let dropped = 0;
  const out = text.split("\n").map((l) => {
    if (STREET_LINE.test(l) || /\bship[- ]?to\b/i.test(l) || /\b\d{5}(-\d{4})?\b.*\b(MI|UT|CA|TX|NY|FL|OH|IL|PA|GA|NC|WA|AZ|CO|MA|TN|IN|MO|MD|WI|MN|SC|AL|LA|KY|OR|OK|CT|IA|MS|AR|KS|NV|NM|NE|ID|WV|HI|NH|ME|MT|RI|DE|SD|ND|AK|VT|WY|DC)\b/.test(l)) { dropped++; return "[line removed from the public bundle: ship-to]"; }
    return l;
  }).join("\n");
  return { text: out, dropped };
}

function collectBundle(rp) {
  const run = loadJsonOr(path.join(rp.dir, "run.json"), {});
  const files = new Map(); // relpath -> Buffer
  const notes = [];
  const addFile = (rel, buf) => { if (!files.has(rel)) files.set(rel, buf); };
  const addPath = (rel) => {
    const abs = path.join(rp.dir, rel);
    if (!exists(abs) || !fs.statSync(abs).isFile()) return;
    if (SECRET_NAME.test(rel)) { notes.push(`skipped ${rel}: name looks secret`); return; }
    if (SKIP_DIR.test(rel)) return;
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE) { notes.push(`skipped ${rel}: ${st.size} B over the ${MAX_FILE} B cap`); return; }
    const ext = path.extname(rel).toLowerCase();
    let buf = fs.readFileSync(abs);
    if (ext === ".json") {
      let j; try { j = JSON.parse(buf.toString("utf8")); } catch { notes.push(`skipped ${rel}: not valid JSON`); return; }
      buf = Buffer.from(JSON.stringify(redactJson(j), null, 1) + "\n");
    } else if (ext === ".md" || ext === ".txt") {
      const r = redactText(buf.toString("utf8"));
      if (r.dropped) notes.push(`${rel}: ${r.dropped} ship-to line(s) removed`);
      buf = Buffer.from(r.text);
    }
    if ((ext === ".json" || ext === ".md" || ext === ".txt") && SECRET_TEXT.test(buf.toString("utf8"))) { notes.push(`skipped ${rel}: contents look like a token or cookie`); return; }
    addFile(rel, buf);
  };
  const addDir = (rel, filter) => {
    const abs = path.join(rp.dir, rel);
    if (!exists(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) addDir(r, filter);
      else if (!filter || filter(e.name)) addPath(r);
    }
  };
  addPath("run.json");
  addDir("review", (n) => /\.json$/.test(n));
  for (const e of fs.readdirSync(rp.dir)) if (/\.md$/.test(e)) addPath(e);
  for (const f of ["decision.json", "links-block.json", "slack-post.json", "slack-note.txt"]) addPath(f);
  addDir("candidates");
  addDir("variants", (n) => /\.json$/.test(n));
  addDir("signage", (n) => /\.svg$/.test(n));
  addDir(path.join("signage", "shots"), (n) => /\.(png|jpg|jpeg|webp)$/i.test(n));
  // every image or vector run.json points at (chosen logos, sticker file, proofs)
  const refs = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else if (typeof v === "string" && /\.(png|svg|jpg|jpeg|webp|pdf)$/i.test(v) && !v.startsWith("http") && !path.isAbsolute(v)) refs.add(v.replace(/^\.\//, ""));
    else if (typeof v === "string" && path.isAbsolute(v) && v.startsWith(rp.dir + path.sep) && /\.(png|svg|jpg|jpeg|webp|pdf)$/i.test(v)) refs.add(path.relative(rp.dir, v));
  })(run);
  for (const r of refs) if (!r.includes("..")) addPath(r);
  let total = 0;
  for (const [rel, buf] of files) { total += buf.length; }
  if (total > MAX_BUNDLE) {
    // drop the largest non-essential images until under the cap
    const order = [...files.entries()].filter(([r]) => !/^(run\.json|review\/|candidates\/)/.test(r)).sort((a, b) => b[1].length - a[1].length);
    for (const [rel, buf] of order) { if (total <= MAX_BUNDLE) break; files.delete(rel); total -= buf.length; notes.push(`dropped ${rel}: bundle over ${MAX_BUNDLE} B`); }
  }
  return { files, total, notes };
}

async function pushBundle(rp, token, origin, by) {
  const { files, total, notes } = collectBundle(rp);
  const prev = origin ? await fetchJson(`${origin}/bundles/${rp.slug}/manifest.json`).catch(() => null) : null;
  const manifest = { slug: rp.slug, pushed_at: nowIso(), by: by || os.hostname(), bytes: total, files: {} };
  let uploaded = 0, reused = 0;
  for (const [rel, buf] of files) {
    const hash = sha256(buf);
    const old = prev?.files?.[rel];
    if (old && old.sha256 === hash && old.url) { manifest.files[rel] = old; reused++; continue; }
    const url = await putBlob(token, `bundles/${rp.slug}/${rel}`, buf, 60);
    manifest.files[rel] = { sha256: hash, bytes: buf.length, url };
    uploaded++;
  }
  // drop store copies of files that left the bundle
  const gone = Object.entries(prev?.files || {}).filter(([rel, o]) => !manifest.files[rel] && o?.url).map(([, o]) => o.url);
  if (gone.length) await delBlobs(token, gone).catch((e) => notes.push(`orphan delete failed: ${e.message}`));
  if (gone.length) notes.push(`${gone.length} file(s) removed from the store copy`);
  const mbuf = Buffer.from(JSON.stringify(manifest, null, 1) + "\n");
  const murl = await putBlob(token, `bundles/${rp.slug}/manifest.json`, mbuf, 60);
  return { manifest_url: murl, files: files.size, bytes: total, uploaded, reused, pushed_at: manifest.pushed_at, notes };
}

// ---------- commands ----------
async function cmdSet() {
  if (!opt.run) usage();
  const rp = runPaths(opt.run);
  const cur = loadJsonOr(rp.progressFile, {});
  const next = { ...cur };
  if (opt.stage !== undefined) {
    if (!STAGES.includes(opt.stage)) die(`stage must be one of ${STAGES.join("|")}`);
    next.stage = opt.stage;
  }
  if (!next.stage) die("--stage is required the first time");
  if (opt.last !== undefined) next.last_step = opt.last.trim() || null;
  if (opt.next !== undefined) next.next_step = opt.next.trim() || null;
  if (opt.blocked !== undefined) next.blocked_on = opt.blocked.trim() || null;
  if (opt.clearBlocked || next.stage === "done") next.blocked_on = null;
  if (opt.by) next.by = opt.by;
  next.host = os.hostname();
  next.updated_at = nowIso();
  guardPublic({ last_step: next.last_step, next_step: next.next_step, blocked_on: next.blocked_on }, "progress text");
  fs.mkdirSync(path.dirname(rp.progressFile), { recursive: true });
  fs.writeFileSync(rp.progressFile, JSON.stringify(next, null, 1) + "\n");
  console.log(`${rp.progressFile}: ${JSON.stringify(next)}`);
  if (!opt.noPublish) await cmdPublish(rp);
}

async function cmdPublish(rpIn) {
  const rp = rpIn || (opt.run ? runPaths(opt.run) : usage());
  const token = loadToken();
  if (!token) { console.error("run-progress.mjs: no BLOB_READ_WRITE_TOKEN (env or " + path.join(REVIEWS_REPO, ".env.local") + "); progress saved locally only"); return; }
  const origin = await publicOrigin(token);
  const progress = loadJsonOr(rp.progressFile, {});
  if (!opt.noBundle) {
    const b = await pushBundle(rp, token, origin, progress.by);
    progress.bundle = { manifest_url: b.manifest_url, files: b.files, bytes: b.bytes, pushed_at: b.pushed_at };
    fs.writeFileSync(rp.progressFile, JSON.stringify(progress, null, 1) + "\n");
    console.log(`bundle: ${b.files} files, ${b.bytes} B, ${b.uploaded} uploaded, ${b.reused} unchanged -> ${b.manifest_url}`);
    for (const n of b.notes) console.log(`  ${n}`);
  }
  const payload = statusPayload(rp);
  guardPublic(payload, "status payload");
  const url = await putBlob(token, `status/${rp.slug}.json`, Buffer.from(JSON.stringify(payload)), 60);
  console.log(`status: ${url}`);
}

function cmdGet() {
  if (!opt.run) usage();
  const rp = runPaths(opt.run);
  console.log(JSON.stringify(loadJsonOr(rp.progressFile, {}), null, 1));
}

function brief(p, localDir) {
  const pr = p.progress || {};
  const lines = [
    `${p.name || p.slug} (${p.slug})`,
    `  stage:       ${pr.stage || "(none)"}`,
    `  last step:   ${pr.last_step || "(none)"}`,
    `  next step:   ${pr.next_step || "(none)"}`,
    `  blocked on:  ${pr.blocked_on || "nothing (agent work)"}`,
    `  by:          ${pr.by || "?"} on ${pr.host || "?"} at ${pr.updated_at || "?"}`,
    `  review:      ${p.review_status ? `${p.review_status.status}${p.review_status.waiting_on ? ", waiting on " + p.review_status.waiting_on : ""}${p.review_status.ease ? ", ease " + p.review_status.ease : ""}` : "(not posted)"}`,
    `  pick:        ${p.picked_letter || "(none)"}   branding write: ${p.branding_write || "(none)"}   slack: ${p.slack_posted ? "posted" : "no"}`,
    `  hold:        ${p.hold || "none"}`,
    `  figma:       ${p.figma_url || "(none)"}`,
    `  site:        ${p.site_url}`,
    `  bundle:      ${p.bundle ? `${p.bundle.files} files, ${p.bundle.bytes} B, pushed ${p.bundle.pushed_at}` : "(none pushed)"}`,
  ];
  if (localDir) lines.push(`  local:       ${exists(path.join(localDir, "run.json")) ? localDir : "no run dir on this machine; run: run-progress.mjs pull --slug " + p.slug + " --run-root <root>"}`);
  return lines.join("\n");
}

async function cmdResume() {
  let slug = opt.slug, localDir = null;
  if (!slug && opt.run) { const rp = runPaths(opt.run); slug = rp.slug; localDir = rp.dir; }
  if (!slug) usage();
  if (opt.runRoot) localDir = path.join(path.resolve(opt.runRoot), slug);
  const origin = await publicOrigin(loadToken()).catch(() => null);
  let remote = null;
  if (origin) remote = await fetchJson(`${origin}/status/${slug}.json`).catch((e) => { console.error(`(blob read failed: ${e.message})`); return null; });
  let local = null;
  if (localDir && exists(path.join(localDir, "run.json"))) local = statusPayload(runPaths(localDir));
  const pick = (() => {
    if (remote && local) {
      const r = Date.parse(remote.progress?.updated_at || 0), l = Date.parse(local.progress?.updated_at || 0);
      return l > r ? { p: local, src: "local (newer than Blob)" } : { p: remote, src: "Blob" };
    }
    return remote ? { p: remote, src: "Blob" } : local ? { p: local, src: "local (nothing in Blob)" } : null;
  })();
  if (!pick) die(`no progress for ${slug} in Blob${origin ? "" : " (no public origin known)"} or locally`, 1);
  if (opt.json) { console.log(JSON.stringify({ source: pick.src, ...pick.p }, null, 1)); return; }
  console.log(`source: ${pick.src}`);
  console.log(brief(pick.p, localDir));
}

async function cmdPull() {
  if (!opt.slug || !opt.runRoot) usage();
  const origin = await publicOrigin(loadToken());
  if (!origin) die("no public Blob origin known (set BLOB_PUBLIC_ORIGIN, or have the fulfillment-reviews clone, or the token)");
  const manifest = await fetchJson(`${origin}/bundles/${opt.slug}/manifest.json`);
  if (!manifest) die(`no bundle for ${opt.slug} at ${origin}`, 1);
  const dest = path.join(path.resolve(opt.runRoot), opt.slug);
  let written = 0, kept = 0, same = 0;
  const missing = [];
  for (const [rel, info] of Object.entries(manifest.files)) {
    if (rel.includes("..") || path.isAbsolute(rel)) continue;
    const abs = path.join(dest, rel);
    if (exists(abs)) {
      const localHash = sha256(fs.readFileSync(abs));
      if (localHash === info.sha256) { same++; continue; }
      if (!opt.force) { kept++; console.log(`kept local ${rel} (differs from the bundle; --force to overwrite)`); continue; }
    }
    const res = await fetch(`${info.url}?t=${Date.now()}`, { cache: "no-store" });
    if (res.status === 404) { missing.push(rel); continue; }
    if (!res.ok) die(`GET ${rel}: ${res.status}`, 1);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(await res.arrayBuffer()));
    written++;
  }
  const pf = path.join(dest, "review", "progress.json");
  const prog = loadJsonOr(pf, {});
  prog.pulled = { from: `${origin}/bundles/${opt.slug}/manifest.json`, at: nowIso(), pushed_at: manifest.pushed_at, host: os.hostname() };
  fs.mkdirSync(path.dirname(pf), { recursive: true });
  fs.writeFileSync(pf, JSON.stringify(prog, null, 1) + "\n");
  console.log(`${dest}: ${written} written, ${same} already identical, ${kept} kept local (bundle pushed ${manifest.pushed_at} by ${manifest.by})`);
  if (missing.length) console.log(`${missing.length} file(s) in the manifest are gone from the store (the manifest is edge-cached for 60 s; a push just replaced it): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}. Run pull again in a minute.`);
  console.log("run.json in the bundle has ship-to and contact fields redacted; the finish step reads them live from Boostly.");
}

async function cmdList() {
  const token = loadToken();
  const origin = await publicOrigin(token);
  if (!origin) die("no public Blob origin known");
  let slugs = [];
  if (token) slugs = (await listBlobs(token, "status/")).map((b) => b.pathname.replace(/^status\//, "").replace(/\.json$/, "")).filter((s) => s !== "checklist");
  else die("list needs BLOB_READ_WRITE_TOKEN");
  const rows = [];
  for (const s of slugs) {
    const p = await fetchJson(`${origin}/status/${s}.json`).catch(() => null);
    if (p) rows.push(p);
  }
  rows.sort((a, b) => String(b.progress?.updated_at || "").localeCompare(String(a.progress?.updated_at || "")));
  if (opt.json) { console.log(JSON.stringify(rows, null, 1)); return; }
  for (const p of rows) console.log(`${(p.progress?.stage || "?").padEnd(16)} ${(p.progress?.updated_at || "").slice(0, 16).padEnd(17)} ${p.slug.padEnd(44)} next: ${p.progress?.next_step || "?"}${p.progress?.blocked_on ? "  [blocked: " + p.progress.blocked_on + "]" : ""}`);
}

const run = { set: cmdSet, get: cmdGet, publish: () => cmdPublish(), resume: cmdResume, pull: cmdPull, list: cmdList }[cmd];
if (!run) usage();
await run();
