// Link rows, verdicts and the Links section summary: a line-for-line port of review-canvas.mjs
// (LINK_CATEGORY_WORDS, LINK_STATUS_STYLE, sortLinkRowsByStatus, evidenceWords, approvedWebsiteSwap,
// buildLinkRows, linkVerdict, displayUrl, linksSection summary). tests/links.test.ts runs the skill's own
// functions against this port over every local run and requires identical rows.
import type { CategoryResult, LinkEv } from "./contract";

export const LINK_CATEGORY_WORDS: Record<string, string> = {
  website: "Website", ordering: "Online ordering", order: "Online ordering", menu: "Menu", facebook: "Facebook", instagram: "Instagram",
  x_twitter: "X (Twitter)", tiktok: "TikTok", youtube: "YouTube", careers_jobs: "Careers", catering: "Catering", events: "Events",
  reservations: "Reservations", gift_cards: "Gift cards", loyalty_rewards: "Loyalty / rewards", ios_app: "iOS app", android_app: "Android app",
  app_downloads: "App downloads", other_custom: "Other", socials: "Socials",
};
const LINK_CATEGORY_ORDER = ["website", "ordering", "menu", "facebook", "instagram", "x_twitter", "tiktok", "youtube", "careers_jobs", "catering", "events", "reservations", "gift_cards", "loyalty_rewards", "ios_app", "android_app", "app_downloads", "other_custom"];
const canonCategory = (c: unknown) => (c === "order" ? "ordering" : String(c ?? "").toLowerCase());

export type StatusKind = "written" | "live" | "existing" | "ready" | "held" | "pending" | "rejected" | "none";
export const LINK_STATUS_STYLE: Record<StatusKind, { chip: string; words: string }> = {
  written: { chip: "#1B5E20", words: "written" }, live: { chip: "#1B5E20", words: "verified live" }, existing: { chip: "#1B5E20", words: "already live" },
  ready: { chip: "#1B5E20", words: "verified, ready to write" }, held: { chip: "#B7791F", words: "held for review" },
  pending: { chip: "#6B6B6B", words: "pending browser" }, rejected: { chip: "#6B6B6B", words: "rejected" }, none: { chip: "#6B6B6B", words: "none found" },
};
const LINK_STATUS_GROUP: Record<string, number> = { held: 0, pending: 0, ready: 1, live: 2, written: 2, existing: 2, rejected: 3, none: 4 };

export type LinkRow = { category: string; label: string; url: string | null; status: { kind: StatusKind; chip: string; words: string }; reason: string | null; evidence: string[]; source: string | null; verdict: string };

export function sortLinkRowsByStatus<T extends { status?: { kind?: string } | string }>(rows: T[]): T[] {
  const g = (r: T) => LINK_STATUS_GROUP[(typeof r.status === "string" ? r.status : r.status?.kind) ?? ""] ?? 5;
  return rows.map((r, i) => [r, i] as const).sort((a, b) => g(a[0]) - g(b[0]) || a[1] - b[1]).map(([r]) => r);
}

export function displayUrl(url: unknown, max = 60): string {
  const t = String(url ?? "").replace(/^https?:\/\/(www\.)?/i, "");
  if (t.length <= max) return t;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${t.slice(0, head)}…${t.slice(t.length - tail)}`;
}

export function firstSentence(text: unknown, max = 220): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function evidenceWords(link: LinkEv | null | undefined): string[] {
  if (!link) return [];
  const out: string[] = [];
  const page = link.page_evidence ?? {};
  const title = page.title || null;
  const h1 = Array.isArray(page.h1) && page.h1.length ? page.h1[0] : null;
  if (title && !/just a moment/i.test(title)) out.push(`title "${String(title).slice(0, 70)}"`);
  else if (h1) out.push(`H1 "${String(h1).slice(0, 60)}"`);
  const seen = new Set<string>();
  for (const raw of [...(link.location_match_evidence ?? []), ...(link.validity_evidence ?? []), ...(link.source_evidence ?? [])]) {
    const [key, value] = String(raw).split("=");
    let words: string | null = null;
    if (key === "official_website_links_to_candidate" && value === "true") words = "the website links to it";
    else if (key === "url_slug_or_provider_domain_matches_location" && value === "true") words = "URL slug names the business";
    else if (/^(title|h1|page_title|og_title)_(matches|contains)/.test(key) && value !== "false") words = "title matches the business";
    else if (/^(address|city|geo|zip|phone)_/.test(key) && value !== "false") words = `${key.split("_")[0]} on the page matches`;
    else if (key === "security_or_bot_challenge_detected" && value === "true") words = "bot challenge blocked the automated check";
    else if (key === "platform_unavailable_page_detected" && value === "true") words = "platform says the page is unavailable";
    else if (key === "http_status" && value && !/^2/.test(value)) words = `HTTP ${value}`;
    else if (key === "link_source" && value) words = `found as ${/^[aeiou]/i.test(value) ? "an" : "a"} ${value.replace(/[-_]/g, " ")}`;
    else if (key === "canonicalized_candidate_from" && value) words = `canonical form of ${value}`;
    else if (["final_url", "title", "challenge_signal", "anchor_or_url"].includes(key)) words = null;
    else if (value === "true") words = key.replace(/_/g, " ");
    if (words && !seen.has(words)) { seen.add(words); out.push(words); }
  }
  if (link.liveness && link.liveness !== "live" && link.liveness !== "unknown" && !seen.has(link.liveness)) out.push(`page ${link.liveness}`);
  if (link.rejection_reason && !out.some((w) => /challenge|unavailable/.test(w))) {
    const reason = String(link.rejection_reason).replace(/\.$/, "");
    const m = /^claude_chrome_result_missing:\s*(\S+)/.exec(reason);
    out.push(m ? `no live Chrome result yet for ${m[1]}` : reason);
  }
  return out;
}

const executionCategory = (op: any): string | null => {
  if (!op) return null;
  if (op.category) return canonCategory(op.category);
  if (op.field === "website_url") return "website";
  if (op.field === "ordering_url") return "ordering";
  for (const k of ["facebook", "instagram", "tiktok", "youtube"]) if (`${k}_url` in op) return k;
  if ("x_url" in op) return "x_twitter";
  if ("apple_app_url" in op) return "ios_app";
  if ("google_app_url" in op) return "android_app";
  return null;
};
const executionUrl = (op: any): any => op?.url ?? op?.value ?? Object.entries(op ?? {}).find(([k, v]) => /_url$/.test(k) && typeof v === "string")?.[1] ?? null;

export function approvedWebsiteSwap(wb: any): { url: string; stored: string | null; note: string } | null {
  const url = wb?.approved_website_url;
  if (!url || !/^https?:\/\//.test(String(url))) return null;
  const stored = wb.stored_website_url ?? wb.places_website_uri ?? wb.url ?? null;
  const bare = stored ? String(stored).replace(/^https?:\/\//, "") : null;
  return { url: String(url), stored, note: bare ? `replaces stored ${bare} (approved)` : "approved website" };
}

function urlText(u: any): string | null {
  if (u == null || u === "") return null;
  if (typeof u === "string") return u;
  if (Array.isArray(u)) return urlText(u.find((x) => urlText(x)));
  if (typeof u === "object") return urlText(u.url ?? u.value ?? u.href ?? null);
  return String(u);
}

const OPERATOR_SENTENCE = /--[a-z][\w-]*|\b(?:branding|location|boostly-links|links?)\s+set\b|\bdry run\b|\bsee [\w]+_[\w.]+\b|\bwrite (?:via|with|at)\b|\bcloseout (?:applies|writes|will write)\b|\brun\.json\b/i;
const sentencesOf = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((x) => x.trim()).filter(Boolean);
const reviewerSentences = (reason: unknown) => sentencesOf(reason)
  .map((x) => x.replace(/^(?:question for travisse|note|hold|held|rejected?|ready|write|skip)\s*:\s*/i, "").trim())
  .filter((x) => x && !OPERATOR_SENTENCE.test(x));
const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function linkVerdict(row: { status?: any; evidence?: string[]; reason?: string | null }): string {
  const kind = typeof row?.status === "string" ? row.status : row?.status?.kind ?? "none";
  const text = [...(row?.evidence ?? []), String(row?.reason ?? "")].join(" ; ");
  const matched: string[] = [];
  if (/address on the page matches|\baddress\b[^.;]{0,80}\bmatch(?:es|ing)?\b/i.test(text)) matched.push("address");
  if (/phone on the page matches|\bphone\b[^.;]{0,60}\bmatch(?:es|ing)?\b|\(matches places\)/i.test(text)) matched.push("phone");
  let signal: string | null = null;
  if (matched.length) signal = `Matches the store's ${matched.join(" and ")}.`;
  else if (/the website links to it|\blinked (?:as|from)\b|\bsite backlink\b|official_website_links_to_candidate/i.test(text)) signal = "Linked from the store's own website.";
  else if (/title matches the business|url slug names the business|\bpage title\b|\btitle "/i.test(text)) signal = "Name matches the business.";
  const why = reviewerSentences(row?.reason);
  const first = why[0] ? clipText(why[0], 150) : null;
  if (kind === "written") return ["Written to the location.", signal ?? first].filter(Boolean).join(" ");
  if (kind === "ready" || kind === "live") return ["Will be written at closeout.", signal ?? first].filter(Boolean).join(" ");
  if (kind === "existing") return ["Already on the location, kept as is.", signal ?? first].filter(Boolean).join(" ");
  if (kind === "held") {
    const body = first ?? "needs a human decision";
    return `Held: ${body}${/needs a yes|needs a human|needs a decision/i.test(body) ? "" : " Needs a yes to proceed."}`;
  }
  if (kind === "pending") return "Waiting on the live browser check before a decision.";
  if (kind === "rejected") return `Rejected: ${first ?? "not this business."}`;
  return ["Nothing found.", first].filter(Boolean).join(" ");
}

type WorkRow = { category: string; label: string; url: any; status: StatusKind | null; reason: string | null; evidence: string[]; source: string | null; reportUrl?: any; decided?: boolean };

export function buildLinkRows({ links = {}, categoryResults = [], pendingUrls = [] }: { links?: any; categoryResults?: CategoryResult[]; pendingUrls?: string[] } = {}): LinkRow[] {
  const rows = new Map<string, WorkRow>();
  const at = (c: unknown): WorkRow => {
    const key = canonCategory(c);
    if (!rows.has(key)) rows.set(key, { category: key, label: LINK_CATEGORY_WORDS[key] ?? key.replace(/_/g, " "), url: null, status: null, reason: null, evidence: [], source: null });
    return rows.get(key)!;
  };
  const pending = new Set(pendingUrls.map((u) => String(u).replace(/\/$/, "")));
  const isPending = (u: any) => u && pending.has(String(u).replace(/\/$/, ""));
  for (const cr of categoryResults) {
    const row = at(cr.category);
    const link = cr.selected_link ?? cr.existing_link ?? null;
    const url = link?.final_url ?? link?.input_url ?? null;
    if (url && !row.url) row.url = url;
    row.reportUrl = url;
    row.evidence = evidenceWords(link);
    const st = String(cr.category_status ?? "");
    if (cr.proposed_action === "create" || cr.proposed_action === "update") row.status = "ready";
    else if (/existing_verified|existing_kept/.test(st)) row.status = "existing";
    else if (/found_verified/.test(st)) row.status = "live";
    else if (/needs_manual_review|blocked/.test(st)) { row.status = "held"; row.reason = link?.rejection_reason ?? st.replace(/_/g, " "); }
    else if (/rejected|broken/.test(st)) { row.status = "rejected"; row.reason = link?.rejection_reason ?? st.replace(/_/g, " "); }
    else if (/not_found/.test(st) || !url) row.status = "none";
    else row.status = "held";
    row.source = "discovery report";
  }
  const norm = (u: any) => String(u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
  for (const c of links.candidates ?? []) {
    const row = at(c.category);
    row.decided = true;
    if (c.url) row.url = c.url;
    if (row.reportUrl && norm(c.url) !== norm(row.reportUrl)) row.evidence = [];
    const action = String(c.action ?? "");
    const vs = String(c.verification_status ?? "");
    const why = c.reason ?? c.hold_reason ?? null;
    if (action === "hold") { row.status = "held"; row.reason = why; }
    else if (action === "ready") { row.status = "ready"; row.reason = why; }
    else if (action === "preserve" || /existing_verified/.test(vs)) { row.status = "existing"; row.reason = why; }
    else if (action === "skip" || action === "reject" || /broken|rejected/.test(vs)) { row.status = "rejected"; row.reason = c.reason_code ? `${String(c.reason_code).replace(/_/g, " ")}${why ? `: ${why}` : ""}` : why; }
    else if (action === "write" || action === "apply") { row.status = /verified/.test(vs) ? "live" : "ready"; row.reason = why; }
    else if (!c.url || /no_candidate|not_found/.test(vs) || action === "not_found") { row.status = "none"; row.reason = why; row.url = null; row.evidence = []; }
    if (Array.isArray(c.evidence) && c.evidence.length) row.evidence = c.evidence.map(String);
    if (/verified/.test(vs) && !row.evidence.length) row.evidence.push(`${vs.replace(/_/g, " ")}${c.fetch_method ? ` (${String(c.fetch_method).replace(/_/g, " ")})` : ""}`);
    row.source = "run.json candidates";
  }
  for (const rj of links.rejected ?? []) {
    if (!rj?.category) continue;
    const row = at(rj.category);
    if (row.decided) continue;
    const same = !row.url || !rj.url || norm(rj.url) === norm(row.url);
    if (!same) continue;
    row.decided = true;
    row.url = rj.url ?? row.url;
    row.status = "rejected";
    row.reason = rj.reason ?? rj.reason_code ?? "rejected by the fulfillment agent";
    row.evidence = [];
    row.source = "run.json rejected";
  }
  for (const e of links.execution ?? []) {
    const cat = executionCategory(e.operation);
    if (!cat) continue;
    const row = at(cat);
    row.decided = true;
    const url = executionUrl(e.operation);
    if (url && !row.url) row.url = url;
    const outcome = String(e.outcome ?? "");
    if (/applied|written|created|updated|success/.test(outcome)) { row.status = "written"; row.reason = e.reason ?? null; }
    else if (outcome === "skipped_existing") {
      const action = String(e.operation?.action ?? "");
      row.status = action === "reject" ? "rejected" : action === "none" ? "none" : "existing";
      row.reason = e.reason ?? row.reason;
    } else if (/held|skipped|blocked/.test(outcome)) { row.status = "held"; row.reason = e.reason ?? row.reason; }
    row.source = "execution";
  }
  for (const w of links.writes_performed ?? []) {
    const cat = executionCategory(w.operation ?? w);
    if (!cat) continue;
    const row = at(cat);
    row.status = "written"; row.url = row.url ?? executionUrl(w.operation ?? w); row.reason = w.reason ?? row.reason;
  }
  for (const c of links.not_found ?? []) { const row = at(c); if (!row.status) row.status = "none"; }
  const wb = links.website_bootstrap;
  if (wb && (wb.places_website_uri || wb.url || wb.approved_website_url)) {
    const row = at("website");
    row.url = row.url ?? wb.places_website_uri ?? wb.url;
    if (/applied|written/.test(String(wb.status))) row.status = "written";
    else if (String(wb.status) === "held") { row.status = "held"; row.reason = row.reason ?? (wb.apply ?? "website bootstrap held"); }
    if (wb.resolves_to && !row.evidence.length) row.evidence.push(`Places website resolves to ${String(wb.resolves_to).split(" ")[0]}`);
    const swap = approvedWebsiteSwap(wb);
    if (swap) {
      row.url = swap.url;
      row.decided = true;
      if (row.status !== "written") { row.status = "ready"; row.reason = wb.closeout_action ?? wb.approved_by ?? "approved website swap"; }
      row.evidence = [swap.note];
    }
  }
  const om = links.ordering_url_match;
  if (om?.stored) {
    const row = at("ordering");
    row.url = row.url ?? om.stored;
    if (om.match === true) row.evidence.unshift("stored ordering URL matches the website");
    if (!row.status) row.status = "existing";
  }
  for (const row of rows.values()) {
    if (!row.decided && row.status !== "written" && row.status !== "existing" && isPending(row.url)) { row.status = "pending"; row.reason = row.reason ?? "waiting on the live Chrome check"; }
    if (!row.status) row.status = row.url ? "held" : "none";
    row.reason = row.reason ? String(row.reason).replace(/\s+/g, " ").trim() : null;
  }
  const order = (c: string) => { const i = LINK_CATEGORY_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  const chipFor = (r: WorkRow) => {
    const kind = r.status as StatusKind;
    const style = { kind, ...LINK_STATUS_STYLE[kind] };
    if (kind === "rejected" && r.reason) {
      const short = r.reason.length > 72 ? `${r.reason.slice(0, 69).trimEnd()}...` : r.reason;
      return { ...style, words: `rejected: ${short}` };
    }
    return style;
  };
  return [...rows.values()]
    .sort((a, b) => order(a.category) - order(b.category) || a.category.localeCompare(b.category))
    .map(({ reportUrl, decided, ...r }) => ({ ...r, url: urlText(r.url), status: chipFor(r), verdict: linkVerdict(r) }));
}

export type SummaryLine = { text: string; color?: string; bold?: boolean };

/** The Links section: rows (sorted) and the summary lines, or null when the run has no link data. Port of linksSection(). */
export function linksSection(input: {
  links: any;
  report: { file: string; checked_at: string | null; summary: Record<string, number | null> | null; category_results: CategoryResult[] } | null;
  pendingUrls: string[];
  manifest: string | null;
  validation: { file: string; valid: boolean | null; errors: string[] } | null;
}): { rows: LinkRow[]; summary: SummaryLine[]; held: number } | null {
  const { links, report, pendingUrls, manifest, validation: v } = input;
  const rows = sortLinkRowsByStatus(buildLinkRows({ links, categoryResults: report?.category_results ?? [], pendingUrls }));
  const hasData = rows.length || links.website_bootstrap || links.execution?.length || links.candidates?.length;
  if (!hasData) return null;
  const count = (k: string) => rows.filter((r) => r.status.kind === k).length;
  const held = count("held");
  const written = count("written");
  const pending = count("pending");
  const GREY = "#444444";
  const summary: SummaryLine[] = [];
  if (links.mode || links.written_by) summary.push({ text: `Run: ${[links.mode ? String(links.mode).replace(/_/g, " ") : null, links.applied ? "writes applied" : "no link writes applied", links.written_by ? `by ${String(links.written_by).split(",")[0]}` : null].filter(Boolean).join("; ")}.`, color: GREY });
  const wb = links.website_bootstrap;
  const swap = approvedWebsiteSwap(wb);
  if (swap) summary.push({ text: `Website: ${swap.url} ${swap.note}; written at closeout.`, color: GREY });
  else if (wb) summary.push({ text: `Website bootstrap: ${wb.status ?? "unknown"}${wb.places_website_uri ? `, Places says ${wb.places_website_uri}` : ""}${wb.resolves_to ? ` (${String(wb.resolves_to).split(" (")[0]})` : ""}.`, color: GREY });
  else if (links.existing?.website_url) summary.push({ text: `Website on file: ${links.existing.website_url}.`, color: GREY });
  const om = links.ordering_url_match;
  if (om?.stored) summary.push({ text: `Ordering URL on file ${om.stored}: ${om.match === true ? "matches the website" : om.match === false ? "does not match the website" : "not compared"}${om.note ? `. ${firstSentence(om.note, 160)}` : ""}`, color: GREY });
  if (report) {
    const s = report.summary;
    summary.push({ text: `Discovery report ${report.file}${report.checked_at ? ` (${report.checked_at.slice(0, 16).replace("T", " ")})` : ""}${s ? `: ${s.categories_total ?? rows.length} categories, ${s.manual_review_items ?? 0} for manual review, ${s.proposed_location_updates ?? 0} proposed field updates, ${s.proposed_touchpoint_events ?? 0} proposed events` : ""}.`, color: GREY });
  }
  if (pendingUrls.length) summary.push({ text: `${pendingUrls.length} URL${pendingUrls.length === 1 ? "" : "s"} still waiting on the live Chrome check${manifest ? ` (${manifest})` : ""}.`, color: "#6B6B6B" });
  if (v) summary.push({ text: `Validator ${v.file}: ${v.valid ? "valid" : `not valid (${(v.errors ?? []).map((e) => String(e).replace(/_/g, " ")).join("; ") || "no reason given"})`}.`, color: v.valid ? "#1B5E20" : "#B7791F" });
  summary.push({ text: `${rows.length} categories: ${written} written, ${rows.filter((r) => r.status.kind === "live" || r.status.kind === "existing" || r.status.kind === "ready").length} verified or already live, ${held} held for review, ${pending} pending browser, ${count("rejected")} rejected, ${count("none")} none found.`, bold: true });
  return { rows, summary, held };
}
