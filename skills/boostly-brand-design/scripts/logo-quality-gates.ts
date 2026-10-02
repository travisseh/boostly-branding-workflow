#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// sharp comes from the skill harness (boostly-brand-design/harness) first; the Codex runtime copy is the fallback.
const harnessRequire = createRequire(new URL('../harness/package.json', import.meta.url));
function loadSharp(): any {
  try { return harnessRequire('sharp'); } catch { return require('/Users/travisse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'); }
}
const sharp = loadSharp();

// ---------------------------------------------------------------------------
// Gate registry: every threshold below comes from ../references/gates.json.
// Nothing in this file carries a number of its own; change a rule by editing
// the registry and running `gates.ts replay`, never by editing code.
// ---------------------------------------------------------------------------
export const GATES_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'references', 'gates.json');

export type GateSeverity = 'block' | 'warn' | 'info';
export type GateDefinition = {
  id: string;
  name: string;
  tool: 'harness' | 'logo-quality-gates' | 'validate-logo-surface' | 'logo-crop' | 'gates';
  command: string;
  measures: string;
  inputs: string[];
  thresholds: Record<string, unknown>;
  pass_rule: string;
  severity: GateSeverity;
  override_allowed: boolean;
  override_allowed_verdicts?: string[];
  /** Override accepted only on an asset already live in production (recorded with --shipped). */
  override_allowed_for_shipped?: boolean;
  /** Per-verdict severity that overrides `severity` for that verdict only. */
  severity_by_verdict?: Record<string, GateSeverity>;
  override_rationale: string;
  case_study: string;
  battery: boolean | 'conditional';
  when?: string;
};
export type GateRegistry = {
  schema_version: number;
  aliases: Record<string, string>;
  gates: GateDefinition[];
  changelog?: Array<{ date: string; gate: string; change: string; reason: string; decided_by: string }>;
};
/** The severity a result carries: the gate's severity unless severity_by_verdict names this verdict. */
export function effectiveSeverity(def: GateDefinition, verdict: string | null): GateSeverity {
  return (verdict && def.severity_by_verdict?.[verdict]) || def.severity;
}

let registryCache: GateRegistry | null = null;
export function loadGateRegistry(): GateRegistry {
  if (!registryCache) registryCache = JSON.parse(fs.readFileSync(GATES_JSON, 'utf8')) as GateRegistry;
  return registryCache;
}
export function gateDefinition(id: string): GateDefinition {
  const entry = loadGateRegistry().gates.find((gate) => gate.id === id);
  if (!entry) throw new Error(`gate "${id}" is not in ${GATES_JSON}`);
  return entry;
}
export function gateThresholds<T extends Record<string, unknown> = Record<string, number>>(id: string): T {
  return { ...gateDefinition(id).thresholds } as T;
}
/** Resolve a gate id or alias (ocr, render_legibility, ship_gate, ...) to the registry id; null when unknown. */
export function canonicalGateId(idOrAlias: string): string | null {
  const registry = loadGateRegistry();
  const key = idOrAlias.trim();
  if (registry.gates.some((gate) => gate.id === key)) return key;
  const alias = registry.aliases[key] ?? registry.aliases[key.toLowerCase()];
  return alias ?? null;
}

const RL = gateThresholds<{
  product_logo_box: { width: number; height: number };
  min_component_height_px: number;
  max_tiny_text_ink_share: number;
  max_small_component_ink_share: number;
  min_edge_energy: number;
  min_rendered_ink_px: number;
  substantial_component_min_ink_share: number;
  tiny_line_min_members: number;
  tiny_line_min_aspect: number;
  tiny_line_height_ratio: number;
}>('render-legibility');
const TL = gateThresholds('text-legibility');
const IR = gateThresholds('ink-retention');
const ACR = gateThresholds('authored-color-retention');
const SO = gateThresholds('source-overlay');
const PNG = gateThresholds<{ allowed_color_types: number[] }>('png-color-type');
const EQ = gateThresholds<{
  min_soft_edge_share: number;
  binary_alpha_min_longest_px: number;
  max_stair_step_score: number;
  min_source_native_px: number;
  contour_run_cap_px: number;
}>('edge-quality');
const SG = gateThresholds<{ min_opaque_bbox_share: number; opaque_alpha: number }>('sticker-ground');
const SV = gateThresholds<{ ocr_width_px: number; ocr_pad_px: number; max_missing_glyph_components: number; glyph_min_height_ratio: number; glyph_max_height_ratio: number; glyph_max_aspect: number; rejected_label_pattern: string }>('sheet-viability');

export const AUTHORED_COLOR_MIN_RETENTION = ACR.minimum_retained_chromatic_share;
export const BADGE_LOGO_BOX = RL.product_logo_box;
export const INK_RETENTION_MIN_RECALL = IR.minimum_coverage_recall;
export const INK_RETENTION_MAX_VANISHED_COMPONENT_SHARE = IR.maximum_vanished_component_ink_share;
// authored_white_dropped: when recall is short, the uncovered source ink must be at least this
// share near-white (and no component may vanish) for the softer, overridable verdict
export const INK_RETENTION_AUTHORED_WHITE_DROPPED_MIN_SHARE = Number(IR.authored_white_dropped_min_share ?? 0.95);
export const INK_RETENTION_NEAR_WHITE_MIN_CHANNEL = Number(IR.near_white_min_channel ?? 225);
// authored_dark_dropped (Cellblock Sips 2026-09-21): when recall is short, the uncovered source ink
// (including a vanished component) must be at least this share near-black AND the card primary must
// merge with that black (contrast under dark_ground_merge_max_contrast) for the softer, overridable
// verdict: the dropped ink is the authored dark ground disappearing into the brand's own dark card,
// not lost logo. Without a primary the verdict stays authored_ink_lost.
export const INK_RETENTION_AUTHORED_DARK_DROPPED_MIN_SHARE = Number(IR.authored_dark_dropped_min_share ?? 0.95);
export const INK_RETENTION_NEAR_BLACK_MAX_CHANNEL = Number(IR.near_black_max_channel ?? 40);
export const INK_RETENTION_DARK_GROUND_MERGE_MAX_CONTRAST = Number(IR.dark_ground_merge_max_contrast ?? 1.5);
// rebuilt_from_low_res_source (Toscana Gourmet Pizza 2026-09-29): the final is a larger rebuild of a
// tiny source (source ink box at most low_res_rebuild_max_source_ink_px on its longest side, final
// ink box at least low_res_rebuild_min_upscale times wider), no component vanished, and recall is
// short but at least low_res_rebuild_min_recall. The shortfall is letter weight against a blurry
// original, not a missing part, so a human who looked at the proof may override it. Below the
// recall floor, or with any vanished component, the verdict stays authored_ink_lost.
export const INK_RETENTION_LOW_RES_REBUILD_MIN_RECALL = Number(IR.low_res_rebuild_min_recall ?? 0.9);
export const INK_RETENTION_LOW_RES_REBUILD_MAX_SOURCE_INK_PX = Number(IR.low_res_rebuild_max_source_ink_px ?? 300);
export const INK_RETENTION_LOW_RES_REBUILD_MIN_UPSCALE = Number(IR.low_res_rebuild_min_upscale ?? 2);

function srgbChannelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}
export function contrastRatioRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relativeLuminance(a.r, a.g, a.b);
  const lb = relativeLuminance(b.r, b.g, b.b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}
const rgbToHex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const PRODUCT_MIN_COMPONENT_HEIGHT = RL.min_component_height_px;
const PRODUCT_MAX_TINY_TEXT_INK_SHARE = RL.max_tiny_text_ink_share;
const PRODUCT_MAX_SMALL_COMPONENT_INK_SHARE = RL.max_small_component_ink_share;
const PRODUCT_MIN_EDGE_ENERGY = RL.min_edge_energy;
export const SOURCE_OVERLAY_MIN_IOU = SO.minimum_iou;
export const SOURCE_OVERLAY_MAX_COMPONENT_DRIFT = SO.maximum_component_drift;
const SOURCE_OVERLAY_WIDTH = SO.width_px;

type InkMask = {
  width: number;
  height: number;
  pixels: Uint8Array;
  mode: 'alpha' | 'uniform_border';
  // ink pixels whose authored RGB is near-white (every channel >= INK_RETENTION_NEAR_WHITE_MIN_CHANNEL);
  // a sub-mask of pixels, carried through alignment so ink-retention can say WHAT was dropped
  white?: Uint8Array;
  // ink pixels whose authored RGB is near-black (every channel <= INK_RETENTION_NEAR_BLACK_MAX_CHANNEL)
  dark?: Uint8Array;
  // mean RGB of the near-black ink (null when there is none); the authored dark ground's color
  darkColor?: { r: number; g: number; b: number } | null;
};

type Component = {
  pixels: number[];
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type SharpnessEvidence = {
  metric: 'laplacian_variance_capped_512px';
  value: number;
  classification: 'low' | 'usable' | 'sharp';
  measured_width: number;
  measured_height: number;
};

export type RenderLegibilityResult = {
  pass: boolean;
  verdict: 'ok' | 'illegible_at_product_size' | 'stylized_script_informational' | 'render_legibility_unassessable';
  product_logo_box: typeof BADGE_LOGO_BOX;
  proxy: {
    limitation: string;
    edge_energy: number;
    minimum_substantial_component_height_px: number | null;
    small_component_ink_share: number;
    tiny_text_ink_share: number;
    ink_pixel_share: number;
  };
  // Set on the informational verdict: the proposal must attach a 4x crop of
  // the 126x56 product box on the primary color instead of holding the write.
  attach_4x_crop_required: boolean;
  crop_4x?: string;
  reasons: string[];
};

export type SourceOverlayResult = {
  pass: boolean;
  verdict: 'ok' | 'redrawn_low_overlap' | 'component_count_drift' | 'source_overlay_unassessable';
  iou: number;
  minimum_iou: number;
  candidate_components: number;
  reference_components: number;
  component_drift: number;
  maximum_component_drift: number;
  aspect_candidate: number;
  aspect_reference: number;
  best_shift_px: { dx: number; dy: number };
  overlay?: string;
  reasons: string[];
};

export type InkRetentionResult = {
  pass: boolean;
  verdict: 'ok' | 'authored_ink_lost' | 'authored_white_dropped' | 'authored_dark_dropped' | 'rebuilt_from_low_res_source' | 'ink_retention_unassessable';
  coverage_recall: number | null;
  // fraction of the uncovered source ink (beyond one SOURCE pixel of edge drift) whose authored
  // RGB is near-white (null when nothing is uncovered); _strict is the same share at the recall's
  // own 1px tolerance and with no white rim, reported for the record
  dropped_ink_white_share: number | null;
  dropped_ink_white_share_strict: number | null;
  dropped_ink_edge_radius_px: number | null;
  // fraction of the uncovered source ink (same edge tolerance) whose authored RGB is near-black
  dropped_ink_dark_share: number | null;
  // the card primary given to the check and how it contrasts with the authored near-black ink;
  // null when no primary was given (then authored_dark_dropped can never be reached)
  dark_ground: { primary: string; dark_color: string; contrast: number; merges: boolean } | null;
  source_component_count: number | null;
  vanished_components: Array<{ ink_share: number; overlap_recall: number }>;
  // native ink boxes (px) of the source and the final, before alignment; null when unassessable
  source_ink_px?: { width: number; height: number } | null;
  final_ink_px?: { width: number; height: number } | null;
  source_mode: InkMask['mode'] | null;
  final_mode: InkMask['mode'] | null;
  thresholds: {
    minimum_coverage_recall: number;
    maximum_vanished_component_ink_share: number;
    authored_white_dropped_min_share: number;
    authored_dark_dropped_min_share: number;
    dark_ground_merge_max_contrast: number;
    low_res_rebuild_min_recall?: number;
    low_res_rebuild_max_source_ink_px?: number;
    low_res_rebuild_min_upscale?: number;
  };
  reasons: string[];
};

export type TextLegibilityResult = {
  pass: boolean;
  verdict: 'ok' | 'business_name_unreadable_at_product_size' | 'glyph_counters_filled' | 'text_legibility_unassessable';
  product_logo_box: typeof BADGE_LOGO_BOX;
  expected_text: string;
  recognized_text: string;
  normalized_expected: string;
  normalized_recognized: string;
  edit_distance: number | null;
  maximum_edit_distance: number;
  source_ocr_readable?: boolean | null;
  counter_topology: CounterTopologyResult;
  notes?: string[];
  reasons: string[];
};

export type AuthoredColorRetentionResult = {
  pass: boolean;
  verdict: 'ok' | 'authored_color_treatment_lost' | 'authored_color_retention_unassessable';
  source_chromatic_ink_share: number | null;
  retained_chromatic_share: number | null;
  minimum_retained_chromatic_share: number;
  reasons: string[];
};

export type CounterTopologyResult = {
  pass: boolean;
  /** ok | glyph_counters_filled | not_applicable_fullcolor | unassessable */
  verdict?: string;
  treatment?: 'knockout' | 'fullcolor' | 'unknown';
  expected_counter_count: number;
  detected_counter_count: number | null;
  minimum_detected_counter_count: number;
  minimum_hole_area_px: number | null;
  source_detected_counter_count?: number | null;
  reasons: string[];
};

export type PngColorTypeResult = {
  pass: boolean;
  verdict: 'ok' | 'indexed_png_not_supported' | 'png_color_type_unassessable';
  color_type: number | null;
  color_type_name: string | null;
  allowed_color_types: number[];
  reasons: string[];
};

export async function assessPngColorType(file: string): Promise<PngColorTypeResult> {
  try {
    const header = Buffer.alloc(26);
    const handle = await fs.promises.open(path.resolve(file), 'r');
    try {
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead < header.length || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('not_a_png');
      }
      if (header.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('missing_png_ihdr');
      const colorType = header[25];
      const names: Record<number, string> = {
        0: 'grayscale',
        2: 'truecolor_rgb',
        3: 'indexed_palette',
        4: 'grayscale_alpha',
        6: 'truecolor_rgba',
      };
      const pass = PNG.allowed_color_types.includes(colorType);
      return {
        pass,
        verdict: pass ? 'ok' : colorType === 3 ? 'indexed_png_not_supported' : 'png_color_type_unassessable',
        color_type: colorType,
        color_type_name: names[colorType] ?? 'unknown',
        allowed_color_types: PNG.allowed_color_types,
        reasons: pass ? [] : [`PNG color type ${colorType} (${names[colorType] ?? 'unknown'}) is not safe for the badge PDF renderer; use truecolor RGB/RGBA.`],
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      pass: false,
      verdict: 'png_color_type_unassessable',
      color_type: null,
      color_type_name: null,
      allowed_color_types: PNG.allowed_color_types,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function measureCandidateSharpness(file: string): Promise<SharpnessEvidence> {
  const rendered = await sharp(path.resolve(file), { failOn: 'error' })
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const value = adaptiveLaplacianVariance(rendered.data, rendered.info.width, rendered.info.height, rendered.info.channels);
  return {
    metric: 'laplacian_variance_capped_512px',
    value: round(value, 3),
    classification: value < 25 ? 'low' : value < 90 ? 'usable' : 'sharp',
    measured_width: rendered.info.width,
    measured_height: rendered.info.height,
  };
}

// ---------------------------------------------------------------------------
// edge-quality: what prints. Three measurements on the exact final upload at
// native size (Skyboxx 2026-09-21: an 800px binary-alpha potrace of a 640px
// Facebook avatar shipped; every mechanical gate passed; the printed edges
// were hard stair-steps and the S/k/y curves wobbled).
//   soft_edge_share    partial-alpha edge pixels / all edge pixels. Binary alpha
//                      gives 0. Blocks (binary_alpha) only under
//                      binary_alpha_min_longest_px: FINALIZE step 3 snaps flat
//                      knockouts to binary alpha on purpose and at >= 1000px the
//                      stairs are under the print raster; under it they print.
//   stair_step_score   1 - (share of contour runs, capped at contour_run_cap_px,
//                      that are exactly 1px). Contour runs are the maximal
//                      straight segments of the binarized (alpha >= 128) mask
//                      boundary, measured along rows (top and bottom edges) and
//                      columns (left and right edges). A smooth curve at native
//                      size has mostly 1px runs mixed with a few longer ones; a
//                      nearest-neighbour upscale by k has NO 1px runs (every run
//                      is a multiple of k), so the score goes to ~1.0.
//   effective resolution   source_native_longest_px and upscale_factor =
//                      final longest / source longest, recorded when the run
//                      knows the verified source (logo_sources.ladder, the
//                      candidate's source_native_px, or the inferred raw file).
//                      A trace or upscale from a source under
//                      min_source_native_px is traced_from_small_source, the
//                      only overridable verdict of this gate.
// ---------------------------------------------------------------------------
export type EdgeQualityDerivation = 'native' | 'vector' | 'trace' | 'upscale' | 'unknown';
export type EdgeQualityResult = {
  pass: boolean;
  verdict: 'ok' | 'binary_alpha' | 'stair_stepped' | 'traced_from_small_source' | 'edge_quality_unassessable';
  width: number | null;
  height: number | null;
  longest: number | null;
  alpha_levels: number | null;
  edge_pixels: number;
  soft_edge_pixels: number;
  soft_edge_share: number | null;
  contour_runs: number;
  one_px_run_share: number | null;
  stair_step_score: number | null;
  run_length_histogram: Record<string, number>;
  source_native_longest_px: number | null;
  source_derivation: EdgeQualityDerivation;
  source_note: string | null;
  upscale_factor: number | null;
  thresholds: { min_soft_edge_share: number; binary_alpha_min_longest_px: number; max_stair_step_score: number; min_source_native_px: number };
  reasons: string[];
};

export type EdgeQualitySourceInfo = { source_native_longest_px?: number | null; derivation?: EdgeQualityDerivation | null; note?: string | null };

/** Contour run lengths of the binarized alpha mask: straight top/bottom edge segments along rows and left/right segments along columns. Exported for tests. */
export function contourRunLengths(alpha: Uint8Array | Buffer, width: number, height: number, threshold = 128): number[] {
  const m = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && alpha[y * width + x] >= threshold;
  const runs: number[] = [];
  for (let y = 0; y < height; y += 1) {
    let top = 0; let bottom = 0;
    for (let x = 0; x <= width; x += 1) {
      const inside = x < width && m(x, y);
      const t = inside && !m(x, y - 1);
      const b = inside && !m(x, y + 1);
      if (t) top += 1; else if (top) { runs.push(top); top = 0; }
      if (b) bottom += 1; else if (bottom) { runs.push(bottom); bottom = 0; }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let left = 0; let right = 0;
    for (let y = 0; y <= height; y += 1) {
      const inside = y < height && m(x, y);
      const l = inside && !m(x - 1, y);
      const r = inside && !m(x + 1, y);
      if (l) left += 1; else if (left) { runs.push(left); left = 0; }
      if (r) right += 1; else if (right) { runs.push(right); right = 0; }
    }
  }
  return runs;
}

export async function assessEdgeQuality(file: string, source: EdgeQualitySourceInfo = {}): Promise<EdgeQualityResult> {
  const thresholds = { min_soft_edge_share: EQ.min_soft_edge_share, binary_alpha_min_longest_px: EQ.binary_alpha_min_longest_px, max_stair_step_score: EQ.max_stair_step_score, min_source_native_px: EQ.min_source_native_px };
  const derivation: EdgeQualityDerivation = source.derivation ?? 'unknown';
  const sourcePx = typeof source.source_native_longest_px === 'number' && Number.isFinite(source.source_native_longest_px) && source.source_native_longest_px > 0 ? Math.round(source.source_native_longest_px) : null;
  const base = {
    width: null, height: null, longest: null, alpha_levels: null, edge_pixels: 0, soft_edge_pixels: 0, soft_edge_share: null, contour_runs: 0, one_px_run_share: null, stair_step_score: null,
    run_length_histogram: {}, source_native_longest_px: sourcePx, source_derivation: derivation, source_note: source.note ?? null, upscale_factor: null, thresholds,
  };
  let rendered: { data: Buffer; info: { width: number; height: number; channels: number } };
  try {
    rendered = await sharp(path.resolve(file), { failOn: 'error' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    return { ...base, pass: false, verdict: 'edge_quality_unassessable', reasons: [error instanceof Error ? error.message : String(error)] };
  }
  const { data, info } = rendered;
  const width = info.width; const height = info.height; const channels = info.channels;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) alpha[i] = data[i * channels + 3];
  const a = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : alpha[y * width + x]);
  let edge = 0; let soft = 0;
  const levels = new Set<number>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = alpha[y * width + x];
      if (v === 0) continue;
      levels.add(v);
      const partial = v < 255;
      const touchesOutside = a(x - 1, y) === 0 || a(x + 1, y) === 0 || a(x, y - 1) === 0 || a(x, y + 1) === 0;
      if (partial || touchesOutside) { edge += 1; if (partial) soft += 1; }
    }
  }
  if (edge === 0) return { ...base, width, height, longest: Math.max(width, height), alpha_levels: 0, pass: false, verdict: 'edge_quality_unassessable', reasons: ['no opaque ink found'] };
  const runsAll = contourRunLengths(alpha, width, height);
  const runs = runsAll.filter((r) => r <= EQ.contour_run_cap_px);
  const histogram: Record<string, number> = {};
  for (const r of runs) histogram[String(r)] = (histogram[String(r)] ?? 0) + 1;
  const onePx = runs.length ? (histogram['1'] ?? 0) / runs.length : null;
  const stair = onePx === null ? null : round(1 - onePx, 4);
  const longest = Math.max(width, height);
  const softShare = round(soft / edge, 4);
  const upscale = sourcePx ? round(longest / sourcePx, 3) : null;
  const reasons: string[] = [];
  let verdict: EdgeQualityResult['verdict'] = 'ok';
  if (softShare < EQ.min_soft_edge_share && longest < EQ.binary_alpha_min_longest_px) {
    verdict = 'binary_alpha';
    reasons.push(`alpha is binary (soft edge share ${softShare}, ${levels.size} alpha level${levels.size === 1 ? '' : 's'}) on a ${longest}px file; under ${EQ.binary_alpha_min_longest_px}px every edge prints as a hard stair-step. Re-render with anti-aliased alpha (SVG -> 2x -> lanczos, alpha quantized) or ship at >= ${EQ.binary_alpha_min_longest_px}px.`);
  } else if (stair !== null && runs.length >= 50 && stair > EQ.max_stair_step_score) {
    verdict = 'stair_stepped';
    reasons.push(`contour is block-stepped: only ${Math.round((onePx ?? 0) * 100)}% of contour runs are 1px (stair_step_score ${stair} > ${EQ.max_stair_step_score}); this is the signature of a nearest-neighbour upscale. Re-cut from the native source.`);
  } else if (sourcePx !== null && sourcePx < EQ.min_source_native_px && (derivation === 'trace' || derivation === 'upscale')) {
    verdict = 'traced_from_small_source';
    reasons.push(`${derivation} from a ${sourcePx}px source (${upscale}x to ${longest}px); sources under ${EQ.min_source_native_px}px add wobble on curves. Exhaust references/logo-source-ladder.json before shipping; a human may override this verdict knowingly.`);
  }
  return {
    ...base,
    pass: verdict === 'ok',
    verdict,
    width, height, longest,
    alpha_levels: levels.size,
    edge_pixels: edge,
    soft_edge_pixels: soft,
    soft_edge_share: softShare,
    contour_runs: runs.length,
    one_px_run_share: onePx === null ? null : round(onePx, 4),
    stair_step_score: stair,
    run_length_histogram: histogram,
    upscale_factor: upscale,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// sticker-ground: a sticker / POP-on-white asset must be transparent-ground.
// An authored panel (The Place Pizza 2026-09-17: the copper panel lockup) is
// still a panel on a white sticker. Measures the opaque share of the ink
// bounding box and whether its four corners are opaque.
// ---------------------------------------------------------------------------
export type StickerGroundResult = {
  pass: boolean;
  verdict: 'ok' | 'opaque_panel_ground' | 'sticker_ground_unassessable';
  bbox: { left: number; top: number; width: number; height: number } | null;
  opaque_bbox_share: number | null;
  opaque_corners: number | null;
  reasons: string[];
};

export async function assessStickerGround(file: string): Promise<StickerGroundResult> {
  let rendered: { data: Buffer; info: { width: number; height: number; channels: number } };
  try {
    rendered = await sharp(path.resolve(file), { failOn: 'error' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    return { pass: false, verdict: 'sticker_ground_unassessable', bbox: null, opaque_bbox_share: null, opaque_corners: null, reasons: [error instanceof Error ? error.message : String(error)] };
  }
  const { data, info } = rendered;
  const W = info.width; const H = info.height; const C = info.channels;
  let left = W; let top = H; let right = -1; let bottom = -1;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    if (data[(y * W + x) * C + 3] > 0) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
  }
  if (right < 0) return { pass: false, verdict: 'sticker_ground_unassessable', bbox: null, opaque_bbox_share: null, opaque_corners: null, reasons: ['no ink found'] };
  const bw = right - left + 1; const bh = bottom - top + 1;
  let opaque = 0;
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) if (data[(y * W + x) * C + 3] >= SG.opaque_alpha) opaque += 1;
  const share = round(opaque / (bw * bh), 4);
  const inset = Math.max(1, Math.round(Math.min(bw, bh) * 0.02));
  const corners = [[left + inset, top + inset], [right - inset, top + inset], [left + inset, bottom - inset], [right - inset, bottom - inset]]
    .filter(([x, y]) => data[(y * W + x) * C + 3] >= SG.opaque_alpha).length;
  const panel = share >= SG.min_opaque_bbox_share && corners === 4;
  return {
    pass: !panel,
    verdict: panel ? 'opaque_panel_ground' : 'ok',
    bbox: { left, top, width: bw, height: bh },
    opaque_bbox_share: share,
    opaque_corners: corners,
    reasons: panel ? [`the ink bounding box is ${Math.round(share * 100)}% opaque with all four corners opaque: this is a panel, not a transparent-ground mark. Stickers and POP signs print on white; cut the mark from the source without its ground.`] : [],
  };
}

// ---------------------------------------------------------------------------
// sheet-viability: refuse a logo asset BEFORE variant-sheet.mjs renders it.
// Dogwood Pizza 2026-09-21: the sheet carried a "Do woo Pizza" auto cut (the
// agent marked it rejected and rendered it anyway) and a white-square lockup.
//   opaque_ground           the sticker-ground measurement on a card asset
//   wordmark_text_mismatch  a words-only cut that no longer reads what its
//                           source reads (OCR; letter-component fallback)
//   rejected_label          the label / note already says rejected
// ---------------------------------------------------------------------------
export type SheetViabilityVerdict = 'ok' | 'opaque_ground' | 'wordmark_text_mismatch' | 'rejected_label' | 'sheet_viability_unassessable';
export type SheetViabilityResult = {
  pass: boolean;
  verdict: SheetViabilityVerdict;
  blocks: SheetViabilityVerdict[];
  checks: {
    rejected_label: { checked: boolean; matched: string | null };
    opaque_ground: { checked: boolean; verdict: string | null; opaque_bbox_share: number | null; opaque_corners: number | null };
    wordmark: {
      checked: boolean;
      method: 'ocr' | 'components' | null;
      expected: string | null;
      source_read: string | null;
      cut_read: string | null;
      source_edit_distance: number | null;
      cut_edit_distance: number | null;
      maximum_edit_distance: number | null;
      source_glyphs: number | null;
      cut_glyphs: number | null;
      missing_glyphs: number | null;
      notes: string[];
    };
  };
  thresholds: typeof SV;
  reasons: string[];
};

export type SheetViabilityOptions = { source?: string | null; expected?: string | null; label?: string | null; note?: string | null };

/** Pure: does a row / cell label or note already say rejected? Exported so variant-sheet.mjs tests can cover it without an image. */
export function rejectedLabelMatch(...texts: Array<string | null | undefined>): string | null {
  const pattern = new RegExp(SV.rejected_label_pattern, 'i');
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const hit = pattern.exec(text);
    if (hit) return hit[0];
  }
  return null;
}

/** Letter-sized components on the tallest text line of an ink mask (the cut-words line rule, scale free). */
export function nameLineGlyphCount(mask: { pixels: Uint8Array; width: number; height: number }): { glyphs: number; line_median_height: number | null; components: number } {
  const components = connectedComponents(mask.pixels, mask.width, mask.height).filter((c) => c.pixels.length >= 4);
  if (!components.length) return { glyphs: 0, line_median_height: null, components: 0 };
  type Line = { members: Component[]; top: number; bottom: number; median: number; weighted: number };
  const lines: Line[] = [];
  const recompute = (line: Line) => {
    const heights = line.members.map((m) => m.height).sort((a, b) => a - b);
    line.median = heights[Math.floor(heights.length / 2)];
    const ink = line.members.reduce((sum, m) => sum + m.pixels.length, 0);
    line.weighted = line.members.reduce((sum, m) => sum + m.height * m.pixels.length, 0) / Math.max(1, ink);
  };
  for (const c of [...components].sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom))) {
    let placed: Line | null = null;
    for (const line of lines) {
      const overlap = Math.min(line.bottom, c.bottom) - Math.max(line.top, c.top) + 1;
      if (overlap > 0 && overlap / Math.max(1, Math.min(line.median, c.height)) >= 0.5) { placed = line; break; }
    }
    if (!placed) lines.push({ members: [c], top: c.top, bottom: c.bottom, median: c.height, weighted: c.height });
    else { placed.members.push(c); placed.top = Math.min(placed.top, c.top); placed.bottom = Math.max(placed.bottom, c.bottom); recompute(placed); }
  }
  // Word-like lines first (2+ members, or one wide joined script word); the tallest by ink-weighted height wins.
  const wordLike = lines.filter((l) => l.members.length >= 2 || l.members.some((m) => m.width / Math.max(1, m.height) >= 2));
  const pool = wordLike.length ? wordLike : lines;
  const line = pool.reduce((best, l) => (l.weighted > best.weighted ? l : best), pool[0]);
  const glyphs = line.members.filter((m) => m.height >= SV.glyph_min_height_ratio * line.median
    && m.height <= SV.glyph_max_height_ratio * line.median
    && m.width / Math.max(1, m.height) <= SV.glyph_max_aspect).length;
  return { glyphs, line_median_height: line.median, components: components.length };
}

// Ink mask for the OCR render: alpha >= 128 on a transparent file (the 64 floor loadInkMask uses for
// coverage fattens script strokes: the Dogwood source read "Doquood" at 64 and "Dogwood" at 128);
// the uniform-border silhouette otherwise.
async function loadOcrMask(file: string): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(path.resolve(file), { failOn: 'error' }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let transparent = 0;
  for (let offset = 3; offset < data.length; offset += channels) if (data[offset] < 250) transparent += 1;
  if (transparent / Math.max(1, width * height) < 0.001) return loadInkMask(file);
  const pixels = new Uint8Array(width * height);
  for (let pixel = 0, offset = 3; offset < data.length; pixel += 1, offset += channels) pixels[pixel] = data[offset] >= 128 ? 1 : 0;
  return { pixels, width, height };
}

// Tesseract read of an ink mask drawn black on white at SV.ocr_width_px (psm 7 then 6); null when tesseract is unavailable.
async function ocrInkMask(mask: { pixels: Uint8Array; width: number; height: number }, expected: string | null): Promise<string | null> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boostly-sheet-viability-'));
  try {
    const rgb = Buffer.alloc(mask.width * mask.height * 3, 255);
    for (let i = 0; i < mask.pixels.length; i += 1) if (mask.pixels[i]) { rgb[i * 3] = 0; rgb[i * 3 + 1] = 0; rgb[i * 3 + 2] = 0; }
    const file = path.join(directory, 'ocr.png');
    await sharp(rgb, { raw: { width: mask.width, height: mask.height, channels: 3 } })
      .resize({ width: SV.ocr_width_px })
      .extend({ top: SV.ocr_pad_px, bottom: SV.ocr_pad_px, left: SV.ocr_pad_px, right: SV.ocr_pad_px, background: '#FFFFFF' })
      .png()
      .toFile(file);
    let best: string | null = null;
    let sawSuccess = false;
    for (const psm of ['7', '6']) {
      const result = spawnSync('/opt/homebrew/bin/tesseract', [file, 'stdout', '--psm', psm], { encoding: 'utf8', timeout: 15_000 });
      if (result.error || result.status !== 0) continue;
      sawSuccess = true;
      const candidate = result.stdout.trim();
      if (best === null) { best = candidate; continue; }
      const better = expected
        ? levenshtein(normalizeOcrText(expected), normalizeOcrText(candidate)) < levenshtein(normalizeOcrText(expected), normalizeOcrText(best))
        : normalizeOcrText(candidate).length > normalizeOcrText(best).length;
      if (better) best = candidate;
    }
    return sawSuccess ? (best ?? '') : null;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function assessSheetViability(file: string, options: SheetViabilityOptions = {}): Promise<SheetViabilityResult> {
  const reasons: string[] = [];
  const blocks: SheetViabilityVerdict[] = [];
  const result: SheetViabilityResult = {
    pass: false,
    verdict: 'ok',
    blocks,
    checks: {
      rejected_label: { checked: false, matched: null },
      opaque_ground: { checked: false, verdict: null, opaque_bbox_share: null, opaque_corners: null },
      wordmark: { checked: false, method: null, expected: options.expected ?? null, source_read: null, cut_read: null, source_edit_distance: null, cut_edit_distance: null, maximum_edit_distance: null, source_glyphs: null, cut_glyphs: null, missing_glyphs: null, notes: [] },
    },
    thresholds: SV,
    reasons,
  };

  // (3) rejected label: the cheapest check, and the one the Dogwood agent bypassed by marking after rendering.
  result.checks.rejected_label.checked = true;
  const matched = rejectedLabelMatch(options.label, options.note);
  if (matched) {
    result.checks.rejected_label.matched = matched;
    blocks.push('rejected_label');
    reasons.push(`the label/provenance says "${matched}": a cell you already consider rejected is not added to the sheet`);
  }

  // (1) opaque ground: an opaque panel on a colored card prints as a white square (Dogwood P-T).
  let unassessable: string | null = null;
  try {
    const ground = await assessStickerGround(file);
    result.checks.opaque_ground = { checked: true, verdict: ground.verdict, opaque_bbox_share: ground.opaque_bbox_share, opaque_corners: ground.opaque_corners };
    if (ground.verdict === 'opaque_panel_ground') {
      blocks.push('opaque_ground');
      reasons.push(`opaque ground: the ink bounding box is ${Math.round((ground.opaque_bbox_share ?? 0) * 100)}% opaque with all four corners opaque; on a colored card this renders as a solid square, not a mark. Cut the mark from its ground (transparent PNG) before adding it.`);
    } else if (ground.verdict === 'sticker_ground_unassessable') {
      unassessable = ground.reasons.join('; ') || 'no ink';
    }
  } catch (error) {
    unassessable = error instanceof Error ? error.message : String(error);
  }

  // (2) wordmark text mismatch: only when the cut's source is known.
  if (options.source) {
    const wm = result.checks.wordmark;
    wm.checked = true;
    try {
      const [sourceMask, cutMask] = await Promise.all([loadInkMask(options.source), loadInkMask(file)]);
      const expected = options.expected ? normalizeOcrText(options.expected) : '';
      let decided = false;
      if (expected) {
        const [sourceRead, cutRead] = await Promise.all([loadOcrMask(options.source).then((m) => ocrInkMask(m, options.expected ?? null)), loadOcrMask(file).then((m) => ocrInkMask(m, options.expected ?? null))]);
        if (sourceRead === null || cutRead === null) {
          wm.notes.push('tesseract_unavailable');
        } else {
          wm.source_read = sourceRead;
          wm.cut_read = cutRead;
          wm.maximum_edit_distance = Math.max(TL.min_max_edit_distance, Math.floor(expected.length * TL.max_edit_distance_ratio));
          wm.source_edit_distance = levenshtein(expected, normalizeOcrText(sourceRead));
          wm.cut_edit_distance = levenshtein(expected, normalizeOcrText(cutRead));
          if (wm.source_edit_distance <= wm.maximum_edit_distance) {
            wm.method = 'ocr';
            decided = true;
            if (wm.cut_edit_distance > wm.maximum_edit_distance) {
              blocks.push('wordmark_text_mismatch');
              reasons.push(`wordmark text mismatch: the source reads "${sourceRead}" (edit distance ${wm.source_edit_distance} from "${options.expected}") but the cut reads "${cutRead}" (edit distance ${wm.cut_edit_distance}, maximum ${wm.maximum_edit_distance}); the cut dropped part of the name.`);
            }
          } else {
            wm.notes.push('source_ocr_unreadable_stylized_script');
          }
        }
      } else {
        wm.notes.push('no_expected_text');
      }
      if (!decided) {
        // Fallback: count letter-sized components on the name line of each file; a cut may not lose any.
        wm.method = 'components';
        const src = nameLineGlyphCount(sourceMask);
        const cut = nameLineGlyphCount(cutMask);
        wm.source_glyphs = src.glyphs;
        wm.cut_glyphs = cut.glyphs;
        wm.missing_glyphs = Math.max(0, src.glyphs - cut.glyphs);
        if (wm.missing_glyphs > SV.max_missing_glyph_components) {
          blocks.push('wordmark_text_mismatch');
          reasons.push(`wordmark text mismatch: the source name line has ${src.glyphs} letter-sized components and the cut has ${cut.glyphs} (${wm.missing_glyphs} missing, at most ${SV.max_missing_glyph_components} allowed); the cut dropped part of the name.`);
        }
      }
    } catch (error) {
      wm.notes.push(`wordmark_unassessable: ${error instanceof Error ? error.message : String(error)}`);
      if (!unassessable) unassessable = `wordmark check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (blocks.length) {
    result.verdict = blocks[0];
    result.pass = false;
  } else if (unassessable) {
    result.verdict = 'sheet_viability_unassessable';
    result.pass = false;
    reasons.push(`not assessable: ${unassessable}`);
  } else {
    result.verdict = 'ok';
    result.pass = true;
  }
  return result;
}

export async function assessRenderLegibility(
  file: string,
  options: { background?: string; cropOut?: string } = {},
): Promise<RenderLegibilityResult> {
  let source: InkMask;
  try {
    source = await loadInkMask(file);
  } catch (error) {
    return {
      pass: false,
      verdict: 'render_legibility_unassessable',
      product_logo_box: BADGE_LOGO_BOX,
      proxy: {
        limitation: proxyLimitation(),
        edge_energy: 0,
        minimum_substantial_component_height_px: null,
        small_component_ink_share: 0,
        tiny_text_ink_share: 0,
        ink_pixel_share: 0,
      },
      attach_4x_crop_required: false,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }

  // Tiny-text share, measured at NATIVE resolution: ink in components whose
  // native height lands under 7px once the whole mark is fitted into the
  // 126x56 box (EST. lines, ring text, city lines, slice dots). This is a
  // property of the lockup, not of stroke weight, so it stays a hard failure.
  // The remaining product-size small-component ink comes from thin strokes
  // that fragment on downsampling (stylized script): informational only.
  const nativeBounds = inkBounds(source);
  const productScale = nativeBounds
    ? Math.min(BADGE_LOGO_BOX.width / nativeBounds.width, BADGE_LOGO_BOX.height / nativeBounds.height)
    : 1;
  const nativeComponents = connectedComponents(source.pixels, source.width, source.height);
  const nativeInk = Math.max(1, countInk(source.pixels));
  const tinyCandidates = nativeComponents
    .filter((component) => component.pixels.length * productScale * productScale >= 2)
    .filter((component) => component.height * productScale < PRODUCT_MIN_COMPONENT_HEIGHT);
  const tinyTextInkShare = tinyTextLineInk(tinyCandidates) / nativeInk;

  const productMask = fitMask(source, BADGE_LOGO_BOX.width, BADGE_LOGO_BOX.height);
  const components = connectedComponents(productMask.pixels, productMask.width, productMask.height)
    .filter((component) => component.pixels.length >= 2);
  const inkPixels = countInk(productMask.pixels);
  const smallInk = components
    .filter((component) => component.height < PRODUCT_MIN_COMPONENT_HEIGHT)
    .reduce((sum, component) => sum + component.pixels.length, 0);
  const substantial = components.filter((component) => component.pixels.length / Math.max(1, inkPixels) >= RL.substantial_component_min_ink_share);
  const smallComponentInkShare = smallInk / Math.max(1, inkPixels);
  const rendered = await sharp(path.resolve(file), { failOn: 'error' })
    .rotate()
    .resize(BADGE_LOGO_BOX.width, BADGE_LOGO_BOX.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const edgeEnergy = adaptiveLaplacianVariance(
    rendered.data,
    rendered.info.width,
    rendered.info.height,
    rendered.info.channels,
  );
  const reasons: string[] = [];
  const informational: string[] = [];
  if (inkPixels < RL.min_rendered_ink_px) reasons.push('logo_has_too_little_rendered_ink');
  if (tinyTextInkShare > PRODUCT_MAX_TINY_TEXT_INK_SHARE) {
    reasons.push('too_much_ink_collapses_below_7px_component_height');
  } else if (smallComponentInkShare > PRODUCT_MAX_SMALL_COMPONENT_INK_SHARE) {
    informational.push('thin_strokes_fragment_below_7px_at_product_size_stylized_script');
  }
  if (edgeEnergy < PRODUCT_MIN_EDGE_ENERGY) reasons.push('edge_energy_below_product_size_floor');

  let crop4x: string | undefined;
  if (options.cropOut) {
    crop4x = await writeProductBoxCrop(file, options.cropOut, options.background ?? '#990000');
  }
  const verdict = reasons.length ? 'illegible_at_product_size' : informational.length ? 'stylized_script_informational' : 'ok';
  return {
    pass: reasons.length === 0,
    verdict,
    product_logo_box: BADGE_LOGO_BOX,
    proxy: {
      limitation: proxyLimitation(),
      edge_energy: round(edgeEnergy, 3),
      minimum_substantial_component_height_px: substantial.length
        ? Math.min(...substantial.map((component) => component.height))
        : null,
      small_component_ink_share: round(smallComponentInkShare, 4),
      tiny_text_ink_share: round(tinyTextInkShare, 4),
      ink_pixel_share: round(inkPixels / (BADGE_LOGO_BOX.width * BADGE_LOGO_BOX.height), 4),
    },
    attach_4x_crop_required: verdict === 'stylized_script_informational',
    ...(crop4x ? { crop_4x: crop4x } : {}),
    reasons: [...reasons, ...informational],
  };
}

// Tiny TEXT is small components that sit in a horizontal line: at least three
// members with comparable heights (within 2.5x), vertically overlapping, and a
// line at least four times wider than tall (EST. lines, city lines, ring text
// arcs, taglines). Scattered small pieces (illustration crumbs, i-dots,
// apostrophes, waffle cells) are not text lines and do not count.
function tinyTextLineInk(components: Component[]): number {
  type Line = { members: Component[]; top: number; bottom: number; left: number; right: number; maxHeight: number };
  const lines: Line[] = [];
  const sorted = [...components].sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
  for (const component of sorted) {
    let placed: Line | undefined;
    for (const line of lines) {
      const overlap = Math.min(line.bottom, component.bottom) - Math.max(line.top, component.top) + 1;
      const shorter = Math.min(line.maxHeight, component.height);
      const comparable = Math.max(line.maxHeight, component.height) / Math.max(1, shorter) <= RL.tiny_line_height_ratio;
      if (overlap > 0 && overlap / Math.max(1, shorter) >= 0.5 && comparable) {
        placed = line;
        break;
      }
    }
    if (!placed) {
      lines.push({ members: [component], top: component.top, bottom: component.bottom, left: component.left, right: component.right, maxHeight: component.height });
    } else {
      placed.members.push(component);
      placed.top = Math.min(placed.top, component.top);
      placed.bottom = Math.max(placed.bottom, component.bottom);
      placed.left = Math.min(placed.left, component.left);
      placed.right = Math.max(placed.right, component.right);
      placed.maxHeight = Math.max(placed.maxHeight, component.height);
    }
  }
  return lines
    .filter((line) => line.members.length >= RL.tiny_line_min_members && (line.right - line.left + 1) >= RL.tiny_line_min_aspect * (line.bottom - line.top + 1))
    .reduce((sum, line) => sum + line.members.reduce((inner, m) => inner + m.pixels.length, 0), 0);
}

// 4x render of the 126x56 product logo box on the given card color (504x224):
// the artifact a stylized-script proposal attaches in place of a hold.
async function writeProductBoxCrop(file: string, out: string, background: string): Promise<string> {
  const scale = 4;
  const { r, g, b } = parseHexColor(background);
  const logo = await sharp(path.resolve(file), { failOn: 'error' })
    .rotate()
    .resize(BADGE_LOGO_BOX.width * scale, BADGE_LOGO_BOX.height * scale, {
      fit: 'contain',
      kernel: 'lanczos3',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const target = path.resolve(out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp({
    create: { width: BADGE_LOGO_BOX.width * scale, height: BADGE_LOGO_BOX.height * scale, channels: 4, background: { r, g, b, alpha: 1 } },
  })
    .composite([{ input: logo }])
    .png()
    .toFile(target);
  return target;
}

// Source overlay: bbox-aligned ink-mask IoU of a candidate (typically an
// imagegen knockout) against the deterministic knockout or the source ink
// mask, both normalized to 800px wide, plus a component-count drift check
// that catches dropped apostrophes, dots, and invented outlines. Writes an
// optional overlay PNG (white = both, red = candidate only, blue = reference only).
export async function assessSourceOverlay(
  candidateFile: string,
  referenceFile: string,
  overlayOut?: string,
): Promise<SourceOverlayResult> {
  let candidate: InkMask;
  let reference: InkMask;
  try {
    [candidate, reference] = await Promise.all([loadInkMask(candidateFile), loadInkMask(referenceFile)]);
  } catch (error) {
    return {
      pass: false,
      verdict: 'source_overlay_unassessable',
      iou: 0,
      minimum_iou: SOURCE_OVERLAY_MIN_IOU,
      candidate_components: 0,
      reference_components: 0,
      component_drift: 1,
      maximum_component_drift: SOURCE_OVERLAY_MAX_COMPONENT_DRIFT,
      aspect_candidate: 0,
      aspect_reference: 0,
      best_shift_px: { dx: 0, dy: 0 },
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
  const cb = inkBounds(candidate);
  const rb = inkBounds(reference);
  if (!cb || !rb) {
    return {
      pass: false,
      verdict: 'source_overlay_unassessable',
      iou: 0,
      minimum_iou: SOURCE_OVERLAY_MIN_IOU,
      candidate_components: 0,
      reference_components: 0,
      component_drift: 1,
      maximum_component_drift: SOURCE_OVERLAY_MAX_COMPONENT_DRIFT,
      aspect_candidate: 0,
      aspect_reference: 0,
      best_shift_px: { dx: 0, dy: 0 },
      reasons: ['no_ink_in_candidate_or_reference'],
    };
  }
  const width = SOURCE_OVERLAY_WIDTH;
  const height = Math.max(1, Math.round((width * rb.height) / rb.width));
  const b = fitMask(reference, width, height);
  // Bbox fit, then a small shift search (up to 4% of width, 4% of height) so a
  // stray edge pixel or a slightly longer swash does not skew the whole overlay.
  const fitted = fitMask(candidate, width, height);
  let best = { iou: -1, dx: 0, dy: 0 };
  const stepX = Math.max(1, Math.round(width * 0.005));
  const stepY = Math.max(1, Math.round(height * 0.005));
  for (let dy = -4 * stepY; dy <= 4 * stepY; dy += stepY) {
    for (let dx = -4 * stepX; dx <= 4 * stepX; dx += stepX) {
      let both = 0;
      let either = 0;
      for (let y = 0; y < height; y += 1) {
        const sy = y - dy;
        for (let x = 0; x < width; x += 1) {
          const sx = x - dx;
          const cand = sx >= 0 && sy >= 0 && sx < width && sy < height ? fitted.pixels[sy * width + sx] : 0;
          const ref = b.pixels[y * width + x];
          if (cand && ref) both += 1;
          if (cand || ref) either += 1;
        }
      }
      const value = both / Math.max(1, either);
      if (value > best.iou) best = { iou: value, dx, dy };
    }
  }
  const iou = best.iou;
  const a: InkMask = { ...fitted, pixels: new Uint8Array(width * height) };
  for (let y = 0; y < height; y += 1) {
    const sy = y - best.dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sx = x - best.dx;
      if (sx < 0 || sx >= width) continue;
      a.pixels[y * width + x] = fitted.pixels[sy * width + sx];
    }
  }
  const minimumPixels = 2;
  const candidateComponents = connectedComponents(a.pixels, width, height).filter((c) => c.pixels.length >= minimumPixels).length;
  const referenceComponents = connectedComponents(b.pixels, width, height).filter((c) => c.pixels.length >= minimumPixels).length;
  const drift = Math.abs(candidateComponents - referenceComponents) / Math.max(1, referenceComponents);
  const reasons: string[] = [];
  if (iou < SOURCE_OVERLAY_MIN_IOU) reasons.push('redrawn_low_overlap');
  if (drift > SOURCE_OVERLAY_MAX_COMPONENT_DRIFT) reasons.push('component_count_drift');
  let overlay: string | undefined;
  if (overlayOut) {
    const rgb = Buffer.alloc(width * height * 3, 0);
    for (let index = 0; index < a.pixels.length; index += 1) {
      const x = a.pixels[index];
      const y = b.pixels[index];
      const offset = index * 3;
      if (x && y) { rgb[offset] = 255; rgb[offset + 1] = 255; rgb[offset + 2] = 255; }
      else if (x) { rgb[offset] = 255; rgb[offset + 1] = 60; rgb[offset + 2] = 60; }
      else if (y) { rgb[offset] = 60; rgb[offset + 1] = 140; rgb[offset + 2] = 255; }
    }
    overlay = path.resolve(overlayOut);
    fs.mkdirSync(path.dirname(overlay), { recursive: true });
    await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toFile(overlay);
  }
  return {
    pass: reasons.length === 0,
    verdict: reasons.length === 0 ? 'ok' : (reasons[0] as SourceOverlayResult['verdict']),
    iou: round(iou, 4),
    minimum_iou: SOURCE_OVERLAY_MIN_IOU,
    candidate_components: candidateComponents,
    reference_components: referenceComponents,
    component_drift: round(drift, 4),
    maximum_component_drift: SOURCE_OVERLAY_MAX_COMPONENT_DRIFT,
    aspect_candidate: round(cb.width / cb.height, 3),
    aspect_reference: round(rb.width / rb.height, 3),
    best_shift_px: { dx: best.dx, dy: best.dy },
    ...(overlay ? { overlay } : {}),
    reasons,
  };
}

// Single-ink knockout detection (2026-09-17 scoping): the counter census counts alpha holes, which
// only means "filled counters" when the letters are cut from one ink. An alpha-keyed asset whose
// opaque pixels are one color (within the registry tolerance) is a knockout; anything else is
// full-color art and the census is not applicable. An explicit treatment from the run wins.
export async function detectSingleInkKnockout(file: string): Promise<{ knockout: boolean; opaque_pixels: number; single_ink_share: number; median_ink: string | null; mode: InkMask['mode'] | null }> {
  const result = await sharp(path.resolve(file), { failOn: 'error' }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = result.info;
  let transparent = 0;
  for (let offset = 0; offset < result.data.length; offset += channels) if (result.data[offset + 3] < 250) transparent += 1;
  if (transparent / Math.max(1, width * height) < 0.001) return { knockout: false, opaque_pixels: 0, single_ink_share: 0, median_ink: null, mode: 'uniform_border' };
  const rs: number[] = []; const gs: number[] = []; const bs: number[] = [];
  for (let offset = 0; offset < result.data.length; offset += channels) {
    if (result.data[offset + 3] < 200) continue;
    rs.push(result.data[offset]); gs.push(result.data[offset + 1]); bs.push(result.data[offset + 2]);
  }
  if (!rs.length) return { knockout: false, opaque_pixels: 0, single_ink_share: 0, median_ink: null, mode: 'alpha' };
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const mr = median(rs); const mg = median(gs); const mb = median(bs);
  let near = 0;
  for (let index = 0; index < rs.length; index += 1) {
    if (Math.sqrt((rs[index] - mr) ** 2 + (gs[index] - mg) ** 2 + (bs[index] - mb) ** 2) <= TL.knockout_single_ink_max_rgb_distance) near += 1;
  }
  const share = near / rs.length;
  return { knockout: share >= TL.knockout_single_ink_min_share, opaque_pixels: rs.length, single_ink_share: round(share, 4), median_ink: `#${[mr, mg, mb].map((v) => v.toString(16).padStart(2, '0')).join('')}`, mode: 'alpha' };
}

export async function assessTextLegibility(
  file: string,
  expectedText: string,
  background = '#990000',
  sourceFile?: string,
  options: { treatment?: 'knockout' | 'fullcolor' } = {},
): Promise<TextLegibilityResult> {
  const normalizedExpected = normalizeOcrText(expectedText);
  const maximumEditDistance = Math.max(TL.min_max_edit_distance, Math.floor(normalizedExpected.length * TL.max_edit_distance_ratio));
  if (!normalizedExpected) return unassessableTextLegibility(expectedText, maximumEditDistance, 'expected_text_is_empty');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boostly-logo-ocr-'));
  const renderedPath = path.join(directory, 'product-size.png');
  try {
    const parsedBackground = parseHexColor(background);
    const logo = await sharp(path.resolve(file), { failOn: 'error' })
      .rotate()
      .resize(BADGE_LOGO_BOX.width - TL.render_inset_px, BADGE_LOGO_BOX.height - TL.render_inset_px, { fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: BADGE_LOGO_BOX.width,
        height: BADGE_LOGO_BOX.height,
        channels: 4,
        background: { ...parsedBackground, alpha: 1 },
      },
    }).composite([{ input: logo, gravity: 'centre' }]).flatten({ background: parsedBackground }).png().toFile(renderedPath);

    // psm 7 assumes a single text line; a stacked two-line wordmark (State Fare
    // lesson, 2026-08-11) OCRs as empty under it. Try line mode first, then
    // block mode, and keep whichever recognition is closer to the expected name.
    let recognizedText = '';
    let sawSuccess = false;
    let lastError = '';
    for (const psm of ['7', '6']) {
      const result = spawnSync('/opt/homebrew/bin/tesseract', [renderedPath, 'stdout', '--psm', psm], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (result.error || result.status !== 0) {
        lastError = result.error?.message ?? result.stderr.trim() ?? `tesseract_exit_${result.status}`;
        continue;
      }
      sawSuccess = true;
      const candidate = result.stdout.trim();
      if (!recognizedText
        || levenshtein(normalizedExpected, normalizeOcrText(candidate)) < levenshtein(normalizedExpected, normalizeOcrText(recognizedText))) {
        recognizedText = candidate;
      }
    }
    if (!sawSuccess) {
      return unassessableTextLegibility(expectedText, maximumEditDistance, lastError || 'tesseract_failed');
    }
    const normalizedRecognized = normalizeOcrText(recognizedText);
    const editDistance = levenshtein(normalizedExpected, normalizedRecognized);
    let treatment: 'knockout' | 'fullcolor' | 'unknown' = options.treatment ?? 'unknown';
    let detection: Awaited<ReturnType<typeof detectSingleInkKnockout>> | null = null;
    if (treatment === 'unknown') {
      try { detection = await detectSingleInkKnockout(file); treatment = detection.knockout ? 'knockout' : 'fullcolor'; } catch { treatment = 'unknown'; }
    }
    const counterTopology: CounterTopologyResult = treatment === 'fullcolor'
      ? { pass: true, verdict: 'not_applicable_fullcolor', treatment, expected_counter_count: countExpectedCounters(normalizedExpected), detected_counter_count: null, minimum_detected_counter_count: 0, minimum_hole_area_px: null, reasons: [], ...(detection ? { single_ink_share: detection.single_ink_share, median_ink: detection.median_ink } : {}) } as CounterTopologyResult
      : { ...(await assessCounterTopology(file, normalizedExpected, sourceFile)), treatment, ...(detection ? { single_ink_share: detection.single_ink_share, median_ink: detection.median_ink } : {}) };
    if (!counterTopology.verdict) counterTopology.verdict = counterTopology.pass ? 'ok' : counterTopology.reasons.some((r) => r.startsWith('counter_topology_unassessable')) ? 'unassessable' : 'glyph_counters_filled';
    const reasons: string[] = [];
    const notes: string[] = [];
    let sourceOcrReadable: boolean | null = null;
    if (!normalizedRecognized || editDistance > maximumEditDistance) {
      // OCR is a proxy, and some authored display scripts (um.ma lesson,
      // 2026-08-11: hand-brush wordmark tesseract cannot read even at native
      // 934px) are categorically outside the engine's competence. When the
      // VERIFIED SOURCE at native size is equally unreadable, the spelling
      // failure carries no degradation signal; legibility is then carried by
      // render-legibility and source-relative counter topology, and the
      // limitation is surfaced as ocr_unassessable_stylized_script instead of
      // a hard failure. If the engine CAN read the source, a final-render miss
      // remains a real degradation signal and still fails.
      if (sourceFile) {
        const sourceRecognized = await recognizeAtNativeSize(sourceFile, directory);
        sourceOcrReadable = sourceRecognized === null
          ? null // tesseract errored: unknown, keep the hard failure below
          : levenshtein(normalizedExpected, normalizeOcrText(sourceRecognized)) <= maximumEditDistance;
      }
      if (sourceOcrReadable === false) {
        notes.push('ocr_unassessable_stylized_script');
      } else {
        reasons.push('expected_business_name_not_readable_at_126x56');
      }
    }
    reasons.push(...counterTopology.reasons);
    const verdict = reasons.includes('counter_bearing_glyphs_have_filled_interiors')
      ? 'glyph_counters_filled'
      : reasons.length
        ? 'business_name_unreadable_at_product_size'
        : 'ok';
    return {
      pass: reasons.length === 0,
      verdict,
      product_logo_box: BADGE_LOGO_BOX,
      expected_text: expectedText,
      recognized_text: recognizedText,
      normalized_expected: normalizedExpected,
      normalized_recognized: normalizedRecognized,
      edit_distance: editDistance,
      maximum_edit_distance: maximumEditDistance,
      source_ocr_readable: sourceOcrReadable,
      counter_topology: counterTopology,
      notes,
      reasons,
    };
  } catch (error) {
    return unassessableTextLegibility(
      expectedText,
      maximumEditDistance,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Enclosed-hole census used by counter topology; a "counter" here is a
// transparent region fully surrounded by ink (not touching the canvas border).
// Color-keyed counter census of a (possibly transparent) final: flatten on the
// SOURCE'S own ground color (Vino lesson, 2026-08-18: a white-ink mark
// flattened on white erases itself; the source census was measured against the
// source's red ground, so the final must be flattened onto that same ground for
// a like-for-like census) and apply the same border-distance ink rule used for
// opaque sources. Returns null when the flattened image has no usable
// uniform-border silhouette.
async function countEnclosedCountersColorKeyed(
  file: string,
  ground: { r: number; g: number; b: number } = { r: 255, g: 255, b: 255 },
): Promise<number | null> {
  try {
    const flat = await sharp(path.resolve(file), { failOn: 'error' })
      .rotate()
      .flatten({ background: ground })
      .removeAlpha()
      .png()
      .toBuffer();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boostly-counter-census-'));
    const flatPath = path.join(directory, 'flat.png');
    try {
      fs.writeFileSync(flatPath, flat);
      return (await countEnclosedCounters(flatPath)).count;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

async function countEnclosedCounters(file: string): Promise<{ count: number; minimumHoleArea: number }> {
  const mask = await loadInkMask(file);
  const bounds = inkBounds(mask);
  if (!bounds) throw new Error('logo_has_no_detectable_ink');
  const minimumHoleArea = Math.max(TL.counter_min_hole_area_px, Math.round(bounds.width * bounds.height * TL.counter_min_hole_area_share));
  const negativeSpace = Uint8Array.from(mask.pixels, (value) => value ? 0 : 1);
  const count = connectedComponents(negativeSpace, mask.width, mask.height, 4)
    .filter((component) => component.left > 0
      && component.top > 0
      && component.right < mask.width - 1
      && component.bottom < mask.height - 1
      && component.pixels.length >= minimumHoleArea)
    .length;
  return { count, minimumHoleArea };
}

// Optional sourceFile (Hooligan's 2026-08-11 lesson): some authored display
// faces draw counters OPEN, the negative space of "oo"/"A" connects to the
// exterior through channels between letterforms, so the absolute
// expected-from-name minimum can never be met even though nothing is filled.
// When a VERIFIED first-party or human-supplied source is supplied, the
// requirement becomes "no decrease from the source's own enclosed-counter
// count". A malformed generated asset must never be its own source (that was
// the Nonna failure mode); the caller vouches for provenance.
export async function assessCounterTopology(file: string, expectedText: string, sourceFile?: string): Promise<CounterTopologyResult> {
  const expectedCounterCount = countExpectedCounters(normalizeOcrText(expectedText));
  const minimumDetectedCounterCount = expectedCounterCount ? Math.max(1, Math.ceil(expectedCounterCount * TL.counter_expected_min_ratio)) : 0;
  if (!expectedCounterCount) {
    return {
      pass: true,
      expected_counter_count: 0,
      detected_counter_count: 0,
      minimum_detected_counter_count: 0,
      minimum_hole_area_px: null,
      reasons: [],
    };
  }

  try {
    const { count: detectedCounterCount, minimumHoleArea } = await countEnclosedCounters(file);
    let sourceDetected: number | null = null;
    let pass = detectedCounterCount >= minimumDetectedCounterCount;
    if (!pass && sourceFile) {
      sourceDetected = (await countEnclosedCounters(sourceFile)).count;
      pass = detectedCounterCount >= sourceDetected;
      // Mode-matched fallback (Papa's Raw Bar lesson, 2026-08-11): an opaque
      // source is censused with a color-keyed mask (white counters on ink count
      // as holes) while a transparent final is censused by alpha (only true
      // holes count). When a treatment preserves the authored interior, e.g.
      // outer-canvas-only removal keeping a white disc, those color-keyed
      // counters still exist as color contrast but not as alpha holes, and the
      // cross-mode comparison false-fails. Recompute the FINAL's census under
      // the SAME color-keyed convention (flattened on the source's ground) and
      // compare like with like. A treatment that genuinely fills a counter
      // with ink still fails: the color-keyed census drops either way.
      if (!pass) {
        const matched = await countEnclosedCountersColorKeyed(file, await sourceGroundColor(sourceFile));
        if (matched !== null && matched >= sourceDetected) {
          pass = true;
        }
      }
    }
    const reasons = pass ? [] : ['counter_bearing_glyphs_have_filled_interiors'];
    return {
      pass,
      expected_counter_count: expectedCounterCount,
      detected_counter_count: detectedCounterCount,
      minimum_detected_counter_count: minimumDetectedCounterCount,
      minimum_hole_area_px: minimumHoleArea,
      source_detected_counter_count: sourceDetected,
      reasons,
    };
  } catch (error) {
    return {
      pass: false,
      expected_counter_count: expectedCounterCount,
      detected_counter_count: null,
      minimum_detected_counter_count: minimumDetectedCounterCount,
      minimum_hole_area_px: null,
      reasons: [`counter_topology_unassessable:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export async function assessInkRetention(sourceFile: string, finalFile: string, options: { primary?: string | null } = {}): Promise<InkRetentionResult> {
  let source: InkMask;
  let final: InkMask;
  try {
    [source, final] = await Promise.all([loadInkMask(sourceFile), loadInkMask(finalFile)]);
  } catch (error) {
    return unassessableInkRetention(error instanceof Error ? error.message : String(error));
  }
  source = withoutPermittedBorderDust(source);
  final = withoutPermittedBorderDust(final);

  const sourceBounds = inkBounds(source);
  const finalBounds = inkBounds(final);
  if (!sourceBounds || !finalBounds) return unassessableInkRetention('source_or_final_has_no_detectable_ink');
  const sourceAspect = sourceBounds.width / sourceBounds.height;
  const finalAspect = finalBounds.width / finalBounds.height;
  if (Math.abs(Math.log(sourceAspect / finalAspect)) > IR.aspect_log_tolerance) {
    return {
      ...unassessableInkRetention('aligned_silhouette_aspect_ratio_changed'),
      verdict: 'authored_ink_lost',
      source_mode: source.mode,
      final_mode: final.mode,
    };
  }

  const alignedSource = normalizeMask(source, IR.normalize_px);
  const alignedFinal = normalizeMask(final, IR.normalize_px);
  const tolerantFinal = dilate(alignedFinal.pixels, alignedFinal.width, alignedFinal.height, 1);
  const sourceInk = countInk(alignedSource.pixels);
  let covered = 0;
  for (let index = 0; index < alignedSource.pixels.length; index += 1) {
    if (alignedSource.pixels[index] && tolerantFinal[index]) covered += 1;
  }
  const coverageRecall = covered / Math.max(1, sourceInk);
  // What was dropped: share of the uncovered source ink whose authored color is near-white.
  // Authored white that becomes negative space on a colored card (Coloradough snow caps,
  // 2026-09-18) is a recognizability call for a human; a vanished keyline, ring, or word is not.
  // Classification of the dropped ink (never of the recall itself) tolerates ONE SOURCE PIXEL of
  // edge drift: a small source upscaled into the 512 frame turns a 1px trace or resample slop into
  // several aligned pixels, and that rim is edge noise, not lost ink. The same radius is applied
  // to the white sub-mask so the anti-aliased rim of authored white counts as white.
  const sourceScale = Math.min((IR.normalize_px - 16) / sourceBounds.width, (IR.normalize_px - 16) / sourceBounds.height);
  const edgeRadius = Math.max(1, Math.ceil(sourceScale));
  const edgeTolerantFinal = edgeRadius === 1 ? tolerantFinal : dilate(alignedFinal.pixels, alignedFinal.width, alignedFinal.height, edgeRadius);
  const strictWhite = alignedSource.white;
  const sourceWhite = strictWhite ? dilate(strictWhite, alignedSource.width, alignedSource.height, edgeRadius) : undefined;
  const strictDark = alignedSource.dark;
  const sourceDark = strictDark ? dilate(strictDark, alignedSource.width, alignedSource.height, edgeRadius) : undefined;
  let uncovered = 0;
  let uncoveredWhite = 0;
  let uncoveredDark = 0;
  let uncoveredStrict = 0;
  let uncoveredWhiteStrict = 0;
  for (let index = 0; index < alignedSource.pixels.length; index += 1) {
    if (!alignedSource.pixels[index]) continue;
    if (!tolerantFinal[index]) {
      uncoveredStrict += 1;
      if (strictWhite && strictWhite[index]) uncoveredWhiteStrict += 1;
    }
    if (!edgeTolerantFinal[index]) {
      uncovered += 1;
      if (sourceWhite && sourceWhite[index]) uncoveredWhite += 1;
      if (sourceDark && sourceDark[index]) uncoveredDark += 1;
    }
  }
  const droppedInkWhiteShare = uncovered ? uncoveredWhite / uncovered : null;
  const droppedInkDarkShare = uncovered ? uncoveredDark / uncovered : null;
  // dark ground: does the card primary merge with the authored near-black ink?
  const primaryRgb = options.primary ? parseHexRgb(options.primary) : null;
  const darkColor = alignedSource.darkColor ?? null;
  const darkGround = primaryRgb && darkColor
    ? (() => {
      const contrast = contrastRatioRgb(primaryRgb, darkColor);
      return { primary: rgbToHex(primaryRgb), dark_color: rgbToHex(darkColor), contrast: round(contrast, 3), merges: contrast < INK_RETENTION_DARK_GROUND_MERGE_MAX_CONTRAST };
    })()
    : null;
  const droppedInkWhiteShareStrict = uncoveredStrict ? uncoveredWhiteStrict / uncoveredStrict : null;
  const components = connectedComponents(alignedSource.pixels, alignedSource.width, alignedSource.height);
  const vanishedDetailed = components
    .map((component) => {
      const overlap = component.pixels.reduce((sum, index) => sum + (tolerantFinal[index] ? 1 : 0), 0);
      const darkPixels = strictDark ? component.pixels.reduce((sum, index) => sum + (strictDark[index] ? 1 : 0), 0) : 0;
      return {
        ink_share: component.pixels.length / Math.max(1, sourceInk),
        overlap_recall: overlap / Math.max(1, component.pixels.length),
        dark_share: darkPixels / Math.max(1, component.pixels.length),
      };
    })
    .filter((component) => component.ink_share > INK_RETENTION_MAX_VANISHED_COMPONENT_SHARE && component.overlap_recall < IR.vanished_overlap_recall_below);
  const vanishedComponents = vanishedDetailed.map((component) => ({
    ink_share: round(component.ink_share, 4),
    overlap_recall: round(component.overlap_recall, 4),
  }));
  const reasons: string[] = [];
  if (coverageRecall < INK_RETENTION_MIN_RECALL) reasons.push(`coverage_recall_below_${INK_RETENTION_MIN_RECALL}`);
  if (vanishedComponents.length) reasons.push(`source_component_over_${INK_RETENTION_MAX_VANISHED_COMPONENT_SHARE}_ink_share_vanished`);
  // authored_white_dropped: only a recall shortfall made of authored white; a vanished
  // component of any color (a detached ring, keyline, or word) stays authored_ink_lost
  const whiteDropped = reasons.length > 0
    && vanishedComponents.length === 0
    && droppedInkWhiteShare !== null
    && droppedInkWhiteShare >= INK_RETENTION_AUTHORED_WHITE_DROPPED_MIN_SHARE;
  if (whiteDropped) reasons.push(`dropped_ink_is_authored_white_${INK_RETENTION_AUTHORED_WHITE_DROPPED_MIN_SHARE}`);
  // authored_dark_dropped (Cellblock Sips 2026-09-21): the recall shortfall, including any vanished
  // component, is authored near-black ink AND the card primary merges with that black (< 1.5:1), so
  // the dropped ink is the mark's own dark ground disappearing into the brand's dark card, not lost
  // logo. A vanished component of any other color, or a primary that contrasts with the black,
  // stays authored_ink_lost. Never reached without a primary.
  const darkDropped = reasons.length > 0
    && !whiteDropped
    && darkGround !== null
    && darkGround.merges
    && droppedInkDarkShare !== null
    && droppedInkDarkShare >= INK_RETENTION_AUTHORED_DARK_DROPPED_MIN_SHARE
    && vanishedDetailed.every((component) => component.dark_share >= INK_RETENTION_AUTHORED_DARK_DROPPED_MIN_SHARE);
  if (darkDropped) reasons.push(`dropped_ink_is_authored_dark_ground_${INK_RETENTION_AUTHORED_DARK_DROPPED_MIN_SHARE}_merging_with_primary_under_${INK_RETENTION_DARK_GROUND_MERGE_MAX_CONTRAST}`);
  // rebuilt_from_low_res_source (Toscana 2026-09-29): a larger rebuild of a tiny source whose only
  // failure is a recall shortfall no lower than the floor. Any vanished component stays hard.
  const lowResRebuild = reasons.length > 0
    && !whiteDropped
    && !darkDropped
    && vanishedComponents.length === 0
    && coverageRecall >= INK_RETENTION_LOW_RES_REBUILD_MIN_RECALL
    && Math.max(sourceBounds.width, sourceBounds.height) <= INK_RETENTION_LOW_RES_REBUILD_MAX_SOURCE_INK_PX
    && finalBounds.width >= INK_RETENTION_LOW_RES_REBUILD_MIN_UPSCALE * sourceBounds.width;
  if (lowResRebuild) reasons.push(`final_is_rebuild_of_source_under_${INK_RETENTION_LOW_RES_REBUILD_MAX_SOURCE_INK_PX}px_with_recall_at_least_${INK_RETENTION_LOW_RES_REBUILD_MIN_RECALL}`);

  return {
    pass: reasons.length === 0,
    verdict: reasons.length ? (whiteDropped ? 'authored_white_dropped' : darkDropped ? 'authored_dark_dropped' : lowResRebuild ? 'rebuilt_from_low_res_source' : 'authored_ink_lost') : 'ok',
    coverage_recall: round(coverageRecall, 4),
    dropped_ink_white_share: droppedInkWhiteShare === null ? null : round(droppedInkWhiteShare, 4),
    dropped_ink_white_share_strict: droppedInkWhiteShareStrict === null ? null : round(droppedInkWhiteShareStrict, 4),
    dropped_ink_edge_radius_px: edgeRadius,
    dropped_ink_dark_share: droppedInkDarkShare === null ? null : round(droppedInkDarkShare, 4),
    dark_ground: darkGround,
    source_component_count: components.length,
    vanished_components: vanishedComponents,
    source_ink_px: { width: sourceBounds.width, height: sourceBounds.height },
    final_ink_px: { width: finalBounds.width, height: finalBounds.height },
    source_mode: source.mode,
    final_mode: final.mode,
    thresholds: {
      minimum_coverage_recall: INK_RETENTION_MIN_RECALL,
      maximum_vanished_component_ink_share: INK_RETENTION_MAX_VANISHED_COMPONENT_SHARE,
      authored_white_dropped_min_share: INK_RETENTION_AUTHORED_WHITE_DROPPED_MIN_SHARE,
      authored_dark_dropped_min_share: INK_RETENTION_AUTHORED_DARK_DROPPED_MIN_SHARE,
      dark_ground_merge_max_contrast: INK_RETENTION_DARK_GROUND_MERGE_MAX_CONTRAST,
      low_res_rebuild_min_recall: INK_RETENTION_LOW_RES_REBUILD_MIN_RECALL,
      low_res_rebuild_max_source_ink_px: INK_RETENTION_LOW_RES_REBUILD_MAX_SOURCE_INK_PX,
      low_res_rebuild_min_upscale: INK_RETENTION_LOW_RES_REBUILD_MIN_UPSCALE,
    },
    reasons,
  };
}

export async function assessAuthoredColorRetention(
  sourceFile: string,
  finalFile: string,
): Promise<AuthoredColorRetentionResult> {
  try {
    const [source, final] = await Promise.all([
      normalizedRgba(sourceFile),
      normalizedRgba(finalFile),
    ]);
    let sourceInk = 0;
    let sourceChromatic = 0;
    let retainedChromatic = 0;
    for (let offset = 0; offset < source.length; offset += 4) {
      if (source[offset + 3] < ACR.alpha_min) continue;
      sourceInk += 1;
      const sourceSpread = Math.max(source[offset], source[offset + 1], source[offset + 2])
        - Math.min(source[offset], source[offset + 1], source[offset + 2]);
      if (sourceSpread < ACR.source_spread_min) continue;
      sourceChromatic += 1;
      if (final[offset + 3] < ACR.alpha_min) continue;
      const finalSpread = Math.max(final[offset], final[offset + 1], final[offset + 2])
        - Math.min(final[offset], final[offset + 1], final[offset + 2]);
      const distance = Math.sqrt(
        (source[offset] - final[offset]) ** 2
        + (source[offset + 1] - final[offset + 1]) ** 2
        + (source[offset + 2] - final[offset + 2]) ** 2,
      );
      if (finalSpread >= ACR.final_spread_min && distance <= ACR.max_rgb_distance) retainedChromatic += 1;
    }
    const sourceChromaticInkShare = sourceChromatic / Math.max(1, sourceInk);
    if (sourceChromaticInkShare < ACR.minimum_source_chromatic_ink_share) {
      return {
        pass: false,
        verdict: 'authored_color_retention_unassessable',
        source_chromatic_ink_share: round(sourceChromaticInkShare, 4),
        retained_chromatic_share: null,
        minimum_retained_chromatic_share: AUTHORED_COLOR_MIN_RETENTION,
        reasons: ['source_has_no_meaningful_authored_chromatic_treatment'],
      };
    }
    const retainedShare = retainedChromatic / Math.max(1, sourceChromatic);
    const pass = retainedShare >= AUTHORED_COLOR_MIN_RETENTION;
    return {
      pass,
      verdict: pass ? 'ok' : 'authored_color_treatment_lost',
      source_chromatic_ink_share: round(sourceChromaticInkShare, 4),
      retained_chromatic_share: round(retainedShare, 4),
      minimum_retained_chromatic_share: AUTHORED_COLOR_MIN_RETENTION,
      reasons: pass ? [] : ['authored_chromatic_fill_or_outline_treatment_collapsed'],
    };
  } catch (error) {
    return {
      pass: false,
      verdict: 'authored_color_retention_unassessable',
      source_chromatic_ink_share: null,
      retained_chromatic_share: null,
      minimum_retained_chromatic_share: AUTHORED_COLOR_MIN_RETENTION,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function normalizedRgba(file: string): Promise<Buffer> {
  return sharp(path.resolve(file), { failOn: 'error' })
    .rotate()
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(256, 256, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

function proxyLimitation(): string {
  return 'No OCR or semantic text map is available. This gate conservatively measures product-size component height and edge energy; it cannot identify which words are essential.';
}

async function loadInkMask(file: string): Promise<InkMask> {
  const result = await sharp(path.resolve(file), { failOn: 'error' })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = result.info;
  const pixels = new Uint8Array(width * height);
  let transparent = 0;
  for (let offset = 0; offset < result.data.length; offset += channels) {
    if (result.data[offset + 3] < 250) transparent += 1;
  }
  const hasTransparency = transparent / Math.max(1, width * height) >= 0.001;
  const white = new Uint8Array(width * height);
  const dark = new Uint8Array(width * height);
  const darkSum = { r: 0, g: 0, b: 0, n: 0 };
  const nearWhite = (offset: number) => result.data[offset] >= INK_RETENTION_NEAR_WHITE_MIN_CHANNEL
    && result.data[offset + 1] >= INK_RETENTION_NEAR_WHITE_MIN_CHANNEL
    && result.data[offset + 2] >= INK_RETENTION_NEAR_WHITE_MIN_CHANNEL;
  const nearBlack = (offset: number) => result.data[offset] <= INK_RETENTION_NEAR_BLACK_MAX_CHANNEL
    && result.data[offset + 1] <= INK_RETENTION_NEAR_BLACK_MAX_CHANNEL
    && result.data[offset + 2] <= INK_RETENTION_NEAR_BLACK_MAX_CHANNEL;
  const markDark = (pixel: number, offset: number) => {
    if (!nearBlack(offset)) return;
    dark[pixel] = 1;
    darkSum.r += result.data[offset]; darkSum.g += result.data[offset + 1]; darkSum.b += result.data[offset + 2]; darkSum.n += 1;
  };
  const darkColorOf = () => (darkSum.n ? { r: darkSum.r / darkSum.n, g: darkSum.g / darkSum.n, b: darkSum.b / darkSum.n } : null);
  if (hasTransparency) {
    for (let pixel = 0, offset = 0; offset < result.data.length; pixel += 1, offset += channels) {
      pixels[pixel] = result.data[offset + 3] >= 64 ? 1 : 0;
      if (pixels[pixel] && nearWhite(offset)) white[pixel] = 1;
      if (pixels[pixel]) markDark(pixel, offset);
    }
    if (!countInk(pixels)) throw new Error('transparent_logo_has_no_detectable_ink');
    return { width, height, pixels, mode: 'alpha', white, dark, darkColor: darkColorOf() };
  }

  const border = borderColor(result.data, width, height, channels);
  let ink = 0;
  for (let pixel = 0, offset = 0; offset < result.data.length; pixel += 1, offset += channels) {
    const distance = Math.sqrt(
      (result.data[offset] - border.r) ** 2
      + (result.data[offset + 1] - border.g) ** 2
      + (result.data[offset + 2] - border.b) ** 2,
    );
    if (distance >= 24) {
      pixels[pixel] = 1;
      ink += 1;
      if (nearWhite(offset)) white[pixel] = 1;
      markDark(pixel, offset);
    }
  }
  const share = ink / Math.max(1, width * height);
  if (share < 0.001 || share > 0.95) throw new Error('opaque_logo_has_no_uniform_border_silhouette');
  return { width, height, pixels, mode: 'uniform_border', white, dark, darkColor: darkColorOf() };
}

// Median border color of a source file (its authored ground), white fallback
// for transparent sources whose flattened border is white anyway.
async function sourceGroundColor(file: string): Promise<{ r: number; g: number; b: number }> {
  try {
    const { data, info } = await sharp(path.resolve(file), { failOn: 'error' })
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return borderColor(data, info.width, info.height, info.channels);
  } catch {
    return { r: 255, g: 255, b: 255 };
  }
}

function borderColor(data: Buffer, width: number, height: number, channels: number): { r: number; g: number; b: number } {
  const values: Array<[number, number, number]> = [];
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * channels;
    values.push([data[offset], data[offset + 1], data[offset + 2]]);
  };
  for (let x = 0; x < width; x += 1) {
    add(x, 0);
    if (height > 1) add(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    add(0, y);
    if (width > 1) add(width - 1, y);
  }
  const median = (index: number) => {
    const sorted = values.map((value) => value[index]).sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return { r: median(0), g: median(1), b: median(2) };
}

function fitMask(source: InkMask, targetWidth: number, targetHeight: number): InkMask {
  const bounds = inkBounds(source);
  if (!bounds) return { width: targetWidth, height: targetHeight, pixels: new Uint8Array(targetWidth * targetHeight), mode: source.mode };
  const scale = Math.min(targetWidth / bounds.width, targetHeight / bounds.height);
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  const left = Math.floor((targetWidth - width) / 2);
  const top = Math.floor((targetHeight - height) / 2);
  const pixels = new Uint8Array(targetWidth * targetHeight);
  const white = source.white ? new Uint8Array(targetWidth * targetHeight) : undefined;
  const dark = source.dark ? new Uint8Array(targetWidth * targetHeight) : undefined;
  for (let y = 0; y < height; y += 1) {
    const sourceY = bounds.top + Math.min(bounds.height - 1, Math.floor((y / height) * bounds.height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = bounds.left + Math.min(bounds.width - 1, Math.floor((x / width) * bounds.width));
      pixels[(top + y) * targetWidth + left + x] = source.pixels[sourceY * source.width + sourceX];
      if (white && source.white) white[(top + y) * targetWidth + left + x] = source.white[sourceY * source.width + sourceX];
      if (dark && source.dark) dark[(top + y) * targetWidth + left + x] = source.dark[sourceY * source.width + sourceX];
    }
  }
  return { width: targetWidth, height: targetHeight, pixels, mode: source.mode, ...(white ? { white } : {}), ...(dark ? { dark } : {}), darkColor: source.darkColor ?? null };
}

function normalizeMask(source: InkMask, target: number): InkMask {
  const fitted = fitMask(source, target - 16, target - 16);
  const pixels = new Uint8Array(target * target);
  const white = fitted.white ? new Uint8Array(target * target) : undefined;
  const dark = fitted.dark ? new Uint8Array(target * target) : undefined;
  for (let y = 0; y < fitted.height; y += 1) {
    for (let x = 0; x < fitted.width; x += 1) {
      pixels[(y + 8) * target + x + 8] = fitted.pixels[y * fitted.width + x];
      if (white && fitted.white) white[(y + 8) * target + x + 8] = fitted.white[y * fitted.width + x];
      if (dark && fitted.dark) dark[(y + 8) * target + x + 8] = fitted.dark[y * fitted.width + x];
    }
  }
  return { width: target, height: target, pixels, mode: source.mode, ...(white ? { white } : {}), ...(dark ? { dark } : {}), darkColor: fitted.darkColor ?? null };
}

function inkBounds(mask: InkMask): { left: number; top: number; width: number; height: number } | null {
  let left = mask.width;
  let right = -1;
  let top = mask.height;
  let bottom = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.pixels[y * mask.width + x]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left || bottom < top ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// connectivity: 8 (default) for ink components; pass 4 for NEGATIVE-SPACE
// censuses. Digital topology requires opposite connectivity for foreground and
// background, with 8-connected background, a single lighter antialias pixel
// on a thin outline opens a diagonal leak that merges an enclosed counter with
// the outside (Papa's Raw Bar lesson, 2026-08-11: an ESRGAN-smoothed final
// "lost" 6 of 21 counters that were all still enclosed under 4-connectivity).
function connectedComponents(pixels: Uint8Array, width: number, height: number, connectivity: 4 | 8 = 8): Component[] {
  const visited = new Uint8Array(pixels.length);
  const components: Component[] = [];
  for (let start = 0; start < pixels.length; start += 1) {
    if (!pixels[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    const indexes: number[] = [];
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    while (queue.length) {
      const index = queue.pop() as number;
      indexes.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          if (connectivity === 4 && dx !== 0 && dy !== 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (pixels[next] && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    components.push({
      pixels: indexes,
      width: right - left + 1,
      height: bottom - top + 1,
      left,
      right,
      top,
      bottom,
    });
  }
  return components;
}

function withoutPermittedBorderDust(mask: InkMask): InkMask {
  const components = connectedComponents(mask.pixels, mask.width, mask.height);
  const totalInk = Math.max(1, countInk(mask.pixels));
  const pixels = Uint8Array.from(mask.pixels);
  for (const component of components) {
    const touchesBorder = component.left === 0
      || component.top === 0
      || component.right === mask.width - 1
      || component.bottom === mask.height - 1;
    if (!touchesBorder || component.pixels.length / totalInk > INK_RETENTION_MAX_VANISHED_COMPONENT_SHARE) continue;
    for (const index of component.pixels) pixels[index] = 0;
  }
  return { ...mask, pixels };
}

function dilate(pixels: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!pixels[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const targetX = x + dx;
          const targetY = y + dy;
          if (targetX >= 0 && targetY >= 0 && targetX < width && targetY < height) {
            out[targetY * width + targetX] = 1;
          }
        }
      }
    }
  }
  return out;
}

function adaptiveLaplacianVariance(data: Buffer, width: number, height: number, channels: number): number {
  return Math.max(
    laplacianVariance(data, width, height, channels, 0),
    laplacianVariance(data, width, height, channels, 255),
  );
}

function laplacianVariance(data: Buffer, width: number, height: number, channels: number, matte: number): number {
  const gray = new Float64Array(width * height);
  for (let pixel = 0, offset = 0; offset < data.length; pixel += 1, offset += channels) {
    const alpha = channels >= 4 ? data[offset + 3] / 255 : 1;
    const luminance = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
    gray[pixel] = luminance * alpha + matte * (1 - alpha);
  }
  const values: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const center = y * width + x;
      values.push(
        gray[center - width] + gray[center - 1] - 4 * gray[center] + gray[center + 1] + gray[center + width],
      );
    }
  }
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function unassessableInkRetention(reason: string): InkRetentionResult {
  return {
    pass: false,
    verdict: 'ink_retention_unassessable',
    coverage_recall: null,
    dropped_ink_white_share: null,
    dropped_ink_white_share_strict: null,
    dropped_ink_edge_radius_px: null,
    dropped_ink_dark_share: null,
    dark_ground: null,
    source_component_count: null,
    vanished_components: [],
    source_mode: null,
    final_mode: null,
    thresholds: {
      minimum_coverage_recall: INK_RETENTION_MIN_RECALL,
      maximum_vanished_component_ink_share: INK_RETENTION_MAX_VANISHED_COMPONENT_SHARE,
      authored_white_dropped_min_share: INK_RETENTION_AUTHORED_WHITE_DROPPED_MIN_SHARE,
      authored_dark_dropped_min_share: INK_RETENTION_AUTHORED_DARK_DROPPED_MIN_SHARE,
      dark_ground_merge_max_contrast: INK_RETENTION_DARK_GROUND_MERGE_MAX_CONTRAST,
      low_res_rebuild_min_recall: INK_RETENTION_LOW_RES_REBUILD_MIN_RECALL,
      low_res_rebuild_max_source_ink_px: INK_RETENTION_LOW_RES_REBUILD_MAX_SOURCE_INK_PX,
      low_res_rebuild_min_upscale: INK_RETENTION_LOW_RES_REBUILD_MIN_UPSCALE,
    },
    reasons: [reason],
  };
}

// Best-case OCR of the verified source: native size, flattened on white, both
// psm modes. Returns null when tesseract itself errors (treated as unknown, so
// the caller keeps the hard failure rather than waiving it).
async function recognizeAtNativeSize(sourceFile: string, workDirectory: string): Promise<string | null> {
  try {
    const nativePath = path.join(workDirectory, 'source-native.png');
    await sharp(path.resolve(sourceFile), { failOn: 'error' })
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toFile(nativePath);
    let best: string | null = null;
    for (const psm of ['7', '6']) {
      const result = spawnSync('/opt/homebrew/bin/tesseract', [nativePath, 'stdout', '--psm', psm], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (result.error || result.status !== 0) continue;
      const candidate = result.stdout.trim();
      if (best === null || normalizeOcrText(candidate).length > normalizeOcrText(best).length) best = candidate;
    }
    return best;
  } catch {
    return null;
  }
}

function unassessableTextLegibility(
  expectedText: string,
  maximumEditDistance: number,
  reason: string,
): TextLegibilityResult {
  return {
    pass: false,
    verdict: 'text_legibility_unassessable',
    product_logo_box: BADGE_LOGO_BOX,
    expected_text: expectedText,
    recognized_text: '',
    normalized_expected: normalizeOcrText(expectedText),
    normalized_recognized: '',
    edit_distance: null,
    maximum_edit_distance: maximumEditDistance,
    counter_topology: {
      pass: false,
      expected_counter_count: countExpectedCounters(normalizeOcrText(expectedText)),
      detected_counter_count: null,
      minimum_detected_counter_count: 0,
      minimum_hole_area_px: null,
      reasons: ['counter_topology_not_run'],
    },
    reasons: [reason],
  };
}

function countExpectedCounters(normalizedText: string): number {
  const counters: Record<string, number> = { A: 1, B: 2, D: 1, O: 1, P: 1, Q: 1, R: 1, 0: 1, 6: 1, 8: 2, 9: 1 };
  return [...normalizedText].reduce((sum, character) => sum + (counters[character] ?? 0), 0);
}

function normalizeOcrText(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function parseHexColor(value: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) throw new Error(`invalid_background_hex:${value}`);
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
  };
}

function countInk(pixels: Uint8Array): number {
  return pixels.reduce((sum, value) => sum + (value ? 1 : 0), 0);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function parseArgs(argv: string[]): { command: string; args: Record<string, string> } {
  const [command, ...rest] = argv;
  if (!command || command.startsWith('--')) throw new Error('Usage: logo-quality-gates.ts <png-color-type|edge-quality|sticker-ground|sheet-viability|render-legibility|text-legibility|ink-retention|authored-color-retention|source-overlay> [options]');
  const args: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return { command, args };
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  let result: PngColorTypeResult | EdgeQualityResult | StickerGroundResult | SheetViabilityResult | RenderLegibilityResult | TextLegibilityResult | InkRetentionResult | AuthoredColorRetentionResult | SourceOverlayResult;
  if (command === 'png-color-type') {
    if (!args.logo) throw new Error('png-color-type requires --logo <file>');
    result = await assessPngColorType(args.logo);
  } else if (command === 'edge-quality') {
    if (!args.logo) throw new Error('edge-quality requires --logo <file> [--source-native-px <n>] [--derivation native|vector|trace|upscale]');
    const derivation = args.derivation as EdgeQualityDerivation | undefined;
    if (derivation && !['native', 'vector', 'trace', 'upscale', 'unknown'].includes(derivation)) throw new Error(`--derivation must be native|vector|trace|upscale, got ${derivation}`);
    result = await assessEdgeQuality(args.logo, { source_native_longest_px: args['source-native-px'] ? Number(args['source-native-px']) : null, derivation: derivation ?? null, note: args['source-note'] ?? null });
  } else if (command === 'sticker-ground') {
    if (!args.logo) throw new Error('sticker-ground requires --logo <file>');
    result = await assessStickerGround(args.logo);
  } else if (command === 'sheet-viability') {
    if (!args.logo) throw new Error('sheet-viability requires --logo <file> [--source <png>] [--expected <business-name>] [--label <text>] [--note <text>]');
    result = await assessSheetViability(args.logo, { source: args.source ?? null, expected: args.expected ?? null, label: args.label ?? null, note: args.note ?? null });
  } else if (command === 'render-legibility') {
    if (!args.logo) throw new Error('render-legibility requires --logo <file> [--background <hex>] [--crop-out <png>]');
    result = await assessRenderLegibility(args.logo, { background: args.background, cropOut: args['crop-out'] });
  } else if (command === 'text-legibility') {
    if (!args.logo || !args.expected) throw new Error('text-legibility requires --logo <file> --expected <business-name>');
    result = await assessTextLegibility(args.logo, args.expected, args.background ?? '#990000', args.source);
  } else if (command === 'ink-retention') {
    if (!args.source || !args.final) throw new Error('ink-retention requires --source <verified-source> --final <final-logo> [--primary <card hex>]');
    result = await assessInkRetention(args.source, args.final, { primary: args.primary ?? null });
  } else if (command === 'authored-color-retention') {
    if (!args.source || !args.final) throw new Error('authored-color-retention requires --source <verified-source> --final <final-logo>');
    result = await assessAuthoredColorRetention(args.source, args.final);
  } else if (command === 'source-overlay') {
    if (!args.candidate || !args.reference) throw new Error('source-overlay requires --candidate <png> --reference <deterministic-knockout-or-source> [--overlay-out <png>]');
    result = await assessSourceOverlay(args.candidate, args.reference, args['overlay-out']);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pass) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
