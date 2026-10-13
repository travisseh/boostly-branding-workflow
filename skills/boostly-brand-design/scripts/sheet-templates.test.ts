import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import templates from '../templates/sheet-templates.js';
import { appendCells, cellView, composeSheet, normalizeManifest, sheetView } from './variant-sheet.mjs';
import { signageSpecFor } from './signage-preview.mjs';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'harness', 'package.json'));
const sharp = require('sharp');

// ---- the vendored templates are pure functions of JSON --------------------------------------------
test('badgeCardHtml reproduces generate-badge-html.ts: 216x336 card, lanyard slot, issue circle, logo box, tap icon, accent strip', () => {
  const html = templates.badgeCardHtml({ logoUrl: '../candidates/k.png', primary: '#0517B8', secondary: '#B56CAD', text: '#FFFFFF', textSecondary: '#000000', issueId: 7, side: 'back' });
  assert.match(html, /width: 216px; height: 336px; border-radius: 12px; overflow: hidden; background-color: #0517B8;/);
  assert.match(html, /width: 56px; height: 8px; margin: 0 auto; border-radius: 9999px; background-color: white;/, 'lanyard slot');
  assert.match(html, /width: 32px; height: 32px; border-radius: 50%; background-color: #B56CAD;[\s\S]*?color: #000000; font-size: 16px; font-weight: 600;[\s\S]*?>7</, 'issue circle in the secondary with the digit color');
  assert.match(html, /top: 52px; left: 0; right: 0; width: 58.33%; height: 56px;[\s\S]*?<img src="\.\.\/candidates\/k\.png"/, 'logo box');
  assert.match(html, /viewBox="0 0 489.3 489.3" width="52" height="52" fill="#FFFFFF"/, 'scan icon on the back');
  assert.match(html, />Tap for Options</);
  assert.match(html, /bottom: 0; left: 0; width: 100%; height: 80px; background-color: #B56CAD;/, 'accent strip');
  const front = templates.badgeCardHtml({ primary: '#000000', secondary: '#111111', side: 'front', qrDataUrl: 'data:image/png;base64,AA==' });
  assert.match(front, />Scan for Options</);
  assert.doesNotMatch(front, /Tap for Options/);
  assert.doesNotMatch(front, /<img src="[^"]*candidates/, 'no logo box without a logo');
  const defaults = templates.badgeCardHtml({});
  assert.match(defaults, /background-color: #6b7280;/, 'BADGE_DEFAULT_PRIMARY');
  assert.match(defaults, />1</, 'issue id defaults to 1 like the harness');
});

test('badgeShotHtml frames the card like the harness shot box and scales with width', () => {
  const full = templates.badgeShotHtml({ logoUrl: 'x.png', primary: '#000000', secondary: '#111111', text: '#FFFFFF' }, { width: 386 });
  assert.match(full, /class="bs-badge-shot" style="position: relative; width: 386px; height: 600px; background: #ffffff;/);
  assert.match(full, /scale\(1\.785714\)/);
  const sheet = templates.badgeShotHtml({ logoUrl: 'x.png', primary: '#000000', secondary: '#111111', text: '#FFFFFF' }, { width: 260 });
  assert.match(sheet, /width: 260px; height: 404px;/, 'the sheet tile is 260 wide, 404 tall (772:1200)');
});

test('stickerMockHtml and popTileHtml reproduce the mock geometry; the mock QR is seeded and deterministic', () => {
  const a = templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', seed: 42, size: 720 });
  const b = templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', seed: 42, size: 720 });
  assert.equal(a, b);
  assert.notEqual(a, templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', seed: 43, size: 720 }), 'another seed is another mock QR');
  assert.match(a, /clip-path: polygon\(0 0, 100% 0, 100% 47%, 0 59%\)/, 'diagonal band');
  assert.match(a, /font-size: 59\.04px; font-weight: 500;/, 'headline at 8.2% of the size');
  assert.match(a, /<div>Be the first to know\.<\/div><div>Receive exclusive deals\.<\/div>/);
  assert.match(a, /width: 2px; align-self: stretch; background: #8B2C1D;/, 'divider in the band color');
  assert.equal(templates.seedFrom('abc'), templates.seedFrom('abc'));
  assert.notEqual(templates.seedFrom('abc'), templates.seedFrom('abd'));
  const qr = templates.mockQrSvg('#FFFFFF', 4242);
  assert.match(qr, /^<svg [^>]*viewBox="-0\.2 -0\.2 25\.4 25\.4"[^>]*fill="#FFFFFF"/);
  assert.match(qr, /<path d="m0 0h1v1h-1z/, 'finder pattern starts at the origin');
  const pop = templates.popTileHtml({ logoUrl: 'l.png', ground: '#0517B8', offer: '20% OFF', width: 300 });
  assert.match(pop, /width: 300px; height: 420px; background: #0517B8;/);
  assert.match(pop, /font-size: 28px; line-height: 30px; font-weight: 500;">20% OFF</, 'title at 140/1500 of the width');
  assert.match(pop, /class="bs-pop-qr" style="position: absolute; left: 82\.5px; top: 160\.4px; width: 135px; height: 135px;"/, 'QR box from the plan geometry; the image itself lives once in the CSS');
  assert.match(templates.SHEET_CSS, /\.bs-pop-qr \{ background: url\("data:image\/svg\+xml,/);
  assert.match(pop, /Consent not req'd for purchase\. Msg &amp; data rates may apply\./);
  assert.match(templates.popTileHtml({ logoUrl: 'l.png', ground: '#000', offer: '<b>&' }), />&lt;b&gt;&amp;</, 'offer is escaped');
});

test('signagePreviewHtml draws the four onboarding pieces with the vendored QR matrix and the harness shot size', () => {
  const html = templates.signagePreviewHtml({ logoUrl: 'k.png', logoLightUrl: 's.png', primary: '#0517B8', accent: '#C94689', offer: 'Get 20% Off' });
  for (const id of ['pop', 'tapcard', 'table', 'bathroom']) assert.match(html, new RegExp(`data-piece="${id}"`));
  assert.match(html, /height: 36rem; transform: perspective\(1200px\) rotateY\(18deg\)/, 'POP: 8in tall, tilted 18');
  assert.match(html, /height: 20\.25rem; transform: perspective\(1200px\) rotateY\(10deg\)/, 'tapcard: 4.5in');
  assert.match(html, /height: 15\.75rem; transform: perspective\(1200px\) rotateY\(-10deg\)/, 'table: 3.5in');
  assert.match(html, /height: 13\.5rem; transform: perspective\(1200px\) rotateY\(-18deg\)/, 'bathroom: 3in');
  assert.match(html, /margin-left: -21px;/, 'overlap');
  assert.match(html, /background-color: #C94689; color: #000000; font-size: clamp\(0\.4rem, 10\.5cqi, 1\.4rem\);">1</, 'issue circle: accent with computeTextColor (black on that pink), tapcard fontScale 2.1');
  assert.match(html, /<img src="s\.png"[^>]*alt=""/, 'the table sticker takes the on-white logo');
  assert.match(html, /Scan to join our VIP text club/);
  assert.match(html, /Your phone&#8217;s already out&hellip;/);
  assert.match(html, />Scan for a deal</);
  const layout = templates.signageLayout();
  assert.ok(Math.abs(layout.shotWidthRem * 16 - 1271) < 2, `shot width ${layout.shotWidthRem * 16}`);
  assert.ok(Math.abs(layout.shotHeightRem * 16 - 729) < 2, `shot height ${layout.shotHeightRem * 16}`);
  assert.equal(templates.SIGNAGE_QR_ROWS.length, 33);
  assert.ok(templates.SIGNAGE_QR_ROWS.every((r) => r.length === 33 && /^[01]+$/.test(r)));
  assert.match(templates.signageQrSvg('#ffffff'), /viewBox="0 0 37 37"/, '2-module quiet zone like qrcode margin:2');
  const vip = templates.signagePreviewHtml({ primary: '#000000', accent: '#111111', offer: 'x', bathroomCopy: 'Join the VIP\nclub' });
  assert.match(vip, />Join the VIP<br>club</);
  assert.equal(templates.computeTextColor('#FFFFFF'), '#000000');
  assert.equal(templates.computeTextColor('#0517B8'), '#ffffff');
});

// ---- the JSON contract: cell views, sheet view, inline data block, signage spec -----------------------
function sampleRun() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-run-'));
  fs.mkdirSync(path.join(runDir, 'candidates'));
  fs.mkdirSync(path.join(runDir, 'variants'));
  fs.writeFileSync(path.join(runDir, 'candidates', 'k.png'), '');
  fs.writeFileSync(path.join(runDir, 'candidates', 'sticker.png'), '');
  const manifest = normalizeManifest({
    run_dir: runDir, business_name: 'Sample', primary: '#0517B8', text: '#FFFFFF', print_text_secondary: '#FFFFFF', offer: '20% OFF',
    sticker_logo: path.join(runDir, 'candidates', 'sticker.png'),
    rows: [{ key: 'knockout', label: 'card knockout', logo: path.join(runDir, 'candidates', 'k.png') }],
    columns: [{ index: 0, hex: '#B56CAD', source: 'fable_chosen', label: 'chosen' }, { index: 1, hex: '#C182BA', source: 'logo_ink', label: 'logo ink 39%' }],
    cells: {}, next_letter: 0,
  }, path.join(runDir, 'variants'));
  appendCells(manifest, manifest.rows.flatMap((row) => manifest.columns.map((column) => ({ row, column }))));
  return { runDir, manifest };
}

test('cellView carries everything the browser needs, with run-dir-relative logo paths', () => {
  const { runDir, manifest } = sampleRun();
  const view = cellView(manifest, manifest.cells.A);
  assert.equal(view.letter, 'A');
  assert.deepEqual(view.card, { logo: 'candidates/k.png', primary: '#0517B8', secondary: '#B56CAD', text: '#FFFFFF', text_secondary: '#FFFFFF', issue_id: 1 });
  assert.equal(view.sticker.logo, 'candidates/sticker.png', 'the sheet sticker logo sits on the white sticker');
  assert.equal(view.sticker.band, '#0517B8', 'band = the primary when it passes on white');
  assert.equal(view.sticker.seed, templates.seedFrom('sticker.png#0517B8'), 'same mock QR seed as sticker-mock.mjs');
  assert.deepEqual(view.pop, { logo: 'candidates/k.png', ground: '#0517B8', offer: '20% OFF' });
  assert.equal(view.header.text, "A   #B56CAD Fable's pick   digit 3.68:1 ok");
  assert.equal(view.header.bg, '#1B5E20');
  assert.equal(view.status, null);
  assert.equal(view.not_viable, null);
  assert.equal(view.rejected, false);
  assert.doesNotMatch(JSON.stringify(view), new RegExp(runDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no absolute path in a view');
  // a NOT VIABLE cell and a rejected cell say so in the view
  manifest.cells.B.viability = { pass: false, verdict: 'ink_vanishes_on_card', reasons: [], forced: true, kind: 'cell' };
  manifest.cells.B.status = 'rejected';
  const b = cellView(manifest, manifest.cells.B);
  assert.deepEqual(b.not_viable, { verdict: 'ink_vanishes_on_card' });
  assert.equal(b.rejected, true);
  assert.equal(b.status_tag, 'REJECTED');
  assert.equal(b.header.bg, '#616161');
  // a LOW digit header is red
  manifest.cells.B.status = null;
  manifest.cells.B.badge_digit_web = { pass: false, contrast_with_text: 2.1, fix: '#000000' };
  assert.equal(cellView(manifest, manifest.cells.B).header.bg, '#B71C1C');
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('sheetView derives views for legacy (schema 2) cells and carries header texts; the sheet html embeds it as JSON', async () => {
  const { runDir, manifest } = sampleRun();
  for (const cell of Object.values(manifest.cells)) cell.view = null; // a sheet written before schema 3
  const view = sheetView(manifest);
  assert.deepEqual(view.columns.map((c) => c.text), ["#B56CAD  Fable's pick", '#C182BA  logo ink 39%']);
  assert.deepEqual(view.rows.map((r) => r.text), ['card knockout']);
  assert.deepEqual(Object.keys(view.cells), ['A', 'B']);
  assert.equal(view.cells.B.card.secondary, '#C182BA');
  const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#FFFFFF' } }).png().toBuffer();
  fs.writeFileSync(path.join(runDir, 'candidates', 'k.png'), png);
  fs.writeFileSync(path.join(runDir, 'candidates', 'sticker.png'), png);
  const file = await composeSheet(manifest, path.join(runDir, 'variants'));
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /<img src="\.\.\/candidates\/k\.png" data-logo="candidates\/k\.png"/, 'img src relative to variants/, data-logo keeps the run-dir-relative key for client code');
  const embedded = JSON.parse(/<script type="application\/json" id="variant-sheet-view">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(embedded.cells.A, manifest.cells.A.view);
  assert.equal(manifest.schema, 3);
  assert.equal(manifest.render, 'html');
  assert.equal(manifest.rows[0].logo_rel, 'candidates/k.png');
  const compare = templates.compareHtml(view, ['A', 'B', 'Q']);
  assert.match(compare, /data-letter="A"[\s\S]*data-letter="B"/);
  assert.match(compare, /<h3>Q<\/h3><p>not on the sheet<\/p>/);
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('signageSpecFor takes the cell colors, the card logo and the on-white sticker logo, with overrides', () => {
  const { runDir, manifest } = sampleRun();
  manifest.rows[0].sticker_logo_used = manifest.sticker_logo;
  const spec = signageSpecFor(manifest, 'B');
  assert.equal(spec.logo, 'candidates/k.png');
  assert.equal(spec.logo_light, 'candidates/sticker.png');
  assert.equal(spec.primary, '#0517B8');
  assert.equal(spec.accent, '#C182BA');
  assert.equal(spec.offer, '20% OFF');
  assert.equal(spec.bathroom_copy, null);
  const over = signageSpecFor(manifest, 'A', { offer: 'Get 20% Off', accent: '#c94689', bathroom: 'Join the VIP\\nclub' });
  assert.equal(over.accent, '#C94689');
  assert.equal(over.bathroom_copy, 'Join the VIP\nclub');
  assert.throws(() => signageSpecFor(manifest, 'Z'), /not on the sheet/);
  fs.rmSync(runDir, { recursive: true, force: true });
});
