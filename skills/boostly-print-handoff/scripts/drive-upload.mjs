#!/usr/bin/env node
// Copy logos into print-handoff/logos/, ensure the master Drive folder (once), the Boostly logos folder,
// the location folder, upload the six PDFs + logos/ (md5 skip/update), and upsert the summary sheet row.
// Usage: node drive-upload.mjs --run-dir <dir> [--offline] [--skip-summary]
import fs from "node:fs";
import path from "node:path";
import { parseArgs, requireRunDir, readRun, handoffDir, readHandoff, writeHandoff, requestFacts, folderNameFor, shipLines, KINDS, MASTER_REF, REFERENCES, sha256File, log } from "./lib/common.mjs";
import { ensureFolder, findChild, getFile, listChildren, uploadDir, copyFile, shareAnyoneReader, folderLink, upsertSummarySheet, SHEET_MIME, FOLDER_MIME } from "./lib/drive.mjs";

export const MASTER_NAME = "Boostly print orders (customstickers.com)";
export const LOGOS_NAME = "Boostly logos (roll binding stickers)";
export const LOGOS_SOURCE_FOLDER = "1YXmKPvzzCDCcH1uVdqe4pNMOgElpt57w"; // one-off batch's logo folder, copied once
export const SUMMARY_NAME = "Print order summary";
export const SUMMARY_HEADER = ["Location", "Drive folder", "Offer", "Tables (promo + review sticker per table)", "Bathroom stalls (promo + review strip per stall)", "To-go label rolls", "POP sign sets", "Ship to name", "Address line 1", "Address line 2", "City", "State", "Zip"];

const args = parseArgs(process.argv.slice(2));
const runDir = requireRunDir(args);
const run = readRun(runDir);
const out = handoffDir(runDir);
const h = readHandoff(runDir);

// 1. Logos: card/sign logo (write.logo_file) and sticker logo (write.sticker_logo_file, with the finish agent's fallbacks).
const w = run.write || {};
const logosDir = path.join(out, "logos");
fs.mkdirSync(logosDir, { recursive: true });
const logos = [];
const card = w.logo_file;
if (card && fs.existsSync(path.join(runDir, card))) logos.push(["card-sign-logo" + path.extname(card), card]);
let st = w.sticker_logo_file || (w.secondary_logo && w.secondary_logo.file) || null;
if (!st && fs.existsSync(path.join(runDir, "fix/sticker-logo-color.png"))) st = "fix/sticker-logo-color.png";
if (st && st !== card && fs.existsSync(path.join(runDir, st))) logos.push(["sticker-logo" + path.extname(st), st]);
h.logos = {};
for (const [name, src] of logos) { const dst = path.join(logosDir, name); fs.copyFileSync(path.join(runDir, src), dst); h.logos[name] = { source: src, sha256: sha256File(dst) }; }
if (!logos.length) log("WARNING no logo files found in run.json write block");

// 2. Master folder, created once and pinned in references/drive-master.json.
fs.mkdirSync(REFERENCES, { recursive: true });
let master = fs.existsSync(MASTER_REF) ? JSON.parse(fs.readFileSync(MASTER_REF, "utf8")) : {};
if (master.master_folder_id) {
  const m = await getFile(master.master_folder_id, "id,name,trashed");
  if (m.trashed) throw new Error(`master folder ${master.master_folder_id} is trashed; fix references/drive-master.json by hand`);
} else {
  const f = await ensureFolder("root", MASTER_NAME);
  master = { master_folder_id: f.id, master_link: folderLink(f.id), master_name: MASTER_NAME, created_at: new Date().toISOString() };
  log("master folder", f.action, f.id);
}
const share = await shareAnyoneReader(master.master_folder_id);
master.shared_anyone_reader = true;
log("master share", share.action);

// 3. Boostly logos folder: copy the six vendor-facing Boostly logo files once.
if (!master.logos_folder_id) {
  const lf = await ensureFolder(master.master_folder_id, LOGOS_NAME);
  master.logos_folder_id = lf.id; master.logos_link = folderLink(lf.id);
}
{
  const have = new Set((await listChildren(master.logos_folder_id)).map((f) => f.name));
  const src = await listChildren(LOGOS_SOURCE_FOLDER);
  let copied = 0;
  for (const f of src.filter((x) => x.mimeType !== FOLDER_MIME && !have.has(x.name))) { await copyFile(f.id, master.logos_folder_id, f.name); copied++; }
  master.logos_files = (await listChildren(master.logos_folder_id)).map((f) => f.name).sort();
  log("logos folder", master.logos_folder_id, "copied", copied, "total", master.logos_files.length);
}
fs.writeFileSync(MASTER_REF, JSON.stringify(master, null, 2) + "\n");

// 4. Location folder: six PDFs + logos/.
const facts = requestFacts(run, args);
const folderName = folderNameFor(facts);
const folder = await ensureFolder(master.master_folder_id, folderName);
const files = {};
// Only the kinds export-sheets.mjs found frames for are required (a zero-table location has no table or review sheets).
const present = Object.keys(h.sheets || {});
if (!present.length) throw new Error(`handoff.json has no sheets block in ${out} (run export-sheets.mjs first)`);
const missing = present.map((k) => `${k}.pdf`).filter((f) => !fs.existsSync(path.join(out, f)));
if (missing.length) throw new Error(`missing PDFs in ${out}: ${missing.join(", ")} (rerun export-sheets.mjs)`);
const notIncluded = KINDS.map((k) => k.kind).filter((k) => !present.includes(k));
if (notIncluded.length) log("kinds not in this section (not uploaded):", notIncluded.join(", "));
for (const r of await uploadDir(folder.id, out, (f) => f.endsWith(".pdf"))) { files[r.name] = { id: r.id, md5: r.md5Checksum, action: r.action }; log(r.action, r.name); }
if (logos.length) {
  const lf = await ensureFolder(folder.id, "logos");
  for (const r of await uploadDir(lf.id, logosDir)) { files[`logos/${r.name}`] = { id: r.id, md5: r.md5Checksum, action: r.action }; log(r.action, "logos/" + r.name); }
}
// Nothing else may sit in the vendor's folder: report strays, never delete.
const strays = (await listChildren(folder.id)).filter((f) => !(f.name in files) && f.name !== "logos").map((f) => f.name);
if (strays.length) log("WARNING stray files in location folder:", strays.join(", "));

// 5. Update only this summary row. RAW preserves postal strings and numeric counts.
let summary = { status: "skipped" };
if (!args["skip-summary"]) {
  const existing = await findChild(master.master_folder_id, SUMMARY_NAME, SHEET_MIME);
  const s = facts.shipping || {};
  const q = facts.quantities || {};
  const row = [facts.location_name, folderName, facts.offer_text || "", q.tables ?? "", q.bathroom_stalls ?? "", q.to_go_rolls ?? "", q.signage ?? "", s.recipient_name || "", s.address_line1 || "", s.address_line2 || "", s.city || "", s.state || "", s.zip || ""];
  const up = await upsertSummarySheet(master.master_folder_id, SUMMARY_NAME, SUMMARY_HEADER, row, existing?.id);
  summary = { id: up.id, link: up.webViewLink, row_action: up.row_action, rows: up.rows };
  master.summary_sheet_id = up.id; master.summary_link = up.webViewLink;
  fs.writeFileSync(MASTER_REF, JSON.stringify(master, null, 2) + "\n");
  log("summary sheet", summary.row_action, up.webViewLink);
}

h.request_id = facts.request_id; h.location_name = facts.location_name;
h.facts = { offer_text: facts.offer_text, quantities: { tap_cards: facts.quantities?.tap_cards, tables: facts.quantities?.tables, bathroom_stalls: facts.quantities?.bathroom_stalls, to_go_rolls: facts.quantities?.to_go_rolls, signage: facts.quantities?.signage }, ship_to: shipLines(facts.shipping || {}), ship_to_complete: !!facts.shipping?.complete, source: facts.source };
h.drive = { not_included_kinds: notIncluded, master_folder_id: master.master_folder_id, master_link: master.master_link, logos_folder_id: master.logos_folder_id, logos_link: master.logos_link, folder_name: folderName, folder_id: folder.id, folder_link: folderLink(folder.id), files, summary, uploaded_at: new Date().toISOString() };
writeHandoff(runDir, h);
log(JSON.stringify({ folder: folderLink(folder.id), files: Object.keys(files).length, summary: summary.row_action || summary.status }));
