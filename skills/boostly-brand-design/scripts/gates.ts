#!/usr/bin/env node
// gates.ts: the data-driven gate runner, verdict, and replay for the brand-design pipeline.
// Every threshold and severity comes from ../references/gates.json (the registry); this file
// only wires tools to the registry and combines results with recorded overrides.
//
//   gates registry                                   print the registry summary (id, severity, override_allowed)
//   gates run --asset <png> [--run <run_dir>] [--color <hex>] [--expected <name>] [--source <png>]
//             [--gates a,b] [--laddered] [--crop-out <png>] [--force --reason "<why>"]
//                                                    run the battery, write fix/gates/<asset>/gate-*.json and
//                                                    the `gates` block of run.json (when --run is given)
//   gates verdict --run <run_dir> [--asset <png>] [--partial]
//                                                    combine gates + overrides: SHIP | SHIP-WITH-OVERRIDE | HOLD
//   gates check --asset <png> --color <hex> [--run <run_dir>] ...   run + verdict in one call (exit 2 on HOLD);
//                                                    this is what the write stage calls before a branding apply
//   gates replay [--root <spike dir>] [--since <date>] [--runs <glob>] [--gates a,b] [--baseline]
//                [--overrides <dir>] [--scratch <dir>] [--json <report.json>]
//                                                    rerun the current definitions against every shipped logo
//                                                    (read-only on the run dirs); BLOCK (exit 3) when a shipped
//                                                    asset now fails a block gate without an override record
//
// Rules enforced here:
// - an override is RECORDED data matched to (gate, asset); it never changes a threshold or severity;
// - a gate with override_allowed=false (or a verdict outside override_allowed_verdicts) refuses its override;
// - the replay is a regression stop that a human resolves (explicit override or revert the edit), never an auto-fix.
// Run with: node --experimental-strip-types gates.ts ...

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  GATES_JSON,
  assessEdgeQuality,
  assessPngColorType,
  assessRenderLegibility,
  assessStickerGround,
  assessTextLegibility,
  assessInkRetention,
  canonicalGateId,
  effectiveSeverity,
  gateDefinition,
  loadGateRegistry,
  type GateDefinition,
  type GateRegistry,
  type GateSeverity,
} from './logo-quality-gates.ts';
import { assessLogoSurface } from './validate-logo-surface.ts';
import { inferSourceForRun, type Derivation } from './logo-sources.ts';
import { assessLogoCrop } from './logo-crop.ts';
import {
  borderWhiteDustCheck,
  componentContrastCheck,
  countHoles,
  edgeBandLegibility,
  interiorFillCheck,
  shipResolutionGate,
  softFringeCheck,
  strokeAnalysis,
  whiteblobCheck,
} from '../harness/iterate-logo-rules.mjs';
import {
  RUN_FILE_NAME,
  asObject,
  migrateRun,
  readRun,
  runFileExists,
  runHasAppliedEvidence,
  setBlock,
  stringOrNull,
  stripNote,
  type JsonObject,
  type RunFile,
} from '../../boostly-box-fulfillment/scripts/run-file.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_JSON = path.resolve(HERE, '..', 'references', 'gates-baseline.json');
const DEFAULT_ROOT = process.env.BOOSTLY_RUN_ROOT || '/Users/travisse/Programming/projects/brand-design-spike-2026-07-06';
const DEFAULT_OCR_BACKGROUND = '#990000';

export type GateResult = {
  gate: string;
  asset: string;
  asset_sha256: string | null;
  pass: boolean | null;
  verdict: string | null;
  severity: GateSeverity;
  override_allowed: boolean;
  thresholds: Record<string, unknown>;
  inputs: Record<string, unknown>;
  file: string | null;
  result: JsonObject | null;
  at: string;
  registry_sha256: string;
  source: 'gates run';
};

export type OverrideRecord = { gate: string; asset: string; decided_by: string; reason: string; at: string } & JsonObject;

export type Verdict = {
  verdict: 'SHIP' | 'SHIP-WITH-OVERRIDE' | 'HOLD';
  assets: string[];
  reasons: string[];
  failing: Array<{ gate: string; asset: string; verdict: string | null; severity: GateSeverity }>;
  overridden: Array<{ gate: string; asset: string; verdict: string | null; override: { decided_by: string; reason: string; at: string } }>;
  refused: Array<{ gate: string; asset: string; verdict: string | null; why: string; override: { decided_by: string; reason: string; at: string } }>;
  warnings: Array<{ gate: string; asset: string; verdict: string | null }>;
  missing: string[];
  registry_sha256: string;
};

// ---------------------------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------------------------

export function registrySha256(): string {
  return crypto.createHash('sha256').update(fs.readFileSync(GATES_JSON)).digest('hex');
}

export function sha256File(file: string): string | null {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/** Schema check for gates.json; returns a list of problems (empty when valid). */
export function validateRegistry(registry: GateRegistry = loadGateRegistry()): string[] {
  const errors: string[] = [];
  if (registry.schema_version !== 1) errors.push('schema_version must be 1');
  if (!Array.isArray(registry.gates) || !registry.gates.length) errors.push('gates must be a non-empty array');
  const ids = new Set<string>();
  const severities: GateSeverity[] = ['block', 'warn', 'info'];
  const tools = ['harness', 'logo-quality-gates', 'validate-logo-surface', 'logo-crop', 'gates'];
  for (const gate of registry.gates ?? []) {
    const at = `gate "${gate?.id ?? '?'}"`;
    for (const key of ['id', 'name', 'tool', 'command', 'measures', 'pass_rule', 'severity', 'override_rationale', 'case_study'] as const) {
      if (typeof gate[key] !== 'string' || !gate[key]) errors.push(`${at}: ${key} must be a non-empty string`);
    }
    if (ids.has(gate.id)) errors.push(`${at}: duplicate id`);
    ids.add(gate.id);
    if (!/^[a-z][a-z0-9-]*$/.test(gate.id ?? '')) errors.push(`${at}: id must be kebab-case`);
    if (!severities.includes(gate.severity)) errors.push(`${at}: severity must be one of ${severities.join('|')}`);
    if (!tools.includes(gate.tool)) errors.push(`${at}: tool must be one of ${tools.join('|')}`);
    if (typeof gate.override_allowed !== 'boolean') errors.push(`${at}: override_allowed must be boolean`);
    if (gate.override_allowed_verdicts !== undefined && (!Array.isArray(gate.override_allowed_verdicts) || !gate.override_allowed_verdicts.length)) {
      errors.push(`${at}: override_allowed_verdicts must be a non-empty array when present`);
    }
    if (gate.override_allowed_verdicts && !gate.override_allowed) errors.push(`${at}: override_allowed_verdicts needs override_allowed=true`);
    if (gate.override_allowed_for_shipped !== undefined && typeof gate.override_allowed_for_shipped !== 'boolean') errors.push(`${at}: override_allowed_for_shipped must be boolean`);
    for (const [verdict, sev] of Object.entries(gate.severity_by_verdict ?? {})) if (!severities.includes(sev)) errors.push(`${at}: severity_by_verdict.${verdict} must be one of ${severities.join('|')}`);
    if (!Array.isArray(gate.inputs) || !gate.inputs.length) errors.push(`${at}: inputs must be a non-empty array`);
    if (gate.thresholds == null || typeof gate.thresholds !== 'object' || Array.isArray(gate.thresholds)) errors.push(`${at}: thresholds must be an object`);
    if (!(gate.battery === true || gate.battery === false || gate.battery === 'conditional')) errors.push(`${at}: battery must be true|false|"conditional"`);
    if (gate.battery !== true && !gate.when) errors.push(`${at}: a non-battery gate needs a "when"`);
  }
  if (registry.changelog !== undefined) {
    if (!Array.isArray(registry.changelog)) errors.push('changelog must be an array');
    else for (const [index, entry] of registry.changelog.entries()) {
      for (const key of ['date', 'gate', 'change', 'reason', 'decided_by'] as const) if (typeof entry?.[key] !== 'string' || !entry[key]) errors.push(`changelog[${index}]: ${key} must be a non-empty string`);
      if (entry?.date && !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) errors.push(`changelog[${index}]: date must be YYYY-MM-DD`);
    }
  }
  for (const [alias, target] of Object.entries(registry.aliases ?? {})) {
    if (!ids.has(target)) errors.push(`alias "${alias}" points at unknown gate "${target}"`);
    if (ids.has(alias)) errors.push(`alias "${alias}" shadows a gate id`);
  }
  return errors;
}

function overrideAllowedFor(def: GateDefinition | null, verdict: string | null, record: JsonObject | null = null, shipped = false): { ok: boolean; why: string | null } {
  if (!def) return { ok: false, why: 'gate is not in the registry' };
  if (!def.override_allowed) {
    // shipped path: the record was made with --shipped AND the run proves the asset is live
    if (def.override_allowed_for_shipped && record?.shipped_asset === true && shipped) return { ok: true, why: null };
    if (def.override_allowed_for_shipped && record?.shipped_asset === true) return { ok: false, why: `${def.id} override is marked shipped_asset but this run has no proof the asset is live` };
    return { ok: false, why: `${def.id} is not overridable (override_allowed=false${def.override_allowed_for_shipped ? '; only on an already-live asset via run-file override --shipped' : ''}); change the rule by editing gates.json deliberately` };
  }
  if (def.override_allowed_verdicts && !(verdict && def.override_allowed_verdicts.includes(verdict))) {
    // the shipped path also covers a verdict outside override_allowed_verdicts (logo-crop excess_canvas_padding on a live asset)
    if (def.override_allowed_for_shipped && record?.shipped_asset === true && shipped) return { ok: true, why: null };
    return { ok: false, why: `${def.id} verdict "${verdict ?? 'unknown'}" is not overridable (allowed: ${def.override_allowed_verdicts.join(', ')}${def.override_allowed_for_shipped ? '; on an already-live asset via run-file override --shipped' : ''})` };
  }
  return { ok: true, why: null };
}

// ---------------------------------------------------------------------------------------------
// Running the battery
// ---------------------------------------------------------------------------------------------

export type RunContext = {
  asset: string;             // absolute path of the logo file
  primary?: string | null;   // card web primary hex
  expected?: string | null;  // business name expected on the asset (OCR)
  treatment?: 'knockout' | 'fullcolor' | null; // explicit human-given treatment for the counter census; detected when absent
  treatment_hint?: 'knockout' | 'fullcolor' | null; // what the run's variant cell says; recorded only
  source?: string | null;    // verified source for ink-retention
  laddered?: boolean;        // the file was reduced by the byte ladder
  cropOut?: string | null;   // render-legibility 4x crop path
  sourceNativePx?: number | null; // edge-quality: longest side of the verified native source
  derivation?: Derivation | null; // edge-quality: how the final was made from that source
  sourceNote?: string | null;     // edge-quality: where the source figure came from (recorded only)
  surface?: 'card' | 'sticker' | null; // sticker: also run the sticker-ground gate (POP/sticker on white)
};

type Adapter = {
  needs: (ctx: RunContext) => string | null; // reason the gate cannot run in this context, or null
  run: (ctx: RunContext, thresholds: Record<string, unknown>) => Promise<{ result: JsonObject; pass: boolean | null; verdict: string | null }>;
};

const verdictOk = (result: JsonObject): boolean => result.verdict === 'ok';
/** WCAG 2 contrast ratio of a hex color against white. */
export function contrastVsWhite(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`primary must be a six-digit hex, got ${hex}`);
  const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return (1 + 0.05) / (lum + 0.05);
}
const passOf = (result: JsonObject): boolean | null => (typeof result.pass === 'boolean' ? result.pass : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const ADAPTERS: Record<string, Adapter> = {
  'ship-gate': {
    needs: () => null,
    run: async (ctx) => { const result = await shipResolutionGate(ctx.asset) as JsonObject; return { result, pass: passOf(result), verdict: str(result.verdict) }; },
  },
  'border-dust': {
    needs: () => null,
    run: async (ctx) => { const result = await borderWhiteDustCheck(ctx.asset) as JsonObject; return { result, pass: passOf(result), verdict: str(result.note) }; },
  },
  'soft-fringe': {
    needs: () => null,
    run: async (ctx) => { const result = await softFringeCheck(ctx.asset) as JsonObject; return { result, pass: verdictOk(result), verdict: str(result.verdict) }; },
  },
  holes: {
    needs: () => null,
    run: async (ctx, t) => {
      const result = await countHoles(ctx.asset) as JsonObject;
      const pass = Number(result.holes) >= Number(t.minHoles ?? 1);
      return { result, pass, verdict: pass ? 'ok' : 'no_enclosed_counters' };
    },
  },
  interior: {
    needs: (ctx) => (ctx.primary ? null : 'needs --color <primary hex>'),
    run: async (ctx) => { const result = await interiorFillCheck(ctx.asset, ctx.primary as string) as JsonObject; return { result, pass: verdictOk(result), verdict: str(result.verdict) }; },
  },
  'component-contrast': {
    needs: (ctx) => (ctx.primary ? null : 'needs --color <primary hex>'),
    run: async (ctx) => {
      const result = await componentContrastCheck(ctx.asset, ctx.primary as string) as JsonObject;
      const pass = passOf(result);
      // 2026-09-23 (Soybean): an explicit --treatment fullcolor is a human saying this is the brand's own
      // untouched lockup; a failure then gets the overridable verdict instead of the hard one.
      const verdict = !pass && ctx.treatment === 'fullcolor' ? 'authored_lockup_low_contrast' : str(result.verdict);
      if (!pass && ctx.treatment === 'fullcolor') result.verdict_reclassified_from = str(result.verdict);
      return { result, pass, verdict };
    },
  },
  whiteblob: {
    needs: () => null,
    run: async (ctx) => { const result = await whiteblobCheck(ctx.asset) as JsonObject; return { result, pass: passOf(result), verdict: str(result.note) }; },
  },
  stroke: {
    needs: () => null,
    run: async (ctx) => { const result = await strokeAnalysis(ctx.asset) as JsonObject; return { result, pass: verdictOk(result), verdict: str(result.verdict) }; },
  },
  edge: {
    needs: (ctx) => (ctx.primary ? null : 'needs --color <primary hex>'),
    run: async (ctx) => { const result = await edgeBandLegibility(ctx.asset, ctx.primary as string) as JsonObject; return { result, pass: null, verdict: null }; },
  },
  'png-color-type': {
    needs: () => null,
    run: async (ctx) => { const result = await assessPngColorType(ctx.asset) as unknown as JsonObject; return { result, pass: passOf(result), verdict: str(result.verdict) }; },
  },
  'edge-quality': {
    needs: () => null,
    run: async (ctx) => {
      const result = await assessEdgeQuality(ctx.asset, { source_native_longest_px: ctx.sourceNativePx ?? null, derivation: ctx.derivation ?? null, note: ctx.sourceNote ?? null }) as unknown as JsonObject;
      return { result, pass: passOf(result), verdict: str(result.verdict) };
    },
  },
  'sticker-ground': {
    needs: (ctx) => (ctx.surface === 'sticker' ? null : 'applies only to sticker / POP-on-white assets (gates check --surface sticker)'),
    run: async (ctx) => { const result = await assessStickerGround(ctx.asset) as unknown as JsonObject; return { result, pass: passOf(result), verdict: str(result.verdict) }; },
  },
  'primary-too-light': {
    needs: (ctx) => (ctx.primary ? null : 'needs --color <primary hex>'),
    run: async (ctx, t) => {
      const ratio = contrastVsWhite(ctx.primary as string);
      const min = Number(t.min_contrast_vs_white);
      const pass = ratio >= min;
      const result = { primary: ctx.primary, contrast_vs_white: Number(ratio.toFixed(3)), min_contrast_vs_white: min, pass, verdict: pass ? 'ok' : 'primary_too_light', reasons: pass ? [] : [`web_primary_color ${ctx.primary} is ${ratio.toFixed(2)}:1 against white (floor ${min}); the primary is the touchpoint page background and a white or near-white one makes the link tree look broken (That's a Wrap 2026-09-17). Only white and near-white are banned; a brand's own authored cream or tan is allowed as the card when text reads black on it (Chubby's tan; Q8 = A 2026-09-22). A neutral-ink mark takes a black card with a white knockout.`] };
      return { result, pass, verdict: result.verdict };
    },
  },
  'render-legibility': {
    needs: () => null,
    run: async (ctx) => {
      const result = await assessRenderLegibility(ctx.asset, { background: ctx.primary ?? undefined, cropOut: ctx.cropOut ?? undefined }) as unknown as JsonObject;
      return { result, pass: passOf(result), verdict: str(result.verdict) };
    },
  },
  'text-legibility': {
    needs: (ctx) => (ctx.expected ? null : 'needs --expected <business name> (or a run.json request.location_name)'),
    run: async (ctx) => {
      const result = await assessTextLegibility(ctx.asset, ctx.expected as string, ctx.primary ?? DEFAULT_OCR_BACKGROUND, ctx.source ?? undefined, ctx.treatment ? { treatment: ctx.treatment } : {}) as unknown as JsonObject;
      return { result, pass: passOf(result), verdict: str(result.verdict) };
    },
  },
  'ink-retention': {
    needs: (ctx) => (ctx.source ? null : 'needs --source <verified source>'),
    run: async (ctx) => { const result = await assessInkRetention(ctx.source as string, ctx.asset, { primary: ctx.primary ?? null }) as unknown as JsonObject; return { result, pass: passOf(result), verdict: str(result.verdict) }; },
  },
  'validate-logo-surface': {
    needs: (ctx) => (ctx.primary ? null : 'needs --color <primary hex>'),
    run: async (ctx) => { const result = await assessLogoSurface(ctx.asset, ctx.primary as string) as unknown as JsonObject; return { result, pass: passOf(result), verdict: str(result.verdict) }; },
  },
  'logo-crop': {
    needs: () => null,
    run: async (ctx) => { const result = await assessLogoCrop(ctx.asset) as unknown as JsonObject; return { result, pass: passOf(result), verdict: str(result.verdict) }; },
  },
  'upload-size': {
    needs: () => null,
    run: async (ctx, t) => {
      const bytes = fs.statSync(ctx.asset).size;
      const max = Number(t.max_bytes);
      const pass = bytes > 0 && bytes <= max;
      return { result: { bytes, max_bytes: max, pass, verdict: pass ? 'ok' : 'upload_over_byte_cap' }, pass, verdict: pass ? 'ok' : 'upload_over_byte_cap' };
    },
  },
  'ladder-floor': {
    needs: (ctx) => (ctx.laddered ? null : 'applies only to byte-laddered files (gates run --laddered)'),
    run: async (ctx, t) => {
      const meta = await shipResolutionGate(ctx.asset, { minLongest: Number(t.min_longest_px) }) as JsonObject;
      const pass = passOf(meta) === true;
      const result = { width: meta.width, height: meta.height, longest: meta.longest, min_longest_px: Number(t.min_longest_px), pass, verdict: pass ? 'ok' : 'below_byte_ladder_floor' };
      return { result, pass, verdict: result.verdict };
    },
  },
};

/** Gates that run for this context: battery gates, conditional gates whose inputs are present, plus an explicit --gates list. */
export function selectGates(ctx: RunContext, only?: string[] | null): { run: GateDefinition[]; skipped: Array<{ gate: string; why: string }> } {
  const registry = loadGateRegistry();
  const run: GateDefinition[] = [];
  const skipped: Array<{ gate: string; why: string }> = [];
  const wanted = only?.map((id) => canonicalGateId(id) ?? id) ?? null;
  for (const def of registry.gates) {
    if (wanted && !wanted.includes(def.id)) continue;
    const adapter = ADAPTERS[def.id];
    if (!adapter) { if (wanted) skipped.push({ gate: def.id, why: 'not runnable through gates run; use the tool directly' }); continue; }
    const why = adapter.needs(ctx);
    if (why) { if (wanted || def.battery !== false) skipped.push({ gate: def.id, why }); continue; }
    if (def.battery === false && !wanted && def.id !== 'ladder-floor' && !(def.id === 'sticker-ground' && ctx.surface === 'sticker')) continue;
    run.push(def);
  }
  for (const id of wanted ?? []) if (!registry.gates.some((def) => def.id === id)) skipped.push({ gate: id, why: 'unknown gate id' });
  return { run, skipped };
}

function relAsset(asset: string, runDir: string | null): string {
  if (!runDir) return asset;
  const rel = path.relative(runDir, asset);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : asset;
}

export async function runBattery(
  ctx: RunContext,
  options: { runDir?: string | null; only?: string[] | null; writeFiles?: boolean } = {},
): Promise<{ results: GateResult[]; skipped: Array<{ gate: string; why: string }>; asset: string; asset_sha256: string | null }> {
  const asset = path.resolve(ctx.asset);
  if (!fs.existsSync(asset)) throw new Error(`asset does not exist: ${asset}`);
  const runDir = options.runDir ? path.resolve(options.runDir) : null;
  const { run, skipped } = selectGates({ ...ctx, asset }, options.only);
  const assetRel = relAsset(asset, runDir);
  const assetSha = sha256File(asset);
  const regSha = registrySha256();
  const outDir = runDir && options.writeFiles !== false ? path.join(runDir, 'fix', 'gates', path.basename(asset, path.extname(asset))) : null;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const results: GateResult[] = [];
  for (const def of run) {
    const at = new Date().toISOString();
    let outcome: { result: JsonObject; pass: boolean | null; verdict: string | null };
    try {
      outcome = await ADAPTERS[def.id].run({ ...ctx, asset }, def.thresholds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { result: { error: message }, pass: def.severity === 'info' ? null : false, verdict: `unassessable: ${message}` };
    }
    let file: string | null = null;
    if (outDir) {
      const target = path.join(outDir, `gate-${def.id}.json`);
      fs.writeFileSync(target, `${JSON.stringify(outcome.result, null, 2)}\n`);
      file = path.relative(runDir as string, target);
    }
    results.push({
      gate: def.id,
      asset: assetRel,
      asset_sha256: assetSha,
      pass: outcome.pass,
      verdict: outcome.verdict,
      severity: effectiveSeverity(def, outcome.verdict),
      override_allowed: def.override_allowed,
      thresholds: def.thresholds,
      inputs: { primary: ctx.primary ?? null, expected: def.inputs.includes('expected') ? ctx.expected ?? null : undefined, source: def.inputs.includes('source') ? ctx.source ?? null : undefined, laddered: ctx.laddered ?? false, ...(def.id === 'text-legibility' ? { treatment: ctx.treatment ?? 'detected', treatment_hint: ctx.treatment_hint ?? null } : {}), ...(def.id === 'edge-quality' ? { source_native_px: ctx.sourceNativePx ?? null, derivation: ctx.derivation ?? null, source_note: ctx.sourceNote ?? null } : {}), ...(def.id === 'sticker-ground' ? { surface: ctx.surface ?? null } : {}) },
      file,
      result: outcome.result,
      at,
      registry_sha256: regSha,
      source: 'gates run',
    });
  }
  return { results, skipped, asset: assetRel, asset_sha256: assetSha };
}

/** Merge fresh results into run.json's gates block, replacing earlier entries for the same (gate, asset). */
export function writeGatesBlock(runDir: string, fresh: GateResult[], skipped: Array<{ gate: string; why: string }>, options: { force?: boolean; reason?: string; by?: string } = {}): RunFile {
  const run = readRun(runDir);
  const existing = asObject(run.gates);
  const previous = Array.isArray(existing.results) ? existing.results as JsonObject[] : [];
  const replaced = new Set(fresh.map((r) => `${r.gate}::${r.asset}`));
  const kept = previous.filter((r) => !replaced.has(`${canonicalGateId(String(r.gate)) ?? r.gate}::${r.asset}`));
  const block = { ...existing, results: [...kept, ...fresh], skipped, registry: GATES_JSON, registry_sha256: registrySha256(), last_run_at: new Date().toISOString() };
  return setBlock(runDir, 'gates', block, { force: options.force, reason: options.reason, by: options.by ?? 'gates run' });
}

// ---------------------------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------------------------

function assetMatches(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return true;
  return path.basename(a) === path.basename(b);
}

const SOURCE_RANK: Record<string, number> = { 'gates run': 3, live_receipts: 2, manifest: 1 };

/** One entry per (canonical gate, asset): the freshest structured result wins over migrated manifest prose. */
export function dedupeResults(results: JsonObject[]): JsonObject[] {
  const best = new Map<string, JsonObject>();
  for (const raw of results) {
    const gate = canonicalGateId(String(raw.gate)) ?? String(raw.gate);
    const entry = { ...raw, gate, raw_gate: raw.gate };
    const key = `${gate}::${String(raw.asset)}`;
    const current = best.get(key);
    const rank = (r: JsonObject) => SOURCE_RANK[String(r.source)] ?? 2;
    if (!current || rank(entry) > rank(current) || (rank(entry) === rank(current) && String(entry.at ?? '') >= String(current.at ?? ''))) best.set(key, entry);
  }
  return [...best.values()];
}

export function computeVerdict(
  rawResults: JsonObject[],
  overrides: JsonObject[],
  options: { asset?: string | null; partial?: boolean; shipped?: boolean } = {},
): Verdict {
  const registry = loadGateRegistry();
  let results = dedupeResults(rawResults);
  if (options.asset) results = results.filter((r) => assetMatches(r.asset, options.asset));
  const assets = [...new Set(results.map((r) => String(r.asset)))];
  const verdict: Verdict = { verdict: 'SHIP', assets, reasons: [], failing: [], overridden: [], refused: [], warnings: [], missing: [], registry_sha256: registrySha256() };
  if (!results.length) {
    verdict.verdict = 'HOLD';
    verdict.reasons.push(options.asset ? `no gate results recorded for ${options.asset}; run gates run first` : 'no gate results recorded; run gates run first');
    return verdict;
  }
  for (const asset of assets) {
    const have = new Set(results.filter((r) => String(r.asset) === asset).map((r) => String(r.gate)));
    for (const def of registry.gates) {
      if (def.battery !== true || def.severity !== 'block') continue;
      if (!have.has(def.id)) verdict.missing.push(`${def.id} (${asset})`);
    }
  }
  if (verdict.missing.length && !options.partial) {
    verdict.reasons.push(`battery incomplete, missing block gates: ${verdict.missing.join(', ')}`);
  }
  for (const r of results) {
    const gate = String(r.gate);
    const asset = String(r.asset);
    const def = registry.gates.find((g) => g.id === gate) ?? null;
    const verdictText = typeof r.verdict === 'string' ? r.verdict : null;
    const severity: GateSeverity = def ? effectiveSeverity(def, verdictText) : ((r.severity as GateSeverity) ?? 'block');
    const pass = typeof r.pass === 'boolean' ? r.pass : null;
    if (severity === 'info') continue;
    const failed = pass === false || (pass === null && severity === 'block');
    if (!failed) continue;
    if (severity === 'warn') { verdict.warnings.push({ gate, asset, verdict: verdictText }); continue; }
    const sha = typeof r.asset_sha256 === 'string' ? r.asset_sha256 : null;
    const record = overrides.find((o) => (canonicalGateId(String(o.gate)) ?? String(o.gate)) === gate
      && (assetMatches(o.asset, asset) || (sha !== null && o.asset_sha256 === sha)));
    if (!record) {
      verdict.failing.push({ gate, asset, verdict: verdictText, severity });
      verdict.reasons.push(`${gate} failed on ${asset}${verdictText ? ` (${verdictText})` : ''} with no override record`);
      continue;
    }
    const summary = { decided_by: String(record.decided_by), reason: String(record.reason), at: String(record.at) };
    const allowed = overrideAllowedFor(def, verdictText, record, options.shipped === true);
    if (!allowed.ok) {
      verdict.refused.push({ gate, asset, verdict: verdictText, why: allowed.why as string, override: summary });
      verdict.reasons.push(`override refused: ${allowed.why}`);
      continue;
    }
    verdict.overridden.push({ gate, asset, verdict: verdictText, override: summary });
    verdict.reasons.push(`${gate} failed on ${asset}${verdictText ? ` (${verdictText})` : ''}; overridden by ${summary.decided_by} on ${summary.at}: ${summary.reason}`);
  }
  const holds = verdict.failing.length || verdict.refused.length || (verdict.missing.length && !options.partial);
  verdict.verdict = holds ? 'HOLD' : verdict.overridden.length ? 'SHIP-WITH-OVERRIDE' : 'SHIP';
  for (const w of verdict.warnings) verdict.reasons.push(`warn: ${w.gate} on ${w.asset}${w.verdict ? ` (${w.verdict})` : ''}`);
  return verdict;
}

export function verdictForRun(runDir: string, options: { asset?: string | null; partial?: boolean } = {}): Verdict {
  const run = readRun(runDir);
  const results = Array.isArray(asObject(run.gates).results) ? asObject(run.gates).results as JsonObject[] : [];
  const overrides = Array.isArray(run.overrides) ? run.overrides : [];
  const asset = options.asset ? relAsset(path.resolve(options.asset), path.resolve(runDir)) : null;
  return computeVerdict(results, overrides, { asset, partial: options.partial, shipped: runHasAppliedEvidence(runDir) });
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

export type ReplayRow = {
  run: string;
  asset: string;
  gate: string;
  then: boolean | null;
  then_source: 'baseline' | 'recorded' | 'none';
  now: boolean | null;
  now_verdict: string | null;
  severity: GateSeverity;
  override: 'yes' | 'refused' | 'no' | '-';
  status: 'match' | 'mismatch' | 'new' | 'BLOCK';
  resolution_source: AppliedSource;
  sha_check: ShaCheck;
};

export type ReplayReport = {
  generated_at: string;
  registry_sha256: string;
  baseline_used: boolean;
  runs_scanned: number;
  runs_replayed: number;
  runs_skipped: Array<{ run: string; why: string }>;
  rows: ReplayRow[];
  matches: number;
  mismatches: number;
  blocks: ReplayRow[];
  per_gate_now_failing_shipped: Record<string, number>;
  verdicts: Record<string, Verdict['verdict']>;
  resolutions: Record<string, { asset: string; source: AppliedSource; sha_check: ShaCheck; attachment_check: AppliedAsset['attachment_check']; recorded_sha: string | null; actual_sha256: string | null; attachment_id: string | null; note: string | null }>;
  sha_mismatches: Array<{ run: string; asset: string; source: AppliedSource; recorded_sha: string | null; actual_sha256: string | null }>;
  attachment_mismatches: Array<{ run: string; asset: string; source: AppliedSource; receipt_attachment: string | null; live_attachment: string | null }>;
  block: boolean;
};

function runDate(name: string): string | null {
  const m = /^runs-prod-(\d{4})-?(\d{2})-?(\d{2})$/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

function cloneToScratch(realDir: string, scratchRoot: string, rel: string): string {
  const target = path.join(scratchRoot, rel);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // APFS clonefile (cp -c) makes the copy instant and storage-free; fall back to a plain copy elsewhere.
  const clone = spawnSync('cp', ['-Rc', realDir, target], { encoding: 'utf8' });
  if (clone.status !== 0) fs.cpSync(realDir, target, { recursive: true });
  return target;
}

/** Load a run's record read-only: its run.json when present, otherwise a migrated scratch copy. */
function loadRunRecord(realDir: string, rel: string, scratchRoot: string): { run: RunFile; from: 'run.json' | 'migrated' } {
  if (runFileExists(realDir)) return { run: readRun(realDir), from: 'run.json' };
  const scratch = cloneToScratch(realDir, scratchRoot, rel);
  return { run: migrateRun(scratch), from: 'migrated' };
}

function loadSidecarOverrides(dir: string | null, runId: string): JsonObject[] {
  if (!dir) return [];
  const out: JsonObject[] = [];
  const perRun = path.join(dir, `${runId.replace(/\//g, '__')}.json`);
  if (fs.existsSync(perRun)) {
    const parsed = JSON.parse(fs.readFileSync(perRun, 'utf8'));
    out.push(...(Array.isArray(parsed) ? parsed : Array.isArray(parsed.overrides) ? parsed.overrides : []));
  }
  const combined = path.join(dir, 'overrides.json');
  if (fs.existsSync(combined)) {
    const parsed = JSON.parse(fs.readFileSync(combined, 'utf8')) as JsonObject;
    const entry = parsed[runId];
    if (Array.isArray(entry)) out.push(...(entry as JsonObject[]));
  }
  return out;
}

export type AppliedSource = 'run.json:write' | 'apply.json:logo_filename' | 'manifest:logo_filename' | 'manifest:logo_file' | 'manifest:applied_logo_download' | 'manifest:logo_files';
export type ShaCheck = 'match' | 'mismatch' | 'no_recorded_sha';
export type AppliedAsset = {
  logoRel: string;
  logoAbs: string;
  primary: string | null;
  source: AppliedSource;
  recorded_sha: string | null;   // full sha or prefix as recorded next to the path
  actual_sha256: string | null;
  sha_check: ShaCheck;
  attachment_id: string | null;
  /** production-readback.json's live attachment vs the receipt the file came from: 'mismatch' means the run dir holds no receipt for what is live. */
  attachment_check: 'match' | 'mismatch' | 'unknown';
  note: string | null;
};

const SHA_RE = /sha(?:256)?(?:_prefix)?\s*[:=]?\s*"?([0-9a-f]{6,64})/i;
function shaFromProse(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = SHA_RE.exec(value);
  return m ? m[1].toLowerCase() : null;
}
function shaCheck(recorded: string | null, actual: string | null): ShaCheck {
  if (!recorded || !actual) return 'no_recorded_sha';
  return actual.startsWith(recorded) ? 'match' : 'mismatch';
}
function fileExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
function readJsonSafe(file: string): JsonObject | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject; } catch { return null; }
}
/** Files named `basename` under dir (bounded depth, skips node_modules); newest mtime first. */
function findByBasename(dir: string, basename: string, depth = 4): string[] {
  const hits: Array<{ file: string; mtime: number }> = [];
  const walk = (current: string, level: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (level < depth) walk(full, level + 1); }
      else if (entry.name === basename) hits.push({ file: full, mtime: fs.statSync(full).mtimeMs });
    }
  };
  walk(dir, 0);
  return hits.sort((a, b) => b.mtime - a.mtime).map((h) => h.file);
}
/** Candidate files for a recorded basename: the run dir first, the batch's sibling runs only when the run has none. */
function locateNamed(realDir: string, basename: string, recordedSha: string | null): { file: string | null; note: string | null } {
  const batchDir = path.dirname(realDir);
  let hits = findByBasename(realDir, basename);
  let scope = 'run';
  if (!hits.length) {
    hits = findByBasename(batchDir, basename, 4).filter((f) => !f.startsWith(realDir + path.sep));
    scope = 'sibling runs';
  }
  if (!hits.length) return { file: null, note: null };
  if (hits.length === 1) return { file: hits[0], note: scope === 'run' ? null : `${basename} found in a sibling run` };
  if (recordedSha) {
    const bySha = hits.find((f) => (sha256File(f) ?? '').startsWith(recordedSha));
    if (bySha) return { file: bySha, note: `${basename} matched ${hits.length} files in ${scope}; took the one whose sha matches the recorded ${recordedSha}` };
  }
  const shallowest = [...hits].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || b.localeCompare(a))[0];
  return { file: shallowest, note: `${basename} matched ${hits.length} files in ${scope} and no recorded sha decides; took the shallowest path (${path.relative(realDir, shallowest)})` };
}
/** What production last reported for the run (production-readback.json): the authority for the live attachment and primary. */
function liveReadback(realDir: string): { attachment: string | null; primary: string | null } {
  const readback = readJsonSafe(path.join(realDir, 'production-readback.json'));
  if (!readback) return { attachment: null, primary: null };
  const eff = asObject(readback.effective_branding);
  const acct = asObject(readback.account_branding);
  return {
    attachment: stringOrNull(eff.logo_attachment_id) ?? stringOrNull(acct.logo_attachment_id) ?? stringOrNull(readback.logo_attachment_id),
    primary: stringOrNull(eff.web_primary_color) ?? stringOrNull(acct.web_primary_color) ?? stringOrNull(readback.web_primary_color),
  };
}
/** Resolve a recorded relative path under the run, the batch, or a sibling run named by its first segment ("reston/fix/x.png" -> "<batch>/*-reston/fix/x.png"). */
function resolveRecordedPath(realDir: string, rel: string): { abs: string; scope: 'run' | 'batch' | 'sibling' } | null {
  if (path.isAbsolute(rel)) return fileExists(rel) ? { abs: rel, scope: 'run' } : null;
  const batchDir = path.dirname(realDir);
  for (const [base, scope] of [[realDir, 'run'], [batchDir, 'batch']] as const) {
    const abs = path.join(base, rel);
    if (fileExists(abs)) return { abs, scope };
  }
  const [head, ...rest] = rel.split('/');
  if (head && rest.length) {
    let siblings: string[] = [];
    try { siblings = fs.readdirSync(batchDir).filter((name) => name === head || name.endsWith(`-${head}`)); } catch { siblings = []; }
    for (const name of siblings) {
      const abs = path.join(batchDir, name, ...rest);
      if (fileExists(abs)) return { abs, scope: 'sibling' };
    }
  }
  return null;
}
/** Any `files.applied_logo_download` prose in the manifest (top level or nested under production*). */
function appliedLogoDownload(manifest: JsonObject): string | null {
  let found: string | null = null;
  const walk = (value: unknown, depth: number) => {
    if (found || depth > 3 || value == null || typeof value !== 'object' || Array.isArray(value)) return;
    const obj = value as JsonObject;
    if (typeof asObject(obj.files).applied_logo_download === 'string') { found = asObject(obj.files).applied_logo_download as string; return; }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(manifest, 0);
  return found;
}

function primaryFromReadback(readback: JsonObject): string | null {
  return stringOrNull(asObject(readback.effective_branding).web_primary_color)
    ?? stringOrNull(asObject(readback.account_branding).web_primary_color)
    ?? stringOrNull(readback.web_primary_color);
}
function finish(realDir: string, abs: string, partial: Omit<AppliedAsset, 'logoRel' | 'logoAbs' | 'actual_sha256' | 'sha_check' | 'attachment_check'>): AppliedAsset {
  const actual = sha256File(abs);
  const rel = path.relative(realDir, abs);
  const live = liveReadback(realDir).attachment;
  const attachment_check: AppliedAsset['attachment_check'] = live && partial.attachment_id ? (live === partial.attachment_id ? 'match' : 'mismatch') : 'unknown';
  return { ...partial, logoRel: rel.startsWith('..') ? abs : rel, logoAbs: abs, actual_sha256: actual, sha_check: shaCheck(partial.recorded_sha, actual), attachment_check };
}

/**
 * The logo that actually shipped for a run, in priority order:
 *  1. run.json write block (logo_file_resolved / logo_file, verified against write.logo_sha256);
 *  2. the newest fix/** apply*.json receipt: readback.effective_branding.logo_filename plus the downloaded
 *     copy next to it (applied-logo.png / cdn-logo.png), else the file of that name under the run or its batch;
 *  3. manifest production.logo_filename (any block carrying logo_filename + logo_attachment_id);
 *  4. manifest files.applied_logo_download (path and sha prefix in prose);
 *  5. manifest logo_files.card_final / card (with sha256_prefix when present).
 * Every step records where the answer came from and whether the file's sha matches the recorded one.
 * A sha mismatch is returned, never silently replayed.
 */
export function resolveAppliedLogo(realDir: string, write: JsonObject | null): AppliedAsset | null {
  const batchDir = path.dirname(realDir);
  // 1. run.json write block
  if (write && write.status === 'applied') {
    const candidates = [stringOrNull(write.logo_file_resolved), stripNote(write.logo_file)].filter((v): v is string => Boolean(v));
    const recorded = stringOrNull(write.logo_sha256) ?? shaFromProse(write.logo_file);
    for (const rel of candidates) {
      const hit = resolveRecordedPath(realDir, rel);
      if (hit) {
        return finish(realDir, hit.abs, { primary: liveReadback(realDir).primary ?? stringOrNull(asObject(write.colors_after).web_primary_color), source: 'run.json:write', recorded_sha: recorded, attachment_id: stringOrNull(write.logo_attachment_id), note: hit.scope === 'run' ? null : `path recorded relative to the ${hit.scope}` });
      }
    }
  }
  const manifest = readJsonSafe(path.join(realDir, 'manifest.json')) ?? {};
  // 2. newest apply receipt with a readback logo_filename
  const receipts: Array<{ file: string; mtime: number; readback: JsonObject }> = [];
  const fix = path.join(realDir, 'fix');
  const walkReceipts = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (level < 3) walkReceipts(full, level + 1); continue; }
      if (!/^apply.*\.json$/.test(entry.name)) continue;
      const parsed = readJsonSafe(full);
      const readback = asObject(parsed?.readback ?? parsed?.after ?? parsed?.result ?? null);
      if (stringOrNull(asObject(readback.effective_branding).logo_filename) ?? stringOrNull(asObject(readback.account_branding).logo_filename)) {
        receipts.push({ file: full, mtime: fs.statSync(full).mtimeMs, readback });
      }
    }
  };
  walkReceipts(fix, 0);
  receipts.sort((a, b) => b.mtime - a.mtime);
  const download = appliedLogoDownload(manifest);
  const manifestSha = shaFromProse(download)
    ?? Object.keys(manifest).filter((k) => /^(applied|production)/.test(k)).map((k) => shaFromProse(asObject(manifest[k]).logo_file)).find(Boolean)
    ?? null;
  const attachmentOf = (readback: JsonObject) => stringOrNull(asObject(readback.effective_branding).logo_attachment_id) ?? stringOrNull(asObject(readback.account_branding).logo_attachment_id);
  const liveState = liveReadback(realDir);
  const live = liveState.attachment;
  const matching = live ? receipts.filter((r) => attachmentOf(r.readback) === live) : [];
  const chosen = matching[0] ?? receipts[0];
  if (chosen) {
    const readback = chosen.readback;
    const effective = asObject(readback.effective_branding);
    const account = asObject(readback.account_branding);
    const basename = (stringOrNull(effective.logo_filename) ?? stringOrNull(account.logo_filename)) as string;
    const attachment = attachmentOf(readback);
    const notes: string[] = [];
    if (live && !matching.length) notes.push(`no apply receipt carries production-readback's attachment ${live}; took the newest receipt (${attachment})`);
    // a downloaded copy next to any receipt for the same attachment beats a basename search
    const sameAttachment = receipts.filter((r) => attachmentOf(r.readback) === attachment);
    const local = sameAttachment.flatMap((r) => ['applied-logo.png', 'cdn-logo.png'].map((n) => path.join(path.dirname(r.file), n))).find(fileExists);
    let abs: string | null = local ?? null;
    if (local) notes.push(`downloaded copy ${path.relative(realDir, local)}`);
    else {
      const located = locateNamed(realDir, basename, manifestSha);
      abs = located.file;
      if (located.note) notes.push(located.note);
    }
    if (abs) return finish(realDir, abs, { primary: liveState.primary ?? primaryFromReadback(readback), source: 'apply.json:logo_filename', recorded_sha: manifestSha, attachment_id: attachment, note: notes.join('; ') || null });
  }
  // 3. manifest block with logo_filename + logo_attachment_id (production / production_write.effective / applied)
  const blocks: JsonObject[] = [];
  const collect = (value: unknown, depth: number) => {
    if (depth > 3 || value == null || typeof value !== 'object' || Array.isArray(value)) return;
    const obj = value as JsonObject;
    if (typeof obj.logo_filename === 'string' && obj.logo_attachment_id) blocks.push(obj);
    for (const v of Object.values(obj)) collect(v, depth + 1);
  };
  for (const key of Object.keys(manifest).filter((k) => /^(applied|production)/.test(k))) collect(manifest[key], 0);
  for (const block of blocks) {
    const basename = stripNote(block.logo_filename) as string;
    const located = locateNamed(realDir, basename, manifestSha);
    if (located.file) {
      return finish(realDir, located.file, { primary: liveState.primary ?? stringOrNull(block.web_primary_color), source: 'manifest:logo_filename', recorded_sha: manifestSha, attachment_id: stringOrNull(block.logo_attachment_id), note: located.note });
    }
  }
  // 3b. manifest applied*/production_write*.logo_file prose ("reston/fix/card/card-full-tight.png (1600x544, ..., sha256 f199b0dc...)")
  for (const key of Object.keys(manifest).filter((k) => /^(applied|production_write)/.test(k)).sort().reverse()) {
    const block = asObject(manifest[key]);
    const rel = stripNote(block.logo_file);
    if (!rel) continue;
    const hit = resolveRecordedPath(realDir, rel);
    if (hit) {
      return finish(realDir, hit.abs, { primary: liveState.primary ?? stringOrNull(asObject(block.colors_after).web_primary_color), source: 'manifest:logo_file', recorded_sha: shaFromProse(block.logo_file), attachment_id: stringOrNull(block.logo_attachment_id), note: hit.scope === 'run' ? null : `path recorded relative to the ${hit.scope}` });
    }
  }
  // 4. manifest files.applied_logo_download
  if (typeof download === 'string') {
    const rel = download.split(/\s+/)[0];
    const abs = path.join(realDir, rel);
    if (fileExists(abs)) return finish(realDir, abs, { primary: liveState.primary, source: 'manifest:applied_logo_download', recorded_sha: shaFromProse(download), attachment_id: null, note: null });
  }
  // 5. manifest logo_files (only when some applied/production_write key says the write happened)
  const writeKeys = Object.keys(manifest).filter((key) => /^(applied|production_write)/.test(key));
  const appliedEvidence = writeKeys.some((key) => {
    const value = manifest[key];
    if (typeof value === 'string') return /applied/i.test(value);
    const block = asObject(value);
    return /applied/i.test(String(block.status ?? '')) || Boolean(block.logo_attachment_id) || Boolean(asObject(block.effective).logo_attachment_id) || Boolean(block.logo_attachment_id_after) || Boolean(asObject(block.applied).logo_attachment_id);
  });
  if (appliedEvidence) {
    const logoFiles = asObject(manifest.logo_files);
    const card = logoFiles.card_final ?? logoFiles.card ?? logoFiles.final ?? null;
    const rel = typeof card === 'string' ? stripNote(card) : stringOrNull(asObject(card).path);
    const recorded = typeof card === 'string' ? shaFromProse(card) : stringOrNull(asObject(card).sha256) ?? stringOrNull(asObject(card).sha256_prefix);
    if (rel) {
      const abs = path.isAbsolute(rel) ? rel : path.join(realDir, rel);
      if (fileExists(abs)) {
        let primary: string | null = null;
        for (const key of ['applied_colors', ...writeKeys]) {
          const block = asObject(manifest[key]);
          primary = stringOrNull(block.web_primary_color) ?? stringOrNull(asObject(block.effective).web_primary_color) ?? stringOrNull(asObject(block.colors_after).web_primary_color) ?? null;
          if (primary) break;
        }
        return finish(realDir, abs, { primary: liveState.primary ?? primary, source: 'manifest:logo_files', recorded_sha: recorded, attachment_id: null, note: 'logo_files is a candidate list, not a receipt; weakest source' });
      }
    }
  }
  return null;
}

/** An explicit treatment recorded on the run: the applied variant cell's row/treatment text naming a knockout. */
function treatmentFromRun(run: RunFile): 'knockout' | 'fullcolor' | null {
  const variants = asObject(run.variants);
  const letter = stringOrNull(variants.applied_letter);
  const cell = letter ? asObject(asObject(variants.cells)[letter]) : {};
  const text = [cell.treatment, cell.row, cell.label, cell.name].filter((v) => typeof v === 'string').join(' ').toLowerCase();
  if (!text) return null;
  if (/knockout|words[- ]only white|white/.test(text)) return 'knockout';
  if (/full[- ]?colou?r|color/.test(text)) return 'fullcolor';
  return null;
}

export function loadBaseline(): JsonObject | null {
  if (!fs.existsSync(BASELINE_JSON)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE_JSON, 'utf8')) as JsonObject; } catch { return null; }
}

export async function replay(options: {
  root?: string;
  since?: string | null;
  runs?: string | null;
  only?: string[] | null;
  baseline?: boolean;
  overridesDir?: string | null;
  scratch?: string | null;
  log?: (line: string) => void;
} = {}): Promise<ReplayReport> {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const scratchRoot = options.scratch ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gates-replay-'));
  const baseline = options.baseline ? null : loadBaseline();
  const baselineRuns = asObject(baseline?.runs);
  const log = options.log ?? (() => undefined);
  const filter = options.runs ? globToRegExp(options.runs) : null;
  const report: ReplayReport = {
    generated_at: new Date().toISOString(),
    registry_sha256: registrySha256(),
    baseline_used: Boolean(baseline),
    runs_scanned: 0,
    runs_replayed: 0,
    runs_skipped: [],
    rows: [],
    matches: 0,
    mismatches: 0,
    blocks: [],
    per_gate_now_failing_shipped: {},
    verdicts: {},
    resolutions: {},
    sha_mismatches: {} as unknown as ReplayReport['sha_mismatches'],
    block: false,
  };
  report.sha_mismatches = [];
  report.attachment_mismatches = [];
  const baselineOut: JsonObject = { generated_at: report.generated_at, registry_sha256: report.registry_sha256, runs: {} };

  const batches = fs.readdirSync(root).filter((name) => /^runs-prod-/.test(name)).sort();
  for (const batch of batches) {
    const date = runDate(batch);
    if (options.since && date && date < options.since) continue;
    const batchDir = path.join(root, batch);
    if (!fs.statSync(batchDir).isDirectory()) continue;
    for (const name of fs.readdirSync(batchDir).sort()) {
      const realDir = path.join(batchDir, name);
      if (name.startsWith('_') || !fs.statSync(realDir).isDirectory()) continue;
      if (!fs.existsSync(path.join(realDir, 'manifest.json')) && !runFileExists(realDir)) continue;
      const rel = `${batch}/${name}`;
      if (filter && !filter.test(rel)) continue;
      report.runs_scanned += 1;
      let record: { run: RunFile; from: 'run.json' | 'migrated' };
      try {
        record = loadRunRecord(realDir, rel, scratchRoot);
      } catch (error) {
        report.runs_skipped.push({ run: rel, why: `migrate failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const run = record.run;
      const write = asObject(run.write);
      const applied = resolveAppliedLogo(realDir, write);
      if (!applied) {
        report.runs_skipped.push({ run: rel, why: write.status === 'applied' ? `applied logo file missing (${stringOrNull(write.logo_file_resolved) ?? stripNote(write.logo_file) ?? 'none recorded'})` : `not applied (${String(write.status ?? 'no write block')}; no apply receipt, manifest logo_filename, applied_logo_download, or logo_files under an applied key)` });
        continue;
      }
      if (applied.sha_check === 'mismatch') {
        report.sha_mismatches.push({ run: rel, asset: applied.logoRel, source: applied.source, recorded_sha: applied.recorded_sha, actual_sha256: applied.actual_sha256 });
        report.runs_skipped.push({ run: rel, why: `SHA MISMATCH: ${applied.logoRel} (${applied.source}) is ${applied.actual_sha256?.slice(0, 12)} but the run recorded ${applied.recorded_sha}; not replayed` });
        continue;
      }
      if (applied.attachment_check === 'mismatch') {
        report.attachment_mismatches.push({ run: rel, asset: applied.logoRel, source: applied.source, receipt_attachment: applied.attachment_id, live_attachment: liveReadback(realDir).attachment });
        report.runs_skipped.push({ run: rel, why: `ATTACHMENT MISMATCH: production-readback.json says ${liveReadback(realDir).attachment} is live but the newest receipt in the run dir wrote ${applied.attachment_id} (${applied.logoRel}); the shipped file is not recorded here, not replayed` });
        continue;
      }
      const { logoRel, logoAbs } = applied;
      report.resolutions[rel] = { asset: logoRel, source: applied.source, sha_check: applied.sha_check, attachment_check: applied.attachment_check, recorded_sha: applied.recorded_sha, actual_sha256: applied.actual_sha256, attachment_id: applied.attachment_id, note: applied.note };
      const primary = applied.primary ?? stringOrNull(asObject(write.colors_after).web_primary_color) ?? stringOrNull(asObject(asObject(run.decision).palette).web_primary_color) ?? null;
      const recorded = dedupeResults(Array.isArray(asObject(run.gates).results) ? asObject(run.gates).results as JsonObject[] : [])
        .filter((r) => assetMatches(r.asset, logoRel));
      const recordedOcr = recorded.find((r) => r.gate === 'text-legibility');
      // OCR expects the words on the asset: the recorded run's expected text when it exists, else the location
      // name without its admin suffix ("Olympus Pizza (Manchester)" -> "Olympus Pizza").
      // the words on the asset: what a human gave `gates run --expected` (recorded in inputs), else the
      // recorded OCR run's expected text, else the location name without its admin suffix
      const expected = stringOrNull(asObject(recordedOcr?.inputs).expected) ?? stringOrNull(asObject(recordedOcr?.result).expected_text) ?? stripNote(asObject(run.request).location_name);
      const overrides = [...(Array.isArray(run.overrides) ? run.overrides : []), ...loadSidecarOverrides(options.overridesDir ?? null, run.run_id)];

      log(`replay ${rel} (${record.from}) asset=${logoRel} via ${applied.source} sha=${applied.sha_check} primary=${primary ?? '-'} expected=${expected ?? '-'}`);
      // Treatment is detected from the pixels; the variant cell label is only a hint (Park Avenue's cell says
      // "knockout" while the shipped file is full-color art), so it is recorded, not trusted.
      // edge-quality: the native source of the shipped file (recorded ladder, candidate prose, or raw files under candidates/)
      const sourceInfo = inferSourceForRun(realDir, run as JsonObject, logoAbs);
      const battery = await runBattery({ asset: logoAbs, primary, expected, treatment_hint: treatmentFromRun(run), sourceNativePx: sourceInfo.source_native_longest_px, derivation: sourceInfo.derivation, sourceNote: sourceInfo.note ? `${sourceInfo.note}${sourceInfo.inferred ? ' (inferred)' : ''}` : null }, { runDir: realDir, only: options.only, writeFiles: false });
      report.runs_replayed += 1;
      // every replayed asset is live by construction (the resolver proved it), so shipped overrides count
      const verdict = computeVerdict(battery.results as unknown as JsonObject[], overrides, { asset: logoRel, partial: true, shipped: true });
      report.verdicts[rel] = verdict.verdict;
      const baselineGates = asObject(asObject(baselineRuns[rel]).gates);
      const baselineSha = stringOrNull(asObject(baselineRuns[rel]).asset_sha256);
      const gatesOut: JsonObject = {};
      for (const now of battery.results) {
        const def = gateDefinition(now.gate);
        gatesOut[now.gate] = { pass: now.pass, verdict: now.verdict };
        let then: boolean | null = null;
        let thenSource: ReplayRow['then_source'] = 'none';
        const fromBaseline = baselineSha === battery.asset_sha256 ? asObject(baselineGates[now.gate]) : {};
        const fromRecorded = recorded.find((r) => r.gate === now.gate);
        if (typeof fromBaseline.pass === 'boolean') { then = fromBaseline.pass; thenSource = 'baseline'; }
        else if (fromRecorded && typeof fromRecorded.pass === 'boolean') { then = fromRecorded.pass; thenSource = 'recorded'; }
        const overrideState: ReplayRow['override'] = effectiveSeverity(def, now.verdict) !== 'block' ? '-'
          : verdict.overridden.some((o) => o.gate === now.gate) ? 'yes'
          : verdict.refused.some((o) => o.gate === now.gate) ? 'refused'
          : 'no';
        const nowSeverity = effectiveSeverity(def, now.verdict);
        const blocks = nowSeverity === 'block' && (now.pass === false || now.pass === null) && overrideState !== 'yes';
        const status: ReplayRow['status'] = blocks ? 'BLOCK' : then === null ? 'new' : then === now.pass ? 'match' : 'mismatch';
        const row: ReplayRow = { run: rel, asset: logoRel as string, gate: now.gate, then, then_source: thenSource, now: now.pass, now_verdict: now.verdict, severity: nowSeverity, override: overrideState, status, resolution_source: applied.source, sha_check: applied.sha_check };
        report.rows.push(row);
        if (status === 'match') report.matches += 1;
        if (status === 'mismatch') report.mismatches += 1;
        if (status === 'BLOCK') report.blocks.push(row);
        if (nowSeverity === 'block' && now.pass === false) report.per_gate_now_failing_shipped[now.gate] = (report.per_gate_now_failing_shipped[now.gate] ?? 0) + 1;
      }
      (baselineOut.runs as JsonObject)[rel] = { asset: logoRel, asset_sha256: battery.asset_sha256, resolution_source: applied.source, primary, expected, applied_at: write.applied_at ?? null, gates: gatesOut, verdict: verdict.verdict };
    }
  }
  report.block = report.blocks.length > 0;
  if (options.baseline) {
    if (report.block) throw new Error(`refusing to write a baseline while ${report.blocks.length} shipped asset gate(s) BLOCK; resolve them first (explicit override or revert the rule edit)`);
    fs.writeFileSync(BASELINE_JSON, `${JSON.stringify(baselineOut, null, 2)}\n`);
  }
  return report;
}

export function renderReplayTable(report: ReplayReport): string {
  const header = ['run', 'asset', 'resolution_source', 'sha', 'gate', 'then', 'now', 'override', 'status'];
  const rows = report.rows.map((r) => [r.run, path.basename(r.asset), r.resolution_source, r.sha_check, r.gate, r.then === null ? '-' : r.then ? 'pass' : 'FAIL', r.now === null ? '-' : r.now ? 'pass' : 'FAIL', r.override, r.status]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseCli(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) flags[key] = true;
      else { flags[key] = value; index += 1; }
    } else positional.push(token);
  }
  return { positional, flags };
}
const flagString = (flags: Record<string, string | boolean>, key: string): string | null => (typeof flags[key] === 'string' ? flags[key] as string : null);

const USAGE = [
  'gates registry',
  'gates run --asset <png> [--run <run_dir>] [--color <hex>] [--expected <name>] [--source <png>] [--treatment knockout|fullcolor] [--gates a,b] [--laddered] [--crop-out <png>] [--source-native-px <n>] [--derivation native|vector|trace|upscale] [--surface card|sticker] [--force --reason "<why>"]',
  'gates verdict --run <run_dir> [--asset <png>] [--partial]',
  'gates check ... [--gates a,b] [--overrides-run <run_dir>]   (subset = partial; overrides read, gates block not written)',
  'gates check --asset <png> --color <hex> [--run <run_dir>] [--expected <name>] [--source <png>] [--laddered]',
  'gates replay [--root <dir>] [--since <YYYY-MM-DD>] [--runs <glob>] [--gates a,b] [--baseline] [--overrides <dir>] [--scratch <dir>] [--json <report.json>] [--quiet]',
].join('\n');

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseCli(argv);
  const [command] = positional;
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const ctxFrom = (): RunContext & { runDir: string | null } => {
    const asset = flagString(flags, 'asset');
    if (!asset) throw new Error(`--asset <png> is required\n${USAGE}`);
    const runDir = flagString(flags, 'run');
    let expected = flagString(flags, 'expected');
    if (!expected && runDir && runFileExists(runDir)) expected = stringOrNull(asObject(readRun(runDir).request).location_name);
    const treatmentFlag = flagString(flags, 'treatment');
    const treatment = treatmentFlag === 'knockout' || treatmentFlag === 'fullcolor' ? treatmentFlag : null;
    const treatment_hint = runDir && runFileExists(runDir) ? treatmentFromRun(readRun(runDir)) : null;
    // edge-quality source: explicit flags win; with --run the recorded ladder / candidate / raw files are inferred
    let sourceNativePx = flagString(flags, 'source-native-px') ? Number(flagString(flags, 'source-native-px')) : null;
    const derivationFlag = flagString(flags, 'derivation');
    let derivation: Derivation | null = derivationFlag && ['native', 'vector', 'trace', 'upscale'].includes(derivationFlag) ? derivationFlag as Derivation : null;
    if (derivationFlag && !derivation) throw new Error(`--derivation must be native|vector|trace|upscale, got ${derivationFlag}`);
    let sourceNote: string | null = sourceNativePx ? 'given on the command line' : null;
    if (sourceNativePx === null && runDir && runFileExists(runDir)) {
      const inferred = inferSourceForRun(path.resolve(runDir), readRun(runDir) as JsonObject, path.resolve(asset));
      sourceNativePx = inferred.source_native_longest_px;
      derivation = derivation ?? (inferred.derivation === 'unknown' ? null : inferred.derivation);
      sourceNote = inferred.note ? `${inferred.note}${inferred.inferred ? ' (inferred)' : ''}` : null;
    }
    const surfaceFlag = flagString(flags, 'surface');
    const surface = surfaceFlag === 'sticker' ? 'sticker' : surfaceFlag === 'card' || !surfaceFlag ? (surfaceFlag ? 'card' : null) : null;
    if (surfaceFlag && !['card', 'sticker'].includes(surfaceFlag)) throw new Error(`--surface must be card|sticker, got ${surfaceFlag}`);
    return { asset, primary: flagString(flags, 'color'), expected, source: flagString(flags, 'source'), laddered: flags.laddered === true, cropOut: flagString(flags, 'crop-out'), treatment, treatment_hint, runDir, sourceNativePx, derivation, sourceNote, surface };
  };
  const only = flagString(flags, 'gates')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  switch (command) {
    case 'registry': {
      const registry = loadGateRegistry();
      const errors = validateRegistry(registry);
      out({ file: GATES_JSON, sha256: registrySha256(), valid: errors.length === 0, errors, gates: registry.gates.map((g) => ({ id: g.id, severity: g.severity, override_allowed: g.override_allowed, override_allowed_verdicts: g.override_allowed_verdicts ?? null, battery: g.battery, thresholds: g.thresholds })) });
      return errors.length ? 2 : 0;
    }
    case 'run': {
      const ctx = ctxFrom();
      const battery = await runBattery(ctx, { runDir: ctx.runDir, only });
      if (ctx.runDir) {
        if (!runFileExists(ctx.runDir)) throw new Error(`No ${RUN_FILE_NAME} in ${ctx.runDir}; run "run-file init" or "run-file migrate" first (or omit --run to print only)`);
        writeGatesBlock(ctx.runDir, battery.results, battery.skipped, { force: flags.force === true, reason: flagString(flags, 'reason') ?? undefined });
      }
      out({ ok: true, asset: battery.asset, asset_sha256: battery.asset_sha256, results: battery.results.map((r) => ({ gate: r.gate, pass: r.pass, verdict: r.verdict, severity: r.severity, file: r.file })), skipped: battery.skipped });
      return 0;
    }
    case 'verdict': {
      const runDir = flagString(flags, 'run');
      if (!runDir) throw new Error(`verdict needs --run <run_dir>\n${USAGE}`);
      const verdict = verdictForRun(runDir, { asset: flagString(flags, 'asset'), partial: flags.partial === true });
      out(verdict);
      return verdict.verdict === 'HOLD' ? 2 : 0;
    }
    case 'check': {
      const ctx = ctxFrom();
      if (!ctx.primary) throw new Error(`check needs --color <primary hex>\n${USAGE}`);
      const battery = await runBattery(ctx, { runDir: ctx.runDir, only });
      let verdict: Verdict;
      if (ctx.runDir && runFileExists(ctx.runDir)) {
        writeGatesBlock(ctx.runDir, battery.results, battery.skipped, { force: flags.force === true, reason: flagString(flags, 'reason') ?? undefined });
        verdict = verdictForRun(ctx.runDir, { asset: ctx.asset });
      } else {
        // 2026-09-23: a --gates subset is partial by construction (it used to HOLD every asset as
        // "battery incomplete"), and --overrides-run reads a run's recorded overrides without
        // writing its gates block (plan.mjs sticker on-white check).
        const overridesRun = flagString(flags, 'overrides-run');
        let overrides: unknown[] = [];
        let asset = battery.asset;
        if (overridesRun) {
          const run = readRun(overridesRun);
          overrides = Array.isArray(run.overrides) ? run.overrides : [];
          asset = relAsset(path.resolve(ctx.asset), path.resolve(overridesRun));
        }
        verdict = computeVerdict(battery.results as unknown as JsonObject[], overrides as JsonObject[], { asset, partial: Boolean(only) });
      }
      out({ ...verdict, skipped: battery.skipped });
      return verdict.verdict === 'HOLD' ? 2 : 0;
    }
    case 'replay': {
      const report = await replay({
        root: flagString(flags, 'root') ?? undefined,
        since: flagString(flags, 'since'),
        runs: flagString(flags, 'runs'),
        only,
        baseline: flags.baseline === true,
        overridesDir: flagString(flags, 'overrides'),
        scratch: flagString(flags, 'scratch'),
        log: flags.quiet === true ? undefined : (line) => process.stderr.write(`${line}\n`),
      });
      const jsonOut = flagString(flags, 'json');
      if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${renderReplayTable(report)}\n\n`);
      process.stdout.write(`runs scanned ${report.runs_scanned}, replayed ${report.runs_replayed}, skipped ${report.runs_skipped.length}; rows ${report.rows.length}: matches ${report.matches}, mismatches ${report.mismatches}, new ${report.rows.filter((r) => r.status === 'new').length}\n`);
      for (const skip of report.runs_skipped) process.stdout.write(`  skipped ${skip.run}: ${skip.why}\n`);
      for (const [run, verdict] of Object.entries(report.verdicts)) { const r = report.resolutions[run]; process.stdout.write(`  ${verdict.padEnd(18)} ${run}  ${r?.asset ?? ''} via ${r?.source ?? '?'} (sha ${r?.sha_check ?? '?'})${r?.note ? `  [${r.note}]` : ''}\n`); }
      for (const m of report.sha_mismatches) process.stdout.write(`  SHA MISMATCH       ${m.run}  ${m.asset} via ${m.source}: recorded ${m.recorded_sha}, actual ${m.actual_sha256}\n`);
      for (const m of report.attachment_mismatches) process.stdout.write(`  ATTACHMENT MISMATCH ${m.run}  live ${m.live_attachment} vs receipt ${m.receipt_attachment} (${m.asset})\n`);
      if (flags.baseline === true) process.stdout.write(`baseline written: ${BASELINE_JSON}\n`);
      if (report.block) {
        process.stdout.write(`\nBLOCK: ${report.blocks.length} shipped asset gate(s) now fail a block gate without an override record:\n`);
        for (const row of report.blocks) process.stdout.write(`  ${row.run} ${path.basename(row.asset)} [${row.resolution_source}, sha ${row.sha_check}] ${row.gate}${row.now_verdict ? ` (${row.now_verdict})` : ''}${row.override === 'refused' ? ' [override refused]' : ''}\n`);
        process.stdout.write('Resolve by recording an explicit override (run-file override ...) on the affected run, or by reverting the gates.json edit. This is a stop, not an auto-fix.\n');
        return 3;
      }
      process.stdout.write('\nOK: no shipped asset fails a block gate without an override.\n');
      return 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
