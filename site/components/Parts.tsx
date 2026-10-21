// Server-rendered building blocks of a location page, mirroring review-canvas.mjs renderHtml(): linkify,
// text items, link chips, figures, image shots, gray boxes. Same content and order; Tailwind + shadcn look.
import type { ReactNode } from "react";
import { Fragment } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { Figure } from "@/lib/canvas";
import { displayUrl } from "@/lib/links";

const URL_RE = /https?:\/\/[^\s]+?(?=[.,;:)\]'"]*(?:\s|$))/g;

/** Text with every http(s) URL turned into an external link and newlines into <br>. */
export function Linkify({ text }: { text: string | null | undefined }) {
  const lines = String(text ?? "").split("\n");
  return (
    <>
      {lines.map((line, li) => {
        const out: ReactNode[] = [];
        let last = 0;
        for (const m of line.matchAll(URL_RE)) {
          if (m.index! > last) out.push(line.slice(last, m.index));
          out.push(<Ext key={`${li}-${m.index}`} href={m[0]}>{m[0]}</Ext>);
          last = m.index! + m[0].length;
        }
        out.push(line.slice(last));
        return <Fragment key={li}>{li > 0 ? <br /> : null}{out}</Fragment>;
      })}
    </>
  );
}

export function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return <a className={cn("ext text-primary underline decoration-muted-foreground/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-primary", className)} href={href} target="_blank" rel="noopener">{children}</a>;
}

/** Semantic colors the canvas used, mapped to theme-aware classes. */
const COLOR: Record<string, string> = {
  "#444444": "text-muted-foreground", "#666666": "text-muted-foreground", "#6B6B6B": "text-muted-foreground", "#555555": "text-muted-foreground",
  "#111111": "", "#222222": "",
  "#1B5E20": "text-done-foreground", "#B7791F": "text-hold-foreground", "#8A1C1C": "text-needs-foreground",
};
export const colorClass = (c?: string) => (c ? COLOR[c.toUpperCase().replace(/^#([0-9A-F]{6})$/, "#$1")] ?? COLOR[c] ?? "" : "");

export type TextItem = { text: string; size?: number; bold?: boolean; color?: string; gap?: number; id?: string | null };

/** The canvas's sized text runs on a type scale: 28+ title, 22-27 heading, 20-21 lead, 18-19 body, below small. */
const sizeClass = (n: number) => (n >= 28 ? "text-lg" : n >= 22 ? "text-base" : n >= 20 ? "text-sm" : n >= 18 ? "text-sm" : "text-[13px]");

export function TextItems({ items }: { items: TextItem[] }) {
  return (
    <>
      {items.map((it, i) => (
        <p key={i} id={it.id ?? undefined} className={cn("scroll-mt-24 leading-relaxed [overflow-wrap:anywhere]", sizeClass(it.size ?? 22), it.bold && "font-semibold", (it.size ?? 22) >= 22 && it.bold && "tracking-tight", colorClass(it.color), it.gap ? (it.gap >= 10 ? "mt-4" : "mt-1.5") : "")}>
          <Linkify text={it.text} />
        </p>
      ))}
    </>
  );
}

export function LinkChips({ links }: { links: { label: string; url: string }[] }) {
  if (!links.length) return null;
  return (
    <p className="links mb-4 flex flex-wrap gap-2">
      {links.map((l, i) => (
        <Button key={l.url + i} asChild variant="outline" size="sm"><a className="ext" href={l.url} target="_blank" rel="noopener">{l.label}<ExternalLink /></a></Button>
      ))}
    </p>
  );
}

export function Gray({ text }: { text: string }) {
  return <div className="gray rounded-lg border border-dashed bg-muted/50 px-4 py-3 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"><Linkify text={text} /></div>;
}

export function Cap({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <p className="cap mt-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"><Linkify text={text} /></p>;
}

export function Shot({ url, alt, caption }: { url: string | null; alt: string; caption?: string | null }) {
  if (!url) return null;
  return (
    <>
      <div className="shot max-h-[90vh] overflow-auto rounded-lg border"><a href={url} target="_blank"><img className="block h-auto w-full" src={url} loading="lazy" alt={alt} /></a></div>
      <Cap text={caption} />
    </>
  );
}

export function FigureBox({ fig, url, bg, hidden, tall }: { fig: Figure; url: string | null; bg?: string; hidden?: boolean; tall?: boolean }) {
  const back = fig.bg ?? bg;
  const src = fig.source ?? null;
  return (
    <figure className={cn("m-0 min-w-0 overflow-hidden rounded-lg border bg-card", fig.framed && "framed ring-[3px] ring-done-foreground", hidden && "more")}>
      <a className="block" href={fig.pageHref ?? url ?? undefined} target="_blank" rel={fig.pageHref ? "noopener" : undefined} title={fig.pageHref ? `open the source page: ${fig.pageHref}` : "open the file"} style={{ background: back ?? "var(--muted)" }}>
        {url ? <img className={cn("block w-full object-contain", tall ? "h-56 sm:h-72 lg:h-[340px]" : "h-44 sm:h-56 lg:h-64")} src={url} loading="lazy" alt={fig.label ?? ""} /> : <div className={tall ? "h-56" : "h-44"} />}
      </a>
      <figcaption className={cn("px-3 py-2 text-xs leading-relaxed whitespace-normal text-muted-foreground [overflow-wrap:anywhere]", fig.bold && "font-semibold text-foreground", colorClass(fig.labelColor))}>
        {fig.pageHref ? <><Ext href={fig.pageHref}><b>{fig.pageLabel ?? fig.pageHref}</b></Ext><br /></> : null}
        <Linkify text={fig.label} />
        {src && (src.text || src.url) ? (src.url ? <><br /><Ext href={src.url}>{src.text ?? displayUrl(src.url)}</Ext></> : <><br /><span className="src">{src.text}</span></>) : null}
      </figcaption>
    </figure>
  );
}

/** Grid classes per old column count: two columns on phones, the canvas's count on wide screens. */
export const GRID: Record<number, string> = {
  3: "grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3",
  4: "grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4",
};
