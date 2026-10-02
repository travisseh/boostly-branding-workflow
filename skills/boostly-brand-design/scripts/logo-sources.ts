#!/usr/bin/env node
// logo-sources.ts: the logo source ladder as data (../references/logo-source-ladder.json).
//
//   ladderRecord(tried)                  build branding-evidence.json `logo_sources.ladder` from the rungs a run tried
//   ladderCompleteForTrace(ladder)       true when every rung with min_useful_px >= floor was tried
//   sourceInfoForCandidate(packet, cand) native source px + derivation for a candidate (recorded fields first,
//                                        then the ladder's best source, then the candidate's own prose)
//   inferSourceForRun(runDir, run, logo) the same for an older run with no recorded ladder: candidate prose
//                                        ("640x394 Facebook avatar") and raw source files under candidates/
//
// CLI: node --experimental-strip-types logo-sources.ts ladder            print the rungs
//      node --experimental-strip-types logo-sources.ts infer --run <dir>  print the inferred source for the applied logo

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LADDER_JSON = path.resolve(HERE, '..', 'references', 'logo-source-ladder.json');

export type LadderRung = { id: string; label: string; fetch_hint: string; min_useful_px: number; provenance: string; vector?: boolean; locator_only?: boolean };
export type Ladder = { schema_version: number; min_source_px_for_trace: number; rules: Record<string, string>; rungs: LadderRung[] };
export type TriedRung = { rung: string; tried: boolean; longest_px?: number | null; width?: number | null; height?: number | null; url?: string | null; note?: string | null; local_path?: string | null; reason?: string | null };
export type LadderRecord = {
  floor_px: number;
  rungs: Array<TriedRung & { min_useful_px: number; provenance: string; unknown_rung?: boolean }>;
  tried: string[];
  untried_over_floor: string[];
  complete_for_trace: boolean;
  best: { rung: string; longest_px: number; url: string | null; local_path: string | null; note: string | null } | null;
  best_under_floor: boolean | null;
};
export type Derivation = 'native' | 'vector' | 'trace' | 'upscale' | 'unknown';
export type SourceInfo = { source_native_longest_px: number | null; derivation: Derivation; note: string | null; inferred: boolean; from: string };

let cache: Ladder | null = null;
export function loadLadder(): Ladder {
  if (!cache) cache = JSON.parse(fs.readFileSync(LADDER_JSON, 'utf8')) as Ladder;
  return cache;
}

/** The ladder record for a packet: every rung of the JSON, in order, with what the run tried. */
export function ladderRecord(tried: TriedRung[] = []): LadderRecord {
  const ladder = loadLadder();
  const floor = ladder.min_source_px_for_trace;
  const byId = new Map(tried.map((t) => [t.rung, t]));
  const rungs = ladder.rungs.map((rung) => {
    const t = byId.get(rung.id);
    return { rung: rung.id, min_useful_px: rung.min_useful_px, provenance: rung.provenance, tried: Boolean(t?.tried), longest_px: t?.longest_px ?? (t?.width && t?.height ? Math.max(Number(t.width), Number(t.height)) : null), width: t?.width ?? null, height: t?.height ?? null, url: t?.url ?? null, note: t?.note ?? null, local_path: t?.local_path ?? null, reason: t?.reason ?? null };
  });
  for (const t of tried) if (!ladder.rungs.some((r) => r.id === t.rung)) rungs.push({ rung: t.rung, min_useful_px: 0, provenance: 'unknown', tried: Boolean(t.tried), longest_px: t.longest_px ?? null, width: t.width ?? null, height: t.height ?? null, url: t.url ?? null, note: t.note ?? null, local_path: t.local_path ?? null, reason: t.reason ?? null, unknown_rung: true });
  const triedIds = rungs.filter((r) => r.tried).map((r) => r.rung);
  const untried = ladder.rungs.filter((r) => !r.locator_only && r.min_useful_px >= floor && !byId.get(r.id)?.tried).map((r) => r.id);
  const withPx = rungs.filter((r) => r.tried && typeof r.longest_px === 'number' && (r.longest_px as number) > 0 && !ladder.rungs.find((x) => x.id === r.rung)?.locator_only);
  withPx.sort((a, b) => Number(b.longest_px) - Number(a.longest_px));
  const best = withPx[0] ? { rung: withPx[0].rung, longest_px: Number(withPx[0].longest_px), url: withPx[0].url ?? null, local_path: withPx[0].local_path ?? null, note: withPx[0].note ?? null } : null;
  return { floor_px: floor, rungs, tried: triedIds, untried_over_floor: untried, complete_for_trace: untried.length === 0, best, best_under_floor: best ? best.longest_px < floor : null };
}

export function ladderCompleteForTrace(record: LadderRecord | null | undefined): boolean {
  return Boolean(record && record.complete_for_trace);
}

const TRACE_RE = /\b(potrace|traced|trace of|vector trace|retrace|hybrid retrace|re-?traced)\b/i;
const UPSCALE_RE = /\b(upscal\w*|lanczos up\w*|upsampl\w*|super-?resolution)\b/i;
const VECTOR_RE = /\b(\.svg|inline svg|vector source|authored svg)\b/i;
const SIZE_RE = /(\d{2,4})\s*[x×]\s*(\d{2,4})/g;

export function derivationFromProse(text: string | null | undefined): Derivation {
  const s = String(text ?? '');
  if (!s) return 'unknown';
  if (VECTOR_RE.test(s) && !TRACE_RE.test(s)) return 'vector';
  if (TRACE_RE.test(s)) return 'trace';
  if (UPSCALE_RE.test(s)) return 'upscale';
  return 'unknown';
}

/** Pixel sizes mentioned in candidate prose, excluding the candidate's own dimensions. */
export function sizesFromProse(text: string | null | undefined, own: { width?: number | null; height?: number | null } = {}): number[] {
  const out: number[] = [];
  for (const m of String(text ?? '').matchAll(SIZE_RE)) {
    const w = Number(m[1]); const h = Number(m[2]);
    if (own.width && own.height && ((w === own.width && h === own.height) || (w === own.height && h === own.width))) continue;
    if (w < 16 || h < 16 || w > 8000 || h > 8000) continue;
    out.push(Math.max(w, h));
  }
  return out;
}

const RAW_SOURCE_FILES: Array<[RegExp, string]> = [
  [/^site-logo-original\./, 'site header, original file'],
  [/^site-logo-w\d+\./, 'site header, CDN rendition'],
  [/^fb-avatar-large\./, 'Facebook avatar, large'],
  [/^fb-avatar\./, 'Facebook avatar'],
  [/^fb-og-image\./, 'Facebook share image'],
  [/^fb-pic-\d+\./, 'Facebook profile picture'],
  [/^ig-og-image\./, 'Instagram share image'],
  [/^ig-profile-?\d*\./, 'Instagram profile picture'],
  [/^favicon-original\./, 'favicon, original'],
  [/^wizard-attachment\./, 'onboarding wizard upload'],
  [/^customer-logo/, 'customer-supplied logo'],
  [/^toast-logo/, 'Toast logo'],
  [/^chownow-logo/, 'ChowNow logo'],
];

/** Synchronous PNG/JPEG header read (sharp.metadata is async and this runs inside sync replay loops). */
export function pngSize(file: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(32);
      fs.readSync(fd, head, 0, 32, 0);
      if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
      if (head[0] === 0xff && head[1] === 0xd8) {
        // JPEG: walk the markers for SOF0/SOF2
        const buf = fs.readFileSync(file);
        let i = 2;
        while (i < buf.length) {
          if (buf[i] !== 0xff) { i += 1; continue; }
          const marker = buf[i + 1];
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
          const len = buf.readUInt16BE(i + 2);
          if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
          i += 2 + len;
        }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* unreadable */ }
  return null;
}

/** Raw source files under <run>/candidates and <run>/evidence/logo-candidates with their pixel sizes. */
export function rawSourceFiles(runDir: string): Array<{ file: string; label: string; longest_px: number }> {
  const out: Array<{ file: string; label: string; longest_px: number }> = [];
  for (const sub of ['candidates', 'evidence/logo-candidates', 'fix/hq/src', 'customer-logos']) {
    const dir = path.join(runDir, sub);
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const hit = RAW_SOURCE_FILES.find(([re]) => re.test(name));
      if (!hit) continue;
      const file = path.join(dir, name);
      const size = pngSize(file);
      if (!size) continue;
      out.push({ file, label: hit[1], longest_px: Math.max(size.width, size.height) });
    }
  }
  return out.sort((a, b) => b.longest_px - a.longest_px);
}

/** Source info for a candidate of a packet: recorded fields, the ladder's best source, then prose. */
export function sourceInfoForCandidate(packet: JsonObject | null, candidate: JsonObject | null): SourceInfo {
  const c = candidate ?? {};
  const recordedPx = typeof c.source_native_px === 'number' ? c.source_native_px : null;
  const recordedDerivation = typeof c.derivation === 'string' ? (c.derivation as Derivation) : null;
  if (recordedPx !== null || recordedDerivation) {
    return { source_native_longest_px: recordedPx, derivation: recordedDerivation ?? derivationFromProse(String(c.source ?? '')), note: 'recorded on the candidate', inferred: false, from: 'candidate' };
  }
  const ladder = (packet?.logo_sources as JsonObject | undefined)?.ladder as LadderRecord | undefined;
  const prose = String(c.source ?? '');
  const derivation = derivationFromProse(prose);
  if (ladder?.best) {
    return { source_native_longest_px: ladder.best.longest_px, derivation: derivation === 'unknown' ? (Number(c.width ?? 0) > ladder.best.longest_px ? 'upscale' : 'native') : derivation, note: `ladder best: ${ladder.best.rung}`, inferred: false, from: 'ladder' };
  }
  const sizes = sizesFromProse(prose, { width: c.width as number, height: c.height as number });
  if (sizes.length) {
    const own = Math.max(Number(c.width ?? 0), Number(c.height ?? 0));
    const px = Math.max(...sizes);
    return { source_native_longest_px: px, derivation: derivation === 'unknown' ? (own > px ? 'upscale' : 'native') : derivation, note: `size named in the candidate's source prose`, inferred: true, from: 'prose' };
  }
  return { source_native_longest_px: null, derivation, note: null, inferred: true, from: 'none' };
}

/** Source info for the applied logo of a run: the packet's candidate that matches the file, else the raw files on disk. */
export function inferSourceForRun(runDir: string, run: JsonObject, logoAbs: string): SourceInfo {
  const evidence = (run.evidence ?? {}) as JsonObject;
  const packetPath = typeof evidence.packet_path === 'string' ? (path.isAbsolute(evidence.packet_path) ? evidence.packet_path : path.join(runDir, evidence.packet_path)) : path.join(runDir, 'evidence', 'branding-evidence.json');
  let packet: JsonObject | null = null;
  try { packet = JSON.parse(fs.readFileSync(packetPath, 'utf8')) as JsonObject; } catch { packet = null; }
  const candidates = (Array.isArray(packet?.logo_candidates) ? packet!.logo_candidates : Array.isArray(evidence.logo_candidates) ? evidence.logo_candidates : []) as JsonObject[];
  const decision = (run.decision ?? {}) as JsonObject;
  const logoSize = pngSize(logoAbs);
  const own = logoSize ? Math.max(logoSize.width, logoSize.height) : null;
  // 1. the chosen candidate, or the candidate whose file is the applied logo
  const chosen = candidates.find((c) => typeof c.local_path === 'string' && (path.resolve(c.local_path) === path.resolve(logoAbs) || c.local_path === decision.logo_choice)) ?? null;
  const fromCandidate = sourceInfoForCandidate(packet, chosen);
  if (fromCandidate.source_native_longest_px !== null) {
    const der = fromCandidate.derivation === 'unknown' && own && own > fromCandidate.source_native_longest_px ? 'upscale' : fromCandidate.derivation;
    return { ...fromCandidate, derivation: der };
  }
  // 1b. a first-party or human-supplied chosen candidate with no size prose is itself the native source
  if (chosen && fromCandidate.derivation === 'unknown' && /^(first_party|human_supplied)/.test(String(chosen.provenance ?? '')) && Number(chosen.width) > 0) {
    const px = Math.max(Number(chosen.width), Number(chosen.height));
    return { source_native_longest_px: px, derivation: own && own > px ? 'upscale' : 'native', note: `the chosen candidate is the native source (${path.basename(String(chosen.local_path ?? ''))} ${chosen.width}x${chosen.height})`, inferred: true, from: 'candidate_size' };
  }
  // 2. any candidate prose that names a size smaller than the applied logo (the raster the cuts came from)
  for (const c of candidates) {
    const sizes = sizesFromProse(String(c.source ?? ''), { width: c.width as number, height: c.height as number });
    if (!sizes.length) continue;
    const px = Math.max(...sizes);
    const der = derivationFromProse(String(c.source ?? ''));
    return { source_native_longest_px: px, derivation: der === 'unknown' ? (own && own > px ? 'upscale' : 'native') : der, note: `size named in candidate prose (${path.basename(String(c.local_path ?? ''))})`, inferred: true, from: 'prose' };
  }
  // 3. raw source files on disk
  const raw = rawSourceFiles(runDir);
  if (raw.length) {
    const best = raw[0];
    const der = fromCandidate.derivation !== 'unknown' ? fromCandidate.derivation : own && own > best.longest_px ? 'upscale' : 'native';
    return { source_native_longest_px: best.longest_px, derivation: der, note: `${best.label} (${path.relative(runDir, best.file)})`, inferred: true, from: 'raw_file' };
  }
  return { source_native_longest_px: null, derivation: fromCandidate.derivation, note: null, inferred: true, from: 'none' };
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === 'ladder') {
    const ladder = loadLadder();
    process.stdout.write(`${JSON.stringify({ file: LADDER_JSON, floor_px: ladder.min_source_px_for_trace, rungs: ladder.rungs.map((r) => ({ id: r.id, min_useful_px: r.min_useful_px, provenance: r.provenance, locator_only: r.locator_only ?? false })) }, null, 2)}\n`);
    return;
  }
  if (command === 'infer') {
    const i = rest.indexOf('--run');
    const runDir = i >= 0 ? path.resolve(rest[i + 1]) : null;
    if (!runDir) throw new Error('infer needs --run <run_dir> [--logo <png>]');
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as JsonObject;
    const l = rest.indexOf('--logo');
    const write = (run.write ?? {}) as JsonObject;
    const rel = l >= 0 ? rest[l + 1] : (typeof write.logo_file_resolved === 'string' ? write.logo_file_resolved : typeof write.logo_file === 'string' ? write.logo_file.split(/\s+/)[0] : null);
    if (!rel) throw new Error('no applied logo recorded; pass --logo <png>');
    const logo = path.isAbsolute(rel) ? rel : path.join(runDir, rel);
    process.stdout.write(`${JSON.stringify({ run: runDir, logo, ...inferSourceForRun(runDir, run, logo) }, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: logo-sources.ts ladder | infer --run <run_dir> [--logo <png>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
