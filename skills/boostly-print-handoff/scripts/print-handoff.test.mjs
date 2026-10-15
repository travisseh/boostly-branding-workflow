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
    // --offline is never forwarded to drive-upload.mjs (its own --offline only swaps data sources)
    assert.ok(!p.steps.some((s) => s.extra.includes("--offline")));
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
