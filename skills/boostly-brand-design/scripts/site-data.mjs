#!/usr/bin/env node
// site-data.mjs: the data side of the hosted review site (2026-10-21). The site (boostly-branding-workflow
// site/, Next.js) renders every location page live from the Blob store; this script only emits data.
//
//   site-data.mjs build --run RUN_DIR [--no-upload] [--backfill]
//                                                      collect the page facts into RUN_DIR/review/site-data.json and
//                                                      upload every image the page shows (downsized) to
//                                                      site/assets/<slug>/<sha12>-<name> (content addressed, skipped
//                                                      when already in the store). The bundle push (run-progress.mjs
//                                                      publish) then carries review/site-data.json like any review/*.json.
//                                                      The same file also goes to site/data/<slug>.json, so a location
//                                                      renders without a bundle push; the site reads both copies and
//                                                      shows the newer (generated_at).
//                                                      --backfill (2026-10-21): a one-time build for a location published
//                                                      before the site existed, from a local run dir or a pulled copy of an
//                                                      old bundle (no schema_version). Records backfilled_from, refuses
//                                                      (exit 4) a run too thin to draw a sheet, never touches the bundle.
//                                                      A website capture, GBP/Vibe photos, maps capture or review/logo-3x.png
//                                                      missing here falls back to the old static site's upload of it
//                                                      (fulfillment-reviews public/<slug>/index.html, else data/blob-index.json):
//                                                      the Blob URL is reused, recorded in assets and old_site_assets.
//   site-data.mjs index --run RUN_DIR [--backfill] [--entry-only]
//                                                      upsert this location's entry in site/index.json (+ site/entries/<slug>.json);
//                                                      --entry-only writes just the entry (batches: one rebuild-index at the end)
//   site-data.mjs rebuild-index                        rebuild site/index.json from site/entries/*.json
//   site-data.mjs seed-index --sites-json FILE         one-time seed before cutover: an entry (no page data yet,
//                                                      old_url pointing at the static page) for every location in
//                                                      the old site's data/sites.json that has no entry yet
//   site-data.mjs footprint [--slug <slug>]            Blob bytes per location under site/assets/ and bundles/
//
// What is data and what is presentation: this script resolves files (which only exist on the machine that ran
// the location), joins tags (GBP photo <-> brand-environment candidate by sha256), builds the sheet view the
// templates draw (variant-sheet.mjs sheetView: QR matrices need the qrcode package) and maps every run-relative
// image path to its Blob URL. Every review-canvas.mjs presentation rule (link rows and verdicts, photo order,
// captions, section presence, status chips) lives in the site, so a rule change never needs a republish.
//
// Public store: the file is passed through run-progress.mjs redactJson (ship-to/contact keys), street-address
// looking substrings are replaced, and anything that looks like a token or cookie refuses the publish.
// Never prints the Blob token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectLinkSources, collectPreviews, approvedWebsiteSwap } from './review-canvas.mjs';
import { redactJson } from './run-progress.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', 'harness', 'package.json'));
const sharp = require('sharp');

export const SITE_DATA_SCHEMA = 1;
export const INDEX_SCHEMA = 1;
const API = 'https://blob.vercel-storage.com';
const REVIEWS_REPO = process.env.BOOSTLY_REVIEWS_REPO_DIR || path.join(os.homedir(), 'Programming/repos/fulfillment-reviews');
const SITE_URL = process.env.BOOSTLY_SITE_NEXT_URL || null;
const STAGES = ['request', 'evidence', 'decision', 'gates', 'variants', 'links', 'overrides', 'write', 'proofs', 'figma', 'signage', 'slack', 'notion'];
const APPLIED = new Set(['applied', 'applied+inherited']);
const STREET = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Hwy|Highway|Pkwy|Parkway|Ct|Court|Pl|Place|Ste|Suite|Unit)\b\.?/gi;
const SECRET_TEXT = /xox[abpr]-[0-9A-Za-z-]{10,}|figd_[0-9A-Za-z_-]{20,}|vercel_blob_rw_[0-9A-Za-z_-]{10,}|\bsk-[0-9A-Za-z_-]{20,}|\bya29\.[0-9A-Za-z_-]{20,}|AIza[0-9A-Za-z_-]{30,}|\bntn_[0-9A-Za-z]{20,}|secret_[0-9A-Za-z]{30,}|__Secure-|better-auth|session_token=/g;

// ---------- helpers ----------
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();
function die(msg, code = 2) { console.error(`site-data.mjs: ${msg}`); process.exit(code); }

export function loadToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const f of [path.join(REVIEWS_REPO, '.env.local'), process.env.BOOSTLY_BRANDING_ENV_FILE].filter(Boolean)) {
    if (!exists(f)) continue;
    const m = fs.readFileSync(f, 'utf8').match(/^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  return null;
}
/** Public origin of the store: BLOB_PUBLIC_ORIGIN, else the store id inside the read/write token. */
export function publicOrigin(token = loadToken()) {
  if (process.env.BLOB_PUBLIC_ORIGIN) return process.env.BLOB_PUBLIC_ORIGIN.replace(/\/$/, '');
  const id = String(token ?? '').split('_')[3];
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json' };
async function putBlob(token, pathname, body, { maxAge = 60, overwrite = true } = {}) {
  const type = TYPES[path.extname(pathname).toLowerCase()] || 'application/octet-stream';
  let lastErr;
  for (let i = 0; i < 5; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    try {
      const headers = { authorization: `Bearer ${token}`, 'x-api-version': '7', 'x-content-type': type, 'x-add-random-suffix': '0', 'x-cache-control-max-age': String(maxAge), 'content-length': String(body.length) };
      if (overwrite) headers['x-allow-overwrite'] = '1';
      const res = await fetch(`${API}/${pathname}`, { method: 'PUT', headers, body, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`blob put ${pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).url;
    } catch (e) {
      lastErr = e;
      // 5xx, rate limits, resets and our own timeouts (a hung PUT once stalled a backfill for 19 minutes) are retried
      if (!/\b(5\d\d|429|fetch failed)\b|aborted|timeout|ECONNRESET|socket/i.test(`${e.message} ${e.cause?.code ?? ''}`)) throw e;
    }
  }
  throw lastErr;
}
async function listBlobs(token, prefix) {
  const out = [];
  let cursor;
  do {
    const u = new URL(API);
    u.searchParams.set('limit', '1000');
    if (prefix) u.searchParams.set('prefix', prefix);
    if (cursor) u.searchParams.set('cursor', cursor);
    let res;
    for (let k = 0; ; k += 1) {
      try { res = await fetch(u, { headers: { authorization: `Bearer ${token}`, 'x-api-version': '7' }, signal: AbortSignal.timeout(30000) }); if (res.ok || res.status < 500 || k >= 3) break; } catch (e) { if (k >= 3) throw e; }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** k));
    }
    if (!res.ok) throw new Error(`blob list: ${res.status}`);
    const json = await res.json();
    out.push(...(json.blobs || []));
    cursor = json.hasMore ? json.cursor : undefined;
  } while (cursor);
  return out;
}
async function fetchJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

// ---------- public-store scrub ----------
/** Street-address substrings out, token-looking substrings out (counted), recursively. */
export function scrubStrings(v, counts = { street: 0, secret: 0 }) {
  if (Array.isArray(v)) return v.map((x) => scrubStrings(x, counts));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubStrings(x, counts)]));
  if (typeof v === 'string') {
    let s = v;
    // URLs are kept whole: a street-looking run inside a URL path (Toast slugs) is not an address line
    if (!/^https?:\/\//.test(s)) s = s.replace(STREET, () => { counts.street += 1; return '[street address removed]'; });
    s = s.replace(SECRET_TEXT, () => { counts.secret += 1; return '[removed]'; });
    return s;
  }
  return v;
}

// ---------- images ----------
// The fulfillment-reviews build tiers (scripts/build.mjs tierFor + shrink.py), ported to sharp.
export function tierFor(rel) {
  if (/^(variants|candidates|signage|fix|review|mockups)\//.test(rel)) return { max_px: 3200, quality: 92, keep_png: true };
  if (/^evidence\//.test(rel) || /gbp|instagram|website|brand-environment|contact-sheet/i.test(rel)) return { max_px: 1200, quality: 78 };
  return { max_px: 1600, quality: 82 };
}
const MIN_BYTES = 300_000;
/** shrink.py in sharp: small in-bounds files untouched; PNG kept only with real alpha (or keep_png on a .png); else JPEG. */
export async function shrinkImage(buf, rel) {
  const ext = path.extname(rel).toLowerCase();
  const name = path.basename(rel);
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return { buf, name };
  const { max_px, quality, keep_png } = tierFor(rel);
  let meta;
  try { meta = await sharp(buf, { limitInputPixels: false }).metadata(); } catch { return { buf, name }; }
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  const tooBig = longest > max_px;
  if (buf.length < MIN_BYTES && !tooBig) return { buf, name, width: meta.width, height: meta.height };
  let img = sharp(buf, { limitInputPixels: false }).rotate();
  if (tooBig) img = img.resize({ width: max_px, height: max_px, fit: 'inside', kernel: 'lanczos3' });
  let alpha = false;
  if (meta.hasAlpha) {
    const st = await sharp(buf, { limitInputPixels: false }).stats();
    alpha = (st.channels[3]?.min ?? 255) < 255;
  }
  if (alpha || (keep_png && ext === '.png')) {
    const out = await (alpha ? img.ensureAlpha() : img.removeAlpha()).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    // an already-optimized PNG re-encodes larger: keep the source bytes when nothing was resized
    if (!tooBig && out.data.length >= buf.length) return { buf, name, width: meta.width, height: meta.height };
    return { buf: out.data, name: name.replace(/\.(jpe?g|webp)$/i, '.png'), width: out.info.width, height: out.info.height };
  }
  const out = await img.flatten({ background: '#ffffff' }).jpeg({ quality, progressive: true }).toBuffer({ resolveWithObject: true });
  if (!tooBig && out.data.length >= buf.length && /\.jpe?g$/.test(ext)) return { buf, name, width: meta.width, height: meta.height };
  return { buf: out.data, name: name.replace(/\.(png|jpe?g|webp)$/i, '.jpg'), width: out.info.width, height: out.info.height };
}

// ---------- run inputs ----------
/** A path recorded on another machine (Karissa's absolute paths in a pulled run) resolved into this run dir. */
function localPath(runDir, p) {
  if (!p || typeof p !== 'string') return null;
  const direct = path.isAbsolute(p) ? p : path.join(runDir, p);
  if (isFile(direct)) return direct;
  const slug = path.basename(runDir);
  const i = p.lastIndexOf(`/${slug}/`);
  if (i >= 0) { const alt = path.join(runDir, p.slice(i + slug.length + 2)); if (isFile(alt)) return alt; }
  return null;
}
const relOf = (runDir, p) => path.relative(runDir, p).split(path.sep).join('/');
/** A run-relative path for p, also when p is an absolute path from another machine's copy of the same run. */
function runRel(runDir, p) {
  if (!p || typeof p !== 'string') return null;
  if (!path.isAbsolute(p)) return p.split(path.sep).join('/');
  const slug = path.basename(runDir);
  const i = p.lastIndexOf(`/${slug}/`);
  if (i >= 0) return p.slice(i + slug.length + 2);
  return p.startsWith(runDir + path.sep) ? relOf(runDir, p) : null;
}

function effectiveCursor(run) {
  const st = run.state || {};
  let i = STAGES.indexOf(st.cursor);
  for (const k of Object.keys(st.stages || {})) i = Math.max(i, STAGES.indexOf(k));
  if (run.slack?.message_ts || run.slack?.posted_at) i = Math.max(i, STAGES.indexOf('slack'));
  if (run.signage?.direct?.status) i = Math.max(i, STAGES.indexOf('figma'));
  return i < 0 ? null : STAGES[i];
}
function statusFor(cursor, picked, run = {}) {
  const i = STAGES.indexOf(cursor);
  if (i < 0) return { key: 'unknown', label: 'Unknown' };
  if (i >= STAGES.indexOf('slack')) return { key: 'closed', label: 'Closed out' };
  const w = run.write || {};
  if (APPLIED.has(w.status) && w.existing_kept && w.inherited && w.branding_source_run) return { key: 'applied', label: 'Existing account branding (inherited)' };
  if (APPLIED.has(w.status)) return { key: 'applied', label: 'Branding applied' };
  if (w.branding_source_run) return { key: 'inherits', label: `Branding: inherits ${path.basename(String(w.branding_source_run))} (${picked ? 'pending apply' : 'pending pick'})` };
  return picked ? { key: 'picked', label: 'Pick recorded' } : { key: 'awaiting', label: 'Awaiting pick' };
}
function lastUpdated(run, runDir) {
  let best = null;
  for (const st of Object.values(run.state?.stages || {})) { const t = st?.written_at; if (t && (!best || t > best)) best = t; }
  return best || run.updated_at || fs.statSync(path.join(runDir, 'run.json')).mtime.toISOString();
}
function printFolder(runDir) {
  const dir = path.join(runDir, 'print-handoff');
  if (!exists(dir)) return null;
  const d = readJson(path.join(dir, 'handoff.json'), {})?.drive || {};
  let url = d.folder_link || (d.folder_id ? `https://drive.google.com/drive/folders/${d.folder_id}` : null);
  if (url && !/^https:\/\/drive\.google\.com\//.test(url)) url = null;
  return { url };
}
function boardFields(runDir) {
  const root = path.dirname(runDir);
  const slug = path.basename(runDir);
  const items = readJson(path.join(root, 'checklist', 'checklist.json'), {})?.items || [];
  const it = items.find((x) => x.run_dir === slug) || null;
  const notes = readJson(path.join(root, 'checklist', 'notes.json'), {}) || {};
  const note = notes[slug] || it?.note || null;
  return { boostly_status: it?.status ?? null, steps: it?.steps ?? null, needs_you: it?.needs_you ?? null, gaps: it?.gaps ?? null, hold: it?.hold ?? null, done: it?.done ?? null, note: typeof note === 'string' ? note : null };
}
const progressOf = (p) => (p ? { stage: p.stage ?? null, last_step: p.last_step ?? null, next_step: p.next_step ?? null, blocked_on: p.blocked_on ?? null, by: p.by ?? null, host: p.host ?? null, updated_at: p.updated_at ?? null } : null);

/** The list-page entry for one location (index.json entries[slug]). */
export function indexEntry(runDir, run) {
  const slug = path.basename(runDir);
  const req = run.request || {};
  const id = req.identity || {};
  const v = run.variants || {};
  const w = run.write || {};
  const recommended = v.fable_default_letter ?? v.review_canvas?.fable_default_letter ?? null;
  const picked = v.selection?.letter ?? v.applied_letter ?? w.inherited_branding?.letter ?? null;
  const cursor = effectiveCursor(run);
  const st = statusFor(cursor, picked, run);
  const progress = readJson(path.join(runDir, 'review', 'progress.json'), null);
  const review = readJson(path.join(runDir, 'review', 'status.json'), null);
  const folder = printFolder(runDir);
  return {
    slug,
    name: req.location_name || id.location_name || slug,
    account: req.account_name || id.account_name || null,
    city: id.city || null,
    state: id.state || null,
    requested_at: req.created_at || run.created_at || null,
    updated_at: lastUpdated(run, runDir),
    cursor,
    status: st.key,
    status_label: st.label,
    recommended_letter: recommended,
    picked_letter: picked,
    figma_url: run.figma?.section_url ?? null,
    signage_direct: run.signage?.direct?.status ?? null,
    print_url: folder?.url ?? null,
    ...boardFields(runDir),
    progress: progressOf(progress),
    editing: progress?.editing ?? null,
    review_status: review ? { status: review.status ?? null, waiting_on: review.waiting_on ?? null, ease: review.ease ?? null, updated_at: review.updated_at ?? null } : null,
    // the bundle carries review-canvas.json but not the HTML, so a pulled copy is recognised by the JSON
    has_canvas: exists(path.join(runDir, 'review', 'review-canvas.html')) || exists(path.join(runDir, 'review', 'review-canvas.json')),
  };
}

// ---------- old static site fallback (--backfill, 2026-10-21) ----------
// A pulled bundle carries no evidence/ images, gbp-photos/, review/logo-3x.png or review/*.png captures, but the
// old static site (fulfillment-reviews) already uploaded those exact images to this Blob store when it built the
// location's page on the machine that ran it. Its committed page public/<slug>/index.html holds the Blob URLs in
// the order and with the captions the old canvas drew; data/blob-index.json is the fallback when no page exists.
// The URLs are reused as they are (no download-and-reupload of the bytes).
const OLD_BLOB = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/assets\//;
const htmlText = (h) => String(h ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8599;/g, '').replace(/&amp;/g, '&').trim();
const sectionHtml = (html, id) => html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))?.[0] ?? '';
const blobName = (url) => decodeURIComponent(String(url).split('?')[0].split('/').pop()).replace(/^[0-9a-f]{12}-/, '');
const ENV_WORDS = new Set(['storefront', 'interior_fixture', 'exterior', 'signage', 'menu_signage', 'branded_collateral', 'interior']);
/** "#7 by Chris  · vibe  4032x2268  <- cited by Fable" (review-canvas.mjs gbp figure label) back into its facts. */
export function parseGbpCaption(caption) {
  const m = String(caption).match(/^#(\d+)\s*(.*)$/);
  if (!m) return null;
  const rest = m[2].replace(/\s*<-\s*cited by Fable\s*$/, '');
  const size = rest.match(/(\d+)x(\d+)\s*$/);
  const word = rest.match(/·\s*([a-z][a-z _]*?)(?:\s{2}|$)/)?.[1]?.trim().replace(/ /g, '_') ?? null;
  const tag = !word ? null : word === 'vibe' ? { subtype: 'vibe', classification: null, category: 'vibe' } : ENV_WORDS.has(word) ? { subtype: word, classification: null, category: null } : { subtype: null, classification: word, category: null };
  const owner = /^owner photo\b/.test(rest);
  const author = owner ? null : rest.match(/^by (.+?)(?:\s{2}|\s+·|$)/)?.[1]?.trim() ?? '';
  return { index: Number(m[1]), owner, author, width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null, tag };
}
/** The old site's uploaded images for one slug: { page, website, gbp, vibe, maps, logo3x } (null where it had none). */
export function oldSiteAssets(slug, repo = REVIEWS_REPO) {
  const pageFile = path.join(repo, 'public', slug, 'index.html');
  const index = readJson(path.join(repo, 'data', 'blob-index.json'), {}) ?? {};
  const prefix = `assets/${slug}/`;
  const own = Object.entries(index).filter(([k, v]) => k.startsWith(prefix) && v?.url).map(([k, v]) => ({ key: k, name: k.slice(prefix.length).replace(/^[0-9a-f]{12}-/, ''), url: v.url, bytes: v.bytes ?? null })).sort((a, b) => a.key.localeCompare(b.key));
  const bytesOf = (url) => own.find((o) => o.url === url)?.bytes ?? null;
  const out = { page: null, website: null, gbp: null, vibe: null, maps: null, logo3x: null, logos: {}, candidates: null };
  if (isFile(pageFile)) {
    // the committed page is the authority: what it drew is what the old site showed (and a gray box there means none)
    const html = fs.readFileSync(pageFile, 'utf8');
    out.page = `fulfillment-reviews public/${slug}/index.html`;
    const web = sectionHtml(html, 'website');
    const wImg = web.match(/<img src="([^"]+)"/)?.[1];
    if (wImg && OLD_BLOB.test(wImg)) out.website = { url: wImg, bytes: bytesOf(wImg), rel: htmlText(web.match(/<p class="cap">([\s\S]*?)<\/p>/)?.[1]).match(/\(([^()]+)\)\.?$/)?.[1] ?? null };
    const cand = sectionHtml(html, 'candidates');
    if (cand) {
      const figs = [...cand.matchAll(/<figure([^>]*)>[\s\S]*?<img src="([^"]+)"[\s\S]*?<figcaption[^>]*>([\s\S]*?)<\/figcaption>/g)]
        .filter((m) => OLD_BLOB.test(m[2]))
        .map((m) => {
          const lines = m[3].split(/<br\s*\/?>/).map((l) => htmlText(l)).filter(Boolean);
          const dims = lines[0]?.match(/(\d+)x(\d+)\s*$/);
          const srcUrl = m[3].match(/<a class="ext" href="([^"]+)"/)?.[1] ?? null;
          return { url: m[2], bytes: bytesOf(m[2]), width: dims ? Number(dims[1]) : null, height: dims ? Number(dims[2]) : null, source: lines[1] ?? null, source_url: srcUrl, chosen: /class="framed"/.test(m[1]) || lines.includes("FABLE'S PICK") };
        });
      if (figs.length) out.candidates = figs;
    }
    const g = sectionHtml(html, 'gbp');
    const parts = g.split('<div class="grid cols3">');
    for (let i = 1; i < parts.length; i += 1) {
      const label = htmlText([...parts[i - 1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].pop()?.[1]);
      const figs = [...parts[i].split('</div>')[0].matchAll(/<figure[^>]*>[\s\S]*?<img src="([^"]+)"[\s\S]*?<figcaption[^>]*>([\s\S]*?)<\/figcaption>/g)]
        .map((m) => ({ url: m[1], caption: htmlText(m[2]), bytes: bytesOf(m[1]) })).filter((f) => OLD_BLOB.test(f.url));
      if (!figs.length) continue;
      if (/^Place photos/.test(label)) out.gbp = figs.map((f) => ({ ...f, ...parseGbpCaption(f.caption) })).filter((f) => Number.isFinite(f.index));
      else if (/"Vibe" photos|^In-store photos/.test(label)) {
        out.vibe = { from: /^In-store photos/.test(label) ? 'manifest' : 'selected', items: figs.map((f) => {
          const size = f.caption.match(/(\d+)x(\d+)\s*$/);
          const head = f.caption.replace(/\s*\d+x\d+\s*$/, '').trim();
          const [catSub, cls] = head.split(/\s*·\s*/);
          const [category, subtype] = String(catSub ?? '').split(/\s*\/\s*/);
          return { url: f.url, bytes: f.bytes, category: category || null, subtype: subtype || null, classification: cls || null, width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null };
        }) };
      }
    }
    const maps = g.match(/<div class="shot">[\s\S]*?<img src="([^"]+)"/)?.[1];
    if (maps && OLD_BLOB.test(maps)) out.maps = { url: maps, bytes: bytesOf(maps) };
    const z = html.match(/class="zoom3x" src="([^"]+)"/)?.[1] ?? html.match(/<img[^>]+src="([^"]+-logo-3x\.png)"/)?.[1];
    if (z && OLD_BLOB.test(z)) out.logo3x = { url: z, bytes: bytesOf(z) };
    // sheet cell logos: the old sheet stamped each <img> with data-logo="<run-relative file>" next to its upload URL
    for (const m of html.matchAll(/<img src="([^"]+)" data-logo="([^"]+)"/g)) if (OLD_BLOB.test(m[1]) && !out.logos[m[2]]) out.logos[m[2]] = { url: m[1], bytes: bytesOf(m[1]) };
    return out;
  }
  // no committed page: the upload index alone (names only; the newest-sorting key wins on a repeated name)
  if (!own.length) return out;
  out.page = 'fulfillment-reviews data/blob-index.json';
  const last = (re) => own.filter((o) => re.test(o.name)).pop() ?? null;
  const w = last(/^(desktop|website-desktop)\.(png|jpe?g)$/);
  if (w) out.website = { url: w.url, bytes: w.bytes, rel: null };
  const gbp = new Map();
  for (const o of own) { const m = o.name.match(/^gbp-photo-(\d+)\./); if (m) gbp.set(Number(m[1]), o); }
  if (gbp.size) out.gbp = [...gbp.entries()].sort((a, b) => a[0] - b[0]).map(([index, o]) => ({ url: o.url, bytes: o.bytes, index, owner: false, author: '', width: null, height: null, tag: null }));
  const vibe = new Map();
  for (const o of own) { const m = o.name.match(/^(\d{2})\.(jpe?g|png|webp)$/); if (m) vibe.set(m[1], o); }
  if (vibe.size) out.vibe = { from: 'selected', items: [...vibe.entries()].sort().map(([, o]) => ({ url: o.url, bytes: o.bytes, category: null, subtype: null, classification: null, width: null, height: null })) };
  const mp = last(/^google-maps-photos\./);
  if (mp) out.maps = { url: mp.url, bytes: mp.bytes };
  const z = last(/^logo-3x\./);
  if (z) out.logo3x = { url: z.url, bytes: z.bytes };
  return out;
}
/** Asset records for reused old-site URLs: dimensions read from the served bytes (nothing is uploaded). */
export async function describeRemoteAssets(remote, data) {
  const jobs = [...remote.entries()];
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < jobs.length) {
      const [rel, r] = jobs[i++];
      let width = null; let height = null; let bytes = r.bytes ?? null;
      try {
        const res = await fetch(r.url, { signal: AbortSignal.timeout(60000) });
        if (res.ok) { const buf = Buffer.from(await res.arrayBuffer()); bytes = bytes ?? buf.length; const m = await sharp(buf).metadata(); width = m.width ?? null; height = m.height ?? null; }
      } catch { /* the URL stays; the page only loses the intrinsic size */ }
      data.assets[rel] = { url: r.url, bytes: bytes ?? 0, width, height };
    }
  }));
  data.assets = Object.fromEntries(Object.entries(data.assets).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------- build ----------
export async function buildSiteData(runDir, { backfill = false } = {}) {
  const slug = path.basename(runDir);
  const run = readJson(path.join(runDir, 'run.json'));
  if (!run) throw new Error(`${runDir}: no run.json`);
  const reviewDir = path.join(runDir, 'review');
  const notes = [];
  const files = new Map(); // rel -> abs
  const asset = (p) => {
    const a = localPath(runDir, p);
    if (!a) return null;
    let rel;
    if (a.startsWith(runDir + path.sep)) rel = relOf(runDir, a);
    else {
      // a sibling run's file (a location that borrows another location's fix/ asset) publishes under external/<sibling>/
      const root = path.dirname(runDir);
      if (!a.startsWith(root + path.sep) || /\.\./.test(path.relative(root, a))) { notes.push(`outside the run dir, not published: ${p}`); return null; }
      rel = 'external/' + path.relative(root, a).split(path.sep).join('/');
    }
    files.set(rel, a);
    return rel;
  };
  const req = run.request ?? {};
  const identity = req.identity ?? {};
  // an owner photo's attribution is the business itself (the page labels it "owner photo")
  const name0 = () => identity.account_name ?? req.account_name ?? req.location_name ?? '';
  const evidence = readJson(localPath(runDir, run.evidence?.packet_path) ?? path.join(runDir, 'evidence', 'branding-evidence.json'), {}) ?? {};
  const decision = run.decision ?? readJson(path.join(runDir, 'decision.json'), {}) ?? {};
  const usage = readJson(path.join(reviewDir, 'review-canvas.json'), null)?.sections ?? null;
  const swap = approvedWebsiteSwap(run.links?.website_bootstrap);
  const website = swap?.url ?? req.website_url ?? evidence.location?.website_url ?? null;
  // Travisse 2026-10-22: a request with no website still gets a link when discovery or the evidence packet found one.
  const wb = run.links?.website_bootstrap ?? {};
  const discoveredUrl = website ? null : [wb.approved_website_url, wb.stored_website_url_after, wb.url, wb.places_website_uri, wb.places_website_url, run.evidence?.location?.website_url, evidence.website?.url, evidence.website?.source_url, ...(run.links?.execution ?? []).filter((e) => /website/i.test(String(e?.operation?.category ?? e?.operation?.kind ?? e?.category ?? e?.kind ?? ""))).map((e) => e?.operation?.url)].find((u) => u && /^https?:\/\//.test(String(u))) ?? null;
  const websiteDiscovered = discoveredUrl ? { url: String(discoveredUrl), source: wb.url && String(wb.url) === String(discoveredUrl) ? `link discovery (website bootstrap ${wb.applied ? 'written' : wb.action ?? 'pending'})` : run.evidence?.location?.website_url && String(run.evidence.location.website_url) === String(discoveredUrl) ? 'the run evidence' : 'the link plan' } : null;
  const placeId = req.google_place_id ?? evidence.location?.google_place_id ?? null;
  const slackUrl = run.slack?.permalink ?? (req.slack_channel && req.slack_thread_ts ? `https://slack.com/archives/${req.slack_channel}/p${String(req.slack_thread_ts).replace('.', '')}` : null);

  // website: the canvas's cached-evidence order, else unavailable, else the review/ capture
  const websiteFile = [evidence.website?.visual_evidence?.desktop, path.join(runDir, 'evidence', 'website-visual', 'desktop.png'), path.join(reviewDir, 'website-desktop.png')].map((p) => localPath(runDir, p)).find(Boolean) ?? null;
  const websiteUnavailable = evidence.website?.visual_evidence?.status === 'unavailable' ? evidence.website.visual_evidence.reason ?? 'website visual evidence unavailable' : null;

  // GBP Place photos, tagged by sha256 against the brand-environment candidates
  const be = evidence.brand_environment ?? {};
  const beManifest = be.manifest ? readJson(localPath(runDir, be.manifest) ?? be.manifest, null) : null;
  const tagBySha = new Map();
  for (const c of [...(be.selected_candidates ?? []), ...(beManifest?.candidates ?? [])]) {
    if (c?.sha256 && !tagBySha.has(c.sha256)) tagBySha.set(c.sha256, { subtype: c.subtype ?? null, classification: c.classification ?? null, category: c.category ?? null });
  }
  const gbpManifest = readJson(path.join(runDir, 'gbp-photos', 'gbp-photos.json'), null);
  const gbpPhotos = (gbpManifest?.photos ?? []).map((p) => {
    const file = asset(p.file) ?? asset(path.join('gbp-photos', path.basename(p.file ?? '')));
    if (!file) return null;
    return { index: p.index, file, author: p.author_attributions?.[0]?.displayName ?? '', width: p.width_px ?? null, height: p.height_px ?? null, tag: tagBySha.get(p.sha256) ?? null };
  }).filter(Boolean);
  let vibeFrom = 'selected';
  let vibe = (be.selected_candidates ?? []).filter((c) => localPath(runDir, c.local_path));
  if (!vibe.length) { vibeFrom = 'manifest'; vibe = (beManifest?.candidates ?? []).filter((c) => localPath(runDir, c.local_path)).slice(0, 12); }
  if (!vibe.length) vibeFrom = null;
  const vibeItems = vibe.slice(0, 12).map((c) => ({ file: asset(c.local_path), category: c.category ?? null, subtype: c.subtype ?? null, classification: c.classification ?? null, width: c.width ?? null, height: c.height ?? null })).filter((x) => x.file);
  let mapsFile = isFile(path.join(reviewDir, 'google-maps-photos.png')) ? asset(path.join(reviewDir, 'google-maps-photos.png')) : null;
  let logo3xFile = isFile(path.join(reviewDir, 'logo-3x.png')) ? asset(path.join(reviewDir, 'logo-3x.png')) : null;

  // --backfill: a file missing here (a pulled bundle) falls back to the old static site's upload of the same image
  const remote = new Map(); // rel -> { url, bytes }
  const oldFilled = [];
  const oldCandidates = []; // --backfill logo candidates from the old page, merged after the packet's own
  let websiteRel = websiteFile ? asset(websiteFile) : null;
  const old = backfill ? oldSiteAssets(slug) : null;
  if (old?.page) {
    const take = (rel, o) => { remote.set(rel, { url: o.url, bytes: o.bytes ?? null }); return rel; };
    const oldRel = (url) => `old-site/${blobName(url)}`;
    if (!websiteRel && old.website) { websiteRel = take(old.website.rel ?? oldRel(old.website.url), old.website); oldFilled.push('website'); }
    if (!gbpPhotos.length && old.gbp?.length) {
      for (const p of old.gbp) gbpPhotos.push({ index: p.index, file: take(`gbp-photos/${blobName(p.url)}`, p), author: p.owner ? name0() : p.author ?? '', width: p.width, height: p.height, tag: p.tag });
      oldFilled.push(`gbp ${old.gbp.length}`);
    }
    if (!vibeItems.length && old.vibe?.items.length) {
      vibeFrom = old.vibe.from;
      for (const v of old.vibe.items) vibeItems.push({ file: take(`old-site/vibe-${blobName(v.url)}`, v), category: v.category, subtype: v.subtype, classification: v.classification, width: v.width, height: v.height });
      oldFilled.push(`vibe ${old.vibe.items.length}`);
    }
    if (!mapsFile && old.maps) { mapsFile = take('review/google-maps-photos.png', old.maps); oldFilled.push('maps'); }
    if (!logo3xFile && old.logo3x) { logo3xFile = take('review/logo-3x.png', old.logo3x); oldFilled.push('logo-3x'); }
    // logo candidates (2026-10-22): the evidence packet is not in the bundle, but the old page drew the same files
    if (old.candidates?.length) {
      for (const c of old.candidates) oldCandidates.push({ file: take(`old-site/cand-${blobName(c.url)}`, c), basename: blobName(c.url), width: c.width, height: c.height, source: c.source, provenance: null, source_url: c.source_url, url: null, page_url: null, origin_url: null, chosen: c.chosen });
    }
    if (oldFilled.length) notes.push(`old site asset (${old.page}, reused Blob URLs): ${oldFilled.join(', ')}`);
  }

  // logo image search: cached live-Chrome thumbnails, links-only manifest, or the fallback screenshot
  const name = identity.account_name ?? req.account_name ?? req.location_name ?? 'Unknown business';
  const query = `${name} ${identity.city ?? ''} logo`;
  const lsDir = path.join(reviewDir, 'logo-search');
  const lsManifest = readJson(path.join(lsDir, 'manifest.json'), null);
  let logoSearch = { query, mode: null };
  if (lsManifest?.results?.length) {
    const thumbs = lsManifest.results.filter((r) => r.file && isFile(path.join(lsDir, r.file))).map((r) => ({ file: asset(path.join(lsDir, r.file)), alt: r.alt ?? '', w: r.w ?? null, h: r.h ?? null, page: r.page && /^https?:\/\//.test(r.page) ? r.page : null }));
    const links = lsManifest.results.filter((r) => r.page && /^https?:\/\//.test(r.page)).map((r) => ({ file: null, alt: r.alt ?? '', w: r.w ?? null, h: r.h ?? null, page: r.page }));
    const source = lsManifest.source ?? 'Google Images via the live Chrome session';
    if (thumbs.length >= 4) logoSearch = { query, mode: 'thumbs', source, fetched_at: lsManifest.fetched_at ?? null, results: thumbs };
    else if (links.length >= 4) logoSearch = { query, mode: 'links', source, fetched_at: lsManifest.fetched_at ?? null, results: links };
  }
  if (!logoSearch.mode && isFile(path.join(reviewDir, 'logo-image-search.png'))) {
    const meta = readJson(path.join(reviewDir, 'logo-image-search.json'), null);
    const when = meta?.captured_at ? String(meta.captured_at).slice(0, 10) : new Date(fs.statSync(path.join(reviewDir, 'logo-image-search.png')).mtimeMs).toISOString().slice(0, 10);
    logoSearch = { query, mode: 'shot', source: meta?.source ?? null, captured_at: when, file: asset(path.join(reviewDir, 'logo-image-search.png')) };
  }

  // logo candidates (evidence packet) and the raw source files under candidates/
  const chosenAbs = decision?.logo_choice ? localPath(runDir, decision.logo_choice) : null;
  const candidates = [...(evidence.logo_candidates ?? [])].map((c) => ({ c, abs: localPath(runDir, c.local_path) })).filter((x) => x.abs)
    .map(({ c, abs }) => ({ file: asset(abs), basename: path.basename(abs), width: c.width ?? null, height: c.height ?? null, source: c.source ?? null, provenance: c.provenance ?? null, source_url: c.source_url ?? null, url: c.url ?? null, page_url: c.page_url ?? null, origin_url: c.origin_url ?? null, chosen: Boolean(chosenAbs && path.resolve(abs) === path.resolve(chosenAbs)) }));
  if (!candidates.length && oldCandidates.length) { candidates.push(...oldCandidates); oldFilled.push(`candidates ${oldCandidates.length}`); }
  let candDir = [];
  try { candDir = fs.readdirSync(path.join(runDir, 'candidates')).sort().filter((f) => isFile(path.join(runDir, 'candidates', f))); } catch {}
  const rawFiles = candDir.map((f) => ({ basename: f, file: /\.(png|jpe?g|webp|gif)$/i.test(f) ? path.join(runDir, 'candidates', f) : null }));

  // variant sheet view (the templates' input), every logo it references mapped to an asset
  const sheetJsonPath = localPath(runDir, run.variants?.sheet_json ?? 'variants/variant-sheet.json');
  const sheetRaw = sheetJsonPath ? readJson(sheetJsonPath, null) : null;
  let sheet = null;
  if (sheetRaw) {
    const { sheetView, cellView, normalizeManifest, provenanceWords } = await import(path.join(HERE, 'variant-sheet.mjs'));
    if (!sheetRaw.run_dir) sheetRaw.run_dir = runDir;
    const manifest = normalizeManifest(sheetRaw, path.dirname(sheetJsonPath));
    let view;
    try { view = sheetView(manifest); } catch (e) {
      // An old sheet can carry a cell whose row is gone (and no stored view): draw the cells that can be drawn.
      const ok = {};
      for (const [l, c] of Object.entries(manifest.cells ?? {})) {
        if (c.view || (manifest.rows ?? []).some((r) => r.key === c.row)) ok[l] = c;
        else notes.push(`sheet cell ${l} not drawn: its row ${c.row} is not on the sheet`);
      }
      view = sheetView({ ...manifest, cells: ok });
    }
    // A cell's stored view is a snapshot from its last build; the label header follows the current rule
    // (variant-sheet.mjs cellView: one neutral colour, grey only for rejected), so recompute just the header.
    for (const cell of Object.values(manifest.cells ?? {})) {
      const v = view.cells?.[cell.letter];
      if (!v || !cell.view) continue;
      try { v.header = cellView(manifest, cell).header; } catch { /* row files missing on this machine: keep the stored header */ }
    }
    const oldLogos = new Set();
    // the stored view keeps run-relative logo paths; the manifest cell keeps the real file, which may live in a sibling run
    const cellLogo = new Map((Array.isArray(manifest.cells) ? manifest.cells : Object.values(manifest.cells ?? {})).map((c) => [c.letter, c]));
    for (const [letter, v] of Object.entries(view.cells ?? {})) for (const k of ['card', 'sticker', 'pop']) if (v?.[k]?.logo) {
      const c = cellLogo.get(letter);
      const r = asset(v[k].logo) ?? asset(k === 'sticker' ? c?.sticker_logo ?? c?.logo : c?.logo);
      if (r) { v[k].logo = r; continue; }
      // a pulled bundle has no evidence/ files: reuse the old site's upload of the same logo (keyed by run-relative path)
      const rel = runRel(runDir, v[k].logo);
      const o = rel && old?.logos?.[rel];
      if (o) { remote.set(rel, { url: o.url, bytes: o.bytes ?? null }); v[k].logo = rel; oldLogos.add(rel); }
    }
    if (oldLogos.size) oldFilled.push(`sheet logos ${oldLogos.size}`);
    const defaultLetter = sheetRaw.fable_default_letter ?? run.variants?.fable_default_letter ?? null;
    sheet = {
      json_rel: relOf(runDir, sheetJsonPath),
      revision: sheetRaw.revision ?? null,
      default_letter: defaultLetter,
      applied_letter: sheetRaw.applied_letter ?? run.variants?.applied_letter ?? null,
      marks: (sheetRaw.marks ?? []).map((m) => ({ letter: m.letter, status: m.status })),
      cells: Object.fromEntries(Object.entries(sheetRaw.cells ?? {}).map(([l, c]) => [l, { status: c.status ?? null, primary: c.primary ?? null, secondary: c.secondary ?? null, text: c.text ?? null, row_label: c.row_label ?? null, band_words: c.secondary_source ? provenanceWords(c.secondary_source, c.secondary_label) : null }])),
      view,
    };
  }

  // links: the run.json block plus the newest discovery report's category results and the pending browser URLs
  const ls = await collectLinkSources(runDir, run);
  const pickLink = (l) => (l ? { final_url: l.final_url ?? null, input_url: l.input_url ?? null, page_evidence: l.page_evidence ? { title: l.page_evidence.title ?? null, h1: Array.isArray(l.page_evidence.h1) ? l.page_evidence.h1.slice(0, 1) : null } : null, location_match_evidence: l.location_match_evidence ?? [], validity_evidence: l.validity_evidence ?? [], source_evidence: l.source_evidence ?? [], liveness: l.liveness ?? null, rejection_reason: l.rejection_reason ?? null } : null);
  const report = ls.report ? {
    file: relOf(runDir, ls.report.file),
    checked_at: ls.report.checked_at,
    summary: ls.report.report.summary ? { categories_total: ls.report.report.summary.categories_total ?? null, manual_review_items: ls.report.report.summary.manual_review_items ?? null, proposed_location_updates: ls.report.report.summary.proposed_location_updates ?? null, proposed_touchpoint_events: ls.report.report.summary.proposed_touchpoint_events ?? null } : null,
    category_results: (ls.report.report.category_results ?? []).map((cr) => ({ category: cr.category, category_status: cr.category_status ?? null, proposed_action: cr.proposed_action ?? null, selected_link: pickLink(cr.selected_link), existing_link: pickLink(cr.existing_link) })),
  } : null;
  const links = {
    block: run.links ?? {},
    report,
    pending_urls: ls.pendingUrls,
    manifest: ls.manifests[0] ? relOf(runDir, ls.manifests[0].file) : null,
    validation: ls.validations[0] ? { file: relOf(runDir, ls.validations[0].file), valid: ls.validations[0].valid, errors: ls.validations[0].errors } : null,
  };

  // previews: signage specs, legacy signage pngs, AI mockups and their prompts.md verdicts
  const pv = await collectPreviews(reviewDir);
  const previews = { prompts: Boolean(pv.promptsFile), verdicts: Object.fromEntries(pv.verdicts), letters: {} };
  for (const [l, g] of Object.entries(pv.letters)) {
    let spec = g.signage_spec ? { ...g.signage_spec.spec, file: relOf(runDir, g.signage_spec.file) } : null;
    if (spec?.logo) spec.logo = asset(spec.logo) ?? spec.logo;
    if (spec?.logo_light) spec.logo_light = asset(spec.logo_light) ?? spec.logo_light;
    previews.letters[l] = { signage_spec: spec, signage_png: g.signage ? asset(g.signage) : null, mockups: g.mockups.map((m) => ({ file: asset(m.file), scene: m.scene, suffix: m.suffix, name: m.name, basename: path.basename(m.file) })) };
  }

  const data = {
    schema_version: SITE_DATA_SCHEMA,
    kind: 'boostly-review-site-data',
    slug,
    generated_at: nowIso(),
    generator: { script: 'site-data.mjs', host: os.hostname() },
    entry: indexEntry(runDir, run),
    location: {
      name, location_name: req.location_name ?? identity.location_name ?? null, account_name: identity.account_name ?? req.account_name ?? null,
      city: identity.city ?? null, state: identity.state ?? null, request_id: req.request_id ?? null, order_type: req.order_type ?? null,
      website, website_discovered: websiteDiscovered, website_swap: swap, place_id: placeId, slack_url: slackUrl, figma_url: run.figma?.section_url ?? run.figma?.url ?? null,
      print_folder: printFolder(runDir),
    },
    canvas_usage: usageWithOldSite(usage, oldFilled, old?.page),
    // the standalone page (no review canvas: links-only siblings that inherit branding) reads these
    branding: (() => {
      const w = run.write ?? {};
      const eb = w.existing_branding ?? {};
      const src = w.branding_source_run ? path.basename(String(w.branding_source_run)) : null;
      const srcRun = src ? readJson(path.join(path.dirname(runDir), src, 'run.json'), null) : null;
      return {
        existing_kept: Boolean(w.existing_kept), inherited: Boolean(w.inherited), written_this_run: Boolean(w.written_this_run), scope: eb.scope ?? null,
        source_slug: src, source_name: srcRun?.request?.location_name ?? srcRun?.request?.identity?.location_name ?? null,
        colors: { primary: eb.web_primary_color ?? null, secondary: eb.web_secondary_color ?? null, text: eb.web_text_color ?? null, print_text_secondary: eb.print_text_secondary_color ?? null },
      };
    })(),
    website: { file: websiteRel, unavailable: websiteRel ? null : websiteUnavailable },
    gbp: {
      photos: gbpPhotos,
      cite_texts: [decision?.rationale, decision?.composition, evidence.in_store_observations].filter((t) => typeof t === 'string'),
      vibe: { from: vibeFrom, items: vibeItems, source: be.source ?? null, reason: be.reason ?? null },
      maps: { file: mapsFile },
    },
    logo_search: logoSearch,
    logo_3x: logo3xFile || usage?.logo_3x ? { file: logo3xFile, logo: usage?.logo_3x?.logo ?? null, line: usage?.logo_3x?.line ?? null, edge_quality: usage?.logo_3x?.edge_quality ?? null } : null,
    candidates: { items: candidates, raw: rawFiles.map((r) => ({ basename: r.basename, file: r.file ? asset(r.file) : null })) },
    sheet,
    links,
    previews,
    assets: {},
    notes,
  };
  if (oldFilled.length) data.old_site_assets = { source: old.page, filled: oldFilled };
  return { data, files, notes, remote };
}

/** canvas_usage with the sections the old site's upload filled re-labelled (mode "old site asset"). */
function usageWithOldSite(usage, filled, source) {
  if (!filled.length) return usage;
  const u = { ...(usage ?? {}) };
  const from = `${source}, the old review site's Blob upload of the run's file`;
  const has = (k) => filled.some((f) => f === k || f.startsWith(`${k} `));
  if (has('website')) u.website = { ...(u.website ?? {}), mode: 'old site asset', source: from };
  if (has('gbp')) u.gbp_photos = { ...(u.gbp_photos ?? {}), mode: 'old site asset', source: from };
  if (has('vibe')) u.vibe_photos = { ...(u.vibe_photos ?? {}), mode: 'old site asset', from_source: u.vibe_photos?.source ?? null, source: from };
  // maps_view keeps its recorded capture mode (the page caption reads it); the note says where the image comes from
  if (has('maps')) u.maps_view = { ...(u.maps_view ?? {}), served_from: 'old site asset', notes: [...(u.maps_view?.notes ?? []).filter((n) => !/^reused the cached capture/.test(n)), `the earlier capture under review/, re-served from ${from}`] };
  if (has('logo-3x')) u.logo_3x = { ...(u.logo_3x ?? {}), served_from: 'old site asset', source: from };
  return u;
}

/** Downsize and upload every asset; fill data.assets[rel] = { url, bytes, width, height }. */
export async function publishAssets(slug, files, data, { token, upload = true } = {}) {
  const prefix = `site/assets/${slug}/`;
  const have = new Map();
  if (token) for (const b of await listBlobs(token, prefix)) have.set(b.pathname, b);
  const origin = publicOrigin(token);
  const stats = { assets: 0, uploaded: 0, uploaded_bytes: 0, reused: 0, total_bytes: 0, source_bytes: 0 };
  const jobs = [...files.entries()];
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < jobs.length) {
      const [rel, abs] = jobs[i++];
      const src = fs.readFileSync(abs);
      const out = await shrinkImage(src, rel);
      const key = `${prefix}${sha256(out.buf).slice(0, 12)}-${out.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
      let url = have.get(key)?.url ?? null;
      if (!url) {
        if (!upload || !token) url = origin ? `${origin}/${key}` : null;
        else { url = await putBlob(token, key, out.buf, { maxAge: 31536000, overwrite: false }).catch(async (e) => { if (/already exists|409/.test(e.message)) return `${origin}/${key}`; throw e; }); stats.uploaded += 1; stats.uploaded_bytes += out.buf.length; }
      } else stats.reused += 1;
      let { width, height } = out;
      if (!width && /\.(png|jpe?g|webp|gif)$/i.test(out.name)) { try { const m = await sharp(out.buf).metadata(); width = m.width; height = m.height; } catch {} }
      data.assets[rel] = { url, bytes: out.buf.length, width: width ?? null, height: height ?? null };
      stats.assets += 1; stats.total_bytes += out.buf.length; stats.source_bytes += src.length;
    }
  }));
  data.assets = Object.fromEntries(Object.entries(data.assets).sort(([a], [b]) => a.localeCompare(b)));
  return stats;
}

/** Validator-side guard before anything leaves the machine. */
const SHIP_KEY = /^(ship_to|street_address|postal_code)$/;
const isMarker = (v) => v == null || v === '' || v === false || (v && typeof v === 'object' && !Array.isArray(v) && v.redacted === true);
/** Ship-to keys whose value redactJson already replaced (or that are empty) leave the document entirely. */
export function dropRedactedShipKeys(v) {
  if (Array.isArray(v)) return v.map(dropRedactedShipKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k, x]) => !(SHIP_KEY.test(k) && isMarker(x))).map(([k, x]) => [k, dropRedactedShipKeys(x)]));
  return v;
}
export function finalizeForPublic(data) {
  const counts = { street: 0, secret: 0 };
  const out = scrubStrings(dropRedactedShipKeys(redactJson(data)), counts);
  const s = JSON.stringify(out);
  if (/"(ship_to|street_address|postal_code)"/.test(s)) throw new Error('site data would carry ship-to keys; refusing');
  return { data: out, counts };
}

/** The stable Blob path of a location's site data (next to the copy inside its bundle). */
export const siteDataPath = (slug) => `site/data/${slug}.json`;
/** Why a location cannot render a sheet page, or null. */
export function thinReason(data) {
  // a sibling that inherits another location's branding has no sheet of its own (standalone page, or a canvas
  // whose sheet section points at the source)
  if (!data.sheet && data.branding?.source_slug) return null;
  if (!data.sheet) return 'no variant sheet manifest (variants/variant-sheet.json)';
  if (!Object.keys(data.sheet.cells ?? {}).length || !Object.keys(data.sheet.view?.cells ?? {}).length) return 'the variant sheet has no cells';
  return null;
}
/** backfilled_from: the pulled bundle's push time, else the local run dir. */
export function backfillSource(runDir) {
  const prog = readJson(path.join(runDir, 'review', 'progress.json'), {}) ?? {};
  // the last sync was a pull (not a later publish from this machine): the files are the bundle's
  if (prog.pulled?.pushed_at && String(prog.pulled.at ?? '') >= String(prog.bundle?.pushed_at ?? '')) return `bundle ${prog.pulled.pushed_at}`;
  return `local run ${os.hostname()}`;
}

async function cmdBuild(opt) {
  const runDir = path.resolve(opt.run);
  const slug = path.basename(runDir);
  const token = loadToken();
  if (opt.upload && !token) die('no BLOB_READ_WRITE_TOKEN (env or the fulfillment-reviews clone .env.local)');
  const t0 = Date.now();
  const { data, files, notes, remote } = await buildSiteData(runDir, { backfill: Boolean(opt.backfill) });
  if (opt.backfill) {
    const thin = thinReason(data);
    if (thin) { console.error(`site-data.mjs: ${slug} too thin to render: ${thin}`); process.exit(4); }
    data.backfilled_from = backfillSource(runDir);
  }
  const stats = await publishAssets(slug, files, data, { token, upload: opt.upload });
  if (remote.size) { await describeRemoteAssets(remote, data); stats.old_site_reused = remote.size; }
  const { data: pub, counts } = finalizeForPublic(data);
  const out = path.join(runDir, 'review', 'site-data.json');
  const body = JSON.stringify(pub) + '\n';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  if (opt.upload) { await putBlob(token, siteDataPath(slug), Buffer.from(body), { maxAge: 60 }); stats.uploaded_bytes += Buffer.byteLength(body); }
  const summary = { ok: true, slug, file: out, site_data_bytes: Buffer.byteLength(body), ...stats, scrubbed: counts, notes, ms: Date.now() - t0 };
  console.log(opt.json ? JSON.stringify(summary, null, 1) : `site-data ${slug}: ${stats.assets} images (${(stats.total_bytes / 1e6).toFixed(2)} MB on Blob, ${(stats.source_bytes / 1e6).toFixed(2)} MB at source), uploaded ${stats.uploaded} (${(stats.uploaded_bytes / 1e6).toFixed(2)} MB), reused ${stats.reused}; site-data.json ${(summary.site_data_bytes / 1024).toFixed(0)} KB${counts.street || counts.secret ? `; scrubbed ${counts.street} street-like and ${counts.secret} token-like strings` : ''}${notes.length ? `\n  ${notes.join('\n  ')}` : ''}`);
  return summary;
}

async function cmdIndex(opt) {
  const runDir = path.resolve(opt.run);
  const slug = path.basename(runDir);
  const token = loadToken();
  if (!token) die('no BLOB_READ_WRITE_TOKEN');
  const data = readJson(path.join(runDir, 'review', 'site-data.json'), null);
  if (!data) die(`${runDir}/review/site-data.json missing: run site-data.mjs build first`);
  const run = readJson(path.join(runDir, 'run.json'));
  const progress = readJson(path.join(runDir, 'review', 'progress.json'), {}) ?? {};
  let entry = { ...finalizeForPublic(indexEntry(runDir, run)).data, has_site_data: true, old_url: null, published_at: nowIso(), site_data_generated_at: data.generated_at, site_data_url: `${publicOrigin(token)}/${siteDataPath(slug)}`, bundle_pushed_at: progress.bundle?.pushed_at ?? progress.pulled?.pushed_at ?? null };
  if (opt.backfill) {
    // A pulled copy has no checklist/notes beside it: keep the board fields the existing (seeded) entry carries
    // where this run has none, and the seeded request time when run.json has none.
    const prev = await fetchJson(`${publicOrigin(token)}/site/entries/${slug}.json`).catch(() => null);
    if (prev) for (const k of [...BACKFILL_KEEP]) if ((entry[k] == null || (Array.isArray(entry[k]) && !entry[k].length)) && prev[k] != null) entry[k] = prev[k];
    entry = { ...entry, backfilled_from: data.backfilled_from ?? null };
  }
  await putBlob(token, `site/entries/${slug}.json`, Buffer.from(JSON.stringify(entry)), { maxAge: 60 });
  if (opt.entryOnly) { console.log(`entry: ${slug} written (index not rebuilt: run rebuild-index after the batch)`); return; }
  // The index is rebuilt from the per-location entry files (the source of truth) with this run's entry laid
  // over them, never read-modify-written from site/index.json: the public copy of index.json can be up to a
  // minute stale on the CDN, and writing a stale copy back would drop another machine's newer entry.
  // Two passes: the second, a few seconds later, folds in an entry another machine wrote in the meantime.
  let idx;
  for (let pass = 1; pass <= 2; pass += 1) {
    if (pass > 1) await new Promise((r) => setTimeout(r, 3000));
    idx = await buildIndexFromEntries(token, { [slug]: entry });
    await putBlob(token, 'site/index.json', Buffer.from(JSON.stringify(idx)), { maxAge: 60 });
  }
  console.log(`index: ${slug} upserted (${idx.count} entries; the public copy refreshes within a minute)${SITE_URL ? ` -> ${SITE_URL}/l/${slug}` : ''}`);
}

const BACKFILL_KEEP = new Set(['account', 'city', 'state', 'requested_at', 'boostly_status', 'steps', 'needs_you', 'gaps', 'hold', 'done', 'note', 'review_status', 'figma_url', 'print_url', 'recommended_letter', 'picked_letter']);

/** site/index.json content from every site/entries/<slug>.json, with `overlay` entries (this run's) winning. */
async function buildIndexFromEntries(token, overlay = {}) {
  const blobs = (await listBlobs(token, 'site/entries/')).filter((b) => b.pathname.endsWith('.json'));
  const entries = {};
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(12, blobs.length) }, async () => {
    while (i < blobs.length) { const b = blobs[i++]; const e = await fetchJson(b.url).catch(() => null); if (e?.slug) entries[e.slug] = e; }
  }));
  for (const [k, e] of Object.entries(overlay)) {
    // keep whichever copy of this slug is newer: a stale CDN read of our own file must not beat the in-memory one
    if (!entries[k] || String(entries[k].published_at ?? '') <= String(e.published_at ?? '')) entries[k] = e;
  }
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]));
  return { schema_version: INDEX_SCHEMA, generated_at: nowIso(), count: Object.keys(sorted).length, entries: sorted };
}

async function cmdRebuildIndex() {
  const token = loadToken();
  if (!token) die('no BLOB_READ_WRITE_TOKEN');
  const idx = await buildIndexFromEntries(token);
  await putBlob(token, 'site/index.json', Buffer.from(JSON.stringify(idx)), { maxAge: 60 });
  console.log(`index rebuilt: ${idx.count} entries`);
}

async function cmdSeedIndex(opt) {
  const token = loadToken();
  if (!token) die('no BLOB_READ_WRITE_TOKEN');
  const sites = readJson(path.resolve(opt.sitesJson), null)?.sites;
  if (!Array.isArray(sites)) die(`${opt.sitesJson}: no sites[]`);
  const have = new Set((await listBlobs(token, 'site/entries/')).map((b) => b.pathname.replace(/^site\/entries\/|\.json$/g, '')));
  const oldSite = process.env.BOOSTLY_REVIEWS_SITE || 'https://fulfillment-reviews.vercel.app';
  let n = 0;
  for (const e of sites) {
    if (!e.slug || have.has(e.slug)) continue;
    const entry = finalizeForPublic({
      slug: e.slug, name: e.name, account: e.account ?? null, city: e.city ?? null, state: e.state ?? null,
      requested_at: e.requested_at ?? null, updated_at: e.updated_at ?? null, cursor: e.cursor ?? null,
      status: e.status ?? 'unknown', status_label: e.status_label ?? null,
      recommended_letter: e.recommended_letter ?? null, picked_letter: e.picked_letter ?? null,
      figma_url: e.figma_url ?? null, signage_direct: e.signage_direct ?? null, print_url: e.print_handoff_url ?? null,
      boostly_status: e.boostly_status ?? null, steps: e.steps ?? null, needs_you: e.needs_you ?? null, gaps: e.gaps ?? null,
      hold: e.hold ?? null, done: e.done ?? null, note: e.note ?? null, progress: e.progress ?? null, editing: null,
      review_status: e.review_status ?? null, has_canvas: true,
      has_site_data: false, old_url: e.review_url ? new URL(e.review_url, oldSite).toString() : null,
      published_at: nowIso(), seeded_from: 'fulfillment-reviews data/sites.json',
    }).data;
    await putBlob(token, `site/entries/${e.slug}.json`, Buffer.from(JSON.stringify(entry)), { maxAge: 60 });
    n += 1;
  }
  console.log(`seeded ${n} entries (${have.size} already had one)`);
  await cmdRebuildIndex();
}

async function cmdFootprint(opt) {
  const token = loadToken();
  if (!token) die('no BLOB_READ_WRITE_TOKEN');
  const per = new Map();
  const add = (slug, kind, bytes) => { const r = per.get(slug) ?? { site_assets: 0, bundle: 0, old_assets: 0 }; r[kind] += bytes; per.set(slug, r); };
  for (const [prefix, kind] of [['site/assets/', 'site_assets'], ['bundles/', 'bundle'], ['assets/', 'old_assets']]) {
    for (const b of await listBlobs(token, opt.slug ? `${prefix}${opt.slug}/` : prefix)) add(b.pathname.slice(prefix.length).split('/')[0], kind, b.size);
  }
  const rows = [...per.entries()].sort((a, b) => b[1].site_assets - a[1].site_assets);
  const mb = (n) => (n / 1e6).toFixed(2);
  for (const [s, r] of rows) console.log(`${s.padEnd(56)} site ${mb(r.site_assets).padStart(7)} MB  bundle ${mb(r.bundle).padStart(7)} MB  old-site ${mb(r.old_assets).padStart(7)} MB`);
  const tot = rows.reduce((a, [, r]) => ({ s: a.s + r.site_assets, b: a.b + r.bundle, o: a.o + r.old_assets }), { s: 0, b: 0, o: 0 });
  console.log(`TOTAL ${rows.length} slugs: site ${mb(tot.s)} MB, bundles ${mb(tot.b)} MB, old site ${mb(tot.o)} MB`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = { upload: true };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run') opt.run = argv[++i];
    else if (a === '--slug') opt.slug = argv[++i];
    else if (a === '--no-upload') opt.upload = false;
    else if (a === '--backfill') opt.backfill = true;
    else if (a === '--entry-only') opt.entryOnly = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--sites-json') opt.sitesJson = argv[++i];
    else die(`unknown argument ${a}`);
  }
  const run = { build: cmdBuild, index: cmdIndex, 'rebuild-index': cmdRebuildIndex, 'seed-index': cmdSeedIndex, footprint: cmdFootprint }[cmd];
  if (cmd === 'seed-index' && !opt.sitesJson) die('seed-index needs --sites-json FILE');
  if (!run || ((cmd === 'build' || cmd === 'index') && !opt.run)) die('usage: site-data.mjs build|index --run RUN_DIR [--no-upload] [--backfill] [--json] | rebuild-index | footprint [--slug S]');
  await run(opt).catch((e) => die(e.stack || e.message, 1));
}
