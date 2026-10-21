"use client";
// "What's next" (status-ui.mjs nextHtml/strip): one primary chip, smaller muted secondary chips, as shadcn
// badges in a four-tone palette: needs you, in progress, done, hold. Clipped chip text shows in full on hover.
import { ChevronRight } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Chip, StatusRow } from "@/lib/status";
import { RANK, clip, fmtTime, whatsNext } from "@/lib/status";

export type Tone = "needs" | "progress" | "done" | "hold" | "muted";
export const TONE: Record<Tone, string> = {
  needs: "border-needs-border bg-needs text-needs-foreground",
  progress: "border-progress-border bg-progress text-progress-foreground",
  done: "border-done-border bg-done text-done-foreground",
  hold: "border-hold-border bg-hold text-hold-foreground",
  muted: "border-border bg-transparent text-muted-foreground",
};
export const toneOf = (kind: Chip["kind"]): Tone =>
  kind === "progress" ? "progress" : kind === "done" ? "done" : kind === "hold" ? "hold" : kind === "gap" ? "muted" : "needs";

function ChipBadge({ c, max, primary }: { c: Chip; max: number; primary: boolean }) {
  const text = clip(c.text, max);
  const tone: Tone = primary ? toneOf(c.kind) : RANK[c.kind] ? "needs" : c.kind === "hold" ? "hold" : "muted";
  const cls = cn(
    "max-w-full whitespace-normal text-left leading-snug [overflow-wrap:anywhere]",
    TONE[tone],
    primary ? "px-2.5 py-1 text-xs font-semibold" : "px-2 py-0.5 text-[11px] font-medium",
    !primary && tone === "needs" && "bg-transparent",
    c.href && "underline-offset-2 hover:underline",
  );
  const inner = c.href
    ? <Badge asChild variant="outline" className={cls}><a href={c.href} {...(c.ext ? { target: "_blank", rel: "noopener" } : {})}>{text}</a></Badge>
    : <Badge variant="outline" className={cls}>{text}</Badge>;
  if (text === c.text) return inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{inner}</TooltipTrigger>
      <TooltipContent className="max-w-sm">{c.text}</TooltipContent>
    </Tooltip>
  );
}

export function NextChips({ s, now }: { s: StatusRow; now: number }) {
  const w = whatsNext(s, now);
  return (
    <div className="wn flex min-w-0 flex-wrap items-center gap-1.5">
      <ChipBadge c={w.primary} max={90} primary />
      {w.rest.map((r, i) => <ChipBadge key={i} c={r} max={60} primary={false} />)}
    </div>
  );
}

export function NoteToggle({ note }: { note?: string | null }) {
  if (!note) return null;
  return (
    <Collapsible className="mt-1">
      <CollapsibleTrigger className="group inline-flex cursor-pointer items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />note
      </CollapsibleTrigger>
      <CollapsibleContent className="note mt-1 max-w-[90ch] text-xs leading-relaxed text-foreground">{note}</CollapsibleContent>
    </Collapsible>
  );
}

export function LiveDot({ live, fallback }: { live: string | null; fallback: string }) {
  return (
    <span className="live inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <span className={cn("size-1.5 rounded-full", live ? "bg-done-foreground" : "bg-muted-foreground/50")} />
      {live ? `live ${live}` : fallback}
    </span>
  );
}

/** The sticky strip on a location page. */
export function StatusStrip({ s, live, now }: { s: StatusRow; live: string | null; now: number }) {
  const p = s.progress || {};
  const who = [p.by, p.host ? "on " + p.host : "", p.updated_at ? fmtTime(p.updated_at) : ""].filter(Boolean).join(" ");
  return (
    <div className="site-status sticky top-0 z-20 -mx-4 mb-6 border-b bg-background/85 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:-mx-8 sm:px-8" id="site-status" data-slug={s.slug}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What&apos;s next</span>
        <div className="min-w-0 flex-1"><NextChips s={s} now={now} /></div>
        {who ? <span className="pwho text-xs text-muted-foreground tabular-nums" title="last stamped by">{who}</span> : null}
        <LiveDot live={live} fallback="as of the last publish" />
      </div>
      {s.note ? <NoteToggle note={s.note} /> : null}
    </div>
  );
}
