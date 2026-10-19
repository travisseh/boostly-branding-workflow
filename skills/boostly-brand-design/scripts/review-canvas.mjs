#!/usr/bin/env node
// review-canvas.mjs: one review canvas per location that replaces the manual review ritual
// (open the website, open the GBP and look for in-store photos, image-search the logo).
//
//   node review-canvas.mjs --run <run_dir> [--open] [--skip-google] [--no-live-chrome] [--chrome-profile boostly]
//                          [--scale 2] [--no-html] [--record-only] [--png] [--no-record]
//
// Outputs under <run_dir>/review/:
//   review-canvas.html  the review page (inline CSS, relative image paths, every image at native
//                       resolution, click to open the file). The variant sheet, the default cell and the
//                       signage previews are drawn by the browser from the vendored templates
//                       (templates/sheet-templates.js, copied next to the page as sheet-templates.js) and
//                       the sheet JSON: no app screenshots (Travisse 2026-10-13). Click cells to select
//                       them and "Compare selected" for a side-by-side; click the sheet background to
//                       toggle native size.
//   review-canvas.png   only with --png: one tall PNG, 1600px * --scale wide, for the operator's own
//                       look in Preview (--open). The sheet and signage rasters it needs are rendered once in
//                       memory through scripts/render-preview.mjs (no dev server). Nothing else reads it.
// Sections: header + gate summary, website, Google Business Profile (downloaded Place photos, Google
// "Vibe" photos from the SearchAPI evidence, live Maps photo view), logo image search, logo
// candidates, the variant sheet with Fable's default cell marked, Links (the link automation results
// from run.json `links`, the discovery report, and links-port/, one row per category with status and
// evidence in plain words), then Previews (only when files exist; a post-pick step): per letter, the
// harness signage preview (review/signage-preview-<L>.png) and the AI mockups
// (review/mockups/<scene>-<L>[-suffix].png) with the verdict/drift line from review/mockups/prompts.md.
// In the PNG the previews are reduced and skipped when they would push the file past the budget
// (--png-budget-mb, default 25); the HTML always has them at native size. Cached run evidence and earlier
// captures under review/ are reused; Playwright (from ../harness) takes only what is missing.
// --skip-google takes no new Google captures but still reuses cached ones.
//
// Logo image search: Google blocks every headless/automated browser with its "sorry" page, so the
// first path is the user's live Chrome session (open the query in the Boostly profile, read the
// thumbnail URLs, close the tab, re-fetch the public gstatic thumbnails). Fallbacks: headless
// Google, Bing, DuckDuckGo, then a labeled gray box.
// The canvas record lands in run.json under variants.review_canvas through run-file (the run
// schema has no top-level review block; --no-record skips it). No production writes; nothing printed
// that could be a secret.

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import templates from '../templates/sheet-templates.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_FILE = path.resolve(SCRIPT_DIR, '..', 'templates', 'sheet-templates.js');
const HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', 'harness');
const require = createRequire(path.join(HARNESS_DIR, 'package.json'));
const sharp = require('sharp');
const RUN_FILE_CLI = path.resolve(SCRIPT_DIR, '..', '..', 'boostly-box-fulfillment', 'scripts', 'run-file.ts');

// Layout is authored in logical units (1600 wide) and rendered at S x.
let S = 2;
const L = (n) => Math.round(n * S);
const LOGICAL_W = 1600;
const LOGICAL_MARGIN = 40;
const W = () => L(LOGICAL_W);
const MARGIN = () => L(LOGICAL_MARGIN);
const CW = () => W() - MARGIN() * 2;
const FONT = 'Helvetica, Arial, sans-serif';
const GRAY_BG = '#EDEDED';
const LOGO_BG = '#8C8C8C'; // shows both white knockouts and dark inks
const GREEN = '#1B5E20';

// ---------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { command: 'canvas', open: false, skipGoogle: false, googleBudgetMs: 90_000, liveChrome: false, chromeProfile: 'boostly', scale: 2, html: true, recordOnly: false, cells: null, pngBudgetMb: 25, png: false, record: true };
  if (argv[0] && !argv[0].startsWith('--')) {
    if (argv[0] !== 'compare') throw new Error(`Unknown subcommand ${argv[0]}; the only subcommand is "compare"`);
    args.command = argv.shift();
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run' || a === '--run-dir') args.run = argv[++i];
    else if (a === '--cells') args.cells = String(argv[++i]).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    else if (a === '--open') args.open = true;
    else if (a === '--skip-google') args.skipGoogle = true;
    else if (a === '--google-budget-ms') args.googleBudgetMs = Number(argv[++i]);
    else if (a === '--no-live-chrome') args.liveChrome = false;
    // Opt-in only (Travisse 2026-09-24): the live-Chrome path drives his visible Chrome via osascript and steals focus.
    else if (a === '--live-chrome') args.liveChrome = true;
    else if (a === '--chrome-profile') args.chromeProfile = argv[++i];
    else if (a === '--scale') args.scale = Number(argv[++i]);
    else if (a === '--html') args.html = true;
    else if (a === '--no-html') args.html = false;
    else if (a === '--record-only') args.recordOnly = true;
    else if (a === '--png-budget-mb') args.pngBudgetMb = Number(argv[++i]);
    // --png (2026-10-13): the tall review-canvas.png is opt-in; the HTML page is the review surface.
    else if (a === '--png') args.png = true;
    else if (a === '--no-png') args.png = false;
    else if (a === '--no-record') args.record = false;
    else if (a === '--help' || a === '-h') { console.log('node review-canvas.mjs --run <run_dir> [--open] [--skip-google] [--no-live-chrome] [--chrome-profile boostly] [--scale 2] [--no-html] [--record-only] [--png] [--png-budget-mb 25] [--no-record]\nnode review-canvas.mjs compare --run <run_dir> [--cells K,M,L] [--open] [--png] [--scale 2]   (no --cells: the default plus the strongest cell of every other row -> review/compare-default)'); process.exit(0); }
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!args.run) throw new Error('Usage: node review-canvas.mjs --run <run_dir> [--open]  |  node review-canvas.mjs compare --run <run_dir> [--cells K,M,L]');
  if (!(args.scale >= 1 && args.scale <= 4)) throw new Error('--scale must be between 1 and 4');
  if (!(args.pngBudgetMb > 0)) throw new Error('--png-budget-mb must be a positive number');
  args.run = path.resolve(args.run);
  return args;
}

// ---------------------------------------------------------------------------------------------
// text and layout primitives (SVG through sharp; no font files needed)
// ---------------------------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(text, size, maxWidth) {
  const perChar = size * 0.53;
  const maxChars = Math.max(8, Math.floor(maxWidth / perChar));
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length > maxChars && line) { out.push(line); line = w; } else line = next;
      while (line.length > maxChars) { out.push(line.slice(0, maxChars)); line = line.slice(maxChars); }
    }
    out.push(line);
  }
  return out;
}

/** Text lines. Items: string or { text, size, bold, color, gap, indent } in logical units. Width in device px. */
async function textBlock(items, { width = CW(), bg = '#FFFFFF', pad = 0 } = {}) {
  const lines = [];
  let y = pad;
  for (const item of items) {
    const it = typeof item === 'string' ? { text: item } : item;
    const size = L(it.size ?? 22);
    const lh = Math.round(size * 1.3);
    const indent = L(it.indent ?? 0);
    if (it.gap) y += L(it.gap);
    for (const l of wrap(it.text, size, width - pad * 2 - indent)) {
      lines.push(`<text x="${pad + indent}" y="${y + size}" font-family="${FONT}" font-size="${size}" font-weight="${it.bold ? 700 : 400}" fill="${it.color ?? '#111111'}">${esc(l)}</text>`);
      y += lh;
    }
  }
  const height = Math.max(1, y + pad);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${bg}"/>${lines.join('')}</svg>`;
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), width, height };
}

async function grayBox(text, { height = 160, width = CW() } = {}) {
  const inner = await textBlock([{ text, size: 24, color: '#444444' }], { width: width - L(60), bg: GRAY_BG });
  const h = Math.max(L(height), inner.height + L(60));
  const buffer = await sharp({ create: { width, height: h, channels: 3, background: GRAY_BG } })
    .composite([{ input: inner.buffer, left: L(30), top: L(30) }]).png().toBuffer();
  return { buffer, width, height: h };
}

async function spacer(height) {
  const h = L(height);
  return { buffer: await sharp({ create: { width: CW(), height: h, channels: 3, background: '#FFFFFF' } }).png().toBuffer(), width: CW(), height: h };
}

async function rule() {
  const h = L(3);
  return { buffer: await sharp({ create: { width: CW(), height: h, channels: 3, background: '#CCCCCC' } }).png().toBuffer(), width: CW(), height: h };
}

/** Fit an image file into w x h (device px) on a background; cropTop keeps the top of tall pages. */
async function fitImage(file, w, h, { bg = GRAY_BG, cropTop = false, frame = null } = {}) {
  let img = sharp(file, { failOn: 'none', limitInputPixels: false }).rotate();
  const meta = await img.metadata();
  if (cropTop && meta.width && meta.height) {
    const scaled = Math.round(meta.height * (w / meta.width));
    if (scaled > h) img = img.resize({ width: w, kernel: 'lanczos3' }).extract({ left: 0, top: 0, width: w, height: h });
    else img = img.resize(w, h, { fit: 'contain', background: bg, position: 'top', kernel: 'lanczos3' });
  } else {
    img = img.resize(w, h, { fit: 'contain', background: bg, kernel: 'lanczos3' });
  }
  let buffer = await img.flatten({ background: bg }).png().toBuffer();
  if (frame) {
    const t = L(3);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${t}" y="${t}" width="${w - 2 * t}" height="${h - 2 * t}" fill="none" stroke="${frame}" stroke-width="${2 * t}"/></svg>`;
    buffer = await sharp(buffer).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  }
  return buffer;
}

/** Full-width image block. Width: CW, or the native width when `native` and it is narrower. Height capped at maxH (logical). */
async function imageBlock(file, { maxH = 1100, cropTop = false, bg = '#FFFFFF', native = false } = {}) {
  const meta = await sharp(file, { limitInputPixels: false }).metadata();
  const w = native ? Math.min(CW(), meta.width) : CW();
  const naturalH = Math.round(meta.height * (w / meta.width));
  const h = Math.min(naturalH, L(maxH));
  const img = await fitImage(file, w, h, { bg, cropTop: cropTop || naturalH > h });
  const buffer = w < CW()
    ? await sharp({ create: { width: CW(), height: h, channels: 3, background: '#FFFFFF' } }).composite([{ input: img, left: 0, top: 0 }]).png().toBuffer()
    : img;
  return { buffer, width: CW(), height: h, cropped: naturalH > h };
}

/** Grid of { file, label, frame?, labelColor?, bg? } items; cellH/labelH/labelSize in logical units. */
async function imageGrid(items, { cols = 3, cellH = 400, labelH = 52, gap = 12, bg = GRAY_BG, labelSize = 17 } = {}) {
  if (!items.length) return spacer(1);
  const g = L(gap); const ch = L(cellH); const lh = L(labelH);
  const cw = Math.floor((CW() - g * (cols - 1)) / cols);
  const rows = Math.ceil(items.length / cols);
  const height = rows * (ch + lh + g) - g;
  const composites = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const x = (i % cols) * (cw + g);
    const y = Math.floor(i / cols) * (ch + lh + g);
    let img;
    try {
      img = await fitImage(it.file, cw, ch, { bg: it.bg ?? bg, frame: it.frame ?? null });
    } catch (err) {
      img = (await grayBox(`could not read ${path.basename(it.file)}: ${String(err.message).slice(0, 80)}`, { width: cw, height: cellH })).buffer;
    }
    composites.push({ input: img, left: x, top: y });
    const label = await textBlock([{ text: it.label ?? '', size: labelSize, color: it.labelColor ?? '#222222', bold: Boolean(it.bold) }], { width: cw, pad: 0 });
    const clipped = await sharp(label.buffer).extract({ left: 0, top: 0, width: cw, height: Math.min(label.height, lh) }).png().toBuffer();
    composites.push({ input: clipped, left: x, top: y + ch + L(4) });
  }
  const buffer = await sharp({ create: { width: CW(), height, channels: 3, background: '#FFFFFF' } }).composite(composites).png().toBuffer();
  return { buffer, width: CW(), height };
}

/** Stack blocks vertically on a white canvas. */
async function stack(blocks, outFile) {
  const total = blocks.reduce((s, b) => s + b.height, 0) + MARGIN() * 2;
  const composites = [];
  let y = MARGIN();
  for (const b of blocks) {
    composites.push({ input: b.buffer, left: MARGIN(), top: y });
    y += b.height;
  }
  await sharp({ create: { width: W(), height: total, channels: 3, background: '#FFFFFF' }, limitInputPixels: false })
    .composite(composites).png({ compressionLevel: 8 }).toFile(outFile);
  return { width: W(), height: total };
}

// ---------------------------------------------------------------------------------------------
// run inputs
// ---------------------------------------------------------------------------------------------
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
function rel(runDir, p) { return p ? (path.isAbsolute(p) ? path.relative(runDir, p) : p) : null; }
function abs(runDir, p) { return p ? (path.isAbsolute(p) ? p : path.join(runDir, p)) : null; }

function firstSentence(text, max = 220) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Pure: a URL as bare host/path (no scheme, no www.), middle-truncated to about `max` chars. */
export function displayUrl(url, max = 60) {
  const t = String(url ?? '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, (m) => m);
  if (t.length <= max) return t;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${t.slice(0, head)}…${t.slice(t.length - tail)}`;
}

/**
 * Pure: where a logo candidate came from, for the caption. A real URL (source_url and friends, or one
 * written into the source text) wins; a first-party candidate without one points at the website; a
 * local file (wizard upload, attachment) shows its file name with no link. (2026-10-12, Travisse.)
 */
export function candidateSource(c, website = null) {
  const src = String(c?.source ?? '');
  for (const k of ['source_url', 'url', 'page_url', 'origin_url']) if (typeof c?.[k] === 'string' && /^https?:\/\//.test(c[k])) return { url: c[k], text: displayUrl(c[k]) };
  const m = src.match(/https?:\/\/[^\s)\]'"]+/) ?? src.match(/\b(?:www\.)?(?:facebook|instagram|yelp|x|twitter|tiktok)\.com\/[\w.\-/?=&%]+/i);
  if (m) { const url = /^https?:/.test(m[0]) ? m[0] : `https://${m[0]}`; return { url, text: displayUrl(url) }; }
  if (/^first_party/.test(String(c?.provenance ?? '')) && website) return { url: website, text: displayUrl(website) };
  const file = src.match(/[\w][\w.\-]*\.(?:png|jpe?g|svg|webp|gif|pdf|ai|eps)\b/i)?.[0] ?? (c?.local_path ? path.basename(c.local_path) : null);
  return { url: null, text: file ? `file ${file}` : null };
}

// Operator instructions inside a link reason ("Write via branding set --facebook-url at closeout",
// "Dry run recorded", "see website_bootstrap") are for the closeout agent, not the reviewer.
const OPERATOR_SENTENCE = /--[a-z][\w-]*|\b(?:branding|location|boostly-links|links?)\s+set\b|\bdry run\b|\bsee [\w]+_[\w.]+\b|\bwrite (?:via|with|at)\b|\bcloseout (?:applies|writes|will write)\b|\brun\.json\b/i;
const sentencesOf = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((x) => x.trim()).filter(Boolean);
const reviewerSentences = (reason) => sentencesOf(reason)
  .map((x) => x.replace(/^(?:question for travisse|note|hold|held|rejected?|ready|write|skip)\s*:\s*/i, '').trim())
  .filter((x) => x && !OPERATOR_SENTENCE.test(x));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Pure: one plain-English line per link row saying what happens at closeout and why. Built from the
 * status kind, the identity signals in the evidence and reason text, and the first reviewer-facing
 * sentence of the reason. Deterministic; never edits run data. (2026-10-12, Travisse.)
 */
export function linkVerdict(row) {
  const kind = typeof row?.status === 'string' ? row.status : row?.status?.kind ?? 'none';
  const text = [...(row?.evidence ?? []), String(row?.reason ?? '')].join(' ; ');
  const matched = [];
  if (/address on the page matches|\baddress\b[^.;]{0,80}\bmatch(?:es|ing)?\b/i.test(text)) matched.push('address');
  if (/phone on the page matches|\bphone\b[^.;]{0,60}\bmatch(?:es|ing)?\b|\(matches places\)/i.test(text)) matched.push('phone');
  let signal = null;
  if (matched.length) signal = `Matches the store's ${matched.join(' and ')}.`;
  else if (/the website links to it|\blinked (?:as|from)\b|\bsite backlink\b|official_website_links_to_candidate/i.test(text)) signal = "Linked from the store's own website.";
  else if (/title matches the business|url slug names the business|\bpage title\b|\btitle "/i.test(text)) signal = 'Name matches the business.';
  const why = reviewerSentences(row?.reason);
  const first = why[0] ? clip(why[0], 150) : null;
  if (kind === 'written') return ['Written to the location.', signal ?? first].filter(Boolean).join(' ');
  if (kind === 'ready' || kind === 'live') return ['Will be written at closeout.', signal ?? first].filter(Boolean).join(' ');
  if (kind === 'existing') return ['Already on the location, kept as is.', signal ?? first].filter(Boolean).join(' ');
  if (kind === 'held') {
    const body = first ?? 'needs a human decision';
    return `Held: ${body}${/needs a yes|needs a human|needs a decision/i.test(body) ? '' : ' Needs a yes to proceed.'}`;
  }
  if (kind === 'pending') return 'Waiting on the live browser check before a decision.';
  if (kind === 'rejected') return `Rejected: ${first ?? 'not this business.'}`;
  return ['Nothing found.', first].filter(Boolean).join(' ');
}

/** Pure: the short link chips for the top of the page: written, live, ready, and existing rows, plus held rows tagged "held". */
export function overviewLinkChips(rows) {
  const short = { ordering: 'Ordering', careers_jobs: 'Careers' };
  const out = [];
  for (const r of rows ?? []) {
    const kind = r.status?.kind;
    if (!r.url || !/^https?:\/\//.test(r.url)) continue;
    if (!['written', 'live', 'ready', 'existing', 'held'].includes(kind)) continue;
    out.push({ label: short[r.category] ?? r.label, url: r.url, host: displayUrl(r.url, 44), tag: kind === 'held' ? 'held' : null });
  }
  return out;
}

/** Plain-words source label for a logo candidate: provenance first, then the earliest-mentioned source, plus the treatment phrase. */
function candidateSourceLabel(c) {
  const src = String(c.source ?? '');
  const low = src.toLowerCase();
  const table = [
    [/facebook (page )?avatar|facebook profile|fb avatar/, 'Facebook avatar'],
    [/instagram/, 'Instagram avatar'],
    [/site header|header logo|official site/, 'site header'],
    [/wizard attachment|onboarding wizard/, 'onboarding wizard upload'],
    [/gbp photo|storefront sign|illuminated sign|in-store menu|traced from the sign/, 'GBP photo trace (sign/menu)'],
    [/favicon/, 'favicon'],
  ];
  let where = null; let best = Infinity;
  for (const [re, label] of table) {
    const m = low.match(re);
    if (m && m.index < best) { best = m.index; where = label; }
  }
  if (!where) where = c.provenance ?? 'unknown source';
  if (c.provenance === 'first_party_header') where = 'site header';
  if (c.provenance === 'gbp') where = 'GBP photo trace (sign/menu)';
  const traced = c.provenance !== 'first_party_header' && /trace|potrace|vector|cut|knockout|recolor|mask/.test(low);
  const m = src.match(/(?:^|\.\s+)((?:FULL|DESCRIPTOR-FREE|WORDS-ONLY|WORDS|NAME-ONLY|ONE-INK|KNOCKOUT|WHITE|BLACK|NAVY|Script|Words)[^.]{0,70})/);
  const treatment = m ? m[1].replace(/\s+/g, ' ').trim() : null;
  return `${where}${traced ? ', traced cut' : ''}${treatment ? `\n${treatment}` : ''}`;
}

const RAW_SOURCE_FILES = [
  [/^site-logo-original\./, 'site header, original file'],
  [/^site-logo-w\d+\./, 'site header, upscaled'],
  [/^fb-avatar-large\./, 'Facebook avatar, large'],
  [/^fb-avatar\./, 'Facebook avatar'],
  [/^fb-og-image\./, 'Facebook share image'],
  [/^fb-pic-\d+\./, 'Facebook profile picture'],
  [/^ig-og-image\./, 'Instagram share image'],
  [/^favicon-original\./, 'favicon, original'],
  [/^favicon\./, 'favicon'],
  [/^wizard-attachment\./, 'onboarding wizard upload'],
  [/^00-site-panel/, 'site header panel'],
];

// ---------------------------------------------------------------------------------------------
// logo at 3x (what prints): a crop of the exact final upload at 3x native, nearest neighbour, on the
// card primary, plus the effective-resolution line (source px, upscale factor, edge-quality verdict).
// Skyboxx 2026-09-21: the canvas showed the card at 126x56 and hid the stair-steps that printed.
// ---------------------------------------------------------------------------------------------
const LQG_CLI = path.join(SCRIPT_DIR, 'logo-quality-gates.ts');
const SOURCES_CLI = path.join(SCRIPT_DIR, 'logo-sources.ts');
function runTs(cli, argv) {
  const r = spawnSync('node', ['--experimental-strip-types', cli, ...argv], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = (r.stdout || '').trim();
  try { return { ok: r.status === 0 || out.startsWith('{'), json: out ? JSON.parse(out) : null, err: (r.stderr || '').replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?(\(Use[^\n]*\n?)?/g, '').trim() }; }
  catch { return { ok: false, json: null, err: (r.stderr || out).slice(0, 300) }; }
}
export async function logoZoom3x({ runDir, logoFile, primary, outFile, run }) {
  if (!logoFile || !existsSync(logoFile)) return null;
  const meta = await sharp(logoFile).metadata();
  const { data, info } = await sharp(logoFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    if (data[(y * info.width + x) * 4 + 3] > 0) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
  }
  if (right < 0) return null;
  // the crop starts where the ink starts (the wordmark's first letters) and is vertically centred on the ink
  const cropW = Math.min(right - left + 1, 420);
  const cropH = Math.min(bottom - top + 1, 220);
  const cropTop = Math.max(0, Math.min(info.height - cropH, Math.round((top + bottom) / 2 - cropH / 2)));
  const zoom = await sharp(logoFile).extract({ left, top: cropTop, width: cropW, height: cropH }).resize(cropW * 3, cropH * 3, { kernel: 'nearest' }).png().toBuffer();
  const bg = primary && /^#[0-9a-f]{6}$/i.test(primary) ? primary : '#8C8C8C';
  await sharp({ create: { width: cropW * 3, height: cropH * 3, channels: 4, background: bg } }).composite([{ input: zoom }]).png().toFile(outFile);
  // effective resolution: the run's recorded edge-quality result for this file, else a fresh measurement
  const rel = path.relative(runDir, logoFile);
  const recorded = (run?.gates?.results ?? []).find((g) => g.gate === 'edge-quality' && g.asset === rel);
  let source = { source_native_longest_px: recorded?.inputs?.source_native_px ?? null, derivation: recorded?.inputs?.derivation ?? null, note: recorded?.inputs?.source_note ?? null };
  if (source.source_native_longest_px == null) {
    const inf = runTs(SOURCES_CLI, ['infer', '--run', runDir, '--logo', logoFile]);
    if (inf.json) source = { source_native_longest_px: inf.json.source_native_longest_px, derivation: inf.json.derivation === 'unknown' ? null : inf.json.derivation, note: inf.json.note ? `${inf.json.note}${inf.json.inferred ? ' (inferred)' : ''}` : null };
  }
  const eq = recorded?.result?.verdict ? recorded.result : runTs(LQG_CLI, ['edge-quality', '--logo', logoFile, ...(source.source_native_longest_px ? ['--source-native-px', String(source.source_native_longest_px)] : []), ...(source.derivation ? ['--derivation', source.derivation] : [])]).json;
  const srcText = source.source_native_longest_px ? `source ${source.source_native_longest_px}px${source.derivation ? ` (${source.derivation})` : ''}${source.note ? `, ${source.note}` : ''}` : 'source size unknown (no ladder recorded)';
  const up = eq?.upscale_factor ? `, upscale ${eq.upscale_factor}x` : '';
  const verdict = eq ? `${eq.verdict}${eq.verdict === 'ok' ? '' : ` (${(eq.reasons ?? []).join(' ')})`}` : 'not measured';
  const line = `Final upload ${meta.width}x${meta.height}px, ${srcText}${up}. Edge quality: ${verdict}. Soft-edge share ${eq?.soft_edge_share ?? '?'}, stair-step score ${eq?.stair_step_score ?? '?'}.`;
  return { file: outFile, crop: { left, top: cropTop, width: cropW, height: cropH }, line, edge_quality: eq ? { verdict: eq.verdict, pass: eq.pass, soft_edge_share: eq.soft_edge_share, stair_step_score: eq.stair_step_score, source_native_longest_px: eq.source_native_longest_px, upscale_factor: eq.upscale_factor } : null, logo: rel };
}

// ---------------------------------------------------------------------------------------------
// gate summary
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Previews: signage previews and AI mockups written next to the canvas (2026-09-21).
//   review/signage-preview-<L>.json                scripts/signage-preview.mjs (drawn by the browser from the
//                                                  template; preferred since 2026-10-13)
//   review/signage-preview-<L>.png                 legacy harness/mockups/_signage-shot.mjs shot, or the
//                                                  signage-preview.mjs --png raster (shown only without a json)
//   review/mockups/<scene>-<L>[-suffix].png        harness/mockups/ai-mockup.mjs (+ prompts.md)
// ---------------------------------------------------------------------------------------------
/** Pure: read scene and letter from a preview file name; null when it is not one. Tolerates suffixes (box-K-red.png). */
export function parsePreviewName(basename) {
  const m = /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*?)-([A-Za-z]{1,2})(?:-([A-Za-z0-9][\w.-]*))?\.png$/.exec(basename); // letter may be two chars (AA..AZ sheet cells, 2026-10-12)
  if (!m) return null;
  const [, scene, letterRaw, suffix] = m;
  const letter = letterRaw.toUpperCase();
  if (scene === 'signage-preview') return { kind: 'signage', scene: 'signage preview', letter, suffix: suffix ?? null, name: basename.replace(/\.png$/i, '') };
  if (/^(signage|compare|default|variant|logo|google|website|blue|new)/.test(scene)) return null; // other review/ files
  return { kind: 'mockup', scene, letter, suffix: suffix ?? null, name: basename.replace(/\.png$/i, '') };
}

/**
 * Pure: verdict/drift lines from review/mockups/prompts.md, keyed by file name without extension
 * (lower case). Two shapes are read loosely: markdown table rows whose first cell is the file name
 * (the last non-empty cell is the verdict) and "## <name> (...)" headings followed by
 * "- verdict: ..." or "- drift: ..." bullets. The ai-mockup placeholder "(fill in ...)" never
 * overrides a real line and is flagged `placeholder`.
 */
export function parsePromptsVerdicts(md) {
  const out = new Map();
  const put = (name, text) => {
    const key = String(name).replace(/\.png$/i, '').toLowerCase();
    const value = String(text ?? '').trim();
    if (!value) return;
    const placeholder = /^\(?fill in\b/i.test(value);
    const prior = out.get(key);
    if (prior && !prior.placeholder && placeholder) return;
    out.set(key, { verdict: value, placeholder });
  };
  let current = null;
  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{2,4}\s+([\w.-]+?)(?:\.png)?\s*(?:\(|$)/.exec(line);
    if (heading) { current = /^(prompt|batch|harness|box prompt|scan prompt|table prompt)/i.test(heading[1]) ? null : heading[1]; continue; }
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 2 || cells.every((c) => /^:?-{2,}:?$/.test(c)) || /^output$/i.test(cells[0])) continue;
      if (!/\.png$/i.test(cells[0])) continue;
      const verdict = [...cells].reverse().find((c) => c);
      if (verdict && verdict !== cells[0]) put(cells[0], verdict);
      continue;
    }
    const bullet = /^[-*]\s*(verdict|drift|notes?)\s*:\s*(.+)$/i.exec(line);
    if (bullet && current) put(current, bullet[2]);
  }
  return out;
}

/** Files under review/ grouped by letter: { K: { signage: png|null, signage_spec: { file, spec }|null, mockups: [{ file, scene, suffix, name }] } }. */
export async function collectPreviews(reviewDir) {
  const letters = {};
  const at = (letter) => (letters[letter] ??= { signage: null, signage_spec: null, mockups: [] });
  const list = async (dir, ext = /\.png$/i) => { try { return (await fs.readdir(dir)).filter((f) => ext.test(f)).sort(); } catch { return []; } };
  for (const f of await list(reviewDir)) {
    const p = parsePreviewName(f);
    if (p?.kind === 'signage') at(p.letter).signage = path.join(reviewDir, f);
  }
  for (const f of await list(reviewDir, /^signage-preview-[A-Za-z]{1,2}\.json$/)) {
    const letter = /^signage-preview-([A-Za-z]{1,2})\.json$/.exec(f)[1].toUpperCase();
    try { at(letter).signage_spec = { file: path.join(reviewDir, f), spec: JSON.parse(await fs.readFile(path.join(reviewDir, f), 'utf8')) }; } catch { /* a broken spec falls back to the png */ }
  }
  const mockupDir = path.join(reviewDir, 'mockups');
  for (const f of await list(mockupDir)) {
    const p = parsePreviewName(f);
    if (p?.kind === 'mockup') at(p.letter).mockups.push({ file: path.join(mockupDir, f), scene: p.scene, suffix: p.suffix, name: p.name });
  }
  for (const l of Object.keys(letters)) letters[l].mockups.sort((a, b) => a.scene.localeCompare(b.scene) || (a.suffix ?? '').localeCompare(b.suffix ?? ''));
  const promptsFile = path.join(mockupDir, 'prompts.md');
  const verdicts = existsSync(promptsFile) ? parsePromptsVerdicts(await fs.readFile(promptsFile, 'utf8')) : new Map();
  return { letters, promptsFile: existsSync(promptsFile) ? promptsFile : null, verdicts };
}

/** Pure: pick status words for a letter from the sheet manifest and run.json. */
export function pickStatus(letter, sheet, run) {
  const cell = sheet?.cells?.[letter];
  const marks = (sheet?.marks ?? []).filter((m) => m.letter === letter && (m.status === 'travisse_pick' || m.status === 'fable_pick'));
  const status = cell?.status && cell.status !== 'none' ? cell.status : marks[marks.length - 1]?.status ?? null;
  const words = [];
  if (status === 'travisse_pick') words.push('TRAVISSE PICK');
  else if (status === 'fable_pick' || (!status && (sheet?.fable_default_letter ?? run?.variants?.fable_default_letter) === letter)) words.push('FABLE PICK');
  else if (status === 'rejected') words.push('rejected');
  if ((sheet?.applied_letter ?? run?.variants?.applied_letter) === letter) words.push('applied');
  return words;
}

/** The Previews section (shared by PNG and HTML), or null when no preview file exists. */
export function previewsSection({ runDir, reviewDir, previews, sheet, run, provenanceWords }) {
  const letters = Object.keys(previews.letters).sort();
  const links = previews.promptsFile ? [{ label: 'Mockup prompts and verdicts (prompts.md)', url: path.relative(reviewDir ?? path.dirname(path.dirname(previews.promptsFile)), previews.promptsFile) }] : [];
  // Previews are a post-pick step (closeout-location renders them for the chosen letter): no files, no section.
  if (!letters.length) return null;
  const parts = [];
  for (const letter of letters) {
    const group = previews.letters[letter];
    const cell = sheet?.cells?.[letter];
    const hexes = cell ? `card ${cell.primary} on ${cell.secondary}, text ${cell.text}${cell.secondary_source && provenanceWords ? ` (band ${provenanceWords(cell.secondary_source, cell.secondary_label)})` : ''}` : 'cell not on the sheet';
    const status = pickStatus(letter, sheet, run);
    const counts = `${group.signage_spec || group.signage ? 'signage preview' : 'no signage preview'}, ${group.mockups.length} AI mockup${group.mockups.length === 1 ? '' : 's'}`;
    const rowLabel = cell?.row_label ? String(cell.row_label).slice(0, 110) + (cell.row_label.length > 110 ? '...' : '') : null;
    parts.push({ type: 'text', items: [
      { text: `Cell ${letter}${status.length ? `  ${status.join(', ')}` : ''}`, size: 28, bold: true, color: status.includes('TRAVISSE PICK') ? '#B7791F' : status.includes('FABLE PICK') ? GREEN : '#111111', gap: 14 },
      { text: `${rowLabel ? `${rowLabel}. ` : ''}${hexes}. ${counts}.`, size: 18, color: '#444444', gap: 4 },
    ], gapAfter: 6 });
    // The JSON spec is drawn by the browser from the template; a legacy png (or a --png raster) is shown only when no spec exists.
    if (group.signage_spec) parts.push({ type: 'signage', letter, spec: group.signage_spec.spec, file: group.signage, caption: `${rel(runDir, group.signage_spec.file)}: signage preview drawn from the template (POP sign, tap card, table sticker, bathroom sticker); card ${group.signage_spec.spec.primary}, accent ${group.signage_spec.spec.accent}.` });
    else if (group.signage) parts.push({ type: 'image', file: group.signage, native: true, maxH: 900, alt: `signage preview ${letter}`, caption: `${rel(runDir, group.signage)}: signage preview (POP, sticker, card, to-go), click to open.` });
    if (group.mockups.length) {
      parts.push({ type: 'grid', cols: 4, cellH: 300, labelH: 96, labelSize: 15, bg: GRAY_BG, items: group.mockups.map((m) => {
        const v = previews.verdicts.get(m.name.toLowerCase());
        const verdict = v ? (v.placeholder ? 'verdict not filled in yet (prompts.md)' : v.verdict) : (previews.promptsFile ? 'no verdict line in prompts.md' : 'no prompts.md');
        return { file: m.file, label: `${m.scene} (AI)${m.suffix ? ` · ${m.suffix}` : ''}  ${path.basename(m.file)}\n${verdict}`, bg: GRAY_BG, bold: false, labelColor: v && !v.placeholder && /invent|drift|repaint|fake|wrong|missing|fail/i.test(v.verdict) ? '#8A1C1C' : '#222222' };
      }) });
    }
  }
  return { id: 'previews', title: 'Previews', subtitle: 'signage preview and AI mockups per letter; previews, not proofs (QR drift, invented phone content). Click any image to open the native file.', links, sizeGated: true, parts };
}

// ---------------------------------------------------------------------------------------------
// Links: the link automation results folded into the same review doc (2026-09-21). Sources, all
// optional: run.json `links` (website bootstrap, existing, ordering match, candidates, execution),
// the discovery report's category_results (run dir or links-port/, newest by checked_at), and the
// links-port/ artifacts (browser-needed*.json pending URLs, validate-pass*.json).
// ---------------------------------------------------------------------------------------------
export const LINK_CATEGORY_WORDS = {
  website: 'Website', ordering: 'Online ordering', order: 'Online ordering', menu: 'Menu', facebook: 'Facebook', instagram: 'Instagram',
  x_twitter: 'X (Twitter)', tiktok: 'TikTok', youtube: 'YouTube', careers_jobs: 'Careers', catering: 'Catering', events: 'Events',
  reservations: 'Reservations', gift_cards: 'Gift cards', loyalty_rewards: 'Loyalty / rewards', ios_app: 'iOS app', android_app: 'Android app',
  app_downloads: 'App downloads', other_custom: 'Other', socials: 'Socials',
};
const LINK_CATEGORY_ORDER = ['website', 'ordering', 'menu', 'facebook', 'instagram', 'x_twitter', 'tiktok', 'youtube', 'careers_jobs', 'catering', 'events', 'reservations', 'gift_cards', 'loyalty_rewards', 'ios_app', 'android_app', 'app_downloads', 'other_custom'];
const canonCategory = (c) => (c === 'order' ? 'ordering' : String(c ?? '').toLowerCase());
export const LINK_STATUS_STYLE = {
  written: { chip: '#1B5E20', words: 'written' }, live: { chip: '#1B5E20', words: 'verified live' }, existing: { chip: '#1B5E20', words: 'already live' },
  ready: { chip: '#1B5E20', words: 'verified, ready to write' }, held: { chip: '#B7791F', words: 'held for review' },
  pending: { chip: '#6B6B6B', words: 'pending browser' }, rejected: { chip: '#6B6B6B', words: 'rejected' }, none: { chip: '#6B6B6B', words: 'none found' },
};

/** Pure: one evidence phrase per known evidence key, in plain words; unknown keys are humanized. */
export function evidenceWords(link) {
  if (!link) return [];
  const out = [];
  const page = link.page_evidence ?? {};
  const title = page.title || null;
  const h1 = Array.isArray(page.h1) && page.h1.length ? page.h1[0] : null;
  if (title && !/just a moment/i.test(title)) out.push(`title "${String(title).slice(0, 70)}"`);
  else if (h1) out.push(`H1 "${String(h1).slice(0, 60)}"`);
  const seen = new Set();
  for (const raw of [...(link.location_match_evidence ?? []), ...(link.validity_evidence ?? []), ...(link.source_evidence ?? [])]) {
    const [key, value] = String(raw).split('=');
    let words = null;
    if (key === 'official_website_links_to_candidate' && value === 'true') words = 'the website links to it';
    else if (key === 'url_slug_or_provider_domain_matches_location' && value === 'true') words = 'URL slug names the business';
    else if (/^(title|h1|page_title|og_title)_(matches|contains)/.test(key) && value !== 'false') words = 'title matches the business';
    else if (/^(address|city|geo|zip|phone)_/.test(key) && value !== 'false') words = `${key.split('_')[0]} on the page matches`;
    else if (key === 'security_or_bot_challenge_detected' && value === 'true') words = 'bot challenge blocked the automated check';
    else if (key === 'platform_unavailable_page_detected' && value === 'true') words = 'platform says the page is unavailable';
    else if (key === 'http_status' && value && !/^2/.test(value)) words = `HTTP ${value}`;
    else if (key === 'link_source' && value) words = `found as ${/^[aeiou]/i.test(value) ? 'an' : 'a'} ${value.replace(/[-_]/g, ' ')}`;
    else if (key === 'canonicalized_candidate_from' && value) words = `canonical form of ${value}`;
    else if (['final_url', 'title', 'challenge_signal', 'anchor_or_url'].includes(key)) words = null;
    else if (value === 'true') words = key.replace(/_/g, ' ');
    if (words && !seen.has(words)) { seen.add(words); out.push(words); }
  }
  if (link.liveness && link.liveness !== 'live' && link.liveness !== 'unknown' && !seen.has(link.liveness)) out.push(`page ${link.liveness}`);
  if (link.rejection_reason && !out.some((w) => /challenge|unavailable/.test(w))) {
    const reason = String(link.rejection_reason).replace(/\.$/, '');
    const m = /^claude_chrome_result_missing:\s*(\S+)/.exec(reason);
    out.push(m ? `no live Chrome result yet for ${m[1]}` : reason);
  }
  return out;
}

const executionCategory = (op) => {
  if (!op) return null;
  if (op.category) return canonCategory(op.category);
  if (op.field === 'website_url') return 'website';
  if (op.field === 'ordering_url') return 'ordering';
  for (const k of ['facebook', 'instagram', 'tiktok', 'youtube']) if (`${k}_url` in op) return k;
  if ('x_url' in op) return 'x_twitter';
  if ('apple_app_url' in op) return 'ios_app';
  if ('google_app_url' in op) return 'android_app';
  return null;
};
const executionUrl = (op) => op?.url ?? op?.value ?? Object.entries(op ?? {}).find(([k, v]) => /_url$/.test(k) && typeof v === 'string')?.[1] ?? null;

/**
 * Pure: the approved website swap recorded on links.website_bootstrap, or null. `url` is what the page
 * shows as the website; `note` says what it replaces ("replaces stored www.example.com/ (approved)").
 */
export function approvedWebsiteSwap(wb) {
  const url = wb?.approved_website_url;
  if (!url || !/^https?:\/\//.test(String(url))) return null;
  const stored = wb.stored_website_url ?? wb.places_website_uri ?? wb.url ?? null;
  const bare = stored ? String(stored).replace(/^https?:\/\//, '') : null;
  return { url: String(url), stored, note: bare ? `replaces stored ${bare} (approved)` : 'approved website' };
}

/**
 * Pure: one row per category from the run.json links block, the report's category_results, and the
 * pending browser URLs. Row: { category, label, url, status: { kind, words }, reason, evidence, source }.
 */
export function buildLinkRows({ links = {}, categoryResults = [], pendingUrls = [] } = {}) {
  const rows = new Map();
  const at = (c) => { const key = canonCategory(c); if (!rows.has(key)) rows.set(key, { category: key, label: LINK_CATEGORY_WORDS[key] ?? key.replace(/_/g, ' '), url: null, status: null, reason: null, evidence: [], source: null }); return rows.get(key); };
  const pending = new Set(pendingUrls.map((u) => String(u).replace(/\/$/, '')));
  const isPending = (u) => u && pending.has(String(u).replace(/\/$/, ''));
  // 1. report category_results: candidate, status, evidence
  for (const cr of categoryResults) {
    const row = at(cr.category);
    const link = cr.selected_link ?? cr.existing_link ?? null;
    const url = link?.final_url ?? link?.input_url ?? null;
    if (url && !row.url) row.url = url;
    row.reportUrl = url;
    row.evidence = evidenceWords(link);
    const st = String(cr.category_status ?? '');
    if (cr.proposed_action === 'create' || cr.proposed_action === 'update') row.status = 'ready';
    else if (/existing_verified|existing_kept/.test(st)) row.status = 'existing';
    else if (/found_verified/.test(st)) row.status = 'live';
    else if (/needs_manual_review|blocked/.test(st)) { row.status = 'held'; row.reason = link?.rejection_reason ?? st.replace(/_/g, ' '); }
    else if (/rejected|broken/.test(st)) { row.status = 'rejected'; row.reason = link?.rejection_reason ?? st.replace(/_/g, ' '); }
    else if (/not_found/.test(st) || !url) row.status = 'none';
    else row.status = 'held';
    row.source = 'discovery report';
  }
  // 2. run.json candidates: the fulfillment agent's decision wins over the report
  const norm = (u) => String(u ?? '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
  for (const c of links.candidates ?? []) {
    const row = at(c.category);
    row.decided = true;
    if (c.url) row.url = c.url;
    // report evidence describes a different URL than the one the agent chose: drop it rather than mislead
    if (row.reportUrl && norm(c.url) !== norm(row.reportUrl)) row.evidence = [];
    const action = String(c.action ?? '');
    const vs = String(c.verification_status ?? '');
    // a candidate carries its decision text as `reason` (2026-09-22) or the older `hold_reason`
    const why = c.reason ?? c.hold_reason ?? null;
    if (action === 'hold') { row.status = 'held'; row.reason = why; }
    // verified at review stage, written at closeout without another look (2026-09-23): not a hold
    else if (action === 'ready') { row.status = 'ready'; row.reason = why; }
    else if (action === 'preserve' || /existing_verified/.test(vs)) { row.status = 'existing'; row.reason = why; }
    else if (action === 'skip' || action === 'reject' || /broken|rejected/.test(vs)) { row.status = 'rejected'; row.reason = c.reason_code ? `${String(c.reason_code).replace(/_/g, ' ')}${why ? `: ${why}` : ''}` : why; }
    else if (action === 'write' || action === 'apply') { row.status = /verified/.test(vs) ? 'live' : 'ready'; row.reason = why; }
    else if (!c.url || /no_candidate|not_found/.test(vs) || action === 'not_found') { row.status = 'none'; row.reason = why; row.url = null; row.evidence = []; }
    // the agent's own evidence lines replace the report's (the report may describe a stale hold)
    if (Array.isArray(c.evidence) && c.evidence.length) row.evidence = c.evidence.map(String);
    if (/verified/.test(vs) && !row.evidence.length) row.evidence.push(`${vs.replace(/_/g, ' ')}${c.fetch_method ? ` (${String(c.fetch_method).replace(/_/g, ' ')})` : ''}`);
    row.source = 'run.json candidates';
  }
  // 2b. run.json rejected: the fulfillment agent rejected a URL the report had marked found/verified
  // (2026-10-12, Creamer by Kay: dead Wix menu and careers pages showed as "ready"). A rejected entry
  // beats the report for the same category unless a candidate or execution record decided otherwise.
  for (const rj of links.rejected ?? []) {
    if (!rj?.category) continue;
    const row = at(rj.category);
    if (row.decided) continue;
    const same = !row.url || !rj.url || norm(rj.url) === norm(row.url);
    if (!same) continue;
    row.decided = true;
    row.url = rj.url ?? row.url;
    row.status = 'rejected';
    row.reason = rj.reason ?? rj.reason_code ?? 'rejected by the fulfillment agent';
    row.evidence = [];
    row.source = 'run.json rejected';
  }
  // 3. execution records: what was written or held
  for (const e of links.execution ?? []) {
    const cat = executionCategory(e.operation);
    if (!cat) continue;
    const row = at(cat);
    row.decided = true;
    const url = executionUrl(e.operation);
    if (url && !row.url) row.url = url;
    const outcome = String(e.outcome ?? '');
    if (/applied|written|created|updated|success/.test(outcome)) { row.status = 'written'; row.reason = e.reason ?? null; }
    // skipped_existing is a decided no-write (2026-10-19): a ready row already on the location, a rejected
    // candidate, or nothing found. Only held/blocked (and other skips) still need a human.
    else if (outcome === 'skipped_existing') {
      const action = String(e.operation?.action ?? '');
      row.status = action === 'reject' ? 'rejected' : action === 'none' ? 'none' : 'existing';
      row.reason = e.reason ?? row.reason;
    }
    else if (/held|skipped|blocked/.test(outcome)) { row.status = 'held'; row.reason = e.reason ?? row.reason; }
    row.source = 'execution';
  }
  for (const w of links.writes_performed ?? []) {
    const cat = executionCategory(w.operation ?? w);
    if (!cat) continue;
    const row = at(cat);
    row.status = 'written'; row.url = row.url ?? executionUrl(w.operation ?? w); row.reason = w.reason ?? row.reason;
  }
  for (const c of links.not_found ?? []) { const row = at(c); if (!row.status) row.status = 'none'; }
  // 4. website bootstrap and the stored ordering url
  const wb = links.website_bootstrap;
  if (wb && (wb.places_website_uri || wb.url || wb.approved_website_url)) {
    const row = at('website');
    row.url = row.url ?? wb.places_website_uri ?? wb.url;
    if (/applied|written/.test(String(wb.status))) row.status = 'written';
    else if (String(wb.status) === 'held') { row.status = 'held'; row.reason = row.reason ?? (wb.apply ?? 'website bootstrap held'); }
    if (wb.resolves_to && !row.evidence.length) row.evidence.push(`Places website resolves to ${String(wb.resolves_to).split(' ')[0]}`);
    // Travisse approved a different website than the stored one (2026-10-12, Creamer by Kay: the stored
    // www host is dead): the page shows the approved URL everywhere and says what it replaces.
    const swap = approvedWebsiteSwap(wb);
    if (swap) {
      row.url = swap.url;
      row.decided = true;
      if (row.status !== 'written') { row.status = 'ready'; row.reason = wb.closeout_action ?? wb.approved_by ?? 'approved website swap'; }
      row.evidence = [swap.note];
    }
  }
  const om = links.ordering_url_match;
  if (om?.stored) {
    const row = at('ordering');
    row.url = row.url ?? om.stored;
    if (om.match === true) row.evidence.unshift('stored ordering URL matches the website');
    if (!row.status) row.status = 'existing';
  }
  // 5. pending browser checks apply only to rows the fulfillment agent has not decided on
  for (const row of rows.values()) {
    if (!row.decided && row.status !== 'written' && row.status !== 'existing' && isPending(row.url)) { row.status = 'pending'; row.reason = row.reason ?? 'waiting on the live Chrome check'; }
    if (!row.status) row.status = row.url ? 'held' : 'none';
    row.reason = row.reason ? String(row.reason).replace(/\s+/g, ' ').trim() : null;
  }
  const order = (c) => { const i = LINK_CATEGORY_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  // Rejected rows say why on the grey chip itself ("rejected: identity mismatch ..."); they are never
  // counted as held (2026-09-22). The full reason stays in `reason` for the detail line when clipped.
  const chipFor = (r) => {
    const style = { kind: r.status, ...LINK_STATUS_STYLE[r.status] };
    if (r.status === 'rejected' && r.reason) {
      const short = r.reason.length > 72 ? `${r.reason.slice(0, 69).trimEnd()}...` : r.reason;
      return { ...style, words: `rejected: ${short}` };
    }
    return style;
  };
  return [...rows.values()].sort((a, b) => order(a.category) - order(b.category) || a.category.localeCompare(b.category)).map(({ reportUrl, decided, ...r }) => ({ ...r, url: urlText(r.url), status: chipFor(r), verdict: linkVerdict(r) }));
}

/** A link row's URL as text. Run files sometimes carry an object or a list there (2026-09-29, crunchicken-2). */
function urlText(u) {
  if (u == null || u === '') return null;
  if (typeof u === 'string') return u;
  if (Array.isArray(u)) return urlText(u.find((x) => urlText(x)));
  if (typeof u === 'object') return urlText(u.url ?? u.value ?? u.href ?? null);
  return String(u);
}

/** Discovery report and links-port artifacts for a run (all optional). */
export async function collectLinkSources(runDir, run) {
  const links = run.links ?? {};
  const reports = [];
  const addReport = async (file) => {
    if (!file || !existsSync(file) || reports.some((r) => r.file === file)) return;
    const j = await readJson(file);
    if (j && Array.isArray(j.category_results)) reports.push({ file, checked_at: j.checked_at ?? null, report: j });
  };
  const named = typeof links.discovery_report === 'string' ? links.discovery_report.match(/[\w.-]+\.json/)?.[0] : null;
  if (named) await addReport(path.join(runDir, named));
  const portDir = path.join(runDir, 'links-port');
  const inDir = async (dir, re) => { try { return (await fs.readdir(dir)).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; } };
  for (const f of [...await inDir(runDir, /^link-discovery-report.*\.json$/), ...await inDir(portDir, /^link-discovery-report.*\.json$/)]) await addReport(f);
  reports.sort((a, b) => String(b.checked_at ?? '').localeCompare(String(a.checked_at ?? '')));
  const newest = reports[0] ?? null;
  const manifests = [];
  for (const f of await inDir(portDir, /^browser-needed.*\.json$/)) { const j = await readJson(f); if (j) manifests.push({ file: f, generated_at: j.generated_at ?? null, urls: (j.urls ?? []).map((u) => (typeof u === 'string' ? u : u.url)).filter(Boolean) }); }
  manifests.sort((a, b) => String(b.generated_at ?? '').localeCompare(String(a.generated_at ?? '')));
  const results = await readJson(path.join(portDir, 'browser-results.json'));
  const captured = new Set(Object.values(results?.results ?? {}).flatMap((r) => [r.url, r.final_url]).filter(Boolean).map((u) => u.replace(/\/$/, '')));
  const runtimePending = (newest?.report?.runtime?.browser_needed ?? []).map((u) => (typeof u === 'string' ? u : u.url)).filter(Boolean);
  const pendingUrls = [...new Set([...runtimePending, ...(manifests[0]?.urls ?? []).filter((u) => !captured.has(u.replace(/\/$/, '')))])];
  const validations = [];
  for (const f of await inDir(portDir, /^validate.*\.json$/)) { const j = await readJson(f); if (j) validations.push({ file: f, valid: j.valid ?? null, errors: j.errors ?? [] }); }
  return { links, report: newest, reports, manifests, pendingUrls, validations: validations.reverse(), portDir: existsSync(portDir) ? portDir : null };
}

/** The Links section (shared by PNG and HTML), or null when the run has no link data at all. */
export function linksSection({ runDir, sources }) {
  const { links, report, pendingUrls, validations, manifests } = sources;
  const rows = buildLinkRows({ links, categoryResults: report?.report?.category_results ?? [], pendingUrls });
  const hasData = rows.length || links.website_bootstrap || links.execution?.length || links.candidates?.length;
  if (!hasData) return null;
  const held = rows.filter((r) => r.status.kind === 'held').length;
  const written = rows.filter((r) => r.status.kind === 'written').length;
  const pending = rows.filter((r) => r.status.kind === 'pending').length;
  const summary = [];
  if (links.mode || links.written_by) summary.push({ text: `Run: ${[links.mode ? String(links.mode).replace(/_/g, ' ') : null, links.applied ? 'writes applied' : 'no link writes applied', links.written_by ? `by ${String(links.written_by).split(',')[0]}` : null].filter(Boolean).join('; ')}.`, size: 18, color: '#444444' });
  const wb = links.website_bootstrap;
  const swap = approvedWebsiteSwap(wb);
  if (swap) summary.push({ text: `Website: ${swap.url} ${swap.note}; written at closeout.`, size: 18, color: '#444444', gap: 4 });
  else if (wb) summary.push({ text: `Website bootstrap: ${wb.status ?? 'unknown'}${wb.places_website_uri ? `, Places says ${wb.places_website_uri}` : ''}${wb.resolves_to ? ` (${String(wb.resolves_to).split(' (')[0]})` : ''}.`, size: 18, color: '#444444', gap: 4 });
  else if (links.existing?.website_url) summary.push({ text: `Website on file: ${links.existing.website_url}.`, size: 18, color: '#444444', gap: 4 });
  const om = links.ordering_url_match;
  if (om?.stored) summary.push({ text: `Ordering URL on file ${om.stored}: ${om.match === true ? 'matches the website' : om.match === false ? 'does not match the website' : 'not compared'}${om.note ? `. ${firstSentence(om.note, 160)}` : ''}`, size: 18, color: '#444444', gap: 4 });
  if (report) summary.push({ text: `Discovery report ${rel(runDir, report.file)}${report.checked_at ? ` (${report.checked_at.slice(0, 16).replace('T', ' ')})` : ''}${report.report.summary ? `: ${report.report.summary.categories_total ?? rows.length} categories, ${report.report.summary.manual_review_items ?? 0} for manual review, ${report.report.summary.proposed_location_updates ?? 0} proposed field updates, ${report.report.summary.proposed_touchpoint_events ?? 0} proposed events` : ''}.`, size: 18, color: '#444444', gap: 4 });
  if (pendingUrls.length) summary.push({ text: `${pendingUrls.length} URL${pendingUrls.length === 1 ? '' : 's'} still waiting on the live Chrome check${manifests[0] ? ` (${rel(runDir, manifests[0].file)})` : ''}.`, size: 18, color: '#6B6B6B', gap: 4 });
  const v = validations[0];
  if (v) summary.push({ text: `Validator ${rel(runDir, v.file)}: ${v.valid ? 'valid' : `not valid (${(v.errors ?? []).map((e) => String(e).replace(/_/g, ' ')).join('; ') || 'no reason given'})`}.`, size: 18, color: v.valid ? GREEN : '#B7791F', gap: 4 });
  summary.push({ text: `${rows.length} categories: ${written} written, ${rows.filter((r) => r.status.kind === 'live' || r.status.kind === 'existing' || r.status.kind === 'ready').length} verified or already live, ${held} held for review, ${pending} pending browser, ${rows.filter((r) => r.status.kind === 'rejected').length} rejected, ${rows.filter((r) => r.status.kind === 'none').length} none found.`, size: 18, bold: true, gap: 8 });
  const sectionLinks = [
    report ? { label: 'Discovery report', url: rel(reviewDirOf(runDir), report.file) } : null,
    manifests[0] ? { label: 'Browser manifest', url: rel(reviewDirOf(runDir), manifests[0].file) } : null,
    v ? { label: 'Validator output', url: rel(reviewDirOf(runDir), v.file) } : null,
  ].filter(Boolean);
  return { id: 'links', title: 'Links', navLabel: `Links (${held} held for review)`, subtitle: 'the link automation results for this location, one row per category; held rows need a human decision. Click a URL to open it.', links: sectionLinks, parts: [
    { type: 'text', items: summary, gapAfter: 10 },
    { type: 'links', rows },
  ] };
}
const reviewDirOf = (runDir) => path.join(runDir, 'review');

function gateSummaryForRows(run, sheet, runDir) {
  const results = run?.gates?.results ?? [];
  const overrides = Array.isArray(run?.overrides) ? run.overrides : [];
  const out = [];
  for (const row of sheet?.rows ?? []) {
    const asset = rel(runDir, row.logo);
    const mine = results.filter((g) => (g.asset === asset || (row.logo_sha256 && g.asset_sha256 === row.logo_sha256)) && typeof g.pass === 'boolean');
    const overridden = new Set(overrides.filter((o) => rel(runDir, o.asset) === asset).map((o) => o.gate));
    if (!mine.length) { out.push({ row, text: `${row.label}: no gate results in run.json for ${asset}`, fails: [], blocking: false }); continue; }
    const fails = mine.filter((g) => !g.pass);
    const hard = fails.filter((g) => g.severity === 'block' && !overridden.has(g.gate));
    const parts = fails.map((g) => {
      const v = typeof g.verdict === 'string' && g.verdict ? g.verdict : (g.result?.verdict ?? g.result?.note ?? 'failed');
      const why = String(v).replace(/\s+/g, ' ').slice(0, 70);
      const tag = overridden.has(g.gate) ? 'overridden' : g.severity === 'warn' ? 'warning' : g.override_allowed ? 'blocks, can be overridden' : 'blocks';
      return `${g.gate} (${tag}): ${why}`;
    });
    const head = fails.length === 0
      ? `${row.label}: all ${mine.length} gates pass`
      : `${row.label}: ${mine.length - fails.length} of ${mine.length} gates pass${hard.length ? `, ${hard.length} blocking` : ', nothing blocking'}`;
    out.push({ row, text: head, fails: parts, asset, blocking: hard.length > 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Playwright captures (device scale = S so screenshots are sharp on the canvas)
// ---------------------------------------------------------------------------------------------
async function withBrowser(fn) {
  const { chromium } = require('playwright');
  let browser;
  try { browser = await chromium.launch({ headless: true, channel: 'chromium' }); }
  catch { browser = await chromium.launch({ headless: true }); }
  try { return await fn(browser); } finally { await browser.close().catch(() => {}); }
}

async function newPage(browser, { width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'en-US', deviceScaleFactor: S });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  return { ctx, page };
}

async function dismissConsent(page) {
  const labels = ['Accept all', 'Reject all', 'I agree', 'Agree', 'Accept', 'Got it', 'No thanks'];
  for (const l of labels) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(`^${l}$`, 'i') }).first();
      if (await btn.isVisible({ timeout: 700 })) { await btn.click({ timeout: 2000 }); await page.waitForTimeout(800); return l; }
    } catch { /* not present */ }
  }
  for (const frame of page.frames()) {
    for (const l of labels) {
      try {
        const btn = frame.getByRole('button', { name: new RegExp(`^${l}$`, 'i') }).first();
        if (await btn.isVisible({ timeout: 300 })) { await btn.click({ timeout: 2000 }); await page.waitForTimeout(800); return l; }
      } catch { /* not present */ }
    }
  }
  return null;
}

async function looksBlocked(page) {
  const url = page.url();
  if (/\/sorry\/|consent\.google|recaptcha/i.test(url)) return `blocked (${url.slice(0, 60)})`;
  try {
    const text = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 4000).toLowerCase();
    if (/unusual traffic|not a robot|automated queries|verify you are human|bots use duckduckgo|unexpected error\. please try again/.test(text)) return 'served a bot check';
  } catch { /* ignore */ }
  return null;
}

async function captureWebsite(browser, url, outFile) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2500);
    await dismissConsent(page);
    await page.screenshot({ path: outFile, fullPage: true });
    const meta = await sharp(outFile).metadata();
    const cap = 1800 * S;
    if (meta.height > cap) {
      await sharp(outFile).extract({ left: 0, top: 0, width: meta.width, height: cap }).toFile(`${outFile}.tmp.png`);
      await fs.rename(`${outFile}.tmp.png`, outFile);
    }
    return { ok: true, file: outFile, final_url: page.url() };
  } finally { await ctx.close(); }
}

async function captureMapsPhotos(browser, { placeId, name, city, outFile, budgetMs }) {
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  const targets = [
    placeId ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}&hl=en` : null,
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${city}`)}&hl=en`,
  ].filter(Boolean);
  const notes = [];
  for (let attempt = 0; attempt < 2 && left() > 12_000; attempt += 1) {
    const url = targets[Math.min(attempt, targets.length - 1)];
    const { ctx, page } = await newPage(browser);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(30_000, left()) });
      await page.waitForTimeout(2500);
      const consent = await dismissConsent(page);
      if (consent) notes.push(`consent dismissed (${consent})`);
      const blocked = await looksBlocked(page);
      if (blocked) { notes.push(`attempt ${attempt + 1}: ${blocked}`); continue; }
      try {
        const first = page.locator('a[href*="/maps/place/"]').first();
        if (!/\/maps\/place\//.test(page.url()) && await first.isVisible({ timeout: 2000 })) { await first.click(); await page.waitForTimeout(2500); }
      } catch { /* ignore */ }
      let opened = null;
      const openers = [
        () => page.locator('button[aria-label^="Photo of"], button[aria-label^="Photos of"]').first(),
        () => page.getByRole('button', { name: /see photos|all photos|photos/i }).first(),
        () => page.getByRole('tab', { name: /photos/i }).first(),
      ];
      for (const get of openers) {
        try {
          const el = get();
          if (await el.isVisible({ timeout: 2500 })) { await el.click({ timeout: 3000 }); opened = await el.getAttribute('aria-label').catch(() => null) || 'photos'; break; }
        } catch { /* try next */ }
      }
      await page.waitForTimeout(3000);
      let vibe = false;
      try {
        const tab = page.getByRole('button', { name: /^vibe$/i }).or(page.getByRole('tab', { name: /^vibe$/i })).or(page.getByText(/^Vibe$/)).first();
        if (await tab.isVisible({ timeout: 2500 })) { await tab.click({ timeout: 3000 }); vibe = true; await page.waitForTimeout(3000); }
      } catch { /* no vibe tab */ }
      await page.screenshot({ path: outFile, fullPage: false });
      notes.push(`attempt ${attempt + 1}: ${opened ? `opened ${opened}` : 'photo view not found, place page captured'}${vibe ? ', Vibe tab' : ''}`);
      return { ok: true, file: outFile, opened: Boolean(opened), vibe, notes, url: page.url() };
    } catch (err) {
      notes.push(`attempt ${attempt + 1}: ${String(err.message).split('\n')[0].slice(0, 120)}`);
    } finally { await ctx.close().catch(() => {}); }
  }
  return { ok: false, notes };
}

async function captureLogoSearch(browser, { query, outFile }) {
  const notes = [];
  const engines = [
    { name: 'Google Images', url: `https://www.google.com/search?tbm=isch&hl=en&q=${encodeURIComponent(query)}`, results: 'img', min: 8 },
    { name: 'Bing Images', url: `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, results: '.iusc img, .mimg, img.mimg', min: 6 },
    { name: 'DuckDuckGo Images', url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, results: 'img[src*="external-content"], .tile--img__img', min: 4 },
  ];
  for (const engine of engines) {
    const { ctx, page } = await newPage(browser);
    try {
      await page.goto(engine.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
      const consent = await dismissConsent(page);
      if (consent) notes.push(`${engine.name}: consent dismissed (${consent})`);
      const blocked = await looksBlocked(page);
      if (blocked) { notes.push(`${engine.name}: ${blocked}`); continue; }
      const imgs = await page.locator(engine.results).count();
      if (imgs < engine.min) { notes.push(`${engine.name}: only ${imgs} result images rendered`); continue; }
      await page.waitForTimeout(1500);
      await page.screenshot({ path: outFile, fullPage: false });
      return { ok: true, file: outFile, source: engine.name, notes };
    } catch (err) {
      notes.push(`${engine.name}: ${String(err.message).split('\n')[0].slice(0, 120)}`);
    } finally { await ctx.close().catch(() => {}); }
  }
  return { ok: false, notes };
}

// ---------------------------------------------------------------------------------------------
// Google Images through the user's live Chrome session (the only path Google does not block).
// Own AppleScript rather than chrome-live.sh open-profile: Google rewrites the URL on load, so the
// helper's exact-URL tab match races; we match the tab on stable tokens and drive that exact tab.
// ---------------------------------------------------------------------------------------------
const CHROME_LIVE = process.env.REVIEW_CANVAS_CHROME_LIVE
  ?? path.join(process.env.HOME ?? '', '.claude', 'skills', 'chrome-live-session-preferences', 'scripts', 'chrome-live.sh');
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function osascript(script, argv = [], timeoutMs = 15_000) {
  const r = spawnSync('osascript', ['-', ...argv], { encoding: 'utf8', input: script, timeout: timeoutMs });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), timedOut: r.error?.code === 'ETIMEDOUT' };
}

function resolveChromeProfileDir(key) {
  if (!existsSync(CHROME_LIVE)) return null;
  const r = spawnSync('/bin/zsh', [CHROME_LIVE, 'list-profiles'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const line of (r.stdout ?? '').split('\n')) {
    const [k, dir] = line.split('\t');
    if (k === key && dir) return dir;
  }
  return null;
}

const FIND_TAB = `on run argv
  set tokA to item 1 of argv
  set tokB to item 2 of argv
  tell application "Google Chrome"
    repeat with w from 1 to count of windows
      set tabIndex to 0
      repeat with t in tabs of window w
        set tabIndex to tabIndex + 1
        set u to (URL of t as text)
        if u contains "logo" and u contains tokA and u contains tokB and (u contains "tbm=isch" or u contains "udm=2") then return (w as text) & "," & (tabIndex as text)
      end repeat
    end repeat
  end tell
  return ""
end run`;
const EXEC_TAB = `on run argv
  set js to item 1 of argv
  set w to (item 2 of argv) as integer
  set t to (item 3 of argv) as integer
  tell application "Google Chrome" to return execute (tab t of window w) javascript js
end run`;
const CLOSE_TAB = `on run argv
  set w to (item 2 of argv) as integer
  set t to (item 3 of argv) as integer
  tell application "Google Chrome" to close (tab t of window w)
end run`;

async function liveGoogleImages({ query, name, city, profile, outDir }) {
  const notes = [];
  const profileDir = resolveChromeProfileDir(profile);
  if (!profileDir) return { ok: false, notes: [`live Chrome: profile "${profile}" unknown or helper missing`] };
  if (!existsSync(CHROME_BIN)) return { ok: false, notes: ['live Chrome: Google Chrome not installed'] };
  const words = (t) => String(t ?? '').split(/[^A-Za-z]+/).filter((w) => w.length >= 3);
  const tokA = words(name).sort((a, b) => b.length - a.length)[0] ?? 'logo';
  const tokB = words(city)[0] ?? 'logo';
  const url = `https://www.google.com/search?tbm=isch&hl=en&q=${encodeURIComponent(query)}`;
  const launch = spawnSync(CHROME_BIN, [`--profile-directory=${profileDir}`, url], { stdio: 'ignore', timeout: 10_000 });
  if (launch.error && launch.error.code !== 'ETIMEDOUT') return { ok: false, notes: [`live Chrome: launch failed (${launch.error.code})`] };
  let tab = null;
  for (let i = 0; i < 12 && !tab; i += 1) {
    await new Promise((res) => setTimeout(res, 1000));
    const r = osascript(FIND_TAB, [tokA, tokB]);
    if (r.status === 0 && /^\d+,\d+$/.test(r.stdout)) tab = r.stdout.split(',');
  }
  if (!tab) return { ok: false, notes: ['live Chrome: the Google Images tab never appeared (Accessibility / Apple Events permission?)'] };
  const js = `(() => {
    const blocked = /unusual traffic|not a robot|automated queries/i.test(document.body.innerText || '');
    const imgs = [...document.querySelectorAll('img')].filter((i) => (i.currentSrc || i.src || '').includes('encrypted-tbn') && i.naturalWidth >= 80);
    const pageOf = (i) => {
      const box = i.closest('[data-lpage]');
      if (box?.dataset.lpage) return box.dataset.lpage;
      const a = i.closest('a');
      const ref = a?.href ? new URL(a.href, location.href).searchParams.get('imgrefurl') : null;
      if (ref) return ref;
      const cell = i.closest('[data-ri], [data-docid], [jsname]');
      const link = cell ? [...cell.querySelectorAll('a[href^="http"]')].find((x) => !/google\./.test(new URL(x.href).hostname)) : null;
      return link ? link.href : null;
    };
    return JSON.stringify({ blocked, href: location.href, results: imgs.slice(0, 24).map((i) => ({ src: i.currentSrc || i.src, alt: (i.alt || '').slice(0, 120), w: i.naturalWidth, h: i.naturalHeight, page: pageOf(i) })) });
  })();`;
  let data = null;
  for (let i = 0; i < 8; i += 1) {
    const r = osascript(EXEC_TAB, [js, tab[0], tab[1]]);
    if (r.status === 0) {
      try { data = JSON.parse(r.stdout); } catch { data = null; }
      if (data?.blocked || (data?.results?.length ?? 0) >= 8) break;
    } else if (i === 0) notes.push(`live Chrome exec: ${r.stderr.split('\n')[0].slice(0, 120)} (View > Developer > Allow JavaScript from Apple Events?)`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  osascript(CLOSE_TAB, ['', tab[0], tab[1]]);
  if (!data) return { ok: false, notes: [...notes, 'live Chrome: could not read the results page'] };
  if (data.blocked) return { ok: false, notes: [...notes, 'live Chrome: Google served its bot check'] };
  if ((data.results?.length ?? 0) < 4) return { ok: false, notes: [...notes, `live Chrome: only ${data.results?.length ?? 0} result thumbnails`] };
  await fs.mkdir(outDir, { recursive: true });
  const saved = [];
  for (const [i, r] of data.results.entries()) {
    try {
      const res = await fetch(r.src, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}.jpg`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      saved.push({ file, alt: r.alt, src: r.src, w: r.w, h: r.h, page: r.page && /^https?:\/\//.test(r.page) ? r.page : null });
    } catch { /* skip one thumbnail */ }
  }
  const source = `Google Images via the live Chrome session (${profile} profile)`;
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify({ query, url: data.href, profile, source, fetched_at: new Date().toISOString(), results: saved.map((x) => ({ ...x, file: path.basename(x.file) })) }, null, 2)}\n`);
  if (saved.length < 4) return { ok: false, notes: [...notes, `live Chrome: only ${saved.length} thumbnails downloaded`] };
  return { ok: true, source, results: saved, notes };
}

/** Reuse an earlier live-Chrome logo search from review/logo-search/manifest.json. */
async function cachedLogoSearch(outDir) {
  const m = await readJson(path.join(outDir, 'manifest.json'));
  if (!m?.results?.length) return null;
  const results = m.results.map((r) => ({ ...r, file: path.join(outDir, r.file) })).filter((r) => existsSync(r.file));
  if (results.length < 4) return null;
  return { ok: true, cached: true, source: `${m.source ?? 'Google Images via the live Chrome session'}, cached ${String(m.fetched_at ?? '').slice(0, 10)}`, results, notes: [] };
}

// ---------------------------------------------------------------------------------------------
// run.json record
// ---------------------------------------------------------------------------------------------
function runFile(argv) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', RUN_FILE_CLI, ...argv], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function recordReviewCanvas(runDir, record) {
  const got = runFile(['get', runDir, 'variants']);
  if (got.status !== 0) return { ok: false, error: `run-file get variants failed: ${(got.stderr || got.stdout).trim().slice(0, 200)}` };
  const block = JSON.parse(got.stdout);
  const prior = block.review_canvas;
  const modes = (r) => JSON.stringify([r?.html ?? null, r?.width ?? null, Object.fromEntries(Object.entries(r?.sections ?? {}).map(([k, v]) => [k, v?.mode ?? null]))]);
  if (prior && prior.png === record.png && prior.sheet_revision === record.sheet_revision && modes(prior) === modes(record)) {
    return { ok: true, skipped: 'already recorded for this sheet revision with the same section outcomes (review/review-canvas.json has the fresh timestamps)' };
  }
  block.review_canvas = record;
  const tmp = path.join(runDir, 'review', '.variants-block.json');
  await fs.writeFile(tmp, `${JSON.stringify(block, null, 2)}\n`);
  try {
    let r = runFile(['set', runDir, 'variants', '--from', tmp, '--by', 'review-canvas']);
    let forced = false;
    if (r.status !== 0 && /Refusing to overwrite/.test(r.stderr)) {
      // Same pattern as variant-sheet.mjs: the block content is unchanged apart from the added key; the force is recorded in state.forces.
      r = runFile(['set', runDir, 'variants', '--from', tmp, '--by', 'review-canvas', '--force', '--reason', 'review canvas path added under variants.review_canvas; sheet, cells, and letters unchanged']);
      forced = true;
    }
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) };
    return { ok: true, forced };
  } finally { await fs.rm(tmp, { force: true }); }
}

// ---------------------------------------------------------------------------------------------
// Section model -> PNG blocks and HTML. Parts:
//   { type: 'text', items }           items as textBlock items (logical sizes)
//   { type: 'gray', text }
//   { type: 'image', file, caption, maxH, cropTop, bg, native, zoom, alt }
//   { type: 'grid', items, cols, cellH, labelH, labelSize, bg }
//   { type: 'header', items, cell: { file, caption } }
// ---------------------------------------------------------------------------------------------
async function renderPng(sections, outFile, { budgetBytes = Infinity } = {}) {
  const blocks = [];
  // Size-gated sections (previews) are rendered into their own list, measured against the budget
  // (the block buffers are PNG-encoded, so their byte sum is a fair proxy for the file), and
  // dropped when they would push the file over it. Returned under `skipped` so the HTML can say so.
  const gated = [];
  const skipped = {};
  for (const [i, sec] of sections.entries()) {
    const target = sec.sizeGated ? [] : blocks;
    if (sec.sizeGated) gated.push({ sec, blocks: target });
    if (i > 0) target.push(await spacer(24), await rule(), await spacer(24));
    await renderSectionBlocks(sec, target);
  }
  const bytes = (list) => list.reduce((n, b) => n + b.buffer.length, 0);
  let base = bytes(blocks);
  const all = [...blocks];
  for (const g of gated) {
    const own = bytes(g.blocks);
    if (base + own > budgetBytes) {
      skipped[g.sec.id] = { reason: `would add about ${(own / 1e6).toFixed(1)} MB to a PNG already near ${(base / 1e6).toFixed(0)} MB (budget ${(budgetBytes / 1e6).toFixed(0)} MB)`, bytes: own, base_bytes: base };
    } else { all.push(...g.blocks); base += own; }
  }
  const size = await stack(all, outFile);
  return { ...size, skipped };
}

async function renderSectionBlocks(sec, blocks) {
  {
    // (kept as one indented block so the part renderers below stay diff-stable)
    if (sec.title) {
      const items = [{ text: sec.title, size: 40, bold: true }];
      if (sec.subtitle) items.push({ text: sec.subtitle, size: 20, color: '#555555', gap: 6 });
      const t = await textBlock(items);
      blocks.push({ ...t, height: t.height + L(10) });
    }
    for (const part of sec.parts) {
      if (part.type === 'text') blocks.push(await textBlock(part.items), await spacer(part.gapAfter ?? 8));
      else if (part.type === 'gray') blocks.push(await grayBox(part.text, { height: part.height ?? 160 }));
      else if (part.type === 'image') {
        const b = await imageBlock(part.file, { maxH: part.maxH ?? 1100, cropTop: part.cropTop, bg: part.bg ?? '#FFFFFF', native: part.native });
        blocks.push(b);
        const cap = [part.caption, b.cropped ? `Top ${part.maxH ?? 1100}px of a taller image; the HTML page and the file itself show all of it.` : null].filter(Boolean).join(' ');
        if (cap) blocks.push(await textBlock([{ text: cap, size: 17, color: '#666666', gap: 6 }]));
      } else if (part.type === 'sheet' || part.type === 'signage') {
        // HTML-first parts: the PNG shows their raster when --png rendered one, else says where to look.
        if (part.file && existsSync(part.file)) {
          const b = await imageBlock(part.file, { maxH: part.type === 'sheet' ? 4000 : 900, native: true });
          blocks.push(b);
          if (part.caption) blocks.push(await textBlock([{ text: part.caption, size: 17, color: '#666666', gap: 6 }]));
        } else blocks.push(await grayBox(`${part.type === 'sheet' ? 'variant sheet' : `signage preview ${part.letter}`}: drawn in review-canvas.html; run with --png for a raster here.`, { height: 110 }));
      } else if (part.type === 'grid') blocks.push(await imageGrid(part.items, { cols: part.cols, cellH: part.cellH, labelH: part.labelH, labelSize: part.labelSize, bg: part.bg }), await spacer(12));
      else if (part.type === 'links') {
        const items = [];
        for (const r of part.rows) {
          items.push({ text: `${r.label}:  ${r.status.kind === 'rejected' ? 'REJECTED' : r.status.words.toUpperCase()}${r.url ? `   ${r.url}` : ''}`, size: 21, bold: true, color: r.status.chip, gap: 12 });
          if (r.verdict) items.push({ text: r.verdict.slice(0, 260), size: 16, color: '#444444', indent: 24, gap: 3 });
          if (r.evidence.length) items.push({ text: `Evidence: ${r.evidence.join('; ').slice(0, 260)}`, size: 16, color: '#666666', indent: 24, gap: 3 });
        }
        if (!items.length) items.push({ text: 'No link rows.', size: 18, color: '#666666' });
        blocks.push(await textBlock(items), await spacer(8));
      } else if (part.type === 'header') {
        const cellW = L(480);
        const textW = part.cell ? CW() - cellW - L(30) : CW();
        const text = await textBlock(part.items, { width: textW });
        if (!part.cell) { blocks.push(text); continue; }
        if (!part.cell.file) { blocks.push(text); continue; }
        const meta = await sharp(part.cell.file).metadata();
        const scale = Math.min(cellW / meta.width, L(520) / meta.height);
        const cw = Math.round(meta.width * scale); const chh = Math.round(meta.height * scale);
        const img = await fitImage(part.cell.file, cw, chh, { bg: '#FFFFFF', frame: GREEN });
        const cap = await textBlock([{ text: part.cell.caption, size: 18, color: GREEN, bold: true }], { width: cellW });
        const comps = [{ input: text.buffer, left: 0, top: 0 }, { input: img, left: CW() - cellW, top: 0 }, { input: cap.buffer, left: CW() - cellW, top: chh + L(6) }];
        let h = Math.max(text.height, chh + cap.height + L(6));
        if (part.zoom && existsSync(part.zoom.file)) {
          const zm = await sharp(part.zoom.file).metadata();
          const zs = Math.min(cellW / zm.width, L(360) / zm.height);
          const zw = Math.round(zm.width * zs); const zh = Math.round(zm.height * zs);
          const zimg = await fitImage(part.zoom.file, zw, zh, { bg: '#FFFFFF', frame: part.zoom.pass === false ? '#B71C1C' : '#444444' });
          const zcap = await textBlock([{ text: 'Logo at 3x (what prints)', size: 18, bold: true, color: part.zoom.pass === false ? '#B71C1C' : '#222222' }, { text: part.zoom.line, size: 15, color: '#444444', gap: 4 }], { width: cellW });
          const ztop = chh + cap.height + L(16);
          comps.push({ input: zimg, left: CW() - cellW, top: ztop }, { input: zcap.buffer, left: CW() - cellW, top: ztop + zh + L(6) });
          h = Math.max(h, ztop + zh + zcap.height + L(6));
        }
        const buffer = await sharp({ create: { width: CW(), height: h, channels: 3, background: '#FFFFFF' } })
          .composite(comps)
          .png().toBuffer();
        blocks.push({ buffer, width: CW(), height: h });
      }
    }
  }
}

function renderHtml(sections, { title, reviewDir, runDir = path.dirname(reviewDir) }) {
  const href = (file) => path.relative(reviewDir, file).split(path.sep).map(encodeURIComponent).join('/');
  // run-dir-relative logo paths (sheet views, signage specs) -> src relative to the page
  const src = (relPath) => href(path.join(runDir, relPath));
  let sheetJson = null;
  // Sidebar entries: one per section, plus a sub-entry for each bold sub-heading inside it
  // (sizes 22-30 are the in-section headings; the business name and h2 titles are bigger).
  const nav = [];
  let subSeq = 0;
  const subId = (secId, it) => {
    if (!it.bold || (it.size ?? 22) < 22 || (it.size ?? 22) > 30 || !it.text) return null;
    const id = `${secId}-${++subSeq}`;
    nav[nav.length - 1]?.subs.push({ id, label: it.text.split('\n')[0] });
    return id;
  };
  // Escape, then turn every http(s) URL into a real link (trailing punctuation stays outside).
  const ext = (url, label) => `<a class="ext" href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`;
  const linkify = (text) => esc(text ?? '').replace(/\n/g, '<br>').replace(/https?:\/\/[^\s<]+?(?=[.,;:)\]'"]*(?:\s|<br>|$))/g, (u) => ext(u, u));
  // Link chips: a plain label plus the bare host/path for link rows (held ones tagged), label + arrow for the rest.
  const linksHtml = (links) => links?.length ? `<p class="links">${links.map((l) => l.host
    ? `<a class="ext chip${l.tag ? ` ${esc(l.tag)}` : ''}" href="${esc(l.url)}" target="_blank" rel="noopener"><b>${esc(l.label)}</b> ${esc(l.host)}${l.tag ? ` <em>${esc(l.tag)}</em>` : ''}</a>`
    : ext(l.url, esc(l.label) + ' &#8599;')).join(' ')}</p>` : '';
  const textHtml = (items, secId) => items.map((it0) => {
    const it = typeof it0 === 'string' ? { text: it0 } : it0;
    const size = it.size ?? 22;
    const style = `font-size:${Math.round(size * 0.85)}px;${it.bold ? 'font-weight:700;' : ''}${it.color ? `color:${it.color};` : ''}${it.indent ? `margin-left:${it.indent}px;` : ''}${it.gap ? `margin-top:${it.gap}px;` : ''}`;
    const id = secId ? subId(secId, it) : null;
    return `<p${id ? ` id="${id}"` : ''} style="${style}">${linkify(it.text)}</p>`;
  }).join('\n');
  // Caption source line: the real source URL (host/path, middle-truncated) as an external link, or the
  // file name with no link when the candidate came from a local file (2026-10-12).
  const sourceHtml = (source, url) => {
    const src = source ?? (url ? { url, text: displayUrl(url) } : null);
    if (!src?.text && !src?.url) return '';
    return src.url ? `<br>${ext(src.url, `${esc(src.text ?? displayUrl(src.url))} &#8599;`)}` : `<br><span class="src">${esc(src.text)}</span>`;
  };
  const figure = (file, label, { frame, bg, bold, url, source, pageHref, pageLabel, hidden } = {}) =>
    `<figure${bg ? ` style="background:${bg}"` : ''}${frame || hidden ? ` class="${[frame ? 'framed' : null, hidden ? 'more' : null].filter(Boolean).join(' ')}"` : ''}><a href="${pageHref ? esc(pageHref) : href(file)}" target="_blank"${pageHref ? ' rel="noopener"' : ''} title="${pageHref ? `open the source page: ${esc(pageHref)}` : 'open the file'}"><img src="${href(file)}" loading="lazy" alt="${esc(label ?? '')}"></a><figcaption${bold ? ' style="font-weight:700"' : ''}>${pageHref ? `${ext(pageHref, `<b>${esc(pageLabel ?? pageHref)}</b> &#8599;`)}<br>` : ''}${linkify(label)}${sourceHtml(source, url)}</figcaption></figure>`;
  const out = [];
  for (const [i, sec] of sections.entries()) {
    const secId = sec.id || `section-${i + 1}`;
    nav.push({ id: secId, label: sec.navLabel ?? sec.title ?? 'Overview', subs: [] });
    out.push(`<section id="${esc(secId)}">`);
    if (sec.title) out.push(`<h2>${esc(sec.title)}</h2>${sec.subtitle ? `<p class="sub">${linkify(sec.subtitle)}</p>` : ''}`);
    out.push(linksHtml(sec.links));
    for (const part of sec.parts) {
      if (part.type === 'text') out.push(textHtml(part.items, secId));
      else if (part.type === 'gray') out.push(`<div class="gray">${linkify(part.text)}</div>`);
      else if (part.type === 'image') {
        // The variant sheet is the deliverable: load it eagerly (Chrome never fetches loading="lazy" images in a
        // hidden tab, and a 0-height placeholder can sit unloaded for a long time) and cache-bust the src with
        // the file mtime so a rebuilt sheet under the same file name is never served from the browser cache (2026-10-12).
        const bust = part.bust ? `?v=${(() => { try { return Math.round(statSync(part.file).mtimeMs); } catch { return Date.now(); } })()}` : '';
        out.push(`<div class="shot${part.zoom ? ' zoom' : ''}"${part.zoom ? ' title="click to toggle native size"' : ''}><a href="${href(part.file)}${bust}" target="_blank"><img src="${href(part.file)}${bust}" loading="${part.eager ? 'eager' : 'lazy'}" alt="${esc(part.alt ?? part.caption ?? '')}"></a></div>${part.caption ? `<p class="cap">${linkify(part.caption)}</p>` : ''}`);
      }
      // Links table: one plain-English verdict per row (linkVerdict); the raw reason and evidence stay behind a collapsed "raw evidence".
      else if (part.type === 'links') out.push(`<table class="links"><thead><tr><th>Category</th><th>URL</th><th>Status</th><th>Verdict</th></tr></thead><tbody>${part.rows.map((r) => {
        const raw = [r.reason, ...(r.evidence ?? [])].filter(Boolean);
        return `<tr class="st-${esc(r.status.kind)}"><td class="cat">${esc(r.label)}</td><td class="url">${r.url ? ext(r.url, esc(displayUrl(r.url, 72))) : '<span class="none">none</span>'}</td><td><span class="chip" style="background:${esc(r.status.chip)}">${esc(r.status.kind === 'rejected' ? 'rejected' : r.status.words)}</span></td><td class="ev"><div class="verdict">${esc(r.verdict ?? linkVerdict(r))}</div>${raw.length ? `<details><summary>raw evidence</summary><div class="raw">${raw.map((x) => linkify(x)).join('<br>')}</div></details>` : '<span class="none">no evidence recorded</span>'}</td></tr>`;
      }).join('\n')}</tbody></table>`);
      // Grid: items past `showFirst` start hidden behind a "Show all N" toggle (inline JS, no library).
      else if (part.type === 'grid') {
        const n = part.items.length;
        const first = Number.isFinite(part.showFirst) && part.showFirst < n ? part.showFirst : n;
        out.push(`<div class="grid cols${part.cols ?? 3}">${part.items.map((it, i) => figure(it.file, it.label, { frame: it.frame, bg: it.bg ?? part.bg, bold: it.bold, url: it.url, source: it.source, pageHref: it.href, pageLabel: it.hrefLabel, hidden: i >= first })).join('\n')}</div>${first < n ? `<p class="show-all"><button type="button" class="show-all" data-all="Show all ${n}" data-less="Show fewer (${first} of ${n})">Show all ${n}</button></p>` : ''}`);
      }
      // Variant sheet: the montage drawn from the sheet view (templates), the view as an inline JSON block, selection + compare UI.
      else if (part.type === 'sheet') {
        sheetJson = JSON.stringify(part.view).replace(/<\//g, '<\\/');
        out.push(`<div class="sheet-wrap" id="sheet-wrap" title="click the grey background to toggle native size"><div class="sheet-zoom" id="sheet-zoom">${templates.sheetHtml(part.view, { src, focus: part.focus, selectable: true })}</div></div>${part.caption ? `<p class="cap">${linkify(part.caption)}</p>` : ''}<p class="compare-bar"><button type="button" id="compare-btn" disabled>Compare selected</button> <button type="button" id="compare-clear">Clear</button> <span id="compare-count">click 2 to 5 cells</span></p><div id="compare-panel" class="compare-panel"></div>`);
      }
      // Signage preview drawn from its JSON spec (scripts/signage-preview.mjs).
      else if (part.type === 'signage') {
        const sp = part.spec;
        out.push(`<div class="signage-wrap">${templates.signagePreviewHtml({ logoUrl: sp.logo ? src(sp.logo) : null, logoLightUrl: sp.logo_light ? src(sp.logo_light) : null, primary: sp.primary, accent: sp.accent, offer: sp.offer, bathroomCopy: sp.bathroom_copy ?? null })}</div>${part.caption ? `<p class="cap">${linkify(part.caption)}</p>` : ''}`);
      }
      else if (part.type === 'header') out.push(`<div class="hdr"><div>${textHtml(part.items)}</div>${part.cell ? `<div class="cell">${part.cell.html ? `<div class="cell-html">${part.cell.html}</div>` : `<a href="${href(part.cell.file)}" target="_blank"><img src="${href(part.cell.file)}" alt="default cell"></a>`}<p>${esc(part.cell.caption)}</p>${part.zoom && existsSync(part.zoom.file) ? `<a href="${href(part.zoom.file)}" target="_blank" title="open the 3x crop"><img class="zoom3x${part.zoom.pass === false ? ' bad' : ''}" src="${href(part.zoom.file)}" alt="logo at 3x"></a><p><b>Logo at 3x (what prints).</b> ${esc(part.zoom.line)}</p>` : ''}</div>` : ''}</div>`);
    }
    out.push('</section>');
  }
  const navHtml = `<nav class="toc" id="toc"><button class="toc-toggle" type="button" aria-expanded="false" aria-controls="toc-list">Sections</button>
<ol id="toc-list">
<li><a href="#top" class="top">Top</a></li>
${nav.map((n) => `<li><a href="#${esc(n.id)}">${esc(n.label)}</a>${n.subs.length ? `<ol>${n.subs.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.label)}</a></li>`).join('')}</ol>` : ''}</li>`).join('\n')}
</ol></nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
${templates.FONT_LINK_HTML}
<script src="sheet-templates.js"></script>
<style>
  :root { color-scheme: light; scroll-behavior: auto; }
  ${templates.SHEET_CSS}
  .cell-html .bs-cell { border: 6px solid #1b5e20; box-sizing: content-box; }
  .sheet-wrap { border: 1px solid #ddd; overflow: auto; background: #C8C8C8; cursor: zoom-in; }
  .sheet-wrap.native { cursor: zoom-out; }
  .sheet-zoom { width: max-content; }
  .compare-bar { margin: 10px 0 0; font-size: 15px; }
  .compare-bar button { font: inherit; font-size: 14px; font-weight: 700; background: #f4f4f4; border: 1px solid #bbb; border-radius: 4px; padding: 6px 14px; cursor: pointer; }
  .compare-bar button[disabled] { color: #999; cursor: default; }
  .compare-bar span { color: #666; margin-left: 8px; }
  .compare-panel { margin-top: 12px; overflow: auto; }
  .compare-panel h3 { font-size: 22px; margin: 8px 0; }
  .signage-wrap { overflow: auto; border: 1px solid #ddd; }
  body { margin: 0; padding: 32px 40px 80px 280px; background: #fff; color: #111; font-family: Helvetica, Arial, sans-serif; font-size: 18px; line-height: 1.35; max-width: 2040px; box-sizing: border-box; }
  h2 { font-size: 34px; margin: 0 0 4px; }
  section { padding: 28px 0; border-bottom: 3px solid #ccc; scroll-margin-top: 16px; }
  section:first-child { padding-top: 0; }
  p[id] { scroll-margin-top: 16px; }
  .toc { position: fixed; top: 0; left: 0; bottom: 0; width: 240px; box-sizing: border-box; padding: 24px 16px; overflow-y: auto; background: #f4f4f4; border-right: 1px solid #ddd; font-size: 15px; z-index: 10; }
  .toc ol { list-style: none; margin: 0; padding: 0; }
  .toc ol ol { margin: 2px 0 6px 14px; }
  .toc ol ol a { font-size: 13px; color: #555; padding: 3px 8px; }
  .toc a { display: block; padding: 6px 8px; border-radius: 4px; color: #222; line-height: 1.3; }
  .toc a:hover { background: #e6e6e6; }
  .toc a.active { background: #1b5e20; color: #fff; font-weight: 700; }
  .toc a.top { color: #666; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 8px; }
  .toc-toggle { display: none; }
  @media (max-width: 1000px) {
    body { padding: 64px 20px 80px; }
    .toc { position: sticky; top: 0; bottom: auto; width: auto; margin: -64px -20px 24px; padding: 8px 12px; border-right: 0; border-bottom: 1px solid #ddd; max-height: 80vh; }
    .toc-toggle { display: block; font: inherit; font-weight: 700; background: none; border: 1px solid #bbb; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
    .toc-toggle::before { content: "\\2630  "; }
    .toc:not(.open) ol { display: none; }
    .toc ol { padding-top: 8px; }
  }
  p { margin: 4px 0; }
  p.sub { color: #555; font-size: 17px; margin-bottom: 14px; }
  p.cap { color: #666; font-size: 15px; }
  .gray { background: #ededed; color: #444; padding: 26px; font-size: 20px; border-radius: 4px; }
  .hdr { display: flex; gap: 30px; align-items: flex-start; }
  .hdr > div:first-child { flex: 1; }
  .cell { flex: 0 0 auto; max-width: 520px; }
  .cell > a > img { display: block; max-width: 100%; border: 6px solid #1b5e20; box-sizing: border-box; }
  .cell p { color: #1b5e20; font-weight: 700; font-size: 16px; }
  .shot { border: 1px solid #ddd; overflow: auto; max-height: 90vh; }
  .shot img { display: block; width: 100%; height: auto; }
  /* 2026-10-01: a zoomable shot (the variant sheet) is never height-clipped: every row stays visible at page width,
     and native size scrolls inside the container (overflow auto) instead of hiding rows below 90vh. */
  .shot.zoom { max-height: none; }
  .shot.zoom img { cursor: zoom-in; }
  .cell img.zoom3x { margin-top: 10px; border: 3px solid #444; image-rendering: pixelated; }
  .cell img.zoom3x.bad { border-color: #B71C1C; }
  .shot.zoom.native img { width: auto; max-width: none; cursor: zoom-out; }
  .grid { display: grid; gap: 14px; }
  .grid.cols3 { grid-template-columns: repeat(3, 1fr); }
  .grid.cols4 { grid-template-columns: repeat(4, 1fr); }
  .grid.cols5 { grid-template-columns: repeat(5, 1fr); }
  .grid.cols6 { grid-template-columns: repeat(6, 1fr); }
  figure { margin: 0; background: #ededed; }
  figure.framed { outline: 6px solid #1b5e20; outline-offset: -6px; }
  figure a { display: block; }
  figure img { display: block; width: 100%; height: 360px; object-fit: contain; }
  .grid.cols4 figure img { height: 280px; }
  .grid.cols5 figure img, .grid.cols6 figure img { height: 220px; }
  figcaption { font-size: 15px; padding: 6px 4px 10px; background: #fff; color: #222; }
  a { color: inherit; text-decoration: none; }
  a.ext { color: #0b57d0; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  a.ext:hover { color: #083a8c; }
  p.links { display: flex; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 16px; font-size: 15px; }
  p.links a.ext { background: #eef3fc; border: 1px solid #c9d8f5; border-radius: 4px; padding: 3px 10px; text-decoration: none; word-break: normal; }
  p.links a.ext:hover { background: #dce7fb; }
  p.links a.chip b { font-weight: 700; margin-right: 4px; }
  p.links a.chip.held { background: #fff4d6; border-color: #e3c37a; }
  p.links a.chip em { font-style: normal; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8a5a00; margin-left: 4px; }
  figcaption .src { color: #666; }
  .grid figure.more { display: none; }
  .grid.expanded figure.more { display: block; }
  p.show-all { margin: 10px 0 0; }
  button.show-all { font: inherit; font-size: 14px; font-weight: 700; background: #f4f4f4; border: 1px solid #bbb; border-radius: 4px; padding: 6px 14px; cursor: pointer; }
  button.show-all:hover { background: #e6e6e6; }
  table.links .verdict { color: #222; max-width: 560px; }
  table.links details { margin-top: 5px; font-size: 13px; color: #666; max-width: 560px; }
  table.links details summary { cursor: pointer; color: #0b57d0; }
  table.links .raw { margin-top: 4px; }
  table.links { border-collapse: collapse; width: 100%; font-size: 15px; margin-top: 8px; }
  table.links th { text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #666; padding: 6px 10px; border-bottom: 2px solid #ddd; }
  table.links td { padding: 9px 10px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
  table.links td.cat { font-weight: 700; white-space: nowrap; }
  table.links td.url { max-width: 380px; word-break: break-all; }
  table.links td.ev { color: #444; max-width: 520px; }
  table.links .chip { display: inline-block; color: #fff; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; padding: 3px 9px; border-radius: 10px; white-space: nowrap; }
  table.links .why { color: #444; font-size: 14px; margin-top: 5px; max-width: 420px; }
  table.links .none { color: #999; }
  table.links tr.st-held td { background: #fff8e8; }
  table.links tr.st-rejected td { color: #777; }
  table.links tr.st-written td { background: #eef7ee; }
</style></head><body id="top">
${navHtml}
${out.join('\n')}
${sheetJson ? `<script type="application/json" id="variant-sheet-view">${sheetJson}</script>` : ''}
<script>
  for (const el of document.querySelectorAll('.shot.zoom')) {
    el.addEventListener('click', (ev) => { ev.preventDefault(); el.classList.toggle('native'); });
  }
  // Variant sheet (2026-10-13): fit the montage to the content width (CSS zoom), click the background for native size,
  // click cells to select them, Compare selected renders the compare view from the inline JSON with the templates.
  (() => {
    const wrap = document.getElementById('sheet-wrap');
    const zoom = document.getElementById('sheet-zoom');
    const data = document.getElementById('variant-sheet-view');
    if (!wrap || !zoom || !data) return;
    const sheet = zoom.querySelector('.bs-sheet');
    let native = false;
    const fit = () => { const w = sheet.offsetWidth; const avail = wrap.clientWidth; zoom.style.zoom = native ? 1 : Math.min(1, avail / w); wrap.classList.toggle('native', native); };
    window.addEventListener('resize', fit);
    fit();
    wrap.addEventListener('click', (ev) => { if (ev.target.closest('.bs-cell')) return; native = !native; fit(); });
    const view = JSON.parse(data.textContent);
    const logoUrl = {};
    for (const img of zoom.querySelectorAll('img[data-logo]')) logoUrl[img.dataset.logo] ??= img.getAttribute('src');
    const src = (rel) => logoUrl[rel] ?? rel;
    const selected = [];
    const btn = document.getElementById('compare-btn');
    const count = document.getElementById('compare-count');
    const panel = document.getElementById('compare-panel');
    const update = () => { btn.disabled = selected.length < 2 || selected.length > 5; count.textContent = selected.length ? selected.join(', ') + ' selected' + (selected.length > 5 ? ' (at most 5)' : selected.length < 2 ? ' (pick one more)' : '') : 'click 2 to 5 cells'; };
    for (const cell of zoom.querySelectorAll('.bs-cell.selectable')) cell.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const l = cell.dataset.letter; const i = selected.indexOf(l);
      if (i >= 0) selected.splice(i, 1); else selected.push(l);
      cell.classList.toggle('selected', i < 0);
      update();
    });
    btn.addEventListener('click', () => {
      if (!window.BoostlySheet) { panel.innerHTML = '<p class="cap">sheet-templates.js did not load next to this page.</p>'; return; }
      panel.innerHTML = '<h3>Compare ' + selected.join(', ') + '</h3>' + window.BoostlySheet.compareHtml(view, selected.slice(), { src, colW: 300 });
      panel.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    document.getElementById('compare-clear').addEventListener('click', () => { selected.length = 0; for (const c of zoom.querySelectorAll('.bs-cell.selected')) c.classList.remove('selected'); panel.innerHTML = ''; update(); });
    update();
  })();
  // "Show all N" on capped photo grids: reveal the hidden figures in the grid just above the button.
  for (const btn of document.querySelectorAll('button.show-all')) {
    btn.addEventListener('click', () => {
      const grid = btn.parentElement.previousElementSibling;
      if (!grid) return;
      const open = grid.classList.toggle('expanded');
      btn.textContent = open ? btn.dataset.less : btn.dataset.all;
    });
  }
  // Sidebar: highlight the section in view, jump instantly on click (no scroll animation, Travisse 2026-09-29), hamburger below 1000px.
  (() => {
    const toc = document.getElementById('toc');
    const links = new Map([...toc.querySelectorAll('a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
    const sections = [...document.querySelectorAll('section[id]')];
    const visible = new Set();
    const setActive = () => {
      const current = sections.find((s) => visible.has(s)) ?? sections.find((s) => s.getBoundingClientRect().bottom > 0) ?? sections[sections.length - 1];
      for (const a of links.values()) a.classList.remove('active');
      if (current) links.get(current.id)?.classList.add('active');
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target); }
      setActive();
    }, { rootMargin: '-15% 0px -60% 0px', threshold: 0 });
    for (const s of sections) io.observe(s);
    setActive();
    const toggle = toc.querySelector('.toc-toggle');
    toggle.addEventListener('click', () => { const open = toc.classList.toggle('open'); toggle.setAttribute('aria-expanded', String(open)); });
    for (const a of links.values()) a.addEventListener('click', (ev) => {
      const target = document.getElementById(a.getAttribute('href').slice(1));
      if (!target) return;
      ev.preventDefault();
      target.scrollIntoView({ behavior: 'instant', block: 'start' });
      history.replaceState(null, '', a.getAttribute('href'));
      toc.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false');
    });
  })();
</script>
</body></html>
`;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  S = args.scale;
  const runDir = args.run;
  const reviewDir = path.join(runDir, 'review');
  await fs.mkdir(reviewDir, { recursive: true });
  const canvasFile = path.join(reviewDir, 'review-canvas.png');
  const htmlFile = path.join(reviewDir, 'review-canvas.html');
  const openOutputs = (record) => {
    if (!args.open) return;
    if (record?.png && existsSync(canvasFile)) spawnSync('open', ['-a', 'Preview', canvasFile]);
    if (record?.html && existsSync(htmlFile)) spawnSync('open', [htmlFile]);
  };

  const run = await readJson(path.join(runDir, 'run.json'));
  if (!run) throw new Error(`No run.json in ${runDir}`);
  if (args.recordOnly) {
    const record = await readJson(path.join(reviewDir, 'review-canvas.json'));
    if (!record) throw new Error(`--record-only: ${path.join(reviewDir, 'review-canvas.json')} is missing; run without the flag first`);
    const recorded = await recordReviewCanvas(runDir, record);
    console.log(JSON.stringify({ ok: true, record_only: true, canvas: canvasFile, html: record.html ? htmlFile : null, run_file: recorded }, null, 2));
    openOutputs(record);
    return;
  }
  const sheetJsonPath = abs(runDir, run.variants?.sheet_json ?? 'variants/variant-sheet.json');
  const sheet = await readJson(sheetJsonPath);
  if (args.command === 'compare') { await compare({ args, runDir, reviewDir, run, sheet }); return; }
  const sheetPng = abs(runDir, run.variants?.sheet_png ?? 'variants/variant-sheet.png');
  const evidence = await readJson(abs(runDir, run.evidence?.packet_path ?? 'evidence/branding-evidence.json'), {});
  const decision = run.decision ?? (await readJson(path.join(runDir, 'decision.json'), {}));
  const gbpManifest = await readJson(path.join(runDir, 'gbp-photos', 'gbp-photos.json'), null);
  const req = run.request ?? {};
  const identity = req.identity ?? {};
  const name = identity.account_name ?? req.account_name ?? req.location_name ?? 'Unknown business';
  const city = [identity.city, identity.state].filter(Boolean).join(', ') || '';
  const cityOnly = identity.city ?? '';
  // An approved website swap (links.website_bootstrap.approved_website_url) is what the page shows
  // as the website; the stored value stays in run.json for the closeout agent (2026-10-12).
  const websiteSwap = approvedWebsiteSwap(run.links?.website_bootstrap);
  const website = websiteSwap?.url ?? req.website_url ?? evidence.location?.website_url ?? null;
  const placeId = req.google_place_id ?? evidence.location?.google_place_id ?? null;
  // ---- live-source links for the HTML page (omitted when the run does not record them) -------
  const accountId = req.account_id ?? evidence.location?.account_id ?? null;
  const gq = (q) => encodeURIComponent(q);
  const slackLink = run.slack?.permalink
    ?? (req.slack_channel && req.slack_thread_ts ? `https://slack.com/archives/${req.slack_channel}/p${String(req.slack_thread_ts).replace('.', '')}` : null);
  const figmaLink = run.figma?.section_url ?? run.figma?.url ?? null;
  // Signage approval (Karissa 2026-10-19): reviewers approve the real vector PDFs in the location's Drive
  // folder (print-handoff/handoff.json drive.folder_link, uploaded at the closeout stop), not an inline
  // contact sheet. The review site adds the Print files section; the overview chip links the folder.
  let printFolderLink = null;
  try {
    const d = JSON.parse(await fs.readFile(path.join(runDir, 'print-handoff', 'handoff.json'), 'utf8')).drive ?? {};
    const u = d.folder_link ?? (d.folder_id ? `https://drive.google.com/drive/folders/${d.folder_id}` : null);
    if (u && /^https:\/\/drive\.google\.com\//.test(u)) printFolderLink = u;
  } catch {}
  const defaultLetter = sheet?.fable_default_letter ?? run.variants?.fable_default_letter ?? null;
  const overviewLinks = [
    accountId ? { label: 'Boostly account', url: `https://new.boostly.com/admin/accounts/${accountId}` } : null,
    req.request_id && req.source === 'v2-db' ? { label: 'Fulfillment request', url: `https://new.boostly.com/admin/fulfillment/${req.request_id}` } : null,
    slackLink ? { label: 'Slack thread', url: slackLink } : null,
    figmaLink ? { label: 'Figma', url: figmaLink } : null,
    printFolderLink ? { label: 'Print files (Drive)', url: printFolderLink } : null,
    defaultLetter && sheet?.cells?.[defaultLetter] ? { label: 'Compare default', url: 'compare-default.html' } : null,
  ].filter(Boolean);
  // Link chips (2026-10-12, Travisse): only rows that are written, live, ready to write, or already on
  // the location, as "Label host/path"; held rows carry a small "held" tag; rejected candidates never
  // appear here (they stay in the Links table). Falls back to the request website when the run has no link rows.
  const linkSources = await collectLinkSources(runDir, run);
  const linkRows = buildLinkRows({ links: linkSources.links, categoryResults: linkSources.report?.report?.category_results ?? [], pendingUrls: linkSources.pendingUrls });
  const linkChips = overviewLinkChips(linkRows);
  if (!linkChips.some((c) => c.label === 'Website') && website) linkChips.unshift({ label: 'Website', url: website, host: displayUrl(website, 44), tag: null });
  overviewLinks.push(...linkChips);
  const gbpLinks = [
    placeId ? { label: 'Google Maps place', url: `https://www.google.com/maps/place/?q=place_id:${placeId}` } : null,
    { label: 'Google search', url: `https://www.google.com/search?q=${gq(`${name} ${city}`.trim())}` },
  ].filter(Boolean);
  const fableMark = (sheet?.marks ?? []).find((m) => m.status === 'fable_pick' && m.letter === defaultLetter);
  const rationaleLine = fableMark?.note ? fableMark.note.replace(/^Fable( default)?:\s*/i, '') : firstSentence(decision?.rationale);
  const usage = { website: null, gbp_photos: null, vibe_photos: null, maps_view: null, logo_search: null, candidates: null, sheet: null, logo_3x: null, links: null, previews: null, compare_default: null };
  const sections = [];

  // ---- sheet view (schema 3): every cell drawn by the browser from its view; the raster only behind --png ----
  const { sheetGeometry, provenanceWords, sheetView, normalizeManifest, composeSheet } = await import(path.join(SCRIPT_DIR, 'variant-sheet.mjs'));
  const variantsDir = path.dirname(sheetJsonPath);
  if (sheet && !sheet.run_dir) sheet.run_dir = runDir;
  const sheetData = sheet ? sheetView(normalizeManifest(sheet, variantsDir)) : null;
  const srcFromReview = (relPath) => path.relative(reviewDir, path.join(runDir, relPath)).split(path.sep).map(encodeURIComponent).join('/');
  // a small-source trace is a flag on the default, never a hold; the header says "default L (flag: traced from Npx)"
  const flag = defaultFlag(sheet, run, defaultLetter);
  const focusLetter = defaultLetter ?? null;
  const focus = focusLetter && sheetData?.cells?.[focusLetter] ? { letter: focusLetter } : null;
  let defaultCell = null;
  if (sheet && focusLetter && sheet.cells?.[focusLetter]) {
    const geometry = sheetGeometry(sheet);
    const cell = sheet.cells[focusLetter];
    const r = sheet.rows.findIndex((row) => row.key === cell.row);
    const c = cell.column_index ?? sheet.columns.findIndex((col) => col.hex === cell.secondary);
    if (r >= 0 && c >= 0) defaultCell = { letter: focusLetter, cell, view: sheetData.cells[focusLetter], x: 120 + c * geometry.cellW, y: 44 + r * geometry.cellH, w: geometry.cellW, h: geometry.cellH };
  }
  // --png: the tall PNG needs sheet pixels. One in-memory render of the sheet html (render-preview.mjs) into
  // variants/variant-sheet.png, then the default-cell crop and the marked sheet are cut from it as before.
  const cellFile = path.join(reviewDir, 'default-cell.png');
  const markedSheetFile = path.join(reviewDir, 'variant-sheet-marked.png');
  let sheetMeta = null;
  if (args.png && sheet) {
    await composeSheet(sheet, variantsDir, { raster: true });
    sheetMeta = await sharp(sheetPng).metadata();
    if (defaultCell) {
      await sharp(sheetPng).extract({ left: defaultCell.x, top: defaultCell.y, width: defaultCell.w, height: defaultCell.h }).png().toFile(cellFile);
      const { x, y, w, h } = defaultCell;
      const tagText = `default ${focusLetter}${flag ? ` (${flag.words})` : ''}`;
      const tagColor = GREEN;
      const tagW = Math.max(120, 30 + tagText.length * 12);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetMeta.width}" height="${sheetMeta.height}"><rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" fill="none" stroke="${tagColor}" stroke-width="7"/><rect x="${x}" y="${Math.max(0, y - 30)}" width="${tagW}" height="32" fill="${tagColor}"/><text x="${x + 10}" y="${Math.max(0, y - 30) + 23}" font-family="${FONT}" font-size="22" font-weight="700" fill="#FFFFFF">${esc(tagText)}</text></svg>`;
      await sharp(sheetPng).composite([{ input: Buffer.from(svg) }]).png().toFile(markedSheetFile);
    } else {
      await fs.copyFile(sheetPng, markedSheetFile);
    }
  }

  // ---- 1. header + gates --------------------------------------------------------------------
  const flags = Array.isArray(decision?.flags) ? decision.flags : [];
  const headerItems = [
    { text: name, size: 52, bold: true },
    { text: `${city}${req.request_id ? `   ·   request ${req.request_id}` : ''}${req.order_type ? `   ·   ${req.order_type.replace(/_/g, ' ')}` : ''}`, size: 24, color: '#444444', gap: 6 },
    { text: defaultLetter ? `Fable's default: ${defaultLetter}${flag ? ` (flag: ${flag.words})` : ''}` : 'Fable named no default letter', size: 34, bold: true, color: GREEN, gap: 22 },
    { text: rationaleLine || 'No rationale recorded.', size: 22, gap: 6 },
    { text: `Confidence: ${decision?.confidence ?? 'unknown'}${flags.length ? `   ·   flags: ${flags.join(', ')}` : ''}`, size: 19, color: '#666666', gap: 8 },
  ];
  if (defaultCell?.cell) {
    const cell = defaultCell.cell;
    headerItems.push({ text: `Cell ${focusLetter} = ${cell.row_label}, primary ${cell.primary}, band ${cell.secondary} (${provenanceWords(cell.secondary_source, cell.secondary_label)}), text ${cell.text}, print digit ${cell.print_text_secondary}${cell.badge_digit_print?.fix ? ` -> fix ${cell.badge_digit_print.fix}` : ''}`, size: 19, color: '#666666', gap: 4 });
  }
  // ---- logo at 3x (what prints) for the exact final upload of the focused cell -----------------
  let zoom = null;
  if (defaultCell?.cell) {
    const focusRow = sheet.rows.find((row) => row.key === defaultCell.cell.row);
    // the exact final upload: the applied write block first, then the applied cell, then the focused row's logo
    const write = run.write ?? {};
    const written = write.status === 'applied' ? (write.logo_file_resolved ?? (typeof write.logo_file === 'string' ? write.logo_file.split(/\s+/)[0] : null)) : null;
    const finalLogo = abs(runDir, (written && existsSync(abs(runDir, written)) ? written : null) || (sheet.applied_letter && sheet.cells?.[sheet.applied_letter]?.logo) || focusRow?.logo || defaultCell.cell.logo);
    try {
      zoom = await logoZoom3x({ runDir, logoFile: finalLogo, primary: defaultCell.cell.primary, outFile: path.join(reviewDir, 'logo-3x.png'), run });
    } catch (err) {
      zoom = { file: null, line: `3x crop failed: ${String(err.message ?? err).slice(0, 160)}`, edge_quality: null };
    }
  }
  usage.logo_3x = zoom ? { file: zoom.file ? rel(runDir, zoom.file) : null, logo: zoom.logo ?? null, edge_quality: zoom.edge_quality, line: zoom.line } : null;
  // The per-row gate summary is no longer rendered (Travisse, 2026-10-12); the gate results stay in run.json.
  sections.push({ id: 'header', links: overviewLinks, parts: [
    { type: 'header', items: headerItems, cell: defaultCell ? { html: templates.cellHtml(defaultCell.view, { src: srcFromReview }), file: args.png && existsSync(cellFile) ? cellFile : null, caption: `Fable's default cell ${defaultLetter}${flag ? ` (${flag.words} source, floor 700px)` : ''}` } : null, zoom: zoom?.file ? { file: zoom.file, line: zoom.line, pass: zoom.edge_quality?.pass ?? null } : null },
  ] });
  // No inline Signage sheets section (removed 2026-10-19, Karissa): the signage is approved on the Drive PDFs.

  // ---- captures (collected first so failures never block the composition) ------------------
  const websitePng = path.join(reviewDir, 'website-desktop.png');
  const mapsPng = path.join(reviewDir, 'google-maps-photos.png');
  const logoSearchPng = path.join(reviewDir, 'logo-image-search.png');
  const logoSearchDir = path.join(reviewDir, 'logo-search');
  const cachedWebsite = [
    abs(runDir, evidence.website?.visual_evidence?.desktop),
    path.join(runDir, 'evidence', 'website-visual', 'desktop.png'),
    websitePng,
  ].find((p) => p && existsSync(p));
  const websiteUnavailable = evidence.website?.visual_evidence?.status === 'unavailable' ? evidence.website.visual_evidence.reason ?? 'website visual evidence unavailable' : null;
  let websiteCapture = null;
  let mapsCapture = null;
  let logoCapture = null;
  let liveLogo = null;
  const needWebsite = !cachedWebsite && !websiteUnavailable && Boolean(website);
  const haveMaps = existsSync(mapsPng);
  if (!args.skipGoogle && args.liveChrome) {
    liveLogo = await liveGoogleImages({ query: `${name} ${cityOnly} logo`, name, city: cityOnly, profile: args.chromeProfile, outDir: logoSearchDir });
  }
  if (!liveLogo?.ok) {
    const cached = await cachedLogoSearch(logoSearchDir);
    if (cached) liveLogo = { ...cached, notes: [...(liveLogo?.notes ?? []), 'reused the cached live-Chrome results'] };
  }
  const needPlaywright = needWebsite || (!args.skipGoogle && (!haveMaps || !liveLogo?.ok));
  if (needPlaywright) {
    try {
      await withBrowser(async (browser) => {
        if (needWebsite) {
          try { websiteCapture = await captureWebsite(browser, website, websitePng); }
          catch (err) { websiteCapture = { ok: false, error: String(err.message).split('\n')[0].slice(0, 160) }; }
        }
        if (!args.skipGoogle) {
          if (!haveMaps) mapsCapture = await captureMapsPhotos(browser, { placeId, name, city: cityOnly, outFile: mapsPng, budgetMs: args.googleBudgetMs });
          if (!liveLogo?.ok) logoCapture = await captureLogoSearch(browser, { query: `${name} ${cityOnly} logo`, outFile: logoSearchPng });
        }
      });
    } catch (err) {
      const msg = `Playwright could not start: ${String(err.message).split('\n')[0].slice(0, 160)}`;
      websiteCapture ??= { ok: false, error: msg };
      mapsCapture ??= { ok: false, notes: [msg] };
      logoCapture ??= { ok: false, notes: [msg] };
    }
  }
  if (haveMaps && !mapsCapture) mapsCapture = { ok: true, cached: true, file: mapsPng, opened: true, vibe: false, notes: ['reused the cached capture under review/'] };

  // ---- 2. website ---------------------------------------------------------------------------
  const websiteParts = [];
  if (cachedWebsite) {
    usage.website = { mode: 'cached evidence', file: rel(runDir, cachedWebsite) };
    websiteParts.push({ type: 'image', file: cachedWebsite, maxH: 1100, cropTop: true, caption: `Desktop screenshot from the run's evidence (${rel(runDir, cachedWebsite)}).`, alt: 'website desktop screenshot' });
  } else if (websiteUnavailable) {
    usage.website = { mode: 'unavailable', reason: websiteUnavailable };
    websiteParts.push({ type: 'gray', text: `Website not captured. ${websiteUnavailable}` });
  } else if (websiteCapture?.ok) {
    usage.website = { mode: 'fresh screenshot', file: rel(runDir, websitePng) };
    websiteParts.push({ type: 'image', file: websitePng, maxH: 1100, cropTop: true, caption: `Fresh Playwright screenshot at 1440x900 (${S}x), full page capped at 1800px (${websiteCapture.final_url}).`, alt: 'website desktop screenshot' });
  } else {
    usage.website = { mode: 'failed', reason: websiteCapture?.error ?? (website ? 'skipped' : 'no website URL') };
    websiteParts.push({ type: 'gray', text: `Website not captured. ${usage.website.reason}` });
  }
  // The subtitle URL is itself the link (linkify gives it target=_blank rel=noopener); no separate "Open website" button (2026-10-12).
  sections.push({ id: 'website', title: 'Website', subtitle: website ? `${website}${websiteSwap ? ` ${websiteSwap.note}` : ''}` : 'no website on the request', links: [], parts: websiteParts });

  // ---- 3. Google Business Profile ---------------------------------------------------------
  const gbpParts = [];
  const cited = new Set();
  for (const text of [decision?.rationale, decision?.composition, evidence.in_store_observations]) {
    for (const m of String(text ?? '').matchAll(/gbp-photo-(\d{2})/g)) cited.add(Number(m[1]));
  }
  // Photo ordering signal (2026-10-12, Travisse): gbp-photos.json carries no photo-type tag, but most Place
  // photos (403 of 550 across runs-prod) share a sha256 with a brand-environment candidate in the SearchAPI
  // manifest (evidence.brand_environment.manifest, plus selected_candidates), and those carry `subtype`
  // (storefront, interior_fixture, menu_signage, branded_collateral, or plain vibe), `classification`
  // (brand_environment, mixed, unclassified) and Google's `category` (Vibe, By owner, All). Order: tagged
  // environment photos first, then Google's Vibe category, then Fable-cited photos, then everything else
  // (dish photos land there; at most 3 of them stay visible). With no tag match at all: Fable-cited first and
  // 6 visible. The rest sit behind the "Show all N" toggle.
  const be = evidence.brand_environment ?? {};
  const beManifest = be.manifest ? await readJson(be.manifest, null) : null;
  const ENV_SUBTYPES = new Set(['storefront', 'interior_fixture', 'exterior', 'signage', 'menu_signage', 'branded_collateral', 'interior']);
  const photoTag = new Map();
  for (const c of [...(be.selected_candidates ?? []), ...(beManifest?.candidates ?? [])]) {
    if (!c?.sha256 || photoTag.has(c.sha256)) continue;
    const sub = String(c.subtype ?? '').toLowerCase();
    const cls = String(c.classification ?? '').toLowerCase();
    const cat = String(c.category ?? '').toLowerCase();
    const tier = ENV_SUBTYPES.has(sub) || cls === 'brand_environment' || cls === 'mixed' ? 0 : sub === 'vibe' || cat === 'vibe' ? 1 : null;
    if (tier !== null) photoTag.set(c.sha256, { tier, word: tier === 0 ? sub.replace(/_/g, ' ') || cls.replace(/_/g, ' ') : 'vibe' });
  }
  const photoTier = (p) => { const t = photoTag.get(p.sha256); return t ? t.tier : cited.has(p.index) ? 2 : 3; };
  const gbpPhotos = (gbpManifest?.photos ?? []).map((p) => {
    const file = [abs(runDir, p.file), path.join(runDir, 'gbp-photos', path.basename(p.file ?? ''))].find((f) => f && existsSync(f));
    const author = p.author_attributions?.[0]?.displayName ?? '';
    const owner = author && author.toLowerCase().replace(/[^a-z]/g, '').startsWith(name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8));
    const isCited = cited.has(p.index);
    const size = p.width_px && p.height_px ? `  ${p.width_px}x${p.height_px}` : '';
    const tag = photoTag.get(p.sha256);
    return file ? { file, tier: photoTier(p), index: p.index, label: `#${p.index}${owner ? ' owner photo' : author ? ` by ${author}` : ''}${tag ? `  · ${tag.word}` : ''}${size}${isCited ? '  <- cited by Fable' : ''}`, frame: isCited ? GREEN : null, bold: isCited } : null;
  }).filter(Boolean).sort((a, b) => a.tier - b.tier || a.index - b.index);
  if (gbpPhotos.length) {
    const tagged = gbpPhotos.some((p) => p.tier <= 1);
    const showFirst = tagged ? gbpPhotos.filter((p) => p.tier <= 2).length + Math.min(3, gbpPhotos.filter((p) => p.tier === 3).length) : Math.min(6, gbpPhotos.length);
    usage.gbp_photos = { mode: 'cached evidence', count: gbpPhotos.length, ordering: tagged ? 'brand-environment subtype by sha256, then Vibe, then Fable-cited' : 'Fable-cited first (no brand-environment tag matched)', visible: showFirst };
    gbpParts.push({ type: 'text', items: [{ text: `Place photos already downloaded for this run (${gbpPhotos.length}), ${tagged ? 'storefront, interior and signage photos first, then the rest' : 'photos Fable cited first, then the rest'}. Green frame = a photo Fable cited for the sign or interior.`, size: 20 }] });
    gbpParts.push({ type: 'grid', items: gbpPhotos, cols: 3, cellH: 420, labelH: 40, showFirst });
  } else {
    usage.gbp_photos = { mode: 'none' };
    gbpParts.push({ type: 'gray', text: 'No Place photos were downloaded for this run (gbp-photos/gbp-photos.json missing or empty).', height: 110 });
  }
  let vibe = (be.selected_candidates ?? []).filter((c) => c.local_path && existsSync(c.local_path));
  let vibeLabel = 'Google Maps "Vibe" photos from the evidence build (Google\'s own in-store/atmosphere category)';
  if (!vibe.length) {
    vibe = (beManifest?.candidates ?? []).filter((c) => c.local_path && existsSync(c.local_path)).slice(0, 12);
    vibeLabel = 'In-store photos (search results): Google Maps photos fetched by the evidence build, no Vibe category was available';
  }
  if (vibe.length) {
    usage.vibe_photos = { mode: 'cached evidence', count: vibe.length, source: be.source ?? null };
    const items = vibe.slice(0, 12).map((c) => ({ file: c.local_path, label: `${c.category ?? 'photo'}${c.subtype && c.subtype !== 'vibe' ? ` / ${c.subtype}` : ''}${c.classification && c.classification !== 'unclassified' ? ` · ${c.classification}` : ''}${c.width ? `  ${c.width}x${c.height}` : ''}` }));
    gbpParts.push({ type: 'text', items: [{ text: vibeLabel, size: 20, gap: 10 }] }, { type: 'grid', items, cols: 3, cellH: 420, labelH: 40, showFirst: 6 });
  } else {
    usage.vibe_photos = { mode: 'none', reason: be.reason ?? 'no brand-environment photos in the evidence' };
    gbpParts.push({ type: 'gray', text: `No in-store (Vibe) photos in the evidence: ${usage.vibe_photos.reason}`, height: 100 });
  }
  if (mapsCapture?.ok) {
    usage.maps_view = { mode: mapsCapture.cached ? 'cached capture' : 'fresh screenshot', file: rel(runDir, mapsPng), opened_photos: mapsCapture.opened, vibe_tab: mapsCapture.vibe, notes: mapsCapture.notes };
    const cap = mapsCapture.cached ? 'Live Google Maps photo view, reused from the earlier capture under review/' : mapsCapture.opened ? (mapsCapture.vibe ? 'Live Google Maps, photo view, Vibe tab' : 'Live Google Maps, photo view (no Vibe tab found)') : 'Live Google Maps place page (photo view did not open; this is the place panel as loaded)';
    gbpParts.push({ type: 'text', items: [{ text: cap, size: 20, gap: 10 }, { text: mapsCapture.notes.join(' · '), size: 16, color: '#666666', gap: 4 }] }, { type: 'image', file: mapsPng, maxH: 1100, alt: 'Google Maps photo view' });
  } else if (args.skipGoogle) {
    usage.maps_view = { mode: 'skipped' };
    gbpParts.push({ type: 'gray', text: 'Live Google Maps photo view skipped (--skip-google) and no earlier capture under review/ to reuse.', height: 100 });
  } else {
    usage.maps_view = { mode: 'failed', notes: mapsCapture?.notes ?? ['not attempted'] };
    gbpParts.push({ type: 'gray', text: `Live Google Maps photo view not captured. ${(mapsCapture?.notes ?? ['not attempted']).join(' · ')}. The in-store photos above are the fallback.`, height: 110 });
  }
  sections.push({ id: 'gbp', title: 'Google Business Profile', subtitle: placeId ? `place id ${placeId}` : 'no place id on the request', links: gbpLinks, parts: gbpParts });

  // ---- 4. logo image search ---------------------------------------------------------------
  const query = `${name} ${cityOnly} logo`;
  const logoParts = [];
  if (liveLogo?.ok) {
    usage.logo_search = { mode: liveLogo.cached ? 'cached live-Chrome results' : 'fresh, live Chrome', source: liveLogo.source, count: liveLogo.results.length, dir: rel(runDir, logoSearchDir) };
    logoParts.push({ type: 'text', items: [{ text: `${liveLogo.source}: first ${liveLogo.results.length} results, thumbnails at the size Google serves them. Captions are Google's alt text.`, size: 20 }] });
    logoParts.push({ type: 'grid', items: liveLogo.results.slice(0, 24).map((r) => ({ file: r.file, label: `${r.alt || '(no caption)'}${r.w ? `  ${r.w}x${r.h}` : ''}`, href: r.page ?? null, hrefLabel: r.page ? new URL(r.page).hostname.replace(/^www\./, '') : null })), cols: 4, cellH: 280, labelH: 56, labelSize: 15 });
  } else if (args.skipGoogle) {
    usage.logo_search = { mode: 'skipped' };
    logoParts.push({ type: 'gray', text: 'Logo image search skipped (--skip-google) and no cached results under review/logo-search/.', height: 100 });
  } else if (logoCapture?.ok) {
    usage.logo_search = { mode: 'fresh screenshot', source: logoCapture.source, file: rel(runDir, logoSearchPng), notes: [...(liveLogo?.notes ?? []), ...logoCapture.notes] };
    logoParts.push({ type: 'text', items: [{ text: `Source: ${logoCapture.source}, first result rows at 1440x900 (${S}x).`, size: 20 }, { text: usage.logo_search.notes.join(' · '), size: 16, color: '#666666', gap: 4 }] }, { type: 'image', file: logoSearchPng, maxH: 1100, alt: 'logo image search' });
  } else {
    usage.logo_search = { mode: 'failed', notes: [...(liveLogo?.notes ?? []), ...(logoCapture?.notes ?? ['not attempted'])] };
    logoParts.push({ type: 'gray', text: `Logo image search not captured. ${usage.logo_search.notes.join(' · ')}`, height: 110 });
  }
  sections.push({ id: 'logo-search', title: 'Logo image search', subtitle: `"${query}"`, links: [{ label: 'Open Google Images', url: `https://www.google.com/search?tbm=isch&q=${gq(query)}` }], parts: logoParts });

  // ---- 5. logo candidates -----------------------------------------------------------------
  const candParts = [];
  const chosen = decision?.logo_choice ? path.resolve(abs(runDir, decision.logo_choice)) : null;
  const candidates = [...(evidence.logo_candidates ?? [])]
    .filter((c) => c.local_path && existsSync(c.local_path))
    .sort((a, b) => path.basename(a.local_path).localeCompare(path.basename(b.local_path)))
    .map((c) => {
      const isChosen = chosen && path.resolve(c.local_path) === chosen;
      return { file: c.local_path, label: `${path.basename(c.local_path)}  ${c.width}x${c.height}\n${candidateSourceLabel(c)}${isChosen ? '\nFABLE\'S PICK' : ''}`, frame: isChosen ? GREEN : null, bold: isChosen, bg: LOGO_BG, source: candidateSource(c, website) };
    });
  const rawFiles = [];
  try {
    for (const f of (await fs.readdir(path.join(runDir, 'candidates'))).sort()) {
      const hit = RAW_SOURCE_FILES.find(([re]) => re.test(f));
      if (hit && /\.(png|jpe?g|webp|gif)$/i.test(f)) rawFiles.push({ file: path.join(runDir, 'candidates', f), label: `${f}\n${hit[1]}`, bg: LOGO_BG });
    }
  } catch { /* no candidates dir */ }
  usage.candidates = { mode: 'cached evidence', evidence_candidates: candidates.length, raw_source_files: rawFiles.length };
  if (candidates.length) candParts.push({ type: 'grid', items: candidates, cols: 3, cellH: 300, labelH: 84, labelSize: 16, bg: LOGO_BG });
  else candParts.push({ type: 'gray', text: 'No logo candidates listed in the evidence packet.', height: 100 });
  if (rawFiles.length) {
    candParts.push({ type: 'text', items: [{ text: 'Raw source files the candidates were cut from', size: 22, bold: true, gap: 12 }] });
    candParts.push({ type: 'grid', items: rawFiles, cols: 4, cellH: 240, labelH: 56, labelSize: 16, bg: LOGO_BG });
  }
  sections.push({ id: 'candidates', title: 'Logo candidates', subtitle: 'from the evidence packet; green frame = the file Fable chose. Gray background so white knockouts stay visible.', links: website ? [{ label: 'Website', url: website }] : [], parts: candParts });

  // ---- 6. variant sheet: drawn by the browser from the sheet view (no png on the default path) ----------
  const sheetParts = [];
  if (sheetData) {
    const n = Object.keys(sheetData.cells).length;
    usage.sheet = { mode: 'html', file: rel(runDir, sheetJsonPath), revision: sheet?.revision ?? null, cells: n, png: sheetMeta ? rel(runDir, sheetPng) : null, native: sheetMeta ? `${sheetMeta.width}x${sheetMeta.height}` : null };
    sheetParts.push({ type: 'sheet', view: sheetData, focus, file: sheetMeta ? markedSheetFile : null, caption: `${rel(runDir, sheetJsonPath)} revision ${sheet?.revision ?? '?'}: ${n} cells drawn by the browser from the sheet JSON and the badge, sticker and POP templates (no app screenshots). Click cells to select two to five of them and Compare selected; click the grey background to toggle native size.` });
  } else {
    usage.sheet = { mode: 'missing' };
    sheetParts.push({ type: 'gray', text: 'variants/variant-sheet.json is missing; run variant-sheet.mjs build first.', height: 110 });
  }
  sections.push({ id: 'sheet', title: 'Variant sheet', subtitle: `${defaultLetter ? `Fable's default ${defaultLetter} framed in green. ` : ''}Reply with one letter.`, links: accountId ? [{ label: 'Boostly account branding', url: `https://new.boostly.com/admin/accounts/${accountId}` }] : [], parts: sheetParts });

  // ---- 7. links: the link automation results, one row per category ---------------------------
  const linkSec = linksSection({ runDir, sources: linkSources });
  if (linkSec) sections.push(linkSec);
  usage.links = linkSec ? { mode: `run data: ${linkSec.parts[1].rows.filter((r) => r.status.kind === 'held').length} held, ${linkSec.parts[1].rows.filter((r) => r.status.kind === 'written').length} written, ${linkSec.parts[1].rows.filter((r) => r.status.kind === 'pending').length} pending`, rows: linkSec.parts[1].rows.length, held: linkSec.parts[1].rows.filter((r) => r.status.kind === 'held').length, written: linkSec.parts[1].rows.filter((r) => r.status.kind === 'written').length, pending: linkSec.parts[1].rows.filter((r) => r.status.kind === 'pending').length, report: linkSources.report ? rel(runDir, linkSources.report.file) : null } : { mode: 'none' };

  // ---- 8. previews: post-pick signage shots and AI mockups, only when the files exist --------
  const previews = await collectPreviews(reviewDir);
  const previewSec = previewsSection({ runDir, reviewDir, previews, sheet, run, provenanceWords });
  if (previewSec) sections.push(previewSec);
  const previewLetters = Object.fromEntries(Object.entries(previews.letters).map(([l, g]) => [l, { signage: g.signage ? rel(runDir, g.signage) : null, mockups: g.mockups.map((m) => rel(runDir, m.file)), pick: pickStatus(l, sheet, run) }]));
  usage.previews = { mode: Object.keys(previewLetters).length ? 'cached files' : 'none', letters: previewLetters, prompts: previews.promptsFile ? rel(runDir, previews.promptsFile) : null, png: null };

  // ---- compose ------------------------------------------------------------------------------
  // The page needs the template script next to it (the public site copies small .js files locally).
  await fs.copyFile(TEMPLATES_FILE, path.join(reviewDir, 'sheet-templates.js'));
  let size = { width: null, height: null, skipped: {} };
  if (args.png) {
    // Signage previews drawn from a spec need pixels in the PNG: render each once in memory to its png file.
    const specs = Object.entries(previews.letters).filter(([, g]) => g.signage_spec);
    if (specs.length) {
      const { withBrowser, renderSignagePng } = await import('./render-preview.mjs');
      await withBrowser(async (browser) => {
        for (const [letter, g] of specs) {
          const file = path.join(reviewDir, `signage-preview-${letter}.png`);
          await fs.writeFile(file, await renderSignagePng(g.signage_spec.spec, { baseDir: reviewDir, browser, src: srcFromReview }));
          g.signage = file;
          const part = previewSec?.parts.find((p) => p.type === 'signage' && p.letter === letter);
          if (part) part.file = file;
        }
      });
    }
    size = await renderPng(sections, canvasFile, { budgetBytes: args.pngBudgetMb * 1e6 });
  }
  const previewSkip = size.skipped?.previews ?? null;
  usage.previews.png = !args.png ? 'not rendered (--png)' : previewSkip ? `skipped: ${previewSkip.reason}` : (Object.keys(previewLetters).length ? 'included at reduced width' : 'none to include');
  if (previewSkip && previewSec) previewSec.parts.push({ type: 'text', items: [{ text: `Not in review-canvas.png: the previews ${previewSkip.reason}. This page and the files above are the review surface for them.`, size: 18, color: '#8A1C1C', bold: true, gap: 10 }] });
  // compare-default (rule 12): built by the canvas itself whenever a default exists; the header links it.
  if (defaultLetter && sheet?.cells?.[defaultLetter]) {
    try {
      const c = await compare({ args: { ...args, cells: null, open: false, html: true }, runDir, reviewDir, run, sheet, quiet: true });
      usage.compare_default = { cells: c.cells, html: rel(runDir, c.html), png: c.png ? rel(runDir, c.png) : null };
    } catch (err) {
      usage.compare_default = { error: String(err.message ?? err).slice(0, 200) };
    }
  }
  if (args.html) await fs.writeFile(htmlFile, renderHtml(sections, { title: `${name} review`, reviewDir, runDir }));
  else await fs.rm(htmlFile, { force: true });
  const record = {
    png: args.png ? rel(runDir, canvasFile) : null,
    html: args.html ? rel(runDir, htmlFile) : null,
    generated_at: new Date().toISOString(),
    width: size.width,
    height: size.height,
    scale: S,
    render: 'html',
    fable_default_letter: defaultLetter,
    flag: flag ? { letter: flag.letter, flag: flag.flag, native_px: flag.native_px } : null,
    sheet_revision: sheet?.revision ?? null,
    sections: usage,
  };
  await fs.writeFile(path.join(reviewDir, 'review-canvas.json'), `${JSON.stringify(record, null, 2)}\n`);
  const recorded = args.record ? await recordReviewCanvas(runDir, record) : { ok: true, skipped: '--no-record' };
  console.log(JSON.stringify({ ok: true, canvas: args.png ? canvasFile : null, html: args.html ? htmlFile : null, width: size.width, height: size.height, sections: usage, run_file: recorded }, null, 2));
  openOutputs(record);
}

// ---------------------------------------------------------------------------------------------
// compare: shortlisted cells side by side (card, sticker, POP) with every color and its provenance
// (Chuy's 2026-09-17/18: "show a preview with these next to each other", asked three times)
// ---------------------------------------------------------------------------------------------
async function compare({ args, runDir, reviewDir, run, sheet, quiet = false }) {
  if (!sheet) throw new Error('compare needs variants/variant-sheet.json; run variant-sheet.mjs build first');
  const { provenanceWords, sheetView, normalizeManifest } = await import(path.join(SCRIPT_DIR, 'variant-sheet.mjs'));
  // No --cells (rule 12, 2026-10-19): the default plus the strongest cell of every other row (Franks "add I").
  const shortlist = Boolean(args.cells?.length);
  const defaultLetter = sheet.fable_default_letter ?? run.variants?.fable_default_letter ?? null;
  const letters = shortlist ? args.cells : compareDefaultLetters(sheet, defaultLetter);
  if (!letters.length) throw new Error(`compare needs --cells <letter,letter,...> or a default letter on the sheet (fable_default_letter is ${defaultLetter ?? 'empty'})`);
  const missing = letters.filter((l) => !sheet.cells?.[l]);
  if (missing.length) throw new Error(`cells not on the sheet: ${missing.join(', ')} (have ${Object.keys(sheet.cells ?? {}).join(', ')})`);
  const name = run.request?.identity?.account_name ?? run.request?.location_name ?? path.basename(runDir);
  if (!sheet.run_dir) sheet.run_dir = runDir;
  const view = sheetView(normalizeManifest(sheet, path.join(runDir, 'variants')));
  const src = (relPath) => path.relative(reviewDir, path.join(runDir, relPath)).split(path.sep).map(encodeURIComponent).join('/');
  const provenance = { primary: {}, secondary: {} };
  for (const letter of letters) {
    const cell = sheet.cells[letter];
    const row = sheet.rows.find((r) => r.key === cell.row);
    if (row?.primary_source) provenance.primary[letter] = provenanceWords(row.primary_source);
    provenance.secondary[letter] = provenanceWords(cell.secondary_source, cell.secondary_label);
  }
  const slug = shortlist ? letters.join('-') : 'default';
  const pngFile = path.join(reviewDir, `compare-${slug}.png`);
  const htmlFile = path.join(reviewDir, `compare-${slug}.html`);
  const grid = templates.compareHtml(view, letters, { src, colW: 300, provenance });
  const intro = shortlist ? 'Card, sticker, and POP for each shortlisted cell' : `Fable's default ${esc(defaultLetter)} next to the strongest cell of every other row (card, sticker, and POP)`;
  const body = `<h1>${esc(name)}: compare ${esc(letters.join(', '))}</h1><p>${intro}; every color with where it came from. Reply with one letter.</p>${grid}`;
  const page = templates.pageHtml(body, { title: `${name} compare ${letters.join(', ')}`, extraCss: `body{font-family:${FONT};margin:24px;background:#fff;color:#111}h1{font-size:28px}` });
  if (args.html) await fs.writeFile(htmlFile, page);
  let png = null;
  if (args.png) {
    const { renderHtmlPng } = await import('./render-preview.mjs');
    const cols = Math.min(letters.length, 5);
    await fs.writeFile(pngFile, await renderHtmlPng(page, { baseDir: reviewDir, width: cols * 324 + 60, height: 900, scale: 2, fullPage: true }));
    png = pngFile;
  }
  const result = { ok: true, command: 'compare', cells: letters, png, html: args.html ? htmlFile : null };
  if (!quiet) console.log(JSON.stringify(result, null, 2));
  if (args.open) { if (png) spawnSync('open', ['-a', 'Preview', png]); if (args.html) spawnSync('open', [htmlFile]); }
  return result;
}

/**
 * compare-default letters: Fable's default first, then for every other row the cell with the highest passing
 * web-digit contrast (tie: the column nearest the default's), dark-step and site-token columns included.
 * Rejected cells never enter. Exported for tests.
 */
export function compareDefaultLetters(sheet, defaultLetter) {
  const def = defaultLetter ? sheet?.cells?.[defaultLetter] : null;
  if (!def) return [];
  const cells = Object.values(sheet.cells).filter((c) => c?.letter && c.status !== 'rejected');
  const defCol = def.column_index ?? 0;
  const strength = (c) => Number(c.badge_digit_web?.contrast_with_text) || 0;
  const nearer = (a, b) => Math.abs((a.column_index ?? 0) - defCol) - Math.abs((b.column_index ?? 0) - defCol);
  const out = [defaultLetter];
  for (const row of sheet.rows ?? []) {
    if (row.key === def.row) continue;
    const inRow = cells.filter((c) => c.row === row.key);
    if (!inRow.length) continue;
    const passing = inRow.filter((c) => c.badge_digit_web?.pass !== false);
    const best = (passing.length ? passing : inRow).sort((a, b) => strength(b) - strength(a) || nearer(a, b) || String(a.letter).localeCompare(String(b.letter)))[0];
    out.push(best.letter);
  }
  return out;
}

/**
 * The small-source flag on Fable's default (rule 5, 2026-10-19): read from the sheet's default_flag, else from the
 * decision marks (sheet.decision_marks or run.decision.marks). Null when there is no default or no trace flag.
 * Exported for tests.
 */
export function defaultFlag(sheet, run, defaultLetter) {
  if (!defaultLetter) return null;
  const df = sheet?.default_flag ?? sheet?.flag;
  if (df?.flag && (!df.letter || df.letter === defaultLetter)) return { letter: defaultLetter, flag: df.flag, native_px: df.native_px ?? null, words: flagWords(df.flag, df.native_px) };
  const marks = sheet?.decision_marks ?? run?.decision?.marks ?? null;
  if (marks?.traced_from_small_source) return { letter: defaultLetter, flag: 'traced_from_small_source', native_px: marks.source_native_longest_px ?? null, words: flagWords('traced_from_small_source', marks.source_native_longest_px) };
  return null;
}
function flagWords(flag, px) { return flag === 'traced_from_small_source' ? `traced from ${px ?? '?'}px` : String(flag).replace(/_/g, ' '); }

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
