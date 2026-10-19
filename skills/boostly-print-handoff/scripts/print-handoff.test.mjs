// node --test print-handoff.test.mjs : the step planner's safety rules, plus an end-to-end proof that
// --offline (and --dry-run / --scratch) makes zero Drive, Sheets or Gmail calls: the script runs under an
// empty HOME (no Google auth can load, so any API call would throw) and must still exit 0 after the export.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planSteps, DRY_FLAGS } from "./print-handoff.mjs";
import { offerChange, shipToMissing } from "./lib/common.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const names = (p) => p.steps.map((s) => s.script);

test("default plan: direct export, then drive and email only with --live", () => {
  const p = planSteps({});
  assert.deepEqual(names(p), ["export-direct.mjs"]);
  assert.match(p.stopReason, /--live/);
  assert.equal(p.direct, true);
  const live = planSteps({ live: true });
  assert.deepEqual(names(live), ["export-direct.mjs", "drive-upload.mjs", "draft-email.mjs"]);
  assert.equal(live.stopReason, null);
});

test("--figma exports the Figma section instead (fallback, and in-flight runs approved in Figma)", () => {
  const p = planSteps({ figma: true, live: true, section: "14:2" });
  assert.deepEqual(names(p), ["export-sheets.mjs", "drive-upload.mjs", "draft-email.mjs"]);
  assert.deepEqual(p.steps[0].extra, ["--section", "14:2"]);
  assert.equal(p.direct, false);
});

test("every dry flag stops after the export (no drive, no summary, no email)", () => {
  assert.deepEqual(DRY_FLAGS, ["offline", "dry-run", "scratch"]);
  for (const flag of DRY_FLAGS) {
    const p = planSteps({ [flag]: true });
    assert.deepEqual(names(p), ["export-direct.mjs"], flag);
    assert.deepEqual(p.skipped.map((s) => s.script), ["drive-upload.mjs", "draft-email.mjs"], flag);
    assert.ok(p.dry && /no Drive upload, no summary row, no email/.test(p.stopReason), flag);
    // --offline is never forwarded to drive-upload.mjs (its own --offline only swaps data sources);
    // export-direct.mjs does take it (skips the live offer re-read)
    assert.ok(!p.steps.some((s) => s.script === "drive-upload.mjs" && s.extra.includes("--offline")));
    if (flag === "offline") assert.ok(p.steps[0].extra.includes("--offline"));
  }
  const skipExport = planSteps({ offline: true, "skip-export": true });
  assert.deepEqual(names(skipExport), []);
});

test("--force passes through to the export; dry wins over live; --skip-draft", () => {
  const p = planSteps({ force: true });
  assert.ok(p.steps[0].extra.includes("--force"));
  const liveDry = planSteps({ live: true, "dry-run": true });
  assert.deepEqual(names(liveDry), ["export-direct.mjs"], "dry wins over live");
  const skipDraft = planSteps({ live: true, "skip-draft": true });
  assert.deepEqual(names(skipDraft), ["export-direct.mjs", "drive-upload.mjs"]);
});

test("end to end: --offline under an empty HOME makes zero Drive calls and exits 0", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ph-home-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-run-"));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ request: { request_id: "test0000-0000", location_name: "Test Diner" } }));
  fs.mkdirSync(path.join(runDir, "print-handoff"));
  fs.writeFileSync(path.join(runDir, "print-handoff", "handoff.json"), JSON.stringify({ location_name: "Test Diner", sheets: { "pop-sign": { pages: 2, expected_pages: 2, vector: true } } }));
  const r = spawnSync("node", [path.join(here, "print-handoff.mjs"), "--run-dir", runDir, "--offline", "--skip-export"], { encoding: "utf8", env: { ...process.env, HOME: home, FIGMA_TOKEN: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /drive-upload\.mjs skipped: --offline/);
  assert.match(r.stdout, /draft-email\.mjs skipped/);
  assert.doesNotMatch(r.stdout, /== drive-upload\.mjs ==|== draft-email\.mjs ==/);
  const h = JSON.parse(fs.readFileSync(path.join(runDir, "print-handoff", "handoff.json"), "utf8"));
  assert.equal(h.drive, undefined, "no drive block written");
  assert.equal(h.draft, undefined, "no draft block written");
  assert.equal(fs.existsSync(path.join(home, ".config")), false, "nothing touched the empty HOME");
});

// A hand-off fixture with drive + sheets blocks so draft-email.mjs reaches its gate and body without any API.
function draftFixture(facts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ph-home-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-run-"));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ request: { request_id: "test0000-0000", location_id: "loc0", location_name: "Test Diner" } }));
  fs.mkdirSync(path.join(runDir, "print-handoff"));
  fs.writeFileSync(path.join(runDir, "print-handoff", "handoff.json"), JSON.stringify({
    location_name: "Test Diner", source: "direct",
    drive: { folder_link: "https://drive.example/folder", master_link: "https://drive.example/master" },
    sheets: { "pop-sign": { pages: 2, expected_pages: 2, vector: true } },
    facts,
  }));
  return { home, runDir, env: { ...process.env, HOME: home, FIGMA_TOKEN: "" } };
}

test("draft-email exits 3 on an incomplete ship-to and records blocked_on, no draft, no send", () => {
  const { home, runDir, env } = draftFixture({ offer_text: "Get 20% Off!", quantities: { tables: 10, bathroom_stalls: 6, to_go_rolls: 2, signage: 1 }, ship_to: [], ship_to_complete: false, shipping: { recipient_name: "Leo", address_line1: "", city: "Hoboken", state: "NJ", zip: "" } });
  const r = spawnSync("node", [path.join(here, "draft-email.mjs"), "--run-dir", runDir, "--offline"], { encoding: "utf8", env });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /"blocked_on":"ship-to"/);
  const h = JSON.parse(fs.readFileSync(path.join(runDir, "print-handoff", "handoff.json"), "utf8"));
  assert.deepEqual(h.draft, { ...h.draft, blocked_on: "ship-to", missing: ["address_line1", "zip"], sent: false });
  assert.equal(h.draft.id, undefined, "no Gmail draft was made");
  assert.equal(fs.existsSync(path.join(runDir, "print-handoff", "draft-body.txt")), false, "no body written while blocked");
  assert.equal(fs.existsSync(path.join(home, ".config")), false);
  assert.equal(planSteps({ live: true }).steps.find((s) => s.script === "draft-email.mjs").exit3, "blocked on ship-to", "print-handoff.mjs reports exit 3 as a ship-to block");
});

test("draft-email states a zero-table order plainly and tolerates absent sheet kinds", () => {
  const { runDir, env } = draftFixture({ offer_text: "Had a good time? Let us know!", quantities: { tap_cards: 0, tables: 0, bathroom_stalls: 0, to_go_rolls: 0, signage: 40 }, ship_to: ["Leo Iasaad", "195 West Center Street Promenade", "Anaheim, CA 92805"], ship_to_complete: true });
  const r = spawnSync("node", [path.join(here, "draft-email.mjs"), "--run-dir", runDir, "--offline", "--print-only"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- No table stickers in this order$/m);
  assert.match(r.stdout, /^- No bathroom strips in this order$/m);
  assert.match(r.stdout, /^- No to-go label rolls in this order$/m);
  assert.match(r.stdout, /^- POP sign sets: 40$/m);
  assert.match(r.stdout, /Anaheim, CA 92805/);
  assert.doesNotMatch(r.stdout, /not on file yet/);
  const h = JSON.parse(fs.readFileSync(path.join(runDir, "print-handoff", "handoff.json"), "utf8"));
  assert.equal(h.draft, undefined, "--print-only never drafts");
});

test("offerChange and shipToMissing are pure and strict", () => {
  assert.equal(offerChange("Get 20% Off!", "Get 20% Off!"), null);
  assert.equal(offerChange("Get 20% Off!", "  get 20% off! "), null, "whitespace and case are not a change");
  assert.equal(offerChange("Get 20% Off!", null), null, "no live read, no change");
  assert.deepEqual(offerChange("Get 20% Off!", "Free appetizer"), { from: "Get 20% Off!", to: "Free appetizer" });
  assert.equal(offerChange("", "Join the Club!"), null, "empty and the generic default are the same offer");
  assert.deepEqual(offerChange("Join the Club!", "Get 20% Off!"), { from: "Join the Club!", to: "Get 20% Off!" });
  assert.deepEqual(shipToMissing(null), ["recipient_name", "address_line1", "city", "state", "zip"]);
  assert.deepEqual(shipToMissing({ recipient_name: "A", address_line1: "1 Main", city: "Lehi", state: "UT", zip: "84043" }), []);
  assert.deepEqual(shipToMissing({ recipient_name: " ", address_line1: "1 Main", city: "Lehi", state: "UT" }), ["recipient_name", "zip"]);
});
