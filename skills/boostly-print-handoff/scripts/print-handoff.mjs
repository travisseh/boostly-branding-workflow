#!/usr/bin/env node
// One command for the whole hand-off: export (vector PDFs), logos + Drive upload + summary row, Gmail draft.
// Usage: node print-handoff.mjs --run-dir <dir> [--live] [--figma [--section <id[,id]>] [--file-key <key>]] [--offline|--dry-run|--scratch] [--redraft] [--skip-export] [--skip-draft] [--no-send] [--force] [--kinds <kind[,kind]>]
// DEFAULT since 2026-10-15 ("flip it", Travisse, after the parity proof): the PDFs are rendered by export-direct.mjs
// (boostly-signage-sheets/scripts/direct-pdf, no Figma). --figma exports the run's Figma section with export-sheets.mjs
// instead (the fallback, and the right choice for a run whose approved signage IS a Figma section). --direct is accepted
// as a no-op for older prompts.
// SAFETY (2026-10-15, after a scratch --direct run overwrote the Scoops vendor PDFs in Drive for ~30 s):
//   * --offline, --dry-run or --scratch means NO Drive upload, NO summary row, NO email: the run stops after the export.
//     (drive-upload.mjs's own --offline only swaps live v2-db facts for run.json ones; it is never reached from here.)
//   * --direct touches Drive and email only with an explicit --live; without it the direct render stops after the export.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, requireRunDir, readHandoff } from "./lib/common.mjs";

export const DRY_FLAGS = ["offline", "dry-run", "scratch"];

// Pure: which scripts run, with their flags, and why the others are skipped.
export function planSteps(args) {
  const pass = (keys) => keys.flatMap((k) => (args[k] === undefined ? [] : args[k] === true ? [`--${k}`] : [`--${k}`, String(args[k])]));
  const dry = DRY_FLAGS.filter((k) => args[k]);
  const steps = [];
  const skipped = [];
  const direct = !args.figma;
  if (!args["skip-export"]) {
    if (direct) steps.push({ script: "export-direct.mjs", extra: pass(["kinds", "tables", "stalls", "offer", "band", "logo", "pop-primary-logo", "date", "force", "offline"]) });
    else steps.push({ script: "export-sheets.mjs", extra: pass(["section", "file-key", "force", "kinds"]) });
  }
  let stopReason = null;
  if (dry.length) stopReason = `${dry.map((k) => `--${k}`).join(" ")}: no Drive upload, no summary row, no email (export only)`;
  else if (!args.live) stopReason = "no --live: the hand-off stops after the export; pass --live to upload to the vendor folder and email";
  if (stopReason) {
    skipped.push({ script: "drive-upload.mjs", reason: stopReason });
    skipped.push({ script: "draft-email.mjs", reason: stopReason });
    return { steps, skipped, dry: dry.length > 0, stopReason, direct };
  }
  steps.push({ script: "drive-upload.mjs", extra: pass(["skip-summary"]) });
  if (!args["skip-draft"]) steps.push({ script: "draft-email.mjs", extra: pass(["redraft", "no-send"]), exit3: "blocked on ship-to" });
  else skipped.push({ script: "draft-email.mjs", reason: "--skip-draft" });
  return { steps, skipped, dry: false, stopReason: null, direct };
}

export function main(argv = process.argv.slice(2)) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const args = parseArgs(argv);
  const runDir = requireRunDir(args);
  const plan = planSteps(args);
  let blocked = null;
  for (const s of plan.steps) {
    console.log(`\n== ${s.script} ==`);
    try { execFileSync("node", [path.join(here, s.script), "--run-dir", runDir, ...s.extra], { stdio: "inherit" }); }
    catch (e) { if (s.exit3 && e.status === 3) { blocked = s.exit3; break; } throw e; }
  }
  for (const s of plan.skipped) console.log(`\n== ${s.script} skipped: ${s.reason} ==`);
  const h = readHandoff(runDir);
  console.log("\n== hand-off ==");
  console.log(JSON.stringify({
    location: h.location_name,
    source: h.source || (plan.direct ? "direct" : "figma"),
    stopped_after_export: plan.stopReason,
    blocked_on: blocked ? { what: h.draft?.blocked_on || blocked, missing: h.draft?.missing || [] } : null,
    offer_changed: h.direct?.offer_changed || null,
    note: h.direct?.note || null,
    folder: h.drive?.folder_link,
    master: h.drive?.master_link,
    summary: h.drive?.summary?.link,
    pages: Object.fromEntries(Object.entries(h.sheets || {}).map(([k, v]) => [k, `${v.pages}/${v.expected_pages}${v.vector ? " vector" : " NOT VECTOR"}`])),
    draft_id: h.draft?.id || null,
    email_sent: !!h.draft?.sent,
    message_id: h.draft?.message_id || null,
    order_placed: h.draft?.order_placed?.date || null,
  }, null, 2));
  if (blocked) process.exitCode = 3;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main();
