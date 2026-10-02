#!/usr/bin/env node
// variant-sheet.mjs: ONE labeled montage per run, rendered through the real
// badge harness, so the reviewer answers with a single letter.
//
//   rows    = logo treatment: chosen knockout, full color, words-only cut
//   columns = secondary/band candidates in provenance order (Fable's chosen
//             secondary, the chosen mark's inks, theme-authored site tokens),
//             then a 3-step depth ladder of the chosen secondary
//   cell    = harness card (varies by column) + sticker mock + solid POP tile
//             (both per row), with the badge digit contrast printed
//
// The sheet is INCREMENTAL. variant-sheet.json is the source of truth; the png
// is derived from it. Every rendered piece (card, sticker, POP tile) is cached
// under <out>/cells/ keyed by an input fingerprint (logo sha256 + hexes +
// treatment), so a subcommand renders only what its fingerprint says changed.
// Cell letters are assigned once, in creation order (A..Z, AA, AB, ...), and
// never renumbered: adding a row or column appends letters.
//
// Subcommands (the bare flag form is `build`, unchanged):
//   build       --run-dir <run> [--out <dir>] [--run <run_dir>] [--url-base http://localhost:3457]
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
//               [--print-primary <hex>] [--print-secondary <hex>]
//               print-primary: the signage ground (sticker band, POP tile) when print_primary_color differs
//               from the web card primary (Dogwood 2026-09-21: red web card, blue signage); print-secondary
//               is the print band/badge fill when it differs from the web secondary. Both are recorded on
//               the cell and printed on its label; the card render keeps the web colors.
//   mark        --run-dir <run> --cell <letter> --status <fable_pick|travisse_pick|rejected|none>
//               [--note "<why>"] [--by Travisse] [--run <run_dir>]
//   restitch    --run-dir <run> [--out <dir>] [--run <run_dir>]
//
// The sheet lives at <run_dir>/variants/ (override with --out). Outputs
// variant-sheet.png and variant-sheet.json (letter -> exact hexes and logo
// paths, so "apply B" is mechanical). With --run <run_dir> every subcommand
// updates the `variants` block of run.json; `mark --status travisse_pick` also
// runs `run-file select` so the applied letter is recorded once, in run.json.
// Exit 1 on any failure, including a harness that is down when a render is due.
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

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Image harness lives inside this skill (boostly-brand-design/harness) so the skill is self-contained.
const HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', 'harness');
const require = createRequire(path.join(HARNESS_DIR, 'package.json'));
const sharp = require('sharp');

const CARD_W = 260;
const SIDE_W = 150;
const LABEL_H = 34;
const CELL_PAD = 8;
const ROW_HEADER_W = 120;
const COL_HEADER_H = 44;
const MAX_LOGO_INKS = 3;
const MAX_SITE_TOKENS = 2;
const DEFAULT_OFFER = 'Join the club!';
const DEFAULT_URL_BASE = 'http://localhost:3457';
const CELLS_DIR = 'cells';
const SUBCOMMANDS = ['build', 'add-row', 'add-column', 'add-cell', 'mark', 'restitch'];
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
const BOOL_FLAGS = new Set(['noWords', 'force', 'knockout', 'noInstore', 'forceViability', 'allowLighter']);
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
  if (!args.runDir) throw new Error('Usage: variant-sheet.mjs [build|add-row|add-column|add-cell|mark|restitch] --run-dir <run> [--run <run_dir>] [options]');
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

// ---- renderers --------------------------------------------------------------
async function serveFile(file) {
  const buffer = await fs.readFile(file);
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
    res.end(buffer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/logo.png`, close: () => server.close() };
}

async function assertHarness(urlBase) {
  const url = new URL('/public/badge-preview-harness', urlBase).toString();
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`HARNESS DOWN: ${url} unreachable (${error.message}). Start it with PORT=3457 npm run dev in ${process.env.BOOSTLY_REPO_DIR || '/Users/travisse/Programming/boostly'}.`);
  }
  if (!response.ok) throw new Error(`HARNESS DOWN: ${url} returned HTTP ${response.status}.`);
}

async function renderCard(browser, { urlBase, logoUrl, primary, secondary, text, textSecondary }) {
  const url = new URL('/public/badge-preview-harness', urlBase);
  url.search = new URLSearchParams({ logo: logoUrl, primary, secondary, text, textSecondary, issueId: '1' }).toString();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#badge-shot[data-ready="true"]', { timeout: 20000 });
    await page.evaluate(async () => {
      const image = document.querySelector('#badge-shot img');
      if (image instanceof HTMLImageElement) {
        if (!image.complete || image.naturalWidth === 0) {
          await new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', reject, { once: true });
          });
        }
        await image.decode();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    return await page.locator('#badge-shot').screenshot({ omitBackground: false });
  } finally {
    await page.close();
  }
}

function mockQrSvg(color, seed) {
  const N = 25;
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const inFinder = (x, y) => (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
  const cells = [];
  const finderAt = (fx, fy) => {
    for (let y = 0; y < 7; y += 1) for (let x = 0; x < 7; x += 1) {
      const ring = x === 0 || y === 0 || x === 6 || y === 6;
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      if (ring || core) cells.push([fx + x, fy + y]);
    }
  };
  finderAt(0, 0); finderAt(N - 7, 0); finderAt(0, N - 7);
  for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
    if (inFinder(x, y)) continue;
    if (next() < 0.45) cells.push([x, y]);
  }
  const rects = cells.map(([x, y]) => `<rect x="${x}" y="${y}" width="1.05" height="1.05" rx="0.32"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" fill="${color}">${rects}</svg>`;
}

// Solid POP sign tile (plan.mjs popSign.variants.primary geometry, scaled):
// primary ground, white title/body/legal, white QR modules, logo in the
// 330x245 box near the bottom.
async function renderPopTile(browser, { logoFile, primary, offer }) {
  // `primary` here is the sign ground: the tapcard primary, or the sticker band when the primary fails on white (LIGHT PRIMARY rule).
  const W = 300;
  const H = 420;
  const s = W / 1500;
  const logoUri = `data:image/png;base64,${(await fs.readFile(logoFile)).toString('base64')}`;
  const qrUri = `data:image/svg+xml;base64,${Buffer.from(mockQrSvg('#FFFFFF', 4242)).toString('base64')}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:${W}px; height:${H}px; background:${primary}; position:relative; overflow:hidden;
      font-family:'Figtree','Helvetica Neue',Arial,sans-serif; color:#fff; }
    .t { position:absolute; left:${120 * s}px; width:${1260 * s}px; text-align:center; }
    .title { top:${180 * s}px; font-size:${140 * s}px; line-height:${150 * s}px; font-weight:500; }
    .body { top:${420 * s}px; font-size:${70 * s}px; line-height:${85 * s}px; font-weight:500; }
    .qr { position:absolute; left:${412.5 * s}px; top:${802 * s}px; width:${675 * s}px; height:${675 * s}px; }
    .logo { position:absolute; left:${585 * s}px; top:${1675 * s}px; width:${330 * s}px; height:${245 * s}px;
      display:flex; align-items:center; justify-content:center; }
    .logo img { max-width:100%; max-height:100%; object-fit:contain; }
    .legal { top:${1988 * s}px; font-size:${26 * s}px; line-height:${32 * s}px; }
  </style></head><body>
    <div class="t title">${offer}</div>
    <div class="t body">Scan to join our text club<br>for ongoing offers!</div>
    <img class="qr" src="${qrUri}">
    <div class="logo"><img id="logo" src="${logoUri}"></div>
    <div class="t legal">Consent not req'd for purchase. Msg &amp; data rates may apply.</div>
  </body></html>`;
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  try {
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.screenshot();
  } finally {
    await page.close();
  }
}

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

function renderStickerMock({ logoFile, band, outFile }) {
  const script = path.join(HARNESS_DIR, 'sticker-mock.mjs');
  const result = spawnSync('node', [script, '--logo', logoFile, '--primary', band, '--out', outFile], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function labelStrip(text, width, height, { bg = '#111111', fg = '#FFFFFF', size = 15, bold = false } = {}) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${bg}"/>
    <text x="8" y="${Math.round(height / 2 + size * 0.36)}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${fg}">${esc}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Status tag (small corner label) plus a frame around the cell; drawn over the composed sheet, never into the cell render. */
async function statusOverlay(status, cellW, cellH) {
  const style = STATUS_STYLE[status];
  const frame = 4;
  const tagW = Math.min(cellW - 2 * frame, 14 + style.tag.length * 8);
  const tagH = 20;
  const esc = style.tag.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${cellH}">
    <rect x="${frame / 2}" y="${frame / 2}" width="${cellW - frame}" height="${cellH - frame}" fill="none" stroke="${style.color}" stroke-width="${frame}"/>
    <rect x="${cellW - frame - tagW}" y="${LABEL_H + CELL_PAD}" width="${tagW}" height="${tagH}" rx="3" fill="${style.color}"/>
    <text x="${cellW - frame - tagW + 7}" y="${LABEL_H + CELL_PAD + 14}" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="${style.text}">${esc}</text>
    ${status === 'rejected' ? `<text x="${CELL_PAD + CARD_W / 2}" y="${LABEL_H + CELL_PAD + (cellH - LABEL_H - CELL_PAD * 2) / 2 + 14}" text-anchor="middle" transform="rotate(-18 ${CELL_PAD + CARD_W / 2} ${LABEL_H + CELL_PAD + (cellH - LABEL_H - CELL_PAD * 2) / 2})" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="${style.color}" stroke="#FFFFFF" stroke-width="2" paint-order="stroke">REJECTED</text>` : ''}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** NOT VIABLE badge for a cell rendered under --force-viability: purple frame plus a tag naming the gate verdict. */
async function notViableOverlay(verdict, cellW, cellH) {
  const frame = 4;
  const text = `${NOT_VIABLE_STYLE.tag}: ${verdict}`;
  const tagW = Math.min(cellW - 2 * frame, 14 + text.length * 7);
  const tagH = 20;
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${cellH}">
    <rect x="${frame / 2}" y="${frame / 2}" width="${cellW - frame}" height="${cellH - frame}" fill="none" stroke="${NOT_VIABLE_STYLE.color}" stroke-width="${frame}"/>
    <rect x="${frame}" y="${cellH - frame - tagH}" width="${tagW}" height="${tagH}" rx="3" fill="${NOT_VIABLE_STYLE.color}"/>
    <text x="${frame + 7}" y="${cellH - frame - 6}" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="700" fill="${NOT_VIABLE_STYLE.text}">${esc}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The tile drawn where a sticker mock was refused: white sticker field, red words naming the fix. */
async function stickerPlaceholder(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#FFFFFF"/>
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#B71C1C" stroke-width="2" stroke-dasharray="6,4"/>
    <text x="${width / 2}" y="${Math.round(height / 2 - 8)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="700" fill="#B71C1C">sticker:</text>
    <text x="${width / 2}" y="${Math.round(height / 2 + 10)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="700" fill="#B71C1C">${STICKER_NEEDS_FIX}</text>
    <text x="${width / 2}" y="${Math.round(height / 2 + 30)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#555555">sticker-panel.mjs circle|strip</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function fitTo(buffer, width, height, background = '#E5E5E5') {
  return sharp(buffer).resize(width, height, { fit: 'contain', background }).png().toBuffer();
}
/** The greyed treatment of a human-rejected cell's tiles: desaturated and lifted toward light grey (never into the cache). */
async function greyed(buffer) {
  return sharp(buffer).greyscale().linear(0.55, 90).png().toBuffer();
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
  manifest.schema = 2;
  manifest.offer = manifest.offer ?? DEFAULT_OFFER;
  manifest.url_base = manifest.url_base ?? DEFAULT_URL_BASE;
  manifest.sticker_logo = manifest.sticker_logo ?? null;
  manifest.rows = (manifest.rows ?? []).map((row) => ({ primary: null, text: null, knockout: null, sticker_logo: null, ...row }));
  manifest.columns = (manifest.columns ?? []).map((col, i) => ({ index: i, one_off: false, ...col }));
  manifest.cells = manifest.cells ?? {};
  manifest.skipped = manifest.skipped ?? [];
  const letters = Object.keys(manifest.cells);
  for (const letter of letters) {
    const cell = manifest.cells[letter];
    cell.id = cell.id ?? letter;
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

// ---- rendering through the cache --------------------------------------------
/**
 * Render (or reuse) the sticker and POP tile of a row and the cards of the given cells.
 * Only pieces whose fingerprint is not in <out>/cells/ are rendered; the browser starts only when
 * at least one render is due. Returns the render/cache counts.
 */
async function renderPieces(manifest, outDir, { rows: rowsArg, cells, urlBase }) {
  // Always work on the manifest's own row objects (normalizeManifest may have re-created them).
  const rows = rowsArg.map((r) => manifest.rows.find((x) => x.key === r.key) ?? r);
  const counts = { rendered: { cards: 0, stickers: 0, pops: 0 }, cached: { cards: 0, stickers: 0, pops: 0 } };
  await fs.mkdir(path.join(outDir, CELLS_DIR), { recursive: true });

  // Plan: which pieces are missing from the cache.
  const rowJobs = [];
  for (const row of rows) {
    const { band, note } = stickerBand(manifest, row);
    // STICKER GROUND: an opaque sticker asset is neither rendered nor swapped for the card logo.
    const stickerOk = stickerRenderable(row);
    const stickerLogo = stickerOk ? stickerLogoFor(manifest, row) : null;
    const stickerFp = stickerOk ? stickerFingerprint({ logoSha: await fileSha256(stickerLogo), band }) : null;
    const popFp = popFingerprint({ logoSha: await fileSha256(row.logo), band, offer: manifest.offer });
    rowJobs.push({ row, band, note, stickerLogo, stickerFp, popFp, needSticker: stickerOk && !cacheHas(outDir, 'sticker', stickerFp), needPop: !cacheHas(outDir, 'pop', popFp) });
  }
  const cellJobs = [];
  for (const cell of cells) {
    const row = manifest.rows.find((r) => r.key === cell.row);
    const fp = cardFingerprint({ logoSha: await fileSha256(row.logo), primary: cell.primary, secondary: cell.secondary, text: cell.text, textSecondary: cell.text, treatment: row.key });
    cellJobs.push({ cell, row, fp, need: !cacheHas(outDir, 'card', fp) });
  }
  const needBrowser = rowJobs.some((j) => j.needPop) || cellJobs.some((j) => j.need);
  if (needBrowser) await assertHarness(urlBase);

  let browser = null;
  const servers = new Map();
  try {
    if (needBrowser) {
      const { chromium } = require('playwright');
      browser = await chromium.launch();
    }
    for (const job of rowJobs) {
      const { row } = job;
      if (job.needSticker) {
        const target = cachePath(outDir, 'sticker', job.stickerFp);
        const sticker = renderStickerMock({ logoFile: job.stickerLogo, band: job.band, outFile: target });
        if (sticker.status !== 0 && sticker.status !== 3) throw new Error(`sticker-mock failed for ${row.key}: ${sticker.stderr || sticker.stdout}`);
        counts.rendered.stickers += 1;
      } else if (job.stickerFp) counts.cached.stickers += 1;
      else counts.skipped_stickers = (counts.skipped_stickers ?? 0) + 1;
      if (job.needPop) {
        await fs.writeFile(cachePath(outDir, 'pop', job.popFp), await renderPopTile(browser, { logoFile: row.logo, primary: job.band, offer: manifest.offer }));
        counts.rendered.pops += 1;
      } else counts.cached.pops += 1;
      // Stable per-row copies keep the legacy paths (sticker-<row>.png, pop-<row>.png) valid.
      const stickerFile = job.stickerFp ? path.join(outDir, `sticker-${row.key}.png`) : null;
      const popFile = path.join(outDir, `pop-${row.key}.png`);
      if (stickerFile) await fs.copyFile(cachePath(outDir, 'sticker', job.stickerFp), stickerFile);
      else await fs.rm(path.join(outDir, `sticker-${row.key}.png`), { force: true }); // never leave a stale opaque render behind
      await fs.copyFile(cachePath(outDir, 'pop', job.popFp), popFile);
      Object.assign(row, { sticker: stickerFile, sticker_status: stickerFile ? null : STICKER_NEEDS_FIX, sticker_band: job.band, sticker_band_note: job.note, pop: popFile, sticker_fingerprint: job.stickerFp, pop_fingerprint: job.popFp, sticker_logo_used: job.stickerLogo });
      // Every existing cell of the row follows its sticker (an add-column on a legacy sheet can refuse a sticker whose cells already exist).
      for (const cell of Object.values(manifest.cells)) {
        if (cell.row === row.key) Object.assign(cell, { sticker: row.sticker, sticker_status: row.sticker_status ?? null, sticker_band: row.sticker_band, pop: row.pop });
      }
    }
    for (const job of cellJobs) {
      const { cell, row, fp } = job;
      const target = cachePath(outDir, 'card', fp);
      if (job.need) {
        if (!servers.has(row.logo)) servers.set(row.logo, await serveFile(row.logo));
        const png = await renderCard(browser, { urlBase, logoUrl: servers.get(row.logo).url, primary: cell.primary, secondary: cell.secondary, text: cell.text, textSecondary: cell.text });
        await fs.writeFile(target, png);
        counts.rendered.cards += 1;
      } else counts.cached.cards += 1;
      const cardFile = path.join(outDir, `card-${cell.letter}.png`);
      await fs.copyFile(target, cardFile);
      Object.assign(cell, { card: cardFile, fingerprint: fp, cache: target, sticker: row.sticker, sticker_status: row.sticker_status ?? null, sticker_band: row.sticker_band, pop: row.pop });
    }
  } finally {
    if (browser) await browser.close();
    for (const server of servers.values()) server.close();
  }
  manifest.row_assets = manifest.rows.map((row) => ({ row: row.key, sticker: row.sticker, sticker_status: row.sticker_status ?? null, sticker_band: row.sticker_band, sticker_band_note: row.sticker_band_note, pop: row.pop }));
  return counts;
}

/** Adopt the card/sticker/pop files of a legacy (pre-cache) sheet into cells/ so they are never rerendered. */
async function adoptLegacyRenders(manifest, outDir) {
  await fs.mkdir(path.join(outDir, CELLS_DIR), { recursive: true });
  let adopted = 0;
  for (const row of manifest.rows) {
    const asset = (manifest.row_assets ?? []).find((a) => a.row === row.key);
    if (!asset) continue;
    const { band } = stickerBand(manifest, row);
    const stickerLogo = stickerLogoFor(manifest, row);
    if (asset.sticker && existsSync(asset.sticker)) {
      const fp = stickerFingerprint({ logoSha: await fileSha256(stickerLogo), band });
      if (!cacheHas(outDir, 'sticker', fp)) { await fs.copyFile(asset.sticker, cachePath(outDir, 'sticker', fp)); adopted += 1; }
    }
    if (asset.pop && existsSync(asset.pop)) {
      const fp = popFingerprint({ logoSha: await fileSha256(row.logo), band, offer: manifest.offer });
      if (!cacheHas(outDir, 'pop', fp)) { await fs.copyFile(asset.pop, cachePath(outDir, 'pop', fp)); adopted += 1; }
    }
  }
  for (const cell of Object.values(manifest.cells)) {
    const row = manifest.rows.find((r) => r.key === cell.row);
    if (!row || !cell.card || !existsSync(cell.card)) continue;
    const fp = cell.fingerprint ?? cardFingerprint({ logoSha: await fileSha256(row.logo), primary: cell.primary, secondary: cell.secondary, text: cell.text, textSecondary: cell.text, treatment: row.key });
    cell.fingerprint = fp;
    if (!cacheHas(outDir, 'card', fp)) { await fs.copyFile(cell.card, cachePath(outDir, 'card', fp)); adopted += 1; }
    cell.cache = cachePath(outDir, 'card', fp);
  }
  return adopted;
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
export async function composeSheet(manifest, outDir) {
  const { cardH, sideH, cellW, cellH, sheetW, sheetH } = sheetGeometry(manifest);
  const composites = [];
  for (let c = 0; c < manifest.columns.length; c += 1) {
    const col = manifest.columns[c];
    composites.push({
      input: await labelStrip(`${col.hex}  ${provenanceWords(col.source, col.label)}`, cellW, COL_HEADER_H, { bg: '#222222', size: 14, bold: true }),
      left: ROW_HEADER_W + c * cellW,
      top: 0,
    });
  }
  for (let r = 0; r < manifest.rows.length; r += 1) {
    composites.push({
      input: await labelStrip(rowLabelText(manifest, manifest.rows[r]), ROW_HEADER_W, cellH, { bg: '#222222', size: 14, bold: true }),
      left: 0,
      top: COL_HEADER_H + r * cellH,
    });
  }
  for (const cell of Object.values(manifest.cells)) {
    const r = manifest.rows.findIndex((row) => row.key === cell.row);
    const c = cell.column_index ?? manifest.columns.findIndex((col) => col.hex === cell.secondary);
    if (r < 0 || c < 0) throw new Error(`Cell ${cell.letter} points at a row/column that is not on the sheet`);
    const x0 = ROW_HEADER_W + c * cellW;
    const y0 = COL_HEADER_H + r * cellH;
    const digit = cell.badge_digit_web;
    const label = cellLabelText(manifest, cell);
    // REJECTED by a human (mark --status rejected): the letter stays, the header says so, the tiles are greyed.
    const rejected = cell.status === 'rejected';
    const tile = async (buffer, w, h) => (rejected ? greyed(await fitTo(buffer, w, h)) : fitTo(buffer, w, h));
    const card = cell.cache && existsSync(cell.cache) ? cell.cache : cell.card;
    const stickerSkipped = !cell.sticker && cell.sticker_status === STICKER_NEEDS_FIX;
    for (const [what, file] of [['card', card], ['sticker', stickerSkipped ? null : cell.sticker], ['pop', cell.pop]]) {
      if (what === 'sticker' && stickerSkipped) continue;
      if (!file || !existsSync(file)) throw new Error(`Cell ${cell.letter}: ${what} render missing (${file ?? 'unset'}); rerun the subcommand that created it`);
    }
    composites.push({ input: await labelStrip(label, cellW, LABEL_H, { bg: rejected ? STATUS_STYLE.rejected.color : digit.pass ? '#1B5E20' : '#B71C1C', size: 15, bold: true }), left: x0, top: y0 });
    composites.push({ input: await tile(await fs.readFile(card), CARD_W, cardH), left: x0 + CELL_PAD, top: y0 + LABEL_H + CELL_PAD });
    // STICKER GROUND: a skipped sticker is an explicit placeholder that names the fix, never the card logo in its place.
    const stickerTile = stickerSkipped ? await stickerPlaceholder(SIDE_W, sideH) : await tile(await fs.readFile(cell.sticker), SIDE_W, sideH);
    composites.push({ input: stickerTile, left: x0 + CARD_W + CELL_PAD * 2, top: y0 + LABEL_H + CELL_PAD });
    composites.push({ input: await tile(await fs.readFile(cell.pop), SIDE_W, sideH), left: x0 + CARD_W + CELL_PAD * 2, top: y0 + LABEL_H + CELL_PAD * 2 + sideH });
    if (cell.status && STATUS_STYLE[cell.status]) {
      composites.push({ input: await statusOverlay(cell.status, cellW, cellH), left: x0, top: y0 });
    }
    if (cell.viability && cell.viability.pass === false) {
      composites.push({ input: await notViableOverlay(cell.viability.verdict, cellW, cellH), left: x0, top: y0 });
    }
  }
  const sheetFile = path.join(outDir, 'variant-sheet.png');
  await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: '#C8C8C8' } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(sheetFile);
  manifest.sheet = sheetFile;
  return sheetFile;
}

// ---- shared finish: save json, stitch png, record run.json --------------------
async function finish(args, outDir, manifest, extra = {}) {
  const sheetFile = await composeSheet(manifest, outDir);
  const manifestFile = await saveManifest(outDir, manifest);
  const recorded = args.run ? await recordVariantsBlock(path.resolve(args.run), manifestFile, manifest, { reason: extra.reason ?? `variant-sheet ${args.command}` }) : null;
  const summary = {
    ok: true,
    command: args.command,
    sheet: sheetFile,
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
  const counts = await renderPieces(manifest, outDir, { rows: renderRows, cells: created, urlBase: args.urlBase });
  return finish(args, outDir, manifest, { letters: letterList(manifest), words_note: wordsNote, default_letter: def, instore_dominant: instore, ...counts, reason: 'variant-sheet build' });
}

// ---- add-row / add-column / add-cell ----------------------------------------
async function addRow(args, { single = false } = {}) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  const manifest = await loadManifest(outDir);
  await adoptLegacyRenders(manifest, outDir);
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
    note: args.note ?? null,
    added_at: new Date().toISOString(),
    added_by: args.command,
  };
  if ((row.print_primary || row.print_secondary) && !single) throw new Error('--print-primary / --print-secondary are add-cell options (one cell, one print palette)');
  if (row.sticker_logo && !existsSync(row.sticker_logo)) throw new Error(`--sticker-logo not found: ${row.sticker_logo}`);
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
  const counts = await renderPieces(manifest, outDir, { rows: [row], cells: created, urlBase: manifest.url_base });
  return finish(args, outDir, manifest, { row: key, added: true, viability: row.viability, sticker_viability: row.sticker_viability ?? null, new_cells: created.map((c) => `${c.letter}=${c.row}/${c.secondary}`), letters: letterList(manifest), ...counts });
}

async function addColumn(args) {
  const runDir = path.resolve(args.runDir);
  const outDir = resolveOut(args, runDir);
  const manifest = await loadManifest(outDir);
  await adoptLegacyRenders(manifest, outDir);
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
  const counts = await renderPieces(manifest, outDir, { rows: rows.filter((row) => pairs.some((p) => p.row.key === row.key)), cells: created, urlBase: manifest.url_base });
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
  // No render: the sheet is restitched from the cache and the tag drawn over the composed png.
  const sheetFile = await composeSheet(manifest, outDir);
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
  const adopted = await adoptLegacyRenders(manifest, outDir);
  return finish(args, outDir, manifest, { adopted, rendered: { cards: 0, stickers: 0, pops: 0 }, letters: letterList(manifest) });
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
    default: throw new Error(`Unknown subcommand ${args.command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
