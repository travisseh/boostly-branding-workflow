"use client";
// Variant sheet: drawn in the browser from the sheet view with the shared templates (sheetHtml), fit to
// the content width with CSS zoom, click the grey background for native size, click cells to select
// two to five of them and Compare selected. Same behavior as the review-canvas.html inline script.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { templates } from "@/lib/templates";

export default function Sheet({ view, focus, assets, caption }: { view: any; focus: { letter: string } | null; assets: Record<string, string>; caption: string | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const [native, setNative] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const src = useCallback((rel: string) => assets[rel] ?? rel, [assets]);
  // Browser only: the expanded markup carries two inline QR SVGs per cell (about 200 KB each), so the
  // server ships the compact view JSON and the sheet is drawn after hydration, as review-canvas.html did.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const html = useMemo(() => (mounted ? templates.sheetHtml(view, { src, focus, selectable: true }) : ""), [mounted, view, src, focus]);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    const zoom = zoomRef.current;
    const sheet = zoom?.querySelector<HTMLElement>(".bs-sheet");
    if (!wrap || !zoom || !sheet) return;
    const w = sheet.offsetWidth;
    (zoom.style as CSSStyleDeclaration & { zoom: string }).zoom = String(native ? 1 : Math.min(1, wrap.clientWidth / w));
  }, [native]);

  useEffect(() => {
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit, html]);

  useEffect(() => {
    const zoom = zoomRef.current;
    if (!zoom) return;
    for (const cell of zoom.querySelectorAll<HTMLElement>(".bs-cell.selectable")) cell.classList.toggle("selected", selected.includes(cell.dataset.letter ?? ""));
  }, [selected, html]);

  useEffect(() => { if (compare) panelRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" }); }, [compare]);

  const onClick = (ev: React.MouseEvent) => {
    const cell = (ev.target as HTMLElement).closest<HTMLElement>(".bs-cell");
    if (!cell) { setNative((n) => !n); return; }
    if (!cell.classList.contains("selectable")) return;
    const l = cell.dataset.letter ?? "";
    setSelected((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
  };
  const n = selected.length;
  const count = n ? `${selected.join(", ")} selected${n > 5 ? " (at most 5)" : n < 2 ? " (pick one more)" : ""}` : "click 2 to 5 cells";
  return (
    <>
      <div className={`sheet-wrap${native ? " native" : ""}`} id="sheet-wrap" ref={wrapRef} title="click the grey background to toggle native size" onClick={onClick}>
        <div className="sheet-zoom tpl" id="sheet-zoom" ref={zoomRef} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {caption ? <p className="cap mt-2 text-xs leading-relaxed text-muted-foreground">{caption}</p> : null}
      <p className="compare-bar mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" id="compare-btn" disabled={n < 2 || n > 5} onClick={() => setCompare(`<h3>Compare ${selected.join(", ")}</h3>` + templates.compareHtml(view, selected.slice(), { src, colW: 300 }))}>Compare selected</Button>
        <Button type="button" size="sm" variant="outline" id="compare-clear" onClick={() => { setSelected([]); setCompare(null); }}>Clear</Button>
        <span id="compare-count" className="text-sm text-muted-foreground tabular-nums">{count}</span>
      </p>
      <div id="compare-panel" className="compare-panel tpl" ref={panelRef} dangerouslySetInnerHTML={{ __html: compare ?? "" }} />
    </>
  );
}
