import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { circleLayout, keyGround, parseArgs, run } from './sticker-panel.mjs';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'harness', 'package.json'));
const sharp = require('sharp');

/** An authored square panel: opaque black ground, a maroon word block plus a cream mark, off-center on purpose. */
async function opaqueSquare(file: string) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#000000"/><rect x="40" y="150" width="240" height="50" fill="#8B1E2F"/><ellipse cx="90" cy="230" rx="40" ry="18" fill="#D8C89A"/></svg>';
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function raw(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => { const o = (y * info.width + x) * 4; return [data[o], data[o + 1], data[o + 2], data[o + 3]]; };
  return { data, width: info.width, height: info.height, px };
}
function inkStats(img: { data: Buffer; width: number; height: number }) {
  let minX = img.width, maxX = -1, minY = img.height, maxY = -1, maroon = 0, transparent = 0, partial = 0;
  for (let p = 0; p < img.width * img.height; p += 1) {
    const o = p * 4;
    const a = img.data[o + 3];
    if (a === 0) { transparent += 1; continue; }
    if (a < 255) partial += 1;
    const [r, g, b] = [img.data[o], img.data[o + 1], img.data[o + 2]];
    const isInk = Math.hypot(r - 139, g - 30, b - 47) < 40 || Math.hypot(r - 216, g - 200, b - 154) < 40;
    if (!isInk) continue;
    if (Math.hypot(r - 139, g - 30, b - 47) < 40) maroon += 1;
    const x = p % img.width, y = (p - x) / img.width;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY, maroon, transparent, partial, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

test('parseArgs: mode is required and validated; size floor is 1000', () => {
  assert.throws(() => parseArgs(['--logo', 'a.png', '--out', 'b.png']), /--mode/);
  assert.throws(() => parseArgs(['--logo', 'a.png', '--out', 'b.png', '--mode', 'blob']), /circle\|strip/);
  assert.throws(() => parseArgs(['--logo', 'a.png', '--out', 'b.png', '--mode', 'circle', '--size', '800']), />= 1000/);
  const args = parseArgs(['--logo', 'a.png', '--out', 'b.png', '--mode', 'circle', '--bg', '1a1a1a', '--pad', '0.1']);
  assert.equal(args.bg, '#1A1A1A');
  assert.equal(args.pad, 0.1);
  assert.equal(args.size, 1000);
});

test('keyGround: ground pixels go transparent, far pixels stay, near pixels ramp and un-blend; bbox is the ink', () => {
  const w = 4, h = 1;
  const data = Buffer.from([0, 0, 0, 255, 200, 0, 0, 255, 0, 0, 0, 0, 24, 0, 0, 255]);
  // pixel 3 is dist 24 from black (= softLo): keyed out; make it mid-ramp instead
  data[12] = 44; // dist 44 -> ramp 0.5
  const result = keyGround(data, w, h, [0, 0, 0], { softLo: 24, softHi: 64 });
  assert.deepEqual([...data.subarray(0, 4)], [0, 0, 0, 0], 'the ground is transparent');
  assert.deepEqual([...data.subarray(4, 8)], [200, 0, 0, 255], 'ink far from the key is untouched');
  assert.equal(data[15], 128, 'a mid-ramp pixel gets half alpha');
  assert.equal(data[12], 88, 'and is un-blended from the ground (44 = 0.5 * ink + 0.5 * 0)');
  assert.deepEqual(result.bbox, { left: 1, top: 0, width: 3, height: 1 });
  assert.equal(result.keyed, 1);
  assert.equal(result.soft, 1);
});

test('circleLayout: the bbox diagonal spans the padded inner circle and the art is centered', () => {
  const layout = circleLayout({ width: 300, height: 100 }, { size: 1000, pad: 0.12 });
  assert.equal(layout.diameter, 1000);
  const diag = Math.hypot(layout.width, layout.height);
  assert.ok(Math.abs(diag - 760) < 2, `diagonal ${diag} spans 1000 * (1 - 0.24)`);
  assert.ok(Math.abs(layout.left + layout.width / 2 - 500) <= 0.5);
  assert.ok(Math.abs(layout.top + layout.height / 2 - 500) <= 0.5);
});

test('circle mode: an opaque square becomes a >=1000px circular panel with transparent corners and the art centered by its ink bbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-panel-'));
  try {
    const logo = path.join(dir, 'square.png');
    const out = path.join(dir, 'circle.png');
    await opaqueSquare(logo);
    const summary = await run(parseArgs(['--logo', logo, '--out', out, '--mode', 'circle']));
    assert.equal(summary.mode, 'circle');
    const img = await raw(out);
    assert.equal(img.width, 1000);
    assert.equal(img.height, 1000);
    for (const [x, y] of [[2, 2], [997, 2], [2, 997], [997, 997]]) assert.equal(img.px(x, y)[3], 0, `corner ${x},${y} is transparent`);
    assert.deepEqual(img.px(500, 60), [0, 0, 0, 255], 'inside the ring the panel is the opaque ground color');
    const meta = await sharp(out).metadata();
    assert.equal(meta.channels, 4);
    assert.equal(meta.paletteBitDepth, undefined, 'truecolor RGBA, not a palette png');
    const ink = inkStats(img);
    assert.ok(ink.maroon > 10000, `the word block survived (${ink.maroon} px)`);
    assert.ok(Math.abs(ink.cx - 499.5) <= 2, `ink centered horizontally (cx ${ink.cx})`);
    assert.ok(Math.abs(ink.cy - 499.5) <= 2, `ink centered vertically by its bbox, not the source frame (cy ${ink.cy})`);
    assert.ok(ink.partial > 0, 'the ring edge is anti-aliased');
    const diag = Math.hypot(ink.maxX - ink.minX, ink.maxY - ink.minY);
    assert.ok(diag < 1000 * 0.76 + 4 && diag > 1000 * 0.76 - 30, `art diagonal ${diag} fits the padded inner circle`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strip mode: the ground is keyed to transparent with a soft edge, the ink keeps its color, output is >=1000px truecolor RGBA trimmed to the ink', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-panel-'));
  try {
    const logo = path.join(dir, 'square.png');
    const out = path.join(dir, 'strip.png');
    await opaqueSquare(logo);
    const summary = await run(parseArgs(['--logo', logo, '--out', out, '--mode', 'strip']));
    assert.equal(summary.mode, 'strip');
    assert.equal(summary.key, '#000000');
    const img = await raw(out);
    assert.ok(Math.max(img.width, img.height) >= 1000, `longest side ${img.width}x${img.height}`);
    const meta = await sharp(out).metadata();
    assert.equal(meta.channels, 4);
    assert.equal(meta.paletteBitDepth, undefined, 'truecolor RGBA');
    // the word block owns the top-left corner of the trimmed file; the bottom-right (below the block, right of the mark) is keyed ground
    assert.equal(img.px(img.width - 1, img.height - 1)[3], 0, 'bottom-right corner is transparent');
    assert.equal(img.px(Math.round(img.width * 0.6), img.height - 1)[3], 0, 'ground between the block and the mark is transparent');
    const ink = inkStats(img);
    assert.ok(ink.transparent / (img.width * img.height) > 0.25, 'the ground between the word block and the mark is gone');
    assert.ok(ink.maroon > 100000, `the word block survived at 1000px (${ink.maroon} px)`);
    assert.ok(ink.partial > 0, 'edges are anti-aliased, not binary');
    // no black ground pixel survives fully opaque
    let opaqueBlack = 0;
    for (let p = 0; p < img.width * img.height; p += 1) { const o = p * 4; if (img.data[o + 3] === 255 && img.data[o] < 20 && img.data[o + 1] < 20 && img.data[o + 2] < 20) opaqueBlack += 1; }
    assert.equal(opaqueBlack, 0);
    // trimmed: the word block starts at the left edge of the file
    assert.ok(ink.minX <= 2, `trimmed to the ink (minX ${ink.minX})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
