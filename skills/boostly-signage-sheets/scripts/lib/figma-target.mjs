// Single source of truth for WHICH Figma file new signage sections go into.
// Reads ../references/figma-target.json (file key, template section id, grid).
// Existing runs never read this: their run.json figma block carries its own
// file key. Only NEW builds (plan.mjs, closeout agent) resolve through here.
//
// CLI:  node lib/figma-target.mjs            -> prints the resolved target JSON
//       node lib/figma-target.mjs --slot 0 3 -> prints x/y for row 0 col 3
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIGMA_TARGET_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'references', 'figma-target.json',
);

const REQUIRED = ['file_key', 'file_name', 'template_section_id', 'grid'];
const GRID_REQUIRED = ['origin_x', 'origin_y', 'col_step', 'row_step', 'cols_per_row'];

export function validateFigmaTarget(cfg) {
  const errors = [];
  for (const k of REQUIRED) if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') errors.push(`missing ${k}`);
  if (cfg.file_key && !/^[0-9a-zA-Z]{22,128}$/.test(cfg.file_key)) errors.push('file_key is not a Figma file key');
  if (cfg.template_section_id && !/^\d+:\d+$/.test(cfg.template_section_id)) errors.push('template_section_id must look like 123:456');
  if (cfg.grid && typeof cfg.grid === 'object') {
    for (const k of GRID_REQUIRED) if (!Number.isFinite(cfg.grid[k])) errors.push(`grid.${k} must be a number`);
    if (Number.isFinite(cfg.grid.cols_per_row) && cfg.grid.cols_per_row < 1) errors.push('grid.cols_per_row must be >= 1');
  }
  if (cfg.previous_files !== undefined) {
    if (!Array.isArray(cfg.previous_files)) errors.push('previous_files must be an array');
    else cfg.previous_files.forEach((p, i) => { for (const k of ['key', 'name', 'retired_at']) if (!p[k]) errors.push(`previous_files[${i}].${k} missing`); });
  }
  return errors;
}

export function loadFigmaTarget(file = FIGMA_TARGET_PATH) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateFigmaTarget(cfg);
  if (errors.length) throw new Error(`figma-target.json invalid: ${errors.join('; ')}`);
  return cfg;
}

// Nominal canvas position of a grid slot. Row-major. Verify the slot is free
// with a live scan before placing; this is arithmetic, not occupancy.
export function slotPosition(cfg, row, col) {
  const g = cfg.grid;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) throw new Error('row and col must be non-negative integers');
  if (col >= g.cols_per_row) throw new Error(`col ${col} exceeds cols_per_row ${g.cols_per_row}`);
  return { row, col, x: g.origin_x + col * g.col_step, y: g.origin_y + row * g.row_step };
}

// Inverse: which slot a section at (x, y) occupies (nearest), for live scans.
export function slotOf(cfg, x, y) {
  const g = cfg.grid;
  return { row: Math.round((y - g.origin_y) / g.row_step), col: Math.round((x - g.origin_x) / g.col_step) };
}

export function sectionUrl(cfg, sectionId) {
  return `https://www.figma.com/design/${cfg.file_key}/${encodeURIComponent(cfg.file_name)}?node-id=${String(sectionId).replace(':', '-')}`;
}

// plan.json block: everything a Figma driver needs to know about the target.
export function figmaTargetBlock(cfg) {
  return {
    file_key: cfg.file_key,
    file_name: cfg.file_name,
    file_url: cfg.file_url || `https://www.figma.com/design/${cfg.file_key}/${encodeURIComponent(cfg.file_name)}`,
    page_id: cfg.page_id || null,
    template_section_id: cfg.template_section_id,
    template_section_url: sectionUrl(cfg, cfg.template_section_id),
    grid: cfg.grid,
    source: FIGMA_TARGET_PATH,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadFigmaTarget();
  const i = process.argv.indexOf('--slot');
  if (i > -1) {
    const pos = slotPosition(cfg, Number(process.argv[i + 1]), Number(process.argv[i + 2]));
    process.stdout.write(JSON.stringify(pos) + '\n');
  } else {
    process.stdout.write(JSON.stringify(figmaTargetBlock(cfg), null, 2) + '\n');
  }
}
