// "What's next": a direct port of fulfillment-reviews scripts/status-ui.mjs STATUS_JS (2026-10-21):
// owed(), isDone(), claimed(), whatsNext(), merge(). Same priority, same texts, same clipping.
import type { ChecklistItem, Editing, IndexEntry, Progress, ReviewStatus, SlugStatus } from "./contract";

export type StatusRow = {
  slug: string;
  status?: string | null;
  steps?: [string, boolean][] | null;
  needs_you?: string[] | null;
  gaps?: string[] | null;
  hold?: string | null;
  done?: boolean | null;
  note?: string | null;
  review_status?: ReviewStatus;
  progress?: Progress | null;
  editing?: Editing;
  figma_url?: string | null;
  print_url?: string | null;
  review_url: string;
  rec?: string | null;
  boostly_status?: string | null;
};

export type ChipKind = "pick" | "signage" | "links" | "store" | "other" | "progress" | "done" | "hold" | "gap";
export type Chip = { kind: ChipKind; text: string; href?: string; ext?: boolean };
export type WhatsNext = { primary: Chip; rest: Chip[]; owed: Chip[]; rank: number };

export const RANK: Record<string, number> = { pick: 1, signage: 2, links: 3, store: 4, other: 5 };
export const CLAIM_MS = 2 * 3600 * 1000;

export function owed(s: StatusRow): Chip[] {
  if (s.done) return [];
  const out: Chip[] = [];
  for (const n of s.needs_you ?? []) {
    const low = String(n).toLowerCase();
    let m: RegExpMatchArray | null;
    if (low.indexOf("pick a letter") === 0) out.push({ kind: "pick", text: "pick a letter" + (s.rec ? " (Fable default " + s.rec + ")" : "") });
    else if (/^approve the (figma )?signage/.test(low)) {
      const figma = low.indexOf("figma") !== -1 && s.figma_url;
      const href = s.print_url || (figma ? s.figma_url! : (s.review_url || "") + "#print-files");
      out.push({ kind: "signage", text: "approve signage", href, ext: !!(s.print_url || figma) });
    } else if ((m = low.match(/(\d+)\s+link decision/))) out.push({ kind: "links", text: "finish link review (" + m[1] + " held)", href: (s.review_url || "") + "#links" });
    else if (low.indexOf("link decision") !== -1) out.push({ kind: "links", text: "finish link review", href: (s.review_url || "") + "#links" });
    else if (low.indexOf("store details") !== -1) out.push({ kind: "store", text: "confirm store details" });
    else out.push({ kind: "other", text: String(n).replace("(s)", "s") });
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

export function isDone(s: StatusRow): boolean {
  const rs = s.review_status || {};
  const p = s.progress || {};
  return !!(s.done || s.status === "closed" || rs.status === "done" || p.stage === "done");
}

export function claimed(s: StatusRow, now = Date.now()): boolean {
  const ed = (s.progress && s.progress.editing) || s.editing;
  const t = ed && ed.since ? Date.parse(ed.since) : NaN;
  return !!(t && !Number.isNaN(t) && now - t < CLAIM_MS);
}

function progressText(s: StatusRow): string {
  const p = s.progress || {};
  return "in progress: " + (p.stage || "working") + (p.next_step && p.stage !== "done" ? ", next " + p.next_step : "");
}

export function whatsNext(s: StatusRow, now = Date.now()): WhatsNext {
  const o = owed(s);
  const p = s.progress || {};
  let primary: Chip;
  let rest: Chip[] = [];
  if (o.length) { primary = o[0]; rest = o.slice(1); }
  else if (claimed(s, now)) primary = { kind: "progress", text: progressText(s) };
  else if (isDone(s)) primary = { kind: "done", text: "done" };
  else if (p.stage && p.stage !== "done" && !p.blocked_on) primary = { kind: "progress", text: progressText(s) };
  else if (s.hold) primary = { kind: "hold", text: "hold: " + s.hold };
  else if (p.blocked_on) primary = { kind: "other", text: p.blocked_on };
  else if (s.review_status && s.review_status.waiting_on) primary = { kind: "progress", text: "waiting on " + s.review_status.waiting_on };
  else primary = { kind: "progress", text: s.steps ? "with the agents, nothing for you" : "not on the open-request list" };
  if (s.hold && primary.kind !== "hold") rest.push({ kind: "hold", text: "hold: " + s.hold });
  for (const g of s.gaps ?? []) rest.push({ kind: "gap", text: g });
  return { primary, rest, owed: o, rank: o.length ? RANK[o[0].kind] : s.hold && !isDone(s) ? 6 : 9 };
}

export function clip(t: string, n: number): string {
  t = String(t);
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
}

/** status-ui merge(): the live board item overlays the published entry; the newer progress wins. */
export function mergeChecklist(s: StatusRow, it: ChecklistItem): StatusRow {
  const out: StatusRow = { ...s };
  out.boostly_status = it.status || s.boostly_status;
  out.steps = it.steps || s.steps;
  out.needs_you = it.needs_you || s.needs_you;
  out.gaps = it.gaps || s.gaps;
  out.hold = it.hold == null ? s.hold : it.hold;
  out.done = it.done == null ? s.done : it.done;
  out.note = it.note == null ? s.note : it.note;
  out.review_status = it.review_status || s.review_status;
  if (it.progress && (!s.progress || String(it.progress.updated_at || "") >= String(s.progress.updated_at || ""))) out.progress = it.progress;
  if (it.figma_url && !s.figma_url) out.figma_url = it.figma_url;
  return out;
}

/** The per-location status/<slug>.json overlay of the location page strip: newer progress wins. */
export function mergeSlugStatus(s: StatusRow, p: SlugStatus | null): StatusRow {
  if (!p || !p.progress) return s;
  if (s.progress && String(s.progress.updated_at || "") > String(p.progress.updated_at || "")) return s;
  const out: StatusRow = { ...s, progress: p.progress };
  if (p.review_status) out.review_status = p.review_status;
  if (p.editing !== undefined) out.editing = p.editing;
  return out;
}

export function rowFromEntry(e: IndexEntry): StatusRow {
  return {
    slug: e.slug,
    status: e.status,
    steps: e.steps ?? null,
    needs_you: e.needs_you ?? null,
    gaps: e.gaps ?? null,
    hold: e.hold ?? null,
    done: e.done ?? null,
    note: e.note ?? null,
    review_status: e.review_status ?? null,
    progress: e.progress ? { ...e.progress, editing: e.progress.editing ?? e.editing ?? null } : null,
    editing: e.editing ?? null,
    figma_url: e.figma_url ?? null,
    print_url: e.print_url ?? null,
    review_url: `/l/${e.slug}`,
    rec: e.recommended_letter ?? null,
    boostly_status: e.boostly_status ?? null,
  };
}

const FMT_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Denver" });
const FMT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Denver" });
export function parseIso(iso?: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
  return Number.isNaN(t) ? 0 : t;
}
export const fmtTime = (iso?: string | null) => { const t = parseIso(iso); return t ? FMT_TIME.format(new Date(t)) : ""; };
export const fmtDate = (iso?: string | null) => { const t = parseIso(iso); return t ? FMT_DATE.format(new Date(t)) : ""; };
