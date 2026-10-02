import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { cutWords, labelComponents } from './cut-words.mjs';

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
