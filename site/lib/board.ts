import "server-only";
import { readChecklist, readIndex, readSlugStatus } from "./blob";
import type { Checklist, IndexEntry } from "./contract";
import { mergeChecklist, mergeSlugStatus, newest, rowFromEntry, type StatusRow } from "./status";

export type ListRow = StatusRow & {
  name: string;
  city: string | null;
  state: string | null;
  requested_at: string | null;
  updated_at: string | null;
  pick: string | null;
  has_site_data: boolean;
  old_url: string | null;
};

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** The live row for one entry: the published entry, the 5-minute board item, then the per-location progress file. */
export function liveRow(e: IndexEntry, checklist: Checklist | null, slugStatus: Awaited<ReturnType<typeof readSlugStatus>>): StatusRow {
  let s = rowFromEntry(e);
  const it = checklist?.items.find((x) => x.run_dir === e.slug);
  if (it) s = mergeChecklist(s, it);
  return mergeSlugStatus(s, slugStatus);
}

export async function readBoard(): Promise<{ rows: ListRow[]; errors: string[]; liveAt: string | null; stale: boolean; generatedAt: string | null }> {
  const [{ index, errors }, checklist] = await Promise.all([readIndex(), readChecklist()]);
  if (!index) return { rows: [], errors, liveAt: checklist?.generated_at ?? null, stale: Boolean(checklist?.stale), generatedAt: null };
  const entries = Object.values(index.entries);
  const statuses = await pool(entries, 12, (e) => readSlugStatus(e.slug));
  const rows = entries.map((e, i): ListRow => ({
    ...liveRow(e, checklist, statuses[i]),
    name: e.name,
    city: e.city ?? null,
    state: e.state ?? null,
    requested_at: e.requested_at ?? null,
    updated_at: newest(e.updated_at, e.progress?.updated_at, statuses[i]?.progress?.updated_at),
    pick: e.picked_letter ?? statuses[i]?.picked_letter ?? null,
    has_site_data: e.has_site_data !== false,
    old_url: e.old_url ?? null,
  }));
  return { rows, errors, liveAt: checklist?.generated_at ?? null, stale: Boolean(checklist?.stale), generatedAt: index.generated_at };
}
