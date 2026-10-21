// "What's next" priority (port of fulfillment-reviews scripts/status-ui.mjs): one primary chip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newest, whatsNext, type StatusRow } from "../lib/status.ts";

const base: StatusRow = { slug: "x", review_url: "/l/x" };
const now = Date.parse("2026-10-21T18:00:00Z");

test("a pick owed beats everything else and names Fable's default", () => {
  const w = whatsNext({ ...base, rec: "X", needs_you: ["Approve the signage", "Pick a letter", "2 link decisions"] }, now);
  assert.equal(w.primary.kind, "pick");
  assert.equal(w.primary.text, "pick a letter (Fable default X)");
  assert.deepEqual(w.rest.map((c) => c.kind), ["signage", "links"]);
  assert.equal(w.rest[1].text, "finish link review (2 held)");
});

test("an agent mid-run inside the two-hour claim shows in progress", () => {
  const w = whatsNext({ ...base, progress: { stage: "sheet", next: "taste pass", updated_at: "2026-10-21T17:30:00Z", editing: { by: "fulfill-location", since: "2026-10-21T17:30:00Z" } } as any }, now);
  assert.equal(w.primary.kind, "progress");
});

test("done, then hold", () => {
  assert.equal(whatsNext({ ...base, done: true }, now).primary.kind, "done");
  const h = whatsNext({ ...base, hold: "waiting on the owner's logo" }, now);
  assert.equal(h.primary.kind, "hold");
  assert.equal(h.primary.text, "hold: waiting on the owner's logo");
});

test("newest: the latest valid time, nulls and junk ignored", () => {
  assert.equal(newest("2026-10-20T10:00:00Z", null, "2026-10-21T09:00:00.000Z", undefined, "junk"), "2026-10-21T09:00:00.000Z");
  assert.equal(newest(null, undefined), null);
});
