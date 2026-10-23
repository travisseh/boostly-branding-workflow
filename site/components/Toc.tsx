"use client";
// Sidebar: highlights the section in view, instant jumps; a "Sections" disclosure below lg.
// "All locations" is the only link above the sections (no back-to-top item).
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { cn } from "cn";

export type TocItem = { id: string; label: string; subs?: { id: string; label: string }[] };

export default function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const sections = items.map((i) => document.getElementById(i.id)).filter(Boolean) as HTMLElement[];
    const visible = new Set<Element>();
    const pick = () => {
      const current = sections.find((s) => visible.has(s)) ?? sections.find((s) => s.getBoundingClientRect().bottom > 0) ?? sections[sections.length - 1];
      setActive(current?.id ?? null);
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target); }
      pick();
    }, { rootMargin: "-15% 0px -60% 0px", threshold: 0 });
    for (const s of sections) io.observe(s);
    pick();
    return () => io.disconnect();
  }, [items]);
  const jump = (ev: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    ev.preventDefault();
    el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
    history.replaceState(null, "", `#${id}`);
    setOpen(false);
  };
  return (
    <nav id="toc" className={cn("toc z-30 border-b bg-sidebar text-sidebar-foreground lg:fixed lg:inset-y-0 lg:left-0 lg:w-60 lg:overflow-y-auto lg:border-r lg:border-b-0", open && "open")}>
      <div className="flex items-center justify-between gap-2 px-4 py-3 lg:block lg:px-3 lg:pt-6">
        <a href="/" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"><ArrowLeft className="size-3.5" />All locations</a>
        <button type="button" className="toc-toggle inline-flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1 text-sm font-medium lg:hidden" aria-expanded={open} aria-controls="toc-list" onClick={() => setOpen((o) => !o)}>
          Sections<ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      <ol id="toc-list" className={cn("m-0 list-none space-y-0.5 px-3 pb-4 lg:block lg:pt-2", open ? "block" : "hidden")}>
        {items.map((n) => (
          <li key={n.id}>
            <a href={`#${n.id}`} onClick={(e) => jump(e, n.id)} className={cn("block rounded-md px-2 py-1.5 text-sm leading-snug hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", active === n.id ? "active bg-sidebar-primary font-medium text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "")}>{n.label}</a>
            {n.subs?.length ? (
              <ol className="mt-0.5 mb-1 ml-3 list-none space-y-0.5 border-l pl-2">
                {n.subs.map((s) => <li key={s.id}><a href={`#${s.id}`} onClick={(e) => jump(e, s.id)} className="block rounded-md px-2 py-1 text-xs leading-snug text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">{s.label}</a></li>)}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
