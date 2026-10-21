"use client";
// Photo/logo grid with the canvas's "Show all N" toggle: items past showFirst start hidden.
import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { GRID } from "./Parts";

export default function PhotoGrid({ cols, total, showFirst, children }: { cols: number; total: number; showFirst: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const first = Number.isFinite(showFirst) && showFirst < total ? showFirst : total;
  return (
    <>
      <div className={cn("grid", GRID[cols], open && "expanded")}>{children}</div>
      {first < total ? (
        <p className="show-all mt-3">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>{open ? `Show fewer (${first} of ${total})` : `Show all ${total}`}</Button>
        </p>
      ) : null}
    </>
  );
}
