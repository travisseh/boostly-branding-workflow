import assert from 'node:assert/strict';
import test from 'node:test';
import { FIGMA_TARGET_PATH, figmaTargetBlock, loadFigmaTarget, sectionUrl, slotOf, slotPosition, validateFigmaTarget } from './figma-target.mjs';

test('references/figma-target.json loads and validates', () => {
  const cfg = loadFigmaTarget(FIGMA_TARGET_PATH);
  assert.equal(validateFigmaTarget(cfg).length, 0);
  assert.match(cfg.file_key, /^[0-9a-zA-Z]{22,128}$/);
  assert.match(cfg.template_section_id, /^\d+:\d+$/);
  assert.ok(cfg.grid.cols_per_row >= 1);
  assert.ok(Array.isArray(cfg.previous_files));
  for (const p of cfg.previous_files) assert.notEqual(p.key, cfg.file_key, 'a retired file cannot be the current target');
});

test('slot arithmetic is row-major from the origin', () => {
  const cfg = { file_key: 'A'.repeat(22), file_name: 'f', template_section_id: '1:2', grid: { origin_x: -34214, origin_y: -17774, col_step: 16243, row_step: 16243, cols_per_row: 10 } };
  assert.deepEqual(slotPosition(cfg, 0, 0), { row: 0, col: 0, x: -34214, y: -17774 });
  assert.deepEqual(slotPosition(cfg, 0, 1), { row: 0, col: 1, x: -17971, y: -17774 });
  assert.deepEqual(slotPosition(cfg, 2, 9), { row: 2, col: 9, x: 111973, y: 14712 });
  assert.throws(() => slotPosition(cfg, 0, 10), /exceeds cols_per_row/);
  assert.throws(() => slotPosition(cfg, -1, 0), /non-negative/);
  assert.deepEqual(slotOf(cfg, -17971, -17774), { row: 0, col: 1 });
  assert.deepEqual(slotOf(cfg, 95730, 82455), { row: 6, col: 8 }); // off-rhythm section still resolves to nearest slot
});

test('validation reports every missing field', () => {
  const errs = validateFigmaTarget({ file_key: 'nope', template_section_id: 'x', grid: { origin_x: 'a' }, previous_files: [{}] });
  assert.ok(errs.some((e) => e.includes('missing file_name')));
  assert.ok(errs.some((e) => e.includes('not a Figma file key')));
  assert.ok(errs.some((e) => e.includes('template_section_id')));
  assert.ok(errs.some((e) => e.includes('grid.origin_x')));
  assert.ok(errs.some((e) => e.includes('previous_files[0].key')));
});

test('urls and plan block', () => {
  const cfg = { file_key: 'N5uzBBdCz7ySxxaNTxfKGm', file_name: 'In-Store-Fulfillment-8', template_section_id: '2:2670', grid: { origin_x: 0, origin_y: 0, col_step: 1, row_step: 1, cols_per_row: 1 } };
  assert.equal(sectionUrl(cfg, '2:2670'), 'https://www.figma.com/design/N5uzBBdCz7ySxxaNTxfKGm/In-Store-Fulfillment-8?node-id=2-2670');
  const b = figmaTargetBlock(cfg);
  assert.equal(b.template_section_url, sectionUrl(cfg, '2:2670'));
  assert.equal(b.file_url, 'https://www.figma.com/design/N5uzBBdCz7ySxxaNTxfKGm/In-Store-Fulfillment-8');
  assert.equal(b.grid, cfg.grid);
});
