#!/usr/bin/env node
// sticker-panel.mjs: the two standard fixes for a sticker asset that fails the
// opaque-ground pre-check (an authored square panel on a white sticker), so
// agents stop hand-building them (Toscana Gourmet Pizza 2026-09-22, Travisse:
// "either in a circle of black like we did with the one yesterday or strip the
// black background").
//
//   node scripts/sticker-panel.mjs --logo <png> --out <png> --mode circle|strip
//        [--bg #000000] [--pad 0.12] [--key <hex>] [--soft-lo 24] [--soft-hi 64] [--size 1000]
//
//   circle  the art (ground keyed out, so the bbox is the ink, not the panel) centered
//           by its bounding box inside a circular panel of --bg with --pad of the
//           diameter as padding; the panel is the asset's bounding square (Coconut
//           Thyme 2026-09-21 recipe: fix/sticker/panel-circle.png).
//   strip   the ground keyed out by color distance with a soft edge (alpha ramps from
//           0 at --soft-lo to 1 at --soft-hi distance from the key color), edge pixels
//           un-blended from the ground; truecolor RGBA, trimmed to the ink.
//
// --key is the ground color to remove; default: the median color of the 1-px border
// (--bg is only the panel fill of circle mode). --size is the circle's diameter and
// the minimum longest side of a strip output (>= 1000 px, upscaled with lanczos3 when
// the source is smaller). Output alpha is anti-aliased (8-bit ramp), never binary.
//
// Prints a JSON summary. Exit 1 on any error. Gate the result yourself:
//   gates.ts check --asset <out> --color #FFFFFF --surface sticker
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(SCRIPT_DIR, '..', 'harness', 'package.json'));
const sharp = require('sharp');

export const MODES = ['circle', 'strip'];
const DEFAULTS = { bg: '#000000', pad: 0.12, softLo: 24, softHi: 64, size: 1000 };
const MIN_SIZE = 1000;

export function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith('--') && !/^--?\d/.test(value))) throw new Error(`Missing value for ${key}`);
    args[flag] = value;
    i += 1;
  }
  if (!args.logo || !args.out || !args.mode) throw new Error('Usage: sticker-panel.mjs --logo <png> --out <png> --mode circle|strip [--bg #000000] [--pad 0.12] [--key <hex>] [--soft-lo 24] [--soft-hi 64] [--size 1000]');
  if (!MODES.includes(args.mode)) throw new Error(`--mode must be one of ${MODES.join('|')}, got ${args.mode}`);
  args.bg = normalizeHex(args.bg, '--bg');
  args.key = args.key ? normalizeHex(args.key, '--key') : null;
  args.pad = Number(args.pad);
  args.softLo = Number(args.softLo);
  args.softHi = Number(args.softHi);
  args.size = Number(args.size);
  if (!(args.pad >= 0 && args.pad < 0.5)) throw new Error('--pad must be in [0, 0.5)');
  if (!(args.softLo >= 0 && args.softHi > args.softLo)) throw new Error('--soft-lo must be >= 0 and --soft-hi greater than --soft-lo');
  if (!(args.size >= MIN_SIZE)) throw new Error(`--size must be >= ${MIN_SIZE} (sticker assets ship at 1000px or more)`);
  return args;
}

export function normalizeHex(hex, flag) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`${flag} must be a 6-digit hex color, got ${hex}`);
  return `#${m[1].toUpperCase()}`;
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Median color of the 1-px border: the ground of an authored square panel. */
export function borderMedian(data, width, height) {
  const samples = [];
  for (let x = 0; x < width; x += 1) samples.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) samples.push(y * width, y * width + width - 1);
  const channel = (k) => samples.map((p) => data[p * 4 + k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  return [channel(0), channel(1), channel(2)];
}

/**
 * Pure: key `keyRgb` out of RGBA `data` in place with a soft edge. alpha' = alpha * ramp(dist), where
 * ramp is 0 at <= softLo, 1 at >= softHi, linear between; partially keyed pixels are un-blended
 * from the key color so the fringe keeps the ink's own hue. Returns the ink bbox and counts.
 */
export function keyGround(data, width, height, keyRgb, { softLo = DEFAULTS.softLo, softHi = DEFAULTS.softHi } = {}) {
  let minX = width, minY = height, maxX = -1, maxY = -1, keyed = 0, soft = 0, ink = 0;
  for (let p = 0; p < width * height; p += 1) {
    const o = p * 4;
    if (data[o + 3] === 0) continue;
    const dist = Math.hypot(data[o] - keyRgb[0], data[o + 1] - keyRgb[1], data[o + 2] - keyRgb[2]);
    let ramp = (dist - softLo) / (softHi - softLo);
    ramp = ramp <= 0 ? 0 : ramp >= 1 ? 1 : ramp;
    if (ramp < 1) {
      if (ramp === 0) { data[o] = data[o + 1] = data[o + 2] = 0; data[o + 3] = 0; keyed += 1; continue; }
      // un-blend: c = ramp * ink + (1 - ramp) * key  =>  ink = (c - (1 - ramp) * key) / ramp
      for (let k = 0; k < 3; k += 1) data[o + k] = Math.max(0, Math.min(255, Math.round((data[o + k] - (1 - ramp) * keyRgb[k]) / ramp)));
      data[o + 3] = Math.round(data[o + 3] * ramp);
      soft += 1;
    }
    ink += 1;
    const x = p % width, y = (p - x) / width;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return { bbox: null, keyed, soft, ink };
  return { bbox: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, keyed, soft, ink };
}

/** Circle-mode geometry, pure: the panel side and the art's scaled box centered in it. */
export function circleLayout(bbox, { size, pad }) {
  const diameter = size;
  const inner = diameter * (1 - 2 * pad);
  const diag = Math.hypot(bbox.width, bbox.height);
  const scale = inner / diag; // the bbox's diagonal spans the padded inner circle (corners touch the ring)
  const w = Math.max(1, Math.round(bbox.width * scale));
  const h = Math.max(1, Math.round(bbox.height * scale));
  return { diameter, scale, width: w, height: h, left: Math.round((diameter - w) / 2), top: Math.round((diameter - h) / 2) };
}

async function loadKeyed(logo, args) {
  const { data, info } = await sharp(logo).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const keyRgb = args.key ? hexToRgb(args.key) : borderMedian(data, width, height);
  const result = keyGround(data, width, height, keyRgb, { softLo: args.softLo, softHi: args.softHi });
  if (!result.bbox) throw new Error(`no ink left after keying ${args.key ?? 'the border color'} out of ${logo}; pass --key <hex> for the real ground`);
  const art = sharp(data, { raw: { width, height, channels: 4 } }).extract(result.bbox);
  return { art, keyRgb, ...result, source: { width, height } };
}

export async function stripGround(logo, out, args) {
  const keyed = await loadKeyed(logo, args);
  const longest = Math.max(keyed.bbox.width, keyed.bbox.height);
  const scale = longest < args.size ? args.size / longest : 1;
  let image = keyed.art;
  if (scale > 1) image = sharp(await image.png().toBuffer()).resize({ width: Math.round(keyed.bbox.width * scale), height: Math.round(keyed.bbox.height * scale), kernel: 'lanczos3', fit: 'fill' });
  await image.png({ palette: false, compressionLevel: 9 }).toFile(out);
  const meta = await sharp(out).metadata();
  return { mode: 'strip', logo, out, key: rgbHex(keyed.keyRgb), bbox: keyed.bbox, keyed_px: keyed.keyed, soft_px: keyed.soft, ink_px: keyed.ink, scale, width: meta.width, height: meta.height };
}

export async function circlePanel(logo, out, args) {
  const keyed = await loadKeyed(logo, args);
  const layout = circleLayout(keyed.bbox, { size: args.size, pad: args.pad });
  const art = await keyed.art.png().toBuffer();
  const scaled = await sharp(art).resize({ width: layout.width, height: layout.height, kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
  const r = layout.diameter / 2;
  const disc = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.diameter}" height="${layout.diameter}"><circle cx="${r}" cy="${r}" r="${r - 0.5}" fill="${args.bg}"/></svg>`);
  await sharp({ create: { width: layout.diameter, height: layout.diameter, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: disc, left: 0, top: 0 }, { input: scaled, left: layout.left, top: layout.top }])
    .png({ palette: false, compressionLevel: 9 })
    .toFile(out);
  return { mode: 'circle', logo, out, bg: args.bg, pad: args.pad, key: rgbHex(keyed.keyRgb), bbox: keyed.bbox, keyed_px: keyed.keyed, soft_px: keyed.soft, ink_px: keyed.ink, layout, width: layout.diameter, height: layout.diameter };
}

function rgbHex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export async function run(args) {
  const logo = path.resolve(args.logo);
  const out = path.resolve(args.out);
  await fs.access(logo);
  await fs.mkdir(path.dirname(out), { recursive: true });
  return args.mode === 'circle' ? circlePanel(logo, out, args) : stripGround(logo, out, args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv.slice(2)))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
