import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { boundaryDeviation, parseArgs, softMask, toPbm, traceSmooth } from './trace-smooth.mjs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');
const hasPotrace = spawnSync('potrace', ['--version'], { encoding: 'utf8' }).status === 0;

/** A 320 px "small source": gold display shapes on transparent with anti-aliased edges. */
async function smallSource(file) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140"><circle cx="60" cy="70" r="45" fill="#F2C927"/><rect x="130" y="30" width="60" height="80" rx="8" fill="#F2C927"/><path d="M 210 110 L 240 30 L 270 110 Z" fill="#F2C927"/></svg>';
  await sharp(Buffer.from(svg)).png().toFile(file);
}

test('parseArgs: defaults are the memory recipe (scale 8, sigma one source px, potrace -a 1.334 -O 1.0 -t 50, 4000 px)', () => {
  const args = parseArgs(['--in', 'a.png', '--out', 'b.png']);
  assert.equal(args.scale, 8);
  assert.equal(args.sigma, 8);
  assert.equal(args.size, 4000);
  assert.deepEqual([args.alphamax, args.opttolerance, args.turdsize], [1.334, 1.0, 50]);
  assert.equal(args.mask, 'alpha');
  assert.equal(args.color, null);
  assert.equal(parseArgs(['--in', 'a.png', '--out', 'b.png', '--scale', '4']).sigma, 4, 'sigma follows the scale');
  assert.equal(parseArgs(['--in', 'a.png', '--out', 'b.png', '--scale', '4', '--sigma', '6']).sigma, 6);
  assert.equal(parseArgs(['--in', 'a.png', '--out', 'b.png', '--white']).color, '#FFFFFF');
  assert.equal(parseArgs(['--in', 'a.png', '--out', 'b.png', '--color', '1b2a4a']).color, '#1B2A4A');
  assert.throws(() => parseArgs(['--in', 'a.png', '--out', 'b.png', '--mask', 'red']), /alpha\|dark\|light/);
  assert.throws(() => parseArgs(['--in', 'a.png']), /Usage/);
});

test('softMask: alpha mode is the alpha channel; dark mode ramps on luminance; the ink colour is the median over the mask', () => {
  const data = Buffer.from([242, 201, 39, 255, 0, 0, 0, 128, 255, 255, 255, 255, 20, 20, 20, 255]);
  const alpha = softMask(data, 4, 1, 'alpha');
  assert.deepEqual([...alpha.mask], [255, 128, 255, 255]);
  const dark = softMask(data, 4, 1, 'dark');
  assert.equal(dark.mask[2], 0, 'white is not dark ink');
  assert.equal(dark.mask[3], 255, 'near-black is full ink');
  assert.equal(dark.mask[1], 128, 'black at alpha 128 keeps the alpha');
  assert.equal(dark.inkHex, '#141414');
  const light = softMask(data, 4, 1, 'light');
  assert.equal(light.mask[2], 255);
  assert.equal(light.mask[3], 0);
});

test('toPbm packs a binary P4 with 1 = ink at the 0.5 threshold', () => {
  const pbm = toPbm(Uint8Array.from([255, 0, 128, 127, 0, 0, 0, 0, 255, 0]), 10, 1);
  assert.equal(pbm.subarray(0, 8).toString(), 'P4\n10 1\n');
  assert.deepEqual([...pbm.subarray(8)], [0b10100000, 0b10000000]);
});

test('boundaryDeviation: identical masks score 0; a one pixel shift scores p95 1 and a small mismatch', () => {
  const w = 20, h = 10;
  const a = new Uint8Array(w * h);
  const b = new Uint8Array(w * h);
  for (let y = 2; y < 8; y += 1) for (let x = 4; x < 14; x += 1) { a[y * w + x] = 1; b[y * w + x + 1] = 1; }
  assert.equal(boundaryDeviation(a, a, w, h).p95_px, 0);
  const shifted = boundaryDeviation(a, b, w, h);
  assert.equal(shifted.p95_px, 1);
  assert.equal(shifted.max_px, 1);
  assert.equal(shifted.area_ratio_new_over_ref, 1);
  assert.ok(shifted.mismatch_share > 0 && shifted.mismatch_share < 0.25);
});

test('traceSmooth: a 320 px source traces to a 1200 px anti-aliased render in the source ink colour that stays within 1 px of the source grid', { skip: !hasPotrace && 'potrace is not installed' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-smooth-'));
  try {
    const input = path.join(dir, 'small.png');
    await smallSource(input);
    const out = path.join(dir, 'traced.png');
    const result = await traceSmooth(parseArgs(['--in', input, '--out', out, '--scale', '4', '--size', '1200']));
    assert.equal(result.ok, true, JSON.stringify(result.source_grid_check));
    assert.equal(result.width, 1200);
    assert.equal(result.height, Math.round(140 * 1200 / 320));
    assert.equal(result.color, '#F2C927');
    assert.equal(result.color_source, 'source_median_ink');
    assert.equal(result.sigma_source_px, 1);
    assert.ok(result.alpha_levels > 8, `anti-aliased coverage kept as alpha (${result.alpha_levels} levels)`);
    assert.equal(result.source.small_source, true);
    assert.equal(result.note, null);
    assert.ok(result.source_grid_check.p95_px <= 1);
    assert.ok(result.source_grid_check.mismatch_share < 0.08, `mismatch ${result.source_grid_check.mismatch_share}`);
    assert.ok(Math.abs(result.source_grid_check.area_ratio_new_over_ref - 1) < 0.08);
    await access(result.svg);
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => { const o = (y * info.width + x) * 4; return [data[o], data[o + 1], data[o + 2], data[o + 3]]; };
    assert.deepEqual(px(Math.round(60 * 3.75), Math.round(70 * 3.75)), [242, 201, 39, 255], 'the disc centre is solid gold');
    assert.equal(px(5, 5)[3], 0, 'the corner is clear');
    const meta = await sharp(out).metadata();
    assert.equal(meta.paletteBitDepth, undefined, 'truecolor RGBA');
    // --white recolours; --mask dark traces black ink out of an opaque light ground
    const white = await traceSmooth(parseArgs(['--in', input, '--out', path.join(dir, 'w.png'), '--scale', '4', '--size', '800', '--white']));
    assert.equal(white.color, '#FFFFFF');
    const opaque = path.join(dir, 'opaque.png');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="#F4EFE3"/><rect x="40" y="30" width="220" height="60" rx="10" fill="#111111"/></svg>')).png().toFile(opaque);
    const dark = await traceSmooth(parseArgs(['--in', opaque, '--out', path.join(dir, 'd.png'), '--scale', '4', '--size', '900', '--mask', 'dark']));
    assert.equal(dark.ok, true, JSON.stringify(dark.source_grid_check));
    assert.equal(dark.color, '#111111');
    const d = await sharp(dark.out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(d.data[3], 0, 'the light ground is gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('traceSmooth refuses a source with no ink under the mask', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-smooth-'));
  try {
    const empty = path.join(dir, 'empty.png');
    await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(empty);
    await assert.rejects(() => traceSmooth(parseArgs(['--in', empty, '--out', path.join(dir, 'x.png')])), /no ink/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
