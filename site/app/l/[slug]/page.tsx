import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "cn";
import { readChecklist, readIndex, readLocation, readSlugStatus } from "@/lib/blob";
import { liveRow } from "@/lib/board";
import type { SiteData } from "@/lib/contract";
import {
  GRAY_BG, LOGO_BG, candidatesSection, gbpSection, headerLine, hostPath, logoSearchSection, overviewLinks, previewsSection,
  sheetSection, standaloneBranding, standaloneLinksSummary, websiteSection,
} from "@/lib/canvas";
import { displayUrl, linksSection, type StatusKind } from "@/lib/links";
import { fmtTime, type StatusRow } from "@/lib/status";
import { templates } from "@/lib/templates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Cap, Ext, FigureBox, GRID, Gray, LinkChips, Linkify, Shot, TextItems, type TextItem } from "@/components/Parts";
import PhotoGrid from "@/components/PhotoGrid";
import Sheet from "@/components/Sheet";
import Toc, { type TocItem } from "@/components/Toc";
import { StatusStrip, TONE, type Tone } from "@/components/WhatsNext";
import "./canvas.css";

export const revalidate = 30;
export const dynamicParams = true;
/** No slugs at build time: every location renders on first request, then refreshes at most every 30 seconds. */
export async function generateStaticParams() { return []; }

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await readLocation(slug);
  return { title: r.kind === "ok" ? `${r.data.location.name} review` : `${slug} review` };
}

function Section({ id, title, sub, children }: { id: string; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-6">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {sub ? <p className="sub mt-1 mb-4 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{sub}</p> : <div className="mb-4" />}
      {children}
    </section>
  );
}

function PrintFiles({ url }: { url: string | null | undefined }) {
  return url ? (
    <>
      <p className="mb-2"><Button asChild size="sm"><a className="ext" href={url} target="_blank" rel="noopener">Print files (Google Drive folder)<ExternalLink /></a></Button></p>
      <p className="sub text-sm leading-relaxed text-muted-foreground">Approve the signage here: the six vector PDFs and logos exactly as customstickers.com will print them. Later edits replace these files in place, so the link stays the same.</p>
    </>
  ) : <p className="text-sm"><b>Print files:</b> not uploaded yet.</p>;
}

const LINK_TONE: Record<StatusKind, Tone> = { written: "done", live: "done", existing: "done", ready: "done", held: "hold", pending: "progress", rejected: "muted", none: "muted" };

function Shell({ toc, strip, children }: { toc: TocItem[] | null; strip: ReactNode; children: ReactNode }) {
  return (
    <div className="cv min-h-dvh" id="top">
      {/* the shared templates' stylesheet and font: the sheet, compare panel and signage preview need both */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap" precedence="default" />
      <style dangerouslySetInnerHTML={{ __html: templates.SHEET_CSS }} />
      {toc ? <Toc items={toc} /> : null}
      <main className={cn(toc && "lg:pl-60")}>
        <div className="mx-auto max-w-[1680px] px-4 pb-24 sm:px-8">
          {strip}
          <div className="space-y-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

export default async function LocationPage({ params }: Props) {
  const { slug } = await params;
  const [r, checklist, slugStatus] = await Promise.all([readLocation(slug), readChecklist(), readSlugStatus(slug)]);
  const now = Date.now();
  const live = checklist?.generated_at ? fmtTime(checklist.generated_at) : null;
  if (r.kind !== "ok") {
    const { index } = await readIndex();
    const entry = index?.entries[slug] ?? null;
    if (!entry && r.kind === "missing") notFound();
    return (
      <Shell toc={null} strip={<div className="pt-6" />}>
        <a href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />All locations</a>
        <h1 className="text-3xl font-semibold tracking-tight">{entry?.name ?? slug}</h1>
        {entry ? <StatusStrip s={liveRow(entry, checklist, slugStatus)} live={live} now={now} /> : null}
        <Gray text={r.kind === "invalid" ? `This location's published data does not match the site contract: ${r.errors.join("; ")}` : `Not published to this site yet (${r.reason}).`} />
        {entry?.old_url ? <p><Button asChild variant="outline"><a href={entry.old_url} target="_blank" rel="noopener">Open the current review page<ExternalLink /></a></Button></p> : null}
      </Shell>
    );
  }
  const d = r.data;
  const strip = liveRow(d.entry, checklist, slugStatus);
  const asset = (rel: string | null | undefined) => (rel ? d.assets[rel]?.url ?? null : null);
  if (d.entry.has_canvas === false) return <Standalone d={d} strip={strip} live={live} now={now} />;

  const toc: TocItem[] = [];
  let subSeq = 0;
  const sub = (label: string, secId: string) => { const id = `${secId}-${++subSeq}`; toc[toc.length - 1]?.subs?.push({ id, label }); return id; };
  const sec = (id: string, label: string) => toc.push({ id, label, subs: [] });

  sec("header", "Overview");
  const printFolder = d.location.print_folder;
  if (printFolder) sec("print-files", "Print files");
  const web = websiteSection(d);
  sec("website", "Website");
  const gbp = gbpSection(d);
  sec("gbp", "Google Business Profile");
  const ls = logoSearchSection(d);
  if (ls) sec("logo-search", "Logo image search");
  const cand = candidatesSection(d, Boolean(ls));
  sec("candidates", "Logo candidates");
  const rawId = cand.raw.length ? sub("Raw source files the candidates were cut from", "candidates") : null;
  const sh = sheetSection(d);
  sec("sheet", "Variant sheet");
  const lk = linksSection({ links: d.links.block ?? {}, report: d.links.report, pendingUrls: d.links.pending_urls, manifest: d.links.manifest, validation: d.links.validation });
  if (lk) sec("links", `Links (${lk.held} held for review)`);
  const pv = previewsSection(d);
  if (pv) sec("previews", "Previews");
  const pvIds = pv ? pv.map((p) => sub(p.heading, "previews")) : [];
  const assetUrls = Object.fromEntries(Object.entries(d.assets).map(([k, v]) => [k, v.url ?? k]));
  const overview = overviewLinks(d);

  return (
    <Shell toc={toc} strip={<div className="pt-0 lg:pt-4"><StatusStrip s={strip} live={live} now={now} /></div>}>
      <section id="header" className="scroll-mt-24 pt-2">
        <div className="hdr">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{d.location.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">{headerLine(d).split(/\s+·\s+/).join(" · ")}</p>
        </div>
        {overview.length ? <div className="mt-4"><LinkChips links={overview} /></div> : null}
      </section>

      {printFolder ? <Section id="print-files" title="Print files"><PrintFiles url={printFolder.url} /></Section> : null}

      <Section id="website" title="Website" sub={<Linkify text={web.subtitle} />}>
        {web.image ? <Shot url={asset(web.image)} alt="website desktop screenshot" caption={web.caption} /> : <Gray text={web.gray!} />}
      </Section>

      <Section id="gbp" title="Google Business Profile" sub={<Linkify text={gbp.subtitle} />}>
        <LinkChips links={gbp.links} />
        {gbp.photos.length ? (
          <>
            <TextItems items={[{ text: gbp.photoIntro!, size: 20 }]} />
            <div className="mt-3" />
            <PhotoGrid cols={3} total={gbp.photos.length} showFirst={gbp.showFirst}>
              {gbp.photos.map((f, i) => <FigureBox key={f.file! + i} fig={f} url={asset(f.file)} hidden={i >= gbp.showFirst} tall />)}
            </PhotoGrid>
          </>
        ) : <Gray text={gbp.photosGray!} />}
        <div className="mt-6" />
        {gbp.vibe.length ? (
          <>
            <TextItems items={[{ text: gbp.vibeLabel, size: 20 }]} />
            <div className="mt-3" />
            <PhotoGrid cols={3} total={gbp.vibe.length} showFirst={6}>
              {gbp.vibe.map((f, i) => <FigureBox key={f.file! + i} fig={f} url={asset(f.file)} hidden={i >= 6} tall />)}
            </PhotoGrid>
          </>
        ) : <Gray text={gbp.vibeGray!} />}
        <div className="mt-6" />
        {gbp.maps ? (
          <>
            <TextItems items={[{ text: gbp.maps.caption, size: 20 }, { text: gbp.maps.notes, size: 16, color: "#666666", gap: 4 }]} />
            <div className="mt-3" />
            <Shot url={asset(gbp.maps.file)} alt="Google Maps photo view" />
          </>
        ) : <Gray text={gbp.mapsGray!} />}
      </Section>

      {ls ? (
        <Section id="logo-search" title="Logo image search" sub={<Linkify text={`"${ls.query}"`} />}>
          <LinkChips links={[{ label: "Open Google Images", url: ls.googleImages }]} />
          {ls.lines ? <TextItems items={[{ text: ls.intro, size: 20 }, ...ls.lines.map((t) => ({ text: t, size: 16, gap: 6 }))]} /> : <TextItems items={[{ text: ls.intro, size: 20 }]} />}
          {ls.grid ? <div className={cn("mt-3", GRID[4])}>{ls.grid.map((f, i) => <FigureBox key={i} fig={f} url={asset(f.file)} />)}</div> : null}
          {ls.shot ? <div className="mt-3"><Shot url={asset(ls.shot)} alt="logo image search" /></div> : null}
        </Section>
      ) : null}

      <Section id="candidates" title="Logo candidates" sub="from the evidence packet; green frame = the file Fable chose. Gray background so white knockouts stay visible.">
        <LinkChips links={cand.links} />
        {cand.items.length ? <div className={GRID[3]}>{cand.items.map((f, i) => <FigureBox key={i} fig={f} url={asset(f.file)} bg={LOGO_BG} tall />)}</div> : <Gray text="No logo candidates listed in the evidence packet." />}
        {cand.raw.length ? (
          <>
            <TextItems items={[{ text: "Raw source files the candidates were cut from", size: 22, bold: true, gap: 12, id: rawId }]} />
            <div className={cn("mt-3", GRID[4])}>{cand.raw.map((f, i) => <FigureBox key={i} fig={f} url={asset(f.file)} bg={LOGO_BG} />)}</div>
          </>
        ) : null}
      </Section>

      <Section id="sheet" title="Variant sheet" sub={<Linkify text={sh.subtitle} />}>
        {sh.view ? <Sheet view={sh.view} focus={sh.focus} assets={assetUrls} caption={sh.caption} /> : <Gray text={sh.gray!} />}
      </Section>

      {lk ? (
        <Section id="links" title="Links" sub="the link automation results for this location, one row per category; held rows need a human decision. Click a URL to open it.">
          <TextItems items={lk.summary.map((l) => ({ text: l.text, size: 18, color: l.color, bold: l.bold, gap: l.bold ? 8 : undefined }))} />
          <div className="mt-4 overflow-hidden rounded-lg border">
            <Table className="links">
              <TableHeader className="bg-muted/40 max-sm:hidden">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-3 text-xs text-muted-foreground uppercase">Category</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase">URL</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase">Status</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase">Verdict</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lk.rows.map((row) => {
                  const raw = [row.reason, ...(row.evidence ?? [])].filter(Boolean) as string[];
                  return (
                    <TableRow key={row.category} className={cn(`st-${row.status.kind}`, "align-top max-sm:grid max-sm:grid-cols-1 max-sm:py-2", row.status.kind === "held" && "bg-hold/40 hover:bg-hold/60", (row.status.kind === "rejected" || row.status.kind === "none") && "text-muted-foreground")}>
                      <TableCell className="cat pl-3 font-medium max-sm:py-1">{row.label}</TableCell>
                      <TableCell className="url max-w-[22rem] whitespace-normal [overflow-wrap:anywhere] max-sm:max-w-none max-sm:py-1">{row.url ? <Ext href={row.url}>{displayUrl(row.url, 72)}</Ext> : <span className="none text-muted-foreground">none</span>}</TableCell>
                      <TableCell className="max-sm:py-1"><Badge variant="outline" className={cn("chip", TONE[LINK_TONE[row.status.kind]])}>{row.status.kind === "rejected" ? "rejected" : row.status.words}</Badge></TableCell>
                      <TableCell className="ev max-w-[36rem] whitespace-normal text-sm max-sm:max-w-none max-sm:py-1">
                        <div className="verdict">{row.verdict}</div>
                        {raw.length ? (
                          <Collapsible className="mt-1">
                            <CollapsibleTrigger className="group inline-flex cursor-pointer items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"><ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />raw evidence</CollapsibleTrigger>
                            <CollapsibleContent className="raw mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{raw.map((x, i) => <span key={i}>{i ? <br /> : null}<Linkify text={x} /></span>)}</CollapsibleContent>
                          </Collapsible>
                        ) : <span className="none text-xs text-muted-foreground">no evidence recorded</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Section>
      ) : null}

      {pv ? (
        <Section id="previews" title="Previews" sub="signage preview and AI mockups per letter; previews, not proofs (QR drift, invented phone content). Click any image to open the native file.">
          {pv.map((p, i) => (
            <div key={p.letter} className={cn(i > 0 && "mt-8 border-t pt-6")}>
              <TextItems items={[{ text: p.heading, size: 28, bold: true, color: p.headingColor, id: pvIds[i] }, { text: p.sub, size: 18, color: "#444444", gap: 4 }]} />
              <div className="mt-3" />
              {p.signage ? (
                <>
                  <div className="signage-wrap"><div className="tpl" dangerouslySetInnerHTML={{ __html: templates.signagePreviewHtml({ logoUrl: asset(p.signage.spec.logo) ?? null, logoLightUrl: asset(p.signage.spec.logo_light) ?? null, primary: p.signage.spec.primary, accent: p.signage.spec.accent, offer: p.signage.spec.offer, bathroomCopy: p.signage.spec.bathroom_copy ?? null }) }} /></div>
                  <Cap text={p.signage.caption} />
                </>
              ) : p.signagePng ? <Shot url={asset(p.signagePng.file)} alt={`signage preview ${p.letter}`} caption={p.signagePng.caption} /> : null}
              {p.mockups.length ? <div className={cn("mt-4", GRID[4])}>{p.mockups.map((f, j) => <FigureBox key={j} fig={f} url={asset(f.file)} bg={GRAY_BG} />)}</div> : null}
            </div>
          ))}
        </Section>
      ) : null}
    </Shell>
  );
}

/** Links-only siblings with no review canvas (fulfillment-reviews scripts/print-files.mjs standalonePage). */
function Standalone({ d, strip, live, now }: { d: SiteData; strip: StatusRow; live: string | null; now: number }) {
  const b = standaloneBranding(d);
  const ls = standaloneLinksSummary(d.links.block);
  const place = [d.location.city, d.location.state].filter(Boolean).join(", ");
  const name = d.location.location_name ?? d.location.name;
  const toc: TocItem[] = [{ id: "header", label: "Overview" }, { id: "links", label: "Links" }, ...(d.location.print_folder ? [{ id: "print-files", label: "Print files" }] : [])];
  const rows = (title: string, list: { cat: string; url: string | null }[]) => list.length ? (
    <>
      <h3 className="mt-4 mb-2 text-sm font-semibold">{title}</h3>
      <ul className="lk m-0 list-none space-y-1 p-0 text-sm">{list.map((x, i) => <li key={i}><span className="font-medium">{x.cat}</span>{x.url ? <> <Ext href={x.url}>{hostPath(x.url)}</Ext></> : null}</li>)}</ul>
    </>
  ) : null;
  return (
    <Shell toc={toc} strip={<div className="pt-0 lg:pt-4"><StatusStrip s={strip} live={live} now={now} /></div>}>
      <section id="header" className="scroll-mt-24 pt-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{name}</h1>
        {place ? <p className="place mt-1 text-sm text-muted-foreground">{place}</p> : null}
      </section>
      <Section id="branding" title="Branding">
        {b.parts.map((p, i) => <p key={i} className="text-sm leading-relaxed">{p.text}{p.link ? <>(<a className="text-primary underline underline-offset-2" href={p.link.href}>{p.link.label}</a>). This location has no review canvas of its own (links and signage only).</> : null}</p>)}
        {b.swatches.length ? <p className="mt-3 flex flex-wrap gap-3">{b.swatches.map((s) => <span key={s.label} className="sw inline-flex items-center gap-2 text-xs text-muted-foreground"><i className="inline-block size-4 rounded border" style={{ background: s.color }} />{s.label} <span className="font-mono">{s.color}</span></span>)}</p> : null}
      </Section>
      <Section id="links" title="Links">
        {!ls.any ? <p className="sub text-sm text-muted-foreground">No link results recorded in run.json.</p> : (
          <>
            <p className="sum text-sm tabular-nums">{ls.written.length} written, {ls.already.length} already on the location, {ls.held.length} held for review, {ls.notWritten.length} rejected or none found.</p>
            {rows("Written", ls.written)}{rows("Already on the location", ls.already)}{rows("Held for review", ls.held)}
          </>
        )}
      </Section>
      {d.location.print_folder ? <Section id="print-files" title="Print files"><PrintFiles url={d.location.print_folder.url} /></Section> : null}
    </Shell>
  );
}

