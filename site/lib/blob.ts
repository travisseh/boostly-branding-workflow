import "server-only";
import type { BundleManifest, Checklist, IndexDoc, SiteData, SlugStatus } from "./contract";
import { validateIndex, validateManifest, validateSiteData } from "./contract";

// Server-side reads from the public Blob store. The read/write token never reaches the browser: it is used
// only to derive the store's public origin when BLOB_PUBLIC_ORIGIN is not set. Every fetch is cached by
// Next for REVALIDATE seconds; the URL carries a time bucket so the Blob CDN copy is never older than that.
export const REVALIDATE = 30;

export function blobOrigin(): string {
  const explicit = process.env.BLOB_PUBLIC_ORIGIN;
  if (explicit) return explicit.replace(/\/$/, "");
  const id = (process.env.BLOB_READ_WRITE_TOKEN ?? "").split("_")[3];
  if (!id) throw new Error("BLOB_PUBLIC_ORIGIN or BLOB_READ_WRITE_TOKEN must be set (server env)");
  return `https://${id.toLowerCase()}.public.blob.vercel-storage.com`;
}

async function getJson<T>(pathname: string): Promise<T | null> {
  const bucket = Math.floor(Date.now() / (REVALIDATE * 1000));
  const res = await fetch(`${blobOrigin()}/${pathname}?v=${bucket}`, { next: { revalidate: REVALIDATE } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blob ${pathname}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function readIndex(): Promise<{ index: IndexDoc | null; errors: string[] }> {
  const raw = await getJson<IndexDoc>("site/index.json");
  if (!raw) return { index: null, errors: ["site/index.json not found in the Blob store"] };
  const v = validateIndex(raw);
  return v.ok ? { index: raw, errors: [] } : { index: null, errors: v.errors };
}

export async function readChecklist(): Promise<Checklist | null> {
  try {
    const c = await getJson<Checklist>("status/checklist.json");
    return c && Array.isArray(c.items) ? c : null;
  } catch {
    return null;
  }
}

export async function readSlugStatus(slug: string): Promise<SlugStatus | null> {
  try {
    return await getJson<SlugStatus>(`status/${encodeURIComponent(slug)}.json`);
  } catch {
    return null;
  }
}

export type LocationRead =
  | { kind: "ok"; data: SiteData; manifest: BundleManifest }
  | { kind: "missing"; reason: string }
  | { kind: "invalid"; errors: string[] };

export async function readLocation(slug: string): Promise<LocationRead> {
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) return { kind: "missing", reason: "not a location slug" };
  const manifest = await getJson<BundleManifest>(`bundles/${slug}/manifest.json`);
  if (!manifest) return { kind: "missing", reason: "no bundle in the Blob store for this location" };
  const mv = validateManifest(manifest);
  if (!mv.ok) return { kind: "invalid", errors: mv.errors };
  const ref = manifest.files["review/site-data.json"];
  if (!ref) return { kind: "missing", reason: "the bundle has no review/site-data.json (published with the old site path only)" };
  const url = ref.url ?? ref.blob_url;
  if (!url) return { kind: "missing", reason: "review/site-data.json has no URL in the manifest" };
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}sha=${ref.sha256 ?? ""}`, { next: { revalidate: REVALIDATE } });
  if (!res.ok) return { kind: "missing", reason: `review/site-data.json: HTTP ${res.status}` };
  const data = (await res.json()) as SiteData;
  const dv = validateSiteData(data);
  if (!dv.ok) return { kind: "invalid", errors: dv.errors };
  return { kind: "ok", data, manifest };
}
