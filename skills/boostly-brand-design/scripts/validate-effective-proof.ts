#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  extractEffectiveBranding,
  extractLocationId,
  requireCompletePreviewColors,
  resolvePreviewColors,
} from './render-effective-proof.ts';

type JsonObject = Record<string, unknown>;
const require = createRequire(import.meta.url);
// sharp comes from the skill harness (boostly-brand-design/harness) first; the Codex runtime copy is the fallback.
const harnessRequire = createRequire(new URL('../harness/package.json', import.meta.url));
function loadSharp(): any {
  try { return harnessRequire('sharp'); } catch { return require('/Users/travisse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'); }
}
const sharp = loadSharp();
const PROOF_CSS_SIZE = { width: 386, height: 600 } as const;
const LOGO_REGION_CSS = { left: 80.5, top: 92.86, width: 225, height: 100 } as const;
const MIN_LOGO_INK_SHARE = 0.0025;

export type ProofLogoRegionResult = {
  pass: boolean;
  verdict: 'ok' | 'proof_missing_logo';
  non_background_ink_share: number;
  non_background_pixels: number;
  region: { left: number; top: number; width: number; height: number };
};

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[key.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
    index += 1;
  }
  return args;
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function sha256Url(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Effective production logo returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Effective production logo returned non-image content type ${contentType}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new Error('Effective production logo download size is invalid');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function planWritesLogo(plan: JsonObject): boolean {
  const writes = Array.isArray(plan.writes) ? plan.writes : [];
  return writes.some((value) => {
    const write = asObject(value);
    if (write.kind !== 'branding') return false;
    const payload = asObject(write.payload);
    return ['logo_file', 'logo_path', 'logo_attachment_file', 'logo_attachment_id']
      .some((key) => stringValue(payload[key]) !== null);
  });
}

export async function assessProofLogoRegion(proofPath: string, primaryColor: string): Promise<ProofLogoRegionResult> {
  const image = sharp(path.resolve(proofPath), { failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('proof_missing_logo: proof has no dimensions');
  const scaleX = metadata.width / PROOF_CSS_SIZE.width;
  const scaleY = metadata.height / PROOF_CSS_SIZE.height;
  const region = {
    left: Math.max(0, Math.round(LOGO_REGION_CSS.left * scaleX)),
    top: Math.max(0, Math.round(LOGO_REGION_CSS.top * scaleY)),
    width: Math.max(1, Math.min(metadata.width, Math.round(LOGO_REGION_CSS.width * scaleX))),
    height: Math.max(1, Math.min(metadata.height, Math.round(LOGO_REGION_CSS.height * scaleY))),
  };
  region.width = Math.min(region.width, metadata.width - region.left);
  region.height = Math.min(region.height, metadata.height - region.top);
  const raw = await image.extract(region).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const primary = parseHex(primaryColor);
  let ink = 0;
  for (let offset = 0; offset < raw.data.length; offset += raw.info.channels) {
    const distance = Math.sqrt(
      (raw.data[offset] - primary.r) ** 2
      + (raw.data[offset + 1] - primary.g) ** 2
      + (raw.data[offset + 2] - primary.b) ** 2,
    );
    if (raw.data[offset + 3] >= 128 && distance >= 18) ink += 1;
  }
  const share = ink / Math.max(1, raw.info.width * raw.info.height);
  const pass = ink >= 20 && share >= MIN_LOGO_INK_SHARE;
  return {
    pass,
    verdict: pass ? 'ok' : 'proof_missing_logo',
    non_background_ink_share: Number(share.toFixed(5)),
    non_background_pixels: ink,
    region,
  };
}

export async function requireLogoWriteProof(
  plan: JsonObject,
  effective: JsonObject,
  proofPath: string,
  primaryColor: string,
): Promise<ProofLogoRegionResult | null> {
  if (!planWritesLogo(plan)) return null;
  if (!stringValue(effective.logo_attachment_id)) {
    throw new Error('proof_missing_logo: branding plan wrote a logo but readback logo_attachment_id is null');
  }
  const result = await assessProofLogoRegion(proofPath, primaryColor);
  if (!result.pass) {
    throw new Error(`proof_missing_logo: no visible non-background ink in proof logo region (${result.non_background_ink_share})`);
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.readback) throw new Error('Missing required --readback <production-readback.json>');
  if (!args.metadata) throw new Error('Missing required --metadata <proof-branding.json>');
  if (!args.proof) throw new Error('Missing required --proof <proof.png>');
  if (!args.locationId) throw new Error('Missing required --location-id <locationId>');
  const mode = args.mode ?? 'digital';
  if (mode !== 'digital' && mode !== 'print') throw new Error('--mode must be digital or print');

  const readbackPath = path.resolve(args.readback);
  const metadataPath = path.resolve(args.metadata);
  const proofPath = path.resolve(args.proof);
  const readback = JSON.parse(await fs.readFile(readbackPath, 'utf8')) as JsonObject;
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as JsonObject;
  const effective = extractEffectiveBranding(readback);
  const locationId = extractLocationId(readback);

  if (locationId !== args.locationId) {
    throw new Error(`Readback location mismatch: expected ${args.locationId}, found ${locationId ?? 'none'}`);
  }
  assertEqual('metadata location', metadata.location_id, locationId);
  assertEqual('preview surface', metadata.preview_surface, 'tapcard');
  assertEqual('color mode', metadata.color_mode, mode);
  assertEqual('rendered colors', metadata.rendered_colors, requireCompletePreviewColors(resolvePreviewColors(effective, mode)));
  assertEqual('source readback hash', metadata.source_readback_sha256, await sha256(readbackPath));
  assertEqual('proof hash', metadata.proof_sha256, await sha256(proofPath));

  const recordedEffective = metadata.effective_branding as JsonObject | undefined;
  assertEqual('effective logo attachment', recordedEffective?.logo_attachment_id ?? null, effective.logo_attachment_id ?? null);
  assertEqual('effective logo URL', recordedEffective?.logo_url ?? null, effective.logo_url ?? null);
  if (effective.logo_url) {
    assertEqual('effective logo content hash', metadata.logo_sha256, await sha256Url(effective.logo_url));
  } else {
    assertEqual('effective logo content hash', metadata.logo_sha256, null);
  }

  let proofLogoRegion: ProofLogoRegionResult | null = null;
  if (args.plan) {
    const plan = JSON.parse(await fs.readFile(path.resolve(args.plan), 'utf8')) as JsonObject;
    proofLogoRegion = await requireLogoWriteProof(
      plan,
      effective,
      proofPath,
      String(asObject(metadata.rendered_colors).primary ?? ''),
    );
  }

  if (args.run) {
    // proofs block: the validate half. Refuses to mark a different proof than the one rendered.
    const { asObject, readRun, setBlock } = await import('../../boostly-box-fulfillment/scripts/run-file.ts');
    const runDir = path.resolve(args.run);
    const previous = asObject(readRun(runDir).proofs);
    if (typeof previous.proof_sha256 === 'string' && previous.proof_sha256 !== metadata.proof_sha256) {
      throw new Error(`run.json proofs.proof_sha256 ${String(previous.proof_sha256)} is not the proof being validated (${String(metadata.proof_sha256)}); render-effective-proof --run first`);
    }
    setBlock(runDir, 'proofs', {
      ...previous,
      proof_sha256: metadata.proof_sha256,
      logo_sha256: metadata.logo_sha256,
      validated: { ok: true, at: new Date().toISOString(), mode, proof_logo_region: proofLogoRegion, plan_checked: Boolean(args.plan) },
    }, { by: 'validate-effective-proof' });
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, proof: proofPath, metadata: metadataPath, location_id: locationId, colors: metadata.rendered_colors, proof_logo_region: proofLogoRegion, run: args.run ? path.resolve(args.run) : null })}\n`,
  );
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseHex(value: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) throw new Error(`proof_missing_logo: invalid rendered primary color ${JSON.stringify(value)}`);
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
