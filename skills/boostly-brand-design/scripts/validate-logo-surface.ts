#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateThresholds } from './logo-quality-gates.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

// Thresholds come from references/gates.json (gate id validate-logo-surface).
const T = gateThresholds('validate-logo-surface');

type Assessment = {
  pass: boolean;
  verdict: 'ok' | 'opaque_light_panel_on_colored_surface';
  width: number;
  height: number;
  source_has_alpha: boolean;
  transparent_share: number;
  near_white_share: number;
  border_near_white_share: number;
  white_primary_contrast: number;
};

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key ?? 'end of input'}`);
    }
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function srgbToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(red: number, green: number, blue: number): number {
  return 0.2126 * srgbToLinear(red) + 0.7152 * srgbToLinear(green) + 0.0722 * srgbToLinear(blue);
}

function contrast(first: number, second: number): number {
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

function parseHex(value: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid six-digit hex color: ${value}`);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset + 1, offset + 3), 16)) as [number, number, number];
}

export async function assessLogoSurface(logoPath: string, primaryHex: string): Promise<Assessment> {
  const metadata = await sharp(logoPath).metadata();
  const { data, info } = await sharp(logoPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  const border = new Set<number>();
  for (let x = 0; x < info.width; x += 1) {
    border.add(x);
    border.add((info.height - 1) * info.width + x);
  }
  for (let y = 0; y < info.height; y += 1) {
    border.add(y * info.width);
    border.add(y * info.width + info.width - 1);
  }

  let transparent = 0;
  let nearWhite = 0;
  let borderNearWhite = 0;
  let opaqueBorder = 0;
  const isNearWhite = (pixel: number) =>
    data[pixel * 4] >= T.near_white_channel_min && data[pixel * 4 + 1] >= T.near_white_channel_min && data[pixel * 4 + 2] >= T.near_white_channel_min;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const alpha = data[pixel * 4 + 3];
    if (alpha <= 8) transparent += 1;
    if (alpha > 128 && isNearWhite(pixel)) nearWhite += 1;
  }
  for (const pixel of border) {
    if (data[pixel * 4 + 3] <= 128) continue;
    opaqueBorder += 1;
    if (isNearWhite(pixel)) borderNearWhite += 1;
  }

  const [red, green, blue] = parseHex(primaryHex);
  const whitePrimaryContrast = contrast(1, luminance(red, green, blue));
  const sourceHasAlpha = metadata.hasAlpha === true;
  const transparentShare = transparent / total;
  const nearWhiteShare = nearWhite / total;
  const borderNearWhiteShare = opaqueBorder ? borderNearWhite / opaqueBorder : 0;
  const opaqueLightPanel =
    whitePrimaryContrast >= T.min_white_primary_contrast &&
    transparentShare < T.max_transparent_share &&
    (nearWhiteShare >= T.near_white_share_fail || (borderNearWhiteShare >= T.border_near_white_share_fail && nearWhiteShare >= T.near_white_share_with_border_fail));

  return {
    pass: !opaqueLightPanel,
    verdict: opaqueLightPanel ? 'opaque_light_panel_on_colored_surface' : 'ok',
    width: info.width,
    height: info.height,
    source_has_alpha: sourceHasAlpha,
    transparent_share: Number(transparentShare.toFixed(4)),
    near_white_share: Number(nearWhiteShare.toFixed(4)),
    border_near_white_share: Number(borderNearWhiteShare.toFixed(4)),
    white_primary_contrast: Number(whitePrimaryContrast.toFixed(3)),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.logo || !args.primary) throw new Error('usage: validate-logo-surface.ts --logo <path> --primary <hex>');
  const assessment = await assessLogoSurface(path.resolve(args.logo), args.primary);
  process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
  if (!assessment.pass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
