import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CAP,
  buildDerived,
  collectColors,
  colorSource,
  cssVarsFrom,
  fillTemplate,
  isSampledSource,
  notesLine,
  overrideNote,
  parseArgs,
  resolveText,
  splitFailing,
  validateProposals,
  widestGap,
} from './taste-pass.mjs';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'harness', 'package.json'));
const sharp = require('sharp');

// Scoops-shaped evidence: raspberry card, blue band, a pink scoop that only the sampled palette carries.
const packet = {
  logo_candidates: [{
    local_path: '/run/evidence/logo-candidates/01-first_party_header.png',
    provenance: 'first_party_header',
    measured_colors: [{ hex: '#FEFEFE', pixel_share: 0.2 }, { hex: '#010101', pixel_share: 0.14 }, { hex: '#01A5FB', pixel_share: 0.02 }, { hex: '#C16F0B', pixel_share: 0.005 }],
  }, {
    local_path: '/run/evidence/logo-candidates/07-first_party_header.png',
    provenance: 'first_party_header',
    measured_colors: [{ hex: '#000000', pixel_share: 0.62 }],
  }],
  website: { authored_color_tokens: [{ hex: '#0D4F3D', evidence_class: 'theme_authored', semantic_count: 5 }, { hex: '#1976D2', evidence_class: 'framework_default_risk' }] },
};
const decision = { palette: { web_primary_color: '#B24570', web_secondary_color: '#01A5FB', web_text_color: '#FFFFFF' } };
const sheet = {
  primary: '#B24570', text: '#FFFFFF', instore_dominant: { hex: '#AA434D', share: 0.39, images: 10 },
  columns: [{ index: 0, hex: '#01A5FB', source: 'fable_chosen', label: 'chosen' }, { index: 1, hex: '#0184C8', source: 'depth_darker_10', label: 'darker step -10%' }],
  rows: [{ key: 'knockout', label: 'card knockout', logo: '/run/fix/card-final.png', knockout: true }],
  cells: [{ letter: 'A', row: 'knockout', secondary: '#01A5FB', primary: '#B24570' }, { letter: 'D', row: 'knockout', secondary: '#0184C8', primary: '#B24570' }],
};
const colors = collectColors({ packet, sheet, decision, surfaces: [{ role: 'header', background_color: '#FFF1F5', text_color: '#3E1C2A', viewport: 'desktop' }], cssVars: [{ name: '--accent', hex: '#E381A8', file: 'styles.css' }], sampled: [{ hex: '#F888B8', share: 0.053, file: '01-first_party_header.png' }] });
const brief = {
  cap: DEFAULT_CAP, colors, sheet,
  assets: [
    { path: '/run/fix/card-final.png', kind: 'sheet_row_logo', sha256: 'aaa', width: 1526, height: 698 },
    { path: '/run/evidence/logo-candidates/01-first_party_header.png', kind: 'logo_candidate', sha256: 'bbb', width: 1586, height: 698 },
  ],
};
const proposal = (extra = {}) => ({ id: 'p1', pattern: 'two_tone_swap', label: 'raspberry card, scoop pink band', rationale: 'two-tone pink', logo: { asset: '/run/fix/card-final.png' }, primary: '#B24570', secondary: '#F888B8', text: null, knockout: true, sources: {}, ...extra });
const file = (extra = {}) => ({ missing_options_summary: 'no pink', proposals: [proposal()], ...extra });

test('parseArgs: subcommand, run, cap, model, dry-run; bad model and missing run are errors', () => {
  const a = parseArgs(['apply', '--run', '/r', '--cap', '4', '--model', 'opus', '--dry-run']);
  assert.deepEqual([a.command, a.run, a.cap, a.model, a.dryRun], ['apply', '/r', 4, 'opus', true]);
  assert.equal(parseArgs(['brief', '--run', '/r']).cap, DEFAULT_CAP);
  assert.throws(() => parseArgs(['validate']), /--run/);
  assert.throws(() => parseArgs(['validate', '--run', '/r', '--model', 'gpt']), /--model/);
  assert.throws(() => parseArgs(['--run', '/r']), /Usage/);
});

test('collectColors: every real color carries its source; inks of EVERY candidate enter at 1% (Pig black disc), sampled palette adds the scoop pink, framework tokens are excluded, neutrals come last so a brand black names its source', () => {
  const by = Object.fromEntries(colors.map((c) => [c.hex, c]));
  assert.equal(by['#B24570'].source, 'decision_palette');
  assert.equal(by['#01A5FB'].source, 'decision_palette', 'first source wins, the ink is an also');
  assert.ok(by['#01A5FB'].also.some((a) => a.source === 'logo_ink'));
  assert.equal(by['#000000'].source, 'logo_ink', JSON.stringify(by['#000000']));
  assert.match(by['#000000'].detail, /62\.0% of 07-first_party_header\.png/);
  assert.equal(by['#F888B8'].source, 'logo_sampled');
  assert.equal(by['#C16F0B'], undefined, 'under 1% is antialias');
  assert.equal(by['#0D4F3D'].source, 'site_token');
  assert.equal(by['#1976D2'], undefined, 'framework defaults are not brand colors');
  assert.equal(by['#FFF1F5'].source, 'site_surface');
  assert.equal(by['#E381A8'].source, 'site_css_var');
  assert.equal(by['#AA434D'].source, 'instore');
  assert.equal(by['#0184C8'].source, 'sheet_column');
  assert.equal(by['#FFFFFF'].source, 'decision_palette', 'web_text_color names white first');
});

test('cssVarsFrom: reads --name: #hex from first-party files, skips framework prefixes, dedupes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-css-'));
  fs.writeFileSync(path.join(dir, 'styles.css'), ':root{--primary:#B24570;--accent: #E381A8;--bs-blue:#0d6efd;--accent:#E381A8}');
  const vars = cssVarsFrom([path.join(dir, 'styles.css'), path.join(dir, 'missing.css')]);
  assert.deepEqual(vars.map((v) => `${v.name}=${v.hex}`), ['--primary=#B24570', '--accent=#E381A8']);
});

test('colorSource: a listed color matches within 24 RGB; a darker step of a brand hue is allowed and marked; a lighter tint, an unknown hue, and an unlisted gray are refused', () => {
  assert.equal(colorSource('#F98AB9', colors).matched, '#F888B8');
  const darker = colorSource('#8E3759', colors);
  assert.equal(darker.ok, true, JSON.stringify(darker));
  assert.equal(darker.synthetic?.direction, 'darker');
  assert.equal(darker.synthetic?.of, '#B24570');
  assert.equal(colorSource('#4DBFFC', colors).reason, 'color_lighter_synthetic', 'a lighter tint of the blue band');
  // rule 8 (2026-10-19): a lighter step off a SAMPLED base is allowed (the photo sample is shadowed); off an authored token it stays refused
  const lifted = colorSource('#C65A64', colors);
  assert.equal(lifted.ok, true, JSON.stringify(lifted));
  assert.deepEqual([lifted.synthetic?.direction, lifted.synthetic?.of, lifted.source], ['lighter', '#AA434D', 'instore']);
  assert.equal(isSampledSource({ source: 'site_token', also: [{ source: 'instagram_recurring' }] }), true, 'an also-source counts');
  assert.equal(isSampledSource({ source: 'logo_ink', also: [] }), false);
  assert.equal(colorSource('#C9668B', colors).synthetic?.direction, 'darker', 'between raspberry and the site rose it is a darker step of the rose');
  assert.equal(colorSource('#2ECC71', colors).reason, 'color_not_in_evidence');
  assert.equal(colorSource('#777777', colors).reason, 'color_not_in_evidence');
  assert.equal(colorSource('nope', colors).reason, 'invalid_hex');
});

test('resolveText (web/print split): Scoops K takes black text because white vanishes on the pink band; Boludo U keeps the pick in print and gives the web the readable text', () => {
  const scoops = resolveText({ primary: '#B24570', secondary: '#F888B8', text: null, sheetText: '#FFFFFF', printDigit: null });
  assert.equal(scoops.text, '#000000');
  assert.equal(scoops.print_digit, null, 'black reads on both, no print digit needed');
  const boludo = resolveText({ primary: '#000000', secondary: '#C9A227', text: '#C9A227', sheetText: '#FFFFFF', printDigit: '#000000' });
  assert.equal(boludo.text, '#FFFFFF', 'gold text on a gold band has no digit; web text goes white');
  assert.equal(boludo.print_digit, '#000000');
  assert.ok(boludo.notes.some((n) => /web text #FFFFFF instead of #C9A227/.test(n)));
  const white = resolveText({ primary: '#000000', secondary: '#42C0D2', text: '#FFFFFF', sheetText: '#FFFFFF', printDigit: null });
  assert.equal(white.text, '#FFFFFF');
  assert.equal(white.print_digit, '#000000', 'white on turquoise fails the digit, print gets black');
});

test('validateProposals: a good two-tone swap is accepted with resolved text and plain-word sources; structure errors, the cap, unknown colors, lighter tints, near-white cards, invisible bands, unknown assets and derive ops are refused with reasons', () => {
  const ok = validateProposals(brief, file());
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.accepted.length, 1, JSON.stringify(ok.refused));
  assert.equal(ok.accepted[0].text, '#000000');
  assert.match(ok.accepted[0].note, /band #F888B8 logo_sampled/);
  assert.equal(ok.accepted[0].escalation, null);
  assert.deepEqual(validateProposals(brief, []).errors, ['proposals_must_be_object']);
  assert.ok(validateProposals(brief, { proposals: 'x' }).errors.some((e) => e.startsWith('missing_key:proposals')));
  assert.ok(validateProposals(brief, file({ proposals: Array.from({ length: 7 }, (_, i) => proposal({ id: `p${i}` })) })).errors.some((e) => e.startsWith('too_many_proposals')));
  const refusedOf = (p) => validateProposals(brief, file({ proposals: [p] })).refused[0]?.reasons ?? [];
  assert.match(refusedOf(proposal({ secondary: '#2ECC71' }))[0], /secondary_color_not_in_evidence/);
  assert.match(refusedOf(proposal({ secondary: '#4DBFFC' }))[0], /secondary_color_lighter_synthetic/);
  assert.match(refusedOf(proposal({ primary: '#FFF1F5', secondary: '#B24570' }))[0], /primary_too_light/);
  assert.match(refusedOf(proposal({ primary: '#B24570', secondary: '#AA434D' }))[0], /band_invisible/);
  assert.match(refusedOf(proposal({ logo: { asset: '/run/fix/other.png' } }))[0], /logo_not_in_brief/);
  assert.match(refusedOf(proposal({ logo: { derive: { op: 'recolor', from: '/run/fix/card-final.png' } } }))[0], /derive_op_not_allowed/);
  assert.match(refusedOf(proposal({ logo: { derive: { op: 'crop', from: '/run/fix/card-final.png', box: [0, 0, 9000, 10] } } }))[0], /crop_box_outside_asset/);
  assert.match(refusedOf(proposal({ pattern: 'vibes' }))[0], /unknown_pattern/);
  assert.match(refusedOf(proposal({ expected_words: 42 }))[0], /expected_words_not_text/);
  const lifted = validateProposals(brief, file({ proposals: [proposal({ primary: '#000000', secondary: '#C65A64', expected_words: 'SCOOPS' })] })).accepted[0];
  assert.ok(lifted, 'a lifted in-store sample is an accepted band');
  assert.match(lifted.note, /band #C65A64 lighter step of #AA434D \(instore, sampled; lifted to de-shadow the sample\)/);
  assert.equal(lifted.expected_words, 'SCOOPS', 'expected_words rides along to add-cell --expected');
  assert.equal(validateProposals(brief, file()).accepted[0].expected_words, null);
});

test('validateProposals: a duplicate of an existing cell is refused by letter; a light ground is accepted but labeled and escalated; a derivation is accepted with its recipe', () => {
  const dup = validateProposals(brief, file({ proposals: [proposal({ secondary: '#0184C8' })] }));
  assert.deepEqual(dup.refused[0].reasons, ['duplicate_of_cell:D']);
  const light = validateProposals(brief, file({ proposals: [proposal({ primary: '#F888B8', secondary: '#B24570', knockout: false })] })).accepted[0];
  assert.equal(light.escalation, 'light_ground');
  assert.match(light.label, /^LIGHT GROUND: /);
  assert.match(light.note, /escalate before a pick/);
  const stacked = validateProposals(brief, file({ proposals: [proposal({ logo: { derive: { op: 'stack', from: '/run/fix/card-final.png', split: 'auto', gap: 30 } } })] })).accepted[0];
  assert.equal(stacked.logo.kind, 'derive');
  assert.deepEqual(stacked.logo.recipe, { op: 'stack', from: '/run/fix/card-final.png', from_sha256: 'aaa', split: 'auto', gap: 30 });
  const cut = validateProposals(brief, file({ proposals: [proposal({ logo: { derive: { op: 'cut_words', from: '/run/evidence/logo-candidates/01-first_party_header.png', drop_ids: [77, 78], white: true } } })] })).accepted[0];
  assert.deepEqual(cut.logo.recipe.drop_ids, [77, 78]);
  assert.equal(cut.logo.recipe.white, true);
});

test('splitFailing: hard holds versus overridable gates follow the registry; a stack tolerates ink-retention', () => {
  const gates = [
    { id: 'ship-gate', override_allowed: false },
    { id: 'upload-size', override_allowed: true },
    { id: 'ink-retention', override_allowed: true, override_allowed_verdicts: ['authored_white_dropped'] },
  ];
  const failing = [{ gate: 'ship-gate', verdict: 'FAIL' }, { gate: 'upload-size', verdict: 'upload_over_byte_cap' }, { gate: 'ink-retention', verdict: 'authored_ink_lost' }];
  const plain = splitFailing(failing, gates);
  assert.deepEqual(plain.hard.map((f) => f.gate), ['ship-gate', 'ink-retention']);
  assert.deepEqual(plain.overridable.map((f) => f.gate), ['upload-size']);
  const stack = splitFailing(failing, gates, { tolerate: ['ink-retention'] });
  assert.deepEqual(stack.hard.map((f) => f.gate), ['ship-gate']);
  assert.deepEqual(splitFailing([{ gate: 'ink-retention', verdict: 'authored_white_dropped' }], gates).overridable.length, 1);
});

test('derivations: stack splits at the widest transparent gap and copies pixels verbatim; crop trims to the alpha bbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-derive-'));
  const src = path.join(dir, 'lockup.png');
  // a 100x40 lockup: a 20x40 red icon, a 30-column gap, a 50x20 blue wordmark
  await sharp({ create: { width: 100, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: await sharp({ create: { width: 20, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp({ create: { width: 50, height: 20, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer(), left: 50, top: 10 },
    ]).png().toFile(src);
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(widestGap(data, info.width, info.height), { start: 20, end: 50, width: 30 });
  const out = path.join(dir, 'stacked.png');
  const receipt = await buildDerived({ op: 'stack', from: src, split: 'auto', gap: 10 }, out);
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.width, meta.height], [50, 70]);
  assert.equal(receipt.split_at, 20);
  const stacked = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => Array.from(stacked.data.slice((y * 50 + x) * 4, (y * 50 + x) * 4 + 4));
  assert.deepEqual(px(25, 5), [255, 0, 0, 255], 'icon centered on top');
  assert.deepEqual(px(25, 55), [0, 0, 255, 255], 'wordmark below the gap');
  assert.deepEqual(px(25, 45), [0, 0, 0, 0], 'the gap is transparent');
  const crop = path.join(dir, 'crop.png');
  await buildDerived({ op: 'crop', from: src, box: [40, 0, 60, 40], trim: true }, crop);
  const cm = await sharp(crop).metadata();
  assert.deepEqual([cm.width, cm.height], [50, 20], 'trimmed to the wordmark');
  await assert.rejects(buildDerived({ op: 'stack', from: crop, split: 'auto', gap: 10 }, path.join(dir, 'no.png')), /no transparent column gap/);
});

test('overrideNote: upload-size folds into the pick notice, any other overridable gate names the closeout override; never a human call', () => {
  assert.equal(overrideNote({ gate: 'upload-size', verdict: 'over_cap' }), 'over the upload cap: folded into the pick notice (picking this letter also OKs the sticker size)');
  assert.equal(overrideNote({ gate: 'ink-retention', verdict: 'thin_strokes' }), 'needs override at closeout: ink-retention (thin_strokes) (registry allows it)');
  assert.equal(overrideNote({ gate: 'render-legibility' }), 'needs override at closeout: render-legibility (failed) (registry allows it)');
  assert.doesNotMatch(overrideNote({ gate: 'upload-size' }), /human call/);
});

test('notesLine: one true sentence with letters, hand builds, holds and the light-ground escalation', () => {
  assert.equal(notesLine({ model: 'fable', added: [], skipped: [], needsBuild: [], summary: 'the sheet covers the brand' }), 'Taste pass (fable) added nothing: the sheet covers the brand.');
  const line = notesLine({ model: 'opus', added: [{ letter: 'K', label: 'raspberry card, pink band' }, { letter: 'L', label: 'pink card', escalation: 'light_ground' }], skipped: [{ id: 'p3', reason: 'gate hold: ship-gate' }], needsBuild: [{ id: 'p4', reason: 'no gap' }], summary: null });
  assert.match(line, /^Taste pass \(opus\) added K, L \(raspberry card, pink band; pink card\)\./);
  assert.match(line, /1 proposal needs a hand build \(p4: no gap\)/);
  assert.match(line, /1 kept off the sheet \(p3: gate hold: ship-gate\)/);
  assert.match(line, /light ground, escalate before a pick: L\.$/);
});

test('fillTemplate: every placeholder is filled from the brief images; missing captures say so', () => {
  const template = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'references', 'taste-pass-prompt-template.md'), 'utf8');
  const out = fillTemplate(template, { runDir: '/run', name: 'Scoops', cap: 6, images: { sheet_png: '/run/variants/variant-sheet.png', sheet_html: '/run/variants/variant-sheet.html', website: [], gbp_photos: ['/run/gbp-photos/1.jpg'], logo_candidates: ['/run/evidence/logo-candidates/01.png'], brand_environment_contact_sheet: null } });
  assert.ok(!/\{[A-Z_]+\}/.test(out), out.match(/\{[A-Z_]+\}/g)?.join(','));
  assert.ok(out.startsWith('\nYou are the taste pass'), 'the launcher notes above the separator are not part of the prompt');
  assert.match(out, /`\/run\/taste\/brief\.json`/);
  assert.match(out, /none captured/);
  assert.match(out, /At most 6 proposals/);
});
