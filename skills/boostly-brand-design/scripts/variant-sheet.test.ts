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
import { defaultLetterFor, dominantHueFromPixels, hueDistance, provenanceWords, chromaOf, STATUSES, treatmentKeys, planTreatments, treatmentRows, applyPrintCell, planCutRows, cutRowsFrom, isBadgeCut, secondChromaFor, flatPanelHex, panelHexOf, boxStickerFor, finalizeRowAsset, finalizeRowUploads, descriptorInsideLockup, nameTokens } from './variant-sheet.mjs';
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

test('default letter: the knockout row at Fable\'s column, moved to the mark-ink column by the band rule; a small-source trace is a FLAG on the default, never a hold (rule 5)', () => {
  const columns = [
    { hex: '#EFBA81', source: 'fable_chosen', label: 'chosen' },
    { hex: '#FB8308', source: 'logo_ink', label: 'logo ink 5%' },
    { hex: '#E9A154', source: 'depth_darker_10', label: 'chosen -10%' },
  ];
  const plain = defaultLetterFor(sheetWith(columns), {});
  assert.equal(plain.letter, 'A');
  assert.equal(plain.hold, false);
  assert.equal(plain.flag, null);
  assert.equal(plain.override, null);
  const moved = defaultLetterFor(sheetWith(columns), { band_over_brand_ink: { reason: 'secondary_not_a_mark_ink', web_secondary_color: '#EFBA81', mark_ink: '#FB8308', mark_ink_share: 0.05 } });
  assert.equal(moved.letter, 'B', 'Skyboxx: tan site accent loses the band to the ball orange');
  assert.match(moved.reason, /band rule/);
  const flagged = defaultLetterFor(sheetWith(columns), { traced_from_small_source: true, source_native_longest_px: 640 });
  assert.equal(flagged.hold, false, 'picked straight through 5/5: a flag, not a hold');
  assert.equal(flagged.flag, 'traced_from_small_source');
  assert.equal(flagged.native_px, 640);
  assert.equal(flagged.letter, 'A');
  assert.match(flagged.reason, /flag: traced from a 640px source/);
  assert.doesNotMatch(flagged.reason, /HOLD/);
  // the flagged default is still the default: fable_pick with the px on the label, fable_default_letter set
  const manifest = sheetWith(columns);
  applyMark(manifest, flagged.letter, 'fable_pick', { note: flagged.reason, by: 'variant-sheet build' });
  manifest.default_flag = { letter: flagged.letter, flag: flagged.flag, native_px: flagged.native_px, reason: flagged.reason };
  assert.equal(manifest.fable_default_letter, 'A');
  assert.equal(manifest.cells.A.status, 'fable_pick');
  assert.match(cellLabelText(manifest, manifest.cells.A), /source 640px$/);
  assert.doesNotMatch(cellLabelText(manifest, manifest.cells.B), /source 640px/);
  assert.ok(!STATUSES.includes('hold'), 'hold is no longer a status');
  assert.throws(() => applyMark(manifest, 'A', 'hold'), /--status must be one of/);
  applyMark(manifest, 'A', 'rejected', { by: 'Travisse' });
  assert.equal(manifest.default_flag, null, 'rejecting the flagged default clears the flag');
  // a sheet built before 2026-10-19 with a HOLD cell: the held cell becomes the flagged fable default
  const legacy = normalizeManifest({ primary: '#161616', text: '#FFFFFF', rows: [{ key: 'knockout', label: 'card knockout', logo: '/k.png' }], columns, cells: { A: { letter: 'A', row: 'knockout', column_index: 0, secondary: '#EFBA81', status: 'hold', note: 'HOLD: traced from a 640px source' } }, hold: { letter: 'A', native_px: 640, reason: 'HOLD: traced from a 640px source' } }, '/tmp/x');
  assert.equal(legacy.cells.A.status, 'fable_pick');
  assert.equal(legacy.fable_default_letter, 'A');
  assert.deepEqual(legacy.default_flag, { letter: 'A', flag: 'traced_from_small_source', native_px: 640, reason: 'HOLD: traced from a 640px source' });
  assert.equal(legacy.hold, null);
  // the band rule reads the validator's replacement shape too (rule 4 enum additions)
  const viaReplacement = defaultLetterFor(sheetWith(columns), { band_over_brand_ink: { reason: 'same_hue_secondary', web_secondary_color: '#EFBA81', replacement: { hex: '#FB8308', source: 'site_cta', share: 0.05 } } });
  assert.equal(viaReplacement.letter, 'B');
  assert.match(viaReplacement.reason, /a tint of the primary; the site CTA #FB8308 \(5% of ink\)/);
  // the band rule never moves to a cell whose print digit has no brand-owned fix
  const badDigit = sheetWith([{ hex: '#EFBA81', source: 'fable_chosen', label: 'chosen' }, { hex: '#888888', source: 'logo_ink', label: 'logo ink 4%' }]);
  badDigit.cells.B.badge_digit_print = { pass: false, fix: null };
  assert.equal(defaultLetterFor(badDigit, { band_over_brand_ink: { mark_ink: '#888888', web_secondary_color: '#EFBA81' } }).letter, 'A');
});

test('default letter, rule 2: a bright band that needs a black print digit yields to the -10% step of its hue, else the darkest site token that carries a white digit', () => {
  // chosen gold #E2A838: white on it is ~2:1; its -10% step is still light; the site token #0D4F3D carries white
  const columns = [
    { hex: '#E2A838', source: 'fable_chosen', label: 'chosen' },
    { hex: '#0D4F3D', source: 'site_token', label: 'site token x5' },
    { hex: '#C98F27', source: 'depth_darker_10', label: 'darker step -10%' },
  ];
  const sheet = sheetWith(columns);
  const def = defaultLetterFor(sheet, {});
  assert.equal(def.letter, sheet.cells.B.letter, 'the darkest site token with a white digit takes the default');
  assert.match(def.reason, /digit rule: white on #E2A838 is/);
  // a same-hue darker step that carries white wins over the site token
  const steps = sheetWith([{ hex: '#E2A838', source: 'fable_chosen', label: 'chosen' }, { hex: '#0D4F3D', source: 'site_token', label: 'site token x5' }, { hex: '#7A5212', source: 'depth_darker_20', label: 'darker step -20%' }]);
  assert.equal(defaultLetterFor(steps, {}).letter, 'C');
  // nothing moves when no column carries a white digit (the print fix stays on the label)
  const none = sheetWith([{ hex: '#E2A838', source: 'fable_chosen', label: 'chosen' }, { hex: '#F2D27A', source: 'depth_lighter_10', label: 'lighter' }]);
  assert.equal(defaultLetterFor(none, {}).letter, 'A');
});

test('default letter, rules 1 and 3: the dark_ground set at the brand-chroma band when the decision carries dark_ground_default; the full-color row when its cell reads clean on a dark ground, with the render-legibility override named', () => {
  const columns = [
    { hex: '#C8C8C8', source: 'fable_chosen', label: 'chosen' },
    { hex: '#D7262C', source: 'logo_ink', label: 'logo ink 62%' },
  ];
  const rows = [
    { key: 'knockout', label: 'card knockout', logo: '/k.png' },
    { key: 'full_color', label: 'full color', logo: '/c.png' },
    { key: 'dark_ground', label: 'dark ground', logo: '/k.png', primary: '#111111', primary_source: 'dark_ground' },
    { key: 'dark_ground_full_color', label: 'dark ground full color', logo: '/c.png', primary: '#111111', primary_source: 'dark_ground' },
  ];
  const marks = { dark_ground_default: { ground: '#111111', ground_source: 'site_header', band: '#D7262C', band_source: 'mark_ink', reasons: [] } };
  const sheet = sheetWith(columns, rows);
  const def = defaultLetterFor(sheet, marks);
  const cell = sheet.cells[def.letter];
  assert.equal(cell.row, 'dark_ground_full_color', 'Pagliai\'s: dark card, full authored mark, red band');
  assert.equal(cell.secondary, '#D7262C');
  assert.equal(def.override.gate, 'render-legibility');
  assert.equal(def.override.asset, '/c.png');
  assert.match(def.reason, /dark ground #111111 \(site header black\) with the mark ink #D7262C as the band/);
  const plainBlack = defaultLetterFor(sheetWith(columns, rows), { dark_ground_default: { ground: '#111111', ground_source: 'default_black', band: '#D7262C', band_source: 'decision_secondary' } });
  assert.match(plainBlack.reason, /plain black .* with Fable's secondary #D7262C as the band/);
  // a full-color cell that vanished on the card is not clean: the knockout row of the set takes it
  const sheet2 = sheetWith(columns, rows);
  const full = Object.values(sheet2.cells).find((c) => c.row === 'dark_ground_full_color' && c.secondary === '#D7262C');
  full.ink_on_card = { pass: false, verdict: 'ink_vanishes_on_card' };
  const def2 = defaultLetterFor(sheet2, marks);
  assert.equal(sheet2.cells[def2.letter].row, 'dark_ground');
  assert.equal(def2.override, null);
  // without the mark (or without the row on the sheet) the decision-primary set is the base, and on a mid-grey
  // primary (not dark) the full-color row only leads when the descriptor is part of the lockup
  const sheet3 = sheetWith(columns, rows.slice(0, 2));
  sheet3.primary = '#BBBBBB'; // 1.9:1 on white: a light card, not a dark ground
  for (const c of Object.values(sheet3.cells)) c.primary = '#BBBBBB';
  assert.equal(sheet3.cells[defaultLetterFor(sheet3, {}).letter].row, 'knockout');
  assert.equal(sheet3.cells[defaultLetterFor(sheet3, { descriptor_in_lockup: true }).letter].row, 'full_color');
  assert.equal(sheet3.cells[defaultLetterFor(sheet3, marks).letter].row, 'knockout', 'a dark_ground mark with no dark_ground row falls back to the decision set');
});

test('treatment plan (rule 6): every ground gets knockout / full color / words only; a light ground tints the knockout ink; a dark ground adds a white-ink twin of every colored-ink row', () => {
  assert.deepEqual(treatmentKeys(null), { knockout: 'knockout', full_color: 'full_color', words_only: 'words_only' });
  assert.deepEqual(treatmentKeys('dark_ground'), { knockout: 'dark_ground', full_color: 'dark_ground_full_color', words_only: 'dark_ground_words_only' });
  const dark = planTreatments({ setKey: 'dark_ground', ground: '#111111', label: 'dark ground', logoKnockout: '/k.png', logoColor: '/c.png', logoWords: '/w.png' });
  assert.deepEqual(dark.rows.map((r) => r.key), ['dark_ground', 'dark_ground_full_color', 'dark_ground_words_only', 'dark_ground_full_color_white']);
  assert.equal(dark.knockout_ink, null);
  assert.equal(dark.dark_ground, true);
  const twin = dark.rows.at(-1);
  assert.equal(twin.twin_of, 'dark_ground_full_color');
  assert.equal(twin.tint, '#FFFFFF');
  assert.match(twin.label, /white ink$/);
  const light = planTreatments({ ground: '#F3E9D2', text: '#FFFFFF', logoKnockout: '/k.png', logoColor: '/c.png', logoWords: '/w.png' });
  assert.deepEqual(light.rows.map((r) => r.key), ['knockout', 'full_color', 'words_only']);
  assert.equal(light.knockout_ink, '#000000', '206 Burger: white knockout on cream takes the black ink');
  assert.match(light.rows[0].label, /ink #000000/);
  assert.equal(light.rows[1].tint, null);
  assert.equal(planTreatments({ ground: '#111111', logoKnockout: '/k.png' }).rows.length, 1, 'no color or words asset: just the knockout');
});

test('treatmentRows writes the tinted copies and records primary/source/label and an auto-flipped text on every row of a ground set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-treat-'));
  const png = async (name, fill) => { const f = path.join(dir, name); fs.writeFileSync(f, await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><rect x="5" y="5" width="50" height="20" fill="${fill}"/></svg>`)).png().toBuffer()); return f; };
  const k = await png('k.png', '#FFFFFF'); const c = await png('c.png', '#D7262C');
  const { rows, knockout_ink } = await treatmentRows({ setKey: 'panel_ground', label: 'panel ground', primary: '#F3E9D2', primarySource: 'logo_panel', primaryLabel: 'authored panel color', sheetPrimary: '#111111', sheetText: '#FFFFFF', logoKnockout: k, logoColor: c, logoWords: null, outDir: dir });
  assert.equal(knockout_ink, '#000000');
  assert.deepEqual(rows.map((r) => r.key), ['panel_ground', 'panel_ground_full_color']);
  assert.equal(rows[0].text, '#000000', 'white fails on the pale panel: the row text flips to black');
  assert.equal(rows[0].primary, '#F3E9D2');
  assert.equal(rows[0].primary_source, 'logo_panel');
  assert.equal(rows[0].knockout_ink, '#000000');
  assert.ok(rows[0].logo.endsWith('panel_ground-ink.png') && fs.existsSync(rows[0].logo));
  const { data } = await sharp(rows[0].logo).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[(15 * 60 + 30) * 4], 0, 'the knockout ink was recolored to black');
  assert.equal(rows[1].logo, c, 'the full-color row keeps the authored file');
  assert.equal(rows[1].treatment, 'full_color');
  const dark = await treatmentRows({ setKey: 'dark_ground', primary: '#111111', primarySource: 'dark_ground', sheetPrimary: '#F3E9D2', logoKnockout: k, logoColor: c, outDir: dir });
  assert.equal(dark.rows.at(-1).key, 'dark_ground_full_color_white');
  assert.ok(fs.existsSync(dark.rows.at(-1).logo));
  assert.equal(dark.rows[0].text, '#FFFFFF');
  const decision = await treatmentRows({ sheetPrimary: '#111111', logoKnockout: k, logoColor: c, outDir: dir });
  assert.equal(decision.rows[0].primary, null, 'the decision set inherits the sheet primary');
  assert.equal(decision.rows[0].primary_source, null);
});

test('parseArgs: swap-asset, --all-treatments, --expected and --print-cell parse', () => {
  const swap = parseArgs(['swap-asset', '--run-dir', '/r', '--row', 'knockout', '--logo', 'x.png', '--expected', 'Surfin Burrito']);
  assert.equal(swap.command, 'swap-asset');
  assert.equal(swap.row, 'knockout');
  assert.equal(swap.expected, 'Surfin Burrito');
  const set = parseArgs(['add-row', '--run', '/r', '--primary', '#111111', '--all-treatments']);
  assert.equal(set.allTreatments, true);
  const m = parseArgs(['mark', '--run', '/r', '--cell', 'N', '--status', 'travisse_pick', '--print-cell', 'A']);
  assert.equal(m.printCell, 'A');
});

test('mark --print-cell (rule 19): the picked cell takes the print cell\'s palette as its print roles, its web text turns white when it equals its own band, and the view is rewritten', () => {
  const sheet = sheetWith([{ hex: '#E2A838', source: 'fable_chosen', label: 'chosen' }, { hex: '#111111', source: 'site_token', label: 'site token x3' }]);
  sheet.cells.A.text = '#E2A838'; // Boludo U: gold text on the gold band
  sheet.cells.A.badge_digit_web = badgeDigit('#E2A838', '#E2A838');
  const { cell } = applyPrintCell(sheet, 'A', 'B');
  assert.equal(cell.print_cell, 'B');
  assert.equal(cell.print_primary, '#161616');
  assert.equal(cell.print_secondary, '#111111');
  assert.equal(cell.print_text_secondary, '#FFFFFF', 'B\'s print digit on #111111 has the brand-owned white fix: that is the print text secondary');
  assert.equal(cell.text, '#FFFFFF', 'web text white when it equals the band');
  assert.equal(cell.web_text_was, '#E2A838');
  assert.equal(cell.badge_digit_web.text_color, '#FFFFFF');
  assert.equal(cell.badge_digit_print.text_color, cell.print_text_secondary);
  assert.equal(cell.view.print.secondary, '#111111');
  assert.match(cellLabelText(sheet, cell), /print band #111111/);
  assert.equal(cell.secondary, '#E2A838', 'the web band is untouched');
  // a web text that differs from the band stays
  const other = sheetWith([{ hex: '#E2A838', source: 'fable_chosen', label: 'chosen' }, { hex: '#111111', source: 'site_token', label: 'site token x3' }]);
  applyPrintCell(other, 'A', 'B');
  assert.equal(other.cells.A.text, '#FFFFFF');
  assert.equal(other.cells.A.web_text_was, undefined);
  assert.throws(() => applyPrintCell(other, 'A', 'Z'), /--print-cell "Z" is not on the sheet/);
});

test('cut rows (rule 7) from the cut-words sidecar: descriptor-free knockout and words, inner emblem of a ring badge, badge-only of a self-contained emblem', () => {
  // components: 0 ring (giant, annular), 1-3 "PIZZA" name line inside the ring, 4-5 "PIZZERIA" descriptor line, 6 a bird emblem beside the words, 7 dust
  const cut = {
    ok: true,
    source: { width: 1000, height: 400, total_ink: 100000 },
    components: [
      { id: 0, area: 30000, bbox: [0, 0, 400, 400], enclosed_adjacency: 0.6, decision: 'dropped:giant_emblem_or_ring' },
      { id: 1, area: 9000, bbox: [60, 150, 150, 250], decision: 'kept:name_line' },
      { id: 2, area: 9000, bbox: [160, 150, 250, 250], decision: 'kept:name_line' },
      { id: 3, area: 9000, bbox: [260, 150, 340, 250], decision: 'kept:name_line' },
      { id: 4, area: 2000, bbox: [420, 300, 600, 340], decision: 'dropped:descriptor_line_below_ratio' },
      { id: 5, area: 2000, bbox: [610, 300, 800, 340], decision: 'dropped:descriptor_line_below_ratio' },
      { id: 6, area: 20000, bbox: [700, 20, 980, 260], decision: 'dropped:solo_non_word_shape' },
      { id: 7, area: 2, bbox: [5, 5, 6, 6], decision: 'dropped:dust' },
    ],
    lines: [
      { id: 0, reason: 'kept:name_line', height_ratio: 1, members: [1, 2, 3], bbox: [60, 150, 340, 250] },
      { id: 1, reason: 'dropped:descriptor_line_below_ratio', height_ratio: 0.4, members: [4, 5], bbox: [420, 300, 800, 340] },
    ],
  };
  const plans = planCutRows(cut);
  assert.deepEqual(plans.map((p) => p.key), ['knockout_nodesc', 'emblem_inner', 'badge_only']);
  const nodesc = plans[0];
  assert.deepEqual(nodesc.dropIds, [4, 5]);
  assert.ok(nodesc.keepIds.includes(0) && nodesc.keepIds.includes(6) && !nodesc.keepIds.includes(4), 'the knockout minus the descriptor keeps the ring and the emblem');
  assert.equal(nodesc.source, 'knockout', 'checked against the knockout with the expected words');
  const inner = plans[1];
  assert.deepEqual(inner.keepIds, [1, 2, 3, 7], 'everything inside the ring bbox but the ring');
  assert.equal(inner.source, null, 'no wordmark check on an emblem cut');
  const badge = plans[2];
  assert.deepEqual(badge.keepIds, [6]);
  // a second kept line far shorter than the name is the descriptor that survived the ratio: words_only_nodesc drops it
  const twoLines = { ...cut, lines: [...cut.lines, { id: 2, reason: 'kept:name_line', height_ratio: 0.6, members: [4, 5], bbox: [420, 300, 800, 340] }] };
  twoLines.components = cut.components.map((c) => ([4, 5].includes(c.id) ? { ...c, decision: 'kept:name_line' } : c));
  const withWords = planCutRows({ ...twoLines, lines: [twoLines.lines[0], { id: 1, reason: 'dropped:descriptor_line_below_ratio', height_ratio: 0.3, members: [7], bbox: [5, 5, 6, 6] }, twoLines.lines[2]] });
  const wn = withWords.find((p) => p.key === 'words_only_nodesc');
  assert.ok(wn, 'words_only_nodesc planned');
  assert.deepEqual(wn.keepIds, [1, 2, 3]);
  assert.ok(wn.dropIds.includes(4) && wn.dropIds.includes(0));
  assert.equal(isBadgeCut(cut), true);
  assert.equal(isBadgeCut({ ok: true, components: [{ id: 1, decision: 'kept:name_line' }] }), false);
  assert.deepEqual(planCutRows({ ok: false }), []);
  assert.deepEqual(planCutRows({ ok: true, components: cut.components.slice(1, 4), lines: [cut.lines[0]] }), [], 'a plain wordmark adds no cut row');
});

test('cutRowsFrom cuts the planned rows from the knockout and skips a plan that keeps the whole mark', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cut-'));
  const knockout = path.join(dir, 'k.png');
  // two word blocks (name) and a smaller third block below (descriptor), white on transparent
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect x="20" y="20" width="160" height="80" fill="#fff"/><rect x="220" y="20" width="160" height="80" fill="#fff"/><rect x="120" y="140" width="160" height="30" fill="#fff"/></svg>';
  fs.writeFileSync(knockout, await sharp(Buffer.from(svg)).png().toBuffer());
  const { cutWords } = await import('./cut-words.mjs');
  const cut = await cutWords(knockout, path.join(dir, 'words.png'), { white: true, binaryAlpha: true, width: 1600 });
  assert.equal(cut.ok, true);
  const rows = await cutRowsFrom(cut, knockout, dir, { width: 400 });
  assert.deepEqual(rows.map((r) => r.key), ['knockout_nodesc']);
  assert.ok(fs.existsSync(rows[0].logo));
  assert.equal(rows[0].cut_source, 'knockout');
  assert.match(rows[0].note, /cut-words kept 2 components/);
  assert.ok(fs.existsSync(path.join(dir, 'cut-knockout_nodesc.json')));
});

test('second brand chroma (rule 8): a far site token not already a column, else the in-store dominant; same-hue tints, neutrals and existing columns are not a second chroma', () => {
  const columns = [{ hex: '#86D0CE', source: 'fable_chosen' }, { hex: '#0D4F3D', source: 'site_token' }];
  const ev = { website: { authored_color_tokens: [
    { hex: '#0D4F3D', evidence_class: 'theme_authored', semantic_count: 9 }, // already a column
    { hex: '#9A6BB0', evidence_class: 'theme_authored', semantic_count: 7 }, // tint of the purple primary
    { hex: '#777777', evidence_class: 'theme_authored', semantic_count: 6 }, // neutral
    { hex: '#E8A317', evidence_class: 'theme_authored', semantic_count: 4 }, // the mustard: far from purple and teal
  ] } };
  const hit = secondChromaFor({ evidence: ev, instore: null, primary: '#8E5DA6', chosen: '#86D0CE', columns });
  assert.equal(hit.hex, '#E8A317');
  assert.equal(hit.source, 'site_token');
  assert.match(hit.from, /site token x4/);
  const store = secondChromaFor({ evidence: { website: {} }, instore: { hex: '#C8372D', share: 0.3 }, primary: '#8E5DA6', chosen: '#86D0CE', columns });
  assert.equal(store.source, 'instore');
  assert.equal(secondChromaFor({ evidence: { website: {} }, instore: { hex: '#A070B8', share: 0.3 }, primary: '#8E5DA6', chosen: '#86D0CE', columns }), null, 'a same-hue store sample is not a second chroma');
  assert.equal(secondChromaFor({ evidence: { website: {} }, instore: null, primary: '#8E5DA6', chosen: '#86D0CE', columns }), null);
  assert.match(provenanceWords('second_chroma_sampled', 'site token x4'), /second brand chroma, sampled \(site token x4\)/);
  assert.match(provenanceWords('second_chroma_lifted'), /lifted one step/);
});

test('flat panel hex (rule 11): a lockup whose border is one opaque color names it; a transparent or mixed border does not', async () => {
  const buf = async (svg) => sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const panel = await buf('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#C8102E"/><rect x="10" y="5" width="20" height="10" fill="#fff"/></svg>');
  assert.equal(flatPanelHex(panel.data, panel.info.width, panel.info.height, panel.info.channels), '#C8102E');
  const clear = await buf('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect x="10" y="5" width="20" height="10" fill="#fff"/></svg>');
  assert.equal(flatPanelHex(clear.data, clear.info.width, clear.info.height, clear.info.channels), null);
  const mixed = await buf('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#C8102E"/><rect x="20" width="20" height="20" fill="#1040C0"/></svg>');
  assert.equal(flatPanelHex(mixed.data, mixed.info.width, mixed.info.height, mixed.info.channels), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-panel-'));
  const file = path.join(dir, 'panel.png');
  fs.writeFileSync(file, await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#C8102E"/></svg>')).png().toBuffer());
  assert.equal(await panelHexOf(file), '#C8102E');
});

test('box sticker: a words-only cut of a badge records the panel hex and, when sticker-panel box renders, the box output as the sticker asset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-box-'));
  const words = path.join(dir, 'w.png');
  fs.writeFileSync(words, await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect x="20" y="30" width="360" height="60" fill="#fff"/></svg>')).png().toBuffer());
  const row = { key: 'words_only', label: 'words only', logo: words, sticker_logo: null };
  const out = await boxStickerFor(row, '#111111', dir);
  assert.deepEqual(row.sticker_panel, { hex: '#111111' });
  assert.equal(out, path.join(dir, 'sticker-box-words_only.png'));
  assert.ok(fs.existsSync(out)); assert.equal(row.sticker_logo, out);
  assert.equal('sticker_panel_intent' in row, false, 'no intent field: the box mode is installed');
  // a missing logo: the panel hex stays recorded, no sticker asset
  const bad = { key: 'words_only', label: 'words only', logo: path.join(dir, 'missing.png'), sticker_logo: null };
  assert.equal(await boxStickerFor(bad, '#111111', dir), null);
  assert.deepEqual(bad.sticker_panel, { hex: '#111111' }); assert.equal(bad.sticker_logo, null);
});

test('descriptorInsideLockup: a dropped descriptor inside the name band or naming a business-name token is true, one stacked below is false', () => {
  const inside = { lines: [{ reason: 'kept:name_line', bbox: [0, 0, 1000, 400] }, { reason: 'dropped:descriptor_line_below_ratio', bbox: [300, 250, 700, 380] }] };
  const below = { lines: [{ reason: 'kept:name_line', bbox: [0, 0, 1000, 300] }, { reason: 'dropped:descriptor_line_below_ratio', bbox: [300, 320, 700, 380] }] };
  const named = { lines: [{ reason: 'kept:name_line', bbox: [0, 0, 1000, 300] }, { reason: 'dropped:descriptor_line_below_ratio', bbox: [300, 320, 700, 380], text: "Julia's Kitchen" }] };
  assert.equal(descriptorInsideLockup(inside), true);
  assert.equal(descriptorInsideLockup(below), false);
  assert.equal(descriptorInsideLockup(named, nameTokens("Julia's Kitchen")), true);
  assert.deepEqual(nameTokens("Julia's Kitchen"), ['julia', 'kitchen']);
  assert.equal(descriptorInsideLockup(named, ['pizza']), false);
  assert.equal(descriptorInsideLockup({ lines: [{ reason: 'kept:name_line', bbox: [0, 0, 10, 10] }] }), false, 'no descriptor dropped');
  assert.equal(descriptorInsideLockup({}), false);
  assert.equal(descriptorInsideLockup(null), false);
});

test('FINALIZE at build: no finalize-asset.mjs means no upload fields; a finalize CLI records upload_bytes/upload_path, cached by sha, and the label says upload N KB; the sticker surface records sticker_upload_* with --box-bg from the panel and keeps an exit-3 copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-fin-'));
  const logo = path.join(dir, 'k.png');
  fs.writeFileSync(logo, await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect x="5" y="5" width="30" height="10" fill="#fff"/></svg>')).png().toBuffer());
  const row = { key: 'knockout', label: 'card knockout', logo, logo_sha256: 'sha1' };
  assert.equal(await finalizeRowAsset(row, dir, { cli: path.join(dir, 'missing.mjs') }), null);
  assert.equal(row.upload_bytes, undefined);
  const cli = path.join(dir, 'finalize-stub.mjs');
  fs.writeFileSync(cli, `import fs from 'node:fs'; const a = process.argv; const i = a.indexOf('--in'); const o = a.indexOf('--out'); fs.copyFileSync(a[i + 1], a[o + 1]); process.stdout.write(JSON.stringify({ out: a[o + 1], bytes: fs.statSync(a[o + 1]).size, px: 40, steps: ['stub'] }));`);
  const result = await finalizeRowAsset(row, dir, { cli });
  assert.equal(result.px, 40);
  assert.equal(row.upload_path, path.join(dir, 'upload', 'knockout.png'));
  assert.equal(row.upload_bytes, fs.statSync(logo).size);
  assert.equal(row.upload_sha256, 'sha1');
  const again = await finalizeRowAsset(row, dir, { cli });
  assert.equal(again.cached, true, 'same sha: no second run');
  const sheet = sheetWith([{ hex: '#111111', source: 'fable_chosen', label: 'chosen' }], [row]);
  assert.match(cellLabelText(sheet, sheet.cells.A), /upload \d+ KB$/);
  assert.equal(sheet.cells.A.view ?? null, null);
  const view = cellView(sheet, sheet.cells.A);
  assert.equal(view.upload.bytes, row.upload_bytes);
  // sticker surface: the row's sticker asset, --box-bg from sticker_panel, its own fields; exit 3 still records the file
  const stub3 = path.join(dir, 'finalize-stub3.mjs');
  fs.writeFileSync(stub3, `import fs from 'node:fs'; const a = process.argv; const i = a.indexOf('--in'); const o = a.indexOf('--out'); fs.copyFileSync(a[i + 1], a[o + 1]); process.stdout.write(JSON.stringify({ out: a[o + 1], bytes: fs.statSync(a[o + 1]).size, px: 1000, surface: a[a.indexOf('--surface') + 1], box_bg: a.includes('--box-bg') ? a[a.indexOf('--box-bg') + 1] : null })); process.exit(3);`);
  const boxed = { key: 'words_only', label: 'words only', logo, logo_sha256: 'sha1', sticker_logo: logo, sticker_panel: { hex: '#111111' } };
  const both = await finalizeRowUploads({ sticker_logo: null }, boxed, dir, { cli: stub3 });
  assert.equal(both.card.surface, 'card'); assert.equal(both.card.box_bg, null);
  assert.equal(both.sticker.surface, 'sticker'); assert.equal(both.sticker.box_bg, '#111111');
  assert.equal(boxed.sticker_upload_path, path.join(dir, 'upload', 'words_only-sticker.png'));
  assert.equal(boxed.sticker_upload_bytes, fs.statSync(logo).size); assert.equal(boxed.sticker_upload_fits, false);
  assert.equal(boxed.upload_fits, false, 'exit 3 is the best under-cap copy, recorded as not fitting');
  const twice = await finalizeRowUploads({ sticker_logo: null }, boxed, dir, { cli: stub3 });
  assert.equal(twice.sticker.cached, true, 'same sticker sha: no second run');
  const manifest = sheetWith([{ hex: '#111111', source: 'fable_chosen', label: 'chosen' }], [boxed]);
  const cellView2 = cellView(manifest, manifest.cells.A);
  assert.equal(cellView2.sticker_upload.bytes, boxed.sticker_upload_bytes);
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
import { applyCellViability, cardContrastVerdict, cellLabelText, cellView, gateCells, vanishedInkShare } from './variant-sheet.mjs';

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
