import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendCells,
  applyMark,
  badgeDigit,
  cacheHas,
  cachePath,
  candidateSecondaries,
  cardFingerprint,
  composeSheet,
  contrast,
  letterFor,
  letterIndex,
  normalizeManifest,
  parseArgs,
  popFingerprint,
  printRolesText,
  rowLabelText,
  stickerBand,
  sheetGeometry,
  shiftLightness,
  stickerFingerprint,
} from './variant-sheet.mjs';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'harness', 'package.json'));
const sharp = require('sharp');

const decision = {
  logo_choice: '/run/evidence/logo-candidates/01.png',
  palette: { web_primary_color: '#8E5DA6', web_secondary_color: '#86D0CE', web_text_color: '#FFFFFF', print_text_secondary_color: '#000000' },
};
const evidence = {
  logo_candidates: [{
    local_path: '/run/evidence/logo-candidates/01.png',
    measured_colors: [
      { hex: '#9260AB', pixel_share: 0.34 }, // near primary: excluded
      { hex: '#86D0CE', pixel_share: 0.08 }, // chosen: deduped
      { hex: '#2B2B2B', pixel_share: 0.06 },
      { hex: '#91DFDD', pixel_share: 0.02 }, // antialias blend under 5%: excluded
    ],
  }],
  website: { authored_color_tokens: [
    { hex: '#FFFFFF', evidence_class: 'theme_authored', semantic_count: 20 }, // near white: excluded
    { hex: '#0D4F3D', evidence_class: 'theme_authored', semantic_count: 5 },
    { hex: '#1976D2', evidence_class: 'framework_default_risk', semantic_count: 9 }, // not authored: excluded
  ] },
};

test('candidate secondaries follow provenance order: chosen, logo inks, site tokens, then the DARKER depth ladder only (Q3 = A: lighter is never a pick)', () => {
  const { primary, chosen, candidates } = candidateSecondaries({ decision, evidence });
  assert.equal(primary, '#8E5DA6');
  assert.equal(chosen, '#86D0CE');
  assert.deepEqual(candidates.map((c) => c.source), ['fable_chosen', 'logo_ink', 'site_token', 'depth_darker_10', 'depth_darker_20']);
  assert.ok(candidates.filter((c) => c.source.startsWith('depth_darker')).every((c) => /allowed when real ink fails contrast/.test(c.label)), 'darker columns say when they are allowed');
  const withLighter = candidateSecondaries({ decision, evidence, allowLighter: true }).candidates;
  assert.deepEqual(withLighter.map((c) => c.source).slice(-1), ['depth_lighter_10'], '--allow-lighter appends the lighter column last');
  assert.match(withLighter.at(-1).label, /never a pick/);
  assert.deepEqual(candidates.slice(0, 3).map((c) => c.hex), ['#86D0CE', '#2B2B2B', '#0D4F3D']);
  assert(!candidates.some((c) => c.hex === '#91DFDD' || c.hex === '#1976D2' || c.hex === '#FFFFFF'));
});

test('a black chosen secondary yields no ladder step by default and only the lighter one behind --allow-lighter', () => {
  const black = { ...decision, palette: { ...decision.palette, web_secondary_color: '#000000' } };
  const { candidates } = candidateSecondaries({ decision: black, evidence: { logo_candidates: [], website: {} } });
  assert.equal(candidates.filter((c) => c.source.startsWith('depth_')).length, 0);
  const ladder = candidateSecondaries({ decision: black, evidence: { logo_candidates: [], website: {} }, allowLighter: true }).candidates.filter((c) => c.source.startsWith('depth_'));
  assert.equal(ladder.length, 1);
  assert.equal(ladder[0].source, 'depth_lighter_10');
});

test('badge digit contrast flags a light band under white text and names the brand-owned fix', () => {
  const teal = badgeDigit('#86D0CE', '#FFFFFF');
  assert.equal(teal.pass, false);
  assert.equal(teal.fix, '#000000');
  const black = badgeDigit('#000000', '#FFFFFF');
  assert.equal(black.pass, true);
  assert.equal(black.contrast_with_text, 21);
  assert(Math.abs(contrast('#FFFFFF', '#000000') - 21) < 0.01);
});

test('depth ladder shifts lightness deterministically', () => {
  assert.equal(shiftLightness('#E9681E', -0.1), shiftLightness('#E9681E', -0.1));
  assert.notEqual(shiftLightness('#E9681E', -0.1), '#E9681E');
  assert.equal(shiftLightness('#000000', -0.2), '#080808');
});

// ---- incremental sheet -------------------------------------------------------------------

test('parseArgs: the bare flag form is build; subcommands and boolean flags parse', () => {
  assert.equal(parseArgs(['--run-dir', '/r']).command, 'build');
  const add = parseArgs(['add-row', '--run', '/r', '--logo', 'x.png', '--label', 'full lockup', '--knockout']);
  assert.equal(add.command, 'add-row');
  assert.equal(add.runDir, '/r');
  assert.equal(add.knockout, true);
  assert.equal(parseArgs(['--run-dir', '/r', '--allow-lighter']).allowLighter, true);
  assert.throws(() => parseArgs(['bogus', '--run-dir', '/r']), /Unknown subcommand/);
  assert.throws(() => parseArgs(['mark']), /Usage/);
});

test('letters are sequential and never wrap into ambiguous forms: A..Z then AA, AB, ...', () => {
  assert.equal(letterFor(0), 'A');
  assert.equal(letterFor(25), 'Z');
  assert.equal(letterFor(26), 'AA');
  assert.equal(letterFor(27), 'AB');
  assert.equal(letterFor(52), 'BA');
  assert.equal(letterIndex('AA'), 26);
  assert.equal(letterIndex('A1'), null); // legacy overflow form is tolerated, not produced
});

test('fingerprints are deterministic, order-independent, and change with every input', () => {
  const base = { logoSha: 'abc', primary: '#8B2C1D', secondary: '#E65F28', text: '#FFFFFF', textSecondary: '#FFFFFF', treatment: 'knockout' };
  assert.equal(cardFingerprint(base), cardFingerprint({ ...base }));
  for (const key of Object.keys(base)) {
    assert.notEqual(cardFingerprint(base), cardFingerprint({ ...base, [key]: `${base[key]}x` }), `changing ${key} must change the card fingerprint`);
  }
  assert.notEqual(stickerFingerprint({ logoSha: 'abc', band: '#8B2C1D' }), stickerFingerprint({ logoSha: 'abc', band: '#000000' }));
  assert.notEqual(popFingerprint({ logoSha: 'abc', band: '#8B2C1D', offer: 'Join the club!' }), popFingerprint({ logoSha: 'abc', band: '#8B2C1D', offer: 'Get 20% Off' }));
  // No collision across kinds with identical parts.
  assert.notEqual(stickerFingerprint({ logoSha: 'abc', band: '#8B2C1D' }), popFingerprint({ logoSha: 'abc', band: '#8B2C1D', offer: undefined }));
});

test('cache hit/miss is decided by the fingerprint file in cells/', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cache-'));
  const fp = cardFingerprint({ logoSha: 'abc', primary: '#8B2C1D', secondary: '#E65F28', text: '#FFFFFF', textSecondary: '#FFFFFF', treatment: 'knockout' });
  assert.equal(cacheHas(out, 'card', fp), false); // miss
  fs.mkdirSync(path.join(out, 'cells'), { recursive: true });
  fs.writeFileSync(cachePath(out, 'card', fp), 'png');
  assert.equal(cacheHas(out, 'card', fp), true); // hit
  assert.equal(cacheHas(out, 'sticker', fp), false); // a different kind never hits the card cache
  const other = cardFingerprint({ logoSha: 'abc', primary: '#8B2C1D', secondary: '#000000', text: '#FFFFFF', textSecondary: '#FFFFFF', treatment: 'knockout' });
  assert.equal(cacheHas(out, 'card', other), false);
});

function sampleManifest(outDir) {
  return normalizeManifest({
    primary: '#8B2C1D',
    text: '#FFFFFF',
    print_text_secondary: '#F5F3EF',
    offer: 'Join the club!',
    rows: [
      { key: 'knockout', label: 'card knockout', logo: '/x/knockout.png' },
      { key: 'full_color', label: 'full color', logo: '/x/color.png' },
    ],
    columns: [
      { index: 0, hex: '#E8E4DD', source: 'fable_chosen', label: 'chosen' },
      { index: 1, hex: '#000000', source: 'override', label: 'override 2' },
    ],
    cells: {},
    next_letter: 0,
  }, outDir);
}

test('adding a row or column appends letters; existing cell ids never change', () => {
  const manifest = sampleManifest('/tmp/none');
  const first = appendCells(manifest, manifest.rows.flatMap((row) => manifest.columns.map((column) => ({ row, column }))));
  assert.deepEqual(first.map((c) => c.letter), ['A', 'B', 'C', 'D']);
  const before = JSON.stringify(Object.fromEntries(Object.entries(manifest.cells).map(([k, c]) => [k, [c.row, c.column_index, c.secondary]])));

  const row = { key: 'words_only', label: 'words only', logo: '/x/words.png', primary: null, text: null };
  manifest.rows.push(row);
  const added = appendCells(manifest, manifest.columns.map((column) => ({ row, column })));
  assert.deepEqual(added.map((c) => c.letter), ['E', 'F']);

  const column = { index: 2, hex: '#C93B18', source: 'override', label: 'red' };
  manifest.columns.push(column);
  const colCells = appendCells(manifest, manifest.rows.map((r) => ({ row: r, column })));
  assert.deepEqual(colCells.map((c) => c.letter), ['G', 'H', 'I']);
  assert.deepEqual(colCells.map((c) => c.row), ['knockout', 'full_color', 'words_only']);

  const after = JSON.stringify(Object.fromEntries(Object.entries(manifest.cells).filter(([k]) => 'ABCD'.includes(k)).map(([k, c]) => [k, [c.row, c.column_index, c.secondary]])));
  assert.equal(after, before, 'A..D keep their row, column and secondary');
  assert.equal(manifest.next_letter, 9);
  // A row with its own primary carries it into its cells; the sheet primary is untouched.
  const black = { key: 'full_on_black', label: 'full logo on black', logo: '/x/badge.png', primary: '#000000', text: null };
  manifest.rows.push(black);
  const [cell] = appendCells(manifest, [{ row: black, column: manifest.columns[0] }]);
  assert.equal(cell.letter, 'J');
  assert.equal(cell.primary, '#000000');
  assert.equal(manifest.primary, '#8B2C1D');
  assert.equal(cell.print_text_secondary, '#F5F3EF');
});

test('normalizeManifest adopts a legacy (pre-cache) sheet json without renumbering', () => {
  const legacy = normalizeManifest({
    primary: '#8B2C1D', text: '#FFFFFF',
    rows: [{ key: 'knockout', label: 'card knockout', logo: '/x/k.png' }],
    columns: [{ index: 0, hex: '#E8E4DD', source: 'fable_chosen', label: 'chosen' }, { index: 1, hex: '#000000', source: 'override', label: 'o' }],
    cells: {
      A: { letter: 'A', row: 'knockout', secondary: '#E8E4DD', print_text_secondary: '#F5F3EF' },
      B: { letter: 'B', row: 'knockout', secondary: '#000000', print_text_secondary: '#F5F3EF' },
    },
  }, '/tmp/none');
  assert.equal(legacy.next_letter, 2);
  assert.equal(legacy.cells.B.column_index, 1);
  assert.equal(legacy.cells.A.id, 'A');
  assert.equal(legacy.offer, 'Join the club!');
  assert.equal(legacy.print_text_secondary, '#F5F3EF');
  assert.equal(legacy.cells.A.status, null);
});

test('marks annotate the json only: one travisse_pick and one fable_pick at a time, fable default tracked', () => {
  const manifest = sampleManifest('/tmp/none');
  appendCells(manifest, manifest.rows.flatMap((row) => manifest.columns.map((column) => ({ row, column }))));
  const fingerprintsBefore = JSON.stringify(Object.values(manifest.cells).map((c) => c.fingerprint));
  applyMark(manifest, 'A', 'fable_pick', { by: 'Fable' });
  assert.equal(manifest.fable_default_letter, 'A');
  applyMark(manifest, 'B', 'travisse_pick', { note: 'black band', by: 'Travisse' });
  const { superseded } = applyMark(manifest, 'C', 'travisse_pick', { by: 'Travisse' });
  assert.deepEqual(superseded, ['B']);
  assert.equal(manifest.cells.B.status, null);
  assert.equal(manifest.cells.C.status, 'travisse_pick');
  assert.equal(manifest.cells.A.status, 'fable_pick');
  applyMark(manifest, 'D', 'rejected', { note: 'digit fails' });
  assert.equal(manifest.cells.D.note, 'digit fails');
  applyMark(manifest, 'A', 'rejected');
  assert.equal(manifest.fable_default_letter, null, 'rejecting the Fable default clears it');
  assert.equal(JSON.stringify(Object.values(manifest.cells).map((c) => c.fingerprint)), fingerprintsBefore, 'a mark never touches a fingerprint');
  assert.equal(manifest.marks.length, 5);
  assert.throws(() => applyMark(manifest, 'Q', 'rejected'), /not on the sheet/);
  assert.throws(() => applyMark(manifest, 'A', 'maybe'), /--status/);
});

// A fake run dir with real logo files: the HTML sheet references them relatively (schema 3, 2026-10-13).
async function fakeSheet() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-run-'));
  const out = path.join(runDir, 'variants');
  fs.mkdirSync(path.join(runDir, 'candidates'), { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const png = async (w, h, color) => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
  const manifest = sampleManifest(out);
  manifest.run_dir = runDir;
  for (const row of manifest.rows) {
    row.logo = path.join(runDir, 'candidates', `${row.key}.png`);
    fs.writeFileSync(row.logo, await png(120, 60, row.key === 'knockout' ? '#FFFFFF' : '#1B5E20'));
    row.sticker_band = '#8B2C1D';
  }
  appendCells(manifest, manifest.rows.flatMap((row) => manifest.columns.map((column) => ({ row, column }))));
  return { out, runDir, manifest };
}

test('composeSheet writes an HTML sheet from the cell views: deterministic, logos relative, marks change only their cell', async () => {
  const { out, runDir, manifest } = await fakeSheet();
  const { sheetW, sheetH } = sheetGeometry(manifest);
  const first = await composeSheet(manifest, out);
  assert.equal(path.basename(first), 'variant-sheet.html');
  const html1 = fs.readFileSync(first, 'utf8');
  assert.match(html1, new RegExp(`class="bs-sheet" style="width: ${sheetW}px; height: ${sheetH}px;"`));
  assert.equal((html1.match(/class="bs-cell/g) ?? []).length, 4, 'one block per cell');
  assert.match(html1, /src="\.\.\/candidates\/knockout\.png"/, 'logos are referenced relative to the sheet file, inside the run dir');
  assert.doesNotMatch(html1, new RegExp(runDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no absolute run-dir path leaks into the page');
  assert.ok(fs.existsSync(path.join(out, 'variant-sheet.json')) === false, 'composeSheet writes the html only; saveManifest owns the json');
  assert.ok(!fs.existsSync(path.join(out, 'variant-sheet.png')), 'no raster on the default path');
  for (const cell of Object.values(manifest.cells)) {
    assert.equal(cell.view.card.logo, `candidates/${cell.row}.png`, 'the view carries the run-dir-relative logo');
    assert.equal(cell.view.pop.offer, 'Join the club!');
    assert.equal(cell.view.header.text.startsWith(cell.letter), true);
  }
  const view = JSON.parse(/<script type="application\/json" id="variant-sheet-view">([\s\S]*?)<\/script>/.exec(html1)[1]);
  assert.deepEqual(Object.keys(view.cells), ['A', 'B', 'C', 'D'], 'the inline JSON block carries every cell view');
  await composeSheet(manifest, out);
  assert.equal(fs.readFileSync(first, 'utf8'), html1, 'restitch is deterministic');

  applyMark(manifest, 'B', 'travisse_pick', { by: 'Travisse' });
  await composeSheet(manifest, out);
  const marked = fs.readFileSync(first, 'utf8');
  assert.notEqual(marked, html1, 'the tag is drawn on the sheet');
  assert.match(marked, /class="bs-cell travisse_pick" data-letter="B"/);
  assert.match(marked, />TRAVISSE PICK</);
  const cellA = (html) => /<div class="bs-cell[^"]*" data-letter="A"[\s\S]*?<\/div>\n<\/div>/.exec(html)?.[0];
  assert.equal(cellA(marked), cellA(html1), 'cell A is untouched by a mark on B');
  applyMark(manifest, 'B', 'none');
  await composeSheet(manifest, out);
  assert.equal(fs.readFileSync(first, 'utf8'), html1, 'clearing the mark restores the exact sheet');
});

test('composeSheet refuses a cell whose logo file is missing instead of drawing a hole', async () => {
  const { out, manifest } = await fakeSheet();
  fs.rmSync(manifest.rows[1].logo); // full_color: cells C and D
  await assert.rejects(() => composeSheet(manifest, out), /Cell C: card logo missing/);
});

// ---------------------------------------------------------------------------------------------
// 2026-09-21: provenance words, default-letter rule, HOLD for small-source traces, in-store row, gradient center
// ---------------------------------------------------------------------------------------------
import { defaultLetterFor, dominantHueFromPixels, hueDistance, provenanceWords, chromaOf, STATUSES } from './variant-sheet.mjs';
import { applyStickerViability, applyViability, cellViability, checkSheetViability, gateStickerRow, rejectedLabelMatch, stickerLogoFor, stickerRenderable, STICKER_NEEDS_FIX, wordsCutSource } from './variant-sheet.mjs';

test('every column source has plain-word provenance on the label; synthetic steps say synthetic', () => {
  assert.equal(provenanceWords('fable_chosen', 'chosen'), "Fable's pick");
  assert.equal(provenanceWords('logo_ink', 'logo ink 5%'), 'logo ink 5%');
  assert.equal(provenanceWords('logo_ink', 'logo ink 28% (gradient center)'), 'logo ink 28%, gradient center');
  assert.equal(provenanceWords('site_token', 'site token x5'), 'site theme token');
  assert.match(provenanceWords('depth_darker_20', 'chosen -20%'), /darker step, synthetic \(allowed when real ink fails contrast\)/);
  assert.match(provenanceWords('depth_lighter_10', 'chosen +10%'), /lighter.*synthetic.*never a pick/);
  assert.match(provenanceWords('instore', ''), /in-store dominant, sampled/);
  assert.equal(provenanceWords('override', 'navy ink of the Facebook avatar'), 'human override: navy ink of the Facebook avatar');
});

test('logo inks earn a column at 3% share (Skyboxx ball), and a gradient bucket is replaced by the family center (Coloradough)', () => {
  const ev = {
    logo_candidates: [{
      local_path: '/run/evidence/logo-candidates/01.png',
      measured_colors: [
        { hex: '#FFFFFF', pixel_share: 0.9 },
        { hex: '#FB8308', pixel_share: 0.035 }, // 3.5%: an ink since 2026-09-21 (was 5%)
        { hex: '#AD1E30', pixel_share: 0.04 },  // dark pole of a red gradient
      ],
      gradient_families: [{ hue: 355, center_hex: '#D02020', dark_pole: '#AD1E30', light_pole: '#F06060', pixel_share: 0.28, buckets: 5 }],
    }],
    website: { authored_color_tokens: [] },
  };
  const dec = { logo_choice: '/run/evidence/logo-candidates/01.png', palette: { web_primary_color: '#161616', web_secondary_color: '#EFBA81', web_text_color: '#FFFFFF' } };
  const { candidates } = candidateSecondaries({ decision: dec, evidence: ev });
  const inks = candidates.filter((c) => c.source === 'logo_ink');
  assert.deepEqual(inks.map((c) => c.hex), ['#FB8308', '#D02020']);
  assert.match(inks[1].label, /gradient center/);
  assert.ok(!candidates.some((c) => c.hex === '#AD1E30'), 'the dark pole never becomes a column');
});

function sheetWith(columns, rows = [{ key: 'knockout', label: 'card knockout', logo: '/k.png' }]) {
  const manifest = normalizeManifest({ primary: '#161616', text: '#FFFFFF', print_text_secondary: '#161616', rows, columns, cells: {}, next_letter: 0 }, '/tmp/x');
  appendCells(manifest, manifest.rows.flatMap((row) => manifest.columns.map((column) => ({ row, column }))));
  return manifest;
}

test('default letter: the knockout row at Fable\'s column, moved to the mark-ink column by the band rule, or a HOLD for a small-source trace', () => {
  const columns = [
    { hex: '#EFBA81', source: 'fable_chosen', label: 'chosen' },
    { hex: '#FB8308', source: 'logo_ink', label: 'logo ink 5%' },
    { hex: '#E9A154', source: 'depth_darker_10', label: 'chosen -10%' },
  ];
  const plain = defaultLetterFor(sheetWith(columns), {});
  assert.equal(plain.letter, 'A');
  assert.equal(plain.hold, false);
  const moved = defaultLetterFor(sheetWith(columns), { band_over_brand_ink: { reason: 'secondary_not_a_mark_ink', web_secondary_color: '#EFBA81', mark_ink: '#FB8308', mark_ink_share: 0.05 } });
  assert.equal(moved.letter, 'B', 'Skyboxx: tan site accent loses the band to the ball orange');
  assert.match(moved.reason, /band rule/);
  const held = defaultLetterFor(sheetWith(columns), { traced_from_small_source: true, source_native_longest_px: 640 });
  assert.equal(held.hold, true);
  assert.equal(held.letter, 'A');
  assert.match(held.reason, /HOLD: traced from a 640px source/);
  // a hold is a status, not a default: applyMark records it and leaves fable_default_letter empty
  const manifest = sheetWith(columns);
  applyMark(manifest, held.letter, 'hold', { note: held.reason, by: 'variant-sheet build' });
  assert.ok(STATUSES.includes('hold'));
  assert.equal(manifest.fable_default_letter, null);
  assert.equal(manifest.cells.A.status, 'hold');
  assert.equal(manifest.hold.letter, 'A');
  // the band rule never moves to a cell whose print digit has no brand-owned fix
  const badDigit = sheetWith([{ hex: '#EFBA81', source: 'fable_chosen', label: 'chosen' }, { hex: '#888888', source: 'logo_ink', label: 'logo ink 4%' }]);
  badDigit.cells.B.badge_digit_print = { pass: false, fix: null };
  assert.equal(defaultLetterFor(badDigit, { band_over_brand_ink: { mark_ink: '#888888', web_secondary_color: '#EFBA81' } }).letter, 'A');
});

test('in-store dominant color: the top saturated hue bin across photos, with its share; neutrals and highlights ignored', () => {
  const px = (r, g, b, n) => Buffer.from(Array.from({ length: n }, () => [r, g, b]).flat());
  const wall = { data: Buffer.concat([px(30, 90, 200, 300), px(240, 240, 240, 500), px(20, 20, 20, 500), px(200, 40, 40, 100)]), channels: 3 }; // flight blue wall, white, black, a little red
  const menu = { data: Buffer.concat([px(28, 95, 205, 200), px(120, 120, 120, 300)]), channels: 3 };
  const dominant = dominantHueFromPixels([wall, menu]);
  assert.ok(dominant);
  assert.equal(Math.round(dominant.hue), Math.round(218)); // bin 14 -> 217.5
  assert.ok(dominant.share > 0.8, JSON.stringify(dominant));
  assert.equal(dominant.saturated_pixels, 600);
  assert.equal(dominantHueFromPixels([{ data: px(128, 128, 128, 50), channels: 3 }]), null);
  assert.equal(hueDistance(217.5, 170), 47.5);
  assert.ok(chromaOf('#E8E4DD') < 0.15 && chromaOf('#227F70') > 0.15);
});

// ---- sheet viability: a refused asset is recorded, never rendered; --force-viability badges it ----

test('sheet viability: a failing asset is not added and lands in manifest.skipped; --force-viability keeps it with a NOT VIABLE cell badge; a passing asset records the pass', () => {
  const columns = [{ hex: '#E2A838', source: 'fable_chosen', label: 'chosen' }, { hex: '#0A7D57', source: 'site_token', label: 'site token' }];
  const manifest = sheetWith(columns);
  const fail = { pass: false, verdict: 'wordmark_text_mismatch', reasons: ['the cut reads "Do woo Pizza"'] };
  const words = { key: 'words_only', label: 'words only', logo: '/run/variants/card-words-1600.png', logo_sha256: 'f4b3', viability_source: '/run/fix/card-final.png' };
  const refused = applyViability(manifest, words, fail, { command: 'build', at: '2026-09-21T21:00:00.000Z' });
  assert.equal(refused.keep, false);
  assert.equal(manifest.skipped.length, 1);
  assert.deepEqual(manifest.skipped[0], { at: '2026-09-21T21:00:00.000Z', command: 'build', row: 'words_only', label: 'words only', logo: '/run/variants/card-words-1600.png', logo_sha256: 'f4b3', source: '/run/fix/card-final.png', column: null, verdict: 'wordmark_text_mismatch', reasons: ['the cut reads "Do woo Pizza"'] });
  assert.equal(words.viability, undefined, 'a refused row carries nothing; it never joins the manifest');

  const lockup = { key: 'lockup_full_color', label: 'full mascot lockup', logo: '/run/candidates/01-lockup.png', logo_sha256: '6b40' };
  const forced = applyViability(manifest, lockup, { pass: false, verdict: 'opaque_ground', reasons: ['white square'] }, { force: true, command: 'add-row' });
  assert.equal(forced.keep, true);
  assert.equal(forced.forced, true);
  assert.equal(lockup.viability.forced, true);
  assert.equal(manifest.skipped.length, 1, 'a forced render is not a skip');
  manifest.rows.push(lockup);
  const [cell] = appendCells(manifest, [{ row: lockup, column: manifest.columns[0] }]);
  assert.deepEqual(cell.viability, { pass: false, verdict: 'opaque_ground', reasons: ['white square'], forced: true });

  const knock = { key: 'knockout', label: 'card knockout', logo: '/run/fix/card-final.png', logo_sha256: 'd203' };
  const kept = applyViability(manifest, knock, { pass: true, verdict: 'ok', reasons: [] }, { command: 'build' });
  assert.equal(kept.keep, true);
  assert.equal(knock.viability.pass, true);
  const [okCell] = appendCells(manifest, [{ row: knock, column: manifest.columns[0] }]);
  assert.equal(okCell.viability, null, 'a passing row draws no badge');
});

test('sheet viability: a label or note that says rejected is refused before any image work; the cut-words sidecar names the source of a cut', async () => {
  assert.equal(rejectedLabelMatch('words only', 'auto cut-words dropped the g and d; rejected'), 'rejected');
  assert.equal(rejectedLabelMatch('full color', null), null);
  const refused = await checkSheetViability('/nowhere/never-read.png', { label: 'lockup (rejected by Fable)' });
  assert.equal(refused.pass, false);
  assert.equal(refused.verdict, 'rejected_label');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boostly-sheet-source-'));
  try {
    const out = path.join(dir, 'variants');
    fs.mkdirSync(out, { recursive: true });
    const source = path.join(dir, 'fix', 'card-final.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'png');
    const cut = path.join(out, 'card-words-1600.png');
    fs.writeFileSync(cut, 'png');
    fs.writeFileSync(path.join(out, 'cut-words.json'), JSON.stringify({ ok: true, in: source, out: cut }));
    assert.equal(wordsCutSource(cut, out, dir), source);
    assert.equal(wordsCutSource(path.join(out, 'other.png'), out, dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('add-cell print roles: a row with print_primary/print_secondary drives the sticker band, the print digit, the manifest cell, and the labels; web roles untouched', () => {
  const manifest = sampleManifest('/tmp/none');
  appendCells(manifest, manifest.rows.flatMap((row) => manifest.columns.map((column) => ({ row, column }))));
  // Dogwood 2026-09-21: red web card with a blue band; blue signage with a red band.
  const blue = { key: 'blue_signage', label: 'white knockout, blue signage', logo: '/x/knockout.png', primary: null, text: null, print_primary: '#263950', print_secondary: '#C93B18' };
  manifest.rows.push(blue);
  const column = { index: manifest.columns.length, hex: '#263950', source: 'one_off', label: 'one-off #263950', one_off: true };
  manifest.columns.push(column);
  const [cell] = appendCells(manifest, [{ row: blue, column }]);
  assert.equal(cell.primary, manifest.primary, 'web card primary stays the sheet primary');
  assert.equal(cell.secondary, '#263950', 'web band is the column');
  assert.equal(cell.print_primary, '#263950');
  assert.equal(cell.print_secondary, '#C93B18');
  assert.deepEqual([cell.badge_digit_web.contrast_with_text, cell.badge_digit_print.contrast_with_text], [badgeDigit('#263950', manifest.text).contrast_with_text, badgeDigit('#C93B18', cell.print_text_secondary).contrast_with_text], 'web digit vs web band, print digit vs print band');
  assert.equal(stickerBand(manifest, blue).band, '#263950', 'sticker band and POP ground follow the print primary');
  assert.match(stickerBand(manifest, blue).note, /print primary/);
  assert.match(rowLabelText(manifest, blue), /print primary #263950/);
  assert.match(printRolesText(cell), /print primary #263950/);
  assert.match(printRolesText(cell), /print band #C93B18 digit/);
  // A plain cell prints nothing extra and its print roles mirror the web roles.
  const plain = manifest.cells.A;
  assert.equal(plain.print_primary, plain.primary);
  assert.equal(plain.print_secondary, plain.secondary);
  assert.equal(printRolesText(plain), '');
  // The flags parse to camelCase like every other value flag.
  const args = parseArgs(['add-cell', '--run-dir', '/r', '--logo', 'l.png', '--primary', '#000000', '--secondary', '#111111', '--print-primary', '#263950', '--print-secondary', '#C93B18', '--label', 'x']);
  assert.equal(args.printPrimary, '#263950');
  assert.equal(args.printSecondary, '#C93B18');
});

// ---------------------------------------------------------------------------------------------
// 2026-09-22 Toscana Gourmet Pizza: the STICKER logo is gated on the same terms as the card logo
// ---------------------------------------------------------------------------------------------
async function stickerFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sticker-'));
  const opaque = path.join(dir, 'opaque-square.png');
  const clear = path.join(dir, 'card-knockout.png');
  // an authored square panel: black ground edge to edge, a red word block in the middle
  await sharp({ create: { width: 320, height: 320, channels: 4, background: '#000000' } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect x="60" y="130" width="200" height="60" fill="#8B1E2F"/></svg>'), left: 0, top: 0 }])
    .png().toFile(opaque);
  // a transparent-ground mark (an ellipse: a solid rectangle would itself read as an opaque panel)
  await sharp({ create: { width: 320, height: 320, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><ellipse cx="160" cy="160" rx="100" ry="30" fill="#FFFFFF"/></svg>'), left: 0, top: 0 }])
    .png().toFile(clear);
  return { dir, opaque, clear };
}

test('sticker viability: an opaque sticker asset is refused (kind sticker, needs panel or strip) while the card row stays; forced renders with a sticker badge; a sticker that is the card logo inherits', async () => {
  const { dir, opaque, clear } = await stickerFixtures();
  try {
    const columns = [{ hex: '#E2A838', source: 'fable_chosen', label: 'chosen' }];
    const manifest = sheetWith(columns, []);
    manifest.sticker_logo = opaque; // build's fallback: decision.logo_choice, the raw square (Toscana)
    const row = { key: 'knockout', label: 'card knockout', logo: clear, logo_sha256: 'abc', viability: { pass: true, verdict: 'ok', reasons: [], logo_sha256: 'abc' } };
    assert.equal(stickerLogoFor(manifest, row), opaque);
    const render = await gateStickerRow(manifest, row, { force: false, command: 'build' });
    assert.equal(render, false);
    assert.equal(row.sticker_viability.pass, false);
    assert.equal(row.sticker_viability.verdict, 'opaque_ground');
    assert.equal(row.sticker_viability.status, STICKER_NEEDS_FIX);
    assert.equal(row.viability.pass, true, 'the card asset is unaffected');
    assert.equal(stickerRenderable(row), false);
    assert.equal(manifest.skipped.length, 1);
    assert.equal(manifest.skipped[0].kind, 'sticker');
    assert.equal(manifest.skipped[0].row, 'knockout');
    assert.equal(manifest.skipped[0].logo, opaque);
    assert.equal(manifest.skipped[0].status, STICKER_NEEDS_FIX);
    manifest.rows.push(row);
    const [cell] = appendCells(manifest, [{ row, column: manifest.columns[0] }]);
    assert.equal(cell.sticker_status, STICKER_NEEDS_FIX, 'the cell names the fix instead of borrowing the card logo');
    assert.equal(cell.viability, null, 'a refused sticker is a placeholder, not a NOT VIABLE badge');
    // cached: a second gate on the same sha re-records nothing and still refuses
    assert.equal(await gateStickerRow(manifest, row, { force: false, command: 'add-column', columnHex: '#111111' }), false);
    assert.equal(manifest.skipped.length, 2);
    assert.equal(manifest.skipped[1].column, '#111111');

    // --force-viability: rendered anyway, badge names the sticker verdict
    const forcedRow = { key: 'forced', label: 'forced', logo: clear, logo_sha256: 'abc' };
    assert.equal(await gateStickerRow(manifest, forcedRow, { force: true, command: 'add-row' }), true);
    assert.equal(forcedRow.sticker_viability.forced, true);
    assert.equal(stickerRenderable(forcedRow), true);
    assert.deepEqual(cellViability(forcedRow), { pass: false, verdict: 'sticker opaque_ground', reasons: forcedRow.sticker_viability.reasons, forced: true, kind: 'sticker' });
    assert.equal(manifest.skipped.length, 2, 'a forced sticker is not a skip');

    // the full_color row and a row with no sticker asset of its own render their (already gated) card logo
    const fullColor = { key: 'full_color', label: 'full color', logo: clear, logo_sha256: 'abc' };
    assert.equal(await gateStickerRow(manifest, fullColor, { force: false, command: 'build' }), true);
    assert.equal(fullColor.sticker_viability.inherited, 'card logo');
    manifest.sticker_logo = null;
    const plain = { key: 'plain', label: 'plain', logo: clear, logo_sha256: 'abc' };
    assert.equal(await gateStickerRow(manifest, plain, { force: false, command: 'build' }), true);
    assert.equal(stickerLogoFor(manifest, plain), clear);

    // a passing sticker asset of its own records the pass
    const own = { key: 'own', label: 'own', logo: clear, logo_sha256: 'abc', sticker_logo: clear };
    const passRow = { ...own, logo: opaque, logo_sha256: 'zzz' }; // card differs, sticker is the clear mark
    assert.equal(await gateStickerRow(manifest, passRow, { force: false, command: 'add-row' }), true);
    assert.equal(passRow.sticker_viability.pass, true);
    assert.equal(cellViability(passRow), null);

    // pure application, no image work
    const pure = { key: 'p', label: 'p', logo: '/k.png' };
    const refused = applyStickerViability(manifest, pure, { pass: false, verdict: 'opaque_ground', reasons: ['square'] }, { command: 'build', logo: '/s.png', logoSha: 'f00', at: '2026-09-22T17:00:00.000Z' });
    assert.equal(refused.render, false);
    assert.deepEqual(manifest.skipped[manifest.skipped.length - 1], { at: '2026-09-22T17:00:00.000Z', command: 'build', kind: 'sticker', row: 'p', label: 'p', logo: '/s.png', logo_sha256: 'f00', source: null, column: null, verdict: 'opaque_ground', reasons: ['square'], status: STICKER_NEEDS_FIX });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('composeSheet draws the "needs panel or strip" placeholder for a refused sticker and still refuses a sticker logo that is missing', async () => {
  const { out, runDir, manifest } = await fakeSheet();
  const row = manifest.rows[0];
  row.sticker_viability = { pass: false, verdict: 'opaque_ground', reasons: ['opaque'], forced: false };
  const sheet = await composeSheet(manifest, out);
  const html = fs.readFileSync(sheet, 'utf8');
  assert.equal((html.match(/bs-sticker-missing/g) ?? []).length, 2, 'both cells of the refused row carry the placeholder');
  for (const cell of Object.values(manifest.cells)) {
    if (cell.row === row.key) { assert.equal(cell.view.sticker.logo, null); assert.equal(cell.view.sticker.status, STICKER_NEEDS_FIX); }
    else assert.equal(cell.view.sticker.logo, `candidates/${cell.row}.png`, 'the other row still draws its sticker from the card logo');
  }
  // A sticker asset that is merely gone from disk falls back to the (gated) card logo, as stickerLogoFor always did.
  const other = manifest.rows[1];
  other.sticker_logo = path.join(runDir, 'candidates', 'gone.png');
  other.sticker_logo_used = other.sticker_logo;
  await composeSheet(manifest, out);
  assert.equal(manifest.cells.C.view.sticker.logo, 'candidates/full_color.png');
  fs.rmSync(runDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 2026-10-01 (Travisse): a cell the builder refuses on the card takes no letter; a human rejected mark keeps its letter
// ---------------------------------------------------------------------------------------------
import { applyCellViability, cardContrastVerdict, cellLabelText, gateCells, vanishedInkShare } from './variant-sheet.mjs';

test('cell on card: a (row, column) whose ink vanishes on the row primary is not created, takes no letter, and lands in manifest.skipped as kind cell; letters stay contiguous; --force-viability keeps it with a NOT VIABLE badge', async () => {
  const columns = [{ hex: '#000000', source: 'fable_chosen', label: 'chosen' }, { hex: '#003D0E', source: 'site_token', label: 'site token' }, { hex: '#E70C2B', source: 'override', label: 'red' }];
  const knockout = { key: 'knockout', label: 'card knockout', logo: '/run/fix/card-final.png', logo_sha256: 'd203' };
  const lockup = { key: 'full_color', label: 'full color', logo: '/run/candidates/01.png', logo_sha256: '6b40' };
  const manifest = normalizeManifest({ primary: '#17723E', text: '#FFFFFF', rows: [knockout, lockup], columns, cells: {}, next_letter: 0 }, '/tmp/x');
  // Spinachio: every component of the green lockup vanishes on the green card; the white knockout is fine.
  const measured = [];
  const measure = async (logo, primary) => {
    measured.push([logo, primary]);
    return logo === lockup.logo
      ? { primary, minContrast: 3, pass: false, failingComponents: [0, 1, 2], components: [{ id: 0, areaShareOfInk: 0.5 }, { id: 1, areaShareOfInk: 0.3 }, { id: 2, areaShareOfInk: 0.2 }], verdict: 'component_invisible_on_primary' }
      : { primary, minContrast: 3, pass: true, failingComponents: [], components: [{ id: 0, areaShareOfInk: 1 }], verdict: 'ok' };
  };
  const pairs = manifest.rows.flatMap((row) => manifest.columns.map((column) => ({ row, column })));
  const kept = await gateCells(manifest, pairs, { command: 'build', measure });
  assert.equal(measured.length, 2, 'one measurement per (logo, primary), not per cell');
  assert.deepEqual(kept.map((p) => `${p.row.key}/${p.column.hex}`), ['knockout/#000000', 'knockout/#003D0E', 'knockout/#E70C2B']);
  assert.ok(kept.every((p) => p.ink_on_card.pass === true && p.viability === null));
  const created = appendCells(manifest, kept);
  assert.deepEqual(created.map((c) => c.letter), ['A', 'B', 'C'], 'the refused lockup cells took no letters: the next letters stay contiguous');
  assert.equal(manifest.next_letter, 3);
  assert.equal(manifest.cells.A.ink_on_card.pass, true);
  assert.equal(manifest.skipped.length, 3, 'one skip per refused (row, column)');
  const skip = manifest.skipped[0];
  assert.equal(skip.kind, 'cell');
  assert.equal(skip.row, 'full_color');
  assert.equal(skip.column, '#000000');
  assert.equal(skip.column_index, 0);
  assert.equal(skip.primary, '#17723E');
  assert.equal(skip.logo, '/run/candidates/01.png');
  assert.equal(skip.verdict, 'ink_vanishes_on_card');
  assert.equal(skip.vanished_ink_share, 1);
  assert.match(skip.reasons[0], /100% of the logo ink .* vanish on the #17723E card/);
  assert.deepEqual(manifest.skipped.map((s) => s.column), ['#000000', '#003D0E', '#E70C2B']);
  assert.ok(!Object.values(manifest.cells).some((c) => c.row === 'full_color'), 'no cell of the refused row exists, so none carries status rejected');

  // --force-viability: the cell is created, badged NOT VIABLE, and no skip is recorded.
  const forced = normalizeManifest({ primary: '#17723E', text: '#FFFFFF', rows: [lockup], columns, cells: {}, next_letter: 0 }, '/tmp/x');
  const forcedPairs = await gateCells(forced, [{ row: lockup, column: forced.columns[0] }], { force: true, command: 'add-cell', measure });
  assert.equal(forcedPairs.length, 1);
  const [badged] = appendCells(forced, forcedPairs);
  assert.equal(badged.letter, 'A');
  assert.deepEqual(badged.viability, { pass: false, verdict: 'ink_vanishes_on_card', reasons: badged.ink_on_card.reasons, forced: true, kind: 'cell' });
  assert.equal(badged.ink_on_card.forced, true);
  assert.equal(forced.skipped.length, 0, 'a forced cell is not a skip');

  // The threshold is a share of ink, not a count of components: 40% vanished is kept and recorded.
  const partial = cardContrastVerdict({ primary: '#D6522D', minContrast: 3, failingComponents: [1, 2], components: [{ id: 0, areaShareOfInk: 0.6 }, { id: 1, areaShareOfInk: 0.25 }, { id: 2, areaShareOfInk: 0.15 }] }, { minShare: 0.5 });
  assert.equal(partial.pass, true);
  assert.equal(partial.vanished_ink_share, 0.4);
  assert.equal(vanishedInkShare({ failingComponents: [1], components: [{ id: 0, areaShareOfInk: 0.6 }, { id: 1, areaShareOfInk: 0.4 }] }), 0.4);
  const applied = applyCellViability(forced, lockup, forced.columns[1], partial, { command: 'add-column', at: '2026-10-01T17:00:00.000Z' });
  assert.equal(applied.keep, true);
  assert.equal(applied.ink_on_card.checked_at, '2026-10-01T17:00:00.000Z');
  assert.equal(applied.ink_on_card.vanished_ink_share, 0.4);
});

test('cell on card measures the real asset: green ink on the green card is refused, the same asset on black is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-card-'));
  const logo = path.join(dir, 'green-lockup.png');
  // 200x120 transparent png with two green word blocks (the Spinachio two-ink lockup, reduced to its green ink).
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="10" y="10" width="180" height="40" fill="#17723E"/><rect x="10" y="70" width="180" height="40" fill="#17723E"/></svg>';
  fs.writeFileSync(logo, await sharp(Buffer.from(svg)).png().toBuffer());
  const row = { key: 'full_color', label: 'full color', logo, logo_sha256: 'abcd' };
  const column = { index: 0, hex: '#000000', source: 'fable_chosen', label: 'chosen' };
  const green = normalizeManifest({ primary: '#17723E', text: '#FFFFFF', rows: [row], columns: [column], cells: {}, next_letter: 0 }, dir);
  const refused = await gateCells(green, [{ row, column }], { command: 'build' });
  assert.equal(refused.length, 0);
  assert.equal(green.skipped[0].verdict, 'ink_vanishes_on_card');
  assert.equal(green.skipped[0].vanished_ink_share, 1);
  const black = normalizeManifest({ primary: '#000000', text: '#FFFFFF', rows: [row], columns: [column], cells: {}, next_letter: 0 }, dir);
  const kept = await gateCells(black, [{ row, column }], { command: 'build' });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ink_on_card.vanished_ink_share, 0);
  assert.equal(black.skipped.length, 0);
});

test('a human rejected mark keeps its letter and renders greyed with REJECTED in the header; the other cells are untouched', async () => {
  const { out, manifest } = await fakeSheet();
  const { cellW, cellH, sideH } = sheetGeometry(manifest);
  const sheetFile = await composeSheet(manifest, out);
  const before = fs.readFileSync(sheetFile);
  const letters = Object.keys(manifest.cells);
  applyMark(manifest, 'B', 'rejected', { note: 'green ink on the green card (1.03:1): the lockup vanishes', by: 'Travisse' });
  assert.deepEqual(Object.keys(manifest.cells), letters, 'a rejected mark removes nothing: every letter stays');
  assert.equal(manifest.cells.B.status, 'rejected');
  assert.match(cellLabelText(manifest, manifest.cells.B), /^B  REJECTED   /, 'the header strip says REJECTED right after the letter');
  assert.doesNotMatch(cellLabelText(manifest, manifest.cells.A), /REJECTED/);
  await composeSheet(manifest, out);
  const after = fs.readFileSync(sheetFile, 'utf8');
  const cellOf = (html, letter) => new RegExp(`<div class="bs-cell[^"]*" data-letter="${letter}"[\\s\\S]*?<\\/div>\\n<\\/div>`).exec(html)?.[0];
  const b = cellOf(after, 'B');
  assert.match(b, /^<div class="bs-cell rejected"/, 'the rejected class greys every tile of the cell (CSS filter) and frames it');
  assert.match(b, /bs-rejected-word">REJECTED</, 'REJECTED is written across the card');
  assert.match(b, /class="bs-label" style="background: #616161;">B  REJECTED/, 'the header strip is grey and says REJECTED');
  assert.equal(manifest.cells.B.view.rejected, true);
  assert.equal(manifest.cells.B.view.status_tag, 'REJECTED');
  // Cell A is byte-identical: the treatment is confined to the rejected cell.
  assert.equal(cellOf(after, 'A'), cellOf(before.toString(), 'A'));
  assert.ok(cellW > 0 && cellH > 0 && sideH > 0);
  // Clearing the mark restores the exact sheet.
  applyMark(manifest, 'B', 'none');
  await composeSheet(manifest, out);
  assert.deepEqual(fs.readFileSync(sheetFile), before);
});
