import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { alphaModeFor, finalizeAsset, flattenInk, ladderSizes, parseArgs, singleInk, treatAlpha } from './finalize-asset.mjs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');
const SCRIPT = fileURLToPath(new URL('./finalize-asset.mjs', import.meta.url));

/** A hard-to-compress mark: noisy RGB with a soft radial alpha, so bytes track pixel count. */
async function noisyMark(file, width, height) {
  const data = Buffer.alloc(width * height * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const d = Math.hypot((x - width / 2) / (width / 2), (y - height / 2) / (height / 2));
      const a = Math.max(0, Math.min(1, (1 - d) * 1.6));
      data[o] = Math.round(rnd() * 255);
      data[o + 1] = Math.round(rnd() * 255);
      data[o + 2] = Math.round(rnd() * 255);
      data[o + 3] = Math.round(a * 255);
    }
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}
async function alphaValues(file) {
  const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const seen = new Set();
  for (let o = 3; o < data.length; o += 4) seen.add(data[o]);
  return seen;
}

test('parseArgs validates the surface and alpha mode and applies the defaults', () => {
  const args = parseArgs(['--in', 'a.png', '--out', 'b.png', '--surface', 'card']);
  assert.equal(args.maxBytes, 70000);
  assert.equal(args.floorPx, 1000);
  assert.equal(args.step, 100);
  assert.equal(args.alphaLevels, 9);
  assert.equal(args.tinypng, true);
  assert.equal(args.json, false);
  assert.throws(() => parseArgs(['--in', 'a.png', '--out', 'b.png', '--surface', 'badge']), /card\|sticker/);
  assert.throws(() => parseArgs(['--in', 'a.png', '--out', 'b.png', '--surface', 'card', '--alpha', 'hard']), /snap\|aa\|soft/);
  const sticker = parseArgs(['--in', 'a.png', '--out', 'b.png', '--surface', 'sticker', '--max-bytes', '50000', '--no-tinypng', '--json']);
  assert.equal(sticker.maxBytes, 50000);
  assert.equal(sticker.tinypng, false);
  assert.equal(sticker.json, true);
});

test('alphaModeFor: card snaps at 1000 px and above, aa below; sticker always aa; override wins', () => {
  assert.equal(alphaModeFor('card', 1000), 'snap');
  assert.equal(alphaModeFor('card', 1600), 'snap');
  assert.equal(alphaModeFor('card', 900), 'aa');
  assert.equal(alphaModeFor('sticker', 4000), 'aa');
  assert.equal(alphaModeFor('card', 4000, 'soft'), 'soft');
});

test('treatAlpha: snap is binary with RGB zeroed under alpha 0; aa keeps 9 levels with 0 and 255; soft snaps only the ends', () => {
  const sample = () => Buffer.from([10, 20, 30, 0, 10, 20, 30, 100, 10, 20, 30, 200, 10, 20, 30, 250, 10, 20, 30, 255, 10, 20, 30, 5]);
  const snap = sample();
  assert.equal(treatAlpha(snap, 'snap'), 2);
  assert.deepEqual([...snap.subarray(0, 8)], [0, 0, 0, 0, 0, 0, 0, 0], 'alpha 100 snaps to 0 and its RGB is zeroed');
  assert.equal(snap[11], 255);
  const aa = sample();
  const levels = treatAlpha(aa, 'aa', 9);
  assert.ok(levels <= 9);
  assert.equal(aa[3], 0);
  assert.equal(aa[19], 255);
  assert.ok([...new Set([aa[7], aa[11], aa[15]])].every((a) => Number.isInteger(a / 255 * 8 + 1e-9) || Math.abs(a / 255 * 8 - Math.round(a / 255 * 8)) < 0.02), 'quantized to multiples of 255/8');
  const soft = sample();
  treatAlpha(soft, 'soft');
  assert.deepEqual([soft[7], soft[11], soft[15], soft[23]], [100, 200, 255, 0]);
});

test('ladderSizes: native first, 100 px decrements, never below the floor, and the floor never below the 700 px ship gate', () => {
  assert.deepEqual(ladderSizes(1250, { floorPx: 1000, step: 100 }), { floor: 1000, sizes: [1250, 1200, 1100, 1000] });
  assert.deepEqual(ladderSizes(1000, { floorPx: 1000, step: 100 }), { floor: 1000, sizes: [1000] });
  assert.deepEqual(ladderSizes(800, { floorPx: 1000, step: 100 }).sizes, [800], 'a source under the floor is encoded at native only');
  assert.deepEqual(ladderSizes(900, { floorPx: 500, step: 100 }), { floor: 700, sizes: [900, 800, 700] });
});

test('card at 1300 px: snaps alpha, encodes truecolor, walks the ladder to the first rung under the cap and writes the ladder json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finalize-asset-'));
  try {
    const input = path.join(dir, 'mark.png');
    await noisyMark(input, 1300, 400);
    const out = path.join(dir, 'final.png');
    const probe = await finalizeAsset(parseArgs(['--in', input, '--out', out, '--surface', 'card', '--no-tinypng', '--max-bytes', '100000000']));
    assert.equal(probe.fits, true);
    assert.equal(probe.rungs, 1);
    assert.deepEqual(probe.px, [1300, 400]);
    assert.equal(probe.alpha, 'snap');
    assert.deepEqual([...(await alphaValues(out))].sort(), [0, 255], 'binary alpha at 1300 px');
    // cap between the 1100 and 1200 rungs: the ladder must stop at 1100
    const r1200 = await finalizeAsset(parseArgs(['--in', input, '--out', path.join(dir, 'p1200.png'), '--surface', 'card', '--no-tinypng', '--floor-px', '1200', '--max-bytes', '1']));
    const r1100 = await finalizeAsset(parseArgs(['--in', input, '--out', path.join(dir, 'p1100.png'), '--surface', 'card', '--no-tinypng', '--floor-px', '1100', '--max-bytes', '1']));
    assert.ok(r1100.bytes < r1200.bytes && r1200.bytes < probe.bytes, `bytes shrink down the ladder: ${probe.bytes} > ${r1200.bytes} > ${r1100.bytes}`);
    const cap = Math.round((r1100.bytes + r1200.bytes) / 2);
    const result = await finalizeAsset(parseArgs(['--in', input, '--out', out, '--surface', 'card', '--no-tinypng', '--max-bytes', String(cap)]));
    assert.equal(result.fits, true);
    assert.deepEqual(result.px, [1100, Math.round(400 * 1100 / 1300)]);
    assert.equal(result.rungs, 3, 'native, 1200, 1100');
    assert.ok(result.bytes <= cap);
    assert.equal(result.tinypng, 'disabled');
    assert.ok(result.steps.some((s) => s.action === 'resize' && s.longest === 1100));
    assert.ok(result.steps.every((s) => s.action !== 'tinypng'));
    const ladder = JSON.parse(await readFile(`${out}.ladder.json`, 'utf8'));
    assert.equal(ladder.rungs.length, 3);
    assert.deepEqual(ladder.rungs.map((r) => r.longest), [1300, 1200, 1100]);
    assert.deepEqual(ladder.rungs.map((r) => r.fits), [false, false, true]);
    assert.equal(ladder.surface, 'card');
    assert.equal(ladder.max_bytes, cap);
    assert.equal(ladder.floor_px, 1000);
    assert.equal(ladder.in_px[0], 1300);
    assert.equal(ladder.bytes, (await stat(out)).size);
    assert.equal(ladder.out_sha256.length, 64);
    const meta = await sharp(out).metadata();
    assert.equal(meta.channels, 4);
    assert.equal(meta.paletteBitDepth, undefined, 'truecolor, never indexed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sticker keeps 9-level anti-aliased alpha; a card rung under 1000 px also keeps aa', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finalize-asset-'));
  try {
    const input = path.join(dir, 'mark.png');
    await noisyMark(input, 1000, 300);
    const sticker = await finalizeAsset(parseArgs(['--in', input, '--out', path.join(dir, 's.png'), '--surface', 'sticker', '--no-tinypng', '--max-bytes', '100000000']));
    assert.equal(sticker.alpha, 'aa');
    const levels = await alphaValues(path.join(dir, 's.png'));
    assert.ok(levels.size > 2 && levels.size <= 9, `9-level alpha, got ${levels.size}`);
    assert.ok(levels.has(0) && levels.has(255));
    const small = path.join(dir, 'small.png');
    await noisyMark(small, 800, 200);
    const card = await finalizeAsset(parseArgs(['--in', small, '--out', path.join(dir, 'c.png'), '--surface', 'card', '--no-tinypng', '--max-bytes', '100000000']));
    assert.equal(card.alpha, 'aa', 'under 1000 px a card keeps the anti-aliased alpha');
    assert.deepEqual(card.px, [800, 200], 'never upscaled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: over the cap at the floor still writes the floor rung, reports fits: false and exits 3; --json prints the summary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finalize-asset-'));
  try {
    const input = path.join(dir, 'mark.png');
    await noisyMark(input, 1100, 300);
    const out = path.join(dir, 'floor.png');
    const run = spawnSync(process.execPath, [SCRIPT, '--in', input, '--out', out, '--surface', 'sticker', '--no-tinypng', '--max-bytes', '500', '--json'], { encoding: 'utf8', env: { ...process.env, TINYPNG_API_KEY: '' } });
    assert.equal(run.status, 3, run.stderr);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.fits, false);
    assert.deepEqual(summary.px, [1000, Math.round(300 * 1000 / 1100)]);
    assert.equal(summary.rungs, 2);
    assert.equal((await stat(out)).size, summary.bytes);
    const ladder = JSON.parse(await readFile(`${out}.ladder.json`, 'utf8'));
    assert.equal(ladder.fits, false);
    assert.equal(ladder.tinypng, 'disabled');
    const usage = spawnSync(process.execPath, [SCRIPT, '--in', input], { encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Usage/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('singleInk: a one-colour mark is detected from its opaque pixels and flattened under every covered pixel; a two-colour mark is left alone', () => {
  const gold = Buffer.from([242, 201, 39, 255, 240, 200, 40, 255, 120, 100, 20, 128, 0, 0, 0, 0]);
  assert.deepEqual(singleInk(gold), [242, 201, 39]);
  flattenInk(gold, singleInk(gold));
  assert.deepEqual([...gold.subarray(8, 12)], [242, 201, 39, 128], 'the fringe pixel takes the ink, keeps its alpha');
  assert.deepEqual([...gold.subarray(12, 16)], [0, 0, 0, 0], 'transparent pixels stay zero');
  assert.equal(singleInk(Buffer.from([242, 201, 39, 255, 0, 0, 0, 255])), null);
});

test('a single-ink soft-alpha master at 2000 px ladders to a sticker copy under the cap with the ink flattened', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finalize-asset-'));
  try {
    const input = path.join(dir, 'gold.png');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="700"><text x="1000" y="520" text-anchor="middle" font-family="Arial" font-size="560" font-weight="700" fill="#F2C927">KITCHEN</text></svg>';
    await sharp(Buffer.from(svg)).png().toFile(input);
    const out = path.join(dir, 's.png');
    const result = await finalizeAsset(parseArgs(['--in', input, '--out', out, '--surface', 'sticker', '--no-tinypng', '--max-bytes', '30000', '--floor-px', '1000']));
    assert.equal(result.fits, true, JSON.stringify(result));
    assert.ok(result.steps.some((s) => s.action === 'flatten_ink' && s.ink === '#F2C927'));
    const { data } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let o = 0; o < data.length; o += 4) if (data[o + 3]) assert.deepEqual([data[o], data[o + 1], data[o + 2]], [242, 201, 39]);
    const ladder = JSON.parse(await readFile(`${out}.ladder.json`, 'utf8'));
    assert.equal(ladder.single_ink, '#F2C927');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--box-bg boxes the treated mark at every rung and measures the boxed bytes; the output is the rounded box', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finalize-asset-'));
  try {
    const input = path.join(dir, 'gold.png');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="700"><text x="1000" y="520" text-anchor="middle" font-family="Arial" font-size="560" font-weight="700" fill="#F2C927">KITCHEN</text></svg>';
    await sharp(Buffer.from(svg)).png().toFile(input);
    const out = path.join(dir, 'box.png');
    const big = await finalizeAsset(parseArgs(['--in', input, '--out', out, '--surface', 'sticker', '--no-tinypng', '--max-bytes', '100000000', '--box-bg', '000000']));
    assert.equal(big.rungs, 1);
    assert.deepEqual(big.panel, { mode: 'box', hex: '#000000', pad_share_of_mark_height: 0.28, radius_share_of_box_height: 0.2 });
    const ladder = JSON.parse(await readFile(`${out}.ladder.json`, 'utf8'));
    const r = ladder.rungs[0];
    assert.ok(r.mark_px[0] <= 2000 && r.px[0] > r.mark_px[0], `box wider than the mark: ${r.px} vs ${r.mark_px}`);
    assert.ok(r.steps.some((s) => s.action === 'box' && s.bg === '#000000'));
    const img = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => { const o = (y * img.info.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]; };
    assert.equal(px(0, 0)[3], 0, 'rounded corner is transparent');
    assert.deepEqual(px(Math.round(img.info.width / 2), 2), [0, 0, 0, 255], 'box ground at the top edge');
    // a tight cap walks the ladder on the mark size and still ships a box
    const capped = await finalizeAsset(parseArgs(['--in', input, '--out', path.join(dir, 'c.png'), '--surface', 'sticker', '--no-tinypng', '--max-bytes', String(Math.round(big.bytes * 0.8)), '--box-bg', '#000000']));
    assert.ok(capped.rungs > 1);
    assert.equal(capped.fits, true);
    assert.ok(capped.px[0] < big.px[0]);
    assert.ok(capped.bytes <= Math.round(big.bytes * 0.8));
    assert.throws(() => parseArgs(['--in', 'a.png', '--out', 'b.png', '--surface', 'sticker', '--box-bg', 'black']), /--box-bg/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
