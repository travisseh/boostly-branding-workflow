import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { assessLogoCrop, cropLogoCanvas } from './logo-crop.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

test('crops a Leo-like uniform colored canvas to the emblem', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-logo-crop-color-'));
  try {
    const source = path.join(directory, 'source.jpg');
    const output = path.join(directory, 'output.png');
    await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#31499b' } })
      .composite([{ input: Buffer.from('<svg width="800" height="800"><circle cx="400" cy="400" r="390" fill="#fff"/><circle cx="400" cy="400" r="340" fill="#ffe900"/></svg>'), left: 100, top: 100 }])
      .jpeg({ quality: 92 })
      .toFile(source);

    const before = await assessLogoCrop(source);
    assert.equal(before.pass, false);
    assert.equal(before.verdict, 'excess_canvas_padding');

    const cropped = await cropLogoCanvas(source, output);
    assert.equal(cropped.assessment.pass, true);
    assert.ok(cropped.crop.width < 900);
    assert.ok(cropped.crop.height < 900);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('crops a Southlands-like white canvas without changing the mark pixels', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-logo-crop-white-'));
  try {
    const source = path.join(directory, 'source.png');
    const output = path.join(directory, 'output.png');
    await sharp({ create: { width: 800, height: 1200, channels: 4, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="500" height="1000"><path d="M20 80 H480 V920 H20 Z" fill="#d4845f"/><circle cx="250" cy="500" r="160" fill="#f7c75b"/></svg>'), left: 150, top: 100 }])
      .png()
      .toFile(source);

    const before = await assessLogoCrop(source);
    assert.equal(before.pass, false);
    const cropped = await cropLogoCanvas(source, output);
    assert.equal(cropped.assessment.pass, true);
    assert.ok(cropped.crop.width < 560);
    assert.ok(cropped.crop.height < 1060);

    const sourceRegion = await sharp(source).extract({
      left: cropped.crop.left,
      top: cropped.crop.top,
      width: cropped.crop.width,
      height: cropped.crop.height,
    }).ensureAlpha().raw().toBuffer();
    const outputPixels = await sharp(output).ensureAlpha().raw().toBuffer();
    assert.deepEqual(outputPixels, sourceRegion);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not guess a crop when the canvas border is not uniform', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-logo-crop-ambiguous-'));
  try {
    const source = path.join(directory, 'source.png');
    const output = path.join(directory, 'output.png');
    await sharp(Buffer.from('<svg width="400" height="200"><rect width="200" height="200" fill="#d90429"/><rect x="200" width="200" height="200" fill="#161616"/></svg>'))
      .png()
      .toFile(source);

    const assessment = await assessLogoCrop(source);
    assert.equal(assessment.pass, false);
    assert.equal(assessment.verdict, 'crop_unassessed_nonuniform_border');
    await assert.rejects(() => cropLogoCanvas(source, output), /No uniform removable canvas/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('detects transparent side gutters when the mark touches the top and bottom', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-logo-crop-alpha-axis-'));
  try {
    const source = path.join(directory, 'source.png');
    await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="#161616"/></svg>'), left: 100, top: 0 }])
      .png()
      .toFile(source);

    const assessment = await assessLogoCrop(source);
    assert.equal(assessment.pass, false);
    assert.equal(assessment.background_mode, 'transparent');
    assert.equal(assessment.padding_px?.left, 100);
    assert.equal(assessment.padding_px?.right, 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves a subtle authored keyline against a white JPEG canvas', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-logo-crop-keyline-'));
  try {
    const source = path.join(directory, 'source.jpg');
    const output = path.join(directory, 'output.png');
    await sharp({ create: { width: 500, height: 300, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="300" height="180"><rect x="2" y="2" width="296" height="176" rx="20" fill="#161616" stroke="#eeeeee" stroke-width="4"/></svg>'), left: 100, top: 60 }])
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toFile(source);

    const before = await assessLogoCrop(source);
    assert.equal(before.pass, false);
    assert.ok((before.content_bounds?.left ?? 999) <= 101);
    const cropped = await cropLogoCanvas(source, output);
    assert.equal(cropped.assessment.pass, true);
    assert.ok(cropped.crop.left <= 99);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compares the raw ratio at the exact padding threshold', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-logo-crop-boundary-'));
  try {
    const source = path.join(directory, 'source.png');
    await sharp({ create: { width: 1999, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="1939" height="100"><rect width="1939" height="100" fill="#161616"/></svg>'), left: 30, top: 0 }])
      .png()
      .toFile(source);

    const assessment = await assessLogoCrop(source);
    assert.equal(assessment.padding_ratio?.left, 0.015);
    assert.equal(assessment.pass, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid numeric CLI options exit as usage errors', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', path.resolve(import.meta.dirname, 'logo-crop.ts'), '--logo', 'missing.png', '--max-padding-ratio', 'nope'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--max-padding-ratio must be a finite number/);
});
