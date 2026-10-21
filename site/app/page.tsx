import { readBoard } from "@/lib/board";
import { fmtTime } from "@/lib/status";
import LocationList from "@/components/LocationList";

export const revalidate = 30;

export default async function Home() {
  const board = await readBoard();
  const live = board.liveAt ? fmtTime(board.liveAt) + (board.stale ? " (stale: live request query failed)" : "") : null;
  return (
    <main className="mx-auto max-w-[1280px] px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight sm:text-3xl">Boostly Branding Fulfillment</h1>
      {board.errors.length ? <p className="mb-4 rounded-md border border-needs-border bg-needs px-3 py-2 text-sm text-needs-foreground">{board.errors.join("; ")}</p> : null}
      <LocationList rows={board.rows} live={live} now={Date.now()} />
    </main>
  );
}
