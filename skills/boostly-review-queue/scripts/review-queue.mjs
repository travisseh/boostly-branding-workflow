#!/usr/bin/env node
// Build and spot-edit Boostly "Fulfillment Review Queue" Notion pages.
//   build  --title "<title>" --ledgers a.json b.json ... [--intro "<text>"] [--dry-run]
//   upsert --page <id> --ledger x.json [--links 1] [--variants-only 1] [--run <run_dir>]
//          --run records page/block ids in <run_dir>/run.json (notion block) after the upsert
//   status --page <id>
// Never deletes blocks. See SKILL.md for the format contract and limitations.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { api, listChildren, appendChildren, normalizeId, text, plain, uploadFile, imageBlock, DATA_SOURCE_ID } from './notion-client.mjs';

const RUN_FILE_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'boostly-box-fulfillment', 'scripts', 'run-file.ts');

// Record the Notion ids in run.json (notion block) so nothing about the page is retyped later.
function recordNotionBlock(runDir, pageId, result) {
  const runJson = path.join(runDir, 'run.json');
  if (!fs.existsSync(runJson)) throw new Error(`--run ${runDir}: no run.json there`);
  const previous = JSON.parse(fs.readFileSync(runJson, 'utf8')).notion || {};
  const block = {
    ...previous,
    page_id: pageId,
    block_id: result.block_id || previous.block_id || null,
    section: result.section || previous.section || null,
    entry: result.number ?? previous.entry ?? null,
    last_patched_at: new Date().toISOString(),
    last_action: result.action,
    last_patched: result.patched || [],
  };
  const tmp = path.join(runDir, `.notion-block.${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(block));
  try {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', RUN_FILE_CLI, 'set', runDir, 'notion', '--from', tmp, '--by', 'review-queue'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`run-file set notion failed: ${(r.stderr || r.stdout || '').trim()}`);
  } finally { fs.unlinkSync(tmp); }
  return block;
}

const SLACK_CHANNEL = 'C09MSM8MA9Y';
const NARRATIVE_FIELDS = ['Verdict', 'Applied', 'Signage', 'Open'];
const VARIANT_FIELD = 'Variant';
const LINK_FIELDS = ['V2 account', 'Slack', 'Figma', 'Website', 'GBP', 'Logo search'];
const FIELD_ORDER = [...NARRATIVE_FIELDS, VARIANT_FIELD, ...LINK_FIELDS];
const DASH = '—';

// ---------- CLI ----------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'ledgers') { args.ledgers = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.ledgers.push(argv[++i]); }
    else if (key === 'dry-run') args.dryRun = true;
    else args[key] = argv[++i];
  }
  return args;
}

function loadLedger(file) {
  const l = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['business', 'city', 'account_id']) if (!l[k]) throw new Error(`${file}: ledger missing "${k}"`);
  l.status = (l.status || 'waiting').toLowerCase();
  if (!['waiting', 'done'].includes(l.status)) throw new Error(`${file}: status must be waiting|done`);
  if (l.ease != null) l.ease = Number(l.ease);
  return l;
}

// ---------- rendering ----------
function isRealPlaceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(id.trim()) && !/manual/i.test(id);
}

export function headingLabel(l) {
  if (l.label) return l.label;
  if (l.status === 'done') return 'DONE';
  return l.waiting_on ? `waiting on ${l.waiting_on}` : 'waiting';
}

export function headingText(n, l, prefixDone = false) {
  const ease = l.ease ? `  [ease ${l.ease}/5]` : '';
  const pre = prefixDone ? 'DONE ' : '';
  return `${pre}${n}. ${l.business} (${l.city}) ${DASH} ${headingLabel(l)}${ease}`;
}

function slackCells(l) {
  if (!l.slack_ts) return text('(no Slack thread)');
  const ch = l.slack_channel || SLACK_CHANNEL;
  const ts = String(l.slack_ts);
  const deep = `slackMessage://boostlyinc.slack.com/${ch}/${ts}/${ts}`;
  const web = `https://boostlyinc.slack.com/archives/${ch}/p${ts.replace('.', '')}`;
  return text(deep, { url: web });
}

function gbpCells(l) {
  if (isRealPlaceId(l.place_id)) {
    const u = `https://www.google.com/maps/place/?q=place_id:${l.place_id.trim()}`;
    return text(u, { url: u });
  }
  const q = encodeURIComponent([l.business, l.address || l.city].filter(Boolean).join(' '));
  return [...text('Manual place ID, no GBP link. '), ...text('Google search', { url: `https://www.google.com/search?q=${q}` })];
}

function logoSearchCells(l) {
  const hasCity = l.business.toLowerCase().includes(l.city.toLowerCase());
  const q = encodeURIComponent(`${l.business}${hasCity ? '' : ' ' + l.city} logo`);
  const u = `https://www.google.com/search?tbm=isch&q=${q}`;
  return text(u, { url: u });
}

function linkCells(url, fallback) {
  return url ? text(url, { url }) : text(fallback);
}

// ---------- variant sheets ----------
// ledger.variant_sheets: [{ png, json?, label?, applied_letter? }]. The sheet's variant-sheet.json maps letters to
// exact hexes and logo paths (cells[letter]); ledger.applied_variant is a free-text override for the Variant cell.
function readCell(sheet) {
  if (!sheet.json || !sheet.applied_letter || !fs.existsSync(sheet.json)) return null;
  const j = JSON.parse(fs.readFileSync(sheet.json, 'utf8'));
  return j.cells?.[sheet.applied_letter] || null;
}

function digitHex(cell) {
  const d = cell.badge_digit_print || {};
  if (d.pass === false && d.fix) return d.fix;
  return d.text_color || cell.print_text_secondary || null;
}

export function variantSheets(l) {
  const overrideLetter = typeof l.applied_variant === 'string' ? l.applied_variant.trim().match(/^([A-Z]{1,2})\b/)?.[1] : null;
  return (l.variant_sheets || []).filter(s => s && s.png).map(s => {
    const letter = s.applied_letter || overrideLetter || null;
    const cell = readCell(s);
    let summary = null;
    if (cell) summary = `Applied: ${letter} (${cell.row_label || cell.row || 'row ?'}, primary ${cell.primary} / secondary ${cell.secondary}, digit ${digitHex(cell) || 'n/a'})`;
    else if (letter) summary = `Applied: ${letter}`;
    return { ...s, label: s.label || path.basename(s.png), letter, cell, summary };
  });
}

export function variantCellText(l) {
  if (l.applied_variant) return `Applied: ${String(l.applied_variant).trim()}`;
  const parts = variantSheets(l).map(s => s.summary).filter(Boolean);
  return parts.length ? parts.join('; ') : '(no variant sheet)';
}

export function sheetCaption(sheet) {
  return [...text(`Variant sheet ${sheet.label}. `), ...text(`Applied: ${sheet.letter || '(letter not derivable)'}.`, { bold: true })];
}

function sheetBlocks(l, uploads) {
  // uploads: Map<png path, file_upload id>; null on --dry-run (placeholder ids so the JSON stays readable).
  return variantSheets(l).map(s => imageBlock(uploads?.get(s.png) ?? `<upload:${s.png}>`, sheetCaption(s)));
}

async function uploadSheets(ledgers) {
  const uploads = new Map();
  for (const l of ledgers) for (const s of variantSheets(l)) {
    if (!uploads.has(s.png)) uploads.set(s.png, await uploadFile(s.png));
  }
  return uploads;
}

export function detailCells(field, l) {
  switch (field) {
    case 'Verdict': return text(l.verdict || '(pending)');
    case 'Applied': return text(l.applied || '(nothing applied)');
    case 'Signage': return text(l.signage || '(no signage yet)');
    case 'Open': return text(l.open || 'None.');
    case 'Variant': return text(variantCellText(l));
    case 'V2 account': return linkCells(`https://new.boostly.com/admin/accounts/${l.account_id}`);
    case 'Slack': return slackCells(l);
    case 'Figma': return linkCells(l.figma_url, '(no Figma section yet)');
    case 'Website': return linkCells(l.website || l.ordering_url, '(no website on file)');
    case 'GBP': return gbpCells(l);
    case 'Logo search': return logoSearchCells(l);
    default: throw new Error(`unknown field ${field}`);
  }
}

function row(field, cells) {
  return { object: 'block', type: 'table_row', table_row: { cells: [text(field, { bold: true }), cells] } };
}

export function toggleBlock(n, l, prefixDone = false, uploads = null, withImages = true) {
  const rows = [row('Field', text('Detail', { bold: true })), ...FIELD_ORDER.map(f => row(f, detailCells(f, l)))];
  const children = [{ object: 'block', type: 'table', table: { table_width: 2, has_column_header: true, has_row_header: false, children: rows } }];
  if (withImages) children.push(...sheetBlocks(l, uploads));
  return {
    object: 'block', type: 'heading_3',
    heading_3: { rich_text: text(headingText(n, l, prefixDone)), is_toggleable: true, children },
  };
}

function h(level, content) { return { object: 'block', type: `heading_${level}`, [`heading_${level}`]: { rich_text: text(content) } }; }
function para(content) { return { object: 'block', type: 'paragraph', paragraph: { rich_text: text(content) } }; }

function orderLedgers(ledgers) {
  // Global numbering by ease (easiest first, ties keep input order); sections keep that order.
  const numbered = ledgers.map((l, i) => ({ l, i })).sort((a, b) => (a.l.ease ?? 99) - (b.l.ease ?? 99) || a.i - b.i)
    .map((x, idx) => ({ ...x, n: idx + 1 }));
  return {
    waiting: numbered.filter(x => x.l.status === 'waiting'),
    done: numbered.filter(x => x.l.status === 'done'),
  };
}

function defaultIntro(ledgers) {
  const names = ledgers.map(l => l.business).join(', ');
  return `Review queue for the automated tap-card + signage fulfillments (${names}). Ordered easiest-first. Open each toggle for the details table and review links (Slack thread, Figma section, website, Google Business Profile, Google Images logo search). All sets are labeled GENERATED in Figma until blessed; flip to PRODUCTION and ping Karissa in the thread after review.`;
}

export function pageChildren(ledgers, intro, uploads = null, withImages = true) {
  const { waiting, done } = orderLedgers(ledgers);
  return [
    para(intro || defaultIntro(ledgers)),
    h(2, 'Ordered review queue (easiest first)'),
    h(1, 'Waiting'), ...waiting.map(x => toggleBlock(x.n, x.l, false, uploads, withImages)),
    h(1, 'Done'), ...done.map(x => toggleBlock(x.n, x.l, false, uploads, withImages)),
  ];
}

// ---------- page model (read) ----------
async function readQueue(pageId) {
  const top = await listChildren(pageId);
  const entries = [];
  let section = null;
  const sections = {};
  for (let i = 0; i < top.length; i++) {
    const b = top[i];
    if (b.type === 'heading_1') { section = plain(b.heading_1.rich_text).trim(); sections[section] = { block: b, index: i, lastIndex: i }; continue; }
    if (section) sections[section].lastIndex = i;
    if (b.type === 'heading_3') entries.push({ block: b, index: i, section, title: plain(b.heading_3.rich_text) });
  }
  return { top, entries, sections };
}

function findSection(sections, name) {
  const key = Object.keys(sections).find(k => k.toLowerCase().trim() === name.toLowerCase());
  return key ? sections[key] : null;
}

function matchEntry(entries, l) {
  const needle = `${l.business} (${l.city})`.toLowerCase();
  const alt = l.business.toLowerCase();
  return entries.find(e => e.title.toLowerCase().includes(needle))
    || entries.find(e => e.title.toLowerCase().includes(alt) && e.title.toLowerCase().includes(l.city.toLowerCase()));
}

async function entryTable(entry) {
  const kids = await listChildren(entry.block.id);
  const table = kids.find(k => k.type === 'table');
  if (!table) return null;
  const rows = await listChildren(table.id);
  const map = {};
  for (const r of rows) map[plain(r.table_row.cells[0]).trim()] = r;
  const images = kids.filter(k => k.type === 'image');
  return { table, rows, map, kids, images };
}

function findSheetImage(images, sheet) {
  const prefix = `Variant sheet ${sheet.label}`.toLowerCase();
  return images.find(img => plain(img.image.caption).trim().toLowerCase().startsWith(prefix));
}

// Variant row + variant sheet images for one existing toggle. PATCHes the row if present, else APPENDs it after Open;
// PATCHes an image caption only when the applied letter changed, else uploads and appends the image. Never deletes.
async function syncVariant(entry, t, l, result) {
  const cells = detailCells(VARIANT_FIELD, l);
  const r = t.map[VARIANT_FIELD];
  if (r) {
    if (plain(r.table_row.cells[1]) !== plain(cells)) {
      await api('PATCH', `/blocks/${r.id}`, { table_row: { cells: [r.table_row.cells[0], cells] } });
      result.patched.push(VARIANT_FIELD);
    }
  } else {
    const after = t.map.Open?.id || t.rows.at(-1)?.id;
    const created = await appendChildren(t.table.id, [row(VARIANT_FIELD, cells)], after);
    result.patched.push(`${VARIANT_FIELD} (row appended ${created[0]?.id || ''})`.trim());
  }
  let lastChild = t.kids.at(-1)?.id;
  for (const s of variantSheets(l)) {
    const caption = sheetCaption(s);
    const existing = findSheetImage(t.images, s);
    if (existing) {
      if (plain(existing.image.caption) !== plain(caption)) {
        await api('PATCH', `/blocks/${existing.id}`, { image: { caption } });
        result.patched.push(`image caption ${s.label} (${existing.id})`);
      }
      continue;
    }
    const uploadId = await uploadFile(s.png);
    const created = await appendChildren(entry.block.id, [imageBlock(uploadId, caption)], lastChild);
    lastChild = created[0]?.id || lastChild;
    result.patched.push(`image appended ${s.label} (${created[0]?.id || ''})`.trim());
  }
}

// ---------- commands ----------
async function build(args) {
  if (!args.title) throw new Error('build needs --title');
  if (!args.ledgers?.length) throw new Error('build needs --ledgers a.json ...');
  const ledgers = args.ledgers.map(loadLedger);
  if (args.dryRun) { console.log(JSON.stringify(pageChildren(ledgers, args.intro, null), null, 2)); return; }

  const uploads = await uploadSheets(ledgers);
  const children = pageChildren(ledgers, args.intro, uploads);
  const page = await api('POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
    properties: { Name: { title: text(args.title) }, Category: { select: { name: args.category || 'research' } } },
  });
  const notes = [];
  try {
    await appendChildren(page.id, children);
  } catch (e) {
    if (!uploads.size) throw e;
    // Notion rejected file_upload images nested under the toggles in the create request:
    // append the body without images, then append each toggle's images after its table.
    notes.push(`nested image append rejected (${e.message}); images appended per toggle instead`);
    await appendChildren(page.id, pageChildren(ledgers, args.intro, null, false));
    const q0 = await readQueue(page.id);
    for (const l of ledgers) {
      const entry = matchEntry(q0.entries, l);
      const blocks = sheetBlocks(l, uploads);
      if (entry && blocks.length) await appendChildren(entry.block.id, blocks);
    }
  }

  // verify by reading back
  const q = await readQueue(page.id);
  const problems = [];
  if (q.top.length !== children.length) problems.push(`top-level blocks ${q.top.length} != expected ${children.length}`);
  if (q.entries.length !== ledgers.length) problems.push(`toggles ${q.entries.length} != ledgers ${ledgers.length}`);
  for (const e of q.entries) {
    const t = await entryTable(e);
    if (!t) { problems.push(`no table under "${e.title}"`); continue; }
    if (t.rows.length !== FIELD_ORDER.length + 1) problems.push(`"${e.title}" has ${t.rows.length} rows, expected ${FIELD_ORDER.length + 1}`);
    const l = ledgers.find(x => matchEntry([e], x));
    const want = l ? variantSheets(l).length : 0;
    if (t.images.length !== want) problems.push(`"${e.title}" has ${t.images.length} variant sheet images, expected ${want}`);
  }
  const url = page.url || `https://www.notion.so/${page.id.replace(/-/g, '')}`;
  console.log(JSON.stringify({ id: page.id, url, top_level_blocks: q.top.length, toggles: q.entries.length, verified: problems.length === 0, problems, notes }, null, 2));
  if (problems.length) process.exitCode = 1;
}

async function upsert(args) {
  if (!args.page || !args.ledger) throw new Error('upsert needs --page <id> --ledger x.json');
  const pageId = normalizeId(args.page);
  const l = loadLedger(args.ledger);
  const variantsOnly = Boolean(args['variants-only']);
  const q = await readQueue(pageId);
  const entry = matchEntry(q.entries, l);
  const result = { business: l.business, city: l.city, action: null, patched: [], notes: [] };

  if (entry) {
    const t = await entryTable(entry);
    if (!t) throw new Error(`toggle "${entry.title}" has no table; refusing to guess`);
    if (!variantsOnly) {
      // Keep the existing number; rewrite the label; flag a section mismatch with a DONE prefix.
      const m = entry.title.match(/^(?:DONE\s+)?(\d+)\./);
      const n = m ? Number(m[1]) : q.entries.length;
      const inWaiting = (entry.section || '').toLowerCase().startsWith('waiting');
      const prefixDone = l.status === 'done' && inWaiting;
      const newTitle = headingText(n, l, prefixDone);
      if (newTitle !== entry.title) {
        await api('PATCH', `/blocks/${entry.block.id}`, { heading_3: { rich_text: text(newTitle) } });
        result.patched.push('heading');
      }
      if (prefixDone) result.notes.push('Ledger says done but the toggle sits under Waiting. Blocks cannot be moved by the API, so the heading was prefixed with "DONE ". Drag it under Done by hand if you want it there.');
      if (l.status === 'waiting' && !inWaiting) result.notes.push('Ledger says waiting but the toggle sits under Done; heading updated in place, not moved.');

      const fields = [...NARRATIVE_FIELDS.filter(f => l[f.toLowerCase()] != null), ...(args.links ? LINK_FIELDS : [])];
      for (const f of fields) {
        const r = t.map[f];
        if (!r) { result.notes.push(`no "${f}" row in the table; skipped (append it by hand)`); continue; }
        const cells = detailCells(f, l);
        const current = plain(r.table_row.cells[1]);
        if (current === plain(cells) && current !== '') continue;
        await api('PATCH', `/blocks/${r.id}`, { table_row: { cells: [r.table_row.cells[0], cells] } });
        result.patched.push(f);
      }
    }
    // Variant row + sheet images: whenever the ledger carries variant data, or always with --variants-only.
    if (variantsOnly || l.variant_sheets?.length || l.applied_variant) await syncVariant(entry, t, l, result);
    result.action = variantsOnly ? 'updated (variants only)' : 'updated';
    result.block_id = entry.block.id;
  } else {
    const sectionName = l.status === 'done' ? 'Done' : 'Waiting';
    const sec = findSection(q.sections, sectionName);
    if (!sec) throw new Error(`page has no "${sectionName}" H1; cannot place the new toggle`);
    const after = q.top[sec.lastIndex].id;
    const maxN = Math.max(0, ...q.entries.map(e => Number(e.title.match(/^(?:DONE\s+)?(\d+)\./)?.[1] || 0)));
    const uploads = await uploadSheets([l]);
    const created = await appendChildren(pageId, [toggleBlock(maxN + 1, l, false, uploads)], after);
    result.action = 'appended';
    result.section = sectionName;
    result.number = maxN + 1;
    result.block_id = created[0]?.id;
    result.notes.push('Appended at the end of its section; numbering continues from the page max, so re-sort by hand if ease order matters.');
  }
  if (args.run) result.run_file_notion = recordNotionBlock(path.resolve(args.run), pageId, result);
  console.log(JSON.stringify(result, null, 2));
}

async function status(args) {
  if (!args.page) throw new Error('status needs --page <id>');
  const pageId = normalizeId(args.page);
  const q = await readQueue(pageId);
  const intro = q.top.find(b => b.type === 'paragraph');
  const lines = [];
  if (intro) lines.push(plain(intro.paragraph.rich_text), '');
  const bySection = {};
  for (const e of q.entries) (bySection[e.section || '(no section)'] ??= []).push(e);
  for (const [name, list] of Object.entries(bySection)) {
    lines.push(`${name.trim().toUpperCase()} (${list.length})`);
    for (const e of list) {
      lines.push(`  ${e.title}`);
      if (args.brief) continue;
      const t = await entryTable(e);
      if (!t) continue;
      const isWaiting = name.toLowerCase().startsWith('waiting');
      const show = isWaiting ? ['Verdict', 'Open', VARIANT_FIELD] : ['Verdict'];
      for (const f of show) {
        const r = t.map[f];
        if (r) lines.push(`      ${f}: ${plain(r.table_row.cells[1])}`);
      }
    }
    lines.push('');
  }
  console.log(lines.join('\n').trimEnd());
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const commands = { build, upsert, status };
if (!commands[cmd]) {
  console.error('usage: review-queue.mjs build --title "<title>" --ledgers a.json b.json [--intro "<text>"] [--dry-run]\n       review-queue.mjs upsert --page <id> --ledger x.json [--links 1] [--variants-only 1] [--run <run_dir>]\n       review-queue.mjs status --page <id> [--brief 1]');
  process.exit(2);
}
commands[cmd](args).catch(e => { console.error(e.message); process.exit(1); });
