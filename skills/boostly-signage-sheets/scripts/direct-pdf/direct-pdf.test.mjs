// node --test direct-pdf.test.mjs : layout calibration, QR parsing, retarget rules, and a render smoke test.
// No network, no run dir; fixtures are built in a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { layoutText, baselineOffset } from './lib/text-layout.mjs';
import { loadFont } from './lib/fonts.mjs';
import { qrSvgToNodes, parsePath } from './lib/qr-nodes.mjs';
import { buildSection, offerCopy, trim, expandRefs, loadTemplateSpec, sheetsOf } from './lib/retarget.mjs';
import { PdfRenderer, savePdf, roundedRectPath, svgPathToOps } from './lib/pdf-render.mjs';
import { classify, orderFrames } from './lib/kinds.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

// Baselines measured in Figma's own PDF text layer (Scoops section 3:2, 2026-10-15).
test('baseline offsets match Figma for every production text style', () => {
  const med = loadFont('Figtree', 'Medium'), semi = loadFont('Figtree', 'SemiBold'), bold = loadFont('Figtree', 'Bold');
  assert.equal(baselineOffset(100, 90, med), 82);
  assert.equal(baselineOffset(60, 50, semi), 48);
  assert.equal(baselineOffset(80, 70, semi), 65);
  assert.equal(baselineOffset(150, 140, med), 124);
  assert.equal(baselineOffset(85, 70, med), 67);
  assert.equal(baselineOffset(32, 26, med), 25);
  assert.equal(baselineOffset(144, 150, bold), 125);
});

test('centered POP title and wrapped legal line land where Figma put them', () => {
  const title = layoutText('Get 20% Off', { fam: 'Figtree', sty: 'Medium', fs: 140, lh: 150, ls: 0, ah: 'CENTER', av: 'TOP', ar: 'HEIGHT', w: 1260, h: 150 });
  assert.equal(title.lines.length, 1);
  assert.ok(Math.abs(title.lines[0].x - 230.508) < 0.02, `title x ${title.lines[0].x}`); // Figma text layer x 875.508 - (525 sign + 120 box)
  assert.equal(title.lines[0].baseline, 124);
  const legal = layoutText("Consent not req'd for purchase. Msg & data rates may apply. Freq varies. Text STOP to end & HELP for help. Terms & Privacy: boostly.com/mobile-terms-of-use", { fam: 'Figtree', sty: 'Medium', fs: 26, lh: 32, ls: 0, ah: 'CENTER', av: 'TOP', ar: 'HEIGHT', w: 1260, h: 64 });
  assert.equal(legal.lines.length, 2);
  assert.equal(legal.lines[0].text.endsWith('for help. '), true);
  assert.ok(Math.abs(legal.lines[0].x - 5.022) < 0.2, `legal x ${legal.lines[0].x}`); // 4.88: Figma measures this 105-glyph line 0.28 px shorter (known, sub-pixel)
  assert.ok(Math.abs(legal.lines[1].x - (975.886 - 645)) < 0.2, `legal line 2 x ${legal.lines[1].x}`);
  assert.equal(legal.boxH, 64);
});

test('auto-width boxes round up to the pixel like Figma (624, 419) and the to-go label centers two lines', () => {
  const body = layoutText("We'd love to hear from you.\nScan to leave us a review.", { fam: 'Figtree', sty: 'SemiBold', fs: 50, lh: 60, ls: 0, ah: 'LEFT', av: 'TOP', ar: 'WIDTH_AND_HEIGHT' });
  assert.equal(body.boxW, 624); assert.equal(body.boxH, 120);
  const bath = layoutText('Enjoyed your\nmeal?', { fam: 'Figtree', sty: 'SemiBold', fs: 70, lh: 80, ls: 0, ah: 'LEFT', av: 'TOP', ar: 'WIDTH_AND_HEIGHT' });
  assert.equal(bath.boxW, 419);
  const togo = layoutText('Let us know how we did', { fam: 'Figtree', sty: 'Bold', fs: 150, lh: { pct: 96 }, ls: -2, ah: 'LEFT', av: 'CENTER', ar: 'NONE', w: 860, h: 500 });
  assert.equal(togo.lines.length, 2);
  assert.equal(togo.lines[0].baseline, 231); // 287 absolute - 56
  assert.equal(togo.lines[1].baseline, 375);
  const emoji = layoutText('Scan for a deal 👉', { fam: 'Figtree', sty: 'SemiBold', fs: 70, lh: 80, ls: 0, ah: 'LEFT', av: 'TOP', ar: 'WIDTH_AND_HEIGHT' });
  const last = emoji.lines[0].glyphs.at(-1);
  assert.equal(last.kind, 'emoji');
  assert.ok(Math.abs(last.x - 486.787) < 0.5, `emoji x ${last.x}`); // Figma drew its bitmap at 606.787 - 120
});

// A minimal styled QR SVG in the generator's exact markup: 3 modules + 3 finder pairs.
function fixtureSvg(color = '#112233', size = 600, moduleCount = 21) {
  const ms = size / (moduleCount + 4);
  const r = ms * 0.4;
  const mod = (x, y, s, rr) => `M${x + rr},${y} L${x + s - rr},${y} Q${x + s},${y} ${x + s},${y + rr} L${x + s},${y + s - rr} Q${x + s},${y + s} ${x + s - rr},${y + s} L${x + rr},${y + s} Q${x},${y + s} ${x},${y + s - rr} L${x},${y + rr} Q${x},${y} ${x + rr},${y} Z`;
  const modules = [[8, 2], [9, 2], [10, 7]].map(([c, rw]) => `<path d="${mod((c + 2) * ms, (rw + 2) * ms, ms, r)}"/>`).join('\n    ');
  const finder = (row, col) => { const x = (col + 2) * ms, y = (row + 2) * ms; return `\n      <path d="${mod(x, y, 7 * ms, ms * 0.8)} ${mod(x + ms, y + ms, 5 * ms, ms * 0.6)}" fill="${color}" fill-rule="evenodd"/>\n      <path d="${mod(x + 2 * ms, y + 2 * ms, 3 * ms, ms * 0.4)}" fill="${color}"/>\n    `; };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n  <g fill="${color}">\n    ${modules}\n  </g>\n  ${finder(0, 0)}\n${finder(0, moduleCount - 7)}\n${finder(moduleCount - 7, 0)}\n</svg>`;
}

test('styled QR svg becomes the Figma import tree, scaled to the holder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
  const f = path.join(dir, 'qr-tablePromo-primary.svg');
  fs.writeFileSync(f, fixtureSvg());
  const { node, moduleCount, moduleSize, modules } = qrSvgToNodes(f, 'qr-tablePromo-primary', 359);
  assert.equal(moduleCount, 21); assert.equal(modules, 3);
  assert.ok(Math.abs(moduleSize - 359 / 25) < 1e-6);
  assert.equal(node.k.length, 7);
  assert.equal(node.k[0].t, 'GROUP');
  assert.equal(node.k[1].vp[0].windingRule, 'EVENODD');
  const first = node.k[0].k[0];
  assert.ok(Math.abs(first.w - moduleSize) < 0.001);
  assert.ok(/^M.*C.*Z$/.test(first.vp[0].data) && !/Q/.test(first.vp[0].data), 'quadratics converted to cubics');
  assert.equal(parsePath('M0,0 L10,0 Q10,10 0,10 Z').length, 4);
});

test('offer copy rules and trim counts follow plan.mjs and figma-trim', () => {
  assert.deepEqual(offerCopy('Get 20% Off!').headline, 'Get 20% Off');
  assert.equal(offerCopy('$10 OFF').stickerTitle, 'Get $10 Off');
  assert.equal(offerCopy('Join the Club!').kind, 'generic');
  assert.equal(offerCopy('Unlock the V.I.P Experience').kind, 'phrase');
  assert.equal(offerCopy('Had a good time? Let us know!').reviewPhrase, true);
  const sec = expandRefs(loadTemplateSpec());
  const t = trim(sec, 8, 1);
  assert.equal(t.removedSheets.length, 4);
  assert.equal(t.removedStickers.length, 6);
  assert.equal(sheetsOf(sec).length, 10);
  assert.equal(t.remaining.bathroomReview[0].y, 798.4 + 2929);
  assert.throws(() => trim(expandRefs(loadTemplateSpec()), 0, 1), /allowZero/);
  assert.throws(() => trim(expandRefs(loadTemplateSpec()), 13, 1), /cannot add/);
});

test('buildSection renders a vector page with the right size, fonts and QR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-'));
  const qrFiles = {};
  for (const k of ['qr-tablePromo-primary', 'qr-tableReview-primary', 'qr-bathroomPromo-white', 'qr-bathroomReview-white', 'qr-pop-primary', 'qr-pop-white', 'qr-togoPromo-black', 'qr-togoReview-black']) {
    qrFiles[k] = path.join(dir, `${k}.svg`);
    fs.writeFileSync(qrFiles[k], fixtureSvg(/white/.test(k) ? '#ffffff' : /black/.test(k) ? '#000000' : '#aa0000'));
  }
  const logo = path.join(dir, 'logo.png');
  await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toFile(logo);
  const { section, log } = buildSection({ name: 'Test Diner (Lehi)', date: '2026-10-15', band: '#aa0000', offer: '20% OFF', tables: 6, stalls: 2, qrFiles, logos: { sticker: logo, popPrimary: logo } });
  assert.equal(log.recopy.kind, 'discount');
  assert.equal(log.togo.togoPromo.size, 150);
  assert.equal(log.strokeGateFixed.length, 0);
  assert.equal(log.recolored > 50, true);
  const sheets = sheetsOf(section);
  const frames = orderFrames(sheets.map((s) => ({ ...classify(s.n), name: s.n, sheet: s })));
  assert.equal(frames.filter((f) => f.kind === 'table-stickers').length, 2);
  assert.equal(frames.find((f) => f.kind === 'table-stickers' && f.page === 2).sheet.k.filter((c) => c.t === 'FRAME').length, 2);
  const togo = sheets.find((s) => /promo - Black/.test(s.n));
  const tt = togo.k.find((n) => n.t === 'TEXT');
  assert.equal(tt.text.ch, 'Get 20% Off'); assert.equal(tt.w, 860); assert.equal(tt.h, 500);
  assert.equal(togo.k.find((n) => n.n === 'qr-frame').sw, 3);
  const renderer = new PdfRenderer();
  const state = await renderer.newDocument();
  const stats = await renderer.renderSheet(state, frames[0].sheet);
  assert.equal(stats.warnings.length, 0, stats.warnings.join('; '));
  assert.ok(stats.glyphs > 100 && stats.images === 4 && stats.vectors >= 40, JSON.stringify(stats)); // 4 bands + 4 x (3 modules + 6 finder paths)
  const out = path.join(dir, 'page.pdf');
  await savePdf(state, out);
  const doc = await PDFDocument.load(fs.readFileSync(out));
  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(width, 2186); assert.equal(height, 2829);
  const raw = fs.readFileSync(out, 'latin1');
  assert.ok(/\/Subtype \/TrueType|\/CIDFontType2/.test(raw), 'embedded TrueType font');
  assert.ok(/\/ICCBased/.test(raw), 'ICC colour space');
  assert.ok(roundedRectPath(0, 0, 10, 10, 2).includes(' c '));
  assert.equal(svgPathToOps('M0 0L9 0L9 9Z', 1, 1), '1 1 m 10 1 l 10 10 l h');
});
