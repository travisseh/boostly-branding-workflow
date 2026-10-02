#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DECISION_FILE_NAME, asObject as runAsObject, decisionBlockFromFile, readRun, setBlock } from "../../boostly-box-fulfillment/scripts/run-file.ts";
import { gateThresholds } from "./logo-quality-gates.ts";
import { loadLadder, sourceInfoForCandidate, type LadderRecord } from "./logo-sources.ts";

type JsonObject = Record<string, unknown>;

const ALLOWED_KEYS = new Set([
  "logo_choice",
  "palette",
  "composition",
  "confidence",
  "flags",
  "rationale",
]);
const ALLOWED_PALETTE_ROLES = new Set([
  "web_primary_color",
  "web_secondary_color",
  "web_text_color",
  "print_primary_color",
  "print_secondary_color",
  "print_text_color",
  "print_text_secondary_color",
]);
const REQUIRED_WEB_PALETTE_ROLES = [
  "web_primary_color",
  "web_secondary_color",
  "web_text_color",
];
const PROVENANCE_ORDER = [
  "human_supplied",
  "first_party_header",
  "first_party_jsonld",
  "first_party_other",
  "gbp",
  "social",
];

const PRIMARY_TOO_LIGHT = gateThresholds<{ min_contrast_vs_white: number }>("primary-too-light");
const NEUTRAL_BAND_MAX_CHROMA = 0.15;     // cream, gray: RGB chroma (max - min) under this is a neutral
const MARK_INK_MATCH_DISTANCE = 24;       // a secondary within this RGB distance of a mark ink IS that ink
const BRAND_INK_MIN_SHARE = 0.03;         // a non-text saturated mark ink with at least this share earns the band
const BRAND_INK_MIN_SATURATION = 0.35;
const BRAND_INK_MIN_CONTRAST = 1.5;       // band vs card primary: the band only has to read as a separate field (Toscano orange on dark red is 2.4:1 and shipped); the digit rule (3:1 vs text) is checked on the sheet cell
// SYNTHETIC BAND STEPS (Q3 = A, Travisse 2026-09-22; Fresho C sage -20% accepted, That's a Wrap K #1A1A1A accepted,
// Coloradough AA lighter red rejected): a DARKER step of a real brand hue may be the band when the real ink is too
// light to carry a band or a white digit; a LIGHTER step is never a pick. Same hue, similar saturation, higher
// lightness, and not itself an authored color = a lighter tint.
const SYNTHETIC_STEP_MAX_HUE_DELTA = 12;      // degrees
const SYNTHETIC_STEP_MAX_SAT_DELTA = 0.2;
const SYNTHETIC_STEP_MIN_LIGHTNESS_DELTA = 0.04;
const SYNTHETIC_STEP_NEUTRAL_MAX_SATURATION = 0.06; // HSL saturation under this is gray/black/white, exempt (a muted sage like Fresho's #93AD98 is 0.14 and still a hue)

export type DecisionMarks = {
  traced_from_small_source: boolean;
  source_native_longest_px: number | null;
  source_derivation: string;
  source_ladder: { recorded: boolean; complete_for_trace: boolean; untried_over_floor: string[]; best_rung: string | null } | null;
  /** Toscano's cream, Skyboxx tan (2026-09-16/17): the secondary is a neutral or a non-mark (site token) color while the mark carries a saturated ink >= 3% that clears 3:1 on the primary. The sheet moves its default to that ink's column. */
  band_over_brand_ink: { reason: "neutral_secondary" | "secondary_not_a_mark_ink"; web_secondary_color: string; secondary_chroma: number; mark_ink: string; mark_ink_share: number; contrast_on_primary: number } | null;
  /** Q3 = A (2026-09-22): the secondary is a synthetic step of a brand ink or authored token. Darker is allowed (Fresho C, That's a Wrap K); lighter is rejected by the validator (Coloradough AA). */
  band_synthetic_step: { direction: "darker" | "lighter"; of: string; of_source: "mark_ink" | "site_token"; lightness_delta: number } | null;
};

export function validateFableDecision(packet: JsonObject, decision: JsonObject): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(decision)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unsupported_key:${key}`);
  }
  for (const key of ALLOWED_KEYS) {
    if (!(key in decision)) errors.push(`missing_key:${key}`);
  }
  const candidatePaths = new Set(
    asArray(packet.logo_candidates)
      .map(asObject)
      .map((candidate) => stringValue(candidate.local_path))
      .filter((value): value is string => value != null),
  );
  const logo = decision.logo_choice;
  if (logo !== null && (typeof logo !== "string" || !candidatePaths.has(logo))) {
    errors.push("logo_choice_not_in_evidence_packet");
  }
  if (!isObject(decision.palette)) errors.push("palette_must_be_object");
  else {
    for (const [role, color] of Object.entries(decision.palette)) {
      if (!/^[a-z][a-z0-9_]*$/i.test(role)) errors.push(`invalid_palette_role:${role}`);
      else if (!ALLOWED_PALETTE_ROLES.has(role)) errors.push(`unsupported_palette_role:${role}`);
      if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) errors.push(`invalid_palette_color:${role}`);
    }
    for (const role of REQUIRED_WEB_PALETTE_ROLES) {
      if (!(role in decision.palette)) errors.push(`missing_palette_role:${role}`);
    }
  }
  if (!stringValue(decision.composition)) errors.push("composition_must_be_nonempty");
  if (!stringValue(decision.rationale)) errors.push("rationale_must_be_nonempty");
  if (!["low", "medium", "high"].includes(String(decision.confidence))) errors.push("invalid_confidence");
  if (!Array.isArray(decision.flags) || !decision.flags.every((flag) => typeof flag === "string")) {
    errors.push("flags_must_be_string_array");
  } else if (requiresLowSharpnessFlag(packet, decision) && !decision.flags.includes("low_sharpness_candidate")) {
    errors.push("missing_required_flag:low_sharpness_candidate");
  }
  // WHITE PRIMARY (That's a Wrap 2026-09-17): the primary is the touchpoint page background; white or
  // near-white is a hard reject, same floor as the primary-too-light gate (1.3:1, Q8 = A 2026-09-22: authored cream/tan allowed).
  const primary = isObject(decision.palette) ? stringValue(decision.palette.web_primary_color) : null;
  if (primary && /^#[0-9a-f]{6}$/i.test(primary) && contrastVsWhite(primary) < PRIMARY_TOO_LIGHT.min_contrast_vs_white) {
    errors.push(`primary_too_light:${primary} is ${contrastVsWhite(primary).toFixed(2)}:1 against white (floor ${PRIMARY_TOO_LIGHT.min_contrast_vs_white}); only white and near-white are banned, an authored cream or tan card is fine when text reads black on it; a neutral-ink mark takes a black card with a white knockout`);
  }
  // SOURCE LADDER (Nector, Big Potato, Skyboxx 2026-09-18/21): a trace or upscale logo_choice needs every
  // rung with min_useful_px >= floor tried and recorded before it may be chosen.
  const ladderError = sourceLadderError(packet, decision);
  if (ladderError) errors.push(ladderError);
  // LIGHTER SYNTHETIC BAND (Q3 = A, 2026-09-22): a lighter tint of a brand ink is never a pick (Coloradough AA
  // "from nowhere real"); a darker step is allowed and only marked.
  const secondary = isObject(decision.palette) ? stringValue(decision.palette.web_secondary_color) : null;
  const step = secondary ? syntheticStep(packet, decision, secondary) : null;
  if (step && step.direction === "lighter") {
    errors.push(`band_lighter_synthetic:${secondary} is a lighter synthetic step of ${step.of_source === "mark_ink" ? "mark ink" : "authored site token"} ${step.of} (lightness +${step.lightness_delta.toFixed(2)}); a lighter tint is never a pick. Use the real ink, a darker step of it when the real ink fails band/digit contrast, or black`);
  }
  // EMBLEM KNOCKOUT (Q7 = A, 2026-09-22; Katy Q words-only, Coloradough AD open ridge): when the chosen card logo
  // is an emblem knockout whose interior detail collapsed, the default is words-only (flag mark_element_omitted
  // and say so), or the rationale explains an open/outline knockout. A solid silhouette is never the default.
  const emblem = emblemKnockoutCollapse(chosenCandidate(packet, decision));
  if (emblem) {
    const flags = Array.isArray(decision.flags) ? decision.flags.map(String) : [];
    const prose = `${stringValue(decision.composition) ?? ""} ${stringValue(decision.rationale) ?? ""}`;
    const wordsOnly = flags.includes("mark_element_omitted") && WORDS_ONLY_RE.test(prose);
    const openKnockout = OPEN_KNOCKOUT_RE.test(prose);
    if (!wordsOnly && !openKnockout) {
      errors.push(`emblem_knockout_needs_words_default:the chosen knockout loses the emblem's interior (${emblem}); the default card is words-only (add mark_element_omitted and direct the words-only cut, the full emblem stays on the sticker and POP), or explain an open/outline knockout in rationale. A solid silhouette is never the default (Katy Q, Coloradough AD)`);
    }
  }
  return errors;
}

const WORDS_ONLY_RE = /\bwords[- ]only\b/i;
const OPEN_KNOCKOUT_RE = /\b(open|outline)(?:-only)?\s+(knockout|ridge|cut)\b/i;
const KNOCKOUT_RE = /\bknockout\b/i;
const EMBLEM_COLLAPSE_RE = /glyph_counters_filled|interior_blob|interior_detail_lost|emblem_detail_lost|solid_silhouette|authored_white_dropped/i;

/**
 * Evidence that the chosen candidate is an emblem knockout whose interior collapsed (Katy's mug became a blob).
 * Reads what the packet may carry: a `treatment`/`source` naming a knockout, plus either a candidate-level
 * verdict (`counter_topology.verdict`, `emblem_detail.verdict`, `ink_retention.verdict`) or a mechanical_qa
 * summary that names the defect. Returns the evidence string or null. Exported for tests.
 */
export function emblemKnockoutCollapse(candidate: JsonObject | null): string | null {
  if (!candidate) return null;
  const treatment = `${stringValue(candidate.treatment) ?? ""} ${stringValue(candidate.source) ?? ""} ${stringValue(candidate.label) ?? ""}`;
  if (!KNOCKOUT_RE.test(treatment)) return null;
  const verdicts = ["counter_topology", "emblem_detail", "ink_retention", "text_legibility"]
    .map((key) => `${key}:${stringValue(asObject(candidate[key]).verdict) ?? ""}`)
    .filter((v) => EMBLEM_COLLAPSE_RE.test(v));
  if (verdicts.length) return verdicts.join(", ");
  const checks = asObject(asObject(candidate.mechanical_qa).checks);
  for (const [name, check] of Object.entries(checks)) {
    const text = JSON.stringify(check);
    if (EMBLEM_COLLAPSE_RE.test(text)) return `mechanical_qa.${name}: ${text.match(EMBLEM_COLLAPSE_RE)?.[0]}`;
  }
  return null;
}

/** Brand inks (mark inks >= 3% share) and theme-authored site tokens: the real colors a synthetic step could come from. */
function brandColors(packet: JsonObject, decision: JsonObject): Array<{ hex: string; source: "mark_ink" | "site_token" }> {
  const out: Array<{ hex: string; source: "mark_ink" | "site_token" }> = [];
  const chosen = chosenCandidate(packet, decision);
  for (const c of asArray(chosen?.measured_colors).map(asObject)) {
    const hex = stringValue(c.hex); const share = numberValue(c.pixel_share) ?? 0;
    if (hex && /^#[0-9a-f]{6}$/i.test(hex) && share >= BRAND_INK_MIN_SHARE) out.push({ hex, source: "mark_ink" });
  }
  for (const t of asArray(asObject(packet.website).authored_color_tokens).map(asObject)) {
    const hex = stringValue(t.hex);
    if (hex && /^#[0-9a-f]{6}$/i.test(hex) && t.evidence_class === "theme_authored") out.push({ hex, source: "site_token" });
  }
  return out;
}

/**
 * Is the secondary a synthetic lightness step of a brand color? Same hue, similar saturation, lightness moved, and
 * not within matching distance of any authored color. Neutrals (HSL saturation under 0.06) are exempt: a near-black
 * band (That's a Wrap K #1A1A1A) is a depth of black, not a tint of a hue. Exported for tests.
 */
export function syntheticStep(packet: JsonObject, decision: JsonObject, secondary: string): DecisionMarks["band_synthetic_step"] {
  if (!/^#[0-9a-f]{6}$/i.test(secondary) || hsl(secondary).s < SYNTHETIC_STEP_NEUTRAL_MAX_SATURATION) return null;
  const colors = brandColors(packet, decision);
  if (colors.some((c) => colorDistance(c.hex, secondary) < MARK_INK_MATCH_DISTANCE)) return null;
  const s = hsl(secondary);
  let best: DecisionMarks["band_synthetic_step"] = null;
  for (const c of colors) {
    const b = hsl(c.hex);
    if (b.s < SYNTHETIC_STEP_NEUTRAL_MAX_SATURATION) continue;
    const hueDelta = Math.abs(((s.h - b.h + 540) % 360) - 180);
    if (hueDelta > SYNTHETIC_STEP_MAX_HUE_DELTA || Math.abs(s.s - b.s) > SYNTHETIC_STEP_MAX_SAT_DELTA) continue;
    const delta = s.l - b.l;
    if (Math.abs(delta) < SYNTHETIC_STEP_MIN_LIGHTNESS_DELTA) continue;
    const step = { direction: delta > 0 ? "lighter" as const : "darker" as const, of: c.hex, of_source: c.source, lightness_delta: Number(delta.toFixed(3)) };
    if (!best || Math.abs(delta) < Math.abs(best.lightness_delta)) best = step;
  }
  return best;
}

/** The chosen candidate of a packet, or null. */
function chosenCandidate(packet: JsonObject, decision: JsonObject): JsonObject | null {
  if (typeof decision.logo_choice !== "string") return null;
  return asArray(packet.logo_candidates).map(asObject).find((candidate) => candidate.local_path === decision.logo_choice) ?? null;
}

function ladderOf(packet: JsonObject): LadderRecord | null {
  const ladder = asObject(asObject(packet.logo_sources).ladder);
  return Array.isArray(ladder.rungs) ? ladder as unknown as LadderRecord : null;
}

function sourceLadderError(packet: JsonObject, decision: JsonObject): string | null {
  const chosen = chosenCandidate(packet, decision);
  if (!chosen) return null;
  const info = sourceInfoForCandidate(packet, chosen);
  if (info.derivation !== "trace" && info.derivation !== "upscale") return null;
  const ladder = ladderOf(packet);
  if (ladder && ladder.complete_for_trace) return null;
  const floor = loadLadder().min_source_px_for_trace;
  const untried = ladder ? ladder.untried_over_floor : loadLadder().rungs.filter((r) => !r.locator_only && r.min_useful_px >= floor).map((r) => r.id);
  return `source_ladder_incomplete:${info.derivation} logo_choice but ${ladder ? "these" : "no ladder was recorded (logo_sources.ladder); all"} rungs with min_useful_px >= ${floor} were never tried: ${untried.join(", ")}. Record them in the evidence input (logo_sources[]) and rebuild the packet, or choose a native candidate.`;
}

/** Marks stored next to the six keys on the decision block (never inside them): small-source trace and neutral-band-over-brand-ink. */
export function decisionMarks(packet: JsonObject, decision: JsonObject): DecisionMarks {
  const chosen = chosenCandidate(packet, decision);
  const info = sourceInfoForCandidate(packet, chosen);
  const ladder = ladderOf(packet);
  const floor = loadLadder().min_source_px_for_trace;
  const bestPx = info.source_native_longest_px ?? ladder?.best?.longest_px ?? null;
  const traced = bestPx !== null && bestPx < floor && (info.derivation === "trace" || info.derivation === "upscale");
  const palette = asObject(decision.palette);
  const primary = stringValue(palette.web_primary_color);
  const secondary = stringValue(palette.web_secondary_color);
  let band: DecisionMarks["band_over_brand_ink"] = null;
  if (chosen && primary && secondary && /^#[0-9a-f]{6}$/i.test(primary) && /^#[0-9a-f]{6}$/i.test(secondary)) {
    const markInks = asArray(chosen.measured_colors).map(asObject)
      .map((c) => ({ hex: String(c.hex ?? ""), share: numberValue(c.pixel_share) ?? 0 }))
      .filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex) && c.share >= BRAND_INK_MIN_SHARE);
    const secondaryIsMarkInk = markInks.some((c) => colorDistance(c.hex, secondary) < MARK_INK_MATCH_DISTANCE);
    const secondaryChroma = chroma(secondary);
    const reason: DecisionMarks["band_over_brand_ink"] extends infer T ? (T extends { reason: infer R } ? R : never) : never =
      secondaryChroma < NEUTRAL_BAND_MAX_CHROMA ? "neutral_secondary" : "secondary_not_a_mark_ink";
    if (!secondaryIsMarkInk) {
      const inks = markInks
        .filter((c) => hsl(c.hex).s >= BRAND_INK_MIN_SATURATION && chroma(c.hex) >= NEUTRAL_BAND_MAX_CHROMA && hsl(c.hex).l < 0.93 && contrast(c.hex, primary) >= BRAND_INK_MIN_CONTRAST)
        .sort((a, b) => b.share - a.share);
      if (inks[0]) band = { reason, web_secondary_color: secondary, secondary_chroma: Number(secondaryChroma.toFixed(3)), mark_ink: inks[0].hex, mark_ink_share: inks[0].share, contrast_on_primary: Number(contrast(inks[0].hex, primary).toFixed(2)) };
    }
  }
  return {
    traced_from_small_source: traced,
    source_native_longest_px: bestPx,
    source_derivation: info.derivation,
    source_ladder: ladder ? { recorded: true, complete_for_trace: ladder.complete_for_trace, untried_over_floor: ladder.untried_over_floor, best_rung: ladder.best?.rung ?? null } : null,
    band_over_brand_ink: band,
    band_synthetic_step: secondary ? syntheticStep(packet, decision, secondary) : null,
  };
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** RGB chroma in 0..1: max channel minus min channel. Cream #E8E4DD is 0.04, tan #EFBA81 is 0.43, gray is 0. */
export function chroma(hex: string): number {
  const c = rgb(hex);
  return (Math.max(...c) - Math.min(...c)) / 255;
}
function colorDistance(a: string, b: string): number {
  const x = rgb(a); const y = rgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function hsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60; else if (max === g) h = ((b - r) / d + 2) * 60; else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
export function contrast(a: string, b: string): number {
  const la = luminance(a); const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function contrastVsWhite(hex: string): number {
  return contrast(hex, "#FFFFFF");
}

function requiresLowSharpnessFlag(packet: JsonObject, decision: JsonObject): boolean {
  if (typeof decision.logo_choice !== "string") return false;
  const candidates = asArray(packet.logo_candidates).map(asObject);
  const selected = candidates.find((candidate) => candidate.local_path === decision.logo_choice);
  if (!selected) return false;
  const selectedSharpness = asObject(selected.sharpness);
  if (selectedSharpness.classification !== "low") return false;
  const selectedValue = numberValue(selectedSharpness.value);
  const selectedProvenance = PROVENANCE_ORDER.indexOf(String(selected.provenance));
  if (selectedValue == null || selectedProvenance < 0) return false;
  return candidates.some((candidate) => {
    if (candidate === selected) return false;
    const provenance = PROVENANCE_ORDER.indexOf(String(candidate.provenance));
    const value = numberValue(asObject(candidate.sharpness).value);
    return provenance >= 0
      && Math.abs(provenance - selectedProvenance) <= 1
      && value != null
      && value >= Math.max(25, selectedValue * 1.5);
  });
}

function isObject(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = value;
      index += 1;
    }
  }
  return args;
}

const USAGE = [
  "Usage: --packet <branding-evidence.json> --decision <fable-decision.json>",
  "   or: --run <run_dir> [--packet <json>] [--decision <json>] [--force --reason \"<why>\"]",
  `With --run: the packet defaults to run.json's evidence.packet_path (else <run>/evidence/branding-evidence.json),`,
  `the decision file defaults to <run>/${DECISION_FILE_NAME} (the path Fable writes to; <run>/fable-decision.json is`,
  "the fallback), and a valid decision is stored verbatim in run.json as the decision block with its sha256.",
  "Nothing is retyped: the six keys are read from the file Fable wrote.",
].join("\n");

/** Resolve packet and decision paths for a run dir. Exported for tests. */
export function resolveRunPaths(runDir: string, overrides: { packet?: string; decision?: string } = {}): { packet: string; decision: string; evidence_fingerprint: string | null } {
  const run = readRun(runDir);
  const evidence = runAsObject(run.evidence);
  const packetDefault = typeof evidence.packet_path === "string"
    ? (path.isAbsolute(evidence.packet_path) ? evidence.packet_path : path.join(runDir, evidence.packet_path))
    : path.join(runDir, "evidence", "branding-evidence.json");
  const decisionDefault = [path.join(runDir, DECISION_FILE_NAME), path.join(runDir, "fable-decision.json")].find((file) => fs.existsSync(file))
    ?? path.join(runDir, DECISION_FILE_NAME);
  return {
    packet: path.resolve(overrides.packet ?? packetDefault),
    decision: path.resolve(overrides.decision ?? decisionDefault),
    evidence_fingerprint: typeof evidence.evidence_fingerprint === "string" ? evidence.evidence_fingerprint : null,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runDir = typeof args.run === "string" ? path.resolve(args.run) : null;
  const packetArg = typeof args.packet === "string" ? args.packet : undefined;
  const decisionArg = typeof args.decision === "string" ? args.decision : undefined;
  if (!runDir && (!packetArg || !decisionArg)) throw new Error(USAGE);
  const paths = runDir
    ? resolveRunPaths(runDir, { packet: packetArg, decision: decisionArg })
    : { packet: path.resolve(packetArg as string), decision: path.resolve(decisionArg as string), evidence_fingerprint: null };
  if (!fs.existsSync(paths.decision)) throw new Error(`Decision file not found: ${paths.decision} (Fable writes <run_dir>/${DECISION_FILE_NAME})`);
  const packet = JSON.parse(fs.readFileSync(paths.packet, "utf8")) as JsonObject;
  const decision = JSON.parse(fs.readFileSync(paths.decision, "utf8")) as JsonObject;
  const errors = validateFableDecision(packet, decision);
  const marks = decisionMarks(packet, decision);
  let stored: string | null = null;
  if (!errors.length && runDir) {
    const packetFingerprint = typeof packet.evidence_fingerprint === "string" ? packet.evidence_fingerprint : paths.evidence_fingerprint;
    // the six keys stay verbatim; the marks sit beside them so the sheet and the canvas can read them
    const block = { ...decisionBlockFromFile(paths.decision, { evidence_fingerprint: packetFingerprint }), marks };
    setBlock(runDir, "decision", block, {
      by: "validate-fable-decision",
      force: args.force === true,
      reason: typeof args.reason === "string" ? args.reason : undefined,
    });
    stored = String(block.decision_sha256);
  }
  process.stdout.write(`${JSON.stringify({ valid: errors.length === 0, errors, marks, decision: paths.decision, packet: paths.packet, ...(runDir ? { run: runDir, stored_sha256: stored } : {}) }, null, 2)}\n`);
  if (errors.length) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
