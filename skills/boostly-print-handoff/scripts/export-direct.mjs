#!/usr/bin/env node
// Direct-render alternative to export-sheets.mjs: build the six print PDFs straight from the
// run's signage/plan.json with boostly-signage-sheets/scripts/direct-pdf (no Figma, no network),
// into <RUN_DIR>/print-handoff/ with the same file names, sheets.json and handoff.json blocks the
// Figma export writes, so drive-upload.mjs and draft-email.mjs run unchanged after it.
// Status 2026-10-15: parity-proven on approved runs (direct-pdf/parity.mjs), NOT the default;
// print-handoff.mjs --direct selects it. Same flags as direct-pdf.mjs for the build inputs:
// Usage: node export-direct.mjs --run-dir <dir> [--kinds <kind[,kind]>] [--tables N] [--stalls N]
//   [--offer "<text>"] [--band #RRGGBB] [--logo <png>] [--pop-primary-logo <png>] [--date YYYY-MM-DD]
import path from "node:path";
import { parseArgs, requireRunDir, readRun, handoffDir, readHandoff, writeHandoff, log } from "./lib/common.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const directPdf = path.resolve(here, "..", "..", "boostly-signage-sheets", "scripts", "direct-pdf", "direct-pdf.mjs");
const { renderRun } = await import(directPdf);

const args = parseArgs(process.argv.slice(2));
const runDir = requireRunDir(args);
const run = readRun(runDir);
const out = handoffDir(runDir);
// Never replace a Figma export the vendor may already hold: drive-upload.mjs updates Drive files in
// place, so a direct render on top of an existing hand-off would overwrite what was emailed.
const existing = readHandoff(runDir);
if (existing.sheets && existing.source !== "direct" && !args.force) {
  throw new Error(`${runDir}/print-handoff already holds a Figma export (exported ${existing.exported_at}); refusing to overwrite it. Pass --force only if that hand-off is to be replaced.`);
}
const summary = await renderRun(runDir, { ...args, out });
const h = readHandoff(runDir);
h.request_id = run.request?.request_id; h.location_name = run.request?.location_name;
h.source = "direct";
h.direct = { generator: summary.generator, status: summary.status, inputs: summary.inputs, build: { recopy: summary.build.recopy, trim: summary.build.trim, togo: summary.build.togo, strokeGateFixed: summary.build.strokeGateFixed, qr: summary.build.qr, logos: summary.build.logos }, frames: summary.frames.length };
h.figma = run.figma?.section_node_id ? { file_key: run.figma.file_key, sections: [run.figma.section_node_id], frames: summary.frames.length, crosscheck: "not exported (direct render)" } : { crosscheck: "no Figma section (direct render)" };
h.sheets = summary.sheets; h.exported_at = summary.generated_at;
writeHandoff(runDir, h);
log(JSON.stringify({ source: "direct", frames: summary.frames.length, kinds: Object.keys(summary.sheets).length, all_ok: summary.all_ok }));
if (!summary.all_ok) process.exit(2);
