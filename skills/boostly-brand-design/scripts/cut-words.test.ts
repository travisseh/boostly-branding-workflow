import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { cutWords, cutWordsSvg, labelComponents, parsePageSvg, parseTransform, pathBbox } from './cut-words.mjs';
import { writeFile } from 'node:fs/promises';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

test('union-find labeling counts 8-connected components', () => {
  const width = 6;
  const height = 3;
  const mask = new Uint8Array([
    1, 0, 0, 0, 1, 1,
    0, 1, 0, 0, 0, 0,
    0, 0, 0, 1, 0, 0,
  ]);
  const { components } = labelComponents(mask, width, height);
  assert.equal(components.length, 3);
  assert.deepEqual(components.map((c) => c.area).sort(), [1, 2, 2]);
});

test('cut-words keeps the name lines and drops the ring, the EST. line and the slice dots', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-cut-words-'));
  try {
    const logo = path.join(directory, 'badge.png');
    const out = path.join(directory, 'words.png');
    await sharp(Buffer.from(`
      <svg width="1600" height="1600" xmlns="http://www.w3.org/2000/svg">
        <circle cx="800" cy="800" r="740" fill="none" stroke="#FFFFFF" stroke-width="60"/>
        <text x="800" y="620" text-anchor="middle" font-family="Arial" font-size="150" font-weight="700" fill="#FFFFFF">ASTORIA</text>
        <text x="800" y="880" text-anchor="middle" font-family="Arial" font-size="230" font-weight="700" fill="#FFFFFF">PIZZA</text>
        <text x="800" y="1000" text-anchor="middle" font-family="Arial" font-size="70" letter-spacing="10" fill="#FFFFFF">EST. 2014</text>
        <circle cx="600" cy="1200" r="30" fill="#FFFFFF"/>
        <circle cx="700" cy="1250" r="30" fill="#FFFFFF"/>
        <circle cx="900" cy="1220" r="30" fill="#FFFFFF"/>
      </svg>
    `)).png().toFile(logo);
    const result = await cutWords(logo, out, { white: true, binaryAlpha: true, width: 1200 });
    assert.equal(result.ok, true, JSON.stringify(result.lines));
    assert.equal(result.kept_component_count, 12, JSON.stringify(result.lines)); // ASTORIA 7 + PIZZA 5
    const decisions = result.components.map((c) => c.decision);
    assert(decisions.includes('dropped:giant_emblem_or_ring'));
    assert(decisions.includes('dropped:descriptor_line_below_ratio'));
    const ring = result.components.find((c) => c.kind === 'ring');
    assert(ring, 'the dropped ring is classed kind: ring');
    assert(ring.hole_share > 0.3 && ring.hole_share < 0.9, `annular hole share ${ring.hole_share}`);
    assert.equal(result.ring.id, ring.id);
    assert(result.ring.inner_band[0] > 0.02 && result.ring.inner_band[1] < 0.98, `inner band sits inside the ring: ${result.ring.inner_band}`);
    assert(result.components.filter((c) => c.decision.startsWith('kept')).every((c) => c.kind === null), 'letters are not rings');
    const meta = await sharp(out).metadata();
    assert(meta.width <= 1200);
    assert(meta.height < meta.width * 0.6, `words cut should be wide: ${meta.width}x${meta.height}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cut-words honors keep and drop id hints and a band hint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-cut-words-hints-'));
  try {
    const logo = path.join(directory, 'two-lines.png');
    await sharp(Buffer.from(`
      <svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg">
        <text x="600" y="220" text-anchor="middle" font-family="Arial" font-size="200" font-weight="700" fill="#FFFFFF">GOLD</text>
        <text x="600" y="520" text-anchor="middle" font-family="Arial" font-size="60" fill="#FFFFFF">SINCE 1984</text>
      </svg>
    `)).png().toFile(logo);
    const plain = await cutWords(logo, path.join(directory, 'a.png'), {});
    assert.equal(plain.kept_component_count, 4);
    const banded = await cutWords(logo, path.join(directory, 'b.png'), { band: [0.6, 1.0] });
    assert.equal(banded.ok, true);
    assert(banded.components.filter((c) => c.decision.startsWith('kept')).every((c) => c.bbox[1] >= 360));
    const dropOne = await cutWords(logo, path.join(directory, 'c.png'), { dropIds: [plain.components.find((c) => c.decision === 'kept:name_line').id] });
    assert.equal(dropOne.kept_component_count, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a solid disc giant is dropped but is not a ring (hole share near zero)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-cut-words-disc-'));
  try {
    const logo = path.join(directory, 'disc.png');
    await sharp(Buffer.from(`
      <svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg">
        <circle cx="400" cy="400" r="380" fill="#FFFFFF"/>
        <text x="600" y="1100" text-anchor="middle" font-family="Arial" font-size="160" font-weight="700" fill="#FFFFFF">DISC CO</text>
      </svg>
    `)).png().toFile(logo);
    const result = await cutWords(logo, path.join(directory, 'w.png'), { white: true });
    const disc = result.components.find((c) => c.area > 300000);
    assert(disc, 'the disc is one component');
    assert.equal(disc.kind, null);
    assert.equal(result.ring, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('svg helpers: transform parsing, path bbox from absolute coordinates, page parsing with nested fills and transforms', () => {
  assert.deepEqual(parseTransform('translate(10, 20)'), [1, 0, 0, 1, 10, 20]);
  assert.deepEqual(parseTransform('matrix(2, 0, 0, 2, 5, 6)'), [2, 0, 0, 2, 5, 6]);
  assert.deepEqual(parseTransform('translate(10,20) scale(2)'), [2, 0, 0, 2, 10, 20]);
  assert.deepEqual(pathBbox('M 1 -9.5 L 10.25 -9.5 L 10.25 0 L 1 0 Z M 1 -9.5 '), [1, -9.5, 10.25, 0]);
  const page = parsePageSvg(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="50" viewBox="0 0 100 50">
<defs>
<g id="glyph-0-0">
</g>
<g id="glyph-0-1">
<path d="M 0 -10 L 8 -10 L 8 0 L 0 0 Z M 0 -10 "/>
</g>
</defs>
<g transform="translate(5, 0)">
<g fill="rgb(100%, 100%, 100%)" fill-opacity="1">
<use xlink:href="#glyph-0-1" x="10" y="30"/>
<use xlink:href="#glyph-0-0" x="20" y="30"/>
</g>
</g>
<g fill="rgb(0%, 0%, 0%)" fill-opacity="1">
<use xlink:href="#glyph-0-1" x="50" y="45"/>
</g>
</svg>`);
  assert.deepEqual(page.page, { x: 0, y: 0, width: 100, height: 50 });
  assert.equal(page.glyphs.size, 2);
  assert.equal(page.uses.length, 3);
  assert.deepEqual(page.uses[0].bbox, [15, 20, 23, 30], 'glyph box translated by the use x/y and the ancestor translate');
  assert.equal(page.uses[0].fill, 'rgb(100%, 100%, 100%)');
  assert.equal(page.uses[1].bbox, null, 'an empty glyph (space) has no box');
  assert.deepEqual(page.uses[2].bbox, [50, 35, 58, 45]);
  assert.equal(page.uses[2].fill, 'rgb(0%, 0%, 0%)');
});

/** A pdftocairo-like page: a big name line (with one descender glyph), a small descriptor line, a stray glyph far away. */
function glyphPage() {
  const box = (w: number, h: number, below = 0) => `<path d="M 0 ${-h} L ${w} ${-h} L ${w} ${below} L 0 ${below} Z M 0 ${-h} "/>`;
  const name = [40, 60, 80, 100, 120, 140].map((x) => `<use xlink:href="#glyph-0-1" x="${x}" y="200"/>`).join('\n');
  const desc = [40, 50, 60, 70, 80, 90, 100].map((x) => `<use xlink:href="#glyph-0-3" x="${x}" y="230"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="600" viewBox="0 0 400 600">
<defs>
<g id="glyph-0-0">
</g>
<g id="glyph-0-1">
${box(16, 40)}
</g>
<g id="glyph-0-2">
${box(16, 40, 12)}
</g>
<g id="glyph-0-3">
${box(8, 10)}
</g>
</defs>
<rect x="0" y="0" width="400" height="600" fill="rgb(20%, 20%, 20%)"/>
<g fill="rgb(100%, 100%, 100%)" fill-opacity="1">
${name}
<use xlink:href="#glyph-0-2" x="160" y="200"/>
</g>
<g fill="rgb(80%, 10%, 10%)" fill-opacity="1">
${desc}
</g>
<g fill="rgb(100%, 100%, 100%)" fill-opacity="1">
<use xlink:href="#glyph-0-1" x="300" y="560"/>
</g>
</svg>`;
}

test('cut-words --svg keeps the name glyphs (descender included), drops the descriptor line, renders a clip-clean cut from the outlines', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-cut-words-svg-'));
  try {
    const page = path.join(directory, 'page.svg');
    await writeFile(page, glyphPage());
    const out = path.join(directory, 'words.png');
    const result = await cutWordsSvg(page, out, { region: [0, 0, 400, 400], white: true, width: 800 });
    assert.equal(result.ok, true, JSON.stringify(result.lines));
    assert.equal(result.uses_total, 15);
    assert.equal(result.uses_in_region, 14, 'the stray glyph outside the region is ignored');
    assert.equal(result.kept_component_count, 7, 'six name glyphs plus the descender glyph');
    assert(result.components.filter((c) => c.decision === 'dropped:descriptor_line_below_ratio').length === 7);
    assert.equal(result.width, 800);
    assert.equal(result.clip_check.pass, true, JSON.stringify(result.clip_check));
    assert.deepEqual(result.clip_check.edge_ink, { top: 0, bottom: 0, left: 0, right: 0 });
    // the view box spans the descender: glyph bottoms at y=212 (descender) versus 200 (the rest)
    assert(result.view_box[1] + result.view_box[3] > 212, `view box reaches below the descender: ${result.view_box}`);
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    const rgbAt = (x: number, y: number) => [data[(y * info.width + x) * 4], data[(y * info.width + x) * 4 + 1], data[(y * info.width + x) * 4 + 2]];
    // the descender glyph is the right-most; its tail is in the bottom rows but not on the edge row
    const tailX = Math.round(info.width * 0.95);
    assert(alphaAt(tailX, info.height - 2) === 0 || alphaAt(tailX, info.height - 1) === 0, 'the last row is clear');
    let tailInk = 0;
    for (let y = Math.round(info.height * 0.8); y < info.height; y += 1) if (alphaAt(tailX, y) > 128) tailInk += 1;
    assert(tailInk > 0, 'the descender tail is rendered below the baseline');
    assert.deepEqual(rgbAt(Math.round(info.width * 0.1), Math.round(info.height * 0.4)), [255, 255, 255], '--white fills the glyphs white');
    const sidecarSvg = await sharp(result.svg).metadata();
    assert(sidecarSvg.width > 0, 'the vector cut is kept next to the png');
    // the original fill survives without --white
    const colored = await cutWordsSvg(page, path.join(directory, 'c.png'), { region: [0, 0, 400, 400], width: 400 });
    assert.equal(colored.ok, true);
    const c = await sharp(colored.out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mid = Math.round(c.info.height * 0.4) * c.info.width + Math.round(c.info.width * 0.1);
    assert.deepEqual([c.data[mid * 4], c.data[mid * 4 + 1], c.data[mid * 4 + 2]], [255, 255, 255]);
    // --fill restricts to one fill group: the descriptor line alone
    const red = await cutWordsSvg(page, path.join(directory, 'd.png'), { region: [0, 0, 400, 400], fill: 'rgb(80%, 10%, 10%)', width: 400 });
    assert.equal(red.ok, true);
    assert.equal(red.kept_component_count, 7);
    assert.equal((await cutWordsSvg(page, path.join(directory, 'e.png'), { region: [380, 580, 400, 600] })).ok, false, 'an empty region keeps nothing');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
