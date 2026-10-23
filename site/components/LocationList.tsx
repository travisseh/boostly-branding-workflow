"use client";
// The list page: search, status filter, sort ("needs you first" by default), one "What's next" column.
// Same derivation as the location page strip (lib/status.ts whatsNext). A table from md up, cards below.
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Search } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ListRow } from "@/lib/board";
import { fmtDate, isDone as rowIsDone, parseIso, whatsNext, type WhatsNext } from "@/lib/status";
import { LiveDot, NextChips, NoteToggle } from "./WhatsNext";

type Prepared = ListRow & { _w: WhatsNext; _needs: boolean; _hay: string; _req: number; _upd: number };
const norm = (s: unknown) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const SORTERS: Record<string, (a: Prepared, b: Prepared) => number> = {
  needs: (a, b) => a._w.rank - b._w.rank || b._upd - a._upd,
  updated: (a, b) => b._upd - a._upd,
  updated_asc: (a, b) => a._upd - b._upd,
  requested: (a, b) => b._req - a._req,
  requested_asc: (a, b) => a._req - b._req,
  name: (a, b) => a.name.localeCompare(b.name),
};

const SELECT = "h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

function Letter({ l, kind }: { l: string | null | undefined; kind: "rec" | "pick" }) {
  if (!l) return <span className="text-muted-foreground">&ndash;</span>;
  return (
    <span className={cn("letter inline-flex size-6 items-center justify-center rounded-md border text-xs font-semibold tabular-nums", kind === "pick" ? "border-done-border bg-done text-done-foreground" : "border-border bg-muted text-foreground")}>{l}</span>
  );
}

function Links({ s }: { s: Prepared }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {s.review_url ? <Button asChild size="xs"><a href={s.review_url}>Review</a></Button> : <span className="text-xs text-muted-foreground">no review page yet</span>}
      {s.figma_url ? <Button asChild size="xs" variant="outline"><a href={s.figma_url} target="_blank" rel="noopener">Figma<ExternalLink /></a></Button> : null}
      {s.print_url ? <Button asChild size="xs" variant="outline"><a href={s.print_url} target="_blank" rel="noopener">Print files<ExternalLink /></a></Button> : null}
    </div>
  );
}

/** A count that filters the list to its rows when clicked; clicking the active one goes back to the default view. */
function Stat({ n, label, tone, on, onClick }: { n: number; label: string; tone?: boolean; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={on ? "Show the default list" : `Show only these ${n}`}
      className={cn("flex cursor-pointer items-baseline gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5 hover:bg-muted", on && "bg-muted ring-1 ring-border")}>
      <span className={cn("text-lg font-semibold tabular-nums", tone && n > 0 && "text-needs-foreground")}>{n}</span>
      <span className={cn("text-sm", on ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </button>
  );
}
const DEFAULT_SHOW = "open"; // done locations are hidden unless asked for

export default function LocationList({ rows, live, now }: { rows: ListRow[]; live: string | null; now: number }) {
  const [q, setQ] = useState("");
  const [show, setShow] = useState(DEFAULT_SHOW);
  const [sort, setSort] = useState("needs");
  const prepared = useMemo<Prepared[]>(() => rows.map((s) => {
    const w = whatsNext(s, now);
    return {
      ...s, _w: w, _needs: !!(w.owed.length || (s.hold && !s.done)),
      _hay: norm([s.name, s.city, s.state, s.slug, s.note, w.primary.text, w.rest.map((r) => r.text).join(" "), s.review_status?.waiting_on].join(" ")),
      _req: parseIso(s.requested_at), _upd: parseIso(s.updated_at),
    };
  }), [rows, now]);
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const has = (s: Prepared, kind: string) => s._w.owed.some((o) => o.kind === kind);
  // Same rule the chips use (lib/status isDone): closed, done, review done, or progress stage done.
  const isDone = (s: Prepared) => rowIsDone(s);
  const OWED = new Set(["pick", "signage", "links", "store"]);
  const list = prepared.filter((s) => {
    if (show === "open") { if (isDone(s)) return false; }
    else if (OWED.has(show)) { if (!has(s, show)) return false; }
    else if (show === "all") { /* everything, done included */ }
    else if (show && s.status !== show) return false;
    return terms.every((t) => s._hay.includes(t));
  }).sort(SORTERS[sort] ?? SORTERS.needs);
  const toggleShow = (k: string) => setShow((cur) => (cur === k ? DEFAULT_SHOW : k));
  const counts = {
    picks: prepared.filter((s) => has(s, "pick")).length,
    signage: prepared.filter((s) => has(s, "signage")).length,
    links: prepared.filter((s) => has(s, "links")).length,
    store: prepared.filter((s) => has(s, "store")).length,
    open: prepared.filter((s) => !isDone(s)).length,
  };
  const sortBy = (k: string) => setSort((cur) => (cur === k && k !== "name" ? `${k}_asc` : k));
  const SortHead = ({ k, children, className }: { k: string; children: React.ReactNode; className?: string }) => {
    const on = sort.replace(/_asc$/, "") === k;
    const Icon = sort === `${k}_asc` ? ArrowUp : ArrowDown;
    return (
      <TableHead className={className}>
        <button type="button" onClick={() => sortBy(k)} className={cn("inline-flex cursor-pointer items-center gap-1 hover:text-foreground", on ? "text-foreground" : "text-muted-foreground")}>
          {children}{on ? <Icon className="size-3" /> : null}
        </button>
      </TableHead>
    );
  };
  return (
    <>
      <div className="summary mb-6 flex flex-wrap items-center gap-x-6 gap-y-2">
        <Stat n={counts.picks} label="picks" tone on={show === "pick"} onClick={() => toggleShow("pick")} />
        <Stat n={counts.signage} label="signage approvals" tone on={show === "signage"} onClick={() => toggleShow("signage")} />
        <Stat n={counts.links} label="link decisions" tone on={show === "links"} onClick={() => toggleShow("links")} />
        <Stat n={counts.store} label="store details" tone on={show === "store"} onClick={() => toggleShow("store")} />
        <Stat n={counts.open} label="open" on={show === "open"} onClick={() => toggleShow("open")} />
        <span className="ml-auto"><LiveDot live={live} fallback="board not loaded" /></span>
      </div>
      <div className="controls mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by location, city, state, or note" autoComplete="off" aria-label="Search locations" className="pl-8" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">Show
          <select className={SELECT} value={show} onChange={(e) => setShow(e.target.value)}>
            <option value="open">Open (done hidden)</option>
            <option value="all">All locations, done included</option>
            <optgroup label="Needs you">
              <option value="pick">Needs a pick</option>
              <option value="signage">Needs signage approval</option>
              <option value="links">Needs a link decision</option>
              <option value="store">Needs store details</option>
            </optgroup>
            <optgroup label="Other">
              <option value="inherits">Inherits branding (pending)</option>
              <option value="closed">Closed out</option>
            </optgroup>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">Sort
          <select className={SELECT} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="needs">Needs you first</option>
            <option value="updated">Last updated, newest</option>
            <option value="updated_asc">Last updated, oldest</option>
            <option value="requested">Requested, newest</option>
            <option value="requested_asc">Requested, oldest</option>
            <option value="name">Name, A to Z</option>
          </select>
        </label>
      </div>
      <p className="count mb-2 text-sm text-muted-foreground tabular-nums"><span className="font-medium text-foreground">{list.length}</span> of {prepared.length} locations</p>

      <Card className="hidden gap-0 overflow-hidden py-0 md:block">
        <Table className="table-fixed">
          <colgroup><col className="w-[26%]" /><col className="w-[108px]" /><col className="w-[108px]" /><col /><col className="w-[96px]" /><col className="w-[150px] lg:w-[220px]" /></colgroup>
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              <SortHead k="name" className="pl-4">Location</SortHead>
              <SortHead k="requested">Requested</SortHead>
              <SortHead k="updated">Updated</SortHead>
              <TableHead className="text-muted-foreground">What&apos;s next</TableHead>
              <TableHead className="text-muted-foreground">Rec / Pick</TableHead>
              <TableHead><span className="sr-only">Links</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length ? list.map((s) => (
              <TableRow key={s.slug} data-needs={s._needs || undefined} className="align-top">
                <TableCell className="py-3 pl-4 whitespace-normal">
                  {s.review_url ? <a href={s.review_url} className="name font-medium hover:underline">{s.name}</a> : <span className="name font-medium">{s.name}</span>}
                  <div className="place text-xs text-muted-foreground">{[s.city, s.state].filter(Boolean).join(", ")}</div>
                  <NoteToggle note={s.note} />
                </TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground tabular-nums">{fmtDate(s.requested_at)}</TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground tabular-nums">{fmtDate(s.updated_at)}</TableCell>
                <TableCell className="py-3 whitespace-normal"><NextChips s={s} now={now} /></TableCell>
                <TableCell className="py-3"><div className="flex items-center gap-1"><Letter l={s.rec} kind="rec" /><Letter l={s.pick} kind="pick" /></div></TableCell>
                <TableCell className="py-3 whitespace-normal"><Links s={s} /></TableCell>
              </TableRow>
            )) : <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No locations match.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>

      <div className="grid gap-3 md:hidden">
        {list.length ? list.map((s) => (
          <Card key={s.slug} className="gap-3 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {s.review_url ? <a href={s.review_url} className="font-medium hover:underline">{s.name}</a> : <span className="font-medium">{s.name}</span>}
                <div className="text-xs text-muted-foreground">{[s.city, s.state].filter(Boolean).join(", ")}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1"><Letter l={s.rec} kind="rec" /><Letter l={s.pick} kind="pick" /></div>
            </div>
            <NextChips s={s} now={now} />
            <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground tabular-nums">
              <span>Requested {fmtDate(s.requested_at) || "–"}</span><span>Updated {fmtDate(s.updated_at) || "–"}</span>
            </div>
            <NoteToggle note={s.note} />
            <Links s={s} />
          </Card>
        )) : <p className="py-10 text-center text-muted-foreground">No locations match.</p>}
      </div>
    </>
  );
}
