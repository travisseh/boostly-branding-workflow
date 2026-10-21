#!/usr/bin/env node
// site-data.mjs: the data side of the hosted review site (2026-10-21). The site (boostly-branding-workflow
// site/, Next.js) renders every location page live from the Blob store; this script only emits data.
//
//   site-data.mjs build --run RUN_DIR [--no-upload]   collect the page facts into RUN_DIR/review/site-data.json and
//                                                      upload every image the page shows (downsized) to
//                                                      site/assets/<slug>/<sha12>-<name> (content addressed, skipped
//                                                      when already in the store). The bundle push (run-progress.mjs
//                                                      publish) then carries review/site-data.json like any review/*.json.
//   site-data.mjs index --run RUN_DIR                  upsert this location's entry in site/index.json (+ site/entries/<slug>.json)
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
      const res = await fetch(`${API}/${pathname}`, { method: 'PUT', headers, body });
      if (!res.ok) throw new Error(`blob put ${pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).url;
    } catch (e) {
      lastErr = e;
      if (!/\b(5\d\d|429|fetch failed)\b/.test(e.message)) throw e;
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
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}`, 'x-api-version': '7' } });
    if (!res.ok) throw new Error(`blob list: ${res.status}`);
    const json = await res.json();
    out.push(...(json.blobs || []));
    cursor = json.hasMore ? json.cursor : undefined;
  } while (cursor);
  return out;
}
async function fetchJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
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
    has_canvas: exists(path.join(runDir, 'review', 'review-canvas.html')),
  };
}

// ---------- build ----------
export async function buildSiteData(runDir) {
  const slug = path.basename(runDir);
  const run = readJson(path.join(runDir, 'run.json'));
  if (!run) throw new Error(`${runDir}: no run.json`);
  const reviewDir = path.join(runDir, 'review');
  const notes = [];
  const files = new Map(); // rel -> abs
  const asset = (p) => {
    const a = localPath(runDir, p);
    if (!a) return null;
    if (!a.startsWith(runDir + path.sep)) { notes.push(`outside the run dir, not published: ${p}`); return null; }
    const rel = relOf(runDir, a);
    files.set(rel, a);
    return rel;
  };
  const req = run.request ?? {};
  const identity = req.identity ?? {};
  const evidence = readJson(localPath(runDir, run.evidence?.packet_path) ?? path.join(runDir, 'evidence', 'branding-evidence.json'), {}) ?? {};
  const decision = run.decision ?? readJson(path.join(runDir, 'decision.json'), {}) ?? {};
  const usage = readJson(path.join(reviewDir, 'review-canvas.json'), null)?.sections ?? null;
  const swap = approvedWebsiteSwap(run.links?.website_bootstrap);
  const website = swap?.url ?? req.website_url ?? evidence.location?.website_url ?? null;
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
  const mapsFile = isFile(path.join(reviewDir, 'google-maps-photos.png')) ? asset(path.join(reviewDir, 'google-maps-photos.png')) : null;

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
    const view = sheetView(manifest);
    // A cell's stored view is a snapshot from its last build; the label header follows the current rule
    // (variant-sheet.mjs cellView: one neutral colour, grey only for rejected), so recompute just the header.
    for (const cell of Object.values(manifest.cells ?? {})) {
      const v = view.cells?.[cell.letter];
      if (!v || !cell.view) continue;
      try { v.header = cellView(manifest, cell).header; } catch { /* row files missing on this machine: keep the stored header */ }
    }
    for (const v of Object.values(view.cells ?? {})) for (const k of ['card', 'sticker', 'pop']) if (v?.[k]?.logo) { const r = asset(v[k].logo); if (r) v[k].logo = r; }
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
      website, website_swap: swap, place_id: placeId, slack_url: slackUrl, figma_url: run.figma?.section_url ?? run.figma?.url ?? null,
      print_folder: printFolder(runDir),
    },
    canvas_usage: usage,
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
    website: { file: websiteFile ? asset(websiteFile) : null, unavailable: websiteUnavailable },
    gbp: {
      photos: gbpPhotos,
      cite_texts: [decision?.rationale, decision?.composition, evidence.in_store_observations].filter((t) => typeof t === 'string'),
      vibe: { from: vibeFrom, items: vibeItems, source: be.source ?? null, reason: be.reason ?? null },
      maps: { file: mapsFile },
    },
    logo_search: logoSearch,
    candidates: { items: candidates, raw: rawFiles.map((r) => ({ basename: r.basename, file: r.file ? asset(r.file) : null })) },
    sheet,
    links,
    previews,
    assets: {},
    notes,
  };
  return { data, files, notes };
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
export function finalizeForPublic(data) {
  const counts = { street: 0, secret: 0 };
  const out = scrubStrings(redactJson(data), counts);
  const s = JSON.stringify(out);
  if (/"(ship_to|street_address|postal_code)"/.test(s)) throw new Error('site data would carry ship-to keys; refusing');
  return { data: out, counts };
}

async function cmdBuild(opt) {
  const runDir = path.resolve(opt.run);
  const slug = path.basename(runDir);
  const token = loadToken();
  if (opt.upload && !token) die('no BLOB_READ_WRITE_TOKEN (env or the fulfillment-reviews clone .env.local)');
  const t0 = Date.now();
  const { data, files, notes } = await buildSiteData(runDir);
  const stats = await publishAssets(slug, files, data, { token, upload: opt.upload });
  const { data: pub, counts } = finalizeForPublic(data);
  const out = path.join(runDir, 'review', 'site-data.json');
  const body = JSON.stringify(pub) + '\n';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
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
  const entry = { ...finalizeForPublic(indexEntry(runDir, run)).data, has_site_data: true, old_url: null, published_at: nowIso(), site_data_generated_at: data.generated_at, bundle_pushed_at: progress.bundle?.pushed_at ?? null };
  await putBlob(token, `site/entries/${slug}.json`, Buffer.from(JSON.stringify(entry)), { maxAge: 60 });
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
    else if (a === '--json') opt.json = true;
    else if (a === '--sites-json') opt.sitesJson = argv[++i];
    else die(`unknown argument ${a}`);
  }
  const run = { build: cmdBuild, index: cmdIndex, 'rebuild-index': cmdRebuildIndex, 'seed-index': cmdSeedIndex, footprint: cmdFootprint }[cmd];
  if (cmd === 'seed-index' && !opt.sitesJson) die('seed-index needs --sites-json FILE');
  if (!run || ((cmd === 'build' || cmd === 'index') && !opt.run)) die('usage: site-data.mjs build|index --run RUN_DIR [--no-upload] [--json] | rebuild-index | footprint [--slug S]');
  await run(opt).catch((e) => die(e.stack || e.message, 1));
}
