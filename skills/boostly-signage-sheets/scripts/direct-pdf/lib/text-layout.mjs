// Figma-compatible text layout for the direct renderer. Calibrated 2026-10-15 against the
// invisible text layer of Figma's own PDF exports (Scoops Ice Cream section 3:2, File 9):
//   baseline (from the line box top) = round((lineHeight - (asc - desc)) / 2 + asc), with the
//   font's hhea metrics (Figtree: asc 950, desc -250 per 1000). Observed: 90/100 -> 82,
//   50/60 -> 48, 70/80 -> 65, 140/150 -> 124, 70/85 -> 67, 26/32 -> 25, 150/96% -> 125.
//   Lines break at spaces; a trailing space stays on the line but is not measured.
//   CENTER alignment uses the measured line width (no rounding); the x offset is exact.
//   Vertical CENTER (to-go labels): block top = (boxH - lines * lineHeight) / 2.
//   Letter spacing (px) is added after every glyph. Kerning comes from fontkit's GPOS layout.
//   Characters the text font lacks (the "👉" emoji) are shaped with the emoji font and drawn
//   as its bitmap, 1em square, placed so its bottom sits 0.0714em below the baseline (Figma's
//   placement of the Apple Color Emoji bitmap, measured: 70px box at baseline 65 of 80).
import { loadFont, loadEmojiFont } from './fonts.mjs';

export const EMOJI_BASELINE_DROP = 5 / 70;

export function lineHeightPx(lh, fs, fontRec) {
  if (lh === 'AUTO' || lh === undefined || lh === null) {
    const f = fontRec.font;
    return ((f.ascent - f.descent + f.lineGap) / f.unitsPerEm) * fs;
  }
  if (typeof lh === 'object' && lh.pct !== undefined) return (lh.pct / 100) * fs;
  return Number(lh);
}

export function baselineOffset(lhPx, fs, fontRec) {
  const f = fontRec.font;
  const content = ((f.ascent - f.descent) / f.unitsPerEm) * fs;
  return Math.round((lhPx - content) / 2 + (f.ascent / f.unitsPerEm) * fs);
}

function codePoints(str) {
  return Array.from(str);
}

// Shape one paragraph into glyph items. Runs of characters the text font covers go through
// fontkit layout (kerning); anything else (emoji) is shaped with the emoji font.
export function shapeParagraph(text, fontRec, fs, ls) {
  const items = [];
  const font = fontRec.font;
  const upm = font.unitsPerEm;
  const cps = codePoints(text);
  let i = 0;
  while (i < cps.length) {
    const cp = cps[i].codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) { i += 1; continue; } // variation selector / ZWJ: zero width
    const covered = font.hasGlyphForCodePoint(cp);
    let j = i;
    while (j < cps.length) {
      const c = cps[j].codePointAt(0);
      if (c === 0xfe0f || c === 0x200d) { j += 1; continue; }
      if (font.hasGlyphForCodePoint(c) !== covered) break;
      j += 1;
    }
    const run = cps.slice(i, j).filter((c) => { const x = c.codePointAt(0); return x !== 0xfe0f && x !== 0x200d; }).join('');
    if (covered) {
      const lay = font.layout(run);
      lay.glyphs.forEach((g, k) => {
        const pos = lay.positions[k];
        const chars = g.codePoints.length ? String.fromCodePoint(...g.codePoints) : '';
        items.push({ kind: 'glyph', fontRec, glyph: g, gid: g.id, chars, adv: (pos.xAdvance / upm) * fs, xOffset: (pos.xOffset / upm) * fs, nominalAdv: (g.advanceWidth / upm) * fs, isSpace: chars === ' ', ls });
      });
    } else {
      const emoji = loadEmojiFont();
      for (const ch of run) {
        if (!emoji) { items.push({ kind: 'missing', chars: ch, adv: fs, xOffset: 0, nominalAdv: fs, isSpace: false, ls }); continue; }
        const g = emoji.font.glyphForCodePoint(ch.codePointAt(0));
        const adv = (g.advanceWidth / emoji.font.unitsPerEm) * fs;
        items.push({ kind: 'emoji', fontRec: emoji, glyph: g, gid: g.id, chars: ch, adv, xOffset: 0, nominalAdv: adv, isSpace: false, ls, box: fs });
      }
    }
    i = j;
  }
  return items;
}

function measure(items) {
  let end = items.length;
  while (end > 0 && items[end - 1].isSpace) end -= 1;
  let w = 0;
  for (let k = 0; k < end; k += 1) w += items[k].adv + items[k].ls;
  return w;
}

// Greedy word wrap at spaces into a fixed width. Explicit newlines were split by the caller.
function wrap(items, maxWidth) {
  if (maxWidth === Infinity) return [items];
  const lines = [];
  let line = [];
  let k = 0;
  while (k < items.length) {
    // next word = run of non-spaces followed by its trailing spaces
    let e = k;
    while (e < items.length && !items[e].isSpace) e += 1;
    while (e < items.length && items[e].isSpace) e += 1;
    const word = items.slice(k, e);
    const candidate = line.concat(word);
    if (line.length && measure(candidate) > maxWidth + 1e-6) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    k = e;
  }
  lines.push(line);
  return lines;
}

// style: { fam, sty, fs, lh ('AUTO' | px | {pct}), ls, ah, av, ar, w, h }
// Returns box size and per-line glyph positions relative to the box's top-left.
export function layoutText(text, style) {
  const fontRec = loadFont(style.fam, style.sty);
  const fs = style.fs;
  const ls = style.ls || 0;
  const lhPx = lineHeightPx(style.lh, fs, fontRec);
  const base = baselineOffset(lhPx, fs, fontRec);
  const fixedWidth = style.ar === 'WIDTH_AND_HEIGHT' ? Infinity : style.w;
  const paragraphs = String(text).split('\n');
  const lines = [];
  for (const p of paragraphs) {
    const items = shapeParagraph(p, fontRec, fs, ls);
    for (const l of wrap(items, fixedWidth)) lines.push({ items: l, width: measure(l), text: l.map((it) => it.chars).join('') });
  }
  const blockH = lines.length * lhPx;
  // Box: WIDTH_AND_HEIGHT hugs the content (trailing letter spacing included, like Figma);
  // HEIGHT keeps the width and hugs the height; NONE keeps both.
  let boxW = style.w;
  // Figma reports an auto-width box at the next whole pixel (624 for a 623.3 line).
  if (style.ar === 'WIDTH_AND_HEIGHT') boxW = Math.ceil(Math.max(...lines.map((l) => l.items.reduce((a, it) => a + it.adv + it.ls, 0)), 0) - 1e-6);
  let boxH = style.h;
  if (style.ar === 'WIDTH_AND_HEIGHT' || style.ar === 'HEIGHT') boxH = blockH;
  let y0 = 0;
  if (style.av === 'CENTER') y0 = (boxH - blockH) / 2;
  else if (style.av === 'BOTTOM') y0 = boxH - blockH;
  const placed = lines.map((l, k) => {
    let x0 = 0;
    if (style.ah === 'CENTER') x0 = (boxW - l.width) / 2;
    else if (style.ah === 'RIGHT') x0 = boxW - l.width;
    const baseline = y0 + k * lhPx + base;
    let pen = x0;
    const glyphs = l.items.map((it) => { const g = { ...it, x: pen + it.xOffset, y: baseline }; pen += it.adv + it.ls; return g; });
    return { text: l.text, width: l.width, x: x0, baseline, lineTop: y0 + k * lhPx, glyphs };
  });
  return { boxW, boxH, lineHeight: lhPx, baselineOffset: base, lines: placed, fontRec, fs, ls };
}
