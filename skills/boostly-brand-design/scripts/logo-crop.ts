#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateThresholds } from './logo-quality-gates.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

// Padding thresholds come from references/gates.json (gate id logo-crop).
const T = gateThresholds('logo-crop');

type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type Padding = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type CropAssessment = {
  pass: boolean;
  verdict: 'ok' | 'excess_canvas_padding' | 'crop_unassessed_nonuniform_border' | 'no_logo_content';
  width: number;
  height: number;
  background_mode: 'transparent' | 'uniform_color' | 'nonuniform';
  border_reference: string | null;
  border_uniform_share: number;
  content_bounds: Bounds | null;
  padding_px: Padding | null;
  padding_ratio: Padding | null;
  max_padding_ratio: number;
  removable_canvas_share: number;
};

type AnalysisOptions = {
  alphaThreshold?: number;
  colorTolerance?: number;
  maxPaddingRatio?: number;
  minUniformBorderShare?: number;
};

type CropOptions = AnalysisOptions & {
  safetyRatio?: number;
};

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function borderIndexes(width: number, height: number): number[] {
  const indexes = new Set<number>();
  for (let x = 0; x < width; x += 1) {
    indexes.add(x);
    indexes.add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    indexes.add(y * width);
    indexes.add(y * width + width - 1);
  }
  return [...indexes];
}

function colorHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function roundedRatio(value: number): number {
  return Number(value.toFixed(4));
}

export async function assessLogoCrop(
  logoPath: string,
  {
    alphaThreshold = 8,
    colorTolerance = 10,
    maxPaddingRatio = T.maxPaddingRatio,
    minUniformBorderShare = 0.75,
  }: AnalysisOptions = {},
): Promise<CropAssessment> {
  if (!Number.isFinite(maxPaddingRatio) || maxPaddingRatio < 0 || maxPaddingRatio > 0.1) {
    throw new Error('maxPaddingRatio must be a finite number between 0 and 0.1');
  }
  if (!Number.isFinite(colorTolerance) || colorTolerance < 0 || colorTolerance > 64) {
    throw new Error('colorTolerance must be a finite number between 0 and 64');
  }
  const metadata = await sharp(logoPath).metadata();
  const { data, info } = await sharp(logoPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const border = borderIndexes(width, height);
  let transparentPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (data[pixel * 4 + 3] <= alphaThreshold) transparentPixels += 1;
  }
  const transparentBorderShare = border.filter((pixel) => data[pixel * 4 + 3] <= alphaThreshold).length / border.length;

  let backgroundMode: CropAssessment['background_mode'];
  let borderReference: [number, number, number] | null = null;
  let borderUniformShare: number;
  let isBackground: (pixel: number) => boolean;

  if (metadata.hasAlpha && transparentPixels > 0) {
    backgroundMode = 'transparent';
    borderUniformShare = transparentBorderShare;
    isBackground = (pixel) => data[pixel * 4 + 3] <= alphaThreshold;
  } else {
    const opaqueBorder = border.filter((pixel) => data[pixel * 4 + 3] > alphaThreshold);
    borderReference = [0, 1, 2].map((channel) => median(opaqueBorder.map((pixel) => data[pixel * 4 + channel]))) as [number, number, number];
    const nearReference = (pixel: number) =>
      data[pixel * 4 + 3] > alphaThreshold &&
      [0, 1, 2].every((channel) => Math.abs(data[pixel * 4 + channel] - borderReference![channel]) <= colorTolerance);
    borderUniformShare = border.filter(nearReference).length / border.length;
    if (borderUniformShare < minUniformBorderShare) {
      return {
        pass: false,
        verdict: 'crop_unassessed_nonuniform_border',
        width,
        height,
        background_mode: 'nonuniform',
        border_reference: colorHex(...borderReference),
        border_uniform_share: roundedRatio(borderUniformShare),
        content_bounds: null,
        padding_px: null,
        padding_ratio: null,
        max_padding_ratio: maxPaddingRatio,
        removable_canvas_share: 0,
      };
    }
    backgroundMode = 'uniform_color';
    const removable = new Uint8Array(width * height);
    const queue = border.filter(nearReference);
    for (const pixel of queue) removable[pixel] = 1;
    while (queue.length > 0) {
      const pixel = queue.pop()!;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (!removable[next] && nearReference(next)) {
          removable[next] = 1;
          queue.push(next);
        }
      }
    }
    isBackground = (pixel) => removable[pixel] === 1;
  }

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (isBackground(pixel)) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }

  if (right < left || bottom < top) {
    return {
      pass: false,
      verdict: 'no_logo_content',
      width,
      height,
      background_mode: backgroundMode,
      border_reference: borderReference ? colorHex(...borderReference) : null,
      border_uniform_share: roundedRatio(borderUniformShare),
      content_bounds: null,
      padding_px: null,
      padding_ratio: null,
      max_padding_ratio: maxPaddingRatio,
      removable_canvas_share: 1,
    };
  }

  const bounds: Bounds = {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
  const padding: Padding = {
    left,
    top,
    right: width - right - 1,
    bottom: height - bottom - 1,
  };
  const rawPaddingRatio: Padding = {
    left: padding.left / width,
    top: padding.top / height,
    right: padding.right / width,
    bottom: padding.bottom / height,
  };
  const pass = Object.values(rawPaddingRatio).every((ratio) => ratio <= maxPaddingRatio);
  const paddingRatio: Padding = {
    left: roundedRatio(rawPaddingRatio.left),
    top: roundedRatio(rawPaddingRatio.top),
    right: roundedRatio(rawPaddingRatio.right),
    bottom: roundedRatio(rawPaddingRatio.bottom),
  };

  return {
    pass,
    verdict: pass ? 'ok' : 'excess_canvas_padding',
    width,
    height,
    background_mode: backgroundMode,
    border_reference: borderReference ? colorHex(...borderReference) : null,
    border_uniform_share: roundedRatio(borderUniformShare),
    content_bounds: bounds,
    padding_px: padding,
    padding_ratio: paddingRatio,
    max_padding_ratio: maxPaddingRatio,
    removable_canvas_share: roundedRatio(1 - (bounds.width * bounds.height) / (width * height)),
  };
}

export async function cropLogoCanvas(
  inputPath: string,
  outputPath: string,
  { safetyRatio = T.safetyRatio, ...analysisOptions }: CropOptions = {},
): Promise<{ crop: Bounds; assessment: CropAssessment }> {
  if (safetyRatio < 0 || safetyRatio > 0.015) {
    throw new Error('safetyRatio must be between 0 and 0.015');
  }
  const source = await assessLogoCrop(inputPath, analysisOptions);
  if (source.background_mode === 'nonuniform') {
    throw new Error('No uniform removable canvas was detected; inspect this logo instead of guessing a crop.');
  }
  if (!source.content_bounds) throw new Error('No logo content was detected.');

  const horizontalSafety = Math.max(1, Math.ceil(source.content_bounds.width * safetyRatio));
  const verticalSafety = Math.max(1, Math.ceil(source.content_bounds.height * safetyRatio));
  const left = Math.max(0, source.content_bounds.left - horizontalSafety);
  const top = Math.max(0, source.content_bounds.top - verticalSafety);
  const right = Math.min(source.width - 1, source.content_bounds.right + horizontalSafety);
  const bottom = Math.min(source.height - 1, source.content_bounds.bottom + verticalSafety);
  const crop: Bounds = {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };

  await sharp(inputPath).extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height }).png().toFile(outputPath);
  const assessment = await assessLogoCrop(outputPath, analysisOptions);
  if (!assessment.pass) {
    throw new Error(`Cropped logo still fails crop QA: ${assessment.verdict}`);
  }
  return { crop, assessment };
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key ?? 'end of input'}`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.logo) throw new Error('Usage: logo-crop.ts --logo <path> [--out <png>]');
  const numericOption = (name: string, minimum: number, maximum: number): number | undefined => {
    if (args[name] === undefined) return undefined;
    const value = Number(args[name]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`--${name} must be a finite number between ${minimum} and ${maximum}`);
    }
    return value;
  };
  const options: CropOptions = {
    maxPaddingRatio: numericOption('max-padding-ratio', 0, 0.1),
    safetyRatio: numericOption('safety-ratio', 0, 0.015),
    colorTolerance: numericOption('color-tolerance', 0, 64),
  };
  const result = args.out
    ? await cropLogoCanvas(args.logo, args.out, options)
    : await assessLogoCrop(args.logo, options);
  console.log(JSON.stringify(result, null, 2));
  const assessment = 'assessment' in result ? result.assessment : result;
  if (!assessment.pass) process.exitCode = 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
