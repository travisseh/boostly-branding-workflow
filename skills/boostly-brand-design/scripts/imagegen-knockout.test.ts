import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { assessEligibility, buildPrompt, normalizeKnockout } from './imagegen-knockout.mjs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

test('eligibility admits a flat first-party mark at 800px and refuses small, non-first-party, and noisy sources', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-imagegen-eligibility-'));
  try {
    const flat = path.join(directory, 'flat.png');
    const small = path.join(directory, 'small.png');
    const noisy = path.join(directory, 'noisy.png');
    const svg = (w: number, h: number) => Buffer.from(`
      <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#FFFFFF"/>
        <text x="${w / 2}" y="${h * 0.65}" text-anchor="middle" font-family="Arial" font-size="${h * 0.5}" font-weight="700" fill="#8E5DA6">DENISE</text>
      </svg>
    `);
    await sharp(svg(1200, 500)).png().toFile(flat);
    await sharp(svg(400, 160)).png().toFile(small);
    // Photo-like: random RGB noise across the whole ink area.
    const w = 900;
    const h = 400;
    const raw = Buffer.alloc(w * h * 3);
    let seed = 7;
    for (let i = 0; i < raw.length; i += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      raw[i] = seed >>> 24;
    }
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(noisy);

    const ok = await assessEligibility(flat, 'first_party_header');
    assert.equal(ok.eligible, true, JSON.stringify(ok));
    const tooSmall = await assessEligibility(small, 'first_party_header');
    assert.equal(tooSmall.eligible, false);
    assert(tooSmall.reasons.some((r: string) => r.startsWith('source_below_800px')));
    const thirdParty = await assessEligibility(flat, 'aggregator_listing');
    assert(thirdParty.reasons.some((r: string) => r.startsWith('provenance_not_first_party')));
    const photo = await assessEligibility(noisy, 'first_party_other');
    assert.equal(photo.eligible, false);
    assert(photo.reasons.some((r: string) => r.startsWith('not_flat_ink_or_photo') || r.startsWith('textured')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normalize snaps 2.5-style alpha to binary, forces white ink, and tight-crops', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-imagegen-normalize-'));
  try {
    const w = 400;
    const h = 200;
    const raw = Buffer.alloc(w * h * 4, 0);
    for (let y = 60; y < 140; y += 1) for (let x = 100; x < 300; x += 1) {
      const o = (y * w + x) * 4;
      raw[o] = 253; raw[o + 1] = 254; raw[o + 2] = 253; raw[o + 3] = 254; // never 255, like the model
    }
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (raw[o + 3] === 0) raw[o + 3] = 2; // transparent field sits at alpha 0..2
    }
    const input = path.join(directory, 'raw.png');
    const output = path.join(directory, 'norm.png');
    await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(input);
    const result = await normalizeKnockout(input, output);
    assert.equal(result.width, 208); // 200 ink + 2% of 200 pad per side
    assert.equal(result.height, 88);
    const { data } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphas = new Set<number>();
    for (let i = 3; i < data.length; i += 4) alphas.add(data[i]);
    assert.deepEqual([...alphas].sort(), [0, 255]);
    let inkWhite = true;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255 && (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)) inkWhite = false;
    assert.equal(inkWhite, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prompt templates match the report and carry the remove clause only when asked', () => {
  const plain = buildPrompt({ mode: 'knockout', expected: 'Denise\'s Delicacies' });
  assert(plain.startsWith('Reproduce this logo EXACTLY as a single-color white knockout'));
  assert(!plain.includes('REMOVE'));
  const removed = buildPrompt({ mode: 'knockout', remove: 'the tagline "A Sweet Celebration!"', expected: 'x' });
  assert(removed.includes('REMOVE the tagline "A Sweet Celebration!" entirely'));
  const words = buildPrompt({ mode: 'words-only', expected: 'Astoria Pizza Factory' });
  assert(words.includes('extract ONLY the wordmark text "Astoria Pizza Factory"'));
});
