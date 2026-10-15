// Print units and sheet-name classification, the same table boostly-print-handoff uses
// (scripts/lib/common.mjs KINDS and export-sheets.mjs classify), so the direct renderer's
// per-kind PDFs drop into the hand-off unchanged.
export const KINDS = [
  { kind: 'table-stickers', label: 'Table stickers (promo)' },
  { kind: 'review-stickers', label: 'Table stickers (review)' },
  { kind: 'bathroom-stickers', label: 'Bathroom strips (promo)' },
  { kind: 'bathroom-review-stickers', label: 'Bathroom strips (review)' },
  { kind: 'pop-sign', label: 'POP signs 5x7 (primary + light)' },
  { kind: 'togo-label', label: 'To-go labels (promo + review)' },
];

export function classify(name) {
  const n = name.replace(/^Print Sheet\s*-\s*/i, '');
  const page = Number((n.match(/Page\s+(\d+)/i) || [])[1] || 0);
  if (/Bathroom Review Stickers/i.test(n)) return { kind: 'bathroom-review-stickers', page: page || 1 };
  if (/Bathroom Stickers/i.test(n)) return { kind: 'bathroom-stickers', page: page || 1 };
  if (/Review Stickers/i.test(n)) return { kind: 'review-stickers', page: page || 1 };
  if (/Table Stickers/i.test(n)) return { kind: 'table-stickers', page: page || 1 };
  if (/POP Sign/i.test(n)) return { kind: 'pop-sign', page: /Light/i.test(n) ? 2 : 1 };
  if (/To-?Go Label/i.test(n)) return { kind: 'togo-label', page: /review/i.test(n) ? 2 : 1 };
  return null;
}

// Order sheets per kind (page order) and assign per-page file names like export-sheets.mjs.
export function orderFrames(frames) {
  for (const { kind } of KINDS) {
    const fk = frames.filter((f) => f.kind === kind).sort((a, b) => a.page - b.page);
    fk.forEach((f, i) => { f.page = i + 1; f.file = `${kind}-page-${String(i + 1).padStart(2, '0')}.pdf`; });
  }
  return frames;
}
