#!/usr/bin/env node
import fs from 'node:fs/promises';
import {
  contrastRatio,
  deltaE00,
  deriveDarker,
  hexToRgb,
  normalizeHex,
  rgbToHsl,
} from './colors.mjs';

async function loadSharp() {
  const mod = await import('sharp');
  return mod.default;
}

function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

function colorStats(primary, secondary) {
  const pHsl = rgbToHsl(hexToRgb(primary));
  const sHsl = rgbToHsl(hexToRgb(secondary));
  const hueDiff = hueDistance(pHsl.h, sHsl.h);
  const lightnessDiff = pHsl.l - sHsl.l;
  const derived = deriveDarker(primary);
  const derivedDelta = deltaE00(secondary, derived);
  const sameHueDarker =
    hueDiff <= 12 &&
    lightnessDiff >= 0.08 &&
    lightnessDiff <= 0.25 &&
    derivedDelta <= 12;

  let classification = 'contrasting';
  if (sameHueDarker || hueDiff <= 18) classification = 'monochrome';
  else if (hueDiff >= 105 && hueDiff <= 180) classification = 'complementary';

  return { hueDiff, sameHueDarker, classification, deltaE: deltaE00(primary, secondary), derived, derivedDelta };
}

// Edge-band legibility: only the mark's silhouette boundary needs contrast
// against the card primary. Interior fill matching the background is fine —
// a crest with a contrasting outer ring reads perfectly on a same-color card
// (Hofbräuhaus lesson). The old all-pixels version over-triggered and pushed
// agents into destructive treatments (knockouts, medallions) the human
// designers never used.
async function logoEdgeLowContrastShare(logoPath, primary, { band = 3 } = {}) {
  const sharp = await loadSharp();
  const { data, info } = await sharp(logoPath)
    .rotate()
    .resize({ width: 420, height: 420, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const opaque = (p) => data[p * 4 + 3] > 128;
  let current = new Set();
  for (let p = 0; p < w * h; p++) {
    if (!opaque(p)) continue;
    const x = p % w;
    const y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !opaque(ny * w + nx)) {
        current.add(p);
        break;
      }
    }
  }
  const bandSet = new Set(current);
  for (let i = 1; i < band; i++) {
    const next = new Set();
    for (const p of current) {
      const x = p % w;
      const y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (opaque(np) && !bandSet.has(np)) {
          bandSet.add(np);
          next.add(np);
        }
      }
    }
    current = next;
  }
  let low = 0;
  for (const p of bandSet) {
    const hex = `#${[data[p * 4], data[p * 4 + 1], data[p * 4 + 2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    if (contrastRatio(hex, primary) < 1.5) low += 1;
  }
  return bandSet.size ? low / bandSet.size : 1;
}

export async function runTasteCheck(config) {
  const primary = normalizeHex(config.primary);
  const secondary = normalizeHex(config.secondary);
  const text = normalizeHex(config.text);
  const stats = colorStats(primary, secondary);
  const textContrast = contrastRatio(text, primary);
  const pairPass = stats.deltaE >= 15 || stats.sameHueDarker;
  const checks = [
    { name: 'text_vs_primary_contrast', pass: textContrast >= 3.0, value: Number(textContrast.toFixed(3)), threshold: '>= 3.0' },
    {
      name: 'primary_vs_secondary_distinguishable',
      pass: pairPass,
      value: { deltaE00: Number(stats.deltaE.toFixed(3)), hueDiff: Number(stats.hueDiff.toFixed(1)), sameHueDarker: stats.sameHueDarker },
      threshold: 'deltaE00 >= 15 OR same-hue darker derivative',
    },
  ];

  if (config.logoPath) {
    const lowContrastShare = await logoEdgeLowContrastShare(config.logoPath, primary);
    checks.push({
      name: 'logo_edge_legibility_vs_primary',
      pass: lowContrastShare < 0.4,
      value: Number(lowContrastShare.toFixed(4)),
      threshold: '< 0.4 share of silhouette edge band below 1.5 contrast',
    });
  }

  const reasons = checks.filter((check) => !check.pass).map((check) => `${check.name} failed: ${JSON.stringify(check.value)} vs ${check.threshold}`);
  return {
    pass: checks.every((check) => check.pass),
    classification: stats.classification,
    checks,
    reasons,
  };
}

async function main() {
  const [configPath] = process.argv.slice(2);
  if (!configPath) throw new Error('Usage: node taste-check.mjs config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  console.log(JSON.stringify(await runTasteCheck(config), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
