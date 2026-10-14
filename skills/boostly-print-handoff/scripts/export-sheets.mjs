#!/usr/bin/env node
// Export every "Print Sheet - " frame in a location's Figma section(s) as VECTOR PDF through the
// Figma REST API, merge per kind with pdfunite, verify page counts and that the output is vector.
// Usage: node export-sheets.mjs --run-dir <dir> [--section <id[,id]>] [--file-key <key>] [--force] [--kinds <kind[,kind]>]
// --kinds (2026-10-14, ad hoc orders): export only the listed kinds (table-stickers, review-stickers,
// bathroom-stickers, bathroom-review-stickers, pop-sign, togo-label); the others read "not included".
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, requireRunDir, readRun, handoffDir, readHandoff, writeHandoff, figmaToken, figmaTarget, KINDS, md5File, log } from "./lib/common.mjs";

const args = parseArgs(process.argv.slice(2));
const runDir = requireRunDir(args);
const run = readRun(runDir);
const { fileKey, sections } = figmaTarget(run, args);
const TOKEN = figmaToken();
const out = handoffDir(runDir);
const tmp = path.join(out, "_vector-pages");
fs.mkdirSync(tmp, { recursive: true });

async function figma(url, attempt = 0) {
  const res = await fetch(url, { headers: { "X-Figma-Token": TOKEN } });
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    const w = Number(res.headers.get("retry-after") || 15);
    await new Promise((r) => setTimeout(r, w * 1000));
    return figma(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`figma ${res.status} ${url.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.err) throw new Error(`figma err: ${j.err}`);
  return j;
}

// Classify a "Print Sheet - ..." frame name into a kind and page number.
export function classify(name) {
  const n = name.replace(/^Print Sheet\s*-\s*/i, "");
  const page = Number((n.match(/Page\s+(\d+)/i) || [])[1] || 0);
  if (/Bathroom Review Stickers/i.test(n)) return { kind: "bathroom-review-stickers", page: page || 1 };
  if (/Bathroom Stickers/i.test(n)) return { kind: "bathroom-stickers", page: page || 1 };
  if (/Review Stickers/i.test(n)) return { kind: "review-stickers", page: page || 1 };
  if (/Table Stickers/i.test(n)) return { kind: "table-stickers", page: page || 1 };
  if (/POP Sign/i.test(n)) return { kind: "pop-sign", page: /Light/i.test(n) ? 2 : 1 };
  if (/To-?Go Label/i.test(n)) return { kind: "togo-label", page: /review/i.test(n) ? 2 : 1 };
  return null;
}

// Discovery: the file nodes endpoint for each section, collecting top-most "Print Sheet - " frames.
function collect(node, acc) {
  if (/^Print Sheet\s*-/i.test(node.name || "")) { acc.push(node); return; }
  for (const c of node.children || []) collect(c, acc);
}
const frames = [];
const rawFrames = {};
for (const [si, sec] of sections.entries()) {
  const j = await figma(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(sec)}&depth=2`);
  const doc = j.nodes?.[sec]?.document;
  if (!doc) throw new Error(`section ${sec} not found in file ${fileKey}`);
  const acc = [];
  collect(doc, acc);
  rawFrames[sec] = { section_name: doc.name, frames: acc.map((n) => `${n.id}|${n.name}`) };
  for (const n of acc) {
    const c = classify(n.name);
    if (!c) { log("skip unclassified frame", n.id, n.name); continue; }
    const bb = n.absoluteBoundingBox || {};
    frames.push({ node_id: n.id, section: sec, section_index: si, name: n.name, kind: c.kind, page: c.page, w: Math.round(bb.width || 0), h: Math.round(bb.height || 0) });
  }
}
if (!frames.length) throw new Error("no Print Sheet frames found");
// --kinds: keep only the ordered kinds (an ad hoc order of POP signs exports the POP sheet alone).
const keepKinds = args.kinds ? String(args.kinds).split(",").map((k) => k.trim()).filter(Boolean) : null;
if (keepKinds) {
  const known = new Set(KINDS.map((k) => k.kind));
  const bad = keepKinds.filter((k) => !known.has(k));
  if (bad.length) throw new Error(`unknown --kinds ${bad.join(", ")} (known: ${[...known].join(", ")})`);
  const before = frames.length;
  for (let i = frames.length - 1; i >= 0; i -= 1) if (!keepKinds.includes(frames[i].kind)) frames.splice(i, 1);
  log("kinds filter", keepKinds.join(","), `${frames.length}/${before} frames kept`);
  if (!frames.length) throw new Error(`no Print Sheet frames of kind ${keepKinds.join(",")} in the section`);
}
// Order: per kind, section order then page; renumber pages across sections.
for (const { kind } of KINDS) {
  const fk = frames.filter((f) => f.kind === kind).sort((a, b) => a.section_index - b.section_index || a.page - b.page);
  fk.forEach((f, i) => { f.page = i + 1; f.file = `${kind}-page-${String(i + 1).padStart(2, "0")}.pdf`; });
}
fs.writeFileSync(path.join(out, "raw-frames.json"), JSON.stringify({ file_key: fileKey, sections: rawFrames }, null, 2));

// Cross-check against run.json figma.sheet_ids when present (warn, never silently diverge).
const crosscheck = { status: "no sheet_ids in run.json" };
if (run.figma?.sheet_ids) {
  const expectedEntries = Object.entries(run.figma.sheet_ids).filter(([name]) => !keepKinds || keepKinds.includes(classify(name)?.kind));
  const expected = new Set(expectedEntries.map(([, ids]) => ids).flat());
  const found = new Set(frames.map((f) => f.node_id));
  const missing = [...expected].filter((x) => !found.has(x));
  const extra = [...found].filter((x) => !expected.has(x));
  crosscheck.status = !missing.length && !extra.length ? "match" : "MISMATCH";
  crosscheck.missing_from_figma = missing; crosscheck.not_in_run_json = extra;
  if (crosscheck.status !== "match") log("WARNING sheet_ids crosscheck:", JSON.stringify(crosscheck));
}

// Export: vector PDF per frame via /v1/images?format=pdf (chunks of 50).
const pages = (p) => { try { return Number(execFileSync("pdfinfo", [p]).toString().match(/Pages:\s+(\d+)/)[1]); } catch { return 0; } };
const todo = frames.filter((f) => args.force || !(fs.existsSync(path.join(tmp, f.file)) && pages(path.join(tmp, f.file)) === 1));
for (let i = 0; i < todo.length; i += 50) {
  const chunk = todo.slice(i, i + 50);
  const { images } = await figma(`https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(chunk.map((f) => f.node_id).join(","))}&format=pdf`);
  for (const f of chunk) {
    const url = images[f.node_id];
    if (!url) throw new Error(`no export url for ${f.node_id} ${f.name}`);
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    if (buf.subarray(0, 4).toString() !== "%PDF") throw new Error(`${f.name}: not a PDF`);
    const p = path.join(tmp, f.file);
    fs.writeFileSync(p, buf);
    if (pages(p) !== 1) throw new Error(`${f.name}: expected 1 page`);
    log("exported", f.file, buf.length, "bytes", f.node_id);
  }
}

// Merge per kind and verify: page count, embedded fonts (vector text), image count.
function fontsCount(p) { const t = execFileSync("pdffonts", [p]).toString().trim().split("\n"); return Math.max(0, t.length - 2); }
function imagesList(p) {
  const t = execFileSync("pdfimages", ["-list", p]).toString().trim().split("\n").slice(2).filter(Boolean);
  return t.map((l) => { const c = l.trim().split(/\s+/); return { page: Number(c[0]), type: c[2], w: Number(c[3]), h: Number(c[4]) }; });
}
function pageSizePx(p) { const m = execFileSync("pdfinfo", [p]).toString().match(/Page size:\s+([\d.]+) x ([\d.]+)/); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; }
const prevFile = path.join(out, "sheets.json");
const prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, "utf8")).sheets || {} : {};
const sheets = {};
let allOk = true;
for (const { kind } of KINDS) {
  const fk = frames.filter((f) => f.kind === kind).sort((a, b) => a.page - b.page);
  if (!fk.length) continue;
  const parts = fk.map((f) => path.join(tmp, f.file));
  const dst = path.join(out, `${kind}.pdf`);
  // pdfunite output is not byte-stable, so keep the existing merge when its page parts are unchanged (md5 skip on Drive).
  const partsMd5 = parts.map(md5File).join(",");
  if (!(prev[kind]?.parts_md5 === partsMd5 && fs.existsSync(dst) && pages(dst) === fk.length)) {
    if (parts.length === 1) fs.copyFileSync(parts[0], dst); else execFileSync("pdfunite", [...parts, dst]);
  }
  const n = pages(dst);
  const fonts = fontsCount(dst);
  const imgs = imagesList(dst);
  const [pw, ph] = pageSizePx(dst);
  // A rasterized export is one full-page image and no fonts. Vector = fonts embedded and no image spanning the page.
  const fullPage = imgs.filter((im) => im.w >= pw * 0.95 && im.h >= ph * 0.95);
  const vector = fonts > 0 && fullPage.length === 0;
  const ok = n === fk.length && vector;
  allOk = allOk && ok;
  sheets[kind] = { file: `${kind}.pdf`, pages: n, expected_pages: fk.length, node_ids: fk.map((f) => f.node_id), fonts, images: imgs.length, full_page_images: fullPage.length, vector, ok, parts_md5: partsMd5, md5: md5File(dst), bytes: fs.statSync(dst).size };
  log(ok ? "OK " : "BAD", kind, `${n}/${fk.length} pages`, `fonts ${fonts}`, `images ${imgs.length}`, vector ? "vector" : "NOT VECTOR");
}
fs.writeFileSync(path.join(out, "sheets.json"), JSON.stringify({ file_key: fileKey, sections, frames, crosscheck, sheets, exported_at: new Date().toISOString() }, null, 2));
const h = readHandoff(runDir);
h.request_id = run.request?.request_id; h.location_name = run.request?.location_name;
h.figma = { file_key: fileKey, sections, frames: frames.length, crosscheck: crosscheck.status };
h.sheets = sheets; h.exported_at = new Date().toISOString();
writeHandoff(runDir, h);
log(JSON.stringify({ frames: frames.length, kinds: Object.keys(sheets).length, all_ok: allOk, crosscheck: crosscheck.status }));
if (!allOk) process.exit(2);
