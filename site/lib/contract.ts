// The data contract between the skill (publish side) and this site (render side).
// Documented in README.md "Data contract". The skill writes; the site only reads and validates.

export const BUNDLE_SCHEMA_VERSIONS = [1] as const;
export const SITE_DATA_SCHEMA_VERSIONS = [1] as const;
export const INDEX_SCHEMA_VERSIONS = [1] as const;

export type Progress = {
  stage?: string | null;
  last_step?: string | null;
  next_step?: string | null;
  blocked_on?: string | null;
  by?: string | null;
  host?: string | null;
  updated_at?: string | null;
  editing?: Editing | null;
};
export type Editing = { since?: string | null; by?: string | null; host?: string | null } | null;
export type ReviewStatus = { status?: string | null; waiting_on?: string | null; ease?: number | string | null; updated_at?: string | null } | null;

/** One row of site/index.json (also site/entries/<slug>.json and site-data.json `entry`). */
export type IndexEntry = {
  slug: string;
  name: string;
  account?: string | null;
  city?: string | null;
  state?: string | null;
  requested_at?: string | null;
  updated_at?: string | null;
  cursor?: string | null;
  status: string;
  status_label?: string | null;
  recommended_letter?: string | null;
  picked_letter?: string | null;
  figma_url?: string | null;
  signage_direct?: string | null;
  print_url?: string | null;
  boostly_status?: string | null;
  steps?: [string, boolean][] | null;
  needs_you?: string[] | null;
  gaps?: string[] | null;
  hold?: string | null;
  done?: boolean | null;
  note?: string | null;
  progress?: Progress | null;
  editing?: Editing;
  review_status?: ReviewStatus;
  has_canvas?: boolean;
  has_site_data?: boolean;
  old_url?: string | null;
  published_at?: string | null;
  site_data_url?: string | null;
  backfilled_from?: string | null;
};

export type IndexDoc = { schema_version: number; generated_at: string | null; count?: number; entries: Record<string, IndexEntry> };

export type BundleManifest = {
  schema_version: number;
  slug: string;
  pushed_at: string;
  by?: string;
  bytes?: number;
  refs?: number;
  files: Record<string, { sha256?: string; bytes?: number; url?: string | null; blob_url?: string | null }>;
};

/** status/<slug>.json, written by run-progress.mjs. */
export type SlugStatus = {
  slug?: string;
  generated_at?: string;
  progress?: Progress | null;
  review_status?: ReviewStatus;
  editing?: Editing;
  hold?: string | null;
  picked_letter?: string | null;
};

/** status/checklist.json item, written by review-checklist.py --publish-status every 5 minutes. */
export type ChecklistItem = {
  request_id?: string;
  created?: string | null;
  name?: string;
  status?: string;
  run_dir?: string;
  steps?: [string, boolean][] | null;
  needs_you?: string[] | null;
  gaps?: string[] | null;
  hold?: string | null;
  done?: boolean | null;
  figma_url?: string | null;
  print_url?: string | null;
  note?: string | null;
  review_status?: ReviewStatus;
  progress?: Progress | null;
  updated_at?: string | null;
};
export type Checklist = { generated_at?: string; stale?: boolean; items: ChecklistItem[] };

export type Asset = { url: string | null; bytes: number; width: number | null; height: number | null };
export type LinkEv = {
  final_url?: string | null;
  input_url?: string | null;
  page_evidence?: { title?: string | null; h1?: string[] | null } | null;
  location_match_evidence?: string[];
  validity_evidence?: string[];
  source_evidence?: string[];
  liveness?: string | null;
  rejection_reason?: string | null;
};
export type CategoryResult = { category: string; category_status?: string | null; proposed_action?: string | null; selected_link?: LinkEv | null; existing_link?: LinkEv | null };
export type SheetCellMeta = { status: string | null; primary: string | null; secondary: string | null; text: string | null; row_label: string | null; band_words: string | null };

/** bundles/<slug>/review/site-data.json, written by site-data.mjs build. */
export type SiteData = {
  schema_version: number;
  kind: "boostly-review-site-data";
  slug: string;
  generated_at: string;
  entry: IndexEntry;
  location: {
    name: string;
    location_name: string | null;
    account_name: string | null;
    city: string | null;
    state: string | null;
    request_id: string | null;
    order_type: string | null;
    website: string | null;
    website_swap: { url: string; stored: string | null; note: string } | null;
    website_discovered?: { url: string; source: string } | null;
    place_id: string | null;
    slack_url: string | null;
    figma_url: string | null;
    print_folder: { url: string | null } | null;
  };
  canvas_usage: Record<string, any> | null;
  branding?: {
    existing_kept: boolean;
    inherited: boolean;
    written_this_run: boolean;
    scope: string | null;
    source_slug: string | null;
    source_name: string | null;
    colors: { primary: string | null; secondary: string | null; text: string | null; print_text_secondary: string | null };
  };
  website: { file: string | null; unavailable: string | null };
  gbp: {
    photos: { index: number; file: string; author: string; width: number | null; height: number | null; tag: { subtype: string | null; classification: string | null; category: string | null } | null }[];
    cite_texts: string[];
    vibe: { from: "selected" | "manifest" | null; items: { file: string; category: string | null; subtype: string | null; classification: string | null; width: number | null; height: number | null }[]; source: string | null; reason: string | null };
    maps: { file: string | null };
  };
  logo_search:
    | { query: string; mode: null }
    | { query: string; mode: "thumbs" | "links"; source: string; fetched_at: string | null; results: { file: string | null; alt: string; w: number | null; h: number | null; page: string | null }[] }
    | { query: string; mode: "shot"; source: string | null; captured_at: string | null; file: string };
  candidates: {
    items: { file: string; basename: string; width: number | null; height: number | null; source: string | null; provenance: string | null; source_url: string | null; url: string | null; page_url: string | null; origin_url: string | null; chosen: boolean }[];
    raw: { basename: string; file: string | null }[];
  };
  sheet: {
    json_rel: string;
    revision: number | null;
    default_letter: string | null;
    applied_letter: string | null;
    marks: { letter: string; status: string }[];
    cells: Record<string, SheetCellMeta>;
    view: any;
  } | null;
  links: {
    block: Record<string, any>;
    report: { file: string; checked_at: string | null; summary: Record<string, number | null> | null; category_results: CategoryResult[] } | null;
    pending_urls: string[];
    manifest: string | null;
    validation: { file: string; valid: boolean | null; errors: string[] } | null;
  };
  previews: {
    prompts: boolean;
    verdicts: Record<string, { verdict: string; placeholder?: boolean }>;
    letters: Record<string, { signage_spec: Record<string, any> | null; signage_png: string | null; mockups: { file: string; scene: string; suffix: string | null; name: string; basename: string }[] }>;
  };
  assets: Record<string, Asset>;
  notes: string[];
  /** set by a one-time backfill: "bundle <pushed_at>" (a pulled copy) or "local run <host>" */
  backfilled_from?: string | null;
  /** review/logo-3x.png (the 3x crop of the final logo) and the canvas's edge-quality line; absent on older data */
  logo_3x?: { file: string | null; logo: string | null; line: string | null; edge_quality: Record<string, any> | null } | null;
  /** a backfill that reused the old static site's Blob uploads for files missing from a pulled bundle */
  old_site_assets?: { source: string; filled: string[] } | null;
};

/** One place a location's site data can come from, after validation. */
export type SiteDataCandidate = { from: "bundle" | "site-data"; data?: SiteData; missing?: string; errors?: string[] };

/**
 * The bundle copy and the site/data copy of a location's site data: the valid one with the newer
 * generated_at wins (a machine on an older skill updates only the bundle; a backfill only site/data).
 * With no valid copy: invalid (with every reason) when either copy exists but fails the contract,
 * else missing.
 */
export function newestSiteData(cands: SiteDataCandidate[]):
  | { kind: "ok"; data: SiteData; from: "bundle" | "site-data" }
  | { kind: "missing"; reason: string }
  | { kind: "invalid"; errors: string[] } {
  const ok = cands.filter((c): c is SiteDataCandidate & { data: SiteData } => !!c.data);
  if (ok.length) {
    const best = ok.reduce((a, b) => (String(b.data.generated_at ?? "") > String(a.data.generated_at ?? "") ? b : a));
    return { kind: "ok", data: best.data, from: best.from };
  }
  const errors = cands.flatMap((c) => (c.errors ?? []).map((e) => `${c.from === "bundle" ? "bundle" : "site/data"}: ${e}`));
  if (errors.length) return { kind: "invalid", errors };
  return { kind: "missing", reason: cands.map((c) => c.missing).filter(Boolean).join("; ") || "no site data" };
}

export type Validation = { ok: boolean; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validateManifest(m: unknown): Validation {
  const errors: string[] = [];
  if (!isObj(m)) return { ok: false, errors: ["manifest is not an object"] };
  if (typeof m.schema_version !== "number") errors.push("manifest has no schema_version (published before the site contract; republish with the current run-progress.mjs)");
  else if (!(BUNDLE_SCHEMA_VERSIONS as readonly number[]).includes(m.schema_version)) errors.push(`manifest schema_version ${m.schema_version} is not one this site reads (${BUNDLE_SCHEMA_VERSIONS.join(", ")})`);
  if (typeof m.slug !== "string") errors.push("manifest.slug missing");
  if (!isObj(m.files)) errors.push("manifest.files missing");
  return { ok: errors.length === 0, errors };
}

export function validateSiteData(d: unknown): Validation {
  const errors: string[] = [];
  if (!isObj(d)) return { ok: false, errors: ["site-data is not an object"] };
  if (d.kind !== "boostly-review-site-data") errors.push("site-data.kind is wrong");
  if (typeof d.schema_version !== "number" || !(SITE_DATA_SCHEMA_VERSIONS as readonly number[]).includes(d.schema_version)) errors.push(`site-data schema_version ${String(d.schema_version)} is not one this site reads (${SITE_DATA_SCHEMA_VERSIONS.join(", ")})`);
  for (const k of ["location", "website", "gbp", "logo_search", "candidates", "links", "previews", "assets", "entry"]) if (!isObj(d[k])) errors.push(`site-data.${k} missing`);
  if (isObj(d.links) && !Array.isArray(d.links.pending_urls)) errors.push("site-data.links.pending_urls missing");
  if (isObj(d.gbp) && !Array.isArray(d.gbp.photos)) errors.push("site-data.gbp.photos missing");
  return { ok: errors.length === 0, errors };
}

export function validateIndex(d: unknown): Validation {
  const errors: string[] = [];
  if (!isObj(d)) return { ok: false, errors: ["index is not an object"] };
  if (typeof d.schema_version !== "number" || !(INDEX_SCHEMA_VERSIONS as readonly number[]).includes(d.schema_version)) errors.push(`index schema_version ${String(d.schema_version)} is not one this site reads`);
  if (!isObj(d.entries)) errors.push("index.entries missing");
  else for (const [slug, e] of Object.entries(d.entries)) if (!isObj(e) || e.slug !== slug || typeof e.name !== "string") { errors.push(`index entry ${slug} malformed`); break; }
  return { ok: errors.length === 0, errors };
}
