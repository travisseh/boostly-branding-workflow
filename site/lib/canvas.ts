// Section rules ported from review-canvas.mjs (2026-10-21): GBP photo ordering and labels, vibe photos,
// maps capture captions, logo search, logo candidate captions, raw source files, the sheet subtitle and
// caption, pickStatus and the Previews captions. Pure functions over site-data.json.
import type { SiteData } from "./contract";
import { displayUrl } from "./links";

export const GREEN = "#1B5E20";
export const GRAY_BG = "#EDEDED";
export const LOGO_BG = "#8C8C8C";

export type Figure = {
  file: string | null;
  label: string;
  framed?: boolean;
  bold?: boolean;
  bg?: string;
  source?: { url: string | null; text: string | null } | null;
  pageHref?: string | null;
  pageLabel?: string | null;
  labelColor?: string;
};

const gq = (q: string) => encodeURIComponent(q);

/** Header second line: "City, ST   ·   request X   ·   full order". */
export function headerLine(d: SiteData): string {
  const loc = d.location;
  const city = [loc.city, loc.state].filter(Boolean).join(", ");
  return `${city}${loc.request_id ? `   ·   request ${loc.request_id}` : ""}${loc.order_type ? `   ·   ${loc.order_type.replace(/_/g, " ")}` : ""}`;
}

/** Overview link chips. The new.boostly.com admin links are dropped, as the static build did. */
export function overviewLinks(d: SiteData): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  if (d.location.slack_url) out.push({ label: "Slack thread", url: d.location.slack_url });
  if (d.location.figma_url) out.push({ label: "Figma", url: d.location.figma_url });
  if (d.location.print_folder?.url) out.push({ label: "Print files (Drive)", url: d.location.print_folder.url });
  return out;
}

export function websiteSection(d: SiteData) {
  const w = d.location.website;
  const subtitle = w ? `${w}${d.location.website_swap ? ` ${d.location.website_swap.note}` : ""}` : "no website on the request";
  if (d.website.file) return { subtitle, image: d.website.file, caption: `Desktop screenshot from the run's evidence (${d.website.file}).`, gray: null };
  if (d.website.unavailable) return { subtitle, image: null, caption: null, gray: `Website not captured. ${d.website.unavailable}` };
  const u = d.canvas_usage?.website;
  const reason = u?.reason ?? (w ? "skipped" : "no website URL");
  return { subtitle, image: null, caption: null, gray: `Website not captured. ${reason}` };
}

const ENV_SUBTYPES = new Set(["storefront", "interior_fixture", "exterior", "signage", "menu_signage", "branded_collateral", "interior"]);

export function gbpSection(d: SiteData) {
  const name = d.location.name;
  const city = [d.location.city, d.location.state].filter(Boolean).join(", ");
  const links = [
    d.location.place_id ? { label: "Google Maps place", url: `https://www.google.com/maps/place/?q=place_id:${d.location.place_id}` } : null,
    { label: "Google search", url: `https://www.google.com/search?q=${gq(`${name} ${city}`.trim())}` },
  ].filter(Boolean) as { label: string; url: string }[];
  const cited = new Set<number>();
  for (const text of d.gbp.cite_texts) for (const m of String(text ?? "").matchAll(/gbp-photo-(\d{2})/g)) cited.add(Number(m[1]));
  const tagOf = (t: SiteData["gbp"]["photos"][number]["tag"]) => {
    if (!t) return null;
    const sub = String(t.subtype ?? "").toLowerCase();
    const cls = String(t.classification ?? "").toLowerCase();
    const cat = String(t.category ?? "").toLowerCase();
    const tier = ENV_SUBTYPES.has(sub) || cls === "brand_environment" || cls === "mixed" ? 0 : sub === "vibe" || cat === "vibe" ? 1 : null;
    return tier === null ? null : { tier, word: tier === 0 ? sub.replace(/_/g, " ") || cls.replace(/_/g, " ") : "vibe" };
  };
  const nameKey = name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 8);
  const photos = d.gbp.photos.map((p) => {
    const tag = tagOf(p.tag);
    const tier = tag ? tag.tier : cited.has(p.index) ? 2 : 3;
    const author = p.author ?? "";
    const owner = author && author.toLowerCase().replace(/[^a-z]/g, "").startsWith(nameKey);
    const isCited = cited.has(p.index);
    const size = p.width && p.height ? `  ${p.width}x${p.height}` : "";
    const fig: Figure & { tier: number; index: number } = {
      file: p.file, tier, index: p.index,
      label: `#${p.index}${owner ? " owner photo" : author ? ` by ${author}` : ""}${tag ? `  · ${tag.word}` : ""}${size}${isCited ? "  <- cited by Fable" : ""}`,
      framed: isCited, bold: isCited,
    };
    return fig;
  }).sort((a, b) => a.tier - b.tier || a.index - b.index);
  let photoIntro: string | null = null;
  let showFirst = 0;
  if (photos.length) {
    const tagged = photos.some((p) => p.tier <= 1);
    showFirst = tagged ? photos.filter((p) => p.tier <= 2).length + Math.min(3, photos.filter((p) => p.tier === 3).length) : Math.min(6, photos.length);
    photoIntro = `Place photos already downloaded for this run (${photos.length}), ${tagged ? "storefront, interior and signage photos first, then the rest" : "photos Fable cited first, then the rest"}. Green frame = a photo Fable cited for the sign or interior.`;
  }
  const v = d.gbp.vibe;
  const vibeLabel = v.from === "selected"
    ? 'Google Maps "Vibe" photos from the evidence build (Google\'s own in-store/atmosphere category)'
    : "In-store photos (search results): Google Maps photos fetched by the evidence build, no Vibe category was available";
  const vibe: Figure[] = v.items.map((c) => ({ file: c.file, label: `${c.category ?? "photo"}${c.subtype && c.subtype !== "vibe" ? ` / ${c.subtype}` : ""}${c.classification && c.classification !== "unclassified" ? ` · ${c.classification}` : ""}${c.width ? `  ${c.width}x${c.height}` : ""}` }));
  const vibeGray = vibe.length ? null : `No in-store (Vibe) photos in the evidence: ${d.canvas_usage?.vibe_photos?.reason ?? v.reason ?? "no brand-environment photos in the evidence"}`;
  // maps capture: a file on the page means the canvas reused it (or captured it fresh); otherwise the canvas's recorded mode
  const mu = d.canvas_usage?.maps_view ?? null;
  let maps: { file: string; caption: string; notes: string } | null = null;
  let mapsGray: string | null = null;
  if (d.gbp.maps.file) {
    const cached = !mu || mu.mode === "cached capture";
    const cap = cached ? "Live Google Maps photo view, reused from the earlier capture under review/" : mu.opened_photos ? (mu.vibe_tab ? "Live Google Maps, photo view, Vibe tab" : "Live Google Maps, photo view (no Vibe tab found)") : "Live Google Maps place page (photo view did not open; this is the place panel as loaded)";
    maps = { file: d.gbp.maps.file, caption: cap, notes: (mu?.notes ?? ["reused the cached capture under review/"]).join(" · ") };
  } else if (!mu || mu.mode === "skipped") mapsGray = "Live Google Maps photo view skipped (--skip-google) and no earlier capture under review/ to reuse.";
  else mapsGray = `Live Google Maps photo view not captured. ${(mu.notes ?? ["not attempted"]).join(" · ")}. The in-store photos above are the fallback.`;
  return {
    subtitle: d.location.place_id ? `place id ${d.location.place_id}` : "no place id on the request",
    links, photos, photoIntro, showFirst,
    photosGray: photos.length ? null : "No Place photos were downloaded for this run (gbp-photos/gbp-photos.json missing or empty).",
    vibe, vibeLabel, vibeGray, maps, mapsGray,
  };
}

export function logoSearchSection(d: SiteData) {
  const ls = d.logo_search;
  const googleImages = `https://www.google.com/search?tbm=isch&q=${gq(ls.query)}`;
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  if (ls.mode === "links") {
    return { query: ls.query, googleImages, intro: `${ls.source}: first ${ls.results.length} result pages, links only (no thumbnails). Captions are Google's alt text; open Google Images for the pictures.`, lines: ls.results.slice(0, 24).map((r) => `${host(r.page!)}: ${r.alt || "(no caption)"}${r.w ? `  ${r.w}x${r.h}` : ""}  ${r.page}`), grid: null, shot: null };
  }
  if (ls.mode === "thumbs") {
    return { query: ls.query, googleImages, intro: `${ls.source}: first ${ls.results.length} results, thumbnails at the size Google serves them. Captions are Google's alt text.`, lines: null, grid: ls.results.slice(0, 24).map((r) => ({ file: r.file, label: `${r.alt || "(no caption)"}${r.w ? `  ${r.w}x${r.h}` : ""}`, pageHref: r.page ?? null, pageLabel: r.page ? host(r.page) : null } as Figure)), shot: null };
  }
  if (ls.mode === "shot") {
    return { query: ls.query, googleImages, intro: `Source: ${ls.source ?? "image search"} screenshot${ls.captured_at ? `, captured ${ls.captured_at}` : ""} (reused).`, lines: null, grid: null, shot: ls.file };
  }
  return null;
}

/** candidateSource(): where a logo candidate came from (URL wins, first party points at the website, else the file name). */
export function candidateSource(c: SiteData["candidates"]["items"][number], website: string | null): { url: string | null; text: string | null } {
  const src = String(c?.source ?? "");
  for (const k of ["source_url", "url", "page_url", "origin_url"] as const) { const v = c?.[k]; if (typeof v === "string" && /^https?:\/\//.test(v)) return { url: v, text: displayUrl(v) }; }
  const m = src.match(/https?:\/\/[^\s)\]'"]+/) ?? src.match(/\b(?:www\.)?(?:facebook|instagram|yelp|x|twitter|tiktok)\.com\/[\w.\-/?=&%]+/i);
  if (m) { const url = /^https?:/.test(m[0]) ? m[0] : `https://${m[0]}`; return { url, text: displayUrl(url) }; }
  if (/^first_party/.test(String(c?.provenance ?? "")) && website) return { url: website, text: displayUrl(website) };
  const file = src.match(/[\w][\w.\-]*\.(?:png|jpe?g|svg|webp|gif|pdf|ai|eps)\b/i)?.[0] ?? (c?.basename ?? null);
  return { url: null, text: file ? `file ${file}` : null };
}

export function candidateSourceLabel(c: { source: string | null; provenance: string | null }): string {
  const src = String(c.source ?? "");
  const low = src.toLowerCase();
  const table: [RegExp, string][] = [
    [/facebook (page )?avatar|facebook profile|fb avatar/, "Facebook avatar"],
    [/instagram/, "Instagram avatar"],
    [/site header|header logo|official site/, "site header"],
    [/wizard attachment|onboarding wizard/, "onboarding wizard upload"],
    [/gbp photo|storefront sign|illuminated sign|in-store menu|traced from the sign/, "GBP photo trace (sign/menu)"],
    [/favicon/, "favicon"],
  ];
  let where: string | null = null;
  let best = Infinity;
  for (const [re, label] of table) {
    const m = low.match(re);
    if (m && (m.index ?? 0) < best) { best = m.index ?? 0; where = label; }
  }
  if (!where) where = c.provenance ?? "unknown source";
  if (c.provenance === "first_party_header") where = "site header";
  if (c.provenance === "gbp") where = "GBP photo trace (sign/menu)";
  const traced = c.provenance !== "first_party_header" && /trace|potrace|vector|cut|knockout|recolor|mask/.test(low);
  const m = src.match(/(?:^|\.\s+)((?:FULL|DESCRIPTOR-FREE|WORDS-ONLY|WORDS|NAME-ONLY|ONE-INK|KNOCKOUT|WHITE|BLACK|NAVY|Script|Words)[^.]{0,70})/);
  const treatment = m ? m[1].replace(/\s+/g, " ").trim() : null;
  return `${where}${traced ? ", traced cut" : ""}${treatment ? `\n${treatment}` : ""}`;
}

const RAW_SOURCE_FILES: [RegExp, string][] = [
  [/^site-logo-original\./, "site header, original file"],
  [/^site-logo-w\d+\./, "site header, upscaled"],
  [/^fb-avatar-large\./, "Facebook avatar, large"],
  [/^fb-avatar\./, "Facebook avatar"],
  [/^fb-og-image\./, "Facebook share image"],
  [/^fb-pic-\d+\./, "Facebook profile picture"],
  [/^ig-og-image\./, "Instagram share image"],
  [/^favicon-original\./, "favicon, original"],
  [/^favicon\./, "favicon"],
  [/^wizard-attachment\./, "onboarding wizard upload"],
  [/^00-site-panel/, "site header panel"],
];

export function candidatesSection(d: SiteData, hasLogoSearch: boolean) {
  const website = d.location.website;
  const items: Figure[] = [...d.candidates.items]
    .sort((a, b) => a.basename.localeCompare(b.basename))
    .map((c) => ({
      file: c.file,
      label: `${c.basename}  ${c.width}x${c.height}\n${candidateSourceLabel(c)}${c.chosen ? "\nFABLE'S PICK" : ""}`,
      framed: c.chosen, bold: c.chosen, bg: LOGO_BG, source: candidateSource(c, website),
    }));
  const raw: Figure[] = [];
  for (const f of d.candidates.raw) {
    const hit = RAW_SOURCE_FILES.find(([re]) => re.test(f.basename));
    if (hit && f.file && /\.(png|jpe?g|webp|gif)$/i.test(f.basename)) raw.push({ file: f.file, label: `${f.basename}\n${hit[1]}`, bg: LOGO_BG });
  }
  const links = [website ? { label: "Website", url: website } : null, hasLogoSearch ? null : { label: "Google Images logo search", url: `https://www.google.com/search?tbm=isch&q=${gq(d.logo_search.query)}` }].filter(Boolean) as { label: string; url: string }[];
  return { items, raw, links };
}

export function sheetSection(d: SiteData) {
  const s = d.sheet;
  const def = s?.default_letter ?? null;
  const subtitle = `${def ? `Fable's default ${def} framed in green. ` : ""}Reply with one letter.`;
  if (!s) return { subtitle, view: null, focus: null, caption: null, gray: "variants/variant-sheet.json is missing; run variant-sheet.mjs build first." };
  const n = Object.keys(s.view?.cells ?? {}).length;
  const focus = def && s.view?.cells?.[def] ? { letter: def } : null;
  return { subtitle, view: s.view, focus, gray: null, caption: `${s.json_rel} revision ${s.revision ?? "?"}: ${n} cells drawn by the browser from the sheet JSON and the badge, sticker and POP templates (no app screenshots). Click cells to select two to five of them and Compare selected; click the grey background to toggle native size.` };
}

/** pickStatus() over the sheet facts in site-data. */
export function pickStatus(letter: string, d: SiteData): string[] {
  const s = d.sheet;
  const cell = s?.cells?.[letter];
  const marks = (s?.marks ?? []).filter((m) => m.letter === letter && (m.status === "travisse_pick" || m.status === "fable_pick"));
  const status = cell?.status && cell.status !== "none" ? cell.status : marks[marks.length - 1]?.status ?? null;
  const words: string[] = [];
  if (status === "travisse_pick") words.push("TRAVISSE PICK");
  else if (status === "fable_pick" || (!status && s?.default_letter === letter)) words.push("FABLE PICK");
  else if (status === "rejected") words.push("rejected");
  if (s?.applied_letter === letter) words.push("applied");
  return words;
}

export function previewsSection(d: SiteData) {
  const letters = Object.keys(d.previews.letters).sort();
  if (!letters.length) return null;
  return letters.map((letter) => {
    const g = d.previews.letters[letter];
    const cell = d.sheet?.cells?.[letter];
    const hexes = cell ? `card ${cell.primary} on ${cell.secondary}, text ${cell.text}${cell.band_words ? ` (band ${cell.band_words})` : ""}` : "cell not on the sheet";
    const status = pickStatus(letter, d);
    const counts = `${g.signage_spec || g.signage_png ? "signage preview" : "no signage preview"}, ${g.mockups.length} AI mockup${g.mockups.length === 1 ? "" : "s"}`;
    const rowLabel = cell?.row_label ? String(cell.row_label).slice(0, 110) + (cell.row_label.length > 110 ? "..." : "") : null;
    const heading = `Cell ${letter}${status.length ? `  ${status.join(", ")}` : ""}`;
    const headingColor = status.includes("TRAVISSE PICK") ? "#B7791F" : status.includes("FABLE PICK") ? GREEN : "#111111";
    const sub = `${rowLabel ? `${rowLabel}. ` : ""}${hexes}. ${counts}.`;
    const spec = g.signage_spec;
    const signage = spec ? { spec, caption: `${spec.file}: signage preview drawn from the template (POP sign, tap card, table sticker, bathroom sticker); card ${spec.primary}, accent ${spec.accent}.` } : null;
    const signagePng = !spec && g.signage_png ? { file: g.signage_png, caption: `${g.signage_png}: signage preview (POP, sticker, card, to-go), click to open.` } : null;
    const mockups: Figure[] = g.mockups.map((m) => {
      const v = d.previews.verdicts[m.name.toLowerCase()];
      const verdict = v ? (v.placeholder ? "verdict not filled in yet (prompts.md)" : v.verdict) : d.previews.prompts ? "no verdict line in prompts.md" : "no prompts.md";
      return { file: m.file, label: `${m.scene} (AI)${m.suffix ? ` · ${m.suffix}` : ""}  ${m.basename}\n${verdict}`, bg: GRAY_BG, labelColor: v && !v.placeholder && /invent|drift|repaint|fake|wrong|missing|fail/i.test(v.verdict) ? "#8A1C1C" : "#222222" };
    });
    return { letter, heading, headingColor, sub, signage, signagePng, mockups };
  });
}

// ---- standalone page (no review canvas): port of fulfillment-reviews scripts/print-files.mjs -------------
const CAT_LABELS: Record<string, string> = { x_twitter: "X", order: "Ordering", gift_cards: "Gift cards", careers_jobs: "Careers", loyalty_rewards: "Loyalty", ios_app: "iOS app", android_app: "Android app", other_custom: "Other" };
const catLabel = (c: unknown) => String(c || "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => CAT_LABELS[s] || s.replace(/_/g, " ")).join(", ").replace(/^./, (m) => m.toUpperCase());
export function hostPath(u: string): string { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + x.pathname).replace(/\/$/, "/"); } catch { return String(u); } }

export function standaloneLinksSummary(l: any) {
  const ex: any[] = Array.isArray(l?.execution) ? l.execution : [];
  const written: { cat: string; url: string | null }[] = [], already: typeof written = [], held: typeof written = [], notWritten: typeof written = [];
  for (const e of ex) {
    const op = e.operation || {};
    const row = { cat: catLabel(op.category), url: op.url || null };
    if (e.outcome === "applied") written.push(row);
    else if (e.outcome === "held" || op.action === "hold") held.push(row);
    else if (e.outcome === "skipped_existing" && op.action === "ready") already.push(row);
    else notWritten.push(row);
  }
  for (const h of Array.isArray(l?.held) ? l.held : []) {
    const row = { cat: catLabel(h.category), url: h.url || null };
    if (!held.some((x) => x.cat === row.cat)) held.push(row);
  }
  return { written, already, held, notWritten, any: ex.length > 0 };
}

export function standaloneBranding(d: SiteData) {
  const b = d.branding;
  const parts: { text: string; link?: { href: string; label: string } }[] = [];
  if (!b) return { parts, swatches: [] as { label: string; color: string }[] };
  if (b.existing_kept || b.inherited) parts.push({ text: `Existing ${b.scope === "account" ? "account " : ""}branding kept${b.inherited ? " and inherited" : ""}; no branding colors or logo were written for this location.` });
  else if (b.written_this_run) parts.push({ text: "Branding was written for this location in this run." });
  if (b.source_slug) parts.push({ text: `Branding source: ${b.source_name ? b.source_name + " " : ""}`, link: { href: `/l/${b.source_slug}`, label: "review page" } });
  const swatches = ([["Primary", b.colors.primary], ["Secondary", b.colors.secondary], ["Text", b.colors.text], ["Print text secondary", b.colors.print_text_secondary]] as [string, string | null][])
    .filter(([, c]) => /^#[0-9a-f]{3,8}$/i.test(String(c || "")))
    .map(([label, color]) => ({ label, color: color! }));
  return { parts, swatches };
}
