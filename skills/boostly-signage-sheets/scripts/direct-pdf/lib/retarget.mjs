// Build a location's signage section as a node tree WITHOUT Figma: the same clone-and-retarget
// the closeout agent runs in-plugin (clone the Munchie template, rename, recolor the band,
// rebuild the to-go labels, trim to the live counts, recopy the offer, place logos and QRs,
// stroke gate), applied to references/template-spec.json. Text sizes are measured with the
// same layout engine the renderer draws with (lib/text-layout.mjs), so the tree carries the
// box heights Figma would have produced.
import fs from 'node:fs';
import path from 'node:path';
import { layoutText, lineHeightPx } from './text-layout.mjs';
import { loadFont } from './fonts.mjs';
import { qrSvgToNodes } from './qr-nodes.mjs';

export const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
export const TEMPLATE_SPEC = path.join(SKILL_DIR, 'references', 'template-spec.json');
export const TEMPLATE_BAND = '#408bf1';
export const PAGE_Y0 = 798.4;
export const PAGE_STEP = 2929;
export const PER_SHEET = 4;

// Which QR master each unit's holder takes (plan.mjs qr file keys: <ctx>-<role>).
export const UNIT_QR = {
  'table-sticker-promo': 'qr-tablePromo-primary',
  'table-sticker-review': 'qr-tableReview-primary',
  'bathroom-strip-promo': 'qr-bathroomPromo-white',
  'bathroom-strip-review': 'qr-bathroomReview-white',
  'pop-sign-primary': 'qr-pop-white',
  'pop-sign-light': 'qr-pop-primary',
  'Print Sheet - To-Go Label - promo - Black': 'qr-togoPromo-black',
  'Print Sheet - To-Go Label - review - Black': 'qr-togoReview-black',
};

export function loadTemplateSpec(file = TEMPLATE_SPEC) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return j.spec || j;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// Expand {ref unit} children into full copies of the unit definition.
export function expandRefs(spec) {
  const units = {};
  function walk(n) {
    if (n.unit) units[n.unit] = n;
    if (!n.k) return n;
    n.k = n.k.map((c) => {
      if (c.ref) {
        const u = units[c.ref];
        if (!u) throw new Error(`ref ${c.ref} before its unit`);
        const copy = clone(u); delete copy.unit; copy.x = c.x; copy.y = c.y; copy.ref = c.ref; return copy;
      }
      return walk(c);
    });
    return n;
  }
  const root = walk(clone(spec));
  // mark unit copies by name so later passes can find them without the unit/ref flags
  (function mark(n) { if (n.unit) { n.unitName = n.unit; delete n.unit; } if (n.ref) { n.unitName = n.ref; delete n.ref; } (n.k || []).forEach(mark); })(root);
  return root;
}

export function findAll(node, pred, acc = []) {
  if (pred(node)) acc.push(node);
  for (const c of node.k || []) findAll(c, pred, acc);
  return acc;
}

export function recolor(node, from, to, acc = { n: 0 }) {
  if (node.t === 'FRAME' && node.n === 'qr') return acc;
  for (const f of node.f || []) if (f.c && f.c.toLowerCase() === from.toLowerCase()) { f.c = to.toLowerCase(); acc.n += 1; }
  for (const c of node.k || []) recolor(c, from, to, acc);
  return acc;
}

function hex(c) {
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error(`bad hex ${c}`);
  return c.toLowerCase();
}

// Re-measure a TEXT node with the layout engine (ar HEIGHT / WIDTH_AND_HEIGHT hug the text).
// Fonts the skill does not ship (the Inter section header, never printed) keep their template size.
export function measureText(t) {
  let L;
  try { L = layoutText(t.text.ch, { ...t.text, w: t.w, h: t.h }); } catch (e) { if (/not found/.test(e.message)) { t.unmeasured = e.message; return null; } throw e; }
  if (t.text.ar === 'WIDTH_AND_HEIGHT') t.w = L.boxW;
  if (t.text.ar === 'WIDTH_AND_HEIGHT' || t.text.ar === 'HEIGHT') t.h = L.boxH;
  return L;
}

export function setText(t, { fam, sty, fs, lh, ch, x, y, w }) {
  t.text = { ...t.text, fam, sty, fs, lh, ch };
  t.text.ar = 'HEIGHT';
  t.n = ch.replace(/\n/g, ' ');
  t.w = w; t.x = x; t.y = y;
  return measureText(t);
}

// ---- copy rules (plan.mjs specificOfferCopy / figma-recopy.js, kept in sync) ----
export const DEFAULTS = {
  stickerTitle: 'Join the club!',
  stickerBody: 'Be the first to know.\nReceive exclusive deals.',
  popTitle: 'Join the club!',
  popBodyVip: 'Scan to join our VIP text club\nfor ongoing offers!',
  popBodyDiscount: 'Scan to join our text club\nfor ongoing offers!',
};
const GENERIC_OFFER = /^join the club!?$/i;
export function classifyOffer(offer, mode = 'auto') {
  if (mode !== 'auto') return mode;
  if (!offer || GENERIC_OFFER.test(offer.trim())) return 'generic';
  const isDiscount = /^\$?\d+(\.\d+)?\s*%?\s*off\b/i.test(offer) || /^free\b/i.test(offer);
  return isDiscount ? 'discount' : 'phrase';
}
export function offerCopy(offerText, mode = 'auto') {
  let offer = (offerText || '').replace(/\s+/g, ' ').trim();
  const typedGet = offer.match(/^get\s+(.+?)!?\s*$/i);
  if (typedGet && /^\$?\d+(\.\d+)?\s*%?\s*off\b/i.test(typedGet[1])) offer = typedGet[1];
  const kind = classifyOffer(offer, mode);
  const reviewPhrase = kind === 'phrase' && /let us know|review|good time/i.test(offer);
  const headline = kind === 'discount' ? 'Get ' + offer.replace(/\bOFF\b/g, 'Off') : kind === 'phrase' ? offer : DEFAULTS.popTitle;
  return {
    kind, reviewPhrase, headline,
    stickerTitle: kind === 'phrase' && !reviewPhrase ? offer : kind === 'discount' ? headline : DEFAULTS.stickerTitle,
    stickerBody: kind === 'phrase' && !reviewPhrase ? DEFAULTS.popBodyVip : DEFAULTS.stickerBody,
    popBody: kind === 'discount' ? DEFAULTS.popBodyDiscount : DEFAULTS.popBodyVip,
    togoPromo: kind === 'generic' ? DEFAULTS.stickerTitle : headline,
  };
}

const pageOf = (n) => { const m = /- Page (\d+)\s*$/.exec(n.n); return m ? Number(m[1]) : 1; };
const baseNameOf = (n) => n.n.replace(/\s*- Page \d+\s*$/, '');

// The per-count families: how the live quantities map to sheet kinds. Tables drive the table
// promo AND the table review stickers (one of each per table); stalls drive both bathroom strips.
export const COUNT_FAMILIES = [
  { key: 'table', re: /^Print Sheet - Table Stickers/, count: 'tables', sticker: [900, 900] },
  { key: 'review', re: /^Print Sheet - Review Stickers/, count: 'tables', sticker: [900, 900] },
  { key: 'bathroom', re: /^Print Sheet - Bathroom Stickers/, count: 'stalls', sticker: [1300, 612] },
  { key: 'bathroomReview', re: /^Print Sheet - Bathroom Review Stickers/, count: 'stalls', sticker: [1300, 612] },
];

// Fit the section to the live counts, in BOTH directions. The Figma-side figma-trim only ever
// removed (the template holds 10 tables / 6 stalls); here a count above the template clones the
// last FULL sheet of that kind (same cut-guide, same 4-per-sheet grid, same unit frames, so the
// later recopy / QR / logo passes treat the clones exactly like originals), names it with the
// family's existing "- Page N" convention, and the last sheet is cut back to the exact count.
// Sheets short of the grid before the last page (the template's 2-sticker page 3) are refilled
// from the family's full-sheet prototype at the grid slot that is empty.
export function trim(sec, tables, stalls) {
  if (!Number.isInteger(tables) || !Number.isInteger(stalls) || tables < 0 || stalls < 0) throw new Error('tables and stalls must be non-negative integers');
  // Zero tables (or stalls) is a normal order (POP-only ad hoc runs, Craft by Smoke and Fire
  // 2026-10-16): the whole family is removed and reported in `absent`.
  const counts = { tables, stalls };
  const removedSheets = [], removedStickers = [], addedSheets = [], addedStickers = [], errors = [], remaining = {};
  const stallPages = Math.ceil(stalls / PER_SHEET);
  for (const fam of COUNT_FAMILIES) {
    const total = counts[fam.count];
    const isSticker = (c) => c.t === 'FRAME' && c.w === fam.sticker[0] && c.h === fam.sticker[1];
    const stickersOf = (s) => s.k.filter(isSticker).sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const pagesNeeded = Math.ceil(total / PER_SHEET);
    const sheets = sec.k.filter((n) => fam.re.test(n.n)).sort((a, b) => pageOf(a) - pageOf(b));
    if (!sheets.length) { errors.push(`${fam.key}: the template has no sheet of this kind`); continue; }
    // prototype = the fullest sheet (a frozen copy, so later edits to the live sheets never leak in)
    const fullest = sheets.reduce((a, b) => (stickersOf(b).length > stickersOf(a).length ? b : a));
    const protoSlots = stickersOf(fullest);
    if (protoSlots.length !== PER_SHEET) { errors.push(`${fam.key}: no full ${PER_SHEET}-per-sheet prototype (fullest sheet ${fullest.n} holds ${protoSlots.length})`); continue; }
    const proto = clone(fullest);
    const baseName = baseNameOf(sheets[0]);
    // grow: append clones of the prototype after the family's last sheet, numbered on
    let insertAt = sec.k.indexOf(sheets[sheets.length - 1]) + 1;
    for (let page = sheets.length + 1; page <= pagesNeeded; page += 1) {
      const s = clone(proto);
      s.n = `${baseName} - Page ${page}`;
      sec.k.splice(insertAt, 0, s); insertAt += 1;
      sheets.push(s); addedSheets.push(s.n);
    }
    // shrink: drop pages past the count
    const keep = [];
    for (const s of sheets) {
      if (pageOf(s) > pagesNeeded) { removedSheets.push(s.n); sec.k.splice(sec.k.indexOf(s), 1); } else keep.push(s);
    }
    // every kept page holds exactly its share: refill empty grid slots from the prototype, cut extras
    keep.forEach((s, i) => {
      const wanted = Math.min(PER_SHEET, total - i * PER_SHEET);
      const have = stickersOf(s);
      for (const st of have.slice(Math.max(0, wanted))) { removedStickers.push({ sheet: s.n, name: st.n }); s.k.splice(s.k.indexOf(st), 1); }
      if (have.length < wanted) {
        const taken = new Set(have.map((st) => `${st.x},${st.y}`));
        for (const slot of protoSlots) {
          if (s.k.filter(isSticker).length >= wanted) break;
          if (taken.has(`${slot.x},${slot.y}`)) continue;
          const st = clone(slot);
          s.k.push(st); taken.add(`${slot.x},${slot.y}`);
          addedStickers.push({ sheet: s.n, name: st.n, x: st.x, y: st.y });
        }
        s.k = [...s.k.filter((c) => !isSticker(c)), ...stickersOf(s)]; // cut-guide first, then the grid in reading order
      }
    });
    keep.forEach((s, i) => { const row = fam.key === 'bathroomReview' ? stallPages + i : i; s.y = PAGE_Y0 + row * PAGE_STEP; });
    remaining[fam.key] = keep.map((s) => ({ name: s.n, y: Math.round(s.y * 10) / 10, stickers: stickersOf(s).length }));
    const got = keep.reduce((a, s) => a + stickersOf(s).length, 0);
    if (got !== total) errors.push(`${fam.key}: built ${got} stickers over ${keep.length} sheets, wanted ${total}`);
  }
  if (errors.length) throw new Error(errors.join('; '));
  // the section's own box grows with the tallest column (metadata only; the renderer draws sheets)
  const bottom = Math.max(...sheetsOf(sec).map((s) => s.y + s.h));
  if (Number.isFinite(bottom)) sec.h = Math.max(sec.h, Math.ceil(bottom + PAGE_Y0));
  const absent = COUNT_FAMILIES.filter((f) => counts[f.count] === 0).map((f) => f.key);
  const note = tables === 0 ? 'no table stickers in this order' : null;
  return { removedSheets, removedStickers, addedSheets, addedStickers, remaining, absent, note };
}

export function recopy(sec, offerText, mode = 'auto') {
  const copy = offerCopy(offerText, mode);
  const MEDIUM = { fam: 'Figtree', sty: 'Medium' }, SEMIBOLD = { fam: 'Figtree', sty: 'SemiBold' };
  const sheets = sec.k.filter((n) => /^Print Sheet - /.test(n.n));
  const summary = { kind: copy.kind, headline: copy.headline, stickerLayout: null, stickerTitleSize: null, stickerTitleLines: 1, popTitleSize: null, popTitleLines: 1, stickers: 0, popSigns: 0 };
  let stickerLayout = copy.kind === 'phrase' && !copy.reviewPhrase ? null : 'default';
  // Two-line sticker layout (figma-recopy phraseTwoLine: title 74 auto-lh at y56, body 42/60 at
  // y274), with a measured guard: a title that still runs past the body's top shrinks in steps
  // of 2 until it clears y274 (floor 40), so title and body never overlap on any copy.
  const STICKER_TWO_LINE_BODY_Y = 274, STICKER_TITLE_Y = 56;
  const twoLine = (title, body) => {
    let size = 74;
    setText(title, { ...MEDIUM, fs: size, lh: 'AUTO', ch: copy.stickerTitle, x: 56, y: STICKER_TITLE_Y, w: 788 });
    while (STICKER_TITLE_Y + title.h > STICKER_TWO_LINE_BODY_Y && size > 40) { size -= 2; title.text.fs = size; measureText(title); }
    setText(body, { ...SEMIBOLD, fs: 42, lh: 60, ch: copy.stickerBody, x: 56, y: STICKER_TWO_LINE_BODY_Y, w: 788 });
    return size;
  };
  for (const sheet of sheets.filter((s) => /^Print Sheet - Table Stickers/.test(s.n))) {
    for (const f of sheet.k.filter((c) => c.t === 'FRAME' && c.w === 900 && c.h === 900)) {
      const texts = f.k.filter((t) => t.t === 'TEXT');
      const title = texts.find((t) => t.y < 150);
      const body = texts.find((t) => t.y >= 150);
      if (!title || !body) continue;
      if (stickerLayout === null) {
        setText(title, { ...MEDIUM, fs: 82, lh: 'AUTO', ch: copy.stickerTitle, x: 56, y: 56, w: 788 });
        stickerLayout = title.h <= 100 ? 'phraseOneLine' : 'phraseTwoLine';
      }
      if (stickerLayout === 'default') {
        // Cam's default is a ONE-line 90/100 title over the body at y216. A discount offer that
        // wraps at 90 in the 788 box ("Get 20% Off Your Next Visit") would land its second line
        // on the body, so it takes the two-line layout instead (copy unchanged).
        const L = setText(title, { ...MEDIUM, fs: 90, lh: 100, ch: copy.stickerTitle, x: 56, y: 56, w: 788 });
        if (L && L.lines.length > 1) stickerLayout = 'defaultTwoLine';
      }
      if (stickerLayout === 'default') {
        setText(body, { ...SEMIBOLD, fs: 50, lh: 60, ch: copy.stickerBody, x: 56, y: 216, w: 788 });
        summary.stickerTitleSize = 90;
      } else if (stickerLayout === 'phraseOneLine') {
        setText(title, { ...MEDIUM, fs: 82, lh: 'AUTO', ch: copy.stickerTitle, x: 56, y: 56, w: 788 });
        setText(body, { ...SEMIBOLD, fs: 50, lh: 60, ch: copy.stickerBody, x: 56, y: 216, w: 788 });
        summary.stickerTitleSize = 82;
      } else {
        summary.stickerTitleSize = twoLine(title, body);
      }
      summary.stickerTitleLines = Math.max(1, Math.round(title.h / lineHeightPx(title.text.lh, title.text.fs, loadFont(title.text.fam, title.text.sty))));
      summary.stickers += 1;
    }
  }
  summary.stickerLayout = stickerLayout;
  for (const sheet of sheets.filter((s) => /^Print Sheet - POP Sign/.test(s.n))) {
    for (const f of sheet.k.filter((c) => c.t === 'FRAME' && c.w === 1500 && c.h === 2100)) {
      const texts = f.k.filter((t) => t.t === 'TEXT').sort((a, b) => a.y - b.y);
      const [title, body] = texts;
      if (!title || !body) continue;
      let size = 140;
      setText(title, { ...MEDIUM, fs: size, lh: 150, ch: copy.headline, x: 120, y: 180, w: 1260 });
      while (title.h > 150 && size > 80) { size -= 10; title.text.fs = size; measureText(title); }
      let bodyY = 420;
      if (title.h > 150) {
        for (size = 130; size >= 80; size -= 10) {
          const lh = Math.round(size * 1.15);
          title.text.fs = size; title.text.lh = lh; measureText(title);
          if (title.h <= 2 * lh + 1) break;
        }
        bodyY = 180 + title.h + 90; // the template's own title-to-body gap (420 - 180 - 150), as the review mocks draw it
        summary.popTitleLines = 2;
      }
      summary.popTitleSize = size;
      setText(body, { ...MEDIUM, fs: 70, lh: 85, ch: copy.popBody, x: 120, y: bodyY, w: 1260 });
      summary.popSigns += 1;
    }
  }
  return { copy, summary };
}

// Style A framed QR to-go labels (Travisse 2026-10-05), as the closeout clone call builds them.
export function rebuildTogo(sec, headlines) {
  const out = {};
  for (const [key, chars] of Object.entries(headlines)) {
    const sheetName = key === 'togoPromo' ? 'Print Sheet - To-Go Label - promo - Black' : 'Print Sheet - To-Go Label - review - Black';
    const sheet = sec.k.find((n) => n.n === sheetName);
    if (!sheet) throw new Error(`missing ${sheetName}`);
    const t = sheet.k.find((n) => n.t === 'TEXT');
    t.text = { fam: 'Figtree', sty: 'Bold', fs: 150, lh: { pct: 96 }, ls: -2, ah: 'LEFT', av: 'CENTER', ar: 'HEIGHT', ch: chars };
    t.n = chars; t.f = [{ c: '#000000' }];
    const longest = chars.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    let size = 150;
    for (;;) {
      t.text.fs = size; t.w = 860;
      const L = layoutText(chars, { ...t.text, w: 860, h: 10 });
      const lines = Math.round(L.boxH / (size * 0.96));
      const probe = layoutText(longest, { ...t.text, ar: 'WIDTH_AND_HEIGHT' });
      if ((L.boxH <= 500 && lines <= 3 && probe.boxW <= 860) || size <= 56) { t.h = L.boxH; break; }
      size -= 2;
    }
    t.text.ar = 'NONE'; t.w = 860; t.h = 500; t.x = 72; t.y = 56;
    const tile = sheet.k.find((n) => n.t === 'RECTANGLE' && /qr-tile|qr-frame/.test(n.n));
    tile.n = 'qr-frame'; tile.w = 500; tile.h = 500; tile.x = 982; tile.y = 56; tile.cr = 28; tile.f = [{ c: '#ffffff' }]; tile.s = [{ c: '#000000' }]; tile.sw = 3; tile.sa = 'INSIDE';
    const qr = sheet.k.find((n) => n.t === 'FRAME' && n.n === 'qr');
    qr.w = 468; qr.h = 468; qr.x = 998; qr.y = 72;
    sheet.k = sheet.k.filter((n) => n.n !== 'logo');
    out[key] = { size };
  }
  return out;
}

export function strokeGate(sec) {
  const fixed = [];
  for (const sheet of sec.k.filter((n) => /Print Sheet/i.test(n.n))) {
    for (const f of (sheet.k || []).filter((n) => n.t === 'FRAME' && ((n.w === 900 && n.h === 900) || (n.w === 1500 && n.h === 2100)))) {
      const s = (f.s || []).find((p) => p.c);
      const ok = s && s.c.toLowerCase() === '#000000' && f.sw === 1 && f.sa === 'INSIDE';
      if (!ok) { f.s = [{ c: '#000000' }]; f.sw = 1; f.sa = 'INSIDE'; fixed.push(`${sheet.n} / ${f.n}`); }
    }
  }
  return fixed;
}

// Fill the empty qr holders from the per-location SVG masters (plan.json qr block).
export function placeQrs(sec, qrFiles) {
  const placed = {};
  const holders = findAll(sec, (n) => n.t === 'FRAME' && n.n === 'qr');
  for (const h of holders) {
    const owner = findAll(sec, (n) => (n.k || []).includes(h))[0];
    const key = UNIT_QR[owner.unitName || owner.n];
    if (!key) throw new Error(`no QR key for holder under ${owner.n}`);
    const file = qrFiles[key];
    if (!file) throw new Error(`missing QR svg for ${key}`);
    const { node, moduleCount, moduleSize } = qrSvgToNodes(file, key, h.w);
    h.k = [node];
    placed[key] = placed[key] || { count: 0, moduleCount, moduleSize, holder: h.w, file };
    placed[key].count += 1;
  }
  return placed;
}

// Logo image fills: every "logo" rectangle takes the sticker logo except the POP primary sign.
export function placeLogos(sec, { sticker, popPrimary, header }) {
  const placed = { sticker: 0, popPrimary: 0, header: 0 };
  for (const r of findAll(sec, (n) => n.t === 'RECTANGLE' && n.n === 'logo' && (n.f || []).some((f) => f.img !== undefined || f.imgFile))) {
    const owner = findAll(sec, (n) => (n.k || []).includes(r))[0];
    let file = sticker, which = 'sticker';
    if (owner === sec) { file = header || sticker; which = 'header'; }
    else if ((owner.unitName || owner.n) === 'pop-sign-primary') { file = popPrimary; which = 'popPrimary'; }
    if (!file) throw new Error(`no logo file for ${which}`);
    r.f = r.f.map((f) => (f.img !== undefined || f.imgFile ? { imgFile: path.resolve(file), sm: f.sm || 'FIT' } : f));
    placed[which] += 1;
  }
  return placed;
}

// PNG pixel size from the IHDR chunk (no image library needed); null for anything else.
export function pngSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    if (b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch { return null; }
}

export const PANEL_PAD = 0.28; // of the mark height, every side
export const PANEL_RADIUS = 0.2; // of the box height
export const PANEL_STEPS = 48; // gradient stripes (the renderer has no shading primitive)

// Authored panel or gradient behind the mark on LIGHT surfaces (table stickers, light POP):
// the asset stays transparent; a rounded box filled with the panel colour sits under the logo
// holder, padded 28% of the mark height on every side, radius 20% of the box height. The logo
// rectangle shrinks to the fitted mark so the box hugs the mark, centred in the template holder.
// panel: { hex } | { gradient: [top, bottom] } | null. Dark grounds (POP primary) and the
// unprinted section header are left alone.
export function placeLogoPanels(sec, panel, logos = {}) {
  if (!panel) return { placed: 0 };
  const top = panel.gradient ? hex(panel.gradient[0]) : hex(panel.hex);
  const bottom = panel.gradient ? hex(panel.gradient[1]) : null;
  const src = logos.sticker ? pngSize(logos.sticker) : null;
  let placed = 0;
  for (const r of findAll(sec, (n) => n.t === 'RECTANGLE' && n.n === 'logo' && (n.f || []).some((f) => f.img !== undefined || f.imgFile))) {
    const owner = findAll(sec, (n) => (n.k || []).includes(r))[0];
    if (owner === sec) continue;
    const unit = owner.unitName || owner.n;
    if (unit === 'pop-sign-primary') continue;
    const ar = src && src.w && src.h ? src.w / src.h : r.w / r.h;
    // fitted mark height: height-bound h/(1+2p), width-bound w/(ar+2p); the smaller wins
    const dh = Math.min(r.h / (1 + 2 * PANEL_PAD), r.w / (ar + 2 * PANEL_PAD));
    const dw = dh * ar;
    const pad = PANEL_PAD * dh;
    const bw = dw + 2 * pad, bh = dh + 2 * pad;
    const bx = r.x + (r.w - bw) / 2, by = r.y + (r.h - bh) / 2;
    const box = { t: 'RECTANGLE', n: 'logo-panel', x: bx, y: by, w: bw, h: bh, cr: PANEL_RADIUS * bh, f: [{ c: top }] };
    if (bottom) {
      // vertical gradient as clipped stripes: a FRAME with clip + rounded corners, no fill
      box.t = 'FRAME'; box.f = []; box.clip = true; box.k = [];
      const c1 = rgb(top), c2 = rgb(bottom);
      const stepH = bh / PANEL_STEPS;
      for (let i = 0; i < PANEL_STEPS; i += 1) {
        const t = PANEL_STEPS === 1 ? 0 : i / (PANEL_STEPS - 1);
        const c = '#' + [0, 1, 2].map((k) => Math.round(c1[k] + (c2[k] - c1[k]) * t).toString(16).padStart(2, '0')).join('');
        box.k.push({ t: 'RECTANGLE', n: `stripe-${i}`, x: 0, y: i * stepH, w: bw, h: stepH + (i < PANEL_STEPS - 1 ? 0.5 : 0), f: [{ c }] });
      }
    }
    Object.assign(r, { x: bx + pad, y: by + pad, w: dw, h: dh });
    owner.k.splice(owner.k.indexOf(r), 0, box);
    placed += 1;
  }
  return { placed, panel: bottom ? { gradient: [top, bottom] } : { hex: top }, surfaces: ['table-sticker-promo', 'table-sticker-review', 'pop-sign-light'] };
}

function rgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }

// The whole retarget. opts: { name, status, date, band, offer, mode, tables, stalls, qrFiles,
// logos: { sticker, popPrimary, header }, togo: { togoPromo, togoReview }, logoPanel }
export function buildSection(opts, spec = loadTemplateSpec()) {
  const sec = expandRefs(spec);
  const band = hex(opts.band);
  const log = {};
  sec.n = `${opts.name} - generated production sheets ${opts.date}`;
  const title = sec.k.find((n) => n.t === 'TEXT' && n.text.fs === 132);
  if (title) { title.text.ch = opts.name; title.n = opts.name; measureText(title); }
  const status = sec.k.find((n) => n.t === 'TEXT' && n.text.fs === 150);
  if (status) { status.text.ch = opts.status || 'GENERATED - REVIEW BEFORE PRINT'; status.n = status.text.ch; measureText(status); }
  log.recolored = recolor(sec, TEMPLATE_BAND, band).n;
  // light band: every white text fill (band copy, POP primary copy and legal) takes the band ink
  // so the words stay legible on a light band; QR tiles and panels are not TEXT and keep white
  if (opts.bandInk) {
    const ink = hex(opts.bandInk);
    let n = 0;
    for (const t of findAll(sec, (x) => x.t === 'TEXT')) for (const f of t.f || []) if (f.c && f.c.toLowerCase() === '#ffffff') { f.c = ink; n += 1; }
    log.bandInk = { ink, recolored: n };
  }
  const copy = offerCopy(opts.offer, opts.mode || 'auto');
  log.togo = rebuildTogo(sec, { togoPromo: opts.togo?.togoPromo ?? copy.togoPromo, togoReview: opts.togo?.togoReview ?? 'Let us know how we did' });
  log.trim = trim(sec, opts.tables, opts.stalls);
  log.recopy = recopy(sec, opts.offer, opts.mode || 'auto').summary;
  log.strokeGateFixed = strokeGate(sec);
  // re-measure every remaining text box the passes above did not touch (template heights are
  // the template's; the engine's own measure keeps the tree self-consistent)
  for (const t of findAll(sec, (n) => n.t === 'TEXT')) measureText(t);
  log.qr = placeQrs(sec, opts.qrFiles);
  log.logos = placeLogos(sec, opts.logos);
  log.logoPanel = placeLogoPanels(sec, opts.logoPanel || null, opts.logos);
  return { section: sec, log };
}

export function sheetsOf(sec) {
  return sec.k.filter((n) => /^Print Sheet\s*-/i.test(n.n));
}
