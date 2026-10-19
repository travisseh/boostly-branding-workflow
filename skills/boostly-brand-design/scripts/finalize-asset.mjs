#!/usr/bin/env node
// finalize-asset.mjs: FINALIZE CARD ASSET steps 3 to 6 as one deterministic step, run at sheet
// build on every row asset (so the sheet and the review report the real upload size) and
// rerun at closeout only when the asset changed (rule 15, 2026-10-19).
//
//   node scripts/finalize-asset.mjs --in <png> --out <png> --surface card|sticker \
//        [--max-bytes 70000] [--floor-px 1000] [--step 100] [--alpha snap|aa|soft] \
//        [--alpha-levels 9] [--no-tinypng] [--env-file <path>] [--json]
//
// Per rung (native size first, never upscaled):
//   1. alpha: card at >= 1000 px snaps to binary (>= 128 -> 255, else 0, RGB zeroed under
//      alpha 0); card under 1000 px and every sticker keep the anti-aliased alpha quantized
//      to --alpha-levels (9) so the print has no stair-steps (Skyboxx 2026-09-21);
//      --alpha soft snaps only >= 240 and <= 12 for marks with a wanted gradient or shadow.
//   2. encode: max-effort lossless truecolor PNG (palette: false), never indexed.
//   3. tinypng: only when the key is already on hand (TINYPNG_API_KEY or the env file) and
//      the rung is still over --max-bytes; the tinified truecolor re-encode is kept when
//      smaller. No key means the step is recorded as skipped, never prompted for.
//   4. ladder: still over the cap, step the longest side down by --step (100 px) and redo
//      1 to 3, never below --floor-px (1000) and never below the 700 px ship gate.
//   --box-bg <hex> builds the light-surface BOX container (sticker-panel.mjs --mode box geometry:
//   --box-pad 0.28 of the mark height, --box-radius 0.2 of the box height) around the treated
//   mark at EVERY rung and measures the boxed bytes, since boxing after the ladder or laddering
//   an already boxed master both miss the cap (Indian Kitchen fix/smooth/ladder3.py: the words
//   are resized and quantized first, the box is drawn fresh at each size).
// The output is the first rung under the cap, else the floor rung (fits: false, exit 3):
// the best under-cap copy ships by default and the report carries the ladder (rule 18).
// Writes <out>.ladder.json with every rung and prints { out, bytes, px, fits, steps }.
//
// Exit codes: 0 fits, 1 usage/load error, 3 floor rung still over the cap (file written).
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { alphaBbox, boxLayout, normalizeHex } from './sticker-panel.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(SCRIPT_DIR, '..', 'harness', 'package.json'));
const sharp = require('sharp');

export const SURFACES = ['card', 'sticker'];
export const ALPHA_MODES = ['snap', 'aa', 'soft'];
export const SHIP_GATE_PX = 700;
export const DEFAULTS = {
  maxBytes: 70_000,
  floorPx: 1000,
  step: 100,
  alphaLevels: 9,
  snapFromPx: 1000,
  envFile: '/Users/travisse/Programming/product2/shared/apps/brand-extractor-figma/.env',
};
const TINYPNG_CLI = path.join(SCRIPT_DIR, 'tinypng-compress.mjs');
const PNG_OPTIONS = { palette: false, compressionLevel: 9, adaptiveFiltering: true, effort: 10 };

export function parseArgs(argv) {
  const args = { ...DEFAULTS, json: false, tinypng: true, alpha: null, boxBg: null, boxPad: 0.28, boxRadius: 0.2 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flag === 'json') { args.json = true; continue; }
    if (flag === 'noTinypng') { args.tinypng = false; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[flag] = value;
    i += 1;
  }
  if (!args.in || !args.out || !args.surface) throw new Error('Usage: finalize-asset.mjs --in <png> --out <png> --surface card|sticker [--max-bytes 70000] [--floor-px 1000] [--step 100] [--alpha snap|aa|soft] [--alpha-levels 9] [--box-bg <hex> [--box-pad 0.28] [--box-radius 0.2]] [--no-tinypng] [--env-file <path>] [--json]');
  if (!SURFACES.includes(args.surface)) throw new Error(`--surface must be one of ${SURFACES.join('|')}, got ${args.surface}`);
  if (args.alpha && !ALPHA_MODES.includes(args.alpha)) throw new Error(`--alpha must be one of ${ALPHA_MODES.join('|')}, got ${args.alpha}`);
  for (const k of ['maxBytes', 'floorPx', 'step', 'alphaLevels']) {
    args[k] = Number(args[k]);
    if (!(args[k] > 0)) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive number`);
  }
  if (args.alphaLevels < 2) throw new Error('--alpha-levels must be at least 2');
  if (args.boxBg) {
    args.boxBg = normalizeHex(args.boxBg, '--box-bg');
    args.boxPad = Number(args.boxPad);
    args.boxRadius = Number(args.boxRadius);
    if (!(args.boxPad >= 0 && args.boxPad < 0.5)) throw new Error('--box-pad must be in [0, 0.5)');
    if (!(args.boxRadius >= 0 && args.boxRadius <= 0.5)) throw new Error('--box-radius must be in [0, 0.5]');
  }
  return args;
}

/** The alpha treatment a rung gets, pure: snap for a card at or above 1000 px, aa otherwise, soft when asked. */
export function alphaModeFor(surface, longestPx, override = null, snapFromPx = DEFAULTS.snapFromPx) {
  if (override) return override;
  return surface === 'card' && longestPx >= snapFromPx ? 'snap' : 'aa';
}

/** Pure: apply an alpha treatment to RGBA data in place. Returns the count of distinct alpha values after. */
export function treatAlpha(data, mode, levels = DEFAULTS.alphaLevels) {
  const seen = new Set();
  for (let o = 0; o < data.length; o += 4) {
    let a = data[o + 3];
    if (mode === 'snap') a = a >= 128 ? 255 : 0;
    else if (mode === 'soft') a = a >= 240 ? 255 : a <= 12 ? 0 : a;
    else a = Math.round(Math.round((a / 255) * (levels - 1)) / (levels - 1) * 255);
    data[o + 3] = a;
    if (a === 0) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; }
    seen.add(a);
  }
  return seen.size;
}

/**
 * Pure: the single ink of a mark, when every fully opaque pixel is within `tolerance` of the first
 * one (a knockout or a one-colour wordmark), else null. Resizing scatters the RGB of the fringe
 * pixels and a scattered fringe stops compressing; a single-ink mark gets its ink written back
 * under every covered pixel (Indian Kitchen: 2800 px at 9 levels is 63 KB only with a flat gold).
 */
export function singleInk(data, tolerance = 8) {
  let ink = null;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] !== 255) continue;
    if (!ink) { ink = [data[o], data[o + 1], data[o + 2]]; continue; }
    if (Math.abs(data[o] - ink[0]) > tolerance || Math.abs(data[o + 1] - ink[1]) > tolerance || Math.abs(data[o + 2] - ink[2]) > tolerance) return null;
  }
  return ink;
}
export function flattenInk(data, ink) {
  for (let o = 0; o < data.length; o += 4) {
    if (!data[o + 3]) continue;
    data[o] = ink[0];
    data[o + 1] = ink[1];
    data[o + 2] = ink[2];
  }
}

/** The rung sizes the ladder walks, pure: native first, then --step decrements down to the floor (700 px hard rail). */
export function ladderSizes(nativeLongest, { floorPx = DEFAULTS.floorPx, step = DEFAULTS.step } = {}) {
  const floor = Math.max(SHIP_GATE_PX, Math.round(floorPx));
  const sizes = [nativeLongest];
  let next = Math.floor((nativeLongest - 1) / step) * step;
  while (next >= floor) {
    sizes.push(next);
    next -= step;
  }
  return { floor, sizes };
}

/** Whether tinypng-compress.mjs can run without a key prompt: a key in the environment or in the env file. Never returns the key. */
export function tinypngAvailable(envFile = DEFAULTS.envFile) {
  if (process.env.TINYPNG_API_KEY) return true;
  if (!existsSync(envFile)) return false;
  return readFileSync(envFile, 'utf8').split('\n').some((l) => l.startsWith('TINYPNG_API_KEY=') && l.length > 'TINYPNG_API_KEY='.length);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The treated mark inside a fresh rounded box of `bg` (the sticker-panel box geometry). */
async function boxMark(data, width, height, { bg, pad, radius }) {
  const { bbox } = alphaBbox(data, width, height);
  if (!bbox) throw new Error('no ink to box');
  const mark = await sharp(data, { raw: { width, height, channels: 4 } }).extract(bbox).png().toBuffer();
  const layout = boxLayout({ width: bbox.width, height: bbox.height }, { pad, radius });
  const rect = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}"><rect x="0.5" y="0.5" width="${layout.width - 1}" height="${layout.height - 1}" rx="${layout.radius}" ry="${layout.radius}" fill="${bg}"/></svg>`);
  const boxed = await sharp({ create: { width: layout.width, height: layout.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rect, left: 0, top: 0 }, { input: mark, left: layout.left, top: layout.top }])
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: boxed.data, width: layout.width, height: layout.height, layout };
}

async function encodeRung(master, nativeW, nativeH, longest, { surface, alpha, alphaLevels, snapFromPx, ink, box }) {
  const scale = longest / Math.max(nativeW, nativeH);
  let image = sharp(master.data, { raw: { width: nativeW, height: nativeH, channels: 4 } });
  const steps = [];
  if (scale < 1) {
    const width = Math.max(1, Math.round(nativeW * scale));
    const height = Math.max(1, Math.round(nativeH * scale));
    image = sharp(await image.png().toBuffer()).resize({ width, height, kernel: 'lanczos3', fit: 'fill' });
    steps.push({ action: 'resize', px: [width, height], kernel: 'lanczos3' });
  }
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mode = alphaModeFor(surface, Math.max(info.width, info.height), alpha, snapFromPx);
  const levels = treatAlpha(data, mode, alphaLevels);
  steps.push({ action: `alpha_${mode}`, px: [info.width, info.height], alpha_levels: levels, ...(mode === 'aa' ? { levels_requested: alphaLevels } : {}) });
  if (ink) {
    flattenInk(data, ink);
    steps.push({ action: 'flatten_ink', ink: `#${ink.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}` });
  }
  let out = { data, width: info.width, height: info.height };
  if (box) {
    out = await boxMark(data, info.width, info.height, box);
    steps.push({ action: 'box', px: [out.width, out.height], bg: box.bg, pad_px: out.layout.pad, radius_px: out.layout.radius });
  }
  const png = await sharp(out.data, { raw: { width: out.width, height: out.height, channels: 4 } }).png(PNG_OPTIONS).toBuffer();
  steps.push({ action: 'encode', px: [out.width, out.height], bytes: png.length, png: 'truecolor max-effort' });
  return { png, width: out.width, height: out.height, markPx: [info.width, info.height], alpha: mode, alphaLevels: levels, steps };
}

async function tinify(png, maxBytes, envFile, scratch) {
  const inFile = path.join(scratch, 'rung.png');
  const outFile = path.join(scratch, 'rung.tiny.png');
  await fs.writeFile(inFile, png);
  const argv = [TINYPNG_CLI, '--in', inFile, '--out', outFile, '--threshold', String(maxBytes)];
  if (envFile) argv.push('--env-file', envFile);
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', env: process.env });
  let summary = null;
  try { summary = JSON.parse((result.stdout ?? '').trim()); } catch { summary = null; }
  if (result.status === 0 && summary?.pass && summary.action === 'compressed' && existsSync(outFile)) {
    const tiny = await fs.readFile(outFile);
    if (tiny.length < png.length) return { png: tiny, step: { action: 'tinypng', bytes: tiny.length, savings_pct: summary.savingsPct } };
  }
  return { png, step: { action: 'tinypng', bytes: png.length, result: summary?.failures?.length ? `no_gain:${summary.failures.join(',')}` : `http_${result.status}` } };
}

export async function finalizeAsset(args) {
  const inPath = path.resolve(args.in);
  const outPath = path.resolve(args.out);
  const source = await fs.readFile(inPath);
  const master = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const nativeW = master.info.width;
  const nativeH = master.info.height;
  const native = Math.max(nativeW, nativeH);
  const ink = singleInk(master.data);
  const { floor, sizes } = ladderSizes(native, { floorPx: args.floorPx, step: args.step });
  const tinypngMode = !args.tinypng ? 'disabled' : tinypngAvailable(args.envFile) ? 'available' : 'skipped_no_key';
  const scratch = tinypngMode === 'available' ? await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-asset-')) : null;
  const box = args.boxBg ? { bg: args.boxBg, pad: args.boxPad, radius: args.boxRadius } : null;
  const rungs = [];
  let chosen = null;
  try {
    for (const longest of sizes) {
      const rung = await encodeRung(master, nativeW, nativeH, longest, { surface: args.surface, alpha: args.alpha, alphaLevels: args.alphaLevels, snapFromPx: args.snapFromPx, ink, box });
      // with a box the floor applies to the shipped (boxed) asset: stop before a rung whose box is under it
      if (box && rungs.length && Math.max(rung.width, rung.height) < floor) break;
      let { png } = rung;
      const steps = [...rung.steps];
      if (png.length > args.maxBytes && tinypngMode === 'available') {
        const t = await tinify(png, args.maxBytes, args.envFile, scratch);
        png = t.png;
        steps.push(t.step);
      }
      const entry = { longest, px: [rung.width, rung.height], ...(box ? { mark_px: rung.markPx } : {}), alpha: rung.alpha, alpha_levels: rung.alphaLevels, bytes: png.length, fits: png.length <= args.maxBytes, steps };
      rungs.push(entry);
      chosen = { entry, png };
      if (entry.fits) break;
    }
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, chosen.png);
  const ladder = {
    in: inPath,
    in_sha256: sha256(source),
    in_bytes: source.length,
    in_px: [nativeW, nativeH],
    surface: args.surface,
    single_ink: ink ? `#${ink.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}` : null,
    panel: box ? { mode: 'box', hex: box.bg, pad_share_of_mark_height: box.pad, radius_share_of_box_height: box.radius } : null,
    max_bytes: args.maxBytes,
    floor_px: floor,
    ...(floor !== Math.round(args.floorPx) ? { floor_px_requested: args.floorPx, floor_px_clamped_to_ship_gate: true } : {}),
    step_px: args.step,
    tinypng: tinypngMode,
    rungs,
    out: outPath,
    out_sha256: sha256(chosen.png),
    bytes: chosen.png.length,
    px: chosen.entry.px,
    alpha: chosen.entry.alpha,
    fits: chosen.entry.fits,
    at: new Date().toISOString(),
  };
  await fs.writeFile(`${outPath}.ladder.json`, `${JSON.stringify(ladder, null, 2)}\n`);
  const steps = rungs.flatMap((r) => r.steps.map((s) => ({ longest: r.longest, ...s })));
  return { out: outPath, bytes: ladder.bytes, px: ladder.px, fits: ladder.fits, alpha: ladder.alpha, panel: ladder.panel, tinypng: tinypngMode, rungs: rungs.length, ladder: `${outPath}.ladder.json`, steps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  finalizeAsset(args)
    .then((result) => {
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`${result.out}: ${result.px.join('x')} px, ${result.bytes} B, alpha ${result.alpha}, ${result.fits ? 'fits' : 'OVER CAP at the floor'} (${result.rungs} rung${result.rungs === 1 ? '' : 's'}, tinypng ${result.tinypng})\n`);
      process.exit(result.fits ? 0 : 3);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
