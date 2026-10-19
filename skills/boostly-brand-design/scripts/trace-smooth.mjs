#!/usr/bin/env node
// trace-smooth.mjs: the smoothed potrace recipe for a small (sub-700 px) source, the one that
// survived review on Indian Kitchen & Grill 2026-10-12 (fix/smooth/build-smooth.py). The trace
// must remove the source's pixel grid, not preserve it: a trace of the bare 8x upsample follows
// the staircase and every letter edge wobbles at 4000 px.
//
//   node scripts/trace-smooth.mjs --in <png> --out <png> [--scale 8] [--size 4000] \
//        [--sigma <px at scale>] [--mask alpha|dark|light] [--color #hex | --white] \
//        [--alphamax 1.334] [--opttolerance 1.0] [--turdsize 50] [--max-p95 1] [--json]
//
//   1. soft mask from the source: alpha (default, a transparent knockout), dark (black ink on a
//      light or soft ground: (150 - luminance) / 90 ramp times alpha) or light (the inverse).
//   2. lanczos3 upsample by --scale (8), then a Gaussian of --sigma (default = scale, one source
//      pixel) on the soft mask, then the 0.5 threshold.
//   3. potrace -s -a 1.334 -O 1.0 -t 50 (maximum corner smoothing, full curve optimisation).
//   4. render the SVG through sharp at --size on the longest side; the anti-aliased coverage
//      becomes the alpha (no 0.5 snap), the ink colour is --color, --white or the source's
//      median ink colour; truecolor max-effort PNG. The SVG is kept at <out>.svg.
//   5. source-grid check: the render box-averaged back to the source grid against the source
//      mask: boundary deviation p95 (px), mismatch share, area ratio. Over --max-p95: exit 3.
// Byte budget is finalize-asset.mjs's job (soft alpha at 4000 px is a Figma-only master).
//
// Exit codes: 0 ok, 1 usage/load error, 2 potrace missing or failed, 3 source-grid check failed.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(SCRIPT_DIR, '..', 'harness', 'package.json'));
const sharp = require('sharp');

export const MASKS = ['alpha', 'dark', 'light'];
export const DEFAULTS = { scale: 8, size: 4000, mask: 'alpha', alphamax: 1.334, opttolerance: 1.0, turdsize: 50, maxP95: 1 };
export const SMALL_SOURCE_PX = 700;
const PNG_OPTIONS = { palette: false, compressionLevel: 9, adaptiveFiltering: true, effort: 10 };

export function parseArgs(argv) {
  const args = { ...DEFAULTS, json: false, white: false, color: null, sigma: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flag === 'json' || flag === 'white') { args[flag] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[flag] = value;
    i += 1;
  }
  if (!args.in || !args.out) throw new Error('Usage: trace-smooth.mjs --in <png> --out <png> [--scale 8] [--size 4000] [--sigma <px>] [--mask alpha|dark|light] [--color #hex | --white] [--alphamax 1.334] [--opttolerance 1.0] [--turdsize 50] [--max-p95 1] [--json]');
  if (!MASKS.includes(args.mask)) throw new Error(`--mask must be one of ${MASKS.join('|')}, got ${args.mask}`);
  for (const k of ['scale', 'size', 'alphamax', 'opttolerance', 'turdsize', 'maxP95']) {
    args[k] = Number(args[k]);
    if (!(args[k] >= 0)) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a number`);
  }
  if (!(args.scale >= 1)) throw new Error('--scale must be at least 1');
  args.sigma = args.sigma === null ? args.scale : Number(args.sigma);
  if (args.color) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(args.color).trim());
    if (!m) throw new Error(`--color must be a 6-digit hex color, got ${args.color}`);
    args.color = `#${m[1].toUpperCase()}`;
  }
  if (args.white) args.color = '#FFFFFF';
  return args;
}

/** Pure: soft mask (0..255) of RGBA data for a mask mode, plus the median ink colour of the pixels over 0.5. */
export function softMask(data, width, height, mode) {
  const mask = new Uint8Array(width * height);
  const reds = [], greens = [], blues = [];
  for (let p = 0; p < width * height; p += 1) {
    const o = p * 4;
    const a = data[o + 3] / 255;
    let v = a;
    if (mode !== 'alpha') {
      const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      const ramp = mode === 'dark' ? (150 - lum) / 90 : (lum - 105) / 90;
      v = Math.max(0, Math.min(1, ramp)) * a;
    }
    mask[p] = Math.round(v * 255);
    if (v > 0.5) { reds.push(data[o]); greens.push(data[o + 1]); blues.push(data[o + 2]); }
  }
  const median = (arr) => (arr.length ? arr.sort((x, y) => x - y)[Math.floor(arr.length / 2)] : 0);
  const ink = [median(reds), median(greens), median(blues)];
  return { mask, ink, inkHex: `#${ink.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`, inkPixels: reds.length };
}

/** Pure: 1-channel 0..255 data to a binary P4 PBM at threshold 0.5 (1 = black = ink). */
export function toPbm(data, width, height, threshold = 128) {
  const rowBytes = Math.ceil(width / 8);
  const body = Buffer.alloc(rowBytes * height, 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] >= threshold) body[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([Buffer.from(`P4\n${width} ${height}\n`), body]);
}

/**
 * Pure: boundary deviation between two binary masks on the same grid. For every boundary pixel
 * of A, the smallest window radius (0..maxR) within which B has ink, and the same from B to A;
 * p95 and max of those radii (px), the XOR share and the area ratio. Radii past maxR count as maxR + 1.
 */
export function boundaryDeviation(a, b, width, height, maxR = 3) {
  const boundary = (m) => {
    const out = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        if (!m[p]) continue;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !m[p - 1] || !m[p + 1] || !m[p - width] || !m[p + width]) out.push(p);
      }
    }
    return out;
  };
  const nearest = (p, m) => {
    const x = p % width;
    const y = (p - x) / width;
    for (let r = 0; r <= maxR; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (m[yy * width + xx]) return r;
        }
      }
    }
    return maxR + 1;
  };
  const radii = [...boundary(a).map((p) => nearest(p, b)), ...boundary(b).map((p) => nearest(p, a))].sort((x, y) => x - y);
  let xor = 0, or = 0, areaA = 0, areaB = 0;
  for (let p = 0; p < width * height; p += 1) {
    if (a[p]) areaA += 1;
    if (b[p]) areaB += 1;
    if (a[p] !== b[p]) xor += 1;
    if (a[p] || b[p]) or += 1;
  }
  const p95 = radii.length ? radii[Math.min(radii.length - 1, Math.floor(0.95 * radii.length))] : 0;
  return { p95_px: p95, max_px: radii.length ? radii[radii.length - 1] : 0, boundary_pixels: radii.length, mismatch_share: Number((xor / Math.max(1, or)).toFixed(4)), area_ratio_new_over_ref: Number((areaB / Math.max(1, areaA)).toFixed(4)) };
}

/** Raw 1-channel bytes of a sharp pipeline: resize and blur can widen a 1-channel raw input to 3 channels. */
async function singleChannel(pipeline, width, height) {
  const { data, info } = await pipeline.toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return data;
  const out = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) out[p] = data[p * info.channels];
  return out;
}

function svgSizePt(svg) {
  const m = /<svg[^>]*\swidth="([\d.]+)pt"[^>]*\sheight="([\d.]+)pt"/.exec(svg) ?? /width="([\d.]+)pt" height="([\d.]+)pt"/.exec(svg);
  if (!m) throw new Error('potrace SVG without a pt width/height header');
  return { width: Number(m[1]), height: Number(m[2]) };
}

export async function traceSmooth(args) {
  const inPath = path.resolve(args.in);
  const outPath = path.resolve(args.out);
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const { mask, inkHex, inkPixels } = softMask(data, w, h, args.mask);
  if (!inkPixels) throw new Error(`no ink in ${inPath} under --mask ${args.mask}`);
  const W = Math.round(w * args.scale);
  const H = Math.round(h * args.scale);
  let up = sharp(mask, { raw: { width: w, height: h, channels: 1 } }).resize({ width: W, height: H, kernel: 'lanczos3', fit: 'fill' });
  if (args.sigma > 0) up = up.blur(Math.max(0.3, args.sigma));
  const big = await singleChannel(up, W, H);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-smooth-'));
  const svgOut = `${outPath}.svg`;
  try {
    const pbm = path.join(scratch, 'mask.pbm');
    await fs.writeFile(pbm, toPbm(big, W, H));
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const potrace = spawnSync('potrace', ['-s', '-a', String(args.alphamax), '-O', String(args.opttolerance), '-t', String(args.turdsize), '-o', svgOut, pbm], { encoding: 'utf8' });
    if (potrace.error || potrace.status !== 0) {
      const reason = potrace.error ? `potrace not runnable: ${potrace.error.message}` : `potrace exit ${potrace.status}: ${(potrace.stderr || '').trim()}`;
      const error = new Error(reason);
      error.code = 2;
      throw error;
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  const svg = await fs.readFile(svgOut, 'utf8');
  const pt = svgSizePt(svg);
  const longestPt = Math.max(pt.width, pt.height);
  const outW = Math.max(1, Math.round(pt.width * args.size / longestPt));
  const outH = Math.max(1, Math.round(pt.height * args.size / longestPt));
  const render = await sharp(Buffer.from(svg), { density: 72 * args.size / longestPt }).resize({ width: outW, height: outH, fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const color = args.color ?? inkHex;
  const rgb = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
  const out = Buffer.alloc(outW * outH * 4, 0);
  const coverage = new Uint8Array(outW * outH);
  const levels = new Set();
  for (let p = 0; p < outW * outH; p += 1) {
    const o = p * 4;
    // potrace fills black on transparent: coverage = alpha x darkness
    const a = Math.round((render.data[o + 3] / 255) * (1 - render.data[o] / 255) * 255);
    coverage[p] = a;
    levels.add(a);
    if (!a) continue;
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = a;
  }
  await sharp(out, { raw: { width: outW, height: outH, channels: 4 } }).png(PNG_OPTIONS).toFile(outPath);
  // source-grid check: box-average the render back to the source grid
  const back = await singleChannel(sharp(coverage, { raw: { width: outW, height: outH, channels: 1 } }).resize({ width: w, height: h, fit: 'fill', kernel: 'lanczos3' }), w, h);
  const ref = new Uint8Array(w * h);
  const got = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    ref[p] = mask[p] >= 128 ? 1 : 0;
    got[p] = back[p] >= 128 ? 1 : 0;
  }
  const check = boundaryDeviation(ref, got, w, h);
  const bytes = (await fs.stat(outPath)).size;
  return {
    ok: check.p95_px <= args.maxP95,
    in: inPath,
    out: outPath,
    svg: svgOut,
    width: outW,
    height: outH,
    bytes,
    color,
    color_source: args.color ? 'flag' : 'source_median_ink',
    alpha_levels: levels.size,
    mask: args.mask,
    scale: args.scale,
    sigma: args.sigma,
    sigma_source_px: Number((args.sigma / args.scale).toFixed(3)),
    potrace: { alphamax: args.alphamax, opttolerance: args.opttolerance, turdsize: args.turdsize },
    source: { width: w, height: h, longest: Math.max(w, h), small_source: Math.max(w, h) < SMALL_SOURCE_PX },
    source_grid_check: { ...check, max_p95_px: args.maxP95, pass: check.p95_px <= args.maxP95 },
    note: Math.max(w, h) >= SMALL_SOURCE_PX ? `source is ${Math.max(w, h)} px; the smoothed trace is meant for sources under ${SMALL_SOURCE_PX} px` : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  traceSmooth(args)
    .then((result) => {
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`${result.out}: ${result.width}x${result.height} px, ${result.bytes} B, ${result.alpha_levels} alpha levels, ${result.color}, sigma ${result.sigma_source_px} source px; source-grid p95 ${result.source_grid_check.p95_px} px, mismatch ${result.source_grid_check.mismatch_share} (${result.ok ? 'pass' : 'FAIL'})\n`);
      process.exit(result.ok ? 0 : 3);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(error.code === 2 ? 2 : 1);
    });
}
