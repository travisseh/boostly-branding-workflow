#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { measureCandidateSharpness } from "./logo-quality-gates.ts";
import { ladderRecord, type TriedRung } from "./logo-sources.ts";

type JsonObject = Record<string, unknown>;

export type LogoCandidateInput = {
  source: string;
  provenance: "human_supplied" | "first_party_header" | "first_party_jsonld" | "first_party_other" | "imagegen_simplified" | "gbp" | "social";
  path?: string;
  url?: string;
  /** Longest side of the verified native source this candidate was made from (the edge-quality gate's effective resolution). */
  source_native_px?: number;
  /** How the candidate was made from that source. */
  derivation?: "native" | "vector" | "trace" | "upscale";
};

export type BrandingEvidenceInput = {
  location: {
    location_id: string;
    location_name: string;
    account_id: string;
    website_url: string | null;
    address?: string;
    google_place_id?: string | null;
  };
  website_content_hash: string;
  website_html_files?: string[];
  website_visual_evidence?: WebsiteVisualEvidenceInput;
  logo_candidates: LogoCandidateInput[];
  /** The source-ladder rungs the run tried (references/logo-source-ladder.json), recorded as logo_sources.ladder. */
  logo_sources?: TriedRung[];
  gbp_manifest?: string;
  brand_environment_manifest?: string;
  production_branding: JsonObject;
  feedback_case: JsonObject | null;
  prior_packet?: JsonObject;
  prior_fable_judgment?: JsonObject;
};

export type WebsiteVisualEvidenceInput = {
  status: "captured" | "unavailable";
  desktop_screenshot?: string;
  mobile_screenshot?: string;
  computed_styles_manifest?: string;
  reason?: string;
};

const PROVENANCE_SCORE: Record<LogoCandidateInput["provenance"], number> = {
  human_supplied: 600,
  first_party_header: 500,
  first_party_jsonld: 450,
  first_party_other: 400,
  imagegen_simplified: 300,
  gbp: 250,
  social: 150,
};
export const BRAND_ENVIRONMENT_JUDGMENT_POLICY = {
  purpose: "Use exact-place photos to establish deliberate physical brand usage, not to invent a logo or sample incidental scene colors.",
  may_outrank: [
    "framework_default_risk website colors",
    "CSS colors absent from screenshot-visible semantic surfaces",
    "generic template chrome or a single low-salience CTA without independent brand corroboration",
  ],
  may_not_outrank: [
    "human-supplied exact assets",
    "the current verified first-party brand identity",
    "a repeated screenshot-visible theme-authored website system",
  ],
  qualifying_corroboration: [
    {
      mode: "repeated_exact_place_usage",
      minimum_perceptually_unique_images: 2,
      requirement: "The same deliberate brand-owned signage, mark treatment, collateral treatment, or color family appears independently in both exact-place images.",
    },
    {
      mode: "exceptional_permanent_sign_plus_first_party",
      minimum_perceptually_unique_images: 1,
      requirement: "One exceptionally clear permanent exact-location sign agrees with an independent human_supplied or first_party_* logo/collateral asset or a screenshot-visible theme_authored website signal.",
    },
  ],
  permitted_treatment_evidence: [
    "faithful_simplified_mark",
    "full_white_knockout",
    "one_color_mark",
  ],
  excluded_color_causes: [
    "food_or_drink",
    "lighting_or_camera_color_cast",
    "general_decor_or_furniture",
    "uniforms",
    "seasonal_items",
    "one_off_objects",
    "third_party_or_vendor_signage",
    "neighbor_or_sibling_branding",
  ],
  exact_hex_rule: "Use exact-place photos to choose treatment and color family or role. Prefer an agreeing authored token, logo pixel, or first-party collateral value for the emitted hex. Never sample a whole-scene photo as an exact brand color.",
  conflict_rule: "If physical signage conflicts with the current verified first-party identity or appears stale, lower confidence and flag environment_sign_conflicts_current_identity instead of elevating it.",
} as const;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Image harness lives inside this skill (boostly-brand-design/harness) so the skill is self-contained.
const HARNESS_DIR = path.resolve(SCRIPT_DIR, "..", "harness");
const DEFAULT_HARNESS = path.join(HARNESS_DIR, "iterate-logo-rules.mjs");
const require = createRequire(import.meta.url);

export async function buildBrandingEvidencePacket(
  input: BrandingEvidenceInput,
  outDir: string,
  options: { harness?: string; now?: string } = {},
): Promise<JsonObject> {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  assertInput(input);
  fs.mkdirSync(outDir, { recursive: true });
  const assetsDir = path.join(outDir, "logo-candidates");
  fs.mkdirSync(assetsDir, { recursive: true });

  const logos = [];
  for (const [index, candidate] of input.logo_candidates.entries()) {
    const localPath = await materializeAsset(candidate, assetsDir, index);
    const metadata = await inspectImage(localPath);
    const sharpness = await measureCandidateSharpness(localPath);
    const qa = mechanicalQa(localPath, options.harness ?? DEFAULT_HARNESS);
    logos.push({
      source: candidate.source,
      provenance: candidate.provenance,
      local_path: localPath,
      sha256: sha256File(localPath),
      ...metadata,
      source_native_px: typeof candidate.source_native_px === "number" ? candidate.source_native_px : null,
      derivation: candidate.derivation ?? null,
      gradient_families: gradientFamilies((metadata.measured_colors as Array<{ hex: string; pixel_share: number }>) ?? []),
      sharpness,
      mechanical_qa: qa,
      rank_score: PROVENANCE_SCORE[candidate.provenance] + Math.min(200, Math.floor((Number(metadata.width) * Number(metadata.height)) / 100_000)),
    });
  }
  logos.sort((left, right) => Number(right.rank_score) - Number(left.rank_score) || String(left.sha256).localeCompare(String(right.sha256)));
  const uniqueLogos = logos.filter((logo, index, all) =>
    all.findIndex((candidate) => candidate.sha256 === logo.sha256) === index,
  );

  const gbp = input.gbp_manifest ? await buildGbpEvidence(input.gbp_manifest, outDir) : {
    status: "unavailable",
    manifest: null,
    manifest_sha256: null,
    photos: [],
    contact_sheet: null,
    detail_images: [],
  };
  const gbpEnvironmentCandidates = Array.isArray(gbp.brand_environment_candidates)
    ? gbp.brand_environment_candidates
    : [];
  const brandEnvironment = input.brand_environment_manifest
    ? await buildBrandEnvironmentEvidence(input.brand_environment_manifest, input.location.google_place_id ?? null, outDir)
    : gbpEnvironmentCandidates.length
      ? {
          status: "available",
          source: "google_places_selected_photos",
          reason: null,
          manifest: gbp.manifest,
          manifest_sha256: gbp.manifest_sha256,
          selected_candidates: gbpEnvironmentCandidates,
          contact_sheet: gbp.contact_sheet,
          detail_images: gbpEnvironmentCandidates.map((candidate) => candidate.path),
          flags: [],
          judgment_policy: BRAND_ENVIRONMENT_JUDGMENT_POLICY,
        }
    : {
        status: "unavailable",
        reason: "brand_environment_manifest_not_provided",
        manifest: null,
        manifest_sha256: null,
        selected_candidates: [],
        contact_sheet: null,
        detail_images: [],
        flags: ["searchapi_environment_unavailable"],
        judgment_policy: BRAND_ENVIRONMENT_JUDGMENT_POLICY,
      };
  const websiteVisual = await buildWebsiteVisualEvidence(input.website_visual_evidence, input.location.website_url, outDir);
  const authoredColors = extractAuthoredColorTokens(input.website_html_files ?? []);
  const logoSources = { ladder: ladderRecord(input.logo_sources ?? []), recorded: Array.isArray(input.logo_sources) };
  const fingerprintInputs = {
    website_content_hash: input.website_content_hash,
    logo_sources: uniqueLogos.map((logo) => ({
      source: logo.source,
      provenance: logo.provenance,
      sha256: logo.sha256,
    })),
    gbp_evidence_hash: stringValue(gbp.manifest_sha256),
    brand_environment_evidence_hash: stringValue(brandEnvironment.manifest_sha256),
    brand_environment_judgment_policy: BRAND_ENVIRONMENT_JUDGMENT_POLICY,
    website_visual_evidence: {
      status: websiteVisual.status,
      desktop_sha256: stringValue(asObject(websiteVisual.desktop_screenshot).sha256),
      mobile_sha256: stringValue(asObject(websiteVisual.mobile_screenshot).sha256),
      computed_styles_sha256: stringValue(websiteVisual.computed_styles_sha256),
      reason: stringValue(websiteVisual.reason),
    },
    production_branding: input.production_branding,
    feedback_case: input.feedback_case,
  };
  const evidenceFingerprint = sha256Json(fingerprintInputs);
  const priorFingerprint = stringValue(input.prior_packet?.evidence_fingerprint);
  const canReuse = Boolean(
    priorFingerprint &&
    priorFingerprint === evidenceFingerprint &&
    input.prior_fable_judgment,
  );

  const packet: JsonObject = {
    schema_version: 4,
    generated_at: options.now ?? new Date().toISOString(),
    location: input.location,
    evidence_fingerprint: evidenceFingerprint,
    reuse: {
      eligible: canReuse,
      reason: canReuse ? "all_reuse_inputs_unchanged" : "evidence_or_feedback_changed",
      prior_judgment: canReuse ? input.prior_fable_judgment : null,
    },
    website: {
      content_hash: input.website_content_hash,
      authored_color_tokens: authoredColors,
      visual_evidence: websiteVisual,
    },
    logo_candidates: uniqueLogos,
    logo_sources: logoSources,
    gbp,
    brand_environment: brandEnvironment,
    production_branding: input.production_branding,
    feedback_case: input.feedback_case,
    stage_metrics: [{
      stage: "branding_evidence",
      started_at: startedAt,
      duration_ms: Number((performance.now() - startedMs).toFixed(3)),
      counters: {
        logo_candidates_input: input.logo_candidates.length,
        logo_candidates_unique: uniqueLogos.length,
        authored_color_tokens: authoredColors.length,
        website_visual_screenshots: websiteVisual.status === "captured" ? 2 : 0,
        gbp_photos: Array.isArray(gbp.photos) ? gbp.photos.length : 0,
        brand_environment_images: Array.isArray(brandEnvironment.selected_candidates) ? brandEnvironment.selected_candidates.length : 0,
      },
      outcome: "ok",
    }],
    fable_contract: {
      model: "fable",
      allowed_judgments: ["logo_choice", "palette", "composition", "confidence", "flags", "rationale"],
      required_output: {
        logo_choice: "local_path_or_null",
        palette: {
          required: ["web_primary_color", "web_secondary_color", "web_text_color"],
          optional: ["print_primary_color", "print_secondary_color", "print_text_color", "print_text_secondary_color"],
          values: "six_digit_hex",
        },
        composition: "string",
        confidence: "low|medium|high",
        flags: "string[]",
        rationale: "string",
      },
      forbidden_work: [
        "asset_download",
        "background_removal",
        "resizing",
        "color_extraction",
        "mechanical_qa",
        "production_write",
        "slack_or_notion_prose",
      ],
      palette_evidence_rule: "Inspect mandatory website screenshots and exact-place physical-brand evidence together. Repeated screenshot-visible theme-authored systems remain authoritative; corroborated deliberate exact-place signage or collateral may outrank framework defaults, off-screen CSS, generic template chrome, or a single low-salience CTA. Use authored values for exact hex whenever available.",
      logo_integrity_rule: "Open every viable logo candidate and reject malformed glyphs, filled counters, fused strokes, broken negative space, invented spelling, or damaged letter anatomy even when OCR passes. If all candidates are defective, choose null and flag malformed_glyph_topology.",
      environment_evidence_rule: "Use only selected exact-place brand_environment images. Require either two perceptually unique images showing the same deliberate brand usage, or one exceptionally clear permanent sign plus an independent first-party signal. Physical evidence may justify a faithful simplified, full-knockout, or one-color treatment, but never a new logo identity. Exclude food, lighting casts, decor, uniforms, seasonal items, one-off objects, vendor signage, and neighboring brands.",
      required_conditional_flags: {
        mark_element_omitted: "Required when another candidate or qualifying exact-place image shows a distinctive non-text element absent from the chosen logo.",
        low_sharpness_candidate: "Required when choosing a low-sharpness candidate over a materially sharper candidate of equal or adjacent provenance; rationale must explain why.",
      },
    },
  };
  const packetPath = path.join(outDir, "branding-evidence.json");
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { ...packet, packet_path: packetPath };
}

function assertInput(input: BrandingEvidenceInput): void {
  if (!input.location?.location_id || !input.location.account_id) throw new Error("Missing location identity");
  if (!/^[a-f0-9]{32,128}$/i.test(input.website_content_hash)) {
    throw new Error("website_content_hash must be a stable hexadecimal content hash");
  }
  if (!Array.isArray(input.logo_candidates)) throw new Error("logo_candidates must be an array");
  if (input.brand_environment_manifest && !stringValue(input.location.google_place_id)) {
    throw new Error("location.google_place_id is required with brand_environment_manifest");
  }
  if (input.location.website_url && !input.website_visual_evidence) {
    throw new Error("website_visual_evidence is required when website_url is present");
  }
  if (input.website_visual_evidence && !["captured", "unavailable"].includes(input.website_visual_evidence.status)) {
    throw new Error(`Unknown website visual evidence status: ${String(input.website_visual_evidence.status)}`);
  }
  if (input.website_visual_evidence?.status === "captured") {
    for (const field of ["desktop_screenshot", "mobile_screenshot", "computed_styles_manifest"] as const) {
      if (!stringValue(input.website_visual_evidence[field])) throw new Error(`Captured website visual evidence missing ${field}`);
    }
  } else if (input.website_visual_evidence?.status === "unavailable" && !stringValue(input.website_visual_evidence.reason)) {
    throw new Error("Unavailable website visual evidence requires a reason");
  }
  for (const candidate of input.logo_candidates) {
    if (!candidate.path && !candidate.url) throw new Error(`Logo candidate lacks path/url: ${candidate.source}`);
    if (!(candidate.provenance in PROVENANCE_SCORE)) throw new Error(`Unknown logo provenance: ${candidate.provenance}`);
  }
}

async function materializeAsset(candidate: LogoCandidateInput, outDir: string, index: number): Promise<string> {
  const ext = path.extname(candidate.path ?? new URL(candidate.url as string).pathname) || ".png";
  const out = path.join(outDir, `${String(index + 1).padStart(2, "0")}-${safeSegment(candidate.provenance)}${ext.toLowerCase()}`);
  if (candidate.path) {
    const source = path.resolve(candidate.path);
    if (!fs.existsSync(source)) throw new Error(`Logo candidate file does not exist: ${source}`);
    fs.copyFileSync(source, out);
    return out;
  }
  const response = await fetch(candidate.url as string, { redirect: "follow" });
  if (!response.ok) throw new Error(`Logo download returned HTTP ${response.status}: ${candidate.url}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) throw new Error(`Logo download is not an image: ${candidate.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error(`Logo download size rejected: ${candidate.url}`);
  fs.writeFileSync(out, bytes);
  return out;
}

async function inspectImage(file: string): Promise<JsonObject> {
  const sharp = sharpModule();
  const image = sharp(file, { failOn: "error" });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Image has no dimensions: ${file}`);
  const paletteImage = await image
    .clone()
    .ensureAlpha()
    .resize(128, 128, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format ?? null,
    has_alpha: Boolean(metadata.hasAlpha),
    bytes: fs.statSync(file).size,
    measured_colors: measuredLogoColors(paletteImage.data, paletteImage.info.channels),
  };
}

function measuredLogoColors(data: Buffer, channels: number): Array<{ hex: string; pixel_share: number }> {
  const bins = new Map<string, { count: number; red: number; green: number; blue: number }>();
  let opaquePixels = 0;
  for (let offset = 0; offset < data.length; offset += channels) {
    const alpha = channels >= 4 ? data[offset + 3] : 255;
    if (alpha < 128) continue;
    opaquePixels += 1;
    const quantized = [data[offset], data[offset + 1], data[offset + 2]]
      .map((value) => Math.round(value / 16) * 16)
      .map((value) => Math.min(255, value));
    const key = quantized.join(":");
    const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bin.count += 1;
    bin.red += data[offset];
    bin.green += data[offset + 1];
    bin.blue += data[offset + 2];
    bins.set(key, bin);
  }
  if (!opaquePixels) return [];
  return [...bins.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([, bin]) => ({
      hex: rgbHex(bin.red / bin.count, bin.green / bin.count, bin.blue / bin.count),
      pixel_share: Number((bin.count / opaquePixels).toFixed(4)),
    }));
}

/**
 * Gradient families in a candidate's measured colors (Coloradough 2026-09-18): buckets of the same hue
 * (within hue_tolerance degrees) whose lightness spans at least min_lightness_span. The band ink for a
 * gradient mark is the family's CENTER (the share-weighted median lightness bucket), never the dark
 * pole; a site CTA that happens to match the pole must not stand in for the mark ink.
 */
export function gradientFamilies(
  colors: Array<{ hex: string; pixel_share: number }>,
  options: { hue_tolerance?: number; min_lightness_span?: number; min_saturation?: number; min_family_share?: number } = {},
): Array<{ hue: number; center_hex: string; dark_pole: string; light_pole: string; pixel_share: number; buckets: number }> {
  const hueTol = options.hue_tolerance ?? 14;
  const minSpan = options.min_lightness_span ?? 0.12;
  const minSat = options.min_saturation ?? 0.25;
  const minShare = options.min_family_share ?? 0.03;
  const parsed = colors
    .map((c) => ({ ...c, hsl: hexToHsl(c.hex) }))
    .filter((c) => c.hsl.s >= minSat && c.hsl.l > 0.06 && c.hsl.l < 0.94);
  const families: Array<typeof parsed> = [];
  for (const color of parsed) {
    const family = families.find((f) => hueDistance(f[0].hsl.h, color.hsl.h) <= hueTol);
    if (family) family.push(color); else families.push([color]);
  }
  const out: Array<{ hue: number; center_hex: string; dark_pole: string; light_pole: string; pixel_share: number; buckets: number }> = [];
  for (const family of families) {
    if (family.length < 3) continue;
    const share = family.reduce((sum, c) => sum + c.pixel_share, 0);
    if (share < minShare) continue;
    const sorted = [...family].sort((a, b) => a.hsl.l - b.hsl.l);
    if (sorted[sorted.length - 1].hsl.l - sorted[0].hsl.l < minSpan) continue;
    let acc = 0;
    let center = sorted[Math.floor(sorted.length / 2)];
    for (const c of sorted) { acc += c.pixel_share; if (acc >= share / 2) { center = c; break; } }
    out.push({ hue: Math.round(family.reduce((sum, c) => sum + c.hsl.h, 0) / family.length), center_hex: center.hex, dark_pole: sorted[0].hex, light_pole: sorted[sorted.length - 1].hex, pixel_share: Number(share.toFixed(4)), buckets: family.length });
  }
  return out.sort((a, b) => b.pixel_share - a.pixel_share);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function mechanicalQa(file: string, harness: string): JsonObject {
  const metadata = fs.statSync(file);
  const checks: Record<string, JsonObject> = {
    non_empty: { pass: metadata.size > 0, bytes: metadata.size },
  };
  if (!fs.existsSync(harness)) return { status: "harness_unavailable", checks };
  for (const command of ["ship-gate", "border-dust"]) {
    const result = spawnSync(process.execPath, [harness, command, file], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    checks[command] = {
      pass: result.status === 0,
      exit_code: result.status,
      summary: sanitizeQaOutput(result.stdout || result.stderr),
    };
  }
  return { status: "complete", checks };
}

async function buildGbpEvidence(manifestPath: string, outDir: string): Promise<JsonObject> {
  const manifestFile = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as JsonObject;
  const photoValues = Array.isArray(manifest.photos) ? manifest.photos : Array.isArray(manifest.files) ? manifest.files : [];
  const photos = photoValues
    .map((value) => {
      const item = asObject(value);
      const raw = stringValue(item.local_path) ?? stringValue(item.path) ?? stringValue(item.file);
      if (!raw) return null;
      const file = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(manifestFile), raw);
      if (!fs.existsSync(file)) return null;
      return { path: file, sha256: sha256File(file), bytes: fs.statSync(file).size };
    })
    .filter((value): value is { path: string; sha256: string; bytes: number } => value != null);
  const inspected = [];
  for (const photo of photos) inspected.push({ ...photo, ...await inspectImage(photo.path) });
  inspected.sort((left, right) => Number(right.width) * Number(right.height) - Number(left.width) * Number(left.height));
  const contactSheet = inspected.length ? await renderContactSheet(inspected.map((photo) => photo.path), path.join(outDir, "gbp-contact-sheet.jpg")) : null;
  const inspectedByPath = new Map(inspected.map((photo) => [path.resolve(photo.path), photo]));
  const environmentValues = Array.isArray(manifest.brand_environment_candidates)
    ? manifest.brand_environment_candidates
    : [];
  const brandEnvironmentCandidates = environmentValues.map((value) => {
    const item = asObject(value);
    const raw = stringValue(item.local_path) ?? stringValue(item.path) ?? stringValue(item.file);
    if (!raw) throw new Error("GBP brand environment candidate is missing a local path");
    const file = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(manifestFile), raw);
    const photo = inspectedByPath.get(path.resolve(file));
    if (!photo) throw new Error(`GBP brand environment candidate is not in the exact fetched photo set: ${file}`);
    if (item.exact_location !== true) throw new Error(`GBP brand environment candidate is not marked exact_location: ${file}`);
    return {
      ...photo,
      classification: stringValue(item.classification) ?? "unclassified",
      exact_location: true,
      corroboration: stringValue(item.corroboration),
    };
  });
  return {
    status: inspected.length ? "available" : "empty",
    manifest: manifestFile,
    manifest_sha256: sha256File(manifestFile),
    key_details: pickGbpKeyDetails(manifest),
    photos: inspected,
    contact_sheet: contactSheet,
    detail_images: inspected.slice(0, 3).map((photo) => photo.path),
    brand_environment_candidates: brandEnvironmentCandidates,
  };
}

async function buildBrandEnvironmentEvidence(
  manifestPath: string,
  expectedPlaceId: string | null,
  outDir: string,
): Promise<JsonObject> {
  const manifestFile = path.resolve(manifestPath);
  if (!fs.existsSync(manifestFile)) throw new Error(`Brand environment manifest does not exist: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as JsonObject;
  if (manifest.source !== "searchapi_google_maps_photos") {
    throw new Error("Brand environment manifest must come from searchapi_google_maps_photos");
  }
  const status = stringValue(manifest.status);
  const identity = asObject(manifest.place_identity);
  if (status === "identity_conflict" || (status === "available" && identity.exact_match !== true)) {
    throw new Error("Brand environment identity conflict blocks evidence packaging");
  }
  const requestedPlaceId = stringValue(identity.requested_place_id);
  const returnedPlaceId = stringValue(identity.returned_place_id);
  const returnedConflicts = returnedPlaceId !== null && returnedPlaceId !== expectedPlaceId;
  const availableMissingReturn = status === "available" && returnedPlaceId === null;
  if (expectedPlaceId && (requestedPlaceId !== expectedPlaceId || returnedConflicts || availableMissingReturn)) {
    throw new Error("Brand environment manifest place ID does not match the resolved location");
  }
  const common = {
    status: status ?? "unavailable",
    source: manifest.source,
    manifest: manifestFile,
    manifest_sha256: sha256File(manifestFile),
    place_identity: identity,
    minimum_evidence: manifest.minimum_evidence ?? null,
    flags: Array.isArray(manifest.flags) ? manifest.flags : [],
  };
  if (status !== "available") {
    return {
      ...common,
      reason: stringValue(manifest.reason) ?? (status === "empty" ? "searchapi_environment_empty" : "searchapi_environment_unavailable"),
      selected_candidates: [],
      contact_sheet: null,
      detail_images: [],
      judgment_policy: BRAND_ENVIRONMENT_JUDGMENT_POLICY,
    };
  }

  const values = Array.isArray(manifest.selected_candidates) ? manifest.selected_candidates.slice(0, 10) : [];
  const evidenceDir = path.join(outDir, "brand-environment");
  const imagesDir = path.join(evidenceDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  const selected = [];
  for (const [index, raw] of values.entries()) {
    const candidate = asObject(raw);
    const sourcePath = stringValue(candidate.local_path);
    if (!sourcePath || !fs.existsSync(path.resolve(sourcePath))) {
      throw new Error(`Selected brand environment image is missing: ${sourcePath ?? "unknown"}`);
    }
    const source = path.resolve(sourcePath);
    const expectedSha = stringValue(candidate.sha256);
    const actualSha = sha256File(source);
    if (expectedSha && expectedSha !== actualSha) {
      throw new Error(`Selected brand environment image hash mismatch: ${source}`);
    }
    const extension = path.extname(source).toLowerCase() || ".jpg";
    const destination = path.join(imagesDir, `${String(index + 1).padStart(2, "0")}${extension}`);
    fs.copyFileSync(source, destination);
    const metadata = await inspectImage(destination);
    selected.push({
      candidate_id: candidate.candidate_id ?? `environment-${index + 1}`,
      source_type: candidate.source_type,
      category: candidate.category,
      category_id: candidate.category_id ?? null,
      source_url: candidate.source_url,
      local_path: destination,
      sha256: actualSha,
      perceptual_hash: candidate.perceptual_hash ?? null,
      duplicate_group: candidate.duplicate_group ?? null,
      exact_identity_evidence: candidate.exact_identity_evidence,
      classification: candidate.classification ?? "unclassified",
      subtype: candidate.subtype ?? "unclassified",
      classification_source: candidate.classification_source ?? null,
      usable_for_brand_environment: candidate.usable_for_brand_environment ?? null,
      rank_score: candidate.rank_score ?? null,
      ...metadata,
    });
  }
  const contactSheet = selected.length
    ? await renderContactSheet(
        selected.map((candidate) => String(candidate.local_path)),
        path.join(evidenceDir, "contact-sheet.jpg"),
        selected.map((candidate) => `${String(candidate.candidate_id)} · ${String(candidate.category)} · ${String(candidate.subtype)}`),
      )
    : null;
  return {
    ...common,
    status: selected.length ? "available" : "empty",
    reason: selected.length ? null : "searchapi_environment_selected_set_empty",
    candidate_count: manifest.candidate_count ?? null,
    selected_candidates: selected,
    contact_sheet: contactSheet,
    detail_images: selected.map((candidate) => candidate.local_path),
    judgment_policy: BRAND_ENVIRONMENT_JUDGMENT_POLICY,
    interpretation_rule: "Corroborated deliberate physical-brand usage may influence palette roles and faithful logo treatment, but never create or supersede the verified first-party logo identity.",
  };
}

function pickGbpKeyDetails(manifest: JsonObject): JsonObject {
  const source = Object.keys(asObject(manifest.location)).length ? asObject(manifest.location) : manifest;
  const fields = ["name", "title", "address", "phone", "website", "place_id", "google_place_id", "rating", "review_count", "maps_url"];
  return Object.fromEntries(fields.filter((field) => source[field] != null).map((field) => [field, source[field]]));
}

async function renderContactSheet(files: string[], out: string, labels: string[] = []): Promise<string> {
  const sharp = sharpModule();
  const tiles = [];
  const labelHeight = labels.length ? 36 : 0;
  for (const [index, file] of files.slice(0, 10).entries()) {
    const image = await sharp(file).rotate().resize(400, 300, { fit: "cover" }).jpeg({ quality: 86 }).toBuffer();
    if (!labelHeight) {
      tiles.push(image);
      continue;
    }
    const label = Buffer.from(`<svg width="400" height="${labelHeight}"><rect width="100%" height="100%" fill="#111827"/><text x="10" y="24" fill="white" font-size="14" font-family="Arial">${escapeXml(labels[index] ?? "")}</text></svg>`);
    tiles.push(await sharp({ create: { width: 400, height: 300 + labelHeight, channels: 3, background: "#ffffff" } })
      .composite([{ input: image, left: 0, top: 0 }, { input: label, left: 0, top: 300 }])
      .jpeg({ quality: 88 })
      .toBuffer());
  }
  const columns = 2;
  const rows = Math.ceil(tiles.length / columns);
  await sharp({
    create: { width: columns * 400, height: rows * (300 + labelHeight), channels: 3, background: "#ffffff" },
  }).composite(tiles.map((input: Buffer, index: number) => ({
    input,
    left: (index % columns) * 400,
    top: Math.floor(index / columns) * (300 + labelHeight),
  }))).jpeg({ quality: 88 }).toFile(out);
  return out;
}

async function buildWebsiteVisualEvidence(
  input: WebsiteVisualEvidenceInput | undefined,
  websiteUrl: string | null,
  outDir: string,
): Promise<JsonObject> {
  if (!websiteUrl) return { status: "unavailable", reason: "no_official_website" };
  if (!input) throw new Error("website_visual_evidence is required when website_url is present");
  if (input.status === "unavailable") {
    return { status: "unavailable", reason: stringValue(input.reason) };
  }

  const visualDir = path.join(outDir, "website-visual");
  fs.mkdirSync(visualDir, { recursive: true });
  const copyScreenshot = async (sourceValue: string | undefined, label: string): Promise<JsonObject> => {
    const source = path.resolve(sourceValue as string);
    if (!fs.existsSync(source)) throw new Error(`Website ${label} screenshot does not exist: ${source}`);
    const extension = path.extname(source).toLowerCase() || ".png";
    const destination = path.join(visualDir, `${label}${extension}`);
    fs.copyFileSync(source, destination);
    const metadata = await inspectImage(destination);
    return {
      path: destination,
      sha256: sha256File(destination),
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  };

  const desktop = await copyScreenshot(input.desktop_screenshot, "desktop");
  const mobile = await copyScreenshot(input.mobile_screenshot, "mobile");
  const stylesSource = path.resolve(input.computed_styles_manifest as string);
  if (!fs.existsSync(stylesSource)) throw new Error(`Computed styles manifest does not exist: ${stylesSource}`);
  const computedStyles = JSON.parse(fs.readFileSync(stylesSource, "utf8")) as JsonObject;
  const surfaces = computedStyles.surfaces;
  if (!Array.isArray(surfaces) || surfaces.length === 0 || surfaces.some((surface) => {
    const item = asObject(surface);
    return !stringValue(item.role) || !stringValue(item.selector) || !["desktop", "mobile"].includes(String(item.viewport));
  })) {
    throw new Error("Computed styles manifest requires semantic surfaces with role, selector, and desktop/mobile viewport");
  }
  if (!surfaces.some((surface) => asObject(surface).visible === true)) {
    throw new Error("Computed styles manifest requires at least one visible surface");
  }
  for (const viewport of ["desktop", "mobile"]) {
    if (!surfaces.some((surface) => asObject(surface).visible === true && asObject(surface).viewport === viewport)) {
      throw new Error(`Computed styles manifest requires at least one visible ${viewport} surface`);
    }
  }
  if (!/#[0-9a-f]{6}/i.test(JSON.stringify(surfaces))) {
    throw new Error("Computed styles manifest requires exact six-digit colors from visible surfaces");
  }
  const stylesDestination = path.join(visualDir, "computed-styles.json");
  fs.copyFileSync(stylesSource, stylesDestination);

  return {
    status: "captured",
    desktop_screenshot: desktop,
    mobile_screenshot: mobile,
    computed_styles_path: stylesDestination,
    computed_styles_sha256: sha256File(stylesDestination),
    computed_styles: computedStyles,
    interpretation_rule: "Use screenshots to identify visible semantic roles and computed styles for exact values; ignore raw CSS frequency without visible corroboration.",
  };
}

export type AuthoredColorToken = {
  hex: string;
  count: number;
  semantic_count: number;
  framework_default_count: number;
  evidence_class: "theme_authored" | "framework_default_risk" | "unclassified";
  sources: string[];
};

const COMMON_FRAMEWORK_DEFAULT_COLORS = new Set(["#1976D2", "#1565C0"]);

export function extractAuthoredColorTokens(files: string[]): AuthoredColorToken[] {
  const tokens = new Map<string, {
    count: number;
    semanticCount: number;
    frameworkDefaultCount: number;
    sources: Set<string>;
  }>();
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new Error(`Website HTML/CSS file does not exist: ${resolved}`);
    const content = fs.readFileSync(resolved, "utf8");
    for (const match of content.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
      const hex = match[0].toUpperCase();
      const index = match.index ?? 0;
      const prefix = content.slice(Math.max(0, index - 180), index);
      const context = content.slice(Math.max(0, index - 180), Math.min(content.length, index + 180));
      const semanticSignal = /(?:backgroundColor|fontColor\d*|buttonColor|buttonTextColor|primaryColor|secondaryColor|accentColor|footerStyles|headerStyles|brand(?:ing)?|theme|--[\w-]*(?:brand|primary|secondary|accent|theme|color)[\w-]*)[^#]{0,80}$/i.test(prefix);
      const frameworkDefaultSignal = COMMON_FRAMEWORK_DEFAULT_COLORS.has(hex) && /(?:\bmui-|\bMui[A-Z]|material-ui)/.test(context);
      const value = tokens.get(hex) ?? {
        count: 0,
        semanticCount: 0,
        frameworkDefaultCount: 0,
        sources: new Set<string>(),
      };
      value.count += 1;
      if (semanticSignal) value.semanticCount += 1;
      if (frameworkDefaultSignal) value.frameworkDefaultCount += 1;
      value.sources.add(resolved);
      tokens.set(hex, value);
    }
  }
  return [...tokens.entries()]
    .map(([hex, value]): AuthoredColorToken => {
      const frameworkOnly = value.frameworkDefaultCount > 0 && value.semanticCount === 0;
      return {
        hex,
        count: value.count,
        semantic_count: value.semanticCount,
        framework_default_count: value.frameworkDefaultCount,
        evidence_class: value.semanticCount > 0
          ? "theme_authored"
          : frameworkOnly
            ? "framework_default_risk"
            : "unclassified",
        sources: [...value.sources].sort(),
      };
    })
    .sort((left, right) => {
      const rank = { theme_authored: 2, unclassified: 1, framework_default_risk: 0 };
      return rank[right.evidence_class] - rank[left.evidence_class]
        || right.semantic_count - left.semantic_count
        || right.count - left.count
        || left.hex.localeCompare(right.hex);
    });
}

// sharp comes from the skill harness (boostly-brand-design/harness) first; the Codex runtime copy is the fallback.
const harnessRequire = createRequire(new URL("../harness/package.json", import.meta.url));
function sharpModule(): any {
  try { return harnessRequire("sharp"); } catch { return require("/Users/travisse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp"); }
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function sanitizeQaOutput(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character] as string));
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    out[token.slice(2)] = value;
    index += 1;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.run ? path.resolve(args.run) : null;
  if (!args.input || (!args["out-dir"] && !runDir)) {
    throw new Error("Usage: --input <branding-evidence-input.json> --out-dir <dir> | --run <run_dir> --input <json> [--out-dir <dir>] [--force <reason>]");
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8")) as BrandingEvidenceInput;
  const outDir = path.resolve(args["out-dir"] ?? path.join(runDir as string, "evidence"));
  const packet = await buildBrandingEvidencePacket(input, outDir, {
    harness: args.harness ? path.resolve(args.harness) : undefined,
  });
  if (runDir) {
    // The evidence block is a summary of the packet (fingerprint, candidates, measured colors); the
    // packet file stays the full record and is referenced by path.
    const { evidenceBlockFromPacket, setBlock } = await import("../../boostly-box-fulfillment/scripts/run-file.ts");
    setBlock(runDir, "evidence", evidenceBlockFromPacket(packet.packet_path), {
      by: "build-branding-evidence",
      force: typeof args.force === "string",
      reason: args.force,
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, packet_path: packet.packet_path, evidence_fingerprint: packet.evidence_fingerprint, reuse: packet.reuse, run: runDir })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
