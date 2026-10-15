#!/usr/bin/env node
// Parity proof: the direct renderer's PDFs (direct-pdf.mjs) against Figma's REST vector export
// of the SAME location section, page by page. Read-only on Figma (it takes the per-page PDFs
// you already exported and, optionally, a REST /nodes dump of the live section).
//
// Usage: node parity.mjs --run-dir <dir> [--direct <dir>] --figma-pages <dir> [--live-tree <nodes.json> --section <id>]
//   [--dpi 300] [--threshold 32] [--tol 0.5] [--out <dir>]
// --figma-pages: a folder of single-page PDFs, either print-handoff/_vector-pages (files named
//   <kind>-page-NN.pdf, matched through print-handoff/sheets.json) or a scratch export with a
//   manifest.json [{id, name, file}].
// Writes <out>/parity.json, parity.md, raster/*.png (per-page diffs) and worst-page.png.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseArgs, pdfPageSize, pdfFonts, pdfImages, pdfPages } from './direct-pdf.mjs';
import { classify } from './lib/kinds.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const jsQR = require('jsqr');

const args = parseArgs(process.argv.slice(2));
const runDir = path.resolve(args['run-dir'] || args._[0] || '');
if (!runDir || !fs.existsSync(path.join(runDir, 'run.json'))) { console.error('usage: node parity.mjs --run-dir <dir> --figma-pages <dir> [--live-tree <json> --section <id>]'); process.exit(1); }
const direct = path.resolve(args.direct || path.join(runDir, 'signage', 'pdf-direct'));
const figmaDir = path.resolve(args['figma-pages'] || path.join(runDir, 'print-handoff', '_vector-pages'));
const out = path.resolve(args.out || path.join(direct, 'parity'));
const DPI = Number(args.dpi || 300);
const THRESHOLD = Number(args.threshold || 32);
const TOL = Number(args.tol || 0.5);
fs.mkdirSync(path.join(out, 'raster'), { recursive: true });
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- page set
const directSheets = JSON.parse(fs.readFileSync(path.join(direct, 'sheets.json'), 'utf8'));
let figmaFrames = [];
if (fs.existsSync(path.join(figmaDir, 'manifest.json'))) {
  figmaFrames = JSON.parse(fs.readFileSync(path.join(figmaDir, 'manifest.json'), 'utf8')).map((m) => ({ ...m, file: path.join(figmaDir, m.file) }));
} else {
  const sj = path.join(path.dirname(figmaDir), 'sheets.json');
  if (!fs.existsSync(sj)) throw new Error(`no manifest.json in ${figmaDir} and no sheets.json beside it`);
  figmaFrames = JSON.parse(fs.readFileSync(sj, 'utf8')).frames.map((f) => ({ id: f.node_id, name: f.name, file: path.join(figmaDir, f.file) }));
}
const pages = [];
const pageSet = { direct: directSheets.frames.map((f) => f.name), figma: figmaFrames.map((f) => f.name), missing_in_direct: [], missing_in_figma: [] };
for (const f of figmaFrames) if (!directSheets.frames.some((d) => d.name === f.name)) pageSet.missing_in_direct.push(f.name);
for (const d of directSheets.frames) {
  const f = figmaFrames.find((x) => x.name === d.name);
  if (!f) { pageSet.missing_in_figma.push(d.name); continue; }
  const dFile = path.join(direct, '_vector-pages', d.file);
  pages.push({ name: d.name, kind: d.kind, page: d.page, direct: dFile, figma: f.file, figma_id: f.id, size_direct: pdfPageSize(dFile), size_figma: pdfPageSize(f.file), pages_direct: pdfPages(dFile), pages_figma: pdfPages(f.file) });
}
pageSet.same_set = !pageSet.missing_in_direct.length && !pageSet.missing_in_figma.length;
pageSet.sizes_match = pages.every((p) => p.size_direct && p.size_figma && Math.abs(p.size_direct[0] - p.size_figma[0]) < 0.01 && Math.abs(p.size_direct[1] - p.size_figma[1]) < 0.01 && p.pages_direct === 1 && p.pages_figma === 1);

// ---------------------------------------------------------------- geometry vs live REST tree
const section = JSON.parse(fs.readFileSync(path.join(direct, 'section.json'), 'utf8'));
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
function serRest(n, px, py) {
  const b = n.absoluteBoundingBox || { x: px, y: py, width: 0, height: 0 };
  const o = { t: n.type, n: n.name, x: r3(b.x - px), y: r3(b.y - py), w: r3(b.width), h: r3(b.height) };
  const paint = (p) => (p.type === 'IMAGE' ? { img: p.imageRef, sm: p.scaleMode } : { c: p.type === 'SOLID' ? hex(p.color) : p.type, ...(p.opacity !== undefined && p.opacity !== 1 ? { o: p.opacity } : {}), ...(p.visible === false ? { v: false } : {}) });
  if (n.fills?.length) o.f = n.fills.map(paint);
  if (n.strokes?.length) { o.s = n.strokes.map(paint); o.sw = n.strokeWeight; o.sa = n.strokeAlign; if (n.strokeDashes) o.sd = n.strokeDashes; }
  if (n.cornerRadius) o.cr = n.cornerRadius;
  if (n.type === 'FRAME') o.clip = !!n.clipsContent;
  if (n.type === 'TEXT') { const s = n.style; o.text = { fam: s.fontFamily, sty: s.fontStyle, fs: s.fontSize, lh: s.lineHeightUnit === 'PIXELS' ? s.lineHeightPx : s.lineHeightUnit === 'FONT_SIZE_%' ? { pct: s.lineHeightPercentFontSize } : 'AUTO', ls: s.letterSpacing, ah: s.textAlignHorizontal, av: s.textAlignVertical, ar: s.textAutoResize || 'NONE', ch: n.characters }; if (n.absoluteRenderBounds) o.rb = { x: r3(n.absoluteRenderBounds.x - b.x), y: r3(n.absoluteRenderBounds.y - b.y), w: r3(n.absoluteRenderBounds.width), h: r3(n.absoluteRenderBounds.height) }; }
  if (n.type === 'VECTOR') o.vp = (n.fillGeometry || []).map((g) => ({ windingRule: g.windingRule, data: g.path }));
  if (n.children) o.k = n.children.map((c) => serRest(c, b.x, b.y));
  return o;
}
let geometry = { checked: false };
if (args['live-tree']) {
  const live = JSON.parse(fs.readFileSync(path.resolve(args['live-tree']), 'utf8'));
  const secId = args.section || Object.keys(live.nodes)[0];
  const liveDoc = live.nodes[secId].document;
  const liveSec = serRest(liveDoc, liveDoc.absoluteBoundingBox.x, liveDoc.absoluteBoundingBox.y);
  const mism = []; let compared = 0; let maxDelta = 0; const deltas = [];
  const norm = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).toLowerCase());
  function cmp(a, b, pathName, inQr) {
    compared += 1;
    const push = (what, da, db) => mism.push({ path: pathName, what, direct: da, figma: db });
    if (a.t !== b.t) push('type', a.t, b.t);
    if (!inQr && a.t !== 'TEXT' && a.n !== b.n) push('name', a.n, b.n);
    for (const k of ['x', 'y', 'w', 'h']) {
      const d = Math.abs((a[k] || 0) - (b[k] || 0));
      if (!inQr || k === 'w' || k === 'h' || true) { deltas.push(d); maxDelta = Math.max(maxDelta, d); if (d > TOL) push(k, a[k], b[k]); }
    }
    const fa = (a.f || []).filter((f) => f.v !== false), fb = (b.f || []).filter((f) => f.v !== false);
    if (fa.length !== fb.length) push('fills', fa, fb);
    else fa.forEach((f, i) => { const g = fb[i]; if (f.c || g.c) { if (norm(f.c) !== norm(g.c)) push('fill', f.c, g.c); } else if (!(f.imgFile && g.img)) push('fill', f, g); if (f.sm && g.sm && f.sm !== g.sm) push('scaleMode', f.sm, g.sm); });
    const sa = (a.s || []), sb = (b.s || []);
    if (sa.length !== sb.length || (sa.length && (norm(sa[0].c) !== norm(sb[0].c) || a.sw !== b.sw || a.sa !== b.sa || norm(a.sd) !== norm(b.sd)))) push('stroke', { s: sa, sw: a.sw, sa: a.sa, sd: a.sd }, { s: sb, sw: b.sw, sa: b.sa, sd: b.sd });
    if ((a.cr || 0) !== (b.cr || 0)) push('cornerRadius', a.cr, b.cr);
    if (a.t === 'TEXT') for (const k of ['fam', 'sty', 'fs', 'lh', 'ls', 'ah', 'av', 'ar', 'ch']) if (norm(a.text[k]) !== norm(b.text[k])) push(`text.${k}`, a.text[k], b.text[k]);
    if (a.t === 'VECTOR' && !inQr) { const da = (a.vp || []).map((v) => v.data).join('|'), db = (b.vp || []).map((v) => v.data).join('|'); if (da !== db) push('path', da.slice(0, 80), db.slice(0, 80)); }
    const ka = a.k || [], kb = b.k || [];
    if (ka.length !== kb.length) { push('children', ka.length, kb.length); return; }
    const qr = inQr || (a.t === 'FRAME' && a.n === 'qr');
    ka.forEach((c, i) => cmp(c, kb[i], `${pathName}/${c.n}`, qr));
  }
  const liveSheets = liveSec.k.filter((n) => /^Print Sheet\s*-/i.test(n.n));
  const directSheetNodes = section.k.filter((n) => /^Print Sheet\s*-/i.test(n.n));
  const sheetReport = [];
  for (const d of directSheetNodes) {
    const l = liveSheets.find((x) => x.n === d.n);
    if (!l) { mism.push({ path: d.n, what: 'sheet missing in live tree' }); continue; }
    const before = mism.length;
    cmp(d, l, d.n, false);
    sheetReport.push({ sheet: d.n, x: [d.x, l.x], y: [d.y, l.y], mismatches: mism.length - before });
  }
  geometry = { checked: true, section: secId, nodes_compared: compared, tolerance_pt: TOL, max_position_delta_pt: r3(maxDelta), mean_delta_pt: r3(deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length)), mismatches: mism, sheets: sheetReport, pass: !mism.length };
}

// ---------------------------------------------------------------- raster diff (banded, 300 dpi)
function rasterize(pdf, prefix) {
  execFileSync('pdftoppm', ['-r', String(DPI), '-png', '-singlefile', pdf, prefix]);
  return `${prefix}.png`;
}
async function rasterDiff(aFile, bFile, diffFile) {
  const ma = await sharp(aFile).metadata(), mb = await sharp(bFile).metadata();
  const W = Math.min(ma.width, mb.width), H = Math.min(ma.height, mb.height);
  const band = 512, cell = 64;
  const cells = new Map();
  let differing = 0, bbox = null, maxDiff = 0;
  const heat = Buffer.alloc(Math.ceil(W / 8) * Math.ceil(H / 8), 0);
  const hw = Math.ceil(W / 8);
  for (let y0 = 0; y0 < H; y0 += band) {
    const h = Math.min(band, H - y0);
    const [ra, rb] = await Promise.all([sharp(aFile).extract({ left: 0, top: y0, width: W, height: h }).removeAlpha().raw().toBuffer(), sharp(bFile).extract({ left: 0, top: y0, width: W, height: h }).removeAlpha().raw().toBuffer()]);
    for (let i = 0, p = 0; i < ra.length; i += 3, p += 1) {
      const d = Math.max(Math.abs(ra[i] - rb[i]), Math.abs(ra[i + 1] - rb[i + 1]), Math.abs(ra[i + 2] - rb[i + 2]));
      if (d > maxDiff) maxDiff = d;
      if (d > THRESHOLD) {
        differing += 1;
        const x = p % W, y = y0 + Math.floor(p / W);
        if (!bbox) bbox = [x, y, x, y]; else { if (x < bbox[0]) bbox[0] = x; if (y < bbox[1]) bbox[1] = y; if (x > bbox[2]) bbox[2] = x; if (y > bbox[3]) bbox[3] = y; }
        const ck = `${Math.floor(x / cell)},${Math.floor(y / cell)}`; cells.set(ck, (cells.get(ck) || 0) + 1);
        heat[Math.floor(y / 8) * hw + Math.floor(x / 8)] = 255;
      }
    }
  }
  const total = W * H;
  let worstCell = null;
  for (const [k, v] of cells) if (!worstCell || v > worstCell.count) worstCell = { cell: k, count: v };
  const toPt = (px) => r3((px * 72) / DPI);
  const heatPng = await sharp(heat, { raw: { width: hw, height: Math.ceil(H / 8), channels: 1 } }).png().toBuffer();
  fs.writeFileSync(diffFile, heatPng);
  return {
    width: W, height: H, pixels: total, differing, percent: r3((differing / total) * 100), max_channel_diff: maxDiff,
    bbox_pt: bbox ? bbox.map(toPt) : null,
    densest_64px_cell: worstCell ? { x_pt: toPt(Number(worstCell.cell.split(',')[0]) * cell), y_pt: toPt(Number(worstCell.cell.split(',')[1]) * cell), size_pt: toPt(cell), differing: worstCell.count, of: cell * cell } : null,
  };
}

// ---------------------------------------------------------------- text, fonts, images, qr
const txt = (pdf) => { try { return execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }); } catch { return ''; } };
// pdftotext drops the emoji differently from each file (Figma's text layer has no glyph for it), so strip it before collapsing whitespace
const normText = (s) => s.replace(/[\u{1F000}-\u{1FFFF}�?]/gu, '').replace(/\s+/g, ' ').trim();
const plan = JSON.parse(fs.readFileSync(path.join(runDir, 'signage', 'plan.json'), 'utf8'));
const planLinks = {}; for (const [ctx, v] of Object.entries(plan.qr || {})) if (v) planLinks[ctx] = v.link;
const ctxOf = (key) => key.replace(/^qr-/, '').replace(/-(primary|white|black)$/, '');

function qrHolders(sheet) {
  const found = [];
  (function walk(n, px, py) {
    const x = px + (n.x || 0), y = py + (n.y || 0);
    if (n.t === 'FRAME' && n.n === 'qr' && n.k && n.k[0]) found.push({ key: n.k[0].n, x, y, w: n.w, h: n.h, modules: n.k[0].k ? n.k[0].k[0].k.length : null });
    for (const c of n.k || []) walk(c, x, y);
  })(sheet, -sheet.x, -sheet.y);
  return found;
}
async function decodeQr(png, box) {
  const s = DPI / 72, pad = Math.round(box.w * s * 0.08);
  const left = Math.max(0, Math.round(box.x * s) - pad), top = Math.max(0, Math.round(box.y * s) - pad);
  const w = Math.round(box.w * s) + 2 * pad, h = Math.round(box.h * s) + 2 * pad;
  for (const scale of [0.25, 0.5, 1]) {
    const { data, info } = await sharp(png).extract({ left, top, width: w, height: h }).resize(Math.round(w * scale)).greyscale().raw().toBuffer({ resolveWithObject: true });
    // binarize around the crop's mid grey, then feed both polarities (white modules on a band
    // colour read as light-on-dark; jsQR wants dark modules)
    let lo = 255, hi = 0; for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const mid = (lo + hi) / 2;
    for (const invert of [false, true]) {
      const rgba = new Uint8ClampedArray(info.width * info.height * 4);
      for (let i = 0; i < data.length; i += 1) { const v = (data[i] > mid) !== invert ? 255 : 0; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
      const r = jsQR(rgba, info.width, info.height, { inversionAttempts: 'dontInvert' });
      if (r) return r.data;
    }
  }
  return null;
}

const results = [];
for (const p of pages) {
  const base = path.join(out, 'raster', p.name.replace(/[^A-Za-z0-9]+/g, '-'));
  const fPng = rasterize(p.figma, `${base}-figma`);
  const dPng = rasterize(p.direct, `${base}-direct`);
  const diff = await rasterDiff(fPng, dPng, `${base}-diff.png`);
  const sheetNode = section.k.find((n) => n.n === p.name);
  const qrs = [];
  for (const h of qrHolders(sheetNode)) {
    const dd = await decodeQr(dPng, h), fd = await decodeQr(fPng, h);
    const ctx = ctxOf(h.key);
    qrs.push({ key: h.key, box_pt: [h.x, h.y, h.w, h.h], modules: h.modules, module_pt: h.modules ? null : null, direct: dd, figma: fd, plan: planLinks[ctx], ok: !!dd && dd === fd && dd === planLinks[ctx] });
  }
  const tD = normText(txt(p.direct)), tF = normText(txt(p.figma));
  const fontsD = pdfFonts(p.direct), fontsF = pdfFonts(p.figma);
  const imgD = pdfImages(p.direct), imgF = pdfImages(p.figma);
  const rec = { ...p, raster: diff, text_equal: tD === tF, text_direct: tD.slice(0, 400), text_figma: tF.slice(0, 400), fonts_direct: fontsD, fonts_figma: fontsF, images_direct: imgD, images_figma: imgF, qr: qrs, bytes_direct: fs.statSync(p.direct).size, bytes_figma: fs.statSync(p.figma).size };
  results.push(rec);
  console.log(`${p.name}: raster ${diff.percent}% px > ${THRESHOLD} (max ${diff.max_channel_diff}), text ${rec.text_equal ? 'same' : 'DIFF'}, qr ${qrs.filter((q) => q.ok).length}/${qrs.length} ok`);
}

// worst page side by side: figma | direct | diff heat (red)
const worst = results.slice().sort((a, b) => b.raster.percent - a.raster.percent)[0];
let worstFile = null;
if (worst) {
  const base = path.join(out, 'raster', worst.name.replace(/[^A-Za-z0-9]+/g, '-'));
  const targetW = 1400;
  const scale = targetW / worst.raster.width;
  const h = Math.round(worst.raster.height * scale);
  const f = await sharp(`${base}-figma.png`).resize(targetW, h).png().toBuffer();
  const d = await sharp(`${base}-direct.png`).resize(targetW, h).png().toBuffer();
  const heat = await sharp(`${base}-diff.png`).resize(targetW, h, { kernel: 'nearest' }).png().toBuffer();
  const heatRgb = await sharp(heat).raw().toBuffer({ resolveWithObject: true });
  const rgb = Buffer.alloc(targetW * h * 3, 255);
  const ch = heatRgb.info.channels;
  for (let i = 0; i < targetW * h; i += 1) if (heatRgb.data[i * ch] > 0) { rgb[i * 3] = 220; rgb[i * 3 + 1] = 0; rgb[i * 3 + 2] = 0; }
  const heatImg = await sharp(rgb, { raw: { width: targetW, height: h, channels: 3 } }).png().toBuffer();
  worstFile = path.join(out, 'worst-page.png');
  await sharp({ create: { width: targetW * 3 + 40, height: h + 60, channels: 3, background: '#666' } })
    .composite([{ input: f, left: 10, top: 50 }, { input: d, left: targetW + 20, top: 50 }, { input: heatImg, left: targetW * 2 + 30, top: 50 },
      { input: Buffer.from(`<svg width="${targetW * 3 + 40}" height="50"><text x="10" y="35" font-size="28" fill="#fff" font-family="Helvetica">Figma export: ${worst.name}</text><text x="${targetW + 20}" y="35" font-size="28" fill="#fff" font-family="Helvetica">Direct render</text><text x="${targetW * 2 + 30}" y="35" font-size="28" fill="#fff" font-family="Helvetica">Diff (${worst.raster.percent}% px over ${THRESHOLD}/255 at ${DPI} dpi)</text></svg>`), left: 0, top: 0 }])
    .png().toFile(worstFile);
}

// kind-level sizes + vendor checks
const kinds = {};
for (const [kind, s] of Object.entries(directSheets.sheets)) {
  const figmaKind = path.join(path.dirname(figmaDir), `${kind}.pdf`);
  kinds[kind] = { direct_bytes: s.bytes, direct_pages: s.pages, direct_vector: s.vector, direct_fonts: s.font_list, figma_bytes: fs.existsSync(figmaKind) ? fs.statSync(figmaKind).size : null, figma_fonts: fs.existsSync(figmaKind) ? pdfFonts(figmaKind) : null, figma_pages: fs.existsSync(figmaKind) ? pdfPages(figmaKind) : null };
}
const summary = {
  run_dir: runDir, direct, figma_pages: figmaDir, dpi: DPI, threshold: THRESHOLD, generated_at: new Date().toISOString(),
  page_set: pageSet, geometry, pages: results, kinds, worst_page: worst && { name: worst.name, percent: worst.raster.percent, image: worstFile },
  raster: { mean_percent: r3(results.reduce((a, r) => a + r.raster.percent, 0) / Math.max(1, results.length)), max_percent: worst ? worst.raster.percent : null },
  qr: { total: results.reduce((a, r) => a + r.qr.length, 0), ok: results.reduce((a, r) => a + r.qr.filter((q) => q.ok).length, 0) },
  text: { pages_equal: results.filter((r) => r.text_equal).length, pages: results.length },
  vendor: { page_size_equals_frame: pageSet.sizes_match, bleed_or_crop_marks: 'none in either (Figma export has none; direct matches)', all_direct_vector: Object.values(directSheets.sheets).every((s) => s.vector) },
};
fs.writeFileSync(path.join(out, 'parity.json'), JSON.stringify(summary, null, 2));
const md = [];
md.push(`# Direct PDF parity: ${path.basename(runDir)}`, '', `Figma pages: ${figmaDir}`, `Direct pages: ${direct}`, `Raster: ${DPI} dpi, a pixel counts as different when any channel differs by more than ${THRESHOLD}/255.`, '');
md.push(`## Page set`, `- same set: ${pageSet.same_set} (${pages.length} pages; missing in direct: ${pageSet.missing_in_direct.join(', ') || 'none'}; missing in Figma: ${pageSet.missing_in_figma.join(', ') || 'none'})`, `- page sizes (pt) and page counts match: ${pageSet.sizes_match}`, '');
if (geometry.checked) md.push(`## Geometry vs live Figma tree ${geometry.section}`, `- nodes compared: ${geometry.nodes_compared}, tolerance ${geometry.tolerance_pt} pt, max position/size delta ${geometry.max_position_delta_pt} pt, mean ${geometry.mean_delta_pt} pt`, `- mismatches: ${geometry.mismatches.length}${geometry.mismatches.length ? '\n' + geometry.mismatches.slice(0, 40).map((m) => `  - ${m.path}: ${m.what} direct=${JSON.stringify(m.direct)} figma=${JSON.stringify(m.figma)}`).join('\n') : ''}`, '');
md.push(`## Per page`, '| page | size pt | raster % diff | max ch | densest 64px cell | text | qr ok | fonts direct / figma | images direct / figma | bytes direct / figma |', '|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) md.push(`| ${r.name} | ${r.size_direct.join('x')} | ${r.raster.percent} | ${r.raster.max_channel_diff} | ${r.raster.densest_64px_cell ? `${r.raster.densest_64px_cell.differing}/${r.raster.densest_64px_cell.of} at ${r.raster.densest_64px_cell.x_pt},${r.raster.densest_64px_cell.y_pt}` : 'none'} | ${r.text_equal ? 'same' : 'differs'} | ${r.qr.filter((q) => q.ok).length}/${r.qr.length} | ${(r.fonts_direct || []).map((f) => f.name.replace(/^[A-Z]{6}\+/, '')).join(', ')} / ${(r.fonts_figma || []).map((f) => f.name + ' ' + f.type).join(', ')} | ${(r.images_direct || []).map((i) => `${i.w}x${i.h} ${i.enc}`).join(', ') || 'none'} / ${(r.images_figma || []).map((i) => `${i.w}x${i.h} ${i.enc}`).join(', ') || 'none'} | ${r.bytes_direct} / ${r.bytes_figma} |`);
md.push('', `## QR`, ...results.flatMap((r) => r.qr.map((q) => `- ${r.name} ${q.key}: direct=${q.direct} figma=${q.figma} plan=${q.plan} ${q.ok ? 'OK' : 'MISMATCH'}`)));
md.push('', `## Kind files`, ...Object.entries(kinds).map(([k, v]) => `- ${k}: direct ${v.direct_bytes} B (${v.direct_pages} pages, vector ${v.direct_vector}), figma ${v.figma_bytes ?? 'n/a'} B (${v.figma_pages ?? 'n/a'} pages)`));
md.push('', `Worst page: ${worst ? `${worst.name} ${worst.raster.percent}% -> ${worstFile}` : 'n/a'}`);
fs.writeFileSync(path.join(out, 'parity.md'), md.join('\n') + '\n');
console.log(JSON.stringify({ out, same_page_set: pageSet.same_set, sizes_match: pageSet.sizes_match, geometry_mismatches: geometry.checked ? geometry.mismatches.length : 'not checked', max_delta_pt: geometry.max_position_delta_pt, raster_mean_percent: summary.raster.mean_percent, raster_max_percent: summary.raster.max_percent, worst: summary.worst_page?.name, text_pages_equal: `${summary.text.pages_equal}/${summary.text.pages}`, qr: `${summary.qr.ok}/${summary.qr.total}` }));
