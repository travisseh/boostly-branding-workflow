#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type Classification = "brand_environment" | "food" | "people" | "mixed" | "noise" | "unclassified";
type Subtype = "storefront" | "exterior_signage" | "interior_fixture" | "vibe" | "menu_signage" | "branded_collateral" | "other_environment" | "unclassified";

export type EnvironmentCandidate = {
  candidate_id: string;
  source_type: "searchapi_google_maps_photos";
  category: string;
  category_id: string | null;
  source_url: string;
  local_path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  perceptual_hash: string;
  duplicate_group: string;
  exact_identity_evidence: string;
  author_attribution: unknown;
  classification: Classification;
  subtype: Subtype;
  classification_source: string | null;
  usable_for_brand_environment: boolean | null;
  preliminary_eligible: boolean;
  rank_score: number;
};

type IdentityExpectation = {
  placeId: string;
  locationName: string;
  address: string;
  officialDomain?: string;
};

type SearchApiRequest = {
  label: string;
  category: string;
  categoryId: string | null;
  body: JsonObject;
};

const SEARCHAPI_ENDPOINT = "https://www.searchapi.io/api/v1/search";
const DEFAULT_ENV_FILES = [
  `${process.env.HOME}/.config/boostly-branding/.env`,
  `${process.env.HOME}/.config/searchapi.env`,
];
const FIXED_CATEGORIES = {
  vibe: { title: "Vibe", id: "CgIYIg" },
  by_owner: { title: "By owner", id: "CgIgARICEAE" },
  street_view: { title: "Street View & 360", id: "CgIgARICCAI" },
};
const SOURCE_SCORE: Record<string, number> = {
  Vibe: 90,
  "By owner": 75,
  All: 60,
  "All page 2": 55,
};
const CONTENT_SCORE: Record<Subtype, number> = {
  storefront: 25,
  exterior_signage: 25,
  interior_fixture: 20,
  vibe: 20,
  menu_signage: 15,
  branded_collateral: 10,
  other_environment: 5,
  unclassified: 0,
};
const require = createRequire(import.meta.url);

export function evaluateIdentity(expected: IdentityExpectation, returned: JsonObject): JsonObject {
  const returnedPlaceId = stringValue(returned.place_id);
  const returnedTitle = stringValue(returned.title) ?? stringValue(returned.name);
  const returnedAddress = stringValue(returned.address) ?? stringValue(returned.formatted_address);
  const returnedWebsite = stringValue(returned.website);
  const checks: JsonObject = {
    exact_place_id: returnedPlaceId === expected.placeId,
    name_consistent: textOverlap(expected.locationName, returnedTitle ?? "") >= 0.6,
    street_number_consistent: sameStreetNumber(expected.address, returnedAddress ?? ""),
    city_consistent: cityToken(expected.address) ? normalize(returnedAddress ?? "").includes(cityToken(expected.address)) : true,
  };
  if (expected.officialDomain && returnedWebsite) {
    checks.official_domain_consistent = hostMatches(returnedWebsite, expected.officialDomain);
  }
  return {
    requested_place_id: expected.placeId,
    returned_place_id: returnedPlaceId,
    title: returnedTitle,
    address: returnedAddress,
    website: returnedWebsite,
    data_id: returned.data_id ?? null,
    checks,
    exact_match: Object.values(checks).every((value) => value === true),
  };
}

export function rankCandidate(candidate: Pick<EnvironmentCandidate, "category" | "width" | "height" | "classification" | "subtype" | "preliminary_eligible">): number {
  let score = SOURCE_SCORE[candidate.category] ?? 40;
  score += Math.min(10, Math.floor(Math.sqrt(candidate.width * candidate.height) / 300));
  score += CONTENT_SCORE[candidate.subtype];
  if (!candidate.preliminary_eligible) score -= 100;
  if (candidate.classification === "food" || candidate.classification === "noise") score -= 100;
  if (candidate.classification === "people") score -= 60;
  return score;
}

export function shouldIncludePage2(
  mode: "auto" | "always" | "never",
  hasNextPage: boolean,
  uniqueUrlCount: number,
  hasClassificationReceipt: boolean,
): boolean {
  if (!hasNextPage || mode === "never") return false;
  if (mode === "always") return true;
  return uniqueUrlCount < 10 || !hasClassificationReceipt;
}

export function assignDuplicateGroups<T extends Pick<EnvironmentCandidate, "sha256" | "perceptual_hash" | "width" | "height">>(candidates: T[]): string[] {
  const parents = candidates.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const exact = candidates[left].sha256 === candidates[right].sha256;
      const aspectDelta = Math.abs(candidates[left].width / candidates[left].height - candidates[right].width / candidates[right].height);
      const near = aspectDelta <= 0.12 && hammingDistance(candidates[left].perceptual_hash, candidates[right].perceptual_hash) <= 6;
      if (exact || near) unite(left, right);
    }
  }
  const roots = new Map<number, string>();
  return candidates.map((_, index) => {
    const root = find(index);
    if (!roots.has(root)) roots.set(root, `duplicate-${String(roots.size + 1).padStart(3, "0")}`);
    return roots.get(root) as string;
  });
}

export async function collectSearchApiBrandEnvironment(options: {
  placeId: string;
  locationName: string;
  address: string;
  officialDomain?: string;
  outDir: string;
  apiKey: string;
  classifications?: string;
  includePage2?: "auto" | "always" | "never";
  minLongestSide?: number;
  fetchImpl?: typeof fetch;
}): Promise<JsonObject> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "brand-environment.json");
  const flags: string[] = [];
  let identityBody: JsonObject;
  try {
    identityBody = await searchApiJson({ engine: "google_maps_place", place_id: options.placeId }, options.apiKey, fetchImpl);
  } catch (error) {
    const manifest = unavailableManifest(options.placeId, "searchapi_identity_request_failed", error);
    writeJson(manifestPath, manifest);
    return { ...manifest, manifest_path: manifestPath };
  }

  const identity = evaluateIdentity({
    placeId: options.placeId,
    locationName: options.locationName,
    address: options.address,
    officialDomain: options.officialDomain,
  }, asObject(identityBody.place_result));
  writeJson(path.join(outDir, "exact-place-identity.json"), identity);
  if (identity.exact_match !== true) {
    const manifest: JsonObject = {
      schema_version: 1,
      source: "searchapi_google_maps_photos",
      status: "identity_conflict",
      place_identity: identity,
      flags: ["brand_environment_identity_conflict"],
      candidates: [],
      selected_candidates: [],
      contact_sheet: null,
      detail_images: [],
    };
    writeJson(manifestPath, manifest);
    return { ...manifest, manifest_path: manifestPath };
  }

  const receiptsDir = path.join(outDir, "searchapi-receipts");
  fs.mkdirSync(receiptsDir, { recursive: true });
  const requests: SearchApiRequest[] = [];
  const all = await requestOrFlag(
    { engine: "google_maps_photos", place_id: options.placeId },
    "all-page-1",
    "All",
    null,
    options.apiKey,
    fetchImpl,
    flags,
  );
  if (all) requests.push(all);
  const categories = resolveCategories(all?.body);
  if (!Array.isArray(all?.body.categories)) flags.push("searchapi_dynamic_categories_missing");
  for (const category of [categories.vibe, categories.by_owner]) {
    const result = await requestOrFlag(
      { engine: "google_maps_photos", place_id: options.placeId, category_id: category.id },
      safeSegment(category.title),
      category.title,
      category.id,
      options.apiKey,
      fetchImpl,
      flags,
    );
    if (result) requests.push(result);
  }

  const uniqueUrls = new Set(requests.flatMap((request) => photoItems(request.body).map((photo) => stringValue(photo.image))).filter(Boolean));
  const includePage2 = options.includePage2 ?? "auto";
  const nextPageToken = stringValue(asObject(all?.body.pagination).next_page_token);
  if (nextPageToken && shouldIncludePage2(includePage2, true, uniqueUrls.size, Boolean(options.classifications))) {
    const result = await requestOrFlag(
      { engine: "google_maps_photos", place_id: options.placeId, next_page_token: nextPageToken },
      "all-page-2",
      "All page 2",
      null,
      options.apiKey,
      fetchImpl,
      flags,
    );
    if (result) requests.push(result);
  }
  const streetView = await requestOrFlag(
    { engine: "google_maps_photos", place_id: options.placeId, category_id: categories.street_view.id },
    "street-view-360",
    categories.street_view.title,
    categories.street_view.id,
    options.apiKey,
    fetchImpl,
    flags,
  );
  if (streetView) flags.push("street_view_identity_only_not_fable_evidence");

  for (const request of [...requests, ...(streetView ? [streetView] : [])]) {
    writeJson(path.join(receiptsDir, `${request.label}.json`), safeJson(request.body, [options.apiKey]));
  }

  const imageDir = path.join(outDir, "images");
  fs.mkdirSync(imageDir, { recursive: true });
  const seenUrls = new Set<string>();
  const candidates: EnvironmentCandidate[] = [];
  for (const request of requests.sort((left, right) => (SOURCE_SCORE[right.category] ?? 0) - (SOURCE_SCORE[left.category] ?? 0))) {
    for (const photo of photoItems(request.body)) {
      const sourceUrl = stringValue(photo.image);
      if (!sourceUrl || seenUrls.has(sourceUrl)) continue;
      seenUrls.add(sourceUrl);
      const candidateId = `searchapi-${String(candidates.length + 1).padStart(3, "0")}`;
      const downloaded = await downloadImage(sourceUrl, path.join(imageDir, candidateId), fetchImpl);
      if (!downloaded) {
        flags.push("searchapi_photo_download_failed");
        continue;
      }
      const longestSide = Math.max(downloaded.width, downloaded.height);
      candidates.push({
        candidate_id: candidateId,
        source_type: "searchapi_google_maps_photos",
        category: request.category,
        category_id: request.categoryId,
        source_url: sourceUrl,
        local_path: downloaded.file,
        width: downloaded.width,
        height: downloaded.height,
        bytes: downloaded.bytes,
        sha256: downloaded.sha256,
        perceptual_hash: downloaded.perceptualHash,
        duplicate_group: "",
        exact_identity_evidence: `Exact SearchAPI place_id ${options.placeId}; ${stringValue(identity.title)}, ${stringValue(identity.address)}`,
        author_attribution: photo.user ?? photo.author ?? null,
        classification: "unclassified",
        subtype: request.category === "Vibe" ? "vibe" : "unclassified",
        classification_source: null,
        usable_for_brand_environment: null,
        preliminary_eligible: longestSide >= (options.minLongestSide ?? 480),
        rank_score: 0,
      });
    }
  }

  const groups = assignDuplicateGroups(candidates);
  candidates.forEach((candidate, index) => { candidate.duplicate_group = groups[index]; });
  const classificationReceipt = options.classifications ? loadClassifications(options.classifications) : null;
  applyClassifications(candidates, classificationReceipt);
  for (const candidate of candidates) candidate.rank_score = rankCandidate(candidate);
  candidates.sort((left, right) => right.rank_score - left.rank_score || left.sha256.localeCompare(right.sha256));
  const selected = selectCandidates(candidates, Boolean(classificationReceipt));
  const minimumEvidence = assessMinimumEvidence(candidates, Boolean(classificationReceipt));
  if (!classificationReceipt) flags.push("brand_environment_classification_unavailable");
  if (minimumEvidence.status === "insufficient") flags.push("brand_environment_evidence_insufficient");
  if (!candidates.length) flags.push("searchapi_environment_empty");
  const contactSheet = selected.length
    ? await renderContactSheet(selected, path.join(outDir, "brand-environment-contact-sheet.jpg"))
    : null;
  const manifest: JsonObject = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: "searchapi_google_maps_photos",
    status: candidates.length ? "available" : "empty",
    place_identity: identity,
    retrieval: {
      documented_categories_present: Array.isArray(all?.body.categories),
      fixed_category_fallbacks: FIXED_CATEGORIES,
      requests: [...requests, ...(streetView ? [streetView] : [])].map((request) => ({
        label: request.label,
        category: request.category,
        category_id: request.categoryId,
        returned_count: photoItems(request.body).length,
        next_page_available: Boolean(stringValue(asObject(request.body.pagination).next_page_token)),
      })),
    },
    classification_receipt: classificationReceipt ? path.resolve(options.classifications as string) : null,
    minimum_evidence: minimumEvidence,
    flags: [...new Set(flags)].sort(),
    candidate_count: candidates.length,
    candidates,
    selected_candidates: selected,
    contact_sheet: contactSheet,
    detail_images: selected.map((candidate) => candidate.local_path),
  };
  writeJson(manifestPath, manifest);
  return { ...manifest, manifest_path: manifestPath };
}

function unavailableManifest(placeId: string, flag: string, error: unknown): JsonObject {
  return {
    schema_version: 1,
    source: "searchapi_google_maps_photos",
    status: "unavailable",
    place_identity: { requested_place_id: placeId, exact_match: false },
    flags: [flag],
    reason: sanitizeError(error),
    candidates: [],
    selected_candidates: [],
    contact_sheet: null,
    detail_images: [],
  };
}

async function requestOrFlag(
  params: Record<string, string>,
  label: string,
  category: string,
  categoryId: string | null,
  apiKey: string,
  fetchImpl: typeof fetch,
  flags: string[],
): Promise<SearchApiRequest | null> {
  try {
    return { label, category, categoryId, body: await searchApiJson(params, apiKey, fetchImpl) };
  } catch {
    flags.push(`searchapi_${label.replace(/-/g, "_")}_unavailable`);
    return null;
  }
}

async function searchApiJson(params: Record<string, string>, apiKey: string, fetchImpl: typeof fetch): Promise<JsonObject> {
  const url = new URL(SEARCHAPI_ENDPOINT);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await response.json() as JsonObject;
  if (!response.ok || stringValue(asObject(body.search_metadata).status)?.toLowerCase() === "error") {
    throw new Error(`SearchAPI ${params.engine} request failed with HTTP ${response.status}`);
  }
  return body;
}

export function resolveCategories(allBody: JsonObject | undefined): typeof FIXED_CATEGORIES {
  const categories = Array.isArray(allBody?.categories) ? allBody.categories.map(asObject) : [];
  const find = (pattern: RegExp, fallback: { title: string; id: string }): { title: string; id: string } => {
    const match = categories.find((category) => pattern.test(stringValue(category.title) ?? ""));
    const id = match ? stringValue(match.id) ?? stringValue(match.category_id) : null;
    return match && id
      ? { title: fallback.title, id }
      : fallback;
  };
  return {
    vibe: find(/vibe|atmosphere|interior/i, FIXED_CATEGORIES.vibe),
    by_owner: find(/by owner/i, FIXED_CATEGORIES.by_owner),
    street_view: find(/street view|360/i, FIXED_CATEGORIES.street_view),
  };
}

function photoItems(body: JsonObject): JsonObject[] {
  return Array.isArray(body.photos) ? body.photos.map(asObject) : [];
}

async function downloadImage(url: string, basePath: string, fetchImpl: typeof fetch): Promise<{
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  perceptualHash: string;
} | null> {
  try {
    const response = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "BoostlyBrandEnvironment/1.0" } });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) return null;
    const sharp = sharpModule();
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) return null;
    const extension = extensionFor(contentType);
    const file = `${basePath}${extension}`;
    fs.writeFileSync(file, bytes);
    return {
      file,
      width: metadata.width,
      height: metadata.height,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      perceptualHash: await differenceHash(bytes),
    };
  } catch {
    return null;
  }
}

async function differenceHash(bytes: Buffer): Promise<string> {
  const raw = await sharpModule()(bytes).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  let bit = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (raw[row * 9 + column] > raw[row * 9 + column + 1]) bits |= 1n << bit;
      bit += 1n;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function loadClassifications(file: string): Map<string, JsonObject> {
  const resolved = path.resolve(file);
  const value = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  const rows = Array.isArray(value) ? value : Array.isArray(asObject(value).classifications) ? asObject(value).classifications as unknown[] : [];
  if (!rows.length) throw new Error("Classification receipt requires a non-empty classifications array");
  const map = new Map<string, JsonObject>();
  for (const raw of rows) {
    const row = asObject(raw);
    const key = stringValue(row.sha256) ?? stringValue(row.candidate_id);
    const classification = stringValue(row.classification);
    if (!key || !["brand_environment", "food", "people", "mixed", "noise"].includes(classification ?? "")) {
      throw new Error("Classification rows require sha256/candidate_id and a recognized fixed label");
    }
    const subtype = stringValue(row.subtype);
    if (["brand_environment", "mixed"].includes(classification as string)
      && (!subtype || subtype === "unclassified" || !Object.keys(CONTENT_SCORE).includes(subtype))) {
      throw new Error("Eligible environment classifications require a recognized physical subtype");
    }
    map.set(key, row);
  }
  return map;
}

function applyClassifications(candidates: EnvironmentCandidate[], receipt: Map<string, JsonObject> | null): void {
  if (!receipt) return;
  for (const candidate of candidates) {
    const row = receipt.get(candidate.sha256) ?? receipt.get(candidate.candidate_id);
    if (!row) continue;
    candidate.classification = stringValue(row.classification) as Classification;
    const subtype = stringValue(row.subtype) ?? "unclassified";
    if (!Object.keys(CONTENT_SCORE).includes(subtype)) throw new Error(`Unknown environment subtype: ${subtype}`);
    candidate.subtype = subtype as Subtype;
    candidate.classification_source = stringValue(row.classification_source) ?? "fixed_label_receipt";
    candidate.usable_for_brand_environment = candidate.preliminary_eligible
      && ["brand_environment", "mixed"].includes(candidate.classification)
      && candidate.subtype !== "unclassified";
  }
}

export function selectCandidates(candidates: EnvironmentCandidate[], classified: boolean): EnvironmentCandidate[] {
  const selected: EnvironmentCandidate[] = [];
  const groups = new Set<string>();
  const subtypeCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!classified && candidate.category !== "Vibe") continue;
    const eligible = classified ? candidate.usable_for_brand_environment === true : candidate.preliminary_eligible;
    if (!eligible || groups.has(candidate.duplicate_group)) continue;
    const count = subtypeCounts.get(candidate.subtype) ?? 0;
    if (classified && candidate.subtype !== "unclassified" && count >= 3) continue;
    selected.push(candidate);
    groups.add(candidate.duplicate_group);
    subtypeCounts.set(candidate.subtype, count + 1);
    if (selected.length === 10) break;
  }
  return selected;
}

function assessMinimumEvidence(candidates: EnvironmentCandidate[], classified: boolean): JsonObject {
  if (!classified) return { status: "unassessed", reason: "fixed_label_classification_receipt_missing" };
  const unique = new Map<string, EnvironmentCandidate>();
  for (const candidate of candidates) {
    if (candidate.usable_for_brand_environment === true && !unique.has(candidate.duplicate_group)) unique.set(candidate.duplicate_group, candidate);
  }
  const values = [...unique.values()];
  const exterior = values.filter((candidate) => ["storefront", "exterior_signage"].includes(candidate.subtype)).length;
  const interior = values.filter((candidate) => ["interior_fixture", "vibe"].includes(candidate.subtype)).length;
  const additional = values.filter((candidate) => ["menu_signage", "branded_collateral", "other_environment"].includes(candidate.subtype)).length;
  const subtypes = new Set(values.map((candidate) => candidate.subtype));
  const satisfied = values.length >= 4 && exterior >= 1 && interior >= 2 && additional >= 1 && subtypes.size >= 2;
  return {
    status: satisfied ? "satisfied" : "insufficient",
    perceptually_unique_images: values.length,
    storefront_exterior_or_signage: exterior,
    interior_fixture_or_vibe: interior,
    menu_signage_or_additional_environment: additional,
    distinct_subtypes: subtypes.size,
    requirements: { unique_images: 4, exterior: 1, interior: 2, additional: 1, distinct_subtypes: 2 },
  };
}

async function renderContactSheet(candidates: EnvironmentCandidate[], output: string): Promise<string> {
  const sharp = sharpModule();
  const width = 420;
  const imageHeight = 290;
  const labelHeight = 40;
  const columns = 2;
  const tiles: Buffer[] = [];
  for (const candidate of candidates) {
    const image = await sharp(candidate.local_path).rotate().resize(width, imageHeight, { fit: "cover" }).jpeg({ quality: 86 }).toBuffer();
    const label = Buffer.from(`<svg width="${width}" height="${labelHeight}"><rect width="100%" height="100%" fill="#111827"/><text x="12" y="26" fill="white" font-size="16" font-family="Arial">${escapeXml(`${candidate.candidate_id} · ${candidate.category} · ${candidate.subtype}`)}</text></svg>`);
    tiles.push(await sharp({ create: { width, height: imageHeight + labelHeight, channels: 3, background: "#ffffff" } })
      .composite([{ input: image, left: 0, top: 0 }, { input: label, left: 0, top: imageHeight }]).jpeg({ quality: 88 }).toBuffer());
  }
  const rows = Math.ceil(tiles.length / columns);
  await sharp({ create: { width: columns * width, height: rows * (imageHeight + labelHeight), channels: 3, background: "#ffffff" } })
    .composite(tiles.map((input, index) => ({ input, left: index % columns * width, top: Math.floor(index / columns) * (imageHeight + labelHeight) })))
    .jpeg({ quality: 88 }).toFile(output);
  return output;
}

function parseArgs(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function loadApiKey(envFile?: string): Promise<string> {
  if (process.env.SEARCHAPI_API_KEY) return process.env.SEARCHAPI_API_KEY;
  for (const file of [envFile, ...DEFAULT_ENV_FILES].filter(Boolean) as string[]) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").split(/\r?\n/).find((line) => /^\s*SEARCHAPI_API_KEY=/.test(line));
    if (match) return match.slice(match.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function textOverlap(expected: string, returned: string): number {
  const expectedTokens = new Set(normalize(expected).split(" ").filter((token) => token.length > 1));
  const returnedTokens = new Set(normalize(returned).split(" ").filter((token) => token.length > 1));
  if (!expectedTokens.size || !returnedTokens.size) return 0;
  const shared = [...expectedTokens].filter((token) => returnedTokens.has(token)).length;
  return shared / expectedTokens.size;
}

function sameStreetNumber(expected: string, returned: string): boolean {
  const expectedNumber = normalize(expected).match(/^\d+/)?.[0];
  return expectedNumber ? normalize(returned).split(" ").includes(expectedNumber) : true;
}

function cityToken(address: string): string {
  return normalize(address.split(",")[1] ?? "");
}

function hostMatches(url: string, expectedDomain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const expected = expectedDomain.toLowerCase().replace(/^www\./, "");
    return host === expected || host.endsWith(`.${expected}`);
  } catch {
    return false;
  }
}

function hammingDistance(left: string, right: string): number {
  let bits = BigInt(`0x${left || "0"}`) ^ BigInt(`0x${right || "0"}`);
  let count = 0;
  while (bits) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
}

function extensionFor(contentType: string): string {
  if (/png/i.test(contentType)) return ".png";
  if (/webp/i.test(contentType)) return ".webp";
  if (/gif/i.test(contentType)) return ".gif";
  return ".jpg";
}

// sharp comes from the skill harness (boostly-brand-design/harness) first; the Codex runtime copy is the fallback.
const harnessRequire = createRequire(new URL("../harness/package.json", import.meta.url));
function sharpModule(): any {
  try { return harnessRequire("sharp"); } catch { return require("/Users/travisse/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp"); }
}

function safeJson(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => safeJson(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .filter(([key]) => !/api[_-]?key|authorization|password/i.test(key))
      .map(([key, item]) => [key, safeJson(item, secrets)]));
  }
  if (typeof value === "string") return secrets.reduce((result, secret) => secret ? result.split(secret).join("[redacted]") : result, value);
  return value;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/(?:api[_-]?key|authorization|bearer)\s*[=:]?\s*\S+/gi, "[credential redacted]").slice(0, 300);
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "category";
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character] as string));
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args["place-id"] || !args["location-name"] || !args.address || !args["out-dir"]) {
    throw new Error("Usage: --place-id <id> --location-name <name> --address <full-address> --out-dir <dir> [--official-domain <domain>] [--env-file <file>] [--classifications <json>] [--include-page-2 auto|always|never]");
  }
  const includePage2 = (args["include-page-2"] ?? "auto") as "auto" | "always" | "never";
  if (!["auto", "always", "never"].includes(includePage2)) throw new Error("--include-page-2 must be auto, always, or never");
  const apiKey = await loadApiKey(args["env-file"]);
  if (!apiKey) throw new Error("Missing SEARCHAPI_API_KEY; set it in the environment or pass --env-file");
  const manifest = await collectSearchApiBrandEnvironment({
    placeId: args["place-id"],
    locationName: args["location-name"],
    address: args.address,
    officialDomain: args["official-domain"],
    outDir: args["out-dir"],
    apiKey,
    classifications: args.classifications,
    includePage2,
  });
  process.stdout.write(`${JSON.stringify({ ok: manifest.status !== "identity_conflict", status: manifest.status, manifest: manifest.manifest_path, selected_count: Array.isArray(manifest.selected_candidates) ? manifest.selected_candidates.length : 0, flags: manifest.flags })}\n`);
  if (manifest.status === "identity_conflict") process.exitCode = 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}
