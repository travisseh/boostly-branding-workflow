#!/usr/bin/env node
// imagegen-knockout.mjs: the "imagegen-knockout" candidate that sits NEXT TO
// the deterministic knockout at candidate prep (never instead of it).
//
// Eligibility (all required, measured here, from experiments/imagegen-2.5/REPORT.md):
//   first-party source (--provenance first_party*), flat ink on a solid or
//   transparent ground, longest side >= 800px, not a photo, not textured, not
//   a tiny emblem with fine internal detail.
// Then: one gpt-image-2.5-sunburst call at quality high, 1536x1024,
// transparent background (about 26 s, about USD 0.05), alpha snap at 128
// (2.5 never returns alpha 255), RGB forced white for knockouts, zero RGB under
// alpha 0, 2% tight crop, and the gate battery: ship-gate, border-dust,
// png-color-type, render-legibility, text-legibility, plus source-overlay
// (IoU >= 0.75 and component count within 10%) against the deterministic
// knockout. The candidate is written with provenance imagegen_sunburst and
// must never be applied when source-overlay fails.
//
// Usage:
//   node scripts/imagegen-knockout.mjs --source <first-party.png> \
//     --reference <deterministic-knockout.png> --out-dir <run>/candidates \
//     --expected "<Business Name>" [--primary #hex] [--mode knockout|words-only] \
//     [--remove "the tagline 'A Sweet Celebration!'"] [--provenance first_party_header] \
//     [--name imagegen-knockout] [--dry-run] [--skip-eligibility]
//
// Exit codes: 0 candidate ready and every gate passed; 2 ineligible or a gate
// failed (candidate kept on disk, labeled); 1 error.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Image harness lives inside this skill (boostly-brand-design/harness) so the skill is self-contained.
const HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', 'harness');
const require = createRequire(path.join(HARNESS_DIR, 'package.json'));
const sharp = require('sharp');
const GENERATOR = `${process.env.HOME}/.claude/skills/image-generator/generate-image.ts`;
const HARNESS = path.join(HARNESS_DIR, 'iterate-logo-rules.mjs');
const GATES = path.join(SCRIPT_DIR, 'logo-quality-gates.ts');

export const IMAGEGEN_MODEL = 'gpt-image-2.5-sunburst-2026-09-08';
export const IMAGEGEN_SIZE = '1536x1024';
export const IMAGEGEN_QUALITY = 'high';
export const IMAGEGEN_EST_USD = 0.05;
export const ELIGIBILITY = {
  minLongestSide: 800,
  maxDistinctColorShare: 0.08, // share of INTERIOR ink pixels outside the top 6 coarse (3-bit) color buckets: photo/gradient
  maxTextureEnergy: 0.12, // share of ink pixels whose 3x3 neighborhood is not uniform (distressed/textured)
  minLargestComponentShare: 0.05, // a tiny emblem made of many fine pieces has no dominant component
};

function parseArgs(argv) {
  const args = { mode: 'knockout', name: 'imagegen-knockout', provenance: 'first_party_other', primary: '#990000' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flag === 'dryRun' || flag === 'skipEligibility') {
      args[flag] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[flag] = value;
    i += 1;
  }
  for (const required of ['source', 'reference', 'outDir', 'expected']) {
    if (!args[required]) throw new Error('Usage: imagegen-knockout.mjs --source <png> --reference <deterministic-knockout.png> --out-dir <dir> --expected <name> [options]');
  }
  if (!['knockout', 'words-only'].includes(args.mode)) throw new Error('--mode must be knockout or words-only');
  return args;
}

export function buildPrompt({ mode, remove, expected }) {
  if (mode === 'words-only') {
    return [
      `From this logo, extract ONLY the wordmark text "${expected}" as a separate clean asset on a fully transparent background,`,
      'rendered as a single-color white knockout: every inked letter becomes pure white #FFFFFF, the background becomes fully transparent alpha.',
      'Remove every other element entirely (emblems, rings, illustrations, taglines, "EST." or "since" lines, phone numbers, city names) and leave empty space where they were.',
      'Keep the exact typefaces, letterforms, spacing and proportions of the remaining words. Do not add, restyle, or re-kern anything.',
      'Keep all enclosed counters open. No shadow, outline, glow, or extra elements.',
    ].join('\n');
  }
  return [
    'Reproduce this logo EXACTLY as a single-color white knockout on a fully transparent background:',
    'every inked shape becomes pure white #FFFFFF, the background becomes fully transparent alpha.',
    remove ? `REMOVE ${remove} entirely and leave empty space where it was.` : null,
    'Do not redraw, restyle, re-kern, or change any letterform, stroke, or proportion.',
    'Keep all enclosed counters open. No shadow, outline, glow, or extra elements.',
  ].filter(Boolean).join('\n');
}

// ---- eligibility -------------------------------------------------------------
export async function assessEligibility(sourceFile, provenance) {
  const reasons = [];
  const image = sharp(sourceFile, { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (!/^first_party/.test(provenance) && provenance !== 'human_supplied') reasons.push(`provenance_not_first_party:${provenance}`);
  if (longest < ELIGIBILITY.minLongestSide) reasons.push(`source_below_${ELIGIBILITY.minLongestSide}px:${longest}`);

  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // Ink mask: alpha when the file has transparency, else distance from the median border color.
  let transparent = 0;
  for (let p = 3; p < data.length; p += 4) if (data[p] < 250) transparent += 1;
  const hasAlpha = transparent / (width * height) >= 0.001;
  const ink = new Uint8Array(width * height);
  let border = null;
  if (!hasAlpha) {
    const samples = [];
    for (let x = 0; x < width; x += 1) samples.push(x, (height - 1) * width + x);
    for (let y = 1; y < height - 1; y += 1) samples.push(y * width, y * width + width - 1);
    const channel = (k) => samples.map((p) => data[p * 4 + k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    border = [channel(0), channel(1), channel(2)];
  }
  let inkCount = 0;
  for (let p = 0; p < width * height; p += 1) {
    const o = p * 4;
    let isInk;
    if (hasAlpha) isInk = data[o + 3] >= 128;
    else isInk = Math.hypot(data[o] - border[0], data[o + 1] - border[1], data[o + 2] - border[2]) >= 24;
    if (!isInk) continue;
    ink[p] = 1;
    inkCount += 1;
  }
  if (!inkCount) reasons.push('no_detectable_ink');

  // Flat-ink and texture measures on INTERIOR ink only (3x3 neighborhood all
  // ink), so antialiased edges do not count as extra colors. A photo or a
  // gradient spreads interior pixels across many color buckets; a distressed
  // mark has few interior pixels relative to its ink.
  const buckets = new Map();
  let interior = 0;
  let mixed = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      if (!ink[p]) continue;
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += ink[p + dy * width + dx];
      if (sum < 9) {
        if (sum <= 6) mixed += 1;
        continue;
      }
      interior += 1;
      const o = p * 4;
      const key = ((data[o] >> 5) << 6) | ((data[o + 1] >> 5) << 3) | (data[o + 2] >> 5);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }
  const top = [...buckets.values()].sort((a, b) => b - a);
  const outsideTop = top.slice(6).reduce((sum, v) => sum + v, 0) / Math.max(1, interior);
  if (outsideTop > ELIGIBILITY.maxDistinctColorShare) reasons.push(`not_flat_ink_or_photo:${outsideTop.toFixed(3)}_of_interior_ink_outside_top6_colors`);
  // Expected edge share for a flat mark scales with perimeter/area; measure at a
  // fixed 800px-equivalent so big and small sources compare alike.
  const scale = 800 / Math.max(width, height);
  const textureEnergy = (mixed / Math.max(1, inkCount)) / Math.max(0.25, Math.min(1, scale === 1 ? 1 : 1 / scale));
  if (textureEnergy > ELIGIBILITY.maxTextureEnergy) reasons.push(`textured_or_distressed_mark:${textureEnergy.toFixed(3)}`);

  // Largest component share: tiny emblems made of fine pieces have none dominant.
  const labels = new Int32Array(width * height);
  let largest = 0;
  let next = 0;
  const stack = [];
  for (let start = 0; start < width * height; start += 1) {
    if (!ink[start] || labels[start]) continue;
    next += 1;
    let area = 0;
    stack.push(start);
    labels[start] = next;
    while (stack.length) {
      const p = stack.pop();
      area += 1;
      const x = p % width;
      const y = (p / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (ink[q] && !labels[q]) {
          labels[q] = next;
          stack.push(q);
        }
      }
    }
    if (area > largest) largest = area;
  }
  const largestShare = largest / Math.max(1, inkCount);
  if (largestShare < ELIGIBILITY.minLargestComponentShare) reasons.push(`fine_emblem_no_dominant_component:${largestShare.toFixed(3)}`);

  return {
    eligible: reasons.length === 0,
    reasons,
    measured: {
      width, height, longest, has_alpha: hasAlpha, provenance,
      interior_ink_share_outside_top6_colors: Number(outsideTop.toFixed(4)),
      texture_energy: Number(textureEnergy.toFixed(4)),
      largest_component_share: Number(largestShare.toFixed(4)),
      component_count: next,
    },
    thresholds: ELIGIBILITY,
  };
}

// ---- normalize (alpha snap, white ink, tight crop) ---------------------------
export async function normalizeKnockout(inFile, outFile, { white = true, pad = 0.02 } = {}) {
  const { data, info } = await sharp(inFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let mid = 0;
  for (let p = 0; p < width * height; p += 1) {
    const o = p * 4;
    const a = data[o + 3];
    if (a > 10 && a < 245) mid += 1;
    const on = a >= 128;
    data[o + 3] = on ? 255 : 0;
    if (on) {
      if (white) {
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
      }
      const x = p % width;
      const y = (p / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
  }
  if (maxX < 0) throw new Error('imagegen output has no ink after alpha snap');
  const padPx = Math.round(pad * Math.max(maxX - minX + 1, maxY - minY + 1));
  const left = Math.max(0, minX - padPx);
  const top = Math.max(0, minY - padPx);
  const cropW = Math.min(width, maxX + 1 + padPx) - left;
  const cropH = Math.min(height, maxY + 1 + padPx) - top;
  await sharp(data, { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: cropW, height: cropH })
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: true, effort: 10 })
    .toFile(outFile);
  const bytes = (await fs.stat(outFile)).size;
  return { out: outFile, width: cropW, height: cropH, bytes, mid_alpha_share_before_snap: Number((mid / (width * height)).toFixed(4)) };
}

// ---- gates -----------------------------------------------------------------
function runJson(cmd, argv) {
  const result = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let parsed = null;
  const text = (result.stdout || '').trim();
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      parsed = JSON.parse(text.slice(start));
    } catch {
      parsed = null;
    }
  }
  return { status: result.status, json: parsed, stderr: (result.stderr || '').split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join('\n').trim() };
}

export function runGateBattery({ candidate, reference, expected, primary, overlayOut }) {
  const gates = {};
  gates['ship-gate'] = runJson('node', [HARNESS, 'ship-gate', candidate]);
  gates['border-dust'] = runJson('node', [HARNESS, 'border-dust', candidate]);
  gates['png-color-type'] = runJson('node', ['--experimental-strip-types', GATES, 'png-color-type', '--logo', candidate]);
  gates['render-legibility'] = runJson('node', ['--experimental-strip-types', GATES, 'render-legibility', '--logo', candidate, '--background', primary]);
  gates['text-legibility'] = runJson('node', ['--experimental-strip-types', GATES, 'text-legibility', '--logo', candidate, '--expected', expected, '--background', primary]);
  gates['source-overlay'] = runJson('node', ['--experimental-strip-types', GATES, 'source-overlay', '--candidate', candidate, '--reference', reference, '--overlay-out', overlayOut]);
  const summary = {};
  for (const [name, r] of Object.entries(gates)) {
    summary[name] = {
      pass: r.status === 0 || (name === 'render-legibility' && r.json?.pass === true),
      exit_code: r.status,
      verdict: r.json?.verdict ?? null,
      detail: r.json ?? r.stderr,
    };
  }
  return summary;
}

// ---- main -------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(args.source);
  const reference = path.resolve(args.reference);
  const outDir = path.resolve(args.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const receipt = {
    generated_at: new Date().toISOString(),
    source,
    reference,
    mode: args.mode,
    provenance_source: args.provenance,
    provenance: 'imagegen_sunburst',
    model: IMAGEGEN_MODEL,
    size: IMAGEGEN_SIZE,
    quality: IMAGEGEN_QUALITY,
    estimated_usd: IMAGEGEN_EST_USD,
    prompt: buildPrompt({ mode: args.mode, remove: args.remove, expected: args.expected }),
    rule: 'Never applied without source-overlay pass; Fable picks between this and the deterministic candidate; deterministic wins ties.',
  };
  const receiptFile = path.join(outDir, `${args.name}.receipt.json`);
  const finish = async (code, extra) => {
    Object.assign(receipt, extra);
    await fs.writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...receipt, prompt: undefined }, null, 2)}\n`);
    process.exit(code);
  };

  if (!args.skipEligibility) {
    const eligibility = await assessEligibility(source, args.provenance);
    receipt.eligibility = eligibility;
    if (!eligibility.eligible) await finish(2, { status: 'ineligible', reasons: eligibility.reasons });
  }
  if (args.dryRun) await finish(0, { status: 'dry_run', command: generatorCommand(args, receipt.prompt, outDir) });

  const rawFile = path.join(outDir, `${args.name}.raw.png`);
  const gen = spawnSync('npx', ['tsx', GENERATOR, receipt.prompt,
    '--provider', 'openai', '--model', IMAGEGEN_MODEL, '--ref', source,
    '--size', IMAGEGEN_SIZE, '--quality', IMAGEGEN_QUALITY, '--background', 'transparent',
    '--out', outDir, '--name', `${args.name}.raw`], {
    cwd: path.dirname(GENERATOR), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const genLog = `${gen.stdout || ''}\n${gen.stderr || ''}`;
  await fs.writeFile(path.join(outDir, `${args.name}.generate.log`), genLog);
  const usage = /usage[^{]*(\{[\s\S]*?\})/i.exec(genLog);
  receipt.generator = { exit_code: gen.status, elapsed: /Elapsed:\s*([\d.]+)/.exec(genLog)?.[1] ?? null, usage: usage ? usage[1].slice(0, 400) : null };
  if (gen.status !== 0 || !existsSync(rawFile)) {
    await finish(1, { status: 'generation_failed', error: genLog.slice(-800) });
  }

  const candidate = path.join(outDir, `${args.name}.png`);
  receipt.normalize = await normalizeKnockout(rawFile, candidate, { white: true });
  receipt.candidate = candidate;
  receipt.gates = runGateBattery({
    candidate, reference, expected: args.expected, primary: args.primary,
    overlayOut: path.join(outDir, `${args.name}.overlay.png`),
  });
  const failed = Object.entries(receipt.gates).filter(([, g]) => !g.pass).map(([name]) => name);
  await finish(failed.length ? 2 : 0, {
    status: failed.length ? 'gates_failed' : 'candidate_ready',
    failed_gates: failed,
    overlay_pass: receipt.gates['source-overlay'].pass,
  });
}

function generatorCommand(args, prompt, outDir) {
  return `cd ${path.dirname(GENERATOR)} && npx tsx generate-image.ts ${JSON.stringify(prompt)} --provider openai --model ${IMAGEGEN_MODEL} --ref ${path.resolve(args.source)} --size ${IMAGEGEN_SIZE} --quality ${IMAGEGEN_QUALITY} --background transparent --out ${outDir} --name ${args.name}.raw`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
