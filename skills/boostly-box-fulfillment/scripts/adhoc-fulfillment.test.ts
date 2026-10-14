import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  adHocSlug,
  autoApplyEnabled,
  boardNote,
  decideAdHoc,
  evaluatePriorRun,
  figmaActionFor,
  findPriorRun,
  pagesFor,
  parseLooseJson,
  printKindsFor,
  redact,
  renderCommands,
  storeDetailsMissing,
  type AdHocRequestFacts,
  type LiveBranding,
  type Quantities,
} from "./adhoc-fulfillment.ts";
import { initRun, setBlock } from "./run-file.ts";

function quantities(overrides: Partial<Quantities> = {}): Quantities {
  return { tap_cards: 0, tables: 0, bathroom_stalls: 0, signage: 0, to_go_rolls: 0, ...overrides };
}

function facts(overrides: Partial<AdHocRequestFacts> = {}): AdHocRequestFacts {
  const q = overrides.quantities ?? quantities({ signage: 40 });
  return {
    request_id: "adhoc1",
    location_id: "loc1",
    account_id: "acc1",
    location_name: "Craft by Smoke and Fire (Anaheim)",
    account_name: "Craft By Smoke & Fire",
    created_at: "2026-09-30T14:44:14",
    status: "physical_fulfillment",
    slack_thread_ts: "1790779455.309659",
    offer_text: "Had a good time? Let us know!",
    store_details_confirmed_at: "2026-10-14T21:14:11.74",
    digital_fulfilled_at: "2026-09-30T14:44:13.999",
    shipping: { recipient_name: "Someone", address_line1: "1 Main St", city: "Anaheim", state: "CA", zip: "92801", complete: true },
    quantities: q,
    items: [
      ...(q.signage ? [{ item_type: "signage", placement: "point_of_purchase", focus: null, quantity: q.signage, printed: false }] : []),
      ...(q.tables ? [{ item_type: "stickers", placement: "table", focus: "subscribe", quantity: q.tables, printed: false }] : []),
      ...(q.bathroom_stalls ? [{ item_type: "stickers", placement: "bathroom", focus: "subscribe", quantity: q.bathroom_stalls, printed: false }] : []),
      ...(q.tap_cards ? [{ item_type: "tapcards", placement: null, focus: null, quantity: q.tap_cards, printed: false }] : []),
    ],
    ...overrides,
  };
}

const brandingOk: LiveBranding = { logo_set: true, scope: "account", logo_attachment_id: "att1", prior_full_orders_completed: 1 };
const brandingNone: LiveBranding = { logo_set: false, scope: null, logo_attachment_id: null, prior_full_orders_completed: 0 };

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "adhoc-test-"));
}

/** A completed prior run: request + applied write + built figma + the branding-complete receipt. */
function makePriorRun(root: string, slug: string, options: { locationId?: string; tables?: number; stalls?: number; complete?: boolean; applied?: boolean } = {}): string {
  const runDir = path.join(root, slug);
  initRun({
    runDir,
    request: { request_id: `req-${slug}`, location_id: options.locationId ?? "loc1", account_id: "acc1", location_name: "Craft by Smoke and Fire (Anaheim)", order_type: "full_order",
      quantities: { tap_cards: 10, tables: options.tables ?? 10, bathroom_stalls: options.stalls ?? 6, signage: 1, to_go_rolls: 2 } },
  });
  setBlock(runDir, "write", { status: options.applied === false ? "held" : "applied", scope: "account", logo_file: "fix/card-final.png", sticker_logo_file: "fix/sticker.png", logo_attachment_id: "att1" }, { by: "test" });
  setBlock(runDir, "figma", { status: "built", file_key: "N5uzBBdCz7ySxxaNTxfKGm", section_node_id: "591:2", section_url: "https://www.figma.com/design/N5uzBBdCz7ySxxaNTxfKGm/x?node-id=591-2",
    section_name: "Craft - generated production sheets", sheet_ids: { "Print Sheet - POP Sign (Primary)": "591:10" }, quantities: { tables: options.tables ?? 10, bathroom_stalls: options.stalls ?? 6, signage: 1, to_go_rolls: 2 }, built_at: "2026-10-01T00:00:00Z" }, { by: "test" });
  if (options.complete !== false) {
    fs.mkdirSync(path.join(runDir, "finish"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "finish", "branding-complete-apply.json"), "(node:1) ExperimentalWarning: x\nWARNING: moves to physical_fulfillment\n{\"ok\":true}\n");
  }
  return runDir;
}

test("pages and print kinds follow the quantities", () => {
  assert.equal(pagesFor(0), 0);
  assert.equal(pagesFor(10), 3);
  assert.equal(pagesFor(16), 4);
  assert.deepEqual(printKindsFor(quantities({ signage: 40 })), ["pop-sign"]);
  assert.deepEqual(printKindsFor(quantities({ tables: 8, bathroom_stalls: 2, to_go_rolls: 1 })), ["table-stickers", "review-stickers", "bathroom-stickers", "bathroom-review-stickers", "togo-label"]);
  assert.deepEqual(printKindsFor(quantities({ tap_cards: 5 })), []);
});

test("store details completeness mirrors the admin lane: ship-to fields plus the offer for printed items", () => {
  assert.deepEqual(storeDetailsMissing(facts()), []);
  const partial = facts({ shipping: { recipient_name: "Someone", address_line1: "1 Main St", city: "Anaheim", state: "", zip: null, complete: false } });
  assert.deepEqual(storeDetailsMissing(partial), ["state", "zip"]);
  assert.deepEqual(storeDetailsMissing(facts({ offer_text: "" })), ["offer"]);
  assert.deepEqual(storeDetailsMissing(facts({ offer_text: "", quantities: quantities({ tap_cards: 5 }) })), []);
});

test("figma action: reuse on matching pages, trim when fewer, expand when more, none without printed items", () => {
  const prior = { tables: 10, bathroom_stalls: 6 };
  assert.equal(figmaActionFor(quantities({ tap_cards: 5 }), prior), "none");
  assert.equal(figmaActionFor(quantities({ signage: 40 }), prior), "reuse");
  assert.equal(figmaActionFor(quantities({ tables: 10, bathroom_stalls: 6 }), prior), "reuse");
  assert.equal(figmaActionFor(quantities({ tables: 6, bathroom_stalls: 6 }), prior), "clone_trim");
  assert.equal(figmaActionFor(quantities({ tables: 16, bathroom_stalls: 6 }), prior), "clone_expand");
  assert.equal(figmaActionFor(quantities({ tables: 10, bathroom_stalls: 8 }), prior), "clone_expand");
});

test("eligible: prior completed run plus complete store details and live logo", () => {
  const root = makeRoot();
  const priorDir = makePriorRun(root, "craft-anaheim");
  const prior = findPriorRun([root], "loc1", "adhoc1");
  assert.ok(prior);
  assert.equal(prior.run_dir, priorDir);
  assert.equal(prior.complete, true);
  assert.equal(prior.branding_complete_evidence, "finish/branding-complete-apply.json");
  const decision = decideAdHoc({ request: facts(), prior, branding: brandingOk, runRoot: root });
  assert.equal(decision.outcome, "eligible");
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.figma_action, "reuse");
  assert.deepEqual(decision.print_kinds, ["pop-sign"]);
  assert.equal(decision.slug, "craft-by-smoke-and-fire-anaheim-adhoc-20260930");
  assert.equal(decision.run_dir, path.join(root, decision.slug));
  assert.ok(decision.actions.some((a) => a.startsWith("figma: reuse prior section 591:2")));
  assert.ok(decision.actions.some((a) => a.includes("print_handoff: export pop-sign")));
  const commands = renderCommands(decision);
  assert.ok(commands.some((c) => c.includes("print-handoff.mjs") && c.includes("--kinds pop-sign")));
  assert.ok(!commands.some((c) => c.includes("store-details adhoc1 --confirm")), "already confirmed: no confirm command");
  assert.ok(commands.some((c) => c.includes("--thread-ts 1790779455.309659")));
});

test("eligible with writes pending: unconfirmed store details and no branding complete render the dry-then-apply commands", () => {
  const root = makeRoot();
  makePriorRun(root, "craft-anaheim");
  const prior = findPriorRun([root], "loc1");
  const decision = decideAdHoc({ request: facts({ store_details_confirmed_at: null, digital_fulfilled_at: null }), prior, branding: brandingOk, runRoot: root });
  assert.equal(decision.outcome, "eligible");
  const commands = renderCommands(decision);
  const confirm = commands.filter((c) => c.includes("fulfillment store-details adhoc1 --confirm"));
  assert.equal(confirm.length, 2);
  assert.ok(confirm[0].endsWith("--json") && confirm[1].endsWith("--apply"));
  assert.equal(commands.filter((c) => c.includes("fulfillment branding adhoc1 --complete")).length, 2);
});

test("queued: missing prior run for a printed order", () => {
  const root = makeRoot();
  const decision = decideAdHoc({ request: facts(), prior: null, branding: brandingOk, runRoot: root });
  assert.equal(decision.outcome, "queued");
  assert.equal(decision.reasons.length, 1);
  assert.match(decision.reasons[0], /^no_prior_run/);
  assert.equal(decision.figma_action, "none");
  assert.match(boardNote(decision), /queued for the normal pipeline: no prior run\./);
  assert.ok(renderCommands(decision).some((c) => c.includes("--stage intake")));
});

test("tap cards only: no prior run needed, nothing to print", () => {
  const root = makeRoot();
  const decision = decideAdHoc({ request: facts({ quantities: quantities({ tap_cards: 5 }), location_name: "Cafe Panuzzo's", created_at: "2026-10-01T14:27:57.532" }), prior: null, branding: brandingOk, runRoot: root });
  assert.equal(decision.outcome, "eligible");
  assert.equal(decision.checks.print_needed, false);
  assert.equal(decision.figma_action, "none");
  assert.equal(decision.slug, "cafe-panuzzo-s-adhoc-20261001");
  assert.ok(decision.actions.some((a) => a.startsWith("print_handoff: not needed")));
  assert.ok(!renderCommands(decision).some((c) => c.includes("print-handoff.mjs")));
});

test("queued: partial ship-to names the missing fields, never the values", () => {
  const root = makeRoot();
  makePriorRun(root, "craft-anaheim");
  const prior = findPriorRun([root], "loc1");
  const request = facts({ shipping: { recipient_name: "Secret Person", address_line1: null, city: "Anaheim", state: "CA", zip: null, complete: false }, store_details_confirmed_at: null });
  const decision = decideAdHoc({ request, prior, branding: brandingOk, runRoot: root });
  assert.equal(decision.outcome, "queued");
  assert.deepEqual(decision.checks.store_details_missing, ["line1", "zip"]);
  assert.match(decision.reasons[0], /^store_details_incomplete: missing line1, zip$/);
  const note = boardNote(decision);
  assert.ok(!note.includes("Secret Person") && !note.includes("Anaheim"));
  assert.match(note, /store details incomplete/);
});

test("queued: no live logo even with a prior run", () => {
  const root = makeRoot();
  makePriorRun(root, "craft-anaheim");
  const prior = findPriorRun([root], "loc1");
  const decision = decideAdHoc({ request: facts(), prior, branding: brandingNone, runRoot: root });
  assert.equal(decision.outcome, "queued");
  assert.match(decision.reasons[0], /^no_prior_branding/);
});

test("quantity mismatch: more tables than the prior section needs a clone and expand brief", () => {
  const root = makeRoot();
  makePriorRun(root, "craft-anaheim", { tables: 10, stalls: 6 });
  const prior = findPriorRun([root], "loc1");
  const decision = decideAdHoc({ request: facts({ quantities: quantities({ tables: 16, bathroom_stalls: 6, signage: 1 }) }), prior, branding: brandingOk, runRoot: root });
  assert.equal(decision.outcome, "eligible");
  assert.equal(decision.figma_action, "clone_expand");
  assert.deepEqual(decision.figma_pages, { tables: 4, bathroom: 2, prior_tables: 3, prior_bathroom: 2 });
  const commands = renderCommands(decision);
  assert.ok(commands.some((c) => c.includes("needs_figma_build") && c.includes("expand to 4 table pages")));
  const fewer = decideAdHoc({ request: facts({ quantities: quantities({ tables: 6, bathroom_stalls: 2 }) }), prior, branding: brandingOk, runRoot: root });
  assert.equal(fewer.figma_action, "clone_trim");
  assert.ok(renderCommands(fewer).some((c) => c.includes("figma-trim.mjs") && c.includes("--tables 6 --stalls 2")));
});

test("prior run selection: a complete run beats a newer incomplete one; an incomplete-only location reports its problems", () => {
  const root = makeRoot();
  makePriorRun(root, "craft-old", { complete: true });
  const incompleteDir = makePriorRun(root, "craft-new", { complete: false });
  const incomplete = evaluatePriorRun(incompleteDir);
  assert.ok(incomplete && !incomplete.complete);
  assert.match(incomplete.problems[0], /branding complete not recorded/);
  const picked = findPriorRun([root], "loc1");
  assert.equal(picked?.slug, "craft-old");
  const other = makeRoot();
  makePriorRun(other, "craft-held", { applied: false, complete: false });
  const held = findPriorRun([other], "loc1");
  assert.equal(held?.complete, false);
  const decision = decideAdHoc({ request: facts(), prior: held, branding: brandingOk, runRoot: other });
  assert.equal(decision.outcome, "queued");
  assert.match(decision.reasons[0], /^prior_run_incomplete: write.status is held/);
  assert.equal(findPriorRun([root], "loc-other"), null);
});

test("existing ad hoc run state: done is reported, not redone", () => {
  const root = makeRoot();
  makePriorRun(root, "craft-anaheim");
  const prior = findPriorRun([root], "loc1");
  const decision = decideAdHoc({ request: facts(), prior, branding: brandingOk, runRoot: root, existing: { run_dir: path.join(root, "craft-by-smoke-and-fire-anaheim-adhoc-20260930"), adhoc: { status: "done" } } });
  assert.equal(decision.outcome, "done");
  assert.deepEqual(renderCommands(decision), ["nothing: already auto-fulfilled (adhoc.json status done)"]);
});

test("helpers: slug, loose JSON receipts, redaction, auto-apply switch", () => {
  assert.equal(adHocSlug("MG's Prime Time Bar and Event Center", "2026-09-28T21:56:14.272"), "mg-s-prime-time-bar-and-event-center-adhoc-20260928");
  assert.deepEqual(parseLooseJson("(node:1) ExperimentalWarning: x\nWARNING: moves\n{\"a\":1}\n"), { a: 1 });
  assert.equal(redact("cookie=abc.def; token: xyz xoxp-123-abc"), "cookie=<redacted>; token: <redacted> <redacted>");
  const envFile = path.join(makeRoot(), ".env");
  fs.writeFileSync(envFile, "FOO=1\nADHOC_AUTO_APPLY=0\n");
  assert.equal(autoApplyEnabled({}, envFile), false);
  fs.writeFileSync(envFile, "ADHOC_AUTO_APPLY=1\n");
  assert.equal(autoApplyEnabled({}, envFile), true);
  assert.equal(autoApplyEnabled({ ADHOC_AUTO_APPLY: "0" }, envFile), false);
  assert.equal(autoApplyEnabled({}, path.join(path.dirname(envFile), "missing.env")), false);
});
