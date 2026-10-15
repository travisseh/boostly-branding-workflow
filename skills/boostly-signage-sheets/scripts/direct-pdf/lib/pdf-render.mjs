// Render a section node tree (lib/retarget.mjs shape) to vector PDF pages with pdf-lib.
// One "Print Sheet - ..." FRAME = one page, MediaBox = frame size in pt (1 Figma px = 1 pt, the
// same convention as Figma's REST PDF export). Everything is vector: fills and strokes are
// paths, QR modules are paths, text is real text set in the embedded Figtree subset (Figma's
// export draws glyph outlines plus an invisible Type 3 text layer; here the text IS the glyphs).
// Colours use an ICCBased sRGB colour space, like Figma's export. Logo PNGs are embedded
// lossless at full source resolution (Figma re-encodes them as JPEG).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { layoutText, EMOJI_BASELINE_DROP } from './text-layout.mjs';
import { emojiImage } from './fonts.mjs';

const require = createRequire(import.meta.url);
// pdf-lib needs its own fontkit fork for subsetting (encodeStream); lib/fonts.mjs keeps stock fontkit for layout.
const fontkit = require('@pdf-lib/fontkit');
const { PDFDocument, PDFName, PDFNumber, PDFString } = require('pdf-lib');

export const SRGB_ICC_CANDIDATES = ['/System/Library/ColorSync/Profiles/sRGB Profile.icc'];
const KAPPA = 0.5522847498;
const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toString();
  return s === '-0' ? '0' : s;
};

// ---- path builders (Figma px coordinates, y down; the page CTM flips them) ----
export function roundedRectPath(x, y, w, h, r = 0) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return `${n(x)} ${n(y)} m ${n(x + w)} ${n(y)} l ${n(x + w)} ${n(y + h)} l ${n(x)} ${n(y + h)} l h`;
  const k = r * (1 - KAPPA);
  return [
    `${n(x)} ${n(y + r)} m`,
    `${n(x)} ${n(y + k)} ${n(x + k)} ${n(y)} ${n(x + r)} ${n(y)} c`,
    `${n(x + w - r)} ${n(y)} l`,
    `${n(x + w - k)} ${n(y)} ${n(x + w)} ${n(y + k)} ${n(x + w)} ${n(y + r)} c`,
    `${n(x + w)} ${n(y + h - r)} l`,
    `${n(x + w)} ${n(y + h - k)} ${n(x + w - k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c`,
    `${n(x + r)} ${n(y + h)} l`,
    `${n(x + k)} ${n(y + h)} ${n(x)} ${n(y + h - k)} ${n(x)} ${n(y + h - r)} c`,
    'h',
  ].join(' ');
}

// Figma-style path data ("M0 0L900 0C...Z", absolute M/L/C/Z plus H/V/Q/S for safety) -> PDF ops.
export function svgPathToOps(d, dx = 0, dy = 0) {
  const out = [];
  const re = /([MLCZHVQSmlczhvqs])([^MLCZHVQSmlczhvqs]*)/g;
  let m; let cur = [0, 0]; let start = [0, 0]; let prevC = null;
  const nums = (s) => (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) || []).map(Number);
  while ((m = re.exec(d))) {
    const c = m[1]; const a = nums(m[2]);
    const rel = c === c.toLowerCase() && c !== 'z';
    const P = (i) => (rel ? [cur[0] + a[i], cur[1] + a[i + 1]] : [a[i], a[i + 1]]);
    switch (c.toUpperCase()) {
      case 'M': for (let i = 0; i < a.length; i += 2) { cur = P(i); if (i === 0) { start = cur; out.push(`${n(cur[0] + dx)} ${n(cur[1] + dy)} m`); } else out.push(`${n(cur[0] + dx)} ${n(cur[1] + dy)} l`); } prevC = null; break;
      case 'L': for (let i = 0; i < a.length; i += 2) { cur = P(i); out.push(`${n(cur[0] + dx)} ${n(cur[1] + dy)} l`); } prevC = null; break;
      case 'H': for (const v of a) { cur = [rel ? cur[0] + v : v, cur[1]]; out.push(`${n(cur[0] + dx)} ${n(cur[1] + dy)} l`); } prevC = null; break;
      case 'V': for (const v of a) { cur = [cur[0], rel ? cur[1] + v : v]; out.push(`${n(cur[0] + dx)} ${n(cur[1] + dy)} l`); } prevC = null; break;
      case 'C': for (let i = 0; i < a.length; i += 6) { const c1 = P(i), c2 = P(i + 2), p = P(i + 4); out.push(`${n(c1[0] + dx)} ${n(c1[1] + dy)} ${n(c2[0] + dx)} ${n(c2[1] + dy)} ${n(p[0] + dx)} ${n(p[1] + dy)} c`); prevC = c2; cur = p; } break;
      case 'S': for (let i = 0; i < a.length; i += 4) { const c2 = P(i), p = P(i + 2); const c1 = prevC ? [2 * cur[0] - prevC[0], 2 * cur[1] - prevC[1]] : cur; out.push(`${n(c1[0] + dx)} ${n(c1[1] + dy)} ${n(c2[0] + dx)} ${n(c2[1] + dy)} ${n(p[0] + dx)} ${n(p[1] + dy)} c`); prevC = c2; cur = p; } break;
      case 'Q': for (let i = 0; i < a.length; i += 4) { const q = P(i), p = P(i + 2); const c1 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])]; const c2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])]; out.push(`${n(c1[0] + dx)} ${n(c1[1] + dy)} ${n(c2[0] + dx)} ${n(c2[1] + dy)} ${n(p[0] + dx)} ${n(p[1] + dy)} c`); cur = p; } prevC = null; break;
      case 'Z': out.push('h'); cur = start; prevC = null; break;
      default: throw new Error(`path command ${c}`);
    }
  }
  return out.join(' ');
}

function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map((x) => n(x)).join(' ');
}

export class PdfRenderer {
  constructor({ icc = true, producer = 'Boostly direct signage renderer (boostly-signage-sheets/scripts/direct-pdf)' } = {}) {
    this.iccEnabled = icc;
    this.producer = producer;
  }

  async newDocument() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setProducer(this.producer);
    doc.setCreator('boostly-signage-sheets direct-pdf');
    const state = { doc, fonts: new Map(), images: new Map(), emoji: new Map(), icc: null, gs: new Map() };
    if (this.iccEnabled) {
      const file = SRGB_ICC_CANDIDATES.find((p) => fs.existsSync(p));
      if (file) {
        const stream = doc.context.flateStream(fs.readFileSync(file), { N: 3, Alternate: PDFName.of('DeviceRGB') });
        const ref = doc.context.register(stream);
        state.icc = doc.context.register(doc.context.obj([PDFName.of('ICCBased'), ref]));
        state.iccFile = file;
      }
    }
    return state;
  }

  async font(state, fam, sty, fontRec) {
    const key = `${fam}|${sty}`;
    if (!state.fonts.has(key)) {
      const f = await state.doc.embedFont(fontRec.bytes, { subset: true });
      state.fonts.set(key, { pdfFont: f, fontRec });
    }
    return state.fonts.get(key);
  }

  async image(state, file) {
    if (!state.images.has(file)) {
      const bytes = fs.readFileSync(file);
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const img = isPng ? await state.doc.embedPng(bytes) : await state.doc.embedJpg(bytes);
      await img.embed();
      if (state.icc) { const dict = state.doc.context.lookup(img.ref); if (dict && dict.dict && dict.dict.get(PDFName.of('ColorSpace')) === PDFName.of('DeviceRGB')) dict.dict.set(PDFName.of('ColorSpace'), state.icc); }
      state.images.set(file, { img, width: img.width, height: img.height, bytes: bytes.length, png: isPng });
    }
    return state.images.get(file);
  }

  async emojiImg(state, item) {
    const key = `${item.fontRec.file}#${item.gid}`;
    if (!state.emoji.has(key)) {
      const png = emojiImage(item.glyph, item.box);
      if (!png) { state.emoji.set(key, null); return null; }
      const img = await state.doc.embedPng(png);
      await img.embed();
      state.emoji.set(key, { img, width: img.width, height: img.height });
    }
    return state.emoji.get(key);
  }

  // Renders one sheet frame as a new page of state.doc. Returns page stats.
  async renderSheet(state, sheet) {
    const { doc } = state;
    const page = doc.addPage([sheet.w, sheet.h]);
    const ops = [];
    const res = { fonts: new Map(), xobjects: new Map(), gs: new Map() };
    const stats = { texts: 0, glyphs: 0, images: 0, vectors: 0, emoji: 0, fontsUsed: new Set(), warnings: [] };
    const ctx = { state, page, ops, res, stats };
    const colorOp = (hex, stroke = false) => (state.icc ? `/Cs1 ${stroke ? 'CS' : 'cs'} ${rgb(hex)} ${stroke ? 'SCN' : 'scn'}` : `${rgb(hex)} ${stroke ? 'RG' : 'rg'}`);
    ctx.colorOp = colorOp;
    ops.push('q', `1 0 0 -1 0 ${n(sheet.h)} cm`);
    await this.renderNode(ctx, sheet, 0, 0, true);
    ops.push('Q');
    const content = ops.join('\n');
    const stream = doc.context.flateStream(content);
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
    for (const [tag, ref] of res.fonts) page.node.setFontDictionary(PDFName.of(tag), ref);
    for (const [tag, ref] of res.xobjects) page.node.setXObject(PDFName.of(tag), ref);
    for (const [tag, ref] of res.gs) page.node.setExtGState(PDFName.of(tag), ref);
    if (state.icc) {
      const resources = page.node.Resources();
      let cs = resources.lookup(PDFName.of('ColorSpace'));
      if (!cs) { cs = doc.context.obj({}); resources.set(PDFName.of('ColorSpace'), cs); }
      cs.set(PDFName.of('Cs1'), state.icc);
    }
    stats.fontsUsed = [...stats.fontsUsed];
    stats.contentBytes = content.length;
    return stats;
  }

  shapePath(node, x, y) {
    return roundedRectPath(x, y, node.w, node.h, node.cr || 0);
  }

  gsFor(ctx, opacity) {
    const key = `GS${Math.round(opacity * 1000)}`;
    if (!ctx.res.gs.has(key)) {
      const dict = ctx.state.doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity });
      ctx.res.gs.set(key, ctx.state.doc.context.register(dict));
    }
    return key;
  }

  async renderNode(ctx, node, px, py, isRoot = false) {
    const { ops } = ctx;
    if (node.v === false) return;
    const x = isRoot ? 0 : px + node.x;
    const y = isRoot ? 0 : py + node.y;
    const t = node.t;
    ops.push('q');
    if (node.o !== undefined && node.o < 1) ops.push(`/${this.gsFor(ctx, node.o)} gs`);
    if (t === 'TEXT') { await this.renderText(ctx, node, x, y); ops.push('Q'); return; }
    if (t === 'VECTOR' || t === 'LINE' || t === 'ELLIPSE' || t === 'STAR' || t === 'REGULAR_POLYGON' || t === 'BOOLEAN_OPERATION') {
      for (const f of node.f || []) {
        if (f.v === false || !f.c) continue;
        for (const vp of node.vp || []) { ops.push(ctx.colorOp(f.c), svgPathToOps(vp.data, x, y), vp.windingRule === 'EVENODD' ? 'f*' : 'f'); ctx.stats.vectors += 1; }
      }
      if (node.s?.length && node.vp?.length) ctx.stats.warnings.push(`vector stroke not rendered: ${node.n}`);
      ops.push('Q'); return;
    }
    // FRAME / RECTANGLE / GROUP / SECTION: shape = (rounded) rectangle
    const shape = this.shapePath(node, x, y);
    if (t !== 'GROUP') {
      for (const f of node.f || []) {
        if (f.v === false) continue;
        if (f.c) { ops.push(ctx.colorOp(f.c)); if (f.o !== undefined && f.o < 1) ops.push(`/${this.gsFor(ctx, f.o)} gs`); ops.push(shape, 'f'); if (f.o !== undefined && f.o < 1) ops.push(`/${this.gsFor(ctx, 1)} gs`); }
        else if (f.imgFile) await this.renderImageFill(ctx, node, f, x, y, shape);
        else if (f.img !== undefined) ctx.stats.warnings.push(`unresolved image fill on ${node.n}`);
      }
    }
    if (node.clip) ops.push(shape, 'W n');
    for (const c of node.k || []) await this.renderNode(ctx, c, x, y);
    if (node.clip) { ops.push('Q', 'q'); if (node.o !== undefined && node.o < 1) ops.push(`/${this.gsFor(ctx, node.o)} gs`); }
    if (t !== 'GROUP') this.renderStroke(ctx, node, x, y);
    ops.push('Q');
  }

  renderStroke(ctx, node, x, y) {
    const { ops } = ctx;
    const sw = node.sw || 0;
    for (const s of node.s || []) {
      if (s.v === false || !s.c || !sw) continue;
      const align = node.sa || 'INSIDE';
      if (node.sd && node.sd.length) {
        // dashed (the sheet cut-guide): stroke the centerline of the band
        const inset = align === 'INSIDE' ? sw / 2 : align === 'OUTSIDE' ? -sw / 2 : 0;
        ops.push(ctx.colorOp(s.c, true), `${n(sw)} w 0 J [${node.sd.map(n).join(' ')}] 0 d`, roundedRectPath(x + inset, y + inset, node.w - 2 * inset, node.h - 2 * inset, Math.max(0, (node.cr || 0) - inset)), 'S');
        continue;
      }
      // solid: a ring filled even-odd, exactly what Figma exports for an INSIDE stroke
      const e = align === 'INSIDE' ? 0 : align === 'OUTSIDE' ? sw : sw / 2;
      const i = align === 'INSIDE' ? sw : align === 'OUTSIDE' ? 0 : sw / 2;
      const r = node.cr || 0;
      const outer = roundedRectPath(x - e, y - e, node.w + 2 * e, node.h + 2 * e, r ? r + e : 0);
      const inner = roundedRectPath(x + i, y + i, node.w - 2 * i, node.h - 2 * i, Math.max(0, r - i));
      ops.push(ctx.colorOp(s.c), outer, inner, 'f*');
    }
  }

  async renderImageFill(ctx, node, f, x, y, shape) {
    const { ops, state } = ctx;
    const im = await this.image(state, f.imgFile);
    const tag = `Im${im.img.ref.objectNumber}`;
    if (!ctx.res.xobjects.has(tag)) ctx.res.xobjects.set(tag, im.img.ref);
    const mode = f.sm || 'FIT';
    const sx = node.w / im.width, sy = node.h / im.height;
    let scale = mode === 'FILL' ? Math.max(sx, sy) : mode === 'FIT' ? Math.min(sx, sy) : null;
    let dw, dh;
    if (scale === null) { dw = node.w; dh = node.h; } else { dw = im.width * scale; dh = im.height * scale; }
    const dx = x + (node.w - dw) / 2, dy = y + (node.h - dh) / 2;
    ops.push('q', shape, 'W n', `${n(dw)} 0 0 ${n(-dh)} ${n(dx)} ${n(dy + dh)} cm`, `/${tag} Do`, 'Q');
    ctx.stats.images += 1;
    node.imagePlacement = { x: dx, y: dy, w: dw, h: dh, source: { w: im.width, h: im.height, bytes: im.bytes, png: im.png } };
  }

  async renderText(ctx, node, x, y) {
    const { ops, state } = ctx;
    const st = node.text;
    const L = layoutText(st.ch, { ...st, w: node.w, h: node.h });
    const fill = (node.f || []).find((f) => f.v !== false && f.c);
    if (!fill) return;
    const fr = await this.font(state, st.fam, st.sty, L.fontRec);
    const tag = `F${fr.pdfFont.ref.objectNumber}`;
    if (!ctx.res.fonts.has(tag)) ctx.res.fonts.set(tag, fr.pdfFont.ref);
    ctx.stats.fontsUsed.add(`${st.fam} ${st.sty}`);
    ctx.stats.texts += 1;
    node.layout = { boxW: L.boxW, boxH: L.boxH, lines: L.lines.map((l) => ({ text: l.text, x: l.x, baseline: l.baseline, width: l.width })) };
    ops.push(ctx.colorOp(fill.c));
    for (const line of L.lines) {
      let run = [];
      let runStart = null;
      const flush = () => {
        if (!run.length) return;
        const parts = [];
        for (let k = 0; k < run.length; k += 1) {
          const g = run[k];
          const hex = fr.pdfFont.encodeText(g.chars).value;
          parts.push(`<${hex}>`);
          const next = run[k + 1];
          const desired = next ? next.x - g.x : g.adv + g.ls;
          const adj = -((desired - g.nominalAdv) / L.fs) * 1000;
          if (Math.abs(adj) > 0.0005) parts.push(n(adj));
          ctx.stats.glyphs += 1;
        }
        ops.push('BT', `/${tag} ${n(L.fs)} Tf`, `1 0 0 -1 ${n(x + runStart.x)} ${n(y + runStart.y)} Tm`, `[ ${parts.join(' ')} ] TJ`, 'ET');
        run = []; runStart = null;
      };
      for (const g of line.glyphs) {
        if (g.kind === 'glyph') { if (!run.length) runStart = g; run.push(g); continue; }
        flush();
        if (g.kind === 'emoji') {
          const em = await this.emojiImg(state, g);
          if (!em) { ctx.stats.warnings.push(`emoji bitmap missing for ${g.chars}`); continue; }
          const etag = `Im${em.img.ref.objectNumber}`;
          if (!ctx.res.xobjects.has(etag)) ctx.res.xobjects.set(etag, em.img.ref);
          const box = g.box;
          const top = y + g.y - box * (1 - EMOJI_BASELINE_DROP);
          ops.push('q', `${n(box)} 0 0 ${n(-box)} ${n(x + g.x)} ${n(top + box)} cm`, `/${etag} Do`, 'Q');
          ctx.stats.emoji += 1;
        } else ctx.stats.warnings.push(`no glyph for ${JSON.stringify(g.chars)} in ${st.fam} ${st.sty}`);
      }
      flush();
    }
  }
}

export async function savePdf(state, file, { title } = {}) {
  if (title) state.doc.setTitle(title);
  const bytes = await state.doc.save({ useObjectStreams: false });
  fs.writeFileSync(file, bytes);
  return bytes.length;
}

export async function mergePdfs(files, out, { title, producer } = {}) {
  const doc = await PDFDocument.create();
  if (producer) doc.setProducer(producer);
  if (title) doc.setTitle(title);
  for (const f of files) {
    const src = await PDFDocument.load(fs.readFileSync(f));
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) doc.addPage(p);
  }
  const bytes = await doc.save({ useObjectStreams: false });
  fs.writeFileSync(out, bytes);
  return bytes.length;
}

export { PDFNumber, PDFString };
