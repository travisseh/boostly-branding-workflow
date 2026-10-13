#!/usr/bin/env node
// signage-preview.mjs: the signage row preview (POP sign, tap card, table sticker, bathroom sticker) for one
// sheet cell, as a JSON spec the review canvas and the public review site draw with the vendored template
// (templates/sheet-templates.js signagePreviewHtml). Replaces harness/mockups/_signage-shot.mjs, which
// screenshotted the Boostly app's /public/signage-preview-harness (Travisse 2026-10-13: review previews are
// no longer app screenshots).
//
//   node signage-preview.mjs --run-dir <run> --cell <letter> [--offer "<headline>"] [--bathroom "<copy>"]
//                            [--logo <png>] [--logo-light <png>] [--primary #hex] [--accent #hex] [--png] [--out <dir>]
//
// Writes <run>/review/signage-preview-<L>.json: { letter, logo, logo_light, primary, accent, offer,
// bathroom_copy, generated_at } with logo paths relative to the run dir. Defaults come from the cell:
// logo = the cell's card logo, logo_light = the row's sticker logo (on-white asset), primary = the cell
// primary, accent = the cell secondary, offer = the sheet offer. --png also renders the row once in memory
// (scripts/render-preview.mjs) to review/signage-preview-<L>.png, the file the AI mockup script crops its
// to-go reference from; nothing else needs the raster.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relRun } from './variant-sheet.mjs';

const BOOL = new Set(['png']);
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOL.has(flag)) { args[flag] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[flag] = value;
    i += 1;
  }
  if (args.run && !args.runDir) args.runDir = args.run;
  if (!args.runDir || !args.cell) throw new Error('usage: signage-preview.mjs --run-dir <run> --cell <letter> [--offer ...] [--bathroom ...] [--png]');
  return args;
}
function hex(value, flag) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!m) throw new Error(`${flag} must be a 6-digit hex (got "${value}")`);
  return `#${m[1].toUpperCase()}`;
}

/** Pure: the spec for a cell of the sheet manifest, with overrides. Logo paths are run-dir-relative. */
export function signageSpecFor(manifest, letter, { logo = null, logoLight = null, primary = null, accent = null, offer = null, bathroom = null } = {}) {
  const cell = manifest.cells?.[letter];
  if (!cell) throw new Error(`cell ${letter} is not on the sheet (${Object.keys(manifest.cells ?? {}).join(', ')})`);
  const row = (manifest.rows ?? []).find((r) => r.key === cell.row) ?? {};
  const runDir = manifest.run_dir;
  const rel = (p) => relRun(runDir, p);
  const cardLogo = logo ?? row.logo ?? cell.logo;
  const lightLogo = logoLight ?? row.sticker_logo_used ?? row.sticker_logo ?? manifest.sticker_logo ?? cardLogo;
  return {
    schema: 1,
    letter,
    logo: rel(cardLogo),
    logo_light: rel(lightLogo),
    primary: hex(primary ?? cell.primary ?? manifest.primary, 'primary'),
    accent: hex(accent ?? cell.secondary, 'accent'),
    offer: offer ?? manifest.offer ?? 'Join the club!',
    bathroom_copy: bathroom ? bathroom.replace(/\\n/g, '\n') : null,
    source: 'templates/sheet-templates.js signagePreviewHtml (vendored from the onboarding SignagePreviews)',
    generated_at: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.runDir);
  const letter = args.cell.toUpperCase();
  const manifestFile = path.join(runDir, 'variants', 'variant-sheet.json');
  if (!existsSync(manifestFile)) throw new Error(`no variants/variant-sheet.json in ${runDir}`);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.run_dir = manifest.run_dir ?? runDir;
  const spec = signageSpecFor(manifest, letter, { logo: args.logo ? path.resolve(args.logo) : null, logoLight: args.logoLight ? path.resolve(args.logoLight) : null, primary: args.primary ?? null, accent: args.accent ?? null, offer: args.offer ?? null, bathroom: args.bathroom ?? null });
  for (const key of ['logo', 'logo_light']) {
    if (spec[key] && !existsSync(path.join(runDir, spec[key]))) throw new Error(`${key} not found: ${path.join(runDir, spec[key])}`);
  }
  const outDir = path.resolve(args.out ?? path.join(runDir, 'review'));
  await fs.mkdir(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `signage-preview-${letter}.json`);
  await fs.writeFile(jsonFile, `${JSON.stringify(spec, null, 2)}\n`);
  let pngFile = null;
  if (args.png) {
    const { renderSignagePng } = await import('./render-preview.mjs');
    const src = (rel) => path.relative(outDir, path.join(runDir, rel)).split(path.sep).map(encodeURIComponent).join('/');
    const png = await renderSignagePng(spec, { baseDir: outDir, src });
    pngFile = path.join(outDir, `signage-preview-${letter}.png`);
    await fs.writeFile(pngFile, png);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, cell: letter, json: jsonFile, png: pngFile, spec }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
