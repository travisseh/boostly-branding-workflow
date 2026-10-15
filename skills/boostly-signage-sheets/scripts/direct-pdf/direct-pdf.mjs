#!/usr/bin/env node
// Direct signage PDFs for one location run, no Figma: build the section tree from the template
// spec (lib/retarget.mjs) and render every "Print Sheet - " frame as a vector PDF page
// (lib/pdf-render.mjs), merged per print kind exactly like boostly-print-handoff's
// export-sheets.mjs output (table-stickers.pdf, review-stickers.pdf, bathroom-stickers.pdf,
// bathroom-review-stickers.pdf, pop-sign.pdf, togo-label.pdf + _vector-pages/ + sheets.json).
//
// Status: parity-proven against Figma's REST export (parity.mjs, Scoops 3:2, Pig & Parrot 5:2,
// Slice of the 80's 614:2) and THE DEFAULT since 2026-10-15 ("flip it", Travisse): the closeout
// renders the sheets here and print-handoff.mjs exports through export-direct.mjs; the Figma
// build stays an optional fallback (print-handoff.mjs --figma).
// --preview (default on) also writes review-sheets.png, one contact sheet of every page with its
// name, which is what Travisse approves at the closeout stop (replaces the Figma screenshot).
//
// Usage: node direct-pdf.mjs --run-dir <dir> [--out <dir>] [--tables N] [--stalls N]
//   [--offer "<offer_text>"] [--mode auto|discount|phrase|generic] [--band #RRGGBB]
//   [--logo <png>] [--pop-primary-logo <png>] [--header-logo <png>] [--name "<Location (City)>"]
//   [--date YYYY-MM-DD] [--status "<header label>"] [--kinds <kind[,kind]>] [--no-icc] [--allow-zero]
//   [--no-preview] [--preview-dpi 24]
// Defaults come from run.json (figma.header_title, figma.quantities, request.offer_text) and
// signage/plan.json (band, copy, qr files, logo). Never prints secrets; needs no network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildSection, sheetsOf } from './lib/retarget.mjs';
import { PdfRenderer, savePdf } from './lib/pdf-render.mjs';
import { KINDS, classify, orderFrames } from './lib/kinds.mjs';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i += 1; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const tryExec = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
export function pdfPages(p) { const t = tryExec('pdfinfo', [p]); const m = t && t.match(/Pages:\s+(\d+)/); return m ? Number(m[1]) : null; }
export function pdfPageSize(p) { const t = tryExec('pdfinfo', [p]); const m = t && t.match(/Page size:\s+([\d.]+) x ([\d.]+)/); return m ? [Number(m[1]), Number(m[2])] : null; }
export function pdfFonts(p) { const t = tryExec('pdffonts', [p]); if (!t) return null; return t.trim().split('\n').slice(2).filter(Boolean).map((l) => { const c = l.trim().split(/\s+/); return { name: c[0], type: c.slice(1, -6).join(' '), emb: c[c.length - 5] === 'yes', sub: c[c.length - 4] === 'yes' }; }); }
export function pdfImages(p) { const t = tryExec('pdfimages', ['-list', p]); if (!t) return null; return t.trim().split('\n').slice(2).filter(Boolean).map((l) => { const c = l.trim().split(/\s+/); return { page: Number(c[0]), type: c[2], w: Number(c[3]), h: Number(c[4]), color: c[5], enc: c[8], xppi: Number(c[12]), yppi: Number(c[13]) }; }); }

// Resolve build inputs from the run dir (run.json + signage/plan.json) and CLI overrides.
export function resolveInputs(runDir, args) {
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const planFile = path.join(runDir, 'signage', 'plan.json');
  if (!fs.existsSync(planFile)) throw new Error(`no signage/plan.json in ${runDir} (run plan.mjs first)`);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const req = run.request || {};
  const fig = run.figma || {};
  const city = req.city || req.location_city || (req.shipping && req.shipping.city) || '';
  const name = args.name || fig.header_title || (city ? `${req.location_name} (${city})` : req.location_name);
  if (!name) throw new Error('no location name: pass --name');
  const q = fig.quantities || {};
  const tables = Number(args.tables ?? q.tables ?? plan.request?.tables);
  const stalls = Number(args.stalls ?? q.bathroom_stalls ?? plan.request?.stalls);
  if (!Number.isInteger(tables) || !Number.isInteger(stalls)) throw new Error('tables/stalls unresolved: pass --tables and --stalls');
  const band = args.band || fig.band || plan.summary?.band_color;
  const offer = args.offer !== undefined ? String(args.offer) : (req.offer_text || '');
  const qrFiles = {};
  for (const [ctx, v] of Object.entries(plan.qr || {})) {
    if (!v) continue;
    for (const [role, rec] of Object.entries(v)) if (rec && rec.file) qrFiles[`qr-${ctx}-${role}`] = path.isAbsolute(rec.file) ? rec.file : path.join(runDir, 'signage', path.basename(rec.file));
  }
  const abs = (p) => (p ? (path.isAbsolute(p) ? p : path.resolve(runDir, p)) : null);
  const logos = {
    sticker: abs(args.logo) || plan.logo,
    popPrimary: abs(args['pop-primary-logo']) || plan.logo_white_knockout,
    header: abs(args['header-logo']) || null,
  };
  for (const [k, f] of Object.entries(logos)) if (f && !fs.existsSync(f)) throw new Error(`${k} logo missing: ${f}`);
  return {
    name, status: args.status || fig.header || 'GENERATED - REVIEW BEFORE PRINT', date: args.date || new Date().toISOString().slice(0, 10),
    band, offer, mode: args.mode || 'auto', tables, stalls, qrFiles, logos, allowZero: !!args['allow-zero'],
    plan, run,
  };
}

// One PNG with every page rasterized small, in kind order, each labelled with its sheet name:
// the review artifact for the closeout stop. Needs poppler (pdftoppm); returns null without it.
export async function contactSheet(pages, file, { dpi = 24, cols = 5, title = '' } = {}) {
  const { createRequire } = await import('node:module');
  const sharp = createRequire(import.meta.url)('sharp');
  const tmp = fs.mkdtempSync(path.join(path.dirname(file), '.preview-'));
  const tiles = [];
  try {
    for (const [i, p] of pages.entries()) {
      const prefix = path.join(tmp, `p${i}`);
      if (tryExec('pdftoppm', ['-r', String(dpi), '-png', '-singlefile', p.file, prefix]) === null) { fs.rmSync(tmp, { recursive: true, force: true }); return null; }
      tiles.push({ ...p, png: `${prefix}.png` });
    }
    const metas = await Promise.all(tiles.map((t) => sharp(t.png).metadata()));
    const tileW = Math.max(...metas.map((m) => m.width));
    const tileH = Math.max(...metas.map((m) => m.height));
    const labelH = 34, pad = 16, headH = title ? 44 : 0;
    const rows = Math.ceil(tiles.length / cols);
    const width = cols * (tileW + pad) + pad;
    const height = headH + rows * (tileH + labelH + pad) + pad;
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const comps = [];
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    if (title) svg += `<text x="${pad}" y="30" font-family="Helvetica, Arial" font-size="22" fill="#111">${esc(title)}</text>`;
    tiles.forEach((t, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const x = pad + c * (tileW + pad), y = headH + pad + r * (tileH + labelH + pad);
      const m = metas[i];
      comps.push({ input: t.png, left: x + Math.round((tileW - m.width) / 2), top: y });
      svg += `<rect x="${x + Math.round((tileW - m.width) / 2) - 1}" y="${y - 1}" width="${m.width + 2}" height="${m.height + 2}" fill="none" stroke="#999"/>`;
      svg += `<text x="${x}" y="${y + tileH + 22}" font-family="Helvetica, Arial" font-size="14" fill="#222">${esc(t.name.replace(/^Print Sheet\s*-\s*/, ''))} (${t.w}x${t.h})</text>`;
    });
    svg += '</svg>';
    await sharp({ create: { width, height, channels: 3, background: '#f2f2f2' } }).composite([...comps, { input: Buffer.from(svg), left: 0, top: 0 }]).png().toFile(file);
    return { file, width, height, pages: tiles.length, dpi };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderRun(runDir, args = {}) {
  const inputs = resolveInputs(runDir, args);
  const out = path.resolve(args.out || path.join(runDir, 'signage', 'pdf-direct'));
  const pagesDir = path.join(out, '_vector-pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const { section, log } = buildSection(inputs);
  // copy cross-check against plan.json (the Figma path used the same rules; a difference means
  // the offer passed here is not the one plan.mjs saw)
  const planCopy = inputs.plan.copy || {};
  const copyCheck = {
    pop_title: { plan: planCopy.pop?.title, built: log.recopy.headline },
    togo_promo: { plan: planCopy.togoPromo, built: null },
  };
  const frames = [];
  for (const sh of sheetsOf(section)) {
    const c = classify(sh.n);
    if (!c) { console.log('skip unclassified sheet', sh.n); continue; }
    frames.push({ node_id: `direct:${sh.n}`, name: sh.n, kind: c.kind, page: c.page, w: sh.w, h: sh.h, sheet: sh });
  }
  const keepKinds = args.kinds ? String(args.kinds).split(',').map((k) => k.trim()).filter(Boolean) : null;
  if (keepKinds) for (let i = frames.length - 1; i >= 0; i -= 1) if (!keepKinds.includes(frames[i].kind)) frames.splice(i, 1);
  orderFrames(frames);
  const renderer = new PdfRenderer({ icc: !args['no-icc'] });
  const pageStats = {};
  for (const f of frames) {
    const state = await renderer.newDocument();
    const stats = await renderer.renderSheet(state, f.sheet);
    const file = path.join(pagesDir, f.file);
    const bytes = await savePdf(state, file, { title: f.name });
    pageStats[f.file] = { ...stats, bytes, icc: !!state.icc };
    for (const w of stats.warnings) console.log('WARNING', f.file, w);
    console.log('rendered', f.file, bytes, 'bytes', `(${stats.texts} texts, ${stats.glyphs} glyphs, ${stats.vectors} vectors, ${stats.images} images${stats.emoji ? `, ${stats.emoji} emoji` : ''})`);
  }
  const sheets = {};
  let allOk = true;
  for (const { kind } of KINDS) {
    const fk = frames.filter((f) => f.kind === kind).sort((a, b) => a.page - b.page);
    if (!fk.length) continue;
    const parts = fk.map((f) => path.join(pagesDir, f.file));
    const dst = path.join(out, `${kind}.pdf`);
    // the vendor file is rendered as ONE document so pages share the font subsets and logo
    // image objects (copying pages would embed them once per page)
    const kindState = await renderer.newDocument();
    for (const f of fk) await renderer.renderSheet(kindState, f.sheet);
    await savePdf(kindState, dst, { title: `${inputs.name} - ${kind}` });
    const pages = pdfPages(dst);
    const fonts = pdfFonts(dst);
    const imgs = pdfImages(dst);
    const size = pdfPageSize(dst);
    const fullPage = (imgs || []).filter((im) => size && im.w >= size[0] * 0.95 && im.h >= size[1] * 0.95);
    const vector = fonts === null ? null : fonts.length > 0 && fullPage.length === 0;
    const ok = (pages === null || pages === fk.length) && vector !== false;
    allOk = allOk && ok;
    sheets[kind] = { file: `${kind}.pdf`, pages, expected_pages: fk.length, node_ids: fk.map((f) => f.node_id), names: fk.map((f) => f.name), page_size_pt: size, fonts: fonts ? fonts.length : null, font_list: fonts, images: imgs ? imgs.length : null, full_page_images: fullPage.length, vector, ok, parts_md5: parts.map(md5).join(','), md5: md5(dst), bytes: fs.statSync(dst).size };
    console.log(ok ? 'OK ' : 'BAD', kind, `${pages}/${fk.length} pages`, `fonts ${fonts ? fonts.length : '?'}`, `images ${imgs ? imgs.length : '?'}`, vector === null ? '(poppler missing)' : vector ? 'vector' : 'NOT VECTOR');
  }
  const preview = args['no-preview'] ? null : await contactSheet(frames.map((f) => ({ name: f.name, file: path.join(pagesDir, f.file), w: f.w, h: f.h })), path.join(out, 'review-sheets.png'), { dpi: Number(args['preview-dpi'] || 24), title: `${inputs.name}: ${frames.length} print sheets, direct render ${inputs.date}` });
  if (preview) console.log('preview', preview.file, `${preview.width}x${preview.height}`);
  const stripSheets = (n) => { const o = { ...n }; delete o.sheet; return o; };
  const summary = {
    generator: 'boostly-signage-sheets/scripts/direct-pdf/direct-pdf.mjs',
    status: 'default since 2026-10-15 (parity-proven)',
    run_dir: runDir, out, generated_at: new Date().toISOString(),
    inputs: { name: inputs.name, status: inputs.status, date: inputs.date, band: inputs.band, offer: inputs.offer, mode: inputs.mode, tables: inputs.tables, stalls: inputs.stalls, logos: inputs.logos, qr_files: inputs.qrFiles },
    build: log, copy_check: copyCheck, frames: frames.map(stripSheets), sheets, pages: pageStats, preview, all_ok: allOk,
  };
  fs.writeFileSync(path.join(out, 'section.json'), JSON.stringify(section));
  fs.writeFileSync(path.join(out, 'sheets.json'), JSON.stringify({ source: 'direct', frames: frames.map(stripSheets), sheets, exported_at: summary.generated_at }, null, 2));
  fs.writeFileSync(path.join(out, 'build-log.json'), JSON.stringify(summary, null, 2));
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args['run-dir'] || args._[0] || '');
  if (!runDir || !fs.existsSync(path.join(runDir, 'run.json'))) { console.error('usage: node direct-pdf.mjs --run-dir <run dir with run.json and signage/plan.json> [--out <dir>]'); process.exit(1); }
  renderRun(runDir, args).then((s) => {
    console.log(JSON.stringify({ out: s.out, frames: s.frames.length, kinds: Object.keys(s.sheets).length, all_ok: s.all_ok, preview: s.preview && s.preview.file, recopy: s.build.recopy, trim: { removed_sheets: s.build.trim.removedSheets.length, removed_stickers: s.build.trim.removedStickers.length }, togo: s.build.togo }));
    if (!s.all_ok) process.exit(2);
  }).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
