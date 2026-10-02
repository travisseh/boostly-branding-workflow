#!/usr/bin/env node
// Derive a request-ledger.json from a branding run directory (run.json when present, else manifest.json).
//   ledger-from-manifest.mjs <run-dir|run.json|manifest.json> [--out ledger.json] [--set key=value ...] [--overrides o.json]
// Handles both manifest shapes seen in runs-prod-* (nested "location"/"request" and the flat Fox's shape).
// Also reads production-readback.json and link-discovery-report.json from the run dir when present.
// A run dir with no manifest exits 2: write the ledger by hand from STATE.md (see request-ledger.schema.json).
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = { set: {} };
let target;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') opt.out = argv[++i];
  else if (argv[i] === '--overrides') opt.overrides = argv[++i];
  else if (argv[i] === '--set') { const [k, ...v] = argv[++i].split('='); opt.set[k] = v.join('='); }
  else if (!argv[i].startsWith('--')) target = argv[i];
}
if (!target) { console.error('usage: ledger-from-manifest.mjs <run-dir|manifest.json> [--out f] [--set k=v ...] [--overrides f]'); process.exit(2); }

const isDir = fs.statSync(target).isDirectory();
const runDir = isDir ? target : path.dirname(target);
const readJson = p => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

// run.json (one run file per location, boostly-box-fulfillment/references/run-schema.json) is the
// source when the target is a run dir that has one, or run.json itself. An explicit manifest.json
// path still renders from that manifest, so the two routes can be diffed.
const runJsonPath = isDir ? path.join(target, 'run.json') : (path.basename(target) === 'run.json' ? target : null);
const run = runJsonPath && fs.existsSync(runJsonPath) ? readJson(runJsonPath) : null;
let m;
let manifestPath;
if (run) {
  // A migrated run keeps its manifest verbatim under legacy.manifest and renders from that, so the
  // ledger is byte-identical to the pre-run.json output. A run born as run.json renders from its
  // typed blocks through manifestViewFromRun.
  m = run.legacy?.manifest || manifestViewFromRun(run);
  manifestPath = run.legacy?.manifest_path || runJsonPath;
  console.error(`source: ${path.relative(runDir, runJsonPath) || 'run.json'}${run.legacy?.manifest ? ' (legacy manifest kept verbatim)' : ' (typed blocks)'}`);
} else {
  manifestPath = isDir ? path.join(target, 'manifest.json') : target;
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest or run.json at ${runDir}. Write the ledger by hand (fields in request-ledger.schema.json), using STATE.md as the source.`);
    process.exit(2);
  }
  m = readJson(manifestPath);
}

// Manifest-shaped view of a run.json's typed blocks: only the keys the derivation below reads.
function manifestViewFromRun(r) {
  const req = r.request || {};
  const w = r.write || {};
  const v = r.variants || {};
  const f = r.figma || {};
  const l = r.links || {};
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, val]) => val !== undefined && val !== null));
  const appliedLinks = Array.isArray(l.written) ? l.written
    : (l.execution || []).filter(x => x.outcome === 'applied').map(x => `${x.operation?.category || x.operation?.kind} -> ${x.operation?.url || ''}`.trim());
  const view = {
    run_id: r.run_id,
    generated_at: r.created_at,
    location: clean({
      location_id: req.location_id, account_id: req.account_id, name: req.location_name, address: req.address,
      website: req.website_url, ordering_url: req.ordering_url, google_place_id: req.google_place_id,
    }),
    request: clean({
      id: req.request_id, slack_thread_ts: req.slack_thread_ts, offer_text: req.offer_text,
      quantities_db: req.quantities ? clean(req.quantities) : undefined, quantities_source: req.quantities_source,
    }),
    links: { written: appliedLinks },
    signage: clean({ plan: f.plan_json, url: f.section_url, status_label: f.header }),
    open_for_travisse: Array.isArray(r.open_items) ? r.open_items : [],
  };
  if (w.status === 'applied') {
    view.production_write = clean({
      status: `APPLIED${w.scope ? ` (${w.scope} scope)` : ''}${w.gate_override ? ' under a recorded gate override' : ''}`,
      applied_at: w.applied_at,
      after: { ...(w.colors_after || {}), logo_filename: w.logo_file ? path.basename(w.logo_file) : undefined },
      applied: undefined,
    });
    view.applied_colors = w.colors_after || undefined;
  } else if (w.status) {
    view.production_write = clean({ status: w.status.toUpperCase(), reason: w.hold_reason });
  }
  if (v.sheet_png) view.variant_sheet = clean({ png: v.sheet_png, json: v.sheet_json, applied_letter: v.applied_letter });
  return view;
}
const readback = readJson(path.join(runDir, 'production-readback.json'));
const links = readJson(path.join(runDir, 'link-discovery-report.json'));

const loc = m.location || {};
const req = m.request || {};
const name = loc.name || m.location_name || readback?.location?.name || '';
const address = loc.address || m.address || '';

function splitName(n, addr) {
  const p = n.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (p) return { business: p[1].trim(), city: p[2].trim() };
  // "19-46 37th St, Astoria, NY 11105" -> Astoria
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  const city = parts.length >= 3 ? parts[parts.length - 2].replace(/\s+[A-Z]{2}\s+\d{5}.*$/, '') : (parts[1] || '');
  return { business: n.trim(), city: city.replace(/\s*\d{5}(-\d{4})?$/, '') };
}
const { business, city } = splitName(name, address);

const cleanUrl = u => (typeof u === 'string' ? u.replace(/\s*\(.*\)\s*$/, '').trim() : u);
const placeId = loc.google_place_id || m.google_place_id || '';

const pw = m.production_write || {};
const pwStatus = pw.status || m.status || '';
const applied = /applied/i.test(pwStatus);
const eff = readback?.effective_branding || readback?.account_branding;

const appliedParts = [];
if (applied) {
  appliedParts.push(`${pwStatus}${pw.applied_at ? ' ' + pw.applied_at : ''}.`);
  const colors = pw.after || m.proposed_colors || m.proposed || eff;
  if (colors) appliedParts.push(`Colors ${colors.web_primary_color} / ${colors.web_secondary_color} / ${colors.web_text_color}, print_text_secondary ${colors.print_text_secondary_color}.`);
  const logo = eff?.logo_filename || pw.after?.logo_filename || m.logo_files?.card_applied?.path || m.logo_files?.card_final?.path;
  if (logo) appliedParts.push(`Logo ${logo}.`);
  if (eff) {
    const socials = ['facebook_url', 'instagram_url', 'tiktok_url', 'x_url', 'youtube_url'].filter(k => eff[k]).map(k => k.replace('_url', ''));
    appliedParts.push(socials.length ? `Socials live: ${socials.join(', ')}.` : 'No socials on the effective row.');
  }
  if (pw.applied?.events) appliedParts.push(`Events: ${pw.applied.events}.`);
  if (Array.isArray(m.links?.written) && m.links.written.length) appliedParts.push(`Links written: ${m.links.written.length}.`);
} else {
  appliedParts.push(`Not applied. ${pwStatus || 'status unknown'}${pw.reason ? ': ' + pw.reason : ''}`.trim());
}
if (!applied && links?.writes_performed === false && links.hold_reason) appliedParts.push(`Link discovery static only: ${links.hold_reason}`);

const sg = m.signage || {};
const qty = req.quantities_db || m.quantities || {};
const qtyText = Object.keys(qty).length ? Object.entries(qty).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')
  : [req.tables != null && `tables ${req.tables}`, req.stalls != null && `stalls ${req.stalls}`, req.tap_cards != null && `tap cards ${req.tap_cards}`].filter(Boolean).join(', ');
const signageParts = [];
if (sg.plan) signageParts.push(sg.plan.replace(/^signage\/plan\.json\s*/, '').replace(/^\((.*)\)$/, '$1'));
if (qtyText) signageParts.push(qtyText + (req.quantities_source ? ` (${req.quantities_source})` : '') + '.');
const offer = req.offer_text || req.offer_text_db || m.offer?.text || m.offer;
if (offer && typeof offer === 'string') signageParts.push(`Offer "${offer}"${req.signup_keyword ? '; keyword ' + req.signup_keyword : ''}.`);
if (sg.status_label) signageParts.push(`Figma label: ${sg.status_label}.`);

// ---- variant sheets (rule 2b): which lettered cell went to production ----
const stripNote = v => (typeof v === 'string' ? v.replace(/\s*\(.*\)\s*$/, '').trim() : v);
const exists = p => Boolean(p) && fs.existsSync(p);
function findByBasename(base, preferDirs = []) {
  // Search the run dir (skipping node_modules) for a file with this basename; preferred dirs win, then shortest path.
  const hits = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (e.name === base) hits.push(f);
  } };
  walk(runDir);
  hits.sort((a, b) => (preferDirs.some(x => a.includes(x)) ? 0 : 1) - (preferDirs.some(x => b.includes(x)) ? 0 : 1) || a.length - b.length);
  return hits[0] || null;
}
function resolveRunFile(rel, preferDirs) {
  if (!rel) return null;
  const direct = path.resolve(runDir, rel);
  if (exists(direct)) return direct;
  return findByBasename(path.basename(rel), preferDirs);
}
function globDirs(pattern) {
  // exp/variants*  ->  every dir under exp whose name starts with "variants"
  const [parent, prefix] = [path.dirname(pattern), path.basename(pattern).replace(/\*$/, '')];
  const dir = path.join(runDir, parent);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.startsWith(prefix) && fs.statSync(path.join(dir, n)).isDirectory()).sort().reverse().map(n => path.join(dir, n));
}
function searchSheets() {
  const direct = path.join(runDir, 'exp/variant-sheet/variant-sheet.png');
  if (exists(direct)) return [direct];
  for (const d of globDirs('exp/variants*')) {
    const all = path.join(d, 'variant-sheet-all.png');
    if (exists(all)) return [all];
    const one = path.join(d, 'variant-sheet.png');
    if (exists(one)) return [one];
  }
  const plainSheet = path.join(runDir, 'variants/variant-sheet.png');
  return exists(plainSheet) ? [plainSheet] : [];
}
function sheetJsonCandidates(png, explicitJson) {
  // The stitched *-all.png has no json of its own; its letters live in the sibling variant-sheet*.json files.
  const dir = path.dirname(png);
  const own = png.replace(/\.png$/, '.json');
  const siblings = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^variant-sheet.*\.json$/.test(n)).sort().map(n => path.join(dir, n)) : [];
  return [...new Set([explicitJson, own, ...siblings].filter(exists))];
}
// Live readback first (production truth), then the manifest's current applied_colors, then the (possibly stale) first write.
const appliedColors = eff || m.applied_colors || pw.after || m.branding?.applied || {};
const appliedSecondary = (appliedColors.web_secondary_color || '').toUpperCase();
const appliedPrimary = (appliedColors.web_primary_color || '').toUpperCase();
const appliedLogo = path.basename(pw.after?.logo_filename || eff?.logo_filename || m.logo_files?.card_applied?.path || m.logo_files?.card_final?.path || '');
function deriveLetter(jsons) {
  if (!appliedSecondary || !appliedLogo) return null;
  for (const j of jsons) {
    const cells = readJson(j)?.cells || {};
    const hits = Object.values(cells).filter(c => (c.secondary || '').toUpperCase() === appliedSecondary && path.basename(c.logo || '') === appliedLogo);
    const best = hits.find(c => !appliedPrimary || (c.primary || '').toUpperCase() === appliedPrimary) || hits[0];
    if (best) return { letter: best.letter, json: j };
  }
  return null;
}
const variantSheets = [];
{
  const spec = m.variant_sheet || m.branding?.variant_sheet;
  const sheets = [];
  if (spec && typeof spec === 'object') {
    const png = resolveRunFile(stripNote(spec.png), ['exp/variant-sheet', 'variants']);
    if (png) sheets.push({ png, json: resolveRunFile(stripNote(spec.json), [path.relative(runDir, path.dirname(png))]), applied_letter: stripNote(spec.applied_letter) || null });
    else console.error(`variant_sheet.png "${spec.png}" not found under ${runDir}`);
  } else if (typeof spec === 'string') {
    const rel = stripNote(spec.replace(/^shared:\s*/i, ''));
    const png = path.resolve(runDir, rel);
    if (exists(png)) sheets.push({ png, json: null, applied_letter: null, label: `${path.basename(png)} (shared: ${rel})` });
    else console.error(`shared variant sheet "${rel}" not found from ${runDir}`);
  } else {
    for (const png of searchSheets()) sheets.push({ png, json: null, applied_letter: null });
  }
  for (const sh of sheets) {
    const jsons = sheetJsonCandidates(sh.png, sh.json);
    let letter = sh.applied_letter;
    let json = sh.json;
    if (!letter) { const d = deriveLetter(jsons); if (d) ({ letter, json } = d); }
    if (!json) json = jsons[0] || null;
    const entry = { png: sh.png };
    if (json) entry.json = json;
    if (sh.label) entry.label = sh.label;
    if (letter) entry.applied_letter = letter;
    variantSheets.push(entry);
    console.error(`variant sheet: ${path.relative(runDir, sh.png)} json=${json ? path.relative(runDir, json) : '(none)'} applied=${letter || '(letter not derivable)'}${letter && !sh.applied_letter ? ` (matched secondary ${appliedSecondary}, logo ${appliedLogo})` : ''}`);
  }
  if (!variantSheets.length) console.error('variant sheet: none found (manifest.variant_sheet missing and no exp/variant-sheet, exp/variants*, or variants/ sheet)');
}

const openItems = [...(m.open_for_travisse || []), ...(!applied ? (m.hold_reasons || []) : []), ...(m.not_done_by_design || m.not_done || []).filter(x => /slack/i.test(x))];
const verdict = applied
  ? 'Branding applied and read back. Review signage in Figma, then flip to PRODUCTION and ping Karissa.'
  : `Branding not applied${pw.reason ? ' (' + pw.reason.split(';')[0] + ')' : ''}. Needs a decision before signage review.`;

const ledger = {
  location_id: loc.location_id || m.location_id,
  account_id: loc.account_id || m.account_id,
  business, city,
  status: 'waiting',
  waiting_on: '',
  ease: 3,
  verdict,
  applied: appliedParts.join(' '),
  signage: signageParts.join(' ') || '',
  open: openItems.map((x, i) => `(${i + 1}) ${x}`).join(' '),
  slack_ts: req.slack_thread_ts || m.request_thread_ts || '',
  figma_url: sg.url || m.figma?.url || '',
  website: cleanUrl(loc.website || m.website_url || ''),
  place_id: placeId,
  address,
  ordering_url: cleanUrl(loc.ordering_url || links?.candidates?.find(c => c.kind === 'ordering')?.url || ''),
  variant_sheets: variantSheets,
  source: { manifest: path.resolve(manifestPath), run_id: m.run_id || null, generated_at: m.generated_at || null },
};

Object.assign(ledger, opt.overrides ? readJson(opt.overrides) : {}, opt.set);
if (ledger.ease != null) ledger.ease = Number(ledger.ease);
// --set applied_letter=X forces the letter on every derived sheet (for shared sheets or when the colors do not match a cell).
if (ledger.applied_letter) { for (const sh of ledger.variant_sheets || []) sh.applied_letter = ledger.applied_letter; delete ledger.applied_letter; }

const out = JSON.stringify(ledger, null, 2) + '\n';
if (opt.out) { fs.writeFileSync(opt.out, out); console.error(`wrote ${opt.out}`); } else process.stdout.write(out);
