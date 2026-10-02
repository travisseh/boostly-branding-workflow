#!/usr/bin/env node
// Compress a final PNG upload through the TinyPNG API when it exceeds the byte
// threshold, then restore truecolor encoding and verify dimensions/alpha are
// unchanged. Never prints the API key.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

const DEFAULT_ENV_FILE = `${process.env.HOME}/.config/boostly-branding/.env`;
const DEFAULT_THRESHOLD = 70_000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadKey(envFile) {
  if (process.env.TINYPNG_API_KEY) return process.env.TINYPNG_API_KEY;
  if (!existsSync(envFile)) throw new Error(`env file not found: ${envFile}`);
  const line = readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('TINYPNG_API_KEY='));
  if (!line) throw new Error(`TINYPNG_API_KEY not found in ${envFile}`);
  return line.slice('TINYPNG_API_KEY='.length).trim().replace(/^"|"$/g, '');
}

async function stats(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparentPixels = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) transparentPixels += 1;
  const colorType = buffer[24] !== undefined && buffer.subarray(12, 16).toString('ascii') === 'IHDR' ? buffer[25] : null;
  return { width: meta.width, height: meta.height, bytes: buffer.length, transparentPixels, totalPixels: info.width * info.height, colorType };
}

const input = arg('in');
const output = arg('out');
const threshold = Number(arg('threshold', DEFAULT_THRESHOLD));
const envFile = arg('env-file', DEFAULT_ENV_FILE);
if (!input || !output) {
  console.error('usage: tinypng-compress.mjs --in <png> --out <png> [--threshold 70000] [--env-file <path>]');
  process.exit(1);
}

const source = readFileSync(input);
const before = await stats(source);

if (before.bytes <= threshold) {
  console.log(JSON.stringify({ pass: true, action: 'skipped_under_threshold', bytes: before.bytes, threshold }, null, 2));
  process.exit(0);
}

const key = loadKey(envFile);
const auth = 'Basic ' + Buffer.from(`api:${key}`).toString('base64');
const shrink = await fetch('https://api.tinify.com/shrink', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' },
  body: source,
});
if (!shrink.ok) {
  console.error(`TinyPNG shrink failed: HTTP ${shrink.status}`);
  process.exit(2);
}
const shrinkResult = await shrink.json();
const download = await fetch(shrinkResult.output.url, { headers: { Authorization: auth } });
if (!download.ok) {
  console.error(`TinyPNG download failed: HTTP ${download.status}`);
  process.exit(2);
}
let compressed = Buffer.from(await download.arrayBuffer());

// TinyPNG usually emits indexed PNG (color type 3); React-PDF corrupts indexed
// transparency, so re-encode to max-effort truecolor. The quantized pixels keep
// most of the size win even after the truecolor re-encode.
let after = await stats(compressed);
if (after.colorType === 3) {
  compressed = await sharp(compressed)
    .ensureAlpha()
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: true, effort: 10 })
    .toBuffer();
  after = await stats(compressed);
}

const failures = [];
if (after.width !== before.width || after.height !== before.height) failures.push('dimensions_changed');
if (before.transparentPixels > 0 && after.transparentPixels === 0) failures.push('transparency_lost');
if (after.colorType !== 2 && after.colorType !== 6) failures.push('not_truecolor');
if (after.bytes >= before.bytes) failures.push('no_size_gain');

const summary = {
  pass: failures.length === 0,
  action: 'compressed',
  failures,
  before: { bytes: before.bytes, width: before.width, height: before.height, transparentPixels: before.transparentPixels },
  after: { bytes: after.bytes, width: after.width, height: after.height, transparentPixels: after.transparentPixels, colorType: after.colorType },
  savingsPct: Number((100 * (1 - after.bytes / before.bytes)).toFixed(1)),
};

if (summary.pass) writeFileSync(output, compressed);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.pass ? 0 : 3);
