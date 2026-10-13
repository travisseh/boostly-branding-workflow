import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import templates from '../templates/sheet-templates.js';
import { appendCells, cellView, composeSheet, normalizeManifest, qrModules, sheetView, signageCopy } from './variant-sheet.mjs';

const RUN_ROOT = process.env.BOOSTLY_RUN_ROOT || '/Users/travisse/Programming/projects/brand-design-spike-2026-07-06/runs-prod-2026-09-18';
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

test('stickerMockHtml and popTileHtml reproduce the Figma templates (900x900 sticker, 1500x2100 POP) scaled; the QR is the styled closeout code', () => {
  const qr = { url: 'https://tp.boostly.com/KSPM', modules: qrModules('https://tp.boostly.com/KSPM') };
  const a = templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', headline: 'Get 20% Off', qr, size: 900 });
  assert.equal(a, templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', headline: 'Get 20% Off', qr, size: 900 }));
  assert.match(a, /width: 900px; height: 900px; background: #FFFFFF;[^"]*font-family: 'Figtree'[^"]*box-shadow: inset 0 0 0 1px #000000;/, 'white 900 frame, Figtree, 1px inside cut line');
  assert.match(a, /<path d="M0 0H900V429L0 524Z" fill="#8B2C1D"\/>/, 'the band path from plan.mjs');
  assert.match(a, /class="bs-sticker-title" style="position: absolute; left: 56px; top: 56px; width: 788px; font-size: 90px; line-height: 100px; font-weight: 500;[^>]*>Get 20% Off</, 'title Figtree Medium 90/100 at 56/56');
  assert.match(a, /class="bs-sticker-body" style="position: absolute; left: 56px; top: 216px; width: 788px; font-size: 50px; line-height: 60px; font-weight: 600;">Be the first to know\.<br>Receive exclusive deals\.</, 'body Figtree SemiBold 50/60 at y216');
  assert.match(a, /class="bs-sticker-divider" style="position: absolute; left: 446\.5px; top: 420px; width: 7px; height: 440px; background: #8B2C1D;/, 'the 7px divider from y420 (inside the band) to y860');
  assert.match(a, /class="bs-sticker-logo" style="position: absolute; left: 56px; top: 542px; width: 330px; height: 244\.9px;"><img src="l\.png"[^>]*object-fit: contain/, 'logo FIT box');
  assert.match(a, /class="bs-sticker-qr" style="position: absolute; left: 485px; top: 485px; width: 359px; height: 359px; border-radius: 14px; background: #ffffff;"><img src="data:image\/svg\+xml,/, 'QR tile 359 r14');
  const half = templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', qr, size: 150 });
  assert.match(half, /left: 9\.333px; top: 9\.333px; width: 131\.333px; font-size: 15px; line-height: 16\.667px;/, 'everything scales with size');
  const phrase = templates.stickerMockHtml({ logoUrl: 'l.png', band: '#000000', headline: 'Unlock the V.I.P Experience', layout: 'phrase', size: 900 });
  assert.match(phrase, /font-size: 74px; line-height: normal; font-weight: 500;/, 'phrase layout 74/auto');
  assert.match(phrase, /top: 274px; width: 788px; font-size: 42px; line-height: 60px;/, 'phrase body 42/60 at y274');
  // the QR: the closeout's styled SVG (plan.mjs generateStyledSvgQR) of the same matrix
  const svg = templates.styledQrSvg(qr.modules, '#8B2C1D', 600);
  assert.match(svg, /viewBox="0 0 600 600" width="600" height="600"/);
  assert.equal(qr.modules.length, 29, 'tp.boostly.com short links encode to 29 modules at ECC M');
  assert.match(svg, /fill-rule="evenodd"/, 'rounded finder rings');
  assert.ok((svg.match(/<path d="M/g) || []).length > 200, 'one rounded path per module');
  assert.ok(a.includes(encodeURIComponent(svg)), 'the sticker embeds that SVG with band-color modules');
  const master = path.join(RUN_ROOT, 'slice-of-the-80-s-westland', 'signage', 'qr-tablePromo-primary.svg');
  if (fs.existsSync(master)) assert.equal(templates.styledQrSvg(qr.modules, '#0517B8', 600), fs.readFileSync(master, 'utf8'), 'byte-identical to the master the closeout uploaded');
  // no link: the seeded mock matrix drawn the same way
  const mock = templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', seed: 42, size: 900 });
  assert.notEqual(mock, templates.stickerMockHtml({ logoUrl: 'l.png', band: '#8B2C1D', seed: 43, size: 900 }), 'another seed is another mock QR');
  assert.equal(templates.mockQrModules(42).length, 25);
  assert.match(templates.mockQrSvg('#FFFFFF', 4242), /viewBox="0 0 600 600"/);
  assert.equal(templates.seedFrom('abc'), templates.seedFrom('abc'));
  const pop = templates.popTileHtml({ logoUrl: 'l.png', ground: '#0517B8', offer: 'Get 20% Off', body: 'Scan to join our text club|for ongoing offers!', qr, width: 1500 });
  assert.match(pop, /class="bs-pop" style="position: relative; width: 1500px; height: 2100px; background: #0517B8;/);
  assert.match(pop, /class="bs-pop-title" style="position: absolute; left: 120px; top: 180px; width: 1260px; text-align: center; font-size: 140px; line-height: 150px; font-weight: 500;[^>]*>Get 20% Off</, 'title Figtree Medium 140/150 at y180');
  assert.match(pop, /class="bs-pop-body" style="position: absolute; left: 120px; top: 420px; width: 1260px; text-align: center; font-size: 70px; line-height: 85px; font-weight: 500;">Scan to join our text club<br>for ongoing offers!</);
  assert.match(pop, /class="bs-pop-qr" style="position: absolute; left: 412\.5px; top: 802px; width: 675px; height: 675px;"><img src="data:image\/svg\+xml,/);
  assert.ok(pop.includes(encodeURIComponent(templates.styledQrSvg(qr.modules, '#FFFFFF', 600))), 'white modules on the primary sign');
  assert.match(pop, /class="bs-pop-logo" style="position: absolute; left: 539\.6px; top: 1607\.6px; width: 421px; height: 312px;"/, 'the primary sign logo box');
  assert.match(pop, /class="bs-pop-legal" style="position: absolute; left: 120px; top: 1988px; width: 1260px; text-align: center; font-size: 26px; line-height: 32px; font-weight: 500;">Consent not req&#39;d for purchase\. Msg &amp; data rates may apply\. Freq varies\. Text STOP to end &amp; HELP for help\. Terms &amp; Privacy: boostly\.com\/mobile-terms-of-use</);
  const small = templates.popTileHtml({ logoUrl: 'l.png', ground: '#0517B8', offer: '20% OFF', width: 300 });
  assert.match(small, /width: 300px; height: 420px;/);
  assert.match(small, /font-size: 28px; line-height: 30px; font-weight: 500;[^>]*>20% OFF</, 'title at 140/1500 of the width');
  assert.match(small, /Scan to join our VIP text club<br>for ongoing offers!/, 'generic body by default');
  assert.match(templates.popTileHtml({ logoUrl: 'l.png', ground: '#000', offer: '<b>&' }), />&lt;b&gt;&amp;</, 'offer is escaped');
  assert.match(templates.pageHtml('<p>x</p>'), /fonts\.googleapis\.com\/css2\?family=Figtree:wght@400;500;600;700/, 'pages load Figtree');
  assert.doesNotMatch(templates.pageHtml('<p>x</p>', { fonts: false }), /googleapis/);
});

test('signageCopy prints what the closeout prints', () => {
  assert.deepEqual(signageCopy('20% OFF'), { sticker: { title: 'Get 20% Off', body: 'Be the first to know.|Receive exclusive deals.', layout: 'default' }, pop: { title: 'Get 20% Off', body: 'Scan to join our text club|for ongoing offers!' } });
  assert.equal(signageCopy('Get 20% Off!').sticker.title, 'Get 20% Off', 'a typed "Get ... !" normalizes to the discount');
  assert.equal(signageCopy('$10 OFF').pop.title, 'Get $10 Off');
  assert.equal(signageCopy('Join the club!').pop.body, 'Scan to join our VIP text club|for ongoing offers!');
  assert.equal(signageCopy(null).sticker.title, 'Join the club!');
  const phrase = signageCopy('Unlock the V.I.P Experience');
  assert.equal(phrase.sticker.layout, 'phrase');
  assert.equal(phrase.sticker.title, 'Unlock the V.I.P Experience');
  assert.equal(signageCopy("Tillie's Specials").sticker.layout, 'phrase_one_line');
  const review = signageCopy('Had a good time? Let us know!');
  assert.equal(review.sticker.title, 'Join the club!', 'review phrases are POP-only');
  assert.equal(review.pop.title, 'Had a good time? Let us know!');
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
  assert.equal(view.sticker.headline, 'Get 20% Off', 'the closeout sticker title for the offer');
  assert.equal(view.sticker.layout, 'default');
  assert.equal(view.sticker.qr, null, 'no links on a sample run: the tile draws the seeded mock');
  assert.deepEqual(view.pop, { logo: 'candidates/k.png', ground: '#0517B8', offer: 'Get 20% Off', body: 'Scan to join our text club|for ongoing offers!', qr: null });
  manifest.qr_links = { table_promo: 'https://tp.boostly.com/KSPM', pop: 'https://tp.boostly.com/FMWJ', source: 'test' };
  const linked = cellView(manifest, manifest.cells.A);
  assert.equal(linked.sticker.qr.url, 'https://tp.boostly.com/KSPM');
  assert.equal(linked.sticker.qr.modules.length, 29);
  assert.equal(linked.pop.qr.url, 'https://tp.boostly.com/FMWJ');
  manifest.qr_links = null;
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
