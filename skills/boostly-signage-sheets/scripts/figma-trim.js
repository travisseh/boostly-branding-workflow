// figma-trim.js — use_figma code template: trim an ALREADY BUILT Boostly
// signage section down to the real table / stall counts (boostly-signage-sheets).
//
// Paste into `use_figma` (skillNames "figma-use") after substituting the
// parameters, or let the CLI fill them in:
//   node figma-trim.mjs --section 2102:39168 --tables 6 --stalls 2 [--allow-zero]
//
// PARAMETERS:
//   SECTION_ID  '__SECTION_ID__'  section node id
//   TABLES      __TABLES__        table count (1 promo + 1 review sticker per table, 4 per sheet)
//   STALLS      __STALLS__        bathroom stall count (1 strip per stall per variant, 4 per sheet)
//   ALLOW_ZERO  __ALLOW_ZERO__    true to permit TABLES=0 (deletes every table + review sheet)
//
// What it does (trim only; it can never ADD pages, rebuild the set if more are needed):
//   1. Deletes "Print Sheet - Table Stickers ... - Page N" and "Print Sheet - Review
//      Stickers ... [- Page N]" sheets with N > ceil(TABLES/4), and "Bathroom Stickers" /
//      "Bathroom Review Stickers" pages with N > ceil(STALLS/4). A sheet without
//      "- Page N" is page 1.
//   2. On the last remaining sheet of each family, removes sticker frames beyond the
//      remainder (TABLES=6 -> page 2 keeps 2 of 4), in reading order (top-left first).
//      Sticker frames = direct FRAME children sized 900x900 (table/review) or 1300x612
//      (bathroom).
//   3. Re-tidies y: rows at 798.4 + i*2929 per family (x unchanged); bathroom review
//      pages sit at the rows directly under the bathroom promo pages.
//   4. STROKE GATE from SKILL.md on the remaining outer sticker / POP frames.
// Returns removed sheet names, removed sticker ids, and the remaining sheet inventory.
// Run trim BEFORE recopy so recopy only touches stickers that will print.

const SECTION_ID = '__SECTION_ID__';
const TABLES = __TABLES__;
const STALLS = __STALLS__;
const ALLOW_ZERO = __ALLOW_ZERO__;

const PER_SHEET = 4;
const PAGE_Y0 = 798.4;
const PAGE_STEP = 2929;
if (!Number.isInteger(TABLES) || !Number.isInteger(STALLS) || TABLES < 0 || STALLS < 0) throw new Error('TABLES and STALLS must be non-negative integers');
if (TABLES === 0 && !ALLOW_ZERO) throw new Error('TABLES=0 would delete every table and review sheet; pass --allow-zero to confirm');

const sec = await figma.getNodeByIdAsync(SECTION_ID);
if (!sec || sec.type !== 'SECTION') throw new Error(`SECTION_ID ${SECTION_ID} is not a SECTION`);

const FAMILIES = [
  { key: 'table', re: /^Print Sheet - Table Stickers/, total: TABLES, sticker: [900, 900] },
  { key: 'review', re: /^Print Sheet - Review Stickers/, total: TABLES, sticker: [900, 900] },
  { key: 'bathroom', re: /^Print Sheet - Bathroom Stickers/, total: STALLS, sticker: [1300, 612] },
  { key: 'bathroomReview', re: /^Print Sheet - Bathroom Review Stickers/, total: STALLS, sticker: [1300, 612] },
];
const pageOf = n => { const m = /- Page (\d+)\s*$/.exec(n.name); return m ? Number(m[1]) : 1; };
const removedSheets = [];
const removedStickers = [];
const errors = [];
const remaining = {};
const stallPages = Math.ceil(STALLS / PER_SHEET);

for (const fam of FAMILIES) {
  const pagesNeeded = Math.ceil(fam.total / PER_SHEET);
  const sheets = sec.children.filter(n => fam.re.test(n.name)).sort((a, b) => pageOf(a) - pageOf(b));
  if (sheets.length < pagesNeeded) errors.push(`${fam.key}: need ${pagesNeeded} sheets but only ${sheets.length} exist (trim cannot add pages)`);
  const keep = [];
  for (const s of sheets) {
    if (pageOf(s) > pagesNeeded) { removedSheets.push(s.name); s.remove(); } else keep.push(s);
  }
  // last kept sheet: drop stickers beyond the remainder
  if (keep.length && fam.total > 0) {
    const last = keep[keep.length - 1];
    const wanted = fam.total - (pageOf(last) - 1) * PER_SHEET;
    const stickers = last.children
      .filter(c => c.type === 'FRAME' && c.width === fam.sticker[0] && c.height === fam.sticker[1])
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    if (stickers.length < wanted) errors.push(`${fam.key}: ${last.name} holds ${stickers.length} stickers but ${wanted} are needed (trim cannot add stickers)`);
    for (const st of stickers.slice(Math.max(0, wanted))) { removedStickers.push({ sheet: last.name, id: st.id, name: st.name }); st.remove(); }
  }
  // re-tidy rows
  keep.forEach((s, i) => {
    const row = fam.key === 'bathroomReview' ? stallPages + i : i;
    s.y = PAGE_Y0 + row * PAGE_STEP;
  });
  remaining[fam.key] = keep.map(s => ({ id: s.id, name: s.name, y: Math.round(s.y * 10) / 10,
    stickers: s.children.filter(c => c.type === 'FRAME' && c.width === fam.sticker[0] && c.height === fam.sticker[1]).length }));
}

// ---- STROKE GATE (SKILL.md): outer sticker + POP frames only ----
const fixed = [];
for (const f of sec.findAll(n => n.type === 'FRAME' && ((n.width === 900 && n.height === 900) || (n.width === 1500 && n.height === 2100)) && /Print Sheet/i.test(n.parent && n.parent.name || ''))) {
  const s = f.strokes.find(p => p.type === 'SOLID');
  const ok = s && s.color.r === 0 && s.color.g === 0 && s.color.b === 0 && f.strokeWeight === 1 && f.strokeAlign === 'INSIDE';
  if (!ok) { f.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; f.strokeWeight = 1; f.strokeAlign = 'INSIDE'; fixed.push(f.id); }
}
const inventory = sec.children.filter(n => /^Print Sheet - /.test(n.name)).map(n => ({ id: n.id, name: n.name, x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 }));
return { section: sec.name, tables: TABLES, stalls: STALLS, removedSheets, removedStickers, remaining, errors, strokeGateFixed: fixed, inventory,
  mutatedNodeIds: inventory.map(i => i.id) };
