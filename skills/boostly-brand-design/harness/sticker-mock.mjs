#!/usr/bin/env node
// Render a deterministic mock of the Figma table-sticker form factor (product2
// plugin output): primary-color diagonal band with white copy up top, white
// lower area with the on-white logo left and a primary-color QR right.
// The QR is a seeded pseudo-matrix (finder squares + LCG fill), NOT a real
// code — it exists to prove color/contrast/composition, and the JSON output
// says so. Real QRs come from the Figma plugin / product print path.
//
// Usage:
//   node harness/sticker-mock.mjs --logo <png> --primary <hex> --out <png> \
//     [--headline "Join the club!"] [--body "Be the first to know.|Receive exclusive deals."]
//
// Exit codes: 0 ok; 2 usage/load error; 3 contrast gate fail
// (primary vs white < 3.0 means the band copy and a primary-ink QR are at
// risk on the white sticker — surface to the reviewer, never self-waive).
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = {
    headline: 'Join the club!',
    body: 'Be the first to know.|Receive exclusive deals.',
    size: '720',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    i += 1;
    args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const required of ['logo', 'primary', 'out']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(args.primary)) throw new Error('--primary must be a 6-digit hex like #8D0000');
  return args;
}

function relativeLuminance(hex) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrastRatio(hexA, hexB) {
  const [hi, lo] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// Deterministic 25x25 pseudo-QR: real finder patterns, LCG-filled body.
function mockQrSvg(color, seed) {
  const N = 25;
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const inFinder = (x, y) =>
    (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
  const cells = [];
  const finderAt = (fx, fy) => {
    for (let y = 0; y < 7; y += 1)
      for (let x = 0; x < 7; x += 1) {
        const ring = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (ring || core) cells.push([fx + x, fy + y]);
      }
  };
  finderAt(0, 0);
  finderAt(N - 7, 0);
  finderAt(0, N - 7);
  for (let y = 0; y < N; y += 1)
    for (let x = 0; x < N; x += 1) {
      if (inFinder(x, y)) continue;
      if (next() < 0.45) cells.push([x, y]);
    }
  const rects = cells
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="1.05" height="1.05" rx="0.32"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" fill="${color}">${rects}</svg>`;
}

function seedFrom(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const size = Number(args.size);
  const logoBuffer = await fs.readFile(path.resolve(args.logo));
  const ext = path.extname(args.logo).toLowerCase();
  const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const logoUri = `data:${mime};base64,${logoBuffer.toString('base64')}`;
  const qrSvg = mockQrSvg(args.primary, seedFrom(path.basename(args.logo) + args.primary));
  const qrUri = `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}`;
  const bodyLines = args.body
    .split('|')
    .map((line) => `<div>${line}</div>`)
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${size}px; height: ${size}px; background: #ffffff; overflow: hidden;
      font-family: 'Helvetica Neue', Arial, sans-serif; position: relative; }
    .band { position: absolute; inset: 0; background: ${args.primary};
      clip-path: polygon(0 0, 100% 0, 100% 47%, 0 59%); }
    .copy { position: absolute; left: ${size * 0.09}px; right: ${size * 0.09}px; top: ${size * 0.075}px; color: #ffffff; }
    .headline { font-size: ${size * 0.082}px; font-weight: 500; letter-spacing: -0.01em; }
    .body { margin-top: ${size * 0.135}px; font-size: ${size * 0.047}px; font-weight: 400; line-height: 1.45; }
    .lower { position: absolute; left: ${size * 0.09}px; right: ${size * 0.09}px;
      top: ${size * 0.6}px; bottom: ${size * 0.07}px; display: flex; align-items: center; }
    .logo-box { flex: 1 1 0; height: 100%; display: flex; align-items: center; justify-content: center;
      padding-right: ${size * 0.045}px; }
    .logo-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .divider { width: 2px; align-self: stretch; background: ${args.primary}; }
    .qr-box { flex: 1 1 0; height: 100%; display: flex; align-items: center; justify-content: center;
      padding-left: ${size * 0.045}px; }
    .qr-box img { width: ${size * 0.36}px; height: ${size * 0.36}px; }
  </style></head><body>
    <div class="band"></div>
    <div class="copy"><div class="headline">${args.headline}</div><div class="body">${bodyLines}</div></div>
    <div class="lower">
      <div class="logo-box"><img id="logo" src="${logoUri}"></div>
      <div class="divider"></div>
      <div class="qr-box"><img src="${qrUri}"></div>
    </div>
  </body></html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const logoOk = await page.evaluate(() => {
      const img = document.getElementById('logo');
      return img.complete && img.naturalWidth > 0;
    });
    if (!logoOk) {
      console.error('logo failed to load');
      process.exit(2);
    }
    await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await page.screenshot({ path: path.resolve(args.out) });
  } finally {
    await browser.close();
  }

  const contrast = contrastRatio(args.primary, '#FFFFFF');
  const pass = contrast >= 3.0;
  console.log(
    JSON.stringify(
      {
        out: path.resolve(args.out),
        primary: args.primary,
        contrast_primary_vs_white: Number(contrast.toFixed(2)),
        contrast_floor: 3.0,
        contrast_pass: pass,
        mock_qr: true,
        note: 'QR is a seeded mock for color/composition proof only; production QR comes from the product print path.',
      },
      null,
      2,
    ),
  );
  if (!pass) process.exit(3);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
