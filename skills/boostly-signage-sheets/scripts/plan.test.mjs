// node --test plan.test.mjs : the applied-cell band default and logo_panel copy (no network, no run dir).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appliedCellDefaults, normalizePanel } from './plan.mjs';

function fixture({ variants, cells, rows = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ variants }));
  fs.mkdirSync(path.join(dir, 'variants'));
  fs.writeFileSync(path.join(dir, 'variants', 'variant-sheet.json'), JSON.stringify({ cells, rows }));
  return dir;
}

test('band defaults to the applied cell sticker_band, never the cell secondary', async () => {
  const dir = fixture({
    variants: { applied_letter: 'K', sheet_json: 'variants/variant-sheet.json' },
    cells: { K: { letter: 'K', row: 'black_card', secondary: '#2BA4B6', sticker_band: '#000000' }, A: { letter: 'A', row: 'knockout', secondary: '#42C0D2', sticker_band: '#333333' } },
  });
  const d = await appliedCellDefaults(dir);
  assert.equal(d.letter, 'K');
  assert.equal(d.band, '#000000');
  assert.equal(d.source, 'applied cell sticker_band');
  assert.equal(d.logo_panel, null);
  assert.equal(d.row, 'black_card');
});

test('a recorded web/print split reads the PRINT cell; sticker_panel is copied as logo_panel', async () => {
  const dir = fixture({
    variants: { applied_letter: 'N', selection: { letter: 'N', print_letter: 'A' } },
    cells: { N: { row: 'knockout', sticker_band: '#1b4fd8', sticker_panel: null }, A: { row: 'panel_ground', sticker_band: '#7a1f1f', sticker_panel: { hex: '#f2e4c8' } } },
  });
  const d = await appliedCellDefaults(dir);
  assert.equal(d.letter, 'A');
  assert.equal(d.band, '#7A1F1F');
  assert.deepEqual(d.logo_panel, { hex: '#F2E4C8' });
  // row-level panel when the cell has none; gradient form
  const dir2 = fixture({ variants: { applied_letter: 'B' }, cells: { B: { row: 'full_color', sticker_band: '#123456' } }, rows: [{ key: 'full_color', sticker_panel: { gradient: ['#ff8800', '#cc2200'] } }] });
  assert.deepEqual((await appliedCellDefaults(dir2)).logo_panel, { gradient: ['#FF8800', '#CC2200'] });
});

test('no sheet, no letter, or no run dir falls through to the authored-role path', async () => {
  assert.deepEqual(await appliedCellDefaults(null), { letter: null, band: null, logo_panel: null, source: null });
  const noLetter = fixture({ variants: { applied_letter: null }, cells: {} });
  assert.equal((await appliedCellDefaults(noLetter)).band, null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ variants: { applied_letter: 'C' } }));
  const noSheet = await appliedCellDefaults(dir);
  assert.equal(noSheet.letter, 'C'); assert.equal(noSheet.band, null);
  assert.equal(normalizePanel({ hex: 'red' }), null);
  assert.deepEqual(normalizePanel({ hex: '#abcdef' }), { hex: '#ABCDEF' });
  assert.equal(normalizePanel({ gradient: ['#abcdef'] }), null);
});
