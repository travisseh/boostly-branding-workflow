#!/usr/bin/env node
// variant-sheet.mjs: ONE labeled montage per run, rendered as HTML from the vendored
// templates (templates/sheet-templates.js), so the reviewer answers with a single letter.
//
// RENDERING (Travisse 2026-10-13): no Boostly dev server, no app screenshots. Every cell is
// described by its `view` block in variant-sheet.json (logo paths relative to the run dir,
// colors, digit colors, offer, header text, status and NOT VIABLE badges) and the browser draws
// it from the templates: variants/variant-sheet.html here, the review canvas, the public review
// site. A raster exists only on request: --raster writes variant-sheet.png (one in-memory render
// of the HTML through scripts/render-preview.mjs, the Notion review-queue embed and the Apple Note
// checklist link read that file) and `render --cell <L>` writes card-<L>.png / sticker-<row>.png /
// pop-<row>.png (what harness/mockups/ai-mockup.mjs reads for its reference sheets).
//
//   rows    = logo treatment: chosen knockout, full color, words-only cut
//   columns = secondary/band candidates in provenance order (Fable's chosen
//             secondary, the chosen mark's inks, theme-authored site tokens),
//             then a 3-step depth ladder of the chosen secondary
//   cell    = harness card (varies by column) + sticker mock + solid POP tile
//             (both per row), with the badge digit contrast printed
//
// The sheet is INCREMENTAL. variant-sheet.json is the source of truth; the html
// (and any png) is derived from it. Fingerprints (logo sha256 + hexes + treatment)
// are still recorded per cell so run.json can tell when an input changed; legacy
// sheets keep their cells/ render cache and card/sticker/pop files untouched.
// Cell letters are assigned once, in creation order (A..Z, AA, AB, ...), and
// never renumbered: adding a row or column appends letters.
//
// Subcommands (the bare flag form is `build`, unchanged):
//   build       --run-dir <run> [--out <dir>] [--run <run_dir>] [--raster]
//               [--decision <json>] [--evidence <json>] [--logo-knockout <png>] [--logo-color <png>]
//               [--logo-words <png>] [--logo-sticker <png>] [--offer "Get 20% Off"]
//               [--secondaries #hex,#hex] [--max-columns 8] [--no-words] [--no-instore] [--marks <json>] [--force]
//               [--allow-lighter]  (renders the +10% lighter synthetic column too; it is never a pick, Q3 = A)
//   add-row     --run-dir <run> --logo <png> --label "<treatment>" [--key <row_key>] [--primary <hex>]
//               [--text <hex>] [--secondaries #hex,#hex] [--sticker-logo <png>] [--knockout] [--run <run_dir>]
//               [--source <wordmark the cut came from>] [--note "<provenance>"] [--force-viability]
//   add-column  --run-dir <run> --secondary <hex> [--label "<label>"] [--source override] [--run <run_dir>]
//   add-cell    --run-dir <run> --logo <png> --primary <hex> --secondary <hex> [--digit <hex>] [--text <hex>]
//               --label "<treatment>" [--key <row_key>] [--sticker-logo <png>] [--run <run_dir>]
//               [--print-primary <hex>] [--print-secondary <hex>] [--pop-logo <png>] [--pop-ground <hex>]
//               pop-logo / pop-ground (Mi Corazon 2026-10-20): the POP tile's own logo asset and ground when
//               they differ from the card logo and the sticker band (a light-primary row draws the POP on the
//               band, where a dark-ink lockup vanishes; the fix is a white-words recolor of the lockup, or the
//               white light-sign ground with the full-color logo). Card and sticker stay as the row has them;
//               at closeout they map to direct-pdf --pop-primary-logo and plan.mjs --band.
//               print-primary: the signage ground (sticker band, POP tile) when print_primary_color differs
//               from the web card primary (Dogwood 2026-09-21: red web card, blue signage); print-secondary
//               is the print band/badge fill when it differs from the web secondary. Both are recorded on
//               the cell and printed on its label; the card render keeps the web colors.
//   mark        --run-dir <run> --cell <letter> --status <fable_pick|travisse_pick|rejected|none>
//               [--note "<why>"] [--by Travisse] [--run <run_dir>]
//   restitch    --run-dir <run> [--out <dir>] [--run <run_dir>] [--raster]
//   render      --run-dir <run> (--cell <letter> | --cells L,M | --all) [--raster] [--run <run_dir>]
//               writes the per-cell PNG tiles (card-<L>.png, sticker-<row>.png, pop-<row>.png) from the
//               templates for consumers that need files (ai-mockup.mjs); --raster also writes the sheet png.
//   Every subcommand accepts --raster (write variants/variant-sheet.png too). --url-base is accepted
//   and ignored (the harness is gone).
//
// The sheet lives at <run_dir>/variants/ (override with --out). Outputs
// variant-sheet.html and variant-sheet.json (letter -> exact hexes and logo
// paths, so "apply B" is mechanical). With --run <run_dir> every subcommand
// updates the `variants` block of run.json; `mark --status travisse_pick` also
// runs `run-file select` so the applied letter is recorded once, in run.json.
// Exit 1 on any failure.
//
// SHEET VIABILITY (Dogwood Pizza 2026-09-21): every logo asset is checked by
// `logo-quality-gates.ts sheet-viability` BEFORE its cells render (build rows,
// add-row, add-cell, and every row an add-column would extend). A blocked asset
// (opaque_ground, wordmark_text_mismatch, rejected_label) is not added: one line
// per skipped asset goes to stderr and the skip is recorded under
// variants.skipped in run.json. --force-viability renders it anyway with a
// NOT VIABLE badge on the cell.
//
// STICKER GROUND (Toscana Gourmet Pizza 2026-09-22): the sticker logo of every row (the row's
// --sticker-logo, else the sheet's --logo-sticker / fix/sticker-logo*.png / decision logo) sits on
// a WHITE sticker, so it gets the same opaque_ground pre-check as the card asset, in build,
// add-row, add-cell and add-column. An opaque sticker asset never falls back to the card logo:
// the row's sticker render is skipped, its cells carry "sticker: needs panel or strip", the skip
// is recorded (kind: sticker) and printed. Fix with scripts/sticker-panel.mjs --mode circle|strip.
//
// CELL ON CARD (Travisse 2026-10-01: "drop rejected cells from the rendered sheet entirely so they
// do not consume letters"): before a (row, column) pair becomes a cell, the row's logo is measured
// against the row primary with the component-contrast rule (harness/iterate-logo-rules.mjs). When
// at least sheet-viability.card_vanish_min_ink_share of the ink sits in components that vanish on
// the card (Spinachio 2026-09-30: green lockup on the green card, 1.03:1), the cell is NOT created:
// no letter, no render, one `sheet-viability: skipped <row> x <hex> (ink_vanishes_on_card)` line,
// and a kind:'cell' entry under manifest.skipped (row, column, primary, logo, reasons). Letters stay
// contiguous. --force-viability creates it anyway with a NOT VIABLE badge. A cell a human marks
// `rejected` later (mark --status rejected) is different: it KEEPS its letter (letters already
// quoted in Slack or Notion never shift) and is drawn greyed with REJECTED in its header and
// across the card.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cutWords } from './cut-words.mjs';
import { componentContrastCheck } from '../harness/iterate-logo-rules.mjs';
import templates from '../templates/sheet-templates.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Image harness lives inside this skill (boostly-brand-design/harness) so the skill is self-contained.
const HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', 'harness');
const require = createRequire(path.join(HARNESS_DIR, 'package.json'));
const sharp = require('sharp');
const QRCode = require('qrcode');
// The env that carries BOOSTLY_V2_API_BASE / BOOSTLY_V2_API_KEY (the operator's ~/.config/boostly-branding/.env,
// else the brand-extractor service env the closeout's plan.mjs reads); the sheet fetches the location's signage
// touchpoint links from it (read-only) so the preview QRs are the real codes.
const V2_ENV_CANDIDATES = [process.env.BOOSTLY_BRANDING_ENV_FILE, `${process.env.HOME}/.config/boostly-branding/.env`, '/Users/travisse/Programming/product2/shared/apps/brand-extractor-figma/.env'].filter(Boolean);
const V2_ENV_FILE = V2_ENV_CANDIDATES.find((f) => existsSync(f)) ?? V2_ENV_CANDIDATES[0];
const QR_LINKS_FILE = 'touchpoint-links.json';

const CARD_W = 260;
const SIDE_W = 150;
const LABEL_H = 34;
const CELL_PAD = 8;
const ROW_HEADER_W = 120;
const COL_HEADER_H = 44;
const MAX_LOGO_INKS = 3;
const MAX_SITE_TOKENS = 2;
const DEFAULT_OFFER = 'Join the club!';
const DEFAULT_URL_BASE = 'http://localhost:3457'; // legacy manifest key only; nothing is fetched from it
const CELLS_DIR = 'cells';
const SHEET_HTML = 'variant-sheet.html';
const STICKER_HEADLINE = 'Join the club!';
const STICKER_BODY = 'Be the first to know.|Receive exclusive deals.';
const POP_BODY_GENERIC = 'Scan to join our VIP text club|for ongoing offers!';
const POP_BODY_OFFER = 'Scan to join our text club|for ongoing offers!';

// ---- signage copy: the closeout's words (boostly-signage-sheets plan.mjs specificOfferCopy, ported) ----
// A discount ("20% OFF", "Get 20% Off!") becomes "Get 20% Off" on the sticker and the POP; a phrase offer
// ("Unlock the V.I.P Experience") goes verbatim on both with the phrase sticker layout; a review-style phrase
// is POP-only. The generic "Join the club!" keeps Cam's copy. The preview prints what the closeout prints.
const GENERIC_OFFER = /^join the club!?$/i;
const DISCOUNT_RE = /^\$?\d+(\.\d+)?\s*%?\s*off\b/i;
export function signageCopy(offer) {
  const generic = { sticker: { title: STICKER_HEADLINE, body: STICKER_BODY, layout: 'default' }, pop: { title: STICKER_HEADLINE, body: POP_BODY_GENERIC } };
  if (!offer || GENERIC_OFFER.test(offer)) return generic;
  let text = String(offer).trim();
  const typedGet = text.match(/^get\s+(.+?)!?\s*$/i);
  if (typedGet && DISCOUNT_RE.test(typedGet[1])) text = typedGet[1];
  const isDiscount = DISCOUNT_RE.test(text) || /^free\b/i.test(text);
  if (!isDiscount) {
    if (/let us know|review|good time/i.test(text)) return { sticker: generic.sticker, pop: { title: text, body: POP_BODY_GENERIC } };
    // plan.mjs measures the title at 82 against 788px (Figtree Medium); ~18 characters is that line.
    const layout = text.length <= 18 ? 'phrase_one_line' : 'phrase';
    return { sticker: { title: text, body: POP_BODY_GENERIC, layout }, pop: { title: text, body: POP_BODY_GENERIC } };
  }
  const title = `Get ${text.replace(/\bOFF\b/g, 'Off').replace(/\s+/g, ' ').trim()}`;
  return { sticker: { title, body: STICKER_BODY, layout: 'default' }, pop: { title, body: POP_BODY_OFFER } };
}

// ---- QR: the same encoder and matrix as the closeout's SVG masters (qrcode, ECC M) ----------------------
/** ECC-M module matrix of `url` as rows of '0'/'1' (what templates.styledQrSvg draws). */
export function qrModules(url) {
  const qr = QRCode.create(String(url), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const rows = [];
  for (let r = 0; r < n; r += 1) { let line = ''; for (let c = 0; c < n; c += 1) line += qr.modules.get(r, c) ? '1' : '0'; rows.push(line); }
  return rows;
}
function qrView(url) {
  return url ? { url, modules: qrModules(url) } : null;
}
function readV2Env() {
  if (!existsSync(V2_ENV_FILE)) return {};
  const env = {};
  for (const line of readFileSync(V2_ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
/**
 * The location's signage links for the preview QRs ({ table_promo, pop, source }), in this order: the
 * closeout's signage/plan.json (the links its masters encode), the variants/touchpoint-links.json cache,
 * a read-only GET of the V2 signage touchpoints for run.json's location_id (cached). null when none is
 * reachable (the tiles then draw the seeded mock matrix in the same style); never throws.
 */
export async function loadQrLinks(runDir, outDir, { fetchImpl = globalThis.fetch } = {}) {
  const fromPlan = path.join(runDir, 'signage', 'plan.json');
  if (existsSync(fromPlan)) {
    try {
      const plan = JSON.parse(readFileSync(fromPlan, 'utf8'));
      const table = plan.qr?.tablePromo?.link ?? null; const pop = plan.qr?.pop?.link ?? null;
      if (table || pop) return { table_promo: table, pop, source: 'signage/plan.json' };
    } catch { /* fall through */ }
  }
  const cache = path.join(outDir, QR_LINKS_FILE);
  if (existsSync(cache)) {
    try { const c = JSON.parse(readFileSync(cache, 'utf8')); if (c.table_promo || c.pop) return { ...c, source: c.source ?? 'cache' }; } catch { /* fall through */ }
  }
  const runFile = path.join(runDir, 'run.json');
  if (!existsSync(runFile) || typeof fetchImpl !== 'function') return null;
  let locationId = null;
  try { locationId = JSON.parse(readFileSync(runFile, 'utf8')).request?.location_id ?? null; } catch { return null; }
  if (!locationId) return null;
  const env = readV2Env();
  const key = (env.BOOSTLY_V2_API_KEY || env.BOOSTLY_V2_AUTH_TOKEN || '').trim().replace(/^(Bearer|Token)\s+/i, '');
  if (!key) return null;
  const base = env.BOOSTLY_V2_API_BASE || 'https://new.boostly.com/api/service/v1';
  try {
    const res = await fetchImpl(`${base}/touchpoints/signage?location_id=${encodeURIComponent(locationId)}`, { headers: { Accept: 'application/json', 'x-api-key': key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const byName = new Map((data.signage ?? []).map((tp) => [String(tp.name ?? '').toLowerCase(), tp.url ?? tp.link ?? null]));
    const links = { table_promo: byName.get('tables - subscribe') ?? null, pop: byName.get('point of purchase') ?? null, location_id: locationId, fetched_at: new Date().toISOString(), source: 'v2 touchpoints/signage' };
    if (!links.table_promo && !links.pop) return null;
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(cache, `${JSON.stringify(links, null, 2)}\n`);
    return links;
  } catch {
    return null;
  }
}
/** Put the QR links on the manifest once (manifest.qr_links); cellView reads them. */
export async function ensureQrLinks(manifest, outDir) {
  if (manifest.qr_links === undefined || manifest.qr_links === null) manifest.qr_links = await loadQrLinks(manifest.run_dir ?? path.dirname(outDir), outDir);
  return manifest.qr_links;
}
const SUBCOMMANDS = ['build', 'add-row', 'add-column', 'add-cell', 'mark', 'restitch', 'render'];
export const STATUSES = ['fable_pick', 'travisse_pick', 'rejected', 'hold', 'none'];
const STATUS_STYLE = {
  fable_pick: { color: '#1565C0', text: '#FFFFFF', tag: 'FABLE PICK' },
  travisse_pick: { color: '#F9A825', text: '#000000', tag: 'TRAVISSE PICK' },
  rejected: { color: '#616161', text: '#FFFFFF', tag: 'REJECTED' },
  hold: { color: '#B71C1C', text: '#FFFFFF', tag: 'HOLD: traced from small source' },
};
const LOGO_INK_MIN_SHARE = 0.03; // below 3% is antialias blend, not an ink (Skyboxx ball 5%, 2026-09-17)
const INSTORE_MIN_HUE_DISTANCE = 40; // an in-store dominant hue this far from the site primary earns its own primary row
const INSTORE_MIN_SHARE = 0.04;      // of the saturated pixels across the in-store photos

/** Plain-word provenance for a column source (Travisse 2026-09-18: "where did you pull that from?" twice in one run). */
export function provenanceWords(source, label = '') {
  const l = String(label ?? '');
  switch (source) {
    case 'fable_chosen': return "Fable's pick";
    case 'logo_ink': { const m = l.match(/(\d+)%/); const g = /gradient/.test(l) ? ', gradient center' : ''; return `logo ink${m ? ` ${m[1]}%` : ''}${g}`; }
    case 'mark_ink': return 'logo ink, moved here by the band rule';
    case 'site_token': return 'site theme token';
    case 'depth_darker_10': return '10% darker step, synthetic (allowed when real ink fails contrast)';
    case 'depth_darker_20': return '20% darker step, synthetic (allowed when real ink fails contrast)';
    case 'depth_lighter_10': return '10% lighter, synthetic (never a pick; --allow-lighter only)';
    case 'instore': return 'in-store dominant, sampled';
    case 'override': return `human override${l ? `: ${l}` : ''}`;
    case 'one_off': return `one-off${l ? `: ${l}` : ''}`;
    default: return l || String(source ?? 'unknown source');
  }
}
// DEPTH LADDER (Q3 = A, Travisse 2026-09-22): darker steps of the chosen secondary are pick-eligible when the real
// ink is too light to carry a band or a white digit (Fresho C sage -20%, That's a Wrap K #1A1A1A). The lighter step
// is never a pick (Coloradough AA "from nowhere real") and only renders behind --allow-lighter, for comparison.
const LADDER = [
  { key: 'depth_darker_10', label: 'darker step -10% (allowed when real ink fails contrast)', delta: -0.1 },
  { key: 'depth_darker_20', label: 'darker step -20% (allowed when real ink fails contrast)', delta: -0.2 },
];
const LIGHTER_STEP = { key: 'depth_lighter_10', label: 'lighter step +10% (never a pick)', delta: 0.1 };
const BOOL_FLAGS = new Set(['noWords', 'force', 'knockout', 'noInstore', 'forceViability', 'allowLighter', 'raster', 'all']);
const GATES_CLI = path.join(SCRIPT_DIR, 'logo-quality-gates.ts');
const GATES_JSON = path.resolve(SCRIPT_DIR, '..', 'references', 'gates.json');
const NOT_VIABLE_STYLE = { color: '#4A148C', text: '#FFFFFF', tag: 'NOT VIABLE' };

export function parseArgs(argv) {
  let command = 'build';
  if (argv[0] && !argv[0].startsWith('--')) {
    command = argv[0];
    if (!SUBCOMMANDS.includes(command)) throw new Error(`Unknown subcommand "${command}". One of: ${SUBCOMMANDS.join(', ')}`);
    argv = argv.slice(1);
  }
  const args = { command, urlBase: DEFAULT_URL_BASE, maxColumns: '8' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOL_FLAGS.has(flag)) {
      args[flag] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[flag] = value;
    i += 1;
  }
  // --run <run_dir>: the run.json to record the sheet in (variants block). Defaults --run-dir to it.
  if (args.run && !args.runDir) args.runDir = args.run;
  if (!args.runDir) throw new Error('Usage: variant-sheet.mjs [build|add-row|add-column|add-cell|mark|restitch|render] --run-dir <run> [--run <run_dir>] [options]');
  if (args.urlBase !== DEFAULT_URL_BASE) process.stderr.write('note: --url-base is ignored; cells render from templates/sheet-templates.js, not the badge harness\n');
  return args;
}

const RUN_FILE_CLI = path.resolve(SCRIPT_DIR, '..', '..', 'boostly-box-fulfillment', 'scripts', 'run-file.ts');

function runFile(argv) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', RUN_FILE_CLI, ...argv], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Write/update the `variants` block of run.json from the sheet json: run-file builds the canonical
 * block (--from-sheet), then the sheet's own per-cell id/fingerprint/status and the Fable default
 * letter are merged in. A block that later stages already depend on is rewritten with --force and
 * the reason recorded in run.json state.forces (the cells themselves did not change).
 */
export async function recordVariantsBlock(runDirForFile, manifestFile, manifest, { reason = 'variant sheet updated' } = {}) {
  const dir = path.resolve(runDirForFile);
  const attempt = (argv) => {
    let result = runFile(argv);
    if (result.status !== 0 && /Refusing to overwrite/.test(result.stderr)) {
      result = runFile([...argv, '--force', '--reason', reason]);
    }
    if (result.status !== 0) throw new Error(`run-file ${argv[0]} failed: ${(result.stderr || result.stdout || '').trim()}`);
    return JSON.parse(result.stdout);
  };
  attempt(['set', dir, 'variants', '--from-sheet', manifestFile, '--by', 'variant-sheet']);
  const got = runFile(['get', dir, 'variants']);
  if (got.status !== 0) throw new Error(`run-file get variants failed: ${(got.stderr || got.stdout).trim()}`);
  const block = JSON.parse(got.stdout);
  const cells = block.cells ?? {};
  for (const [letter, cell] of Object.entries(manifest.cells)) {
    if (!cells[letter]) continue;
    cells[letter] = { ...cells[letter], id: cell.id ?? letter, column_index: cell.column_index ?? null, fingerprint: cell.fingerprint ?? null, status: cell.status ?? null, note: cell.note ?? null, ...(cell.viability ? { viability: cell.viability } : {}) };
  }
  block.cells = cells;
  // sheet-viability skips are additive: every refused asset stays on record, never rendered.
  block.skipped = [...(manifest.skipped ?? [])];
  block.cells_dir = path.relative(dir, path.join(path.dirname(manifestFile), CELLS_DIR));
  block.fable_default_letter = manifest.fable_default_letter ?? block.fable_default_letter ?? null;
  block.statuses = Object.fromEntries(Object.entries(manifest.cells).filter(([, c]) => c.status).map(([l, c]) => [l, c.status]));
  block.revision = manifest.revision ?? 1;
  block.updated_at = manifest.updated_at ?? manifest.generated_at ?? null;
  const tmp = path.join(path.dirname(manifestFile), '.variants-block.json');
  await fs.writeFile(tmp, `${JSON.stringify(block, null, 2)}\n`);
  try {
    return attempt(['set', dir, 'variants', '--from', tmp, '--by', 'variant-sheet']);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// ---- sheet viability (gate: sheet-viability in references/gates.json) -------------
function sheetViabilityThresholds() {
  const registry = JSON.parse(readFileSync(GATES_JSON, 'utf8'));
  const gate = (registry.gates ?? []).find((g) => g.id === 'sheet-viability');
  if (!gate) throw new Error(`gate "sheet-viability" is not in ${GATES_JSON}`);
  return gate.thresholds;
}
/** Pure: the word the gate refuses in a label or note ("rejected"), or null. */
export function rejectedLabelMatch(...texts) {
  const pattern = new RegExp(sheetViabilityThresholds().rejected_label_pattern, 'i');
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const hit = pattern.exec(text);
    if (hit) return hit[0];
  }
  return null;
}
/** The source a words-only cut came from: --source, else the cut-words.json sidecar whose `out` is this file. */
export function wordsCutSource(logo, outDir, runDir) {
  for (const sidecar of [path.join(outDir, 'cut-words.json'), path.join(runDir, 'fix', 'words', 'cut-words.json'), path.join(runDir, 'fix', 'cut-words.json')]) {
    if (!existsSync(sidecar)) continue;
    try {
      const cut = JSON.parse(readFileSync(sidecar, 'utf8'));
      if (cut?.out && path.resolve(cut.out) === path.resolve(logo) && cut.in && existsSync(cut.in)) return path.resolve(cut.in);
    } catch { /* a broken sidecar is not a source */ }
  }
  return null;
}
/**
 * Run the sheet-viability gate on one logo asset (label check first, no spawn; then
 * logo-quality-gates.ts sheet-viability for opaque_ground and, with a source, wordmark_text_mismatch).
 * Returns the gate result: { pass, verdict, reasons, checks }.
 */
export async function checkSheetViability(logo, { source = null, expected = null, label = null, note = null } = {}) {
  const matched = rejectedLabelMatch(label, note);
  if (matched) {
    return { pass: false, verdict: 'rejected_label', blocks: ['rejected_label'], reasons: [`the label/provenance says "${matched}": a cell you already consider rejected is not added to the sheet`], checks: { rejected_label: { checked: true, matched } } };
  }
  const argv = ['--experimental-strip-types', GATES_CLI, 'sheet-viability', '--logo', logo];
  if (source) argv.push('--source', source);
  if (expected) argv.push('--expected', expected);
  if (label) argv.push('--label', label);
  if (note) argv.push('--note', note);
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) throw new Error(`sheet-viability failed on ${logo}: ${(result.stderr || '').trim()}`);
  return JSON.parse(stdout);
}
/**
 * Pure: apply a viability result to a row (or one-off cell row) about to be added.
 * pass -> row.viability records the pass; fail + force -> the row carries the failure (NOT VIABLE badge);
 * fail -> the skip is appended to manifest.skipped and the row is NOT added. Returns { keep, forced, entry }.
 */
export function applyViability(manifest, row, result, { force = false, command = 'add-row', columnHex = null, at = new Date().toISOString() } = {}) {
  const summary = { pass: Boolean(result.pass), verdict: result.verdict ?? (result.pass ? 'ok' : 'unknown'), reasons: result.reasons ?? [], logo_sha256: row.logo_sha256 ?? null, source: row.viability_source ?? null, checked_at: at };
  if (result.pass) {
    row.viability = summary;
    return { keep: true, forced: false, entry: null };
  }
  if (force) {
    row.viability = { ...summary, forced: true };
    return { keep: true, forced: true, entry: null };
  }
  const entry = { at, command, row: row.key ?? null, label: row.label ?? null, logo: row.logo ?? null, logo_sha256: row.logo_sha256 ?? null, source: row.viability_source ?? null, column: columnHex, verdict: summary.verdict, reasons: summary.reasons };
  manifest.skipped = [...(manifest.skipped ?? []), entry];
  return { keep: false, forced: false, entry };
}
function skipLine(entry) {
  const what = entry.column ? `${entry.row} x ${entry.column}` : entry.row;
  if (entry.kind === 'sticker') return `sheet-viability: sticker for ${what} ${STICKER_NEEDS_FIX} (${entry.verdict}): ${entry.reasons.join(' | ')}${entry.logo ? `  [${entry.logo}]` : ''}\n`;
  if (entry.kind === 'cell') return `sheet-viability: skipped cell ${what} on ${entry.primary} (${entry.verdict}), no letter taken: ${entry.reasons.join(' | ')}${entry.logo ? `  [${entry.logo}]` : ''}\n`;
  return `sheet-viability: skipped ${what} (${entry.verdict}): ${entry.reasons.join(' | ')}${entry.logo ? `  [${entry.logo}]` : ''}\n`;
}
export const STICKER_NEEDS_FIX = 'needs panel or strip';
/** The asset a row's sticker mock renders: the row's own, else the sheet's, else the card logo (full_color always its own). */
export function stickerLogoFor(manifest, row) {
  const candidate = row.sticker_logo ?? manifest.sticker_logo ?? row.logo;
  return row.key === 'full_color' || !existsSync(candidate) ? row.logo : candidate;
}
/**
 * Pure: apply the sticker-ground viability of a row's sticker asset. The row itself is kept (its card
 * cells are fine); only the sticker render is skipped. pass -> row.sticker_viability records it;
 * fail + force -> forced (NOT VIABLE badge, rendered anyway); fail -> row.sticker_viability.pass=false
 * with status "needs panel or strip", and a kind:'sticker' entry lands in manifest.skipped.
 */
export function applyStickerViability(manifest, row, result, { force = false, command = 'add-row', columnHex = null, logo = null, logoSha = null, at = new Date().toISOString() } = {}) {
  const summary = { pass: Boolean(result.pass), verdict: result.verdict ?? (result.pass ? 'ok' : 'unknown'), reasons: result.reasons ?? [], logo, logo_sha256: logoSha, checked_at: at };
  if (result.pass) {
    row.sticker_viability = summary;
    return { render: true, forced: false, entry: null };
  }
  if (force) {
    row.sticker_viability = { ...summary, forced: true };
    return { render: true, forced: true, entry: null };
  }
  row.sticker_viability = { ...summary, status: STICKER_NEEDS_FIX };
  const entry = { at, command, kind: 'sticker', row: row.key ?? null, label: row.label ?? null, logo, logo_sha256: logoSha, source: null, column: columnHex, verdict: summary.verdict, reasons: summary.reasons, status: STICKER_NEEDS_FIX };
  manifest.skipped = [...(manifest.skipped ?? []), entry];
  return { render: false, forced: false, entry };
}
/** true when the row's sticker mock may render (passes, forced, or never assessed on a legacy sheet). */
export function stickerRenderable(row) {
  return !(row.sticker_viability && row.sticker_viability.pass === false && !row.sticker_viability.forced);
}
// ---- cell on card (Travisse 2026-10-01) -------------------------------------------------
/** Pure: the share of a logo's ink held by the components that vanish on the card, from a component-contrast result. */
export function vanishedInkShare(result) {
  const failing = new Set(result.failingComponents ?? []);
  return Number((result.components ?? []).filter((c) => failing.has(c.id)).reduce((sum, c) => sum + (c.areaShareOfInk ?? 0), 0).toFixed(4));
}
/**
 * Pure: turn a component-contrast result (logo on the row primary) into the cell verdict.
 * ink_vanishes_on_card when at least card_vanish_min_ink_share of the ink vanishes; ok otherwise.
 */
export function cardContrastVerdict(result, { primary = result.primary ?? null, minShare = sheetViabilityThresholds().card_vanish_min_ink_share ?? 0.5 } = {}) {
  const vanished = vanishedInkShare(result);
  const failing = (result.failingComponents ?? []).length;
  const total = (result.components ?? []).length;
  if (vanished >= minShare) {
    return { pass: false, verdict: 'ink_vanishes_on_card', primary, vanished_ink_share: vanished, failing_components: failing, components: total, min_share: minShare, reasons: [`${Math.round(vanished * 100)}% of the logo ink sits in ${failing} of ${total} components that vanish on the ${primary} card (under ${result.minContrast ?? 3}:1): the lockup is not a variant on this primary`] };
  }
  return { pass: true, verdict: 'ok', primary, vanished_ink_share: vanished, failing_components: failing, components: total, min_share: minShare, reasons: [] };
}
/**
 * Pure: apply a card-contrast verdict to a (row, column) pair about to become a cell.
 * pass -> the pair carries ink_on_card; fail + force -> the pair carries a NOT VIABLE viability and is kept;
 * fail -> a kind:'cell' entry lands in manifest.skipped and the pair is NOT turned into a cell (no letter).
 */
export function applyCellViability(manifest, row, column, result, { force = false, command = 'add-row', at = new Date().toISOString() } = {}) {
  const primary = result.primary ?? rowPrimary(manifest, row);
  const summary = { pass: Boolean(result.pass), verdict: result.verdict ?? (result.pass ? 'ok' : 'unknown'), reasons: result.reasons ?? [], primary, vanished_ink_share: result.vanished_ink_share ?? null, checked_at: at };
  if (result.pass) return { keep: true, forced: false, entry: null, ink_on_card: summary, viability: null };
  if (force) return { keep: true, forced: true, entry: null, ink_on_card: { ...summary, forced: true }, viability: { pass: false, verdict: summary.verdict, reasons: summary.reasons, forced: true, kind: 'cell' } };
  const entry = { at, command, kind: 'cell', row: row.key ?? null, label: row.label ?? null, logo: row.logo ?? null, logo_sha256: row.logo_sha256 ?? null, source: null, column: column.hex ?? null, column_index: column.index ?? null, primary, verdict: summary.verdict, reasons: summary.reasons, vanished_ink_share: summary.vanished_ink_share };
  manifest.skipped = [...(manifest.skipped ?? []), entry];
  return { keep: false, forced: false, entry, ink_on_card: null, viability: null };
}
/**
 * Gate (row, column) pairs on the card before any letter is taken: one component-contrast measurement per
 * (logo, primary), cached for the call. Returns the pairs that become cells, each carrying ink_on_card
 * (and, under --force-viability, the NOT VIABLE viability). Refused pairs print a skip line and take no letter.
 */
export async function gateCells(manifest, pairs, { force = false, command = 'build', measure = componentContrastCheck } = {}) {
  const cache = new Map();
  const kept = [];
  for (const pair of pairs) {
    const primary = rowPrimary(manifest, pair.row);
    const key = `${pair.row.logo_sha256 ?? pair.row.logo}|${primary}`;
    if (!cache.has(key)) cache.set(key, cardContrastVerdict(await measure(pair.row.logo, primary), { primary }));
    const applied = applyCellViability(manifest, pair.row, pair.column, cache.get(key), { force, command });
    if (!applied.keep) { process.stderr.write(skipLine(applied.entry)); continue; }
    kept.push({ ...pair, ink_on_card: applied.ink_on_card, viability: applied.viability });
  }
  return kept;
}

/**
 * Gate the sticker asset of a row that is (or stays) on the sheet. The card logo was already gated by
 * gateRow, so a sticker that IS the card logo inherits; any other asset runs opaque_ground itself.
 */
export async function gateStickerRow(manifest, row, { force, command, columnHex = null }) {
  const logo = stickerLogoFor(manifest, row);
  const logoSha = await fileSha256(logo);
  if (path.resolve(logo) === path.resolve(row.logo)) {
    row.sticker_viability = { pass: true, verdict: 'ok', reasons: [], logo, logo_sha256: logoSha, inherited: 'card logo', checked_at: new Date().toISOString() };
    return true;
  }
  const cached = row.sticker_viability && row.sticker_viability.logo_sha256 === logoSha;
  const result = cached
    ? { pass: row.sticker_viability.pass, verdict: row.sticker_viability.verdict, reasons: row.sticker_viability.reasons }
    : await checkSheetViability(logo);
  if (cached && (result.pass || row.sticker_viability.forced)) return true;
  const applied = applyStickerViability(manifest, row, result, { force, command, columnHex, logo, logoSha });
  if (!applied.render) process.stderr.write(skipLine(applied.entry));
  return applied.render;
}
/** Check a row before it is rendered: fills row.viability_source / row.viability, prints skip lines, returns keep. */
async function gateRow(manifest, row, { force, command, outDir, runDir, source = null, note = null, columnHex = null }) {
  const cached = row.viability && row.viability.logo_sha256 && row.viability.logo_sha256 === row.logo_sha256;
  if (!cached) {
    row.viability_source = source ?? row.viability_source ?? wordsCutSource(row.logo, outDir, runDir);
    const result = await checkSheetViability(row.logo, { source: row.viability_source, expected: manifest.business_name ?? null, label: row.label, note: note ?? row.note ?? null });
    const applied = applyViability(manifest, row, result, { force, command, columnHex });
    if (!applied.keep) process.stderr.write(skipLine(applied.entry));
    return applied.keep;
  }
  if (row.viability.pass || row.viability.forced) return true;
  const applied = applyViability(manifest, row, { pass: false, verdict: row.viability.verdict, reasons: row.viability.reasons }, { force, command, columnHex });
  if (!applied.keep) process.stderr.write(skipLine(applied.entry));
  return applied.keep;
}

// ---- color helpers -------------------------------------------------------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
function luminance(hex) {
  const ch = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}
function hslToRgb({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 };
}
export function shiftLightness(hex, delta) {
  const hsl = rgbToHsl(hexToRgb(hex));
  hsl.l = Math.max(0.03, Math.min(0.97, hsl.l + delta));
  return rgbToHex(hslToRgb(hsl));
}
// Perceptual-ish distance in RGB, enough for dedupe.
function colorDistance(a, b) {
  const p = hexToRgb(a);
  const q = hexToRgb(b);
  return Math.sqrt((p.r - q.r) ** 2 + (p.g - q.g) ** 2 + (p.b - q.b) ** 2);
}
export function normalizeHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}
function requireHex(value, flag) {
  const hex = normalizeHex(value ?? '');
  if (!hex) throw new Error(`${flag} must be a 6-digit hex like #8D0000 (got "${value}")`);
  return hex;
}

// ---- candidate secondaries -----------------------------------------------
export function candidateSecondaries({ decision, evidence, overrides, allowLighter = false }) {
  const primary = normalizeHex(decision.palette.web_primary_color);
  const chosen = normalizeHex(decision.palette.web_secondary_color);
  const list = [];
  const seen = [];
  const add = (hex, source, label) => {
    const h = normalizeHex(hex);
    if (!h) return false;
    if (primary && colorDistance(h, primary) < 24) return false;
    if (seen.some((s) => colorDistance(s, h) < 18)) return false;
    seen.push(h);
    list.push({ hex: h, source, label });
    return true;
  };
  if (overrides?.length) {
    add(chosen, 'fable_chosen', 'chosen');
    overrides.forEach((hex, i) => add(hex, 'override', `override ${i + 1}`));
  } else {
    add(chosen, 'fable_chosen', 'chosen');
    const candidate = (evidence?.logo_candidates ?? []).find((c) => c.local_path === decision.logo_choice)
      ?? (evidence?.logo_candidates ?? [])[0];
    let inks = 0;
    const families = candidate?.gradient_families ?? [];
    for (const color of candidate?.measured_colors ?? []) {
      if (inks >= MAX_LOGO_INKS) break;
      let h = normalizeHex(color.hex);
      if (!h) continue;
      if ((color.pixel_share ?? 0) < LOGO_INK_MIN_SHARE) continue; // below 3% is antialias blend, not an ink
      const { l, s } = rgbToHsl(hexToRgb(h));
      if (l > 0.93) continue; // near-white: card ground, not a band ink
      if (l < 0.08 && s < 0.2 && list.some((x) => x.source !== 'fable_chosen')) continue; // one near-black is enough
      // GRADIENT INK (Coloradough 2026-09-18): a bucket of a gradient family stands in for the family's CENTER,
      // never the dark pole, and the label says so.
      const family = families.find((f) => normalizeHex(f.dark_pole) === h || normalizeHex(f.light_pole) === h || normalizeHex(f.center_hex) === h || (s >= 0.25 && Math.abs(((rgbToHsl(hexToRgb(h)).h * 360 - f.hue + 540) % 360) - 180) <= 14));
      if (family) {
        const center = normalizeHex(family.center_hex);
        if (add(center, 'logo_ink', `logo ink ${Math.round(family.pixel_share * 100)}% (gradient center)`)) inks += 1;
        continue;
      }
      if (add(h, 'logo_ink', `logo ink ${Math.round(color.pixel_share * 100)}%`)) inks += 1;
    }
    let tokens = 0;
    const authored = (evidence?.website?.authored_color_tokens ?? [])
      .filter((t) => t.evidence_class === 'theme_authored')
      .sort((a, b) => (b.semantic_count ?? 0) - (a.semantic_count ?? 0));
    for (const token of authored) {
      if (tokens >= MAX_SITE_TOKENS) break;
      const h = normalizeHex(token.hex);
      if (!h) continue;
      const { l } = rgbToHsl(hexToRgb(h));
      if (l > 0.93) continue;
      if (add(h, 'site_token', `site token x${token.semantic_count ?? token.count ?? 0}`)) tokens += 1;
    }
  }
  if (chosen) {
    for (const step of allowLighter ? [...LADDER, LIGHTER_STEP] : LADDER) {
      const h = shiftLightness(chosen, step.delta);
      if (seen.some((s) => colorDistance(s, h) < 18)) continue;
      seen.push(h);
      list.push({ hex: h, source: step.key, label: step.label });
    }
  }
  return { primary, chosen, candidates: list };
}

// ---- default letter ----------------------------------------------------------
/**
 * Fable's default cell, computed from the sheet and the decision marks (run.json decision.marks, written by
 * validate-fable-decision.ts). Pure. Returns { letter, reason, hold }:
 *   base      = the card-knockout row (else the first row) at the fable_chosen column;
 *   band rule = when marks.band_over_brand_ink names a mark ink, the default moves to that ink's column on the same
 *               row, provided the cell's print digit passes or has a brand-owned fix (Toscano's cream -> orange,
 *               Skyboxx tan -> orange, 2026-09-16/17);
 *   hold      = when marks.traced_from_small_source, the default is not a default: the cell is marked HOLD with the
 *               native source px on its label and fable_default_letter stays null until a human accepts it.
 */
export function defaultLetterFor(manifest, marks = {}) {
  const cells = Object.values(manifest.cells ?? {});
  if (!cells.length) return { letter: null, reason: 'no cells', hold: false };
  const row = manifest.rows.find((r) => r.key === 'knockout') ?? manifest.rows[0];
  const chosenCol = manifest.columns.find((c) => c.source === 'fable_chosen') ?? manifest.columns[0];
  let cell = cells.find((c) => c.row === row.key && c.column_index === chosenCol.index) ?? cells.find((c) => c.row === row.key) ?? cells[0];
  let reason = `${row.label} at ${provenanceWords(chosenCol.source, chosenCol.label)}`;
  const band = marks?.band_over_brand_ink;
  if (band?.mark_ink) {
    const ink = normalizeHex(band.mark_ink);
    const col = manifest.columns.find((c) => colorDistance(c.hex, ink) < 18 && c.source !== 'fable_chosen');
    const target = col ? cells.find((c) => c.row === row.key && c.column_index === col.index) : null;
    if (target && (target.badge_digit_print?.pass || target.badge_digit_print?.fix)) {
      cell = target;
      reason = `band rule: Fable's ${band.web_secondary_color} is ${band.reason === 'neutral_secondary' ? 'a neutral' : 'not a mark ink'}; the mark's ${ink} (${Math.round((band.mark_ink_share ?? 0) * 100)}% of ink) takes the band`;
    }
  }
  if (marks?.traced_from_small_source) {
    return { letter: cell.letter, reason: `HOLD: traced from a ${marks.source_native_longest_px ?? '?'}px source (floor 700px); ${reason}`, hold: true, native_px: marks.source_native_longest_px ?? null };
  }
  return { letter: cell.letter, reason, hold: false, native_px: marks?.source_native_longest_px ?? null };
}

/** Sampled dominant saturated color across in-store photos (Chuy's flight blue, 2026-09-18). Pure on raw pixel buffers; async wrapper below reads files. */
export function dominantHueFromPixels(buffers) {
  const bins = new Map();
  let saturated = 0;
  for (const { data, channels } of buffers) {
    for (let o = 0; o + 2 < data.length; o += channels) {
      const { h, s, l } = rgbToHsl({ r: data[o], g: data[o + 1], b: data[o + 2] });
      if (s < 0.35 || l < 0.2 || l > 0.75) continue;
      saturated += 1;
      const bin = Math.floor((h * 360) / 15) % 24;
      const b = bins.get(bin) ?? { n: 0, r: 0, g: 0, bl: 0 };
      b.n += 1; b.r += data[o]; b.g += data[o + 1]; b.bl += data[o + 2];
      bins.set(bin, b);
    }
  }
  if (!saturated) return null;
  const [bin, b] = [...bins.entries()].sort((x, y) => y[1].n - x[1].n)[0];
  return { hex: rgbToHex({ r: Math.round(b.r / b.n), g: Math.round(b.g / b.n), b: Math.round(b.bl / b.n) }), hue: bin * 15 + 7.5, share: Number((b.n / saturated).toFixed(3)), saturated_pixels: saturated };
}
export async function dominantInstoreColor(files) {
  const buffers = [];
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    try {
      const { data, info } = await sharp(file).rotate().resize(96, 96, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      buffers.push({ data, channels: info.channels });
    } catch { /* skip unreadable photos */ }
  }
  const dominant = dominantHueFromPixels(buffers);
  return dominant ? { ...dominant, images: buffers.length } : null;
}
export function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
export function chromaOf(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

// ---- badge digit contrast -------------------------------------------------
export function badgeDigit(secondary, textColor) {
  const white = contrast(secondary, '#FFFFFF');
  const black = contrast(secondary, '#000000');
  const current = contrast(secondary, textColor);
  return {
    text_color: textColor,
    contrast_with_text: Number(current.toFixed(2)),
    contrast_white_digit: Number(white.toFixed(2)),
    contrast_black_digit: Number(black.toFixed(2)),
    pass: current >= 3.0,
    fix: current >= 3.0 ? null : (white >= 3.0 ? '#FFFFFF' : black >= 3.0 ? '#000000' : null),
  };
}

// ---- letters, fingerprints, cache -------------------------------------------
/** Cell letters in creation order: A..Z, then AA, AB, ... (never renumbered). */
export function letterFor(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
const fileShaCache = new Map();
export async function fileSha256(file) {
  const abs = path.resolve(file);
  if (!fileShaCache.has(abs)) fileShaCache.set(abs, sha256(await fs.readFile(abs)));
  return fileShaCache.get(abs);
}

/** Deterministic input fingerprint for one rendered piece (card, sticker, or POP tile). */
export function fingerprint(kind, parts) {
  const ordered = Object.fromEntries(Object.keys(parts).sort().map((k) => [k, parts[k]]));
  return sha256(`${kind}\n${JSON.stringify(ordered)}`);
}
export function cardFingerprint({ logoSha, primary, secondary, text, textSecondary, treatment }) {
  return fingerprint('card', { logo_sha256: logoSha, primary, secondary, text, text_secondary: textSecondary, treatment, harness: 'badge-preview-harness' });
}
export function stickerFingerprint({ logoSha, band }) {
  return fingerprint('sticker', { logo_sha256: logoSha, band });
}
export function popFingerprint({ logoSha, band, offer }) {
  return fingerprint('pop', { logo_sha256: logoSha, band, offer });
}
export function cachePath(outDir, kind, fp) {
  return path.join(outDir, CELLS_DIR, `${kind}-${fp.slice(0, 16)}.png`);
}
/** true when the cached render for this fingerprint exists (cache hit). */
export function cacheHas(outDir, kind, fp) {
  return existsSync(cachePath(outDir, kind, fp));
}

// ---- renderers (templates/sheet-templates.js; no browser on the default path) --------
// LIGHT PRIMARY rule: a white knockout on a light card (primary fails 3:1 vs white) is invisible.
// Recolor every ink pixel to the card text ink (or black when the text ink is light too) and
// keep alpha; the row label says so and the cell json records the ink used.
async function tintKnockout(srcFile, outFile, hex) {
  const { r, g, b } = hexToRgb(hex);
  const { data, info } = await sharp(srcFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(outFile);
  return outFile;
}

/** Run-dir-relative form of a path (what the browser-facing JSON carries); null stays null. */
export function relRun(runDir, p) {
  if (!p) return null;
  return path.isAbsolute(p) && runDir ? path.relative(runDir, p) : p;
}
/** img src for a run-dir-relative path from an HTML file in `fromDir` (segments URL-encoded). */
export function srcFrom(runDir, fromDir) {
  return (rel) => path.relative(fromDir, path.join(runDir, rel)).split(path.sep).map(encodeURIComponent).join('/');
}

// ---- manifest (variant-sheet.json is the source of truth) ---------------------
function manifestPath(outDir) {
  return path.join(outDir, 'variant-sheet.json');
}
async function loadManifest(outDir) {
  const file = manifestPath(outDir);
  if (!existsSync(file)) throw new Error(`No variant-sheet.json in ${outDir}; run \`variant-sheet.mjs build\` first.`);
  return normalizeManifest(JSON.parse(await fs.readFile(file, 'utf8')), outDir);
}
async function saveManifest(outDir, manifest) {
  manifest.updated_at = new Date().toISOString();
  manifest.revision = (manifest.revision ?? 0) + 1;
  const file = manifestPath(outDir);
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

/** Fill in the incremental fields for a sheet json written before they existed (legacy build output). */
export function normalizeManifest(manifest, outDir) {
  // schema 3 (2026-10-13): cells carry a `view` block (everything the browser needs to draw the cell from
  // templates/sheet-templates.js); schema 2 sheets are adopted in place and their views derived on demand.
  manifest.schema = 3;
  manifest.render = 'html';
  manifest.offer = manifest.offer ?? DEFAULT_OFFER;
  manifest.url_base = manifest.url_base ?? DEFAULT_URL_BASE;
  manifest.sticker_logo = manifest.sticker_logo ?? null;
  manifest.rows = (manifest.rows ?? []).map((row) => ({ primary: null, text: null, knockout: null, sticker_logo: null, ...row, logo_rel: relRun(manifest.run_dir, row.logo), sticker_logo_rel: relRun(manifest.run_dir, row.sticker_logo) }));
  manifest.columns = (manifest.columns ?? []).map((col, i) => ({ index: i, one_off: false, ...col }));
  manifest.cells = manifest.cells ?? {};
  manifest.skipped = manifest.skipped ?? [];
  const letters = Object.keys(manifest.cells);
  for (const letter of letters) {
    const cell = manifest.cells[letter];
    cell.id = cell.id ?? letter;
    cell.view = cell.view ?? null;
    if (cell.column_index == null) {
      const idx = manifest.columns.findIndex((col) => col.hex === cell.secondary);
      cell.column_index = idx >= 0 ? idx : null;
    }
    cell.status = cell.status ?? null;
    cell.note = cell.note ?? null;
    cell.fingerprint = cell.fingerprint ?? null;
  }
  if (manifest.next_letter == null) {
    // Legacy sheets were sequential in creation order, so the count is the next index.
    let max = letters.length;
    for (const letter of letters) {
      const idx = letterIndex(letter);
      if (idx != null && idx + 1 > max) max = idx + 1;
    }
    manifest.next_letter = max;
  }
  manifest.print_text_secondary = manifest.print_text_secondary ?? Object.values(manifest.cells)[0]?.print_text_secondary ?? manifest.text ?? null;
  manifest.fable_default_letter = manifest.fable_default_letter ?? null;
  manifest.hold = manifest.hold ?? null;
  manifest.applied_letter = manifest.applied_letter ?? null;
  manifest.revision = manifest.revision ?? 1;
  manifest.out_dir = outDir;
  manifest.sheet_html = manifest.sheet_html ?? (outDir ? path.join(outDir, SHEET_HTML) : null);
  return manifest;
}
export function letterIndex(letter) {
  if (!/^[A-Z]+$/.test(letter)) return null; // "A1"-style legacy overflow letters keep their slot by count
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function rowPrimary(manifest, row) {
  return row.primary ?? manifest.primary;
}
function rowText(manifest, row) {
  return row.text ?? manifest.text;
}
function darkestColumn(manifest) {
  return [...manifest.columns].sort((a, b) => luminance(a.hex) - luminance(b.hex))[0];
}
/** Sticker band rule: the row's primary unless it fails on white, then the darkest column. */
export function stickerBand(manifest, row) {
  const primary = row.print_primary ?? rowPrimary(manifest, row);
  if (contrast(primary, '#FFFFFF') >= 3.0) return { band: primary, note: row.print_primary ? `print primary ${row.print_primary}` : 'primary' };
  const darkest = darkestColumn(manifest);
  return { band: darkest.hex, note: `primary ${primary} fails on white (${contrast(primary, '#FFFFFF').toFixed(2)}:1); band = darkest candidate ${darkest.hex}` };
}

// ---- views: what the browser needs per cell (no rendering here) ----------------------
/**
 * Pure (given the manifest's recorded sticker state): the `view` block of one cell, with logo paths
 * relative to the run dir. The browser (variants/variant-sheet.html, the review canvas, the public review
 * site) draws the card, sticker mock and POP tile from it with templates/sheet-templates.js.
 */
export function cellView(manifest, cell) {
  const row = manifest.rows.find((r) => r.key === cell.row);
  if (!row) throw new Error(`Cell ${cell.letter} points at a row that is not on the sheet (${cell.row})`);
  const rel = (p) => relRun(manifest.run_dir, p);
  const digit = cell.badge_digit_web;
  const rejected = cell.status === 'rejected';
  const { band } = stickerBand(manifest, row);
  const stickerOk = stickerRenderable(row);
  const stickerLogo = stickerOk ? (row.sticker_logo_used && existsSync(row.sticker_logo_used) ? row.sticker_logo_used : stickerLogoFor(manifest, row)) : null;
  const status = cell.status && STATUS_STYLE[cell.status] ? cell.status : null;
  const copy = signageCopy(manifest.offer ?? DEFAULT_OFFER);
  const links = manifest.qr_links ?? null;
  return {
    letter: cell.letter,
    row: cell.row,
    row_label: cell.row_label ?? row.label,
    column_index: cell.column_index ?? null,
    header: { text: cellLabelText(manifest, cell), bg: rejected ? STATUS_STYLE.rejected.color : digit?.pass ? '#1B5E20' : '#B71C1C' },
    card: { logo: rel(row.logo), primary: cell.primary, secondary: cell.secondary, text: cell.text, text_secondary: cell.text, issue_id: 1 },
    sticker: stickerLogo
      ? { logo: rel(stickerLogo), band, headline: copy.sticker.title, body: copy.sticker.body, layout: copy.sticker.layout, qr: qrView(links?.table_promo), seed: templates.seedFrom(path.basename(stickerLogo) + band), status: null }
      : { logo: null, band, headline: copy.sticker.title, body: copy.sticker.body, layout: copy.sticker.layout, qr: null, seed: null, status: STICKER_NEEDS_FIX },
    pop: { logo: rel(row.pop_logo && existsSync(row.pop_logo) ? row.pop_logo : row.logo), ground: row.pop_ground ?? band, offer: copy.pop.title, body: copy.pop.body, qr: qrView(links?.pop) },
    print: { primary: cell.print_primary ?? null, secondary: cell.print_secondary ?? null, text_secondary: cell.print_text_secondary ?? null, fix: cell.badge_digit_print?.fix ?? null, digit_contrast: cell.badge_digit_print?.contrast_with_text ?? null },
    status,
    status_tag: status ? STATUS_STYLE[status].tag : null,
    rejected,
    not_viable: cell.viability && cell.viability.pass === false ? { verdict: cell.viability.verdict } : null,
  };
}
/** The whole sheet as the browser sees it: header texts, columns, rows and every cell view (derived when a cell has none). */
export function sheetView(manifest) {
  return {
    business_name: manifest.business_name ?? null,
    primary: manifest.primary,
    text: manifest.text,
    offer: manifest.offer ?? DEFAULT_OFFER,
    revision: manifest.revision ?? null,
    fable_default_letter: manifest.fable_default_letter ?? null,
    hold: manifest.hold ?? null,
    applied_letter: manifest.applied_letter ?? null,
    columns: manifest.columns.map((col) => ({ index: col.index, hex: col.hex, source: col.source, label: col.label, text: `${col.hex}  ${provenanceWords(col.source, col.label)}` })),
    rows: manifest.rows.map((row) => ({ key: row.key, label: row.label, text: rowLabelText(manifest, row) })),
    cells: Object.fromEntries(Object.values(manifest.cells).map((cell) => [cell.letter, cell.view ?? cellView(manifest, cell)])),
  };
}
/**
 * Record the per-row sticker/POP state and per-cell fingerprints for the given rows and cells (what
 * renderPieces used to do around its renders), without rendering anything. Legacy files a row or cell
 * already has stay recorded; new ones carry null until `render --cell` writes them.
 */
async function prepareViews(manifest, outDir, { rows: rowsArg, cells }) {
  const rows = rowsArg.map((r) => manifest.rows.find((x) => x.key === r.key) ?? r);
  const counts = { rendered: { cards: 0, stickers: 0, pops: 0 }, cached: { cards: 0, stickers: 0, pops: 0 }, views: 0 };
  for (const row of rows) {
    const { band, note } = stickerBand(manifest, row);
    const stickerOk = stickerRenderable(row);
    const stickerLogo = stickerOk ? stickerLogoFor(manifest, row) : null;
    const stickerFp = stickerOk ? stickerFingerprint({ logoSha: await fileSha256(stickerLogo), band }) : null;
    const popFp = popFingerprint({ logoSha: await fileSha256(row.pop_logo && existsSync(row.pop_logo) ? row.pop_logo : row.logo), band: row.pop_ground ?? band, offer: manifest.offer });
    const keep = (file) => (file && existsSync(file) ? file : null);
    Object.assign(row, { sticker: stickerOk ? keep(row.sticker) : null, sticker_status: stickerOk ? null : STICKER_NEEDS_FIX, sticker_band: band, sticker_band_note: note, pop: keep(row.pop), sticker_fingerprint: stickerFp, pop_fingerprint: popFp, sticker_logo_used: stickerLogo });
    if (!stickerOk) counts.skipped_stickers = (counts.skipped_stickers ?? 0) + 1;
    for (const cell of Object.values(manifest.cells)) {
      if (cell.row === row.key) Object.assign(cell, { sticker: row.sticker, sticker_status: row.sticker_status ?? null, sticker_band: row.sticker_band, pop: row.pop });
    }
  }
  for (const cell of cells) {
    const row = manifest.rows.find((r) => r.key === cell.row);
    const fp = cardFingerprint({ logoSha: await fileSha256(row.logo), primary: cell.primary, secondary: cell.secondary, text: cell.text, textSecondary: cell.text, treatment: row.key });
    Object.assign(cell, { card: cell.card && existsSync(cell.card) ? cell.card : null, fingerprint: fp, cache: cacheHas(outDir, 'card', fp) ? cachePath(outDir, 'card', fp) : null, sticker: row.sticker, sticker_status: row.sticker_status ?? null, sticker_band: row.sticker_band, pop: row.pop });
  }
  for (const cell of Object.values(manifest.cells)) { cell.view = cellView(manifest, cell); counts.views += 1; }
  manifest.row_assets = manifest.rows.map((row) => ({ row: row.key, sticker: row.sticker, sticker_status: row.sticker_status ?? null, sticker_band: row.sticker_band, sticker_band_note: row.sticker_band_note, pop: row.pop }));
  return counts;
}

/** The NOT VIABLE badge of a cell: a forced card failure, else a forced sticker failure (verdict prefixed "sticker"). */
export function cellViability(row) {
  if (row.viability && row.viability.pass === false) return { pass: false, verdict: row.viability.verdict, reasons: row.viability.reasons, forced: true };
  const sv = row.sticker_viability;
  if (sv && sv.pass === false && sv.forced) return { pass: false, verdict: `sticker ${sv.verdict}`, reasons: sv.reasons, forced: true, kind: 'sticker' };
  return null;
}
function makeCell(manifest, row, column, letter, { viability = undefined, inkOnCard = null } = {}) {
  const primary = rowPrimary(manifest, row);
  const text = rowText(manifest, row);
  const printTextSecondary = row.print_text_secondary ?? manifest.print_text_secondary ?? text;
  const printPrimary = row.print_primary ?? primary;
  const printSecondary = row.print_secondary ?? column.hex;
  return {
    letter,
    id: letter,
    row: row.key,
    row_label: row.label,
    column_index: column.index,
    logo: row.logo,
    primary,
    secondary: column.hex,
    secondary_source: column.source,
    secondary_label: column.label,
    text,
    print_primary: printPrimary,
    print_secondary: printSecondary,
    print_text_secondary: printTextSecondary,
    badge_digit_web: badgeDigit(column.hex, text),
    badge_digit_print: badgeDigit(printSecondary, printTextSecondary),
    card: null,
    sticker: null,
    sticker_status: row.sticker_viability && row.sticker_viability.pass === false && !row.sticker_viability.forced ? STICKER_NEEDS_FIX : null,
    sticker_band: null,
    pop: null,
    fingerprint: null,
    status: null,
    note: null,
    viability: viability === undefined ? cellViability(row) : (viability ?? cellViability(row)),
    ink_on_card: inkOnCard,
  };
}
/**
 * Append cells for (row, column) pairs with the next free letters. Pure: returns the new cells.
 * Only pairs that reach here take a letter: gateCells drops a pair whose ink vanishes on the card first,
 * so letters stay contiguous for the rendered cells. A pair may carry viability / ink_on_card from gateCells.
 */
export function appendCells(manifest, pairs) {
  const created = [];
  for (const { row, column, viability, ink_on_card: inkOnCard } of pairs) {
    const letter = letterFor(manifest.next_letter);
    manifest.next_letter += 1;
    const cell = makeCell(manifest, row, column, letter, { viability, inkOnCard: inkOnCard ?? null });
    manifest.cells[letter] = cell;
    created.push(cell);
  }
  return created;
}

// ---- compose the montage (from cached pieces only) ------------------------------
export function sheetGeometry(manifest) {
  const cardH = Math.round(CARD_W * 1200 / 772);
  const sideH = Math.round((cardH - CELL_PAD) / 2);
  const cellW = CARD_W + SIDE_W + CELL_PAD * 3;
  const cellH = LABEL_H + cardH + CELL_PAD * 2;
  return { cardH, sideH, cellW, cellH, sheetW: ROW_HEADER_W + manifest.columns.length * cellW, sheetH: COL_HEADER_H + manifest.rows.length * cellH };
}
export function rowLabelText(manifest, row) {
  if (row.primary_source === 'instore') return `${row.label} ${row.primary}`; // "in-store #90532E": the row header is 120px wide
  const base = row.primary && row.primary !== manifest.primary ? `${row.label}  primary ${row.primary}` : row.label;
  return row.print_primary ? `${base}  print primary ${row.print_primary}` : base;
}
/** The print-side words on a cell label: only when the cell's print roles differ from its web roles. */
export function printRolesText(cell) {
  const parts = [];
  if (cell.print_primary && cell.print_primary !== cell.primary) parts.push(`print primary ${cell.print_primary}`);
  if (cell.print_secondary && cell.print_secondary !== cell.secondary) {
    const d = cell.badge_digit_print;
    parts.push(`print band ${cell.print_secondary}${d ? ` digit ${d.contrast_with_text}:1 ${d.pass ? 'ok' : `LOW${d.fix ? `, use ${d.fix === '#FFFFFF' ? 'white' : 'black'} digit` : ''}`}` : ''}`);
  }
  return parts.length ? `   ${parts.join('  ')}` : '';
}
/** Pure: the header strip of a cell. A human-rejected cell says REJECTED right after its letter. */
export function cellLabelText(manifest, cell) {
  const digit = cell.badge_digit_web;
  const flag = digit.pass ? 'ok' : `LOW${digit.fix ? `, use ${digit.fix === '#FFFFFF' ? 'white' : 'black'} digit` : ', no brand fix'}`;
  const words = provenanceWords(cell.secondary_source, cell.secondary_label);
  const holdPx = cell.status === 'hold' && manifest.hold?.native_px ? `   source ${manifest.hold.native_px}px` : '';
  const printRoles = printRolesText(cell);
  const head = cell.status === 'rejected' ? `${cell.letter}  REJECTED` : cell.letter;
  // A print-role cell leads with its print palette so the 120px-per-column label never truncates it away.
  return printRoles
    ? `${head}${printRoles}   web band ${cell.secondary} digit ${digit.contrast_with_text}:1 ${flag}${holdPx}`
    : `${head}   ${cell.secondary} ${words}   digit ${digit.contrast_with_text}:1 ${flag}${holdPx}`;
}
/**
 * Write <out>/variant-sheet.html: the montage drawn from every cell's view with the vendored templates,
 * logos as relative <img src> into the run dir, plus the sheet view as an inline JSON block
 * (#variant-sheet-view) for client-side consumers. Refreshes every cell.view first and refuses a cell
 * whose logo file is missing instead of drawing a hole. With { raster: true } it also renders the page
 * once in memory (scripts/render-preview.mjs) and writes variant-sheet.png next to it.
 */
export async function composeSheet(manifest, outDir, { raster = false } = {}) {
  const runDir = manifest.run_dir ?? path.dirname(outDir);
  await ensureQrLinks(manifest, outDir);
  for (const cell of Object.values(manifest.cells)) {
    cell.view = cellView(manifest, cell);
    const card = path.join(runDir, cell.view.card.logo);
    if (!existsSync(card)) throw new Error(`Cell ${cell.letter}: card logo missing (${card}); rerun the subcommand that created it`);
    if (cell.view.sticker?.logo && !existsSync(path.join(runDir, cell.view.sticker.logo))) throw new Error(`Cell ${cell.letter}: sticker logo missing (${path.join(runDir, cell.view.sticker.logo)})`);
  }
  const view = sheetView(manifest);
  const { sheetW, sheetH } = sheetGeometry(manifest);
  const focus = manifest.fable_default_letter ? { letter: manifest.fable_default_letter, hold: false } : manifest.hold?.letter ? { letter: manifest.hold.letter, hold: true } : null;
  const body = `${templates.sheetHtml(view, { src: srcFrom(runDir, outDir), focus })}\n<script type="application/json" id="variant-sheet-view">${JSON.stringify(view).replace(/<\//g, '<\\/')}</script>`;
  const html = templates.pageHtml(body, { title: `${manifest.business_name ?? 'variant sheet'} variant sheet`, width: sheetW, background: '#C8C8C8' });
  const htmlFile = path.join(outDir, SHEET_HTML);
  await fs.writeFile(htmlFile, html);
  manifest.sheet_html = htmlFile;
  manifest.sheet = manifest.sheet ?? path.join(outDir, 'variant-sheet.png');
  if (raster) {
    const { renderSheetPng } = await import('./render-preview.mjs');
    const png = await renderSheetPng(html, { baseDir: outDir, width: sheetW, height: sheetH });
    await fs.writeFile(path.join(outDir, 'variant-sheet.png'), png);
    manifest.sheet = path.join(outDir, 'variant-sheet.png');
    manifest.sheet_png_rendered_at = new Date().toISOString();
  }
  return htmlFile;
}

// ---- shared finish: save json, stitch png, record run.json --------------------
async function finish(args, outDir, manifest, extra = {}) {
  const sheetFile = await composeSheet(manifest, outDir, { raster: Boolean(args.raster) });
  const manifestFile = await saveManifest(outDir, manifest);
  const recorded = args.run ? await recordVariantsBlock(path.resolve(args.run), manifestFile, manifest, { reason: extra.reason ?? `variant-sheet ${args.command}` }) : null;
  const pngFile = path.join(outDir, 'variant-sheet.png');
  const summary = {
    ok: true,
    command: args.command,
    sheet: sheetFile,
    sheet_html: sheetFile,
    sheet_png: existsSync(pngFile) ? pngFile : null,
    manifest: manifestFile,
    run_file: recorded ? recorded.file : null,
    rows: manifest.rows.length,
    columns: manifest.columns.length,
    cells: Object.keys(manifest.cells).length,
    skipped: manifest.skipped ?? [],
    ...extra,
  };
  delete summary.reason;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
function resolveOut(args, runDir) {
  return path.resolve(args.out ?? path.join(runDir, 'variants'));
}
function firstExisting(candidates) {
  return candidates.find((f) => f && existsSync(f)) ?? null;
}
function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'row';
}
function letterList(manifest) {
  return Object.values(manifest.cells).map((c) => `${c.letter}=${c.row}/${c.secondary}`);
}

// ---- build ---------------------------------------------------------------------
async function build(args) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  await fs.mkdir(outDir, { recursive: true });
  const existingFile = manifestPath(outDir);
  if (existsSync(existingFile) && !args.force) {
    const existing = JSON.parse(await fs.readFile(existingFile, 'utf8'));
    const marked = Object.values(existing.cells ?? {}).some((c) => c.status);
    if ((existing.revision ?? 1) > 1 || marked) {
      throw new Error(`${existingFile} has incremental additions or marks (revision ${existing.revision ?? 1}); use add-row/add-column/add-cell/mark, or pass --force to rebuild from the decision inputs.`);
    }
  }

  const decisionFile = path.resolve(args.decision ?? path.join(runDir, 'fable-decision.json'));
  const evidenceFile = path.resolve(args.evidence ?? path.join(runDir, 'evidence', 'branding-evidence.json'));
  const decision = JSON.parse(await fs.readFile(decisionFile, 'utf8'));
  const evidence = existsSync(evidenceFile) ? JSON.parse(await fs.readFile(evidenceFile, 'utf8')) : null;
  const businessName = evidence?.location?.location_name ?? path.basename(runDir);

  let logoKnockout = args.logoKnockout ? path.resolve(args.logoKnockout) : firstExisting([
    path.join(runDir, 'fix', 'card-final.png'),
    path.join(runDir, 'fix', 'card-final-upload.png'),
  ]);
  const logoColor = args.logoColor ? path.resolve(args.logoColor) : (decision.logo_choice && existsSync(decision.logo_choice) ? decision.logo_choice : null);
  const logoSticker = args.logoSticker ? path.resolve(args.logoSticker) : firstExisting([
    path.join(runDir, 'fix', 'sticker-logo-color.png'),
    path.join(runDir, 'fix', 'sticker-logo.png'),
    logoColor,
  ]);
  if (!logoKnockout || !existsSync(logoKnockout)) throw new Error('No card knockout found: pass --logo-knockout <png> (default fix/card-final.png).');

  // Words-only row: existing cut, else a deterministic cut of the knockout.
  let logoWords = args.logoWords ? path.resolve(args.logoWords) : null;
  let wordsNote = null;
  if (!logoWords && !args.noWords) {
    const existing = firstExisting([
      path.join(runDir, 'fix', 'words', 'card-words-1600.png'),
      path.join(runDir, 'fix', 'card-words-1600.png'),
    ]);
    if (existing) {
      logoWords = existing;
    } else {
      const target = path.join(outDir, 'card-words-1600.png');
      const cut = await cutWords(logoKnockout, target, { white: true, binaryAlpha: true, width: 1600 });
      await fs.writeFile(path.join(outDir, 'cut-words.json'), `${JSON.stringify(cut, null, 2)}\n`);
      if (cut.ok && cut.kept_ink_share < 0.985) {
        logoWords = target;
        wordsNote = `cut-words kept ${cut.kept_component_count} components (${Math.round(cut.kept_ink_share * 100)}% of ink)`;
      } else {
        wordsNote = cut.ok ? 'cut-words kept the whole mark; no words-only row' : `cut-words failed: ${cut.reason}`;
      }
    }
  }

  const overrides = args.secondaries ? args.secondaries.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const { primary, chosen, candidates } = candidateSecondaries({ decision, evidence, overrides, allowLighter: Boolean(args.allowLighter) });
  // decision marks (validate-fable-decision.ts writes them next to the six keys in run.json)
  const runJson = args.run && existsSync(path.join(path.resolve(args.run), 'run.json')) ? JSON.parse(await fs.readFile(path.join(path.resolve(args.run), 'run.json'), 'utf8')) : null;
  const marks = args.marks ? JSON.parse(await fs.readFile(path.resolve(args.marks), 'utf8')) : (runJson?.decision?.marks ?? {});
  if (marks?.band_over_brand_ink?.mark_ink && !overrides) {
    const ink = normalizeHex(marks.band_over_brand_ink.mark_ink);
    if (ink && !candidates.some((c) => colorDistance(c.hex, ink) < 18)) candidates.splice(1, 0, { hex: ink, source: 'mark_ink', label: `logo ink ${Math.round((marks.band_over_brand_ink.mark_ink_share ?? 0) * 100)}%` });
  }
  const columns = candidates.slice(0, Number(args.maxColumns)).map((col, i) => ({ index: i, ...col, one_off: false }));
  const text = normalizeHex(decision.palette.web_text_color) ?? '#FFFFFF';
  const printTextSecondary = normalizeHex(decision.palette.print_text_secondary_color) ?? text;

  // LIGHT PRIMARY rule (206 Burger 2026-09-09: cream card, white knockout rows rendered blank).
  const lightPrimary = contrast(primary, '#FFFFFF') < 3.0;
  let knockoutInk = null;
  if (lightPrimary) {
    knockoutInk = contrast(text, primary) >= 3.0 ? text : '#000000';
    logoKnockout = await tintKnockout(logoKnockout, path.join(outDir, 'card-knockout-ink.png'), knockoutInk);
    if (logoWords) logoWords = await tintKnockout(logoWords, path.join(outDir, 'card-words-ink.png'), knockoutInk);
  }

  const rows = [
    { key: 'knockout', label: knockoutInk ? `card knockout (ink ${knockoutInk})` : 'card knockout', logo: logoKnockout, knockout: true },
    logoColor ? { key: 'full_color', label: 'full color', logo: logoColor, knockout: false } : null,
    logoWords ? { key: 'words_only', label: knockoutInk ? `words only (ink ${knockoutInk})` : 'words only', logo: logoWords, knockout: true } : null,
  ].filter(Boolean).map((row) => ({ ...row, primary: null, text: null, sticker_logo: null }));
  // IN-STORE PRIMARY ROW (Chuy's 2026-09-18): the dominant painted color of the in-store photos becomes its own
  // primary row automatically when its hue is far from the site primary (or the primary is a neutral).
  let instore = null;
  if (!args.noInstore && evidence?.brand_environment) {
    const env = evidence.brand_environment;
    const photos = [...(env.detail_images ?? []), ...((env.selected_candidates ?? []).map((c) => c?.path ?? c?.local_path).filter(Boolean))];
    const dominant = await dominantInstoreColor([...new Set(photos)]);
    if (dominant && dominant.share >= INSTORE_MIN_SHARE) {
      const primaryHue = rgbToHsl(hexToRgb(primary)).h * 360;
      const far = chromaOf(primary) < 0.15 || hueDistance(primaryHue, dominant.hue) >= INSTORE_MIN_HUE_DISTANCE;
      const alreadyAColumn = columns.some((c) => colorDistance(c.hex, dominant.hex) < 24);
      instore = { ...dominant, far, added: far && !alreadyAColumn && contrast(dominant.hex, '#FFFFFF') >= 1.2 };
      if (instore.added) {
        rows.push({ key: 'instore_primary', label: 'in-store', logo: logoKnockout, knockout: true, primary: dominant.hex, primary_source: 'instore', primary_label: `sampled: ${Math.round(dominant.share * 100)}% of the saturated in-store pixels`, text: null, sticker_logo: null });
      }
    }
  }
  for (const row of rows) row.logo_sha256 = await fileSha256(row.logo);
  // The words-only row is checked against the wordmark it was cut from: the cut-words sidecar's `in`, else
  // (for the deterministic cut of the knockout) the knockout itself. An explicit --logo-words with no sidecar
  // is an authored asset, not a cut, and gets only the opaque-ground and label checks.
  const wordsSource = logoWords ? (wordsCutSource(logoWords, outDir, runDir) ?? (args.logoWords ? null : logoKnockout)) : null;

  const manifest = normalizeManifest({
    schema: 2,
    generated_at: new Date().toISOString(),
    run_dir: runDir,
    business_name: businessName,
    decision: decisionFile,
    primary,
    light_primary: lightPrimary,
    knockout_ink: knockoutInk,
    text,
    print_text_secondary: printTextSecondary,
    chosen_secondary: chosen,
    offer: args.offer ?? DEFAULT_OFFER,
    url_base: args.urlBase,
    sticker_logo: logoSticker && existsSync(logoSticker) ? logoSticker : null,
    sheet: path.join(outDir, 'variant-sheet.png'),
    rows,
    columns,
    words_note: wordsNote,
    row_assets: [],
    instore_dominant: instore,
    decision_marks: marks ?? null,
    cells: {},
    skipped: [],
    next_letter: 0,
    contract: 'Reviewer answers with one letter. Apply = that cell\'s logo as the card asset and its secondary as web_secondary_color + print_secondary_color; primary/text unchanged; badge_digit_print.fix, when set, is the print_text_secondary_color to use. A cell carrying print_primary / print_secondary (add-cell --print-primary / --print-secondary) applies those as print_primary_color / print_secondary_color instead; web roles unchanged.',
  }, outDir);
  manifest.revision = 0; // saveManifest bumps to 1
  // SHEET VIABILITY: refuse junk before it renders (Dogwood 2026-09-21: "Do woo Pizza" cut, white-square lockup).
  const viableRows = [];
  for (const row of rows) {
    const keep = await gateRow(manifest, row, { force: Boolean(args.forceViability), command: 'build', outDir, runDir, source: row.key === 'words_only' ? wordsSource : null });
    if (keep) viableRows.push(row);
  }
  if (!viableRows.length) throw new Error(`sheet-viability refused every row (${manifest.skipped.map((s) => `${s.row}: ${s.verdict}`).join('; ')}); fix the assets or pass --force-viability to render them with a NOT VIABLE badge.`);
  manifest.rows = viableRows;
  // STICKER GROUND: the sticker asset of every kept row is checked on the same terms before any cell exists.
  for (const row of viableRows) await gateStickerRow(manifest, row, { force: Boolean(args.forceViability), command: 'build' });
  // CELL ON CARD: a (row, column) whose ink vanishes on the card takes no letter (Travisse 2026-10-01).
  const pairs = await gateCells(manifest, viableRows.flatMap((row) => columns.map((column) => ({ row, column }))), { force: Boolean(args.forceViability), command: 'build' });
  if (!pairs.length) throw new Error(`every cell was refused on the card (${manifest.skipped.map((s) => `${s.row}${s.column ? ` x ${s.column}` : ''}: ${s.verdict}`).join('; ')}); fix the assets or pass --force-viability to render them with a NOT VIABLE badge.`);
  const renderRows = viableRows.filter((row) => pairs.some((p) => p.row.key === row.key));
  manifest.rows = renderRows;
  const created = appendCells(manifest, pairs);
  // Fable's default cell: the band rule can move it; a small-source trace turns it into a HOLD instead of a default.
  const def = defaultLetterFor(manifest, marks);
  if (def.letter) {
    applyMark(manifest, def.letter, def.hold ? 'hold' : 'fable_pick', { note: def.hold ? def.reason : `Fable default: ${def.reason}`, by: 'variant-sheet build' });
    if (def.hold) manifest.hold = { ...manifest.hold, native_px: def.native_px, reason: def.reason };
  }
  const counts = await prepareViews(manifest, outDir, { rows: renderRows, cells: created });
  return finish(args, outDir, manifest, { letters: letterList(manifest), words_note: wordsNote, default_letter: def, instore_dominant: instore, ...counts, reason: 'variant-sheet build' });
}

// ---- add-row / add-column / add-cell ----------------------------------------
async function addRow(args, { single = false } = {}) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  const manifest = await loadManifest(outDir);
  if (!args.logo || !args.label) throw new Error(`${args.command} needs --logo <png> --label "<treatment>"`);
  let logo = path.resolve(args.logo);
  if (!existsSync(logo)) throw new Error(`--logo not found: ${logo}`);
  const key = args.key ? slug(args.key) : slug(args.label);
  if (manifest.rows.some((r) => r.key === key)) throw new Error(`Row key "${key}" already exists; pass --key <other>`);
  const primary = args.primary ? requireHex(args.primary, '--primary') : null;
  const text = args.text ? requireHex(args.text, '--text') : null;
  const effectivePrimary = primary ?? manifest.primary;
  const effectiveText = text ?? manifest.text;
  let label = args.label;
  let knockoutInk = null;
  if (args.knockout && contrast(effectivePrimary, '#FFFFFF') < 3.0) {
    // LIGHT PRIMARY rule for a declared white-knockout treatment on a light row primary.
    knockoutInk = contrast(effectiveText, effectivePrimary) >= 3.0 ? effectiveText : '#000000';
    logo = await tintKnockout(logo, path.join(outDir, `${key}-knockout-ink.png`), knockoutInk);
    label = `${label} (ink ${knockoutInk})`;
  }
  const row = {
    key,
    label,
    logo,
    logo_sha256: await fileSha256(logo),
    primary,
    text,
    knockout: Boolean(args.knockout),
    knockout_ink: knockoutInk,
    sticker_logo: args.stickerLogo ? path.resolve(args.stickerLogo) : null,
    print_text_secondary: args.digit ? requireHex(args.digit, '--digit') : null,
    print_primary: args.printPrimary ? requireHex(args.printPrimary, '--print-primary') : null,
    print_secondary: args.printSecondary ? requireHex(args.printSecondary, '--print-secondary') : null,
    pop_logo: args.popLogo ? path.resolve(args.popLogo) : null,
    pop_ground: args.popGround ? requireHex(args.popGround, '--pop-ground') : null,
    note: args.note ?? null,
    added_at: new Date().toISOString(),
    added_by: args.command,
  };
  if ((row.print_primary || row.print_secondary) && !single) throw new Error('--print-primary / --print-secondary are add-cell options (one cell, one print palette)');
  if ((row.pop_logo || row.pop_ground) && !single) throw new Error('--pop-logo / --pop-ground are add-cell options (one cell, one POP treatment)');
  if (row.sticker_logo && !existsSync(row.sticker_logo)) throw new Error(`--sticker-logo not found: ${row.sticker_logo}`);
  if (row.pop_logo && !existsSync(row.pop_logo)) throw new Error(`--pop-logo not found: ${row.pop_logo}`);
  if (args.source && !existsSync(path.resolve(args.source))) throw new Error(`--source not found: ${args.source}`);
  // SHEET VIABILITY: the asset is checked before any cell exists; a refusal is recorded, printed, and not rendered.
  const keep = await gateRow(manifest, row, { force: Boolean(args.forceViability), command: args.command, outDir, runDir, source: args.source ? path.resolve(args.source) : null, note: args.note ?? null });
  if (!keep) {
    const manifestFile = await saveManifest(outDir, manifest);
    const recorded = args.run ? await recordVariantsBlock(path.resolve(args.run), manifestFile, manifest, { reason: `variant-sheet ${args.command} refused ${key}` }) : null;
    const refused = manifest.skipped[manifest.skipped.length - 1];
    process.stdout.write(`${JSON.stringify({ ok: true, command: args.command, added: false, refused, manifest: manifestFile, run_file: recorded ? recorded.file : null, rows: manifest.rows.length, cells: Object.keys(manifest.cells).length, skipped: manifest.skipped, rendered: { cards: 0, stickers: 0, pops: 0 } }, null, 2)}\n`);
    return null;
  }

  let columns;
  if (single) {
    const hex = requireHex(args.secondary, '--secondary');
    let column = manifest.columns.find((c) => c.hex === hex);
    if (!column) {
      column = { index: manifest.columns.length, hex, source: args.source ?? 'one_off', label: args.columnLabel ?? `one-off ${hex}`, one_off: true, added_at: new Date().toISOString() };
      manifest.columns.push(column);
    }
    columns = [column];
  } else if (args.secondaries) {
    columns = args.secondaries.split(',').map((s) => requireHex(s, '--secondaries')).map((hex) => {
      const column = manifest.columns.find((c) => c.hex === hex);
      if (!column) throw new Error(`--secondaries ${hex} is not a column on the sheet (${manifest.columns.map((c) => c.hex).join(', ')}); run add-column --secondary ${hex} first`);
      return column;
    });
  } else {
    columns = manifest.columns.filter((c) => !c.one_off);
  }
  // CELL ON CARD: a column whose cell would vanish on this row's primary takes no letter; a row with no cell left is not added.
  const pairs = await gateCells(manifest, columns.map((column) => ({ row, column })), { force: Boolean(args.forceViability), command: args.command });
  if (!pairs.length) {
    const manifestFile = await saveManifest(outDir, manifest);
    const recorded = args.run ? await recordVariantsBlock(path.resolve(args.run), manifestFile, manifest, { reason: `variant-sheet ${args.command} refused ${key} on the card` }) : null;
    const refused = manifest.skipped.filter((s) => s.kind === 'cell' && s.row === key);
    process.stdout.write(`${JSON.stringify({ ok: true, command: args.command, added: false, refused, manifest: manifestFile, run_file: recorded ? recorded.file : null, rows: manifest.rows.length, cells: Object.keys(manifest.cells).length, skipped: manifest.skipped, rendered: { cards: 0, stickers: 0, pops: 0 } }, null, 2)}\n`);
    return null;
  }
  await gateStickerRow(manifest, row, { force: Boolean(args.forceViability), command: args.command });
  manifest.rows.push(row);
  const created = appendCells(manifest, pairs);
  const counts = await prepareViews(manifest, outDir, { rows: [row], cells: created });
  return finish(args, outDir, manifest, { row: key, added: true, viability: row.viability, sticker_viability: row.sticker_viability ?? null, new_cells: created.map((c) => `${c.letter}=${c.row}/${c.secondary}`), letters: letterList(manifest), ...counts });
}

async function addColumn(args) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  const manifest = await loadManifest(outDir);
  const hex = requireHex(args.secondary, '--secondary');
  const existing = manifest.columns.find((c) => c.hex === hex);
  if (existing) throw new Error(`${hex} is already column ${existing.index} (${existing.label}); nothing to add`);
  const column = { index: manifest.columns.length, hex, source: args.source ?? 'override', label: args.label ?? `override ${hex}`, one_off: false, added_at: new Date().toISOString() };
  manifest.columns.push(column);
  // SHEET VIABILITY: a row that was never checked (legacy sheet) or fails is not extended into the new column.
  const rows = [];
  for (const row of manifest.rows) {
    const keep = await gateRow(manifest, row, { force: Boolean(args.forceViability), command: 'add-column', outDir, runDir, columnHex: hex });
    if (!keep) continue;
    await gateStickerRow(manifest, row, { force: Boolean(args.forceViability), command: 'add-column', columnHex: hex });
    rows.push(row);
  }
  // CELL ON CARD: a row whose ink vanishes on its primary in this column takes no letter for it.
  const pairs = await gateCells(manifest, rows.map((row) => ({ row, column })), { force: Boolean(args.forceViability), command: 'add-column' });
  const created = appendCells(manifest, pairs);
  // Sticker/POP renders of existing rows are cache hits unless the band rule changes for a light primary.
  const counts = await prepareViews(manifest, outDir, { rows: rows.filter((row) => pairs.some((p) => p.row.key === row.key)), cells: created });
  return finish(args, outDir, manifest, { column: column.index, secondary: hex, new_cells: created.map((c) => `${c.letter}=${c.row}/${c.secondary}`), letters: letterList(manifest), ...counts });
}

// ---- mark ------------------------------------------------------------------------
/** Pure: set a cell's status in the manifest (one travisse_pick and one fable_pick at a time). */
export function applyMark(manifest, letter, status, { note = null, by = null, at = new Date().toISOString() } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`--status must be one of ${STATUSES.join(', ')}`);
  const cell = manifest.cells[letter];
  if (!cell) throw new Error(`Cell "${letter}" is not on the sheet (${Object.keys(manifest.cells).join(', ')})`);
  const superseded = [];
  if (status === 'travisse_pick' || status === 'fable_pick') {
    for (const other of Object.values(manifest.cells)) {
      if (other.letter !== letter && other.status === status) {
        other.status = null;
        other.note = `${status} superseded by ${letter}`;
        superseded.push(other.letter);
      }
    }
  }
  cell.status = status === 'none' ? null : status;
  cell.note = note;
  cell.marked_at = at;
  cell.marked_by = by;
  if (status === 'fable_pick') manifest.fable_default_letter = letter;
  else if (manifest.fable_default_letter === letter && status !== 'fable_pick' && status !== 'travisse_pick') manifest.fable_default_letter = null;
  if (status === 'hold') manifest.hold = { letter, note, at };
  else if (manifest.hold?.letter === letter) manifest.hold = null;
  manifest.marks = [...(manifest.marks ?? []), { letter, status, note, by, at }];
  return { cell, superseded };
}

async function mark(args) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  const manifest = await loadManifest(outDir);
  if (!args.cell || !args.status) throw new Error('mark needs --cell <letter> --status <fable_pick|travisse_pick|rejected|none>');
  const letter = args.cell.toUpperCase();
  const by = args.by ?? (args.status === 'travisse_pick' ? 'Travisse' : args.status === 'fable_pick' ? 'Fable' : 'variant-sheet');
  const { superseded } = applyMark(manifest, letter, args.status, { note: args.note ?? null, by });
  // No render: the sheet html is rewritten from the views with the tag on the cell.
  const sheetFile = await composeSheet(manifest, outDir, { raster: Boolean(args.raster) });
  let manifestFile = await saveManifest(outDir, manifest);
  let recorded = null;
  let selection = null;
  if (args.run) {
    const dir = path.resolve(args.run);
    recorded = await recordVariantsBlock(dir, manifestFile, manifest, { reason: `variant-sheet mark ${letter} ${args.status}` });
    if (args.status === 'travisse_pick') {
      const select = runFile(['select', dir, letter, '--by', by, ...(args.note ? ['--reason', args.note] : [])]);
      if (select.status !== 0) throw new Error(`run-file select failed: ${(select.stderr || select.stdout).trim()}`);
      selection = JSON.parse(select.stdout);
      manifest.applied_letter = selection.applied_letter;
      manifestFile = await saveManifest(outDir, manifest);
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: 'mark',
    cell: letter,
    status: args.status,
    superseded,
    sheet: sheetFile,
    manifest: manifestFile,
    run_file: recorded ? recorded.file : null,
    applied_letter: selection ? selection.applied_letter : null,
    overrides: selection ? selection.overrides : null,
    rendered: { cards: 0, stickers: 0, pops: 0 },
  }, null, 2)}\n`);
}

async function restitch(args) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  const manifest = await loadManifest(outDir);
  // Refresh every row's sticker/POP state and every cell view (a legacy sheet gets its schema 3 views here).
  await prepareViews(manifest, outDir, { rows: manifest.rows, cells: Object.values(manifest.cells) });
  return finish(args, outDir, manifest, { rendered: { cards: 0, stickers: 0, pops: 0 }, letters: letterList(manifest) });
}

// ---- render: per-cell PNG tiles on demand (ai-mockup.mjs refs), sheet png with --raster -------------
async function render(args) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  const manifest = await loadManifest(outDir);
  const letters = args.all ? Object.keys(manifest.cells) : [...(args.cell ? [args.cell] : []), ...(args.cells ? args.cells.split(',') : [])].map((l) => l.trim().toUpperCase()).filter(Boolean);
  if (!letters.length && !args.raster) throw new Error('render needs --cell <letter>, --cells L,M, --all, or --raster');
  const missing = letters.filter((l) => !manifest.cells[l]);
  if (missing.length) throw new Error(`cells not on the sheet: ${missing.join(', ')} (have ${Object.keys(manifest.cells).join(', ')})`);
  await prepareViews(manifest, outDir, { rows: manifest.rows, cells: Object.values(manifest.cells) });
  const counts = { rendered: { cards: 0, stickers: 0, pops: 0 }, cached: { cards: 0, stickers: 0, pops: 0 } };
  const written = [];
  if (letters.length) {
    const { withBrowser, renderCellPngs } = await import('./render-preview.mjs');
    await withBrowser(async (browser) => {
      for (const letter of letters) {
        const cell = manifest.cells[letter];
        const row = manifest.rows.find((r) => r.key === cell.row);
        const pngs = await renderCellPngs(cell.view, { baseDir: runDir, browser });
        const cardFile = path.join(outDir, `card-${letter}.png`);
        await fs.writeFile(cardFile, pngs.card);
        cell.card = cardFile; counts.rendered.cards += 1; written.push(cardFile);
        const popFile = path.join(outDir, `pop-${row.key}.png`);
        await fs.writeFile(popFile, pngs.pop);
        row.pop = popFile; counts.rendered.pops += 1; written.push(popFile);
        if (pngs.sticker) {
          const stickerFile = path.join(outDir, `sticker-${row.key}.png`);
          await fs.writeFile(stickerFile, pngs.sticker);
          row.sticker = stickerFile; row.sticker_status = null; counts.rendered.stickers += 1; written.push(stickerFile);
        } else { row.sticker = null; row.sticker_status = STICKER_NEEDS_FIX; }
        for (const other of Object.values(manifest.cells)) if (other.row === row.key) Object.assign(other, { sticker: row.sticker, sticker_status: row.sticker_status ?? null, pop: row.pop });
      }
    });
    manifest.row_assets = manifest.rows.map((row) => ({ row: row.key, sticker: row.sticker, sticker_status: row.sticker_status ?? null, sticker_band: row.sticker_band, sticker_band_note: row.sticker_band_note, pop: row.pop }));
  }
  return finish(args, outDir, manifest, { cells_rendered: letters, written, ...counts, letters: letterList(manifest) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'build': return build(args);
    case 'add-row': return addRow(args);
    case 'add-cell': return addRow(args, { single: true });
    case 'add-column': return addColumn(args);
    case 'mark': return mark(args);
    case 'restitch': return restitch(args);
    case 'render': return render(args);
    default: throw new Error(`Unknown subcommand ${args.command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
