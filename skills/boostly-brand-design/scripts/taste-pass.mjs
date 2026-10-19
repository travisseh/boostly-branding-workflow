#!/usr/bin/env node
// taste-pass.mjs: the variant TASTE PASS (Travisse 2026-10-15). After the variant sheet is built and
// before the review canvas, Fable looks at the sheet the way Travisse does and proposes the GOOD
// cells it lacks (alternate real brand grounds, two-tone swaps, words-only / badge / stacked lockups
// from existing pixels, a dropped descriptor). Fable only proposes; this script does everything
// deterministic around it:
//
//   brief     --run <run_dir> [--cap 6] [--no-raster]
//             Collect every real color with its source (logo inks of every candidate, site theme
//             tokens, computed site surfaces, first-party CSS variables, the in-store dominant,
//             Instagram recurring colors, the decision palette, the sheet's own columns), every
//             existing asset the pass may put on a card, the sheet as built, and the evidence image
//             paths, into <run>/taste/brief.json; fill references/taste-pass-prompt-template.md into
//             <run>/taste/taste-prompt.md. Rasterizes variants/variant-sheet.png when missing.
//   validate  --run <run_dir> [--proposals <file>] [--model fable|opus]
//             Validate <run>/taste/proposals.json (the file the subagent writes) against the brief:
//             structure and cap, every color a brief color (or black/white, or a DARKER step of a
//             brief color; a lighter tint is refused), the primary not near-white, the logo an
//             existing asset or an allowed derivation (crop / stack / cut_words) of one, no
//             duplicate of an existing cell. Resolves the text and print digit by the web/print
//             split rule and labels light grounds for escalation. Writes <run>/taste/validation.json.
//   apply     --run <run_dir> [--model fable|opus] [--dry-run]
//             Validate, build each derived asset into <run>/taste/assets/, run `gates.ts check` on
//             the card (a HOLD on a gate the registry cannot override keeps the cell off the sheet;
//             an overridable HOLD is added with a "needs override" note), add the accepted cells
//             with `variant-sheet.mjs add-cell` (its sheet-viability gate still decides), record the
//             `taste` block in run.json, and print the one-line note for checklist/notes.json.
//
// Never synthesizes a mark, never retypes a wordmark, never upscales: a derived asset is pixels of
// one existing asset cropped, trimmed, stacked or component-cut (cut-words.mjs). The subagent is
// launched by the orchestrator with the Agent tool (model fable, opus when Fable is rate limited;
// --model records which one ran); nothing here calls a model.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contrast, normalizeHex, shiftLightness } from './variant-sheet.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const HARNESS_DIR = path.join(SKILL_DIR, 'harness');
const require = createRequire(path.join(HARNESS_DIR, 'package.json'));
const sharp = require('sharp');

const TEMPLATE = path.join(SKILL_DIR, 'references', 'taste-pass-prompt-template.md');
const GATES_REGISTRY = path.join(SKILL_DIR, 'references', 'gates.json');
const RUN_FILE = path.resolve(SKILL_DIR, '..', 'boostly-box-fulfillment', 'scripts', 'run-file.ts');
const VARIANT_SHEET = path.join(SCRIPT_DIR, 'variant-sheet.mjs');
const GATES = path.join(SCRIPT_DIR, 'gates.ts');
const CUT_WORDS = path.join(SCRIPT_DIR, 'cut-words.mjs');

export const DEFAULT_CAP = 6;
export const MODELS = ['fable', 'opus'];
export const PATTERNS = ['alt_ground', 'two_tone_swap', 'words_only', 'stacked', 'drop_descriptor', 'badge', 'icon_only', 'other'];
export const DERIVE_OPS = ['crop', 'stack', 'cut_words'];
const COLOR_MATCH_DISTANCE = 24;          // same rule as validate-fable-decision: within this RGB distance IS that color
const INK_MIN_SHARE = 0.01;               // a logo ink enters the brief at 1% (Scoops' scoop pink was sampled, not a top ink)
const SYNTHETIC_MAX_HUE_DELTA = 12;
const SYNTHETIC_MAX_SAT_DELTA = 0.2;
const SYNTHETIC_MIN_LIGHTNESS_DELTA = 0.04;
const NEUTRAL_MAX_SATURATION = 0.06;
const LIGHT_GROUND_CONTRAST = 3.0;        // under this against white the card is a light ground (escalate: no override on component-contrast / sticker on white)
const DIGIT_MIN_CONTRAST = 3.0;
const BAND_MIN_CONTRAST = 1.15;           // a band this close to the card is the card (the sheet's own -10% steps sit near 1.3:1 and are real cells)
const CSS_VAR_SKIP = /^--(bs|mui|tw|swiper|fa|wp--style)-/i;   // framework defaults are not brand colors
const MAX_ASSETS = 48;

// ---- small color helpers ----------------------------------------------------------------------
function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function distance(a, b) { const x = rgb(a); const y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }
export function hsl(hex) {
  const [R, G, B] = rgb(hex).map((v) => v / 255);
  const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min; const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) * 60; else if (max === G) h = ((B - R) / d + 2) * 60; else h = ((R - G) / d + 4) * 60;
  return { h, s, l };
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (file) => sha256(readFileSync(file));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const asArray = (v) => (Array.isArray(v) ? v : []);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'cell';
const nowIso = () => new Date().toISOString();

// ---- args ---------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const args = { command: null, cap: DEFAULT_CAP, raster: true, dryRun: false, model: 'fable' };
  const list = [...argv];
  if (list[0] && !list[0].startsWith('--')) args.command = list.shift();
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i]; const next = list[i + 1];
    const take = () => { i += 1; return next; };
    switch (t) {
      case '--run': args.run = take(); break;
      case '--cap': args.cap = Number(take()); break;
      case '--proposals': args.proposals = take(); break;
      case '--model': args.model = take(); break;
      case '--no-raster': args.raster = false; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument ${t}`);
    }
  }
  if (!['brief', 'validate', 'apply'].includes(args.command ?? '')) throw new Error('Usage: taste-pass.mjs brief|validate|apply --run <run_dir> [--cap N] [--no-raster] [--proposals <file>] [--model fable|opus] [--dry-run]');
  if (!args.run) throw new Error('--run <run_dir> is required');
  if (!MODELS.includes(args.model)) throw new Error(`--model must be one of ${MODELS.join('|')}, got ${args.model}`);
  if (!Number.isInteger(args.cap) || args.cap < 1) throw new Error('--cap must be a positive integer');
  return args;
}

// ---- brief: colors ------------------------------------------------------------------------------
/** Add a color to the list: one entry per hex (first source wins the `source`, the rest land in `also`). */
function addColor(colors, hex, source, detail = null, extra = {}) {
  const norm = normalizeHex(hex ?? '');
  if (!norm) return;
  const entry = colors.find((c) => c.hex === norm);
  if (entry) { entry.also.push({ source, detail }); return; }
  colors.push({ hex: norm, source, detail, also: [], ...extra });
}

/** Every real color the pass may use, with its source in plain words. Exported for tests. */
export function collectColors({ packet = {}, sheet = {}, decision = {}, cssVars = [], surfaces = [], sampled = [] }) {
  const colors = [];
  for (const [role, hex] of Object.entries(asObject(decision.palette))) addColor(colors, hex, 'decision_palette', role);
  for (const c of asArray(packet.logo_candidates)) {
    const file = path.basename(String(c.local_path ?? ''));
    for (const ink of asArray(c.measured_colors)) {
      const share = Number(ink.pixel_share) || 0;
      if (share < INK_MIN_SHARE) continue;
      addColor(colors, ink.hex, 'logo_ink', `${(share * 100).toFixed(1)}% of ${file} (${c.provenance ?? 'unknown provenance'})`, { share, candidate: file });
    }
    for (const g of asArray(c.gradient_families)) addColor(colors, g.center ?? g.hex, 'logo_ink', `gradient family center of ${file}`);
  }
  // SAMPLED PALETTE (Scoops' scoop pink, 2026-10-15): the packet's measured_colors are the top clusters; a secondary
  // brand ink at 2-5% (the pink scoop) only shows in the quantized palette of the candidate file.
  for (const p of sampled) addColor(colors, p.hex, 'logo_sampled', `${(p.share * 100).toFixed(1)}% of ${p.file}, quantized palette (sampled, not a measured ink)`, { share: p.share, candidate: p.file });
  for (const t of asArray(asObject(packet.website).authored_color_tokens)) {
    if (t.evidence_class !== 'theme_authored') continue;
    addColor(colors, t.hex, 'site_token', `theme-authored site token${t.semantic_count ? `, ${t.semantic_count} semantic uses` : ''}`);
  }
  for (const s of surfaces) {
    if (s.visible === false) continue;
    addColor(colors, s.background_color, 'site_surface', `${s.role ?? s.selector ?? 'surface'} background (${s.viewport ?? 'desktop'})`);
    addColor(colors, s.text_color, 'site_surface', `${s.role ?? s.selector ?? 'surface'} text (${s.viewport ?? 'desktop'})`);
  }
  for (const v of cssVars) addColor(colors, v.hex, 'site_css_var', `${v.name} in ${v.file}`);
  const instore = asObject(sheet.instore_dominant);
  if (instore.hex) addColor(colors, instore.hex, 'instore', `dominant saturated hue across ${instore.images ?? '?'} in-store photos, ${((instore.share ?? 0) * 100).toFixed(0)}% share${instore.added ? ' (already a sheet row)' : ''}`);
  for (const ig of instagramColors(packet)) addColor(colors, ig.hex, 'instagram_recurring', ig.detail);
  for (const col of asArray(sheet.columns)) addColor(colors, col.hex, 'sheet_column', `${col.label ?? col.source ?? 'column'} (already a band column)`);
  if (sheet.primary) addColor(colors, sheet.primary, 'sheet_primary', 'the sheet card primary');
  if (sheet.text) addColor(colors, sheet.text, 'sheet_text', 'the sheet text color');
  for (const row of asArray(sheet.rows)) {
    if (row.primary) addColor(colors, row.primary, 'sheet_row_primary', `row "${row.label ?? row.key}" card`);
    if (row.text) addColor(colors, row.text, 'sheet_row_text', `row "${row.label ?? row.key}" text`);
  }
  // neutrals last, so a real source (the Pig & Parrot header's black disc at 62%) names black when the brand owns it
  addColor(colors, '#000000', 'neutral', 'black');
  addColor(colors, '#FFFFFF', 'neutral', 'white (text only; never a card)');
  return colors;
}

const PALETTE = path.join(HARNESS_DIR, 'colors.mjs');
const SAMPLED_MIN_SHARE = 0.02;
/** Quantized palette of a candidate file through the harness extractor (top entries at 2%+). */
export function sampledPalette(file, minShare = SAMPLED_MIN_SHARE) {
  const r = run('node', [PALETTE, 'palette', file]);
  const json = r.status === 0 ? (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() : null;
  return asArray(json).filter((p) => typeof p.hex === 'string' && (p.population ?? 0) >= minShare).slice(0, 8).map((p) => ({ hex: p.hex.toUpperCase(), share: Number(p.population.toFixed(4)), file: path.basename(file) }));
}

/** Instagram recurring colors, wherever the packet keeps them (shape varies by evidence version). */
function instagramColors(packet) {
  const out = [];
  const walk = (v, depth) => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    const cls = String(v.evidence_class ?? v.class ?? v.classification ?? '');
    if (typeof v.hex === 'string' && /instagram_recurring/.test(cls)) out.push({ hex: v.hex, detail: `recurring on branded Instagram posts${v.count ? ` (${v.count})` : ''}` });
    Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(packet.instagram, 0);
  return out;
}

/** `--name: #hex` custom properties from the first-party site files kept in <run>/website. Exported for tests. */
export function cssVarsFrom(files) {
  const out = []; const seen = new Set();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
      if (CSS_VAR_SKIP.test(m[1])) continue;
      const key = `${m[1]}=${m[2].toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: m[1], hex: m[2].toUpperCase(), file: path.basename(file) });
    }
  }
  return out.slice(0, 24);
}

// ---- brief: assets and images --------------------------------------------------------------------
function listPngs(dir, depth = 2) {
  if (!existsSync(dir) || depth < 0) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    let st; try { st = statSync(file); } catch { continue; }
    if (st.isDirectory()) { if (!/node_modules|cells|raw|proof$/.test(name)) out.push(...listPngs(file, depth - 1)); continue; }
    if (/\.png$/i.test(name) && !/-upload|compare|contact-sheet|review-canvas|variant-sheet|card-[A-Z]{1,2}\.png$|^(sticker|pop)-/i.test(name)) out.push(file);
  }
  return out;
}

async function describeAsset(file, kind, extra = {}) {
  const meta = await sharp(file).metadata().catch(() => ({}));
  return { path: file, kind, bytes: statSync(file).size, width: meta.width ?? null, height: meta.height ?? null, has_alpha: meta.hasAlpha ?? null, sha256: fileSha(file), ...extra };
}

/** Every existing asset the pass may put on a card: packet candidates, sheet rows and stickers, fix/ and candidates/ PNGs. */
export async function collectAssets(runDir, { packet = {}, sheet = {} }) {
  const seen = new Map();
  const add = async (file, kind, extra = {}) => {
    if (!file || seen.has(file) || !existsSync(file) || seen.size >= MAX_ASSETS) return;
    seen.set(file, await describeAsset(file, kind, extra));
  };
  for (const c of asArray(packet.logo_candidates)) {
    await add(str(c.local_path), 'logo_candidate', { provenance: c.provenance ?? null, source: str(c.source)?.slice(0, 160) ?? null, derivation: c.derivation ?? 'native', inks: asArray(c.measured_colors).filter((i) => (i.pixel_share ?? 0) >= INK_MIN_SHARE).map((i) => ({ hex: i.hex, share: i.pixel_share })) });
  }
  for (const row of asArray(sheet.rows)) {
    await add(str(row.logo), 'sheet_row_logo', { row: row.key, label: row.label, knockout: Boolean(row.knockout) });
    await add(str(row.sticker_logo), 'sheet_row_sticker', { row: row.key });
  }
  await add(str(sheet.sticker_logo), 'sheet_sticker_logo');
  for (const file of listPngs(path.join(runDir, 'fix'), 3)) await add(file, 'fix_asset');
  for (const file of listPngs(path.join(runDir, 'candidates'), 0)) await add(file, 'candidate_file');
  return [...seen.values()];
}

function collectImages(runDir, packet, sheet) {
  const vis = path.join(runDir, 'evidence', 'website-visual');
  const website = ['desktop.png', 'mobile.png'].map((f) => path.join(vis, f)).filter(existsSync);
  const gbpDir = path.join(runDir, 'gbp-photos');
  const gbp = existsSync(gbpDir) ? readdirSync(gbpDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => path.join(gbpDir, f)) : [];
  const env = asObject(packet.brand_environment);
  const contactSheet = [str(env.contact_sheet), path.join(runDir, 'evidence', 'brand-environment', 'contact-sheet.jpg')].find((f) => f && existsSync(f)) ?? null;
  const candidates = asArray(packet.logo_candidates).map((c) => str(c.local_path)).filter((f) => f && existsSync(f));
  const sheetPng = path.join(runDir, 'variants', 'variant-sheet.png');
  return { sheet_png: existsSync(sheetPng) ? sheetPng : null, sheet_html: str(sheet.sheet_html) ?? path.join(runDir, 'variants', 'variant-sheet.html'), website, gbp_photos: gbp, brand_environment_contact_sheet: contactSheet, logo_candidates: candidates };
}

function sheetSummary(sheet) {
  return {
    business_name: sheet.business_name ?? null,
    primary: sheet.primary ?? null,
    text: sheet.text ?? null,
    light_primary: Boolean(sheet.light_primary),
    fable_default_letter: sheet.fable_default_letter ?? null,
    hold: sheet.hold ?? null,
    columns: asArray(sheet.columns).map((c) => ({ index: c.index, hex: c.hex, source: c.source, label: c.label, one_off: Boolean(c.one_off) })),
    rows: asArray(sheet.rows).map((r) => ({ key: r.key, label: r.label, logo: r.logo, sticker_logo: r.sticker_logo ?? null, primary: r.primary ?? null, text: r.text ?? null, knockout: Boolean(r.knockout), note: r.note ?? null, added_by: r.added_by ?? null })),
    cells: Object.values(asObject(sheet.cells)).map((c) => ({ letter: c.letter, row: c.row, secondary: c.secondary, primary: c.view?.card?.primary ?? null, status: c.status ?? null, note: c.note ?? null })),
    skipped: asArray(sheet.skipped).map((s) => ({ kind: s.kind ?? 'row', row: s.row, column: s.column ?? null, verdict: s.verdict, label: s.label ?? null })),
  };
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
/** The last JSON object a CLI printed (stderr carries node warnings; stdout may carry skip lines first). */
function lastJson(stdout) {
  const i = stdout.lastIndexOf('\n{');
  const text = i >= 0 ? stdout.slice(i + 1) : stdout.trim().startsWith('{') ? stdout : null;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function brief(args) {
  const runDir = path.resolve(args.run);
  const sheetFile = path.join(runDir, 'variants', 'variant-sheet.json');
  if (!existsSync(sheetFile)) throw new Error(`no variant sheet at ${sheetFile}; build it first (variant-sheet.mjs build)`);
  const sheet = readJson(sheetFile);
  const packetFile = path.join(runDir, 'evidence', 'branding-evidence.json');
  const packet = existsSync(packetFile) ? readJson(packetFile) : {};
  const decisionFile = path.join(runDir, 'decision.json');
  const decision = existsSync(decisionFile) ? readJson(decisionFile) : asObject(sheet.decision);
  const runJson = existsSync(path.join(runDir, 'run.json')) ? readJson(path.join(runDir, 'run.json')) : {};
  const name = str(asObject(runJson.request).location_name) ?? str(sheet.business_name) ?? path.basename(runDir);
  const surfacesFile = path.join(runDir, 'evidence', 'website-visual', 'computed-styles.json');
  const surfaces = existsSync(surfacesFile) ? asArray(readJson(surfacesFile).surfaces) : [];
  const siteDir = path.join(runDir, 'website');
  const siteFiles = existsSync(siteDir) ? readdirSync(siteDir).filter((f) => /\.css$/i.test(f) || /^curl-(home|index)\.html$/i.test(f)).map((f) => path.join(siteDir, f)) : [];
  const cssVars = cssVarsFrom(siteFiles);
  const sampled = asArray(packet.logo_candidates).map((c) => str(c.local_path)).filter((f) => f && existsSync(f)).flatMap((f) => sampledPalette(f));
  const colors = collectColors({ packet, sheet, decision, cssVars, surfaces, sampled });
  const assets = await collectAssets(runDir, { packet, sheet });
  if (args.raster && !existsSync(path.join(runDir, 'variants', 'variant-sheet.png'))) {
    const r = run('node', [VARIANT_SHEET, 'restitch', '--run-dir', runDir, '--raster']);
    if (r.status !== 0) process.stderr.write(`sheet raster failed (continuing without it): ${(r.stderr || r.stdout).trim().slice(-400)}\n`);
  }
  const images = collectImages(runDir, packet, sheet);
  const tasteDir = path.join(runDir, 'taste');
  mkdirSync(tasteDir, { recursive: true });
  const out = {
    schema: 1,
    generated_at: nowIso(),
    run_dir: runDir,
    business_name: name,
    cap: args.cap,
    decision: { logo_choice: decision.logo_choice ?? null, palette: asObject(decision.palette), composition: str(decision.composition)?.slice(0, 1200) ?? null, flags: asArray(decision.flags), marks: asObject(sheet.decision_marks) },
    sheet: sheetSummary(sheet),
    colors,
    assets,
    images,
    rules: {
      cap: args.cap,
      colors: 'every hex must be a listed color (within 24 RGB) or black/white; a DARKER step (-10%/-20% lightness, same hue) of a listed color is the one allowed synthetic; lighter tints are refused',
      primary: 'never white or near-white (1.3:1 floor against white); under 3:1 is a light ground and is labeled for escalation',
      logo: `an asset path from assets[] or a derivation (${DERIVE_OPS.join(', ')}) of one; no synthesized marks, no retyped wordmarks, no AI upscaling`,
      dedupe: 'a proposal that matches an existing cell (same logo pixels, card and band) is refused',
    },
  };
  const briefFile = path.join(tasteDir, 'brief.json');
  writeFileSync(briefFile, `${JSON.stringify(out, null, 2)}\n`);
  const prompt = fillTemplate(readFileSync(TEMPLATE, 'utf8'), { runDir, name, cap: args.cap, images });
  const promptFile = path.join(tasteDir, 'taste-prompt.md');
  writeFileSync(promptFile, prompt);
  process.stdout.write(`${JSON.stringify({ ok: true, command: 'brief', brief: briefFile, prompt: promptFile, colors: colors.length, assets: assets.length, sheet_png: images.sheet_png, cells: out.sheet.cells.length, cap: args.cap }, null, 2)}\n`);
}

/** The prompt body (after the `---` separator) with the placeholders filled. Exported for tests. */
export function fillTemplate(template, { runDir, name, cap, images }) {
  const body = template.includes('\n---\n') ? template.slice(template.indexOf('\n---\n') + 5) : template;
  const list = (arr) => (arr && arr.length ? arr.join(', ') : 'none captured');
  return body
    .replaceAll('{RUN_DIR}', runDir)
    .replaceAll('{NAME}', name)
    .replaceAll('{CAP}', String(cap))
    .replaceAll('{SHEET_PNG}', images.sheet_png ?? `${images.sheet_html} (no raster; open the html)`)
    .replaceAll('{WEBSITE_IMAGES}', list(images.website))
    .replaceAll('{PHOTO_DIR}', images.gbp_photos.length ? path.dirname(images.gbp_photos[0]) : 'none captured')
    .replaceAll('{LOGO_CANDIDATES}', list(images.logo_candidates))
    .replaceAll('{CONTACT_SHEET}', images.brand_environment_contact_sheet ?? 'none captured');
}

// ---- validate -------------------------------------------------------------------------------------
/** Where a proposed color comes from: a listed color, a darker step of one, or nowhere. Exported for tests. */
export function colorSource(hex, colors) {
  const norm = normalizeHex(hex ?? '');
  if (!norm) return { ok: false, reason: 'invalid_hex' };
  let best = null;
  for (const c of colors) { const d = distance(c.hex, norm); if (d < COLOR_MATCH_DISTANCE && (!best || d < best.d)) best = { c, d }; }
  if (best) return { ok: true, hex: norm, matched: best.c.hex, source: best.c.source, detail: best.c.detail, synthetic: null };
  const s = hsl(norm);
  if (s.s < NEUTRAL_MAX_SATURATION) return { ok: false, hex: norm, reason: 'color_not_in_evidence', note: 'a gray that no evidence carries; use black, white, or a listed neutral' };
  let step = null;
  for (const c of colors) {
    const b = hsl(c.hex);
    if (b.s < NEUTRAL_MAX_SATURATION) continue;
    const hueDelta = Math.abs(((s.h - b.h + 540) % 360) - 180);
    if (hueDelta > SYNTHETIC_MAX_HUE_DELTA || Math.abs(s.s - b.s) > SYNTHETIC_MAX_SAT_DELTA) continue;
    const delta = s.l - b.l;
    if (Math.abs(delta) < SYNTHETIC_MIN_LIGHTNESS_DELTA) continue;
    if (!step || Math.abs(delta) < Math.abs(step.delta)) step = { of: c, delta };
  }
  if (!step) return { ok: false, hex: norm, reason: 'color_not_in_evidence' };
  // A lighter step is allowed only off a SAMPLED base (a photo sample is shadowed; the lift de-shadows it:
  // Koshari, Mad Fish, Creamer). Off an authored token or a measured ink it stays refused.
  if (step.delta > 0 && !isSampledSource(step.of)) return { ok: false, hex: norm, reason: 'color_lighter_synthetic', note: `a lighter tint of ${step.of.hex} (${step.of.source}); never a pick` };
  return { ok: true, hex: norm, matched: step.of.hex, source: step.of.source, detail: step.of.detail, synthetic: { direction: step.delta > 0 ? 'lighter' : 'darker', of: step.of.hex, lightness_delta: Number(step.delta.toFixed(3)) } };
}
/** Photo or site samples (never a logo palette, which is a mark ink): same five names as validate-fable-decision.ts SAMPLED_COLOR_SOURCES. */
export const SAMPLED_SOURCES = ['instore', 'instagram_recurring', 'sampled', 'second_chroma_sampled', 'second_chroma_lifted'];
export function isSampledSource(color) {
  if (!color) return false;
  const sources = [color.source, ...asArray(color.also).map((a) => a.source)];
  return sources.some((s) => SAMPLED_SOURCES.includes(String(s ?? '')));
}

/**
 * Web/print split (Boludo U, 2026-10-01): the web card has one text color for name and digit, print has its own
 * digit color. Pick the web text that reads on the card AND on the band when one does; otherwise the one that
 * reads on the card, and give print its own digit. Exported for tests.
 */
export function resolveText({ primary, secondary, text, sheetText, printDigit }) {
  const order = [text, sheetText, '#FFFFFF', '#000000'].map((h) => normalizeHex(h ?? '')).filter(Boolean);
  const both = order.find((h) => contrast(h, primary) >= DIGIT_MIN_CONTRAST && contrast(h, secondary) >= DIGIT_MIN_CONTRAST);
  // nothing reads on both: take the card-legible text that fares best on the band (Boludo U: white over gold-on-gold)
  const cardOnly = order.filter((h) => contrast(h, primary) >= DIGIT_MIN_CONTRAST).sort((x, y) => contrast(y, secondary) - contrast(x, secondary))[0];
  const webText = both ?? cardOnly ?? order[0];
  const notes = [];
  if (text && webText !== normalizeHex(text)) notes.push(`web text ${webText} instead of ${normalizeHex(text)} (${normalizeHex(text)} is ${contrast(normalizeHex(text), primary).toFixed(2)}:1 on the card, ${contrast(normalizeHex(text), secondary).toFixed(2)}:1 on the band)`);
  let digit = printDigit ? normalizeHex(printDigit) : null;
  if (!digit && contrast(webText, secondary) < DIGIT_MIN_CONTRAST) {
    digit = contrast('#FFFFFF', secondary) >= contrast('#000000', secondary) ? '#FFFFFF' : '#000000';
    notes.push(`print digit ${digit} (web text ${webText} is ${contrast(webText, secondary).toFixed(2)}:1 on the band)`);
  }
  return { text: webText, print_digit: digit, web_digit_contrast: Number(contrast(webText, secondary).toFixed(2)), card_contrast: Number(contrast(webText, primary).toFixed(2)), notes };
}

function logoOf(proposal, brief, errors) {
  const logo = asObject(proposal.logo);
  const assetByPath = new Map(asArray(brief.assets).map((a) => [a.path, a]));
  if (str(logo.asset)) {
    const asset = assetByPath.get(path.resolve(logo.asset));
    if (!asset) { errors.push(`logo_not_in_brief:${logo.asset}`); return null; }
    return { kind: 'asset', path: asset.path, sha256: asset.sha256, label: path.basename(asset.path) };
  }
  const d = asObject(logo.derive);
  if (!str(d.op)) { errors.push('logo_missing: give { asset } or { derive }'); return null; }
  if (!DERIVE_OPS.includes(d.op)) { errors.push(`derive_op_not_allowed:${d.op} (allowed: ${DERIVE_OPS.join(', ')})`); return null; }
  const from = assetByPath.get(path.resolve(String(d.from ?? '')));
  if (!from) { errors.push(`derive_from_not_in_brief:${d.from ?? ''}`); return null; }
  const recipe = { op: d.op, from: from.path, from_sha256: from.sha256 };
  if (d.op === 'crop') {
    const box = asArray(d.box).map(Number);
    if (box.length !== 4 || box.some((n) => !Number.isInteger(n) || n < 0) || box[2] < 1 || box[3] < 1) { errors.push('crop_box_invalid: [x, y, w, h] integers'); return null; }
    if (from.width && from.height && (box[0] + box[2] > from.width || box[1] + box[3] > from.height)) { errors.push(`crop_box_outside_asset: ${from.width}x${from.height}`); return null; }
    recipe.box = box; recipe.trim = d.trim !== false;
  } else if (d.op === 'stack') {
    recipe.split = d.split && typeof d.split === 'object' && Number.isInteger(d.split.at) ? { at: d.split.at } : 'auto';
    recipe.gap = Number.isInteger(d.gap) ? Math.max(0, d.gap) : 30;
  } else if (d.op === 'cut_words') {
    const ids = (v) => (Array.isArray(v) && v.every((n) => Number.isInteger(n)) ? v : null);
    recipe.keep_ids = ids(d.keep_ids); recipe.drop_ids = ids(d.drop_ids);
    recipe.white = Boolean(d.white);
    recipe.band = typeof d.band === 'string' && /^\d*\.?\d+,\d*\.?\d+$/.test(d.band) ? d.band : null;
    recipe.min_line_ratio = typeof d.min_line_ratio === 'number' ? d.min_line_ratio : null;
  }
  return { kind: 'derive', recipe, label: `${d.op} of ${path.basename(from.path)}` };
}

/** Validate the proposals file against the brief. Returns { errors (structural), accepted, refused }. Exported for tests. */
export function validateProposals(brief, proposals, { cap = brief.cap ?? DEFAULT_CAP } = {}) {
  const errors = [];
  if (!proposals || typeof proposals !== 'object' || Array.isArray(proposals)) return { errors: ['proposals_must_be_object'], accepted: [], refused: [] };
  if (!Array.isArray(proposals.proposals)) errors.push('missing_key:proposals (an array, possibly empty)');
  if (!str(proposals.missing_options_summary)) errors.push('missing_key:missing_options_summary');
  const list = asArray(proposals.proposals);
  if (list.length > cap) errors.push(`too_many_proposals:${list.length} over the cap of ${cap}`);
  const ids = new Set();
  const accepted = []; const refused = [];
  const colors = asArray(brief.colors);
  const sheet = asObject(brief.sheet);
  const sheetPrimary = normalizeHex(sheet.primary ?? '') ?? '#000000';
  const sheetText = normalizeHex(sheet.text ?? '') ?? '#FFFFFF';
  const minPrimaryContrast = primaryFloor();
  list.forEach((p, index) => {
    const reasons = [];
    const id = str(p?.id) ?? `p${index + 1}`;
    if (ids.has(id)) reasons.push(`duplicate_id:${id}`);
    ids.add(id);
    if (!str(p?.label)) reasons.push('missing_key:label');
    if (!str(p?.rationale)) reasons.push('missing_key:rationale');
    if (p?.pattern && !PATTERNS.includes(p.pattern)) reasons.push(`unknown_pattern:${p.pattern}`);
    // expected_words (rule 7): the exact words an intentional drop keeps; add-cell --expected makes sheet-viability read for them
    if (p?.expected_words != null && !str(p.expected_words)) reasons.push('expected_words_not_text');
    const primary = colorSource(p?.primary, colors);
    const secondary = colorSource(p?.secondary, colors);
    if (!primary.ok) reasons.push(`primary_${primary.reason}:${p?.primary ?? ''}${primary.note ? ` (${primary.note})` : ''}`);
    if (!secondary.ok) reasons.push(`secondary_${secondary.reason}:${p?.secondary ?? ''}${secondary.note ? ` (${secondary.note})` : ''}`);
    if (primary.ok && contrast(primary.hex, '#FFFFFF') < minPrimaryContrast) reasons.push(`primary_too_light:${primary.hex} is ${contrast(primary.hex, '#FFFFFF').toFixed(2)}:1 against white (floor ${minPrimaryContrast})`);
    if (primary.ok && secondary.ok && contrast(primary.hex, secondary.hex) < BAND_MIN_CONTRAST) reasons.push(`band_invisible:${secondary.hex} on ${primary.hex} is ${contrast(primary.hex, secondary.hex).toFixed(2)}:1; the band has to read as a separate field`);
    const optional = {};
    for (const role of ['text', 'print_digit', 'sticker_band']) {
      if (p?.[role] == null) continue;
      const c = colorSource(p[role], colors);
      if (!c.ok) reasons.push(`${role}_${c.reason}:${p[role]}`); else optional[role] = c;
    }
    const logo = logoOf(p ?? {}, brief, reasons);
    if (reasons.length) { refused.push({ id, label: str(p?.label) ?? null, reasons }); return; }
    const knockout = Boolean(p.knockout);
    const resolved = resolveText({ primary: primary.hex, secondary: secondary.hex, text: optional.text?.hex ?? null, sheetText, printDigit: optional.print_digit?.hex ?? null });
    // DEDUPE: the same pixels on the same card with the same band is already a letter.
    if (logo.kind === 'asset') {
      const rowsByKey = new Map(asArray(sheet.rows).map((r) => [r.key, r]));
      const assetSha = new Map(asArray(brief.assets).map((a) => [a.path, a.sha256]));
      const dup = asArray(sheet.cells).find((cell) => {
        const row = rowsByKey.get(cell.row); if (!row) return false;
        const rowPrimary = normalizeHex(row.primary ?? '') ?? sheetPrimary;
        return assetSha.get(row.logo) === logo.sha256 && rowPrimary === primary.hex && normalizeHex(cell.secondary ?? '') === secondary.hex;
      });
      if (dup) { refused.push({ id, label: p.label, reasons: [`duplicate_of_cell:${dup.letter}`] }); return; }
    }
    const lightGround = contrast(primary.hex, '#FFFFFF') < LIGHT_GROUND_CONTRAST;
    const escalation = lightGround ? 'light_ground' : null;
    const noteBits = [`sources: primary ${sourceText(primary)}; band ${sourceText(secondary)}; text ${optional.text ? sourceText(optional.text) : `${resolved.text} (sheet text or the brand-owned fix)`}`];
    if (resolved.notes.length) noteBits.push(`web/print split: ${resolved.notes.join('; ')}`);
    if (lightGround) noteBits.push(`LIGHT GROUND: ${primary.hex} is ${contrast(primary.hex, '#FFFFFF').toFixed(2)}:1 vs white; escalate before a pick (component-contrast and the sticker on white have no override)`);
    if (optional.sticker_band) noteBits.push(`sticker band suggested ${optional.sticker_band.hex} (advisory; the sheet's band rule decides)`);
    accepted.push({
      id, pattern: p.pattern ?? 'other', label: lightGround ? `LIGHT GROUND: ${p.label}` : p.label, rationale: p.rationale,
      logo, primary: primary.hex, secondary: secondary.hex, text: resolved.text, print_digit: resolved.print_digit, knockout,
      sticker_band: optional.sticker_band?.hex ?? null, escalation, expected_words: str(p.expected_words) ?? null,
      sources: { primary, secondary, text: optional.text ?? null, print_digit: optional.print_digit ?? null, sticker_band: optional.sticker_band ?? null },
      contrast: { card: resolved.card_contrast, web_digit: resolved.web_digit_contrast, primary_vs_white: Number(contrast(primary.hex, '#FFFFFF').toFixed(2)) },
      note: noteBits.join(' | '),
    });
  });
  return { errors, accepted, refused };
}
function sourceText(c) { return `${c.hex} ${c.synthetic ? `${c.synthetic.direction} step of ${c.synthetic.of} (${c.source}${c.synthetic.direction === 'lighter' ? ', sampled; lifted to de-shadow the sample' : ''})` : `${c.source}${c.detail ? `, ${c.detail}` : ''}`}`; }
function primaryFloor() {
  try { return Number(readJson(GATES_REGISTRY).gates.find((g) => g.id === 'primary-too-light')?.thresholds?.min_contrast_vs_white) || 1.3; } catch { return 1.3; }
}

function validate(args, { quiet = false } = {}) {
  const runDir = path.resolve(args.run);
  const briefFile = path.join(runDir, 'taste', 'brief.json');
  if (!existsSync(briefFile)) throw new Error(`no brief at ${briefFile}; run taste-pass.mjs brief first`);
  const proposalsFile = path.resolve(args.proposals ?? path.join(runDir, 'taste', 'proposals.json'));
  if (!existsSync(proposalsFile)) throw new Error(`no proposals at ${proposalsFile} (the taste subagent writes <run>/taste/proposals.json)`);
  const brief = readJson(briefFile);
  // the sheet may have grown since the brief (a rerun, a hand add-cell): dedupe against the live sheet
  const liveSheet = path.join(runDir, 'variants', 'variant-sheet.json');
  if (existsSync(liveSheet)) brief.sheet = sheetSummary(readJson(liveSheet));
  let proposals;
  try { proposals = readJson(proposalsFile); } catch (e) { proposals = null; }
  const result = proposals ? validateProposals(brief, proposals, { cap: args.cap ?? brief.cap }) : { errors: ['proposals_not_json'], accepted: [], refused: [] };
  const out = { valid: result.errors.length === 0, model: args.model, errors: result.errors, accepted: result.accepted, refused: result.refused, brief: briefFile, brief_sha256: fileSha(briefFile), proposals: proposalsFile, proposals_sha256: fileSha(proposalsFile), summary: str(proposals?.missing_options_summary) ?? null, validated_at: nowIso() };
  writeFileSync(path.join(runDir, 'taste', 'validation.json'), `${JSON.stringify(out, null, 2)}\n`);
  if (!quiet) process.stdout.write(`${JSON.stringify({ ...out, accepted: out.accepted.map((a) => ({ id: a.id, label: a.label, primary: a.primary, secondary: a.secondary, text: a.text, print_digit: a.print_digit, logo: a.logo.kind === 'asset' ? a.logo.path : a.logo.recipe, escalation: a.escalation })) }, null, 2)}\n`);
  if (!out.valid) process.exitCode = 2;
  return out;
}

// ---- apply: derivations ----------------------------------------------------------------------------
function alphaBbox(data, width, height, x0 = 0, x1 = width) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = x0; x < x1; x += 1) {
    if (data[(y * width + x) * 4 + 3] === 0) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
/** The widest run of fully transparent columns strictly inside the ink bbox (the gap between icon and wordmark). Exported for tests. */
export function widestGap(data, width, height) {
  const bbox = alphaBbox(data, width, height);
  if (!bbox) return null;
  const empty = new Array(width).fill(true);
  for (let y = 0; y < height; y += 1) for (let x = bbox.left; x < bbox.left + bbox.width; x += 1) if (data[(y * width + x) * 4 + 3] !== 0) empty[x] = false;
  let best = null; let start = null;
  for (let x = bbox.left; x <= bbox.left + bbox.width; x += 1) {
    const isEmpty = x < bbox.left + bbox.width && empty[x];
    if (isEmpty && start === null) start = x;
    if (!isEmpty && start !== null) { const run = { start, end: x, width: x - start }; if (!best || run.width > best.width) best = run; start = null; }
  }
  return best;
}
async function raw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
async function deriveCrop(recipe, out) {
  const [left, top, width, height] = recipe.box;
  let img = sharp(recipe.from).extract({ left, top, width, height });
  if (recipe.trim) {
    const { data, width: w, height: h } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => ({ data, width: info.width, height: info.height }));
    const bbox = alphaBbox(data, w, h);
    if (!bbox) throw new Error('crop region is fully transparent');
    img = sharp(data, { raw: { width: w, height: h, channels: 4 } }).extract(bbox);
  }
  await img.png({ compressionLevel: 9 }).toFile(out);
  return { op: 'crop', box: recipe.box, trimmed: recipe.trim };
}
async function deriveStack(recipe, out) {
  const { data, width, height } = await raw(recipe.from);
  const gap = recipe.split === 'auto' ? widestGap(data, width, height) : { start: recipe.split.at, end: recipe.split.at, width: 0 };
  if (!gap) throw new Error('no transparent column gap inside the lockup to split at');
  const left = alphaBbox(data, width, height, 0, gap.start);
  const right = alphaBbox(data, width, height, gap.end, width);
  if (!left || !right) throw new Error('split leaves an empty side');
  const canvasW = Math.max(left.width, right.width);
  const canvasH = left.height + recipe.gap + right.height;
  const part = (b) => sharp(data, { raw: { width, height, channels: 4 } }).extract(b).png().toBuffer();
  await sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: await part(left), left: Math.round((canvasW - left.width) / 2), top: 0 },
      { input: await part(right), left: Math.round((canvasW - right.width) / 2), top: left.height + recipe.gap },
    ])
    .png({ compressionLevel: 9 }).toFile(out);
  return { op: 'stack', split_at: gap.start, gap_width: gap.width, top: left, bottom: right, canvas: [canvasW, canvasH], note: 'pixels copied verbatim, no resampling' };
}
function deriveCutWords(recipe, out) {
  const argv = [CUT_WORDS, '--in', recipe.from, '--out', out, '--json', `${out}.components.json`];
  if (recipe.keep_ids) argv.push('--keep-ids', recipe.keep_ids.join(','));
  if (recipe.drop_ids) argv.push('--drop-ids', recipe.drop_ids.join(','));
  if (recipe.white) argv.push('--white');
  if (recipe.band) argv.push('--band', recipe.band);
  if (recipe.min_line_ratio != null) argv.push('--min-line-ratio', String(recipe.min_line_ratio));
  const r = run('node', argv);
  if (r.status !== 0) throw new Error(`cut-words exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return { op: 'cut_words', argv: argv.slice(1), components: `${out}.components.json` };
}
export async function buildDerived(recipe, out) {
  if (recipe.op === 'crop') return deriveCrop(recipe, out);
  if (recipe.op === 'stack') return deriveStack(recipe, out);
  if (recipe.op === 'cut_words') return deriveCutWords(recipe, out);
  throw new Error(`unknown op ${recipe.op}`);
}

// ---- apply: gates and the sheet --------------------------------------------------------------------
function registry() { try { return readJson(GATES_REGISTRY).gates; } catch { return []; } }
/** Failing gates the registry lets a human override later (upload-size, an allowed ink-retention verdict) versus hard holds. Exported for tests. */
/** The cell note for one overridable failing gate: upload-size is folded into the pick notice; every other gate names the closeout override. */
export function overrideNote(f) {
  return f.gate === 'upload-size'
    ? 'over the upload cap: folded into the pick notice (picking this letter also OKs the sticker size)'
    : `needs override at closeout: ${f.gate} (${f.verdict ?? 'failed'}) (registry allows it)`;
}
export function splitFailing(failing, gates = registry(), { tolerate = [] } = {}) {
  const hard = []; const overridable = [];
  for (const f of asArray(failing)) {
    const def = gates.find((g) => g.id === f.gate);
    const ok = Boolean(def?.override_allowed) && (tolerate.includes(f.gate) || !def.override_allowed_verdicts || (f.verdict && def.override_allowed_verdicts.includes(f.verdict)));
    (ok ? overridable : hard).push(f);
  }
  return { hard, overridable };
}
// A stacked lockup changes the silhouette aspect by design, so the whole-asset ink-retention gate fails on alignment
// (Scoops M, 2026-10-15: piecewise proof, override at closeout). The registry allows an ink-retention override.
const TOLERATED_BY_OP = { stack: ['ink-retention'] };
function gateCard(runDir, logo, primary, knockout) {
  const argv = ['--experimental-strip-types', GATES, 'check', '--asset', logo, '--color', primary, '--run', runDir];
  if (knockout) argv.push('--treatment', 'knockout');
  const r = run('node', argv);
  const json = lastJson(r.stdout) ?? {};
  return { verdict: json.verdict ?? (r.status === 0 ? 'SHIP' : 'HOLD'), failing: asArray(json.failing), overridden: asArray(json.overridden), reasons: asArray(json.reasons), exit: r.status, error: json.verdict ? null : (r.stderr || r.stdout).trim().slice(-400) };
}
function addCell(runDir, a, logo) {
  const argv = [VARIANT_SHEET, 'add-cell', '--run-dir', runDir, '--run', runDir, '--logo', logo, '--primary', a.primary, '--secondary', a.secondary, '--text', a.text, '--label', a.label, '--key', `taste_${slug(a.id)}_${slug(a.label)}`.slice(0, 60), '--note', `Taste pass (${a.model}): ${a.rationale} | ${a.note}`];
  if (a.print_digit) argv.push('--digit', a.print_digit);
  if (a.knockout) argv.push('--knockout');
  if (a.expected_words) argv.push('--expected', a.expected_words);
  const r = run('node', argv);
  const json = lastJson(r.stdout);
  if (r.status !== 0 || !json) return { ok: false, error: (r.stderr || r.stdout).trim().slice(-500) };
  return { ok: true, added: json.added !== false, letters: asArray(json.new_cells).map((c) => String(c).split('=')[0]), refused: json.refused ?? null, skipped: asArray(json.skipped).slice(-1)[0] ?? null };
}
/** One true sentence for checklist/notes.json. Exported for tests. */
export function notesLine({ model, added, skipped, needsBuild, summary }) {
  const who = `Taste pass (${model})`;
  const parts = [];
  if (added.length) parts.push(`${who} added ${added.map((a) => a.letter).join(', ')} (${added.map((a) => a.label).join('; ')})`);
  else parts.push(`${who} added nothing${summary ? `: ${summary}` : ''}`);
  if (needsBuild.length) parts.push(`${needsBuild.length} proposal${needsBuild.length > 1 ? 's' : ''} need${needsBuild.length > 1 ? '' : 's'} a hand build (${needsBuild.map((n) => `${n.id}: ${n.reason}`).join('; ')})`);
  if (skipped.length) parts.push(`${skipped.length} kept off the sheet (${skipped.map((s) => `${s.id}: ${s.reason}`).join('; ')})`);
  const escalate = added.filter((a) => a.escalation);
  if (escalate.length) parts.push(`light ground, escalate before a pick: ${escalate.map((a) => a.letter).join(', ')}`);
  return `${parts.join('. ')}.`;
}

async function apply(args) {
  const runDir = path.resolve(args.run);
  const validation = validate({ ...args }, { quiet: true });
  process.exitCode = 0;
  const tasteDir = path.join(runDir, 'taste');
  const assetsDir = path.join(tasteDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const added = []; const skipped = []; const needsBuild = []; const built = [];
  if (!validation.valid) {
    const block = tasteBlock({ args, validation, added, skipped, needsBuild, built, summary: validation.summary, notes: `Taste pass (${args.model}) proposals invalid: ${validation.errors.join('; ')}` });
    if (!args.dryRun) recordTaste(runDir, block);
    process.stdout.write(`${JSON.stringify({ ok: false, command: 'apply', errors: validation.errors, notes_line: block.notes_line }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const briefAssetList = asArray(readJson(path.join(tasteDir, 'brief.json')).assets);
  const briefAssets = new Map(briefAssetList.map((a) => [a.sha256, a.path]));
  const briefJson = readJson(path.join(tasteDir, 'brief.json'));
  const shaByPath = new Map(briefAssetList.map((a) => [a.path, a.sha256]));
  const sheetRowShas = new Set(asArray(asObject(briefJson.sheet).rows).map((r) => shaByPath.get(r.logo)).filter(Boolean));
  for (const a of validation.accepted) {
    let logo = a.logo.kind === 'asset' ? a.logo.path : null;
    if (a.logo.kind === 'derive') {
      const out = path.join(assetsDir, `${slug(a.id)}-${a.logo.recipe.op}-${path.basename(a.logo.recipe.from, '.png')}.png`);
      if (args.dryRun) { built.push({ id: a.id, out, recipe: a.logo.recipe, dry_run: true }); logo = out; }
      else {
        try {
          const receipt = await buildDerived(a.logo.recipe, out);
          const sha = fileSha(out);
          if (briefAssets.has(sha)) { skipped.push({ id: a.id, label: a.label, reason: `derived asset is identical to ${path.basename(briefAssets.get(sha))}` }); continue; }
          built.push({ id: a.id, out, sha256: sha, recipe: a.logo.recipe, receipt });
          logo = out;
        } catch (e) {
          needsBuild.push({ id: a.id, label: a.label, reason: e.message, recipe: a.logo.recipe, rationale: a.rationale, primary: a.primary, secondary: a.secondary, text: a.text });
          continue;
        }
      }
    }
    if (args.dryRun) { added.push({ id: a.id, letter: '?', label: a.label, logo, primary: a.primary, secondary: a.secondary, text: a.text, print_digit: a.print_digit, escalation: a.escalation, dry_run: true }); continue; }
    // ASSET ALREADY ON THE SHEET (Pig & Parrot M: the words-only cut on the black ground): the sheet carries it, so
    // only the card-dependent checks matter and add-cell's own sheet-viability and cell-on-card gates run them.
    const onSheet = a.logo.kind === 'asset' && sheetRowShas.has(a.logo.sha256);
    const gate = onSheet ? { verdict: 'SHEET', failing: [], overridden: [], reasons: ['asset already on the sheet; the sheet gates decide'], exit: 0, error: null } : gateCard(runDir, logo, a.primary, a.knockout);
    const { hard, overridable } = splitFailing(gate.failing, registry(), { tolerate: a.logo.kind === 'derive' ? TOLERATED_BY_OP[a.logo.recipe.op] ?? [] : [] });
    if (gate.error && !gate.failing.length) { skipped.push({ id: a.id, label: a.label, reason: `gates check failed: ${gate.error}` }); continue; }
    if (hard.length) { skipped.push({ id: a.id, label: a.label, reason: `gate hold: ${hard.map((f) => `${f.gate} (${f.verdict ?? 'failed'})`).join(', ')}`, gates: gate }); continue; }
    const stackNote = a.logo.kind === 'derive' && a.logo.recipe.op === 'stack' ? ' (stacking changes the silhouette aspect, prove ink retention piecewise)' : '';
    const withNote = overridable.length ? { ...a, note: `${a.note} | ${overridable.map(overrideNote).join('; ')}${stackNote}` } : a;
    const cell = addCell(runDir, { ...withNote, model: args.model }, logo);
    if (!cell.ok) { skipped.push({ id: a.id, label: a.label, reason: `add-cell failed: ${cell.error}` }); continue; }
    if (!cell.added) { skipped.push({ id: a.id, label: a.label, reason: `sheet-viability refused: ${cell.skipped?.verdict ?? 'refused'}${cell.skipped?.reasons?.length ? ` (${cell.skipped.reasons[0]})` : ''}` }); continue; }
    added.push({ id: a.id, letter: cell.letters[0] ?? '?', letters: cell.letters, label: a.label, logo, primary: a.primary, secondary: a.secondary, text: a.text, print_digit: a.print_digit, knockout: a.knockout, escalation: a.escalation, gates: { verdict: gate.verdict, overridable: overridable.map((f) => f.gate) }, rationale: a.rationale });
  }
  const block = tasteBlock({ args, validation, added, skipped, needsBuild, built, summary: validation.summary });
  if (!args.dryRun) recordTaste(runDir, block);
  writeFileSync(path.join(tasteDir, 'applied.json'), `${JSON.stringify(block, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, command: 'apply', dry_run: args.dryRun, model: args.model, added: added.map((a) => ({ id: a.id, letter: a.letter, label: a.label, primary: a.primary, secondary: a.secondary, text: a.text, print_digit: a.print_digit, escalation: a.escalation })), skipped, needs_build: needsBuild.map((n) => ({ id: n.id, reason: n.reason })), refused: validation.refused, notes_line: block.notes_line, sheet: path.join(runDir, 'variants', 'variant-sheet.html') }, null, 2)}\n`);
}
function tasteBlock({ args, validation, added, skipped, needsBuild, built, summary, notes }) {
  return {
    model: args.model, generated_at: nowIso(), dry_run: Boolean(args.dryRun), cap: args.cap ?? validation.cap ?? DEFAULT_CAP,
    brief_sha256: validation.brief_sha256, proposals_sha256: validation.proposals_sha256, summary: summary ?? null,
    accepted: validation.accepted.map((a) => a.id), refused: validation.refused, added, skipped, needs_build: needsBuild, built,
    notes_line: notes ?? notesLine({ model: args.model, added, skipped, needsBuild, summary }),
  };
}
function recordTaste(runDir, block) {
  if (!existsSync(path.join(runDir, 'run.json'))) return;
  const tmp = path.join(runDir, 'taste', 'taste-block.json');
  writeFileSync(tmp, `${JSON.stringify(block, null, 2)}\n`);
  let r = run('node', ['--experimental-strip-types', RUN_FILE, 'set', runDir, 'taste', '--from', tmp, '--by', 'taste-pass']);
  if (r.status !== 0 && /Refusing to overwrite/.test(r.stderr)) r = run('node', ['--experimental-strip-types', RUN_FILE, 'set', runDir, 'taste', '--from', tmp, '--by', 'taste-pass', '--force', '--reason', 'taste pass rerun']);
  if (r.status !== 0) process.stderr.write(`run.json taste block not written: ${(r.stderr || r.stdout).trim().slice(-300)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'brief') return brief(args);
  if (args.command === 'validate') return validate(args);
  return apply(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = process.exitCode || 1; });
}
