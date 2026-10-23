#!/usr/bin/env node
// Direct-render alternative to export-sheets.mjs: build the six print PDFs straight from the
// run's signage/plan.json with boostly-signage-sheets/scripts/direct-pdf (no Figma, no network),
// into <RUN_DIR>/print-handoff/ with the same file names, sheets.json and handoff.json blocks the
// Figma export writes, so drive-upload.mjs and draft-email.mjs run unchanged after it.
// Status 2026-10-15: parity-proven on approved runs (direct-pdf/parity.mjs), NOT the default;
// print-handoff.mjs --direct selects it. Same flags as direct-pdf.mjs for the build inputs:
// Usage: node export-direct.mjs --run-dir <dir> [--kinds <kind[,kind]>] [--tables N] [--stalls N]
//   [--offer "<text>"] [--band #RRGGBB] [--logo <png>] [--pop-primary-logo <png>] [--date YYYY-MM-DD] [--offline]
// LIVE OFFER: the finish re-reads fulfillment_requests.offer_text and the SUBSCRIBE promotion title; when the live
// offer differs from the recorded (approved) one the live offer wins, recopy.offer_changed {from, to} is logged in
// handoff.json and the review-sheets.png preview is regenerated so the change is visible. --offline skips the read.
import path from "node:path";
import { parseArgs, requireRunDir, readRun, handoffDir, readHandoff, writeHandoff, log, liveOffer, livePromotionTitle, offerChange, offerPlaceholder } from "./lib/common.mjs";

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
// A direct build recorded earlier (the closeout renders into print-handoff/ for Travisse's review) fixes the
// inputs: the finish rerun reuses its logos, counts, offer, band and date unless the caller overrides them,
// so the vendor gets exactly the sheets that were approved.
const recorded = existing.source === "direct" && existing.direct?.inputs ? existing.direct.inputs : null;
const merged = { ...args };
if (recorded) {
  const map = { logo: recorded.logos?.sticker, "pop-primary-logo": recorded.logos?.popPrimary, "header-logo": recorded.logos?.header, tables: recorded.tables, stalls: recorded.stalls, offer: recorded.offer, band: recorded.band, date: recorded.date, name: recorded.name, status: recorded.status, mode: recorded.mode };
  for (const [k, v] of Object.entries(map)) if (merged[k] === undefined && v !== undefined && v !== null) merged[k] = v;
  log("reusing the recorded direct-build inputs from handoff.json (" + (existing.exported_at || "earlier") + ")");
}
// Re-read the live offer (and what the SUBSCRIBE keyword pays) unless --offline or an explicit --offer.
let offerChanged = null, promotion = null;
if (!args.offline && args.offer === undefined && run.request?.request_id) {
  const live = liveOffer(run.request.request_id);
  try { promotion = livePromotionTitle(run.request.location_id); } catch (e) { promotion = null; log(`promotion read skipped: ${e.message}`); }
  const baseline = merged.offer !== undefined ? merged.offer : (run.request.offer_text || "");
  // a placeholder on the request ("TBD") never replaces the approved copy; it is logged and the approved copy stays
  const livePh = offerPlaceholder(live?.offer_text);
  offerChanged = livePh ? null : offerChange(baseline, live?.offer_text ?? null);
  if (livePh) log(JSON.stringify({ "recopy.offer_placeholder": { live: live?.offer_text ?? "", kept: baseline } }));
  if (offerChanged) {
    merged.offer = offerChanged.to;
    delete merged["no-preview"];
    log(JSON.stringify({ "recopy.offer_changed": offerChanged, promotion }));
  }
}
// Nothing renders from a placeholder: the agreed sign copy comes from --offer or a real offer_text on the request.
{
  const finalOffer = merged.offer !== undefined ? merged.offer : (run.request?.offer_text || "");
  const ph = offerPlaceholder(finalOffer);
  if (ph) {
    log(JSON.stringify({ blocked_on: "offer", offer: finalOffer, hint: "offer text is a placeholder; pass --offer \"<agreed sign copy>\" (confirm it on the call or with the CSM) or set offer_text on the request" }));
    process.exit(3);
  }
}
const summary = await renderRun(runDir, { ...merged, out });
const h = readHandoff(runDir);
h.request_id = run.request?.request_id; h.location_name = run.request?.location_name;
h.source = "direct";
h.direct = { generator: summary.generator, status: summary.status, inputs: summary.inputs, build: { recopy: summary.build.recopy, trim: summary.build.trim, togo: summary.build.togo, strokeGateFixed: summary.build.strokeGateFixed, qr: summary.build.qr, logos: summary.build.logos, logoPanel: summary.build.logoPanel }, frames: summary.frames.length, note: summary.note, absent_kinds: summary.absent_kinds, offer_changed: offerChanged ? { ...offerChanged, promotion, at: summary.generated_at } : null };
h.figma = run.figma?.section_node_id ? { file_key: run.figma.file_key, sections: [run.figma.section_node_id], frames: summary.frames.length, crosscheck: "not exported (direct render)" } : { crosscheck: "no Figma section (direct render)" };
h.sheets = summary.sheets; h.exported_at = summary.generated_at;
writeHandoff(runDir, h);
log(JSON.stringify({ source: "direct", frames: summary.frames.length, kinds: Object.keys(summary.sheets).length, all_ok: summary.all_ok, note: summary.note, offer_changed: offerChanged, preview: summary.preview?.file || null }));
if (!summary.all_ok) process.exit(2);
