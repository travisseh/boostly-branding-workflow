#!/usr/bin/env node
// Outline the text in an existing print hand-off (2026-10-22): converts every <RUN_DIR>/print-handoff/<kind>.pdf
// that still carries an embedded font to outlined paths (Ghostscript, see boostly-signage-sheets direct-pdf/lib/outline.mjs),
// records text/outline/md5/bytes/fonts in handoff.json sheets[kind], and with --upload updates the same Drive files in
// place (same file ids and links; md5 is checked after upload). Files already outlined are skipped.
// Usage: node outline-handoff.mjs --run-dir <dir> [--upload] [--dry]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, requireRunDir, readHandoff, writeHandoff, handoffDir, md5File, log } from "./lib/common.mjs";
import { outlinePdf } from "../../boostly-signage-sheets/scripts/direct-pdf/lib/outline.mjs";

const args = parseArgs(process.argv.slice(2));
const runDir = requireRunDir(args);
const out = handoffDir(runDir);
const h = readHandoff(runDir);
if (!h.sheets || !Object.keys(h.sheets).length) throw new Error(`no sheets block in ${out}/handoff.json`);
const fontCount = (p) => { try { return execFileSync("pdffonts", [p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").slice(2).filter(Boolean).length; } catch { return null; } };
const results = {};
for (const [kind, rec] of Object.entries(h.sheets)) {
  const file = path.join(out, rec.file || `${kind}.pdf`);
  if (!fs.existsSync(file)) { results[kind] = { skipped: "missing file" }; log(kind, "missing", file); continue; }
  const fonts = fontCount(file);
  if (fonts === 0) { results[kind] = { skipped: "already outlined" }; rec.text = rec.text || "outlined"; log(kind, "already outlined"); continue; }
  if (args.dry) { results[kind] = { would_outline: true, fonts }; log(kind, "would outline", `${fonts} fonts`); continue; }
  const r = outlinePdf(file);
  if (!r.outlined) { results[kind] = { failed: r.reason }; log("WARNING", kind, "not outlined:", r.reason); continue; }
  Object.assign(rec, { fonts: 0, font_list: [], fonts_embedded_before_outline: fonts, text: "outlined", outline: r, md5: md5File(file), bytes: fs.statSync(file).size, vector: rec.full_page_images ? false : true });
  results[kind] = { outlined: true, fonts_before: fonts, bytes: rec.bytes };
  log(kind, "outlined", `${fonts} fonts -> 0`, rec.bytes, "bytes");
}
let uploaded = null;
if (args.upload && !args.dry) {
  const { uploadFile, listChildren } = await import("./lib/drive.mjs");
  const folderId = h.drive?.folder_id;
  if (!folderId) throw new Error("handoff.json has no drive.folder_id; run drive-upload.mjs first");
  const byName = Object.fromEntries((await listChildren(folderId)).map((f) => [f.name, f]));
  uploaded = {};
  for (const [kind, rec] of Object.entries(h.sheets)) {
    if (!results[kind]?.outlined) continue;
    const name = rec.file || `${kind}.pdf`;
    const r = await uploadFile(folderId, path.join(out, name), name, byName[name] || null);
    uploaded[name] = r.action;
    h.drive.files = h.drive.files || {};
    h.drive.files[name] = { id: r.id, md5: r.md5Checksum, action: r.action };
    log(r.action, name, r.id);
  }
  h.drive.outlined_at = new Date().toISOString();
}
if (!args.dry) { h.outline = { at: new Date().toISOString(), results, uploaded }; writeHandoff(runDir, h); }
console.log(JSON.stringify({ run_dir: runDir, results, uploaded }, null, 2));
