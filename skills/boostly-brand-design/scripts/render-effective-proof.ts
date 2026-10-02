#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Image harness lives inside this skill (boostly-brand-design/harness) so the skill is self-contained.
const DEFAULT_RENDERER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'harness',
  'screenshot.mjs',
);

type JsonObject = Record<string, unknown>;

export type EffectiveBranding = {
  web_primary_color?: string | null;
  web_secondary_color?: string | null;
  web_text_color?: string | null;
  print_primary_color?: string | null;
  print_secondary_color?: string | null;
  print_text_color?: string | null;
  print_text_secondary_color?: string | null;
  logo_attachment_id?: string | null;
  logo_url?: string | null;
  logo_filename?: string | null;
};

export type PreviewColors = {
  primary: string | null;
  secondary: string | null;
  text: string | null;
  textSecondary: string | null;
};

export type CompletePreviewColors = {
  primary: string;
  secondary: string;
  text: string;
  textSecondary: string;
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeHex(value: unknown, field: string): string | null {
  const color = stringValue(value);
  if (color === null) return null;
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error(`${field} must be a six-digit hex color, received ${JSON.stringify(color)}`);
  }
  return color.toLowerCase();
}

function hasBrandingFields(value: JsonObject): boolean {
  return [
    'web_primary_color',
    'web_secondary_color',
    'web_text_color',
    'print_primary_color',
    'logo_attachment_id',
    'logo_url',
  ].some((field) => field in value);
}

/**
 * Accept the two production-readback shapes used by the settings CLI:
 * a nested `effective_branding` result or a flattened effective snapshot.
 * Deliberately never derives effective values from account/override rows here;
 * the production resolver is the source of truth for inheritance.
 */
export function extractEffectiveBranding(readback: unknown): EffectiveBranding {
  if (!isObject(readback)) throw new Error('Production readback must be a JSON object');

  const containers = [readback, readback.data, readback.result].filter(isObject);
  for (const container of containers) {
    const nested = container.effective_branding ?? container.effectiveBranding;
    if (isObject(nested) && hasBrandingFields(nested)) return nested as EffectiveBranding;
  }

  // Some manually captured readbacks intentionally flatten the already-resolved result.
  if (hasBrandingFields(readback) && !('account_branding' in readback || 'override_branding' in readback)) {
    return readback as EffectiveBranding;
  }

  throw new Error(
    'Readback does not contain resolved effective_branding. Do not render from account_branding, override_branding, or a proposal manifest.',
  );
}

/** Match BrandingSurfacePreviews exactly: digital is the default visible tap-card preview. */
export function resolvePreviewColors(
  branding: EffectiveBranding,
  mode: 'digital' | 'print' = 'digital',
): PreviewColors {
  const webPrimary = normalizeHex(branding.web_primary_color, 'web_primary_color');
  const webSecondary = normalizeHex(branding.web_secondary_color, 'web_secondary_color');
  const webText = normalizeHex(branding.web_text_color, 'web_text_color');

  if (mode === 'digital') {
    return {
      primary: webPrimary,
      secondary: webSecondary,
      text: webText,
      // Production's digital tab intentionally uses web_text_color for both roles.
      textSecondary: webText,
    };
  }

  return {
    primary: normalizeHex(branding.print_primary_color, 'print_primary_color') ?? webPrimary,
    secondary:
      normalizeHex(branding.print_secondary_color, 'print_secondary_color') ?? webSecondary,
    text: normalizeHex(branding.print_text_color, 'print_text_color') ?? webText,
    textSecondary:
      normalizeHex(branding.print_text_secondary_color, 'print_text_secondary_color') ??
      normalizeHex(branding.print_text_color, 'print_text_color') ??
      webText,
  };
}

export function requireCompletePreviewColors(colors: PreviewColors): CompletePreviewColors {
  const missing = Object.entries(colors)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Effective production branding is missing preview colors: ${missing.join(', ')}. Refusing to render with harness defaults.`,
    );
  }
  return colors as CompletePreviewColors;
}

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

export function extractLocationId(readback: JsonObject): string | null {
  const direct = stringValue(readback.location_id ?? readback.locationId);
  if (direct) return direct;
  if (isObject(readback.location)) return stringValue(readback.location.id);
  for (const child of [readback.data, readback.result]) {
    if (isObject(child)) {
      const nested = extractLocationId(child);
      if (nested) return nested;
    }
  }
  return null;
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function imageExtension(contentType: string | null, url: string): string {
  const type = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/svg+xml') return '.svg';
  if (type === 'image/png') return '.png';
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return ['.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(ext) ? ext : '.png';
}

async function downloadEffectiveLogo(url: string, outBase: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Effective production logo returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Effective production logo returned non-image content type ${contentType}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('Effective production logo download was empty');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Effective production logo exceeds 20 MB');
  const logoPath = `${outBase}${imageExtension(contentType, url)}`;
  await fs.writeFile(logoPath, buffer);
  return logoPath;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Proof renderer failed (${signal ?? `exit ${code}`})`));
    });
  });
}

function pushColorArg(args: string[], name: string, value: string | null): void {
  if (value) args.push(`--${name}`, value);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.readback) throw new Error('Missing required --readback <production-readback.json>');
  if (!args.out) throw new Error('Missing required --out <proof.png>');
  if (!args.locationId) throw new Error('Missing required --location-id <locationId>');
  const mode = args.mode ?? 'digital';
  if (mode !== 'digital' && mode !== 'print') throw new Error('--mode must be digital or print');
  // Optional --run <run_dir>: also record the proof in run.json's proofs block.

  const readbackPath = path.resolve(args.readback);
  const readback = JSON.parse(await fs.readFile(readbackPath, 'utf8')) as JsonObject;
  const locationId = extractLocationId(readback);
  if (locationId !== args.locationId) {
    throw new Error(
      `Readback location mismatch: expected ${args.locationId}, found ${locationId ?? 'none'}`,
    );
  }

  const effective = extractEffectiveBranding(readback);
  const colors = requireCompletePreviewColors(resolvePreviewColors(effective, mode));
  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const effectiveLogoUrl = stringValue(effective.logo_url);
  let logoPath: string | null = null;
  let logoSource = 'none';
  if (effectiveLogoUrl) {
    logoPath = await downloadEffectiveLogo(effectiveLogoUrl, `${outPath}.effective-logo`);
    logoSource = 'effective_branding.logo_url';
  } else if (args.logo) {
    logoPath = path.resolve(args.logo);
    if (!existsSync(logoPath)) throw new Error(`Fallback logo does not exist: ${logoPath}`);
    logoSource = 'explicit_fallback_no_effective_logo_url';
  } else if (stringValue(effective.logo_attachment_id)) {
    throw new Error(
      'Effective branding has a logo attachment but no logo_url; refresh the production readback instead of using a stale proposal asset.',
    );
  }

  const renderer = path.resolve(args.renderer ?? DEFAULT_RENDERER);
  if (!existsSync(renderer)) throw new Error(`Proof renderer does not exist: ${renderer}`);
  const rendererArgs = [
    '--url-base',
    args.urlBase ?? 'http://localhost:3457',
    '--out',
    outPath,
    '--issue-id',
    args.issueId ?? '1',
  ];
  if (logoPath) rendererArgs.push('--logo', logoPath);
  pushColorArg(rendererArgs, 'primary', colors.primary);
  pushColorArg(rendererArgs, 'secondary', colors.secondary);
  pushColorArg(rendererArgs, 'text', colors.text);
  pushColorArg(rendererArgs, 'text-secondary', colors.textSecondary);

  await run(renderer, rendererArgs);
  const proof = await fs.readFile(outPath);
  if (proof.length < 1_000 || proof.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Renderer output is not a non-empty PNG proof');
  }

  const metadataPath = path.resolve(args.metadata ?? path.join(path.dirname(outPath), 'proof-branding.json'));
  const metadata = {
    schema_version: 1,
    preview_surface: 'tapcard',
    color_mode: mode,
    color_contract:
      mode === 'digital'
        ? 'resolved web colors; web_text_color supplies both digital text roles'
        : 'resolved print colors with production print-to-web fallback',
    location_id: locationId,
    selected_scope: stringValue(readback.selected_scope),
    source_readback: readbackPath,
    source_readback_sha256: await sha256(readbackPath),
    effective_branding: {
      web_primary_color: normalizeHex(effective.web_primary_color, 'web_primary_color'),
      web_secondary_color: normalizeHex(effective.web_secondary_color, 'web_secondary_color'),
      web_text_color: normalizeHex(effective.web_text_color, 'web_text_color'),
      print_primary_color: normalizeHex(effective.print_primary_color, 'print_primary_color'),
      print_secondary_color: normalizeHex(effective.print_secondary_color, 'print_secondary_color'),
      print_text_color: normalizeHex(effective.print_text_color, 'print_text_color'),
      print_text_secondary_color: normalizeHex(
        effective.print_text_secondary_color,
        'print_text_secondary_color',
      ),
      logo_attachment_id: stringValue(effective.logo_attachment_id),
      logo_url: effectiveLogoUrl,
    },
    rendered_colors: colors,
    logo_source: logoSource,
    logo_sha256: logoPath ? await sha256(logoPath) : null,
    proof_path: outPath,
    proof_sha256: await sha256(outPath),
    rendered_at: new Date().toISOString(),
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  if (args.run) {
    // proofs block: the render half. validate-effective-proof --run fills proofs.validated.
    const { asObject, readRun, setBlock } = await import('../../boostly-box-fulfillment/scripts/run-file.ts');
    const runDir = path.resolve(args.run);
    const previous = asObject(readRun(runDir).proofs);
    const rel = (file: string) => (path.relative(runDir, file).startsWith('..') ? file : path.relative(runDir, file));
    setBlock(runDir, 'proofs', {
      ...previous,
      proof_png: rel(outPath),
      proof_sha256: metadata.proof_sha256,
      proof_branding_json: rel(metadataPath),
      logo_sha256: metadata.logo_sha256,
      logo_source: logoSource,
      readback: rel(readbackPath),
      readback_sha256: metadata.source_readback_sha256,
      color_mode: mode,
      rendered_colors: colors,
      effective_branding: metadata.effective_branding,
      rendered_at: metadata.rendered_at,
      validated: null,
    }, { by: 'render-effective-proof' });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, out: outPath, metadata: metadataPath, colors, run: args.run ? path.resolve(args.run) : null })}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
