import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { boxLayout, circleLayout, keyGround, parseArgs, run } from './sticker-panel.mjs';

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
  assert.throws(() => parseArgs(['--logo', 'a.png', '--out', 'b.png', '--mode', 'blob']), /circle\|strip\|box/);
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

test('parseArgs: box mode defaults pad to 0.28 of the ink height and radius to 0.2 of the box height; circle keeps 0.12', () => {
  const box = parseArgs(['--logo', 'a.png', '--out', 'b.png', '--mode', 'box', '--bg', '#1B2A4A']);
  assert.equal(box.pad, 0.28);
  assert.equal(box.radius, 0.2);
  assert.equal(box.bg, '#1B2A4A');
  assert.equal(parseArgs(['--logo', 'a.png', '--out', 'b.png', '--mode', 'circle']).pad, 0.12);
  assert.throws(() => parseArgs(['--logo', 'a.png', '--out', 'b.png', '--mode', 'box', '--radius', '0.7']), /--radius/);
});

test('boxLayout: pad is a share of the ink height on every side, radius a share of the box height', () => {
  const layout = boxLayout({ width: 1200, height: 400 }, { pad: 0.28, radius: 0.2 });
  assert.equal(layout.pad, 112);
  assert.deepEqual([layout.width, layout.height], [1424, 624]);
  assert.equal(layout.radius, Math.round(0.2 * 624));
  assert.deepEqual([layout.left, layout.top], [112, 112]);
});

test('box mode: a transparent words cut lands centered in a rounded box of the card ground, nothing keyed, corners transparent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-panel-'));
  try {
    const logo = path.join(dir, 'words.png');
    const out = path.join(dir, 'box.png');
    // gold words on transparent, off-center in a larger transparent frame
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="500"><rect x="100" y="150" width="900" height="200" fill="#F2C927"/></svg>';
    await sharp(Buffer.from(svg)).png().toFile(logo);
    const summary = await run(parseArgs(['--logo', logo, '--out', out, '--mode', 'box', '--bg', '#000000']));
    assert.equal(summary.mode, 'box');
    assert.equal(summary.key, null, 'box mode keys nothing by default');
    assert.deepEqual(summary.bbox, { left: 100, top: 150, width: 900, height: 200 });
    // the mark is below 1000px on its longest side, so it is upscaled to 1000 first
    assert.equal(summary.mark.width, 1000);
    assert.ok(Math.abs(summary.mark.height - 222) <= 1);
    const pad = Math.round(0.28 * summary.mark.height);
    const img = await raw(out);
    assert.equal(img.width, 1000 + 2 * pad);
    assert.equal(img.height, summary.mark.height + 2 * pad);
    for (const [x, y] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) assert.equal(img.px(x, y)[3], 0, `corner ${x},${y} is transparent (rounded)`);
    assert.deepEqual(img.px(Math.round(img.width / 2), 2), [0, 0, 0, 255], 'the top edge mid-point is the opaque ground');
    assert.deepEqual(img.px(2, Math.round(img.height / 2)), [0, 0, 0, 255], 'the left edge mid-point is the opaque ground');
    const [r, g, b, a] = img.px(Math.round(img.width / 2), Math.round(img.height / 2));
    assert.ok(a === 255 && Math.hypot(r - 242, g - 201, b - 39) < 8, `the gold mark sits in the middle (${[r, g, b, a]})`);
    assert.deepEqual(img.px(pad - 3, Math.round(img.height / 2)), [0, 0, 0, 255], 'ground just left of the mark');
    const meta = await sharp(out).metadata();
    assert.equal(meta.channels, 4);
    assert.equal(meta.paletteBitDepth, undefined, 'truecolor RGBA');
    assert.deepEqual(summary.panel, { hex: '#000000', pad_share_of_mark_height: 0.28, radius_share_of_box_height: 0.2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
