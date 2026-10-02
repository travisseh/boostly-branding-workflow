import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BASELINE_JSON,
  computeVerdict,
  dedupeResults,
  registrySha256,
  replay,
  runBattery,
  selectGates,
  validateRegistry,
  verdictForRun,
  writeGatesBlock,
} from './gates.ts';
import { GATES_JSON, canonicalGateId, gateDefinition, loadGateRegistry } from './logo-quality-gates.ts';
import { initRun, readRun, setBlock, type JsonObject } from '../../boostly-box-fulfillment/scripts/run-file.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gates');

// ---------------------------------------------------------------------------------------------
// 1. gates.json schema
// ---------------------------------------------------------------------------------------------

test('gates.json is a valid registry: unique kebab ids, severities, override flags, aliases resolve', () => {
  const registry = loadGateRegistry();
  assert.deepEqual(validateRegistry(registry), []);
  // every gate the runner / logo-quality-gates / surface / crop ship today is registered
  for (const id of ['ship-gate', 'border-dust', 'soft-fringe', 'holes', 'interior', 'component-contrast', 'whiteblob', 'stroke', 'edge', 'verify-erase',
    'png-color-type', 'render-legibility', 'text-legibility', 'ink-retention', 'authored-color-retention', 'source-overlay',
    'validate-logo-surface', 'logo-crop', 'upload-size', 'ladder-floor']) {
    assert.ok(registry.gates.some((gate) => gate.id === id), `missing gate ${id}`);
  }
  // hard technical gates are not overridable
  // component-contrast is overridable only for the authored-lockup verdict (Travisse 2026-09-23, Soybean)
  assert.deepEqual(gateDefinition('component-contrast').override_allowed_verdicts, ['authored_lockup_low_contrast']);
  for (const id of ['png-color-type', 'ship-gate', 'ladder-floor', 'verify-erase', 'source-overlay']) {
    assert.equal(gateDefinition(id).override_allowed, false, `${id} must be override_allowed=false`);
  }
  // the shipped thresholds (behavior identical to the pre-registry code)
  assert.equal(gateDefinition('ship-gate').thresholds.minLongest, 700);
  assert.equal(gateDefinition('interior').thresholds.maxLowContrastShare, 0.35);
  assert.equal(gateDefinition('soft-fringe').thresholds.maxSoftShare, 0.3);
  assert.equal(gateDefinition('render-legibility').thresholds.min_component_height_px, 7);
  assert.equal(gateDefinition('render-legibility').thresholds.max_tiny_text_ink_share, 0.08);
  // 2026-09-17 deliberate edits, each with a changelog entry
  assert.equal(gateDefinition('text-legibility').severity, 'block');
  assert.equal(gateDefinition('text-legibility').severity_by_verdict?.business_name_unreadable_at_product_size, 'warn');
  // 2026-09-18 (Coloradough): ink-retention overridable only for authored white that became negative space
  assert.equal(gateDefinition('ink-retention').override_allowed, true);
  // 2026-09-21 (Cellblock Sips): plus authored near-black ground merging into a near-black card
  assert.deepEqual(gateDefinition('ink-retention').override_allowed_verdicts, ['authored_white_dropped', 'authored_dark_dropped', 'rebuilt_from_low_res_source']);
  assert.equal(gateDefinition('ink-retention').thresholds.low_res_rebuild_min_recall, 0.9);
  assert.equal(gateDefinition('ink-retention').thresholds.low_res_rebuild_max_source_ink_px, 300);
  assert.equal(gateDefinition('ink-retention').thresholds.dark_ground_merge_max_contrast, 1.5);
  assert.equal(gateDefinition('interior').severity_by_verdict?.authored_dark_panel_on_dark_card, 'warn');
  assert.equal(gateDefinition('interior').severity, 'block');
  assert.equal(gateDefinition('ink-retention').override_allowed_for_shipped, false);
  assert.equal(gateDefinition('render-legibility').severity, 'block');
  for (const id of ['png-color-type', 'logo-crop', 'component-contrast']) assert.equal(gateDefinition(id).override_allowed_for_shipped, true, id);
  assert.equal(gateDefinition('ship-gate').override_allowed_for_shipped, false);
  assert.ok((registry.changelog ?? []).length >= 3);
  assert.ok(registry.changelog!.some((e) => e.gate === 'text-legibility' && /warn/.test(e.change)));
  assert.equal(gateDefinition('upload-size').thresholds.max_bytes, 70000);
  assert.equal(gateDefinition('ladder-floor').thresholds.min_longest_px, 1000);
  assert.deepEqual(gateDefinition('png-color-type').thresholds.allowed_color_types, [2, 6]);
  assert.equal(canonicalGateId('ocr'), 'text-legibility');
  assert.equal(canonicalGateId('tiny_text'), 'render-legibility');
  assert.equal(canonicalGateId('nonsense'), null);
});

test('validateRegistry rejects a broken registry', () => {
  const registry = structuredClone(loadGateRegistry());
  (registry.gates[0] as { severity: string }).severity = 'fatal';
  registry.gates.push({ ...registry.gates[1] });
  registry.aliases.ghost = 'no-such-gate';
  const errors = validateRegistry(registry);
  assert.ok(errors.some((e) => /severity/.test(e)));
  assert.ok(errors.some((e) => /duplicate id/.test(e)));
  assert.ok(errors.some((e) => /unknown gate "no-such-gate"/.test(e)));
});

// ---------------------------------------------------------------------------------------------
// 2. threshold parity: registry-driven runs reproduce the recorded ship-time outputs field for field
// ---------------------------------------------------------------------------------------------

function recordedGates(dir: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of fs.readdirSync(dir).filter((file) => /^gate-.*\.json$/.test(file))) {
    out[name.replace(/^gate-/, '').replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return out;
}

function assertSubsetEqual(actual: unknown, expected: unknown, at: string): void {
  if (expected != null && typeof expected === 'object' && !Array.isArray(expected)) {
    assert.ok(actual != null && typeof actual === 'object', `${at}: expected an object`);
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      assertSubsetEqual((actual as Record<string, unknown>)[key], value, `${at}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, `${at} differs`);
}

for (const fixture of [
  { name: 'gregorios-reston-1B', asset: 'card-full-tight.png', primary: '#C93B18', expected: "Gregorio's Trattoria" },
  { name: 'toscanos-winchester-S', asset: '05-name-only-white.png', primary: '#8B2C1D', expected: "TOSCANO'S" },
]) {
  test(`parity: ${fixture.name} reproduces every recorded gate field with registry thresholds`, async () => {
    const dir = path.join(FIXTURES, fixture.name);
    const recorded = recordedGates(dir);
    const battery = await runBattery({ asset: path.join(dir, fixture.asset), primary: fixture.primary, expected: fixture.expected }, { only: Object.keys(recorded), writeFiles: false });
    for (const [gate, expected] of Object.entries(recorded)) {
      const now = battery.results.find((r) => r.gate === gate);
      assert.ok(now, `${gate} did not run`);
      assertSubsetEqual(now.result, expected, `${fixture.name}/${gate}`);
    }
  });
}

test('gregorios 1B fails render-legibility (block) and OCR (warn since 2026-09-17) exactly as shipped; toscanos S passes the full battery', async () => {
  const gDir = path.join(FIXTURES, 'gregorios-reston-1B');
  const g = await runBattery({ asset: path.join(gDir, 'card-full-tight.png'), primary: '#C93B18', expected: "Gregorio's Trattoria" }, { writeFiles: false });
  const gFail = g.results.filter((r) => r.severity === 'block' && r.pass === false).map((r) => r.gate).sort();
  assert.deepEqual(gFail, ['render-legibility']);
  const ocr = g.results.find((r) => r.gate === 'text-legibility');
  assert.equal(ocr?.pass, false);
  assert.equal(ocr?.severity, 'warn');
  // knockouts are still censused for counters
  assert.equal((ocr?.result as { counter_topology: { treatment: string; verdict: string } }).counter_topology.treatment, 'knockout');
  assert.equal((ocr?.result as { counter_topology: { verdict: string } }).counter_topology.verdict, 'ok');
  const tDir = path.join(FIXTURES, 'toscanos-winchester-S');
  const t = await runBattery({ asset: path.join(tDir, '05-name-only-white.png'), primary: '#8B2C1D', expected: "TOSCANO'S" }, { writeFiles: false });
  assert.deepEqual(t.results.filter((r) => r.severity === 'block' && r.pass !== true).map((r) => r.gate), []);
  const verdict = computeVerdict(t.results as unknown as Record<string, unknown>[], [], { asset: t.asset });
  assert.equal(verdict.verdict, 'SHIP');
  assert.equal((t.results.find((r) => r.gate === 'text-legibility')?.result as { counter_topology: { treatment: string } }).counter_topology.treatment, 'knockout');
});

test('counter topology is scoped to single-ink knockouts: Park Avenue full-color art is not_applicable_fullcolor, never glyph_counters_filled', async () => {
  const file = path.join(FIXTURES, 'park-avenue-wellington', 'applied-logo.png');
  const battery = await runBattery({ asset: file, primary: '#2F5E3F', expected: 'Park Avenue BBQ Grille' }, { only: ['text-legibility'], writeFiles: false });
  const result = battery.results[0].result as { verdict: string; counter_topology: { verdict: string; treatment: string; detected_counter_count: number | null } };
  assert.equal(result.counter_topology.verdict, 'not_applicable_fullcolor');
  assert.equal(result.counter_topology.treatment, 'fullcolor');
  assert.notEqual(result.verdict, 'glyph_counters_filled');
  // an explicit treatment from the run wins over detection
  const forced = await runBattery({ asset: file, primary: '#2F5E3F', expected: 'Park Avenue BBQ Grille', treatment: 'knockout' }, { only: ['text-legibility'], writeFiles: false });
  assert.equal((forced.results[0].result as { counter_topology: { treatment: string } }).counter_topology.treatment, 'knockout');
});

// ---------------------------------------------------------------------------------------------
// 3. verdict logic
// ---------------------------------------------------------------------------------------------

function fullPassResults(asset = 'fix/card/final.png'): Record<string, unknown>[] {
  return loadGateRegistry().gates
    .filter((gate) => gate.battery === true)
    .map((gate) => ({ gate: gate.id, asset, pass: gate.severity === 'info' ? null : true, verdict: gate.severity === 'info' ? null : 'ok', source: 'gates run', at: '2026-09-16T00:00:00Z' }));
}
function withFailure(results: Record<string, unknown>[], gate: string, verdict: string): Record<string, unknown>[] {
  return results.map((r) => (r.gate === gate ? { ...r, pass: false, verdict } : r));
}
const OVERRIDE = (gate: string, asset = 'fix/card/final.png') => ({ gate, asset, decided_by: 'travisse', reason: 'TRATTORIA stays; decorative at card size', at: '2026-09-15' });

test('verdict: SHIP when every block gate passes', () => {
  const v = computeVerdict(fullPassResults(), []);
  assert.equal(v.verdict, 'SHIP');
  assert.deepEqual(v.failing, []);
  assert.deepEqual(v.missing, []);
});

test('verdict: HOLD when a block gate fails without a matching override record', () => {
  const v = computeVerdict(withFailure(fullPassResults(), 'render-legibility', 'illegible_at_product_size'), []);
  assert.equal(v.verdict, 'HOLD');
  assert.equal(v.failing.length, 1);
  assert.match(v.reasons[0], /render-legibility failed .* no override record/);
  // an override on a different asset does not count
  const other = computeVerdict(withFailure(fullPassResults(), 'render-legibility', 'illegible_at_product_size'), [OVERRIDE('render-legibility', 'fix/sticker.png')]);
  assert.equal(other.verdict, 'HOLD');
});

test('verdict: SHIP-WITH-OVERRIDE when every failing block gate has an override (aliases and basenames match)', () => {
  let results = withFailure(fullPassResults(), 'render-legibility', 'illegible_at_product_size');
  results = withFailure(results, 'logo-crop', 'crop_unassessed_nonuniform_border');
  const v = computeVerdict(results, [OVERRIDE('tiny_text'), OVERRIDE('crop', '/abs/run/fix/card/final.png')]);
  assert.equal(v.verdict, 'SHIP-WITH-OVERRIDE');
  assert.equal(v.overridden.length, 2);
  assert.deepEqual(v.failing, []);
  assert.equal(v.overridden[0].override.decided_by, 'travisse');
});

test('verdict: the OCR read is a warning since 2026-09-17; filled counters still block', () => {
  const ocr = computeVerdict(withFailure(fullPassResults(), 'text-legibility', 'business_name_unreadable_at_product_size'), []);
  assert.equal(ocr.verdict, 'SHIP');
  assert.equal(ocr.warnings.length, 1);
  const counters = computeVerdict(withFailure(fullPassResults(), 'text-legibility', 'glyph_counters_filled'), []);
  assert.equal(counters.verdict, 'HOLD');
});

test('verdict: ink-retention authored_white_dropped ships with an override; authored_ink_lost holds even with one (Coloradough 2026-09-18)', () => {
  // ink-retention is a conditional battery gate (needs --source), so it is appended rather than found in fullPassResults
  const withInkRetention = (verdict: string) => [...fullPassResults(), { gate: 'ink-retention', asset: 'fix/card/final.png', pass: false, verdict, source: 'gates run', at: '2026-09-18T00:00:00Z' }];
  const whiteDropped = withInkRetention('authored_white_dropped');
  assert.equal(computeVerdict(whiteDropped, []).verdict, 'HOLD', 'no override record yet');
  const overridden = computeVerdict(whiteDropped, [OVERRIDE('ink-retention')]);
  assert.equal(overridden.verdict, 'SHIP-WITH-OVERRIDE', JSON.stringify(overridden.reasons));
  assert.equal(overridden.overridden[0].gate, 'ink-retention');
  const inkLost = computeVerdict(withInkRetention('authored_ink_lost'), [OVERRIDE('ink-retention')]);
  assert.equal(inkLost.verdict, 'HOLD');
  assert.match(inkLost.reasons[0], /override refused: ink-retention verdict "authored_ink_lost" is not overridable \(allowed: authored_white_dropped/);
});

test('verdict: ink-retention authored_dark_dropped ships with an override, authored_ink_lost still refuses one; interior authored_dark_panel_on_dark_card is a warn while fill-collision blocks (Cellblock Sips 2026-09-21)', async () => {
  const withInkRetention = (verdict: string) => [...fullPassResults(), { gate: 'ink-retention', asset: 'fix/card/final.png', pass: false, verdict, source: 'gates run', at: '2026-09-21T00:00:00Z' }];
  const darkDropped = withInkRetention('authored_dark_dropped');
  assert.equal(computeVerdict(darkDropped, []).verdict, 'HOLD', 'no override record yet');
  const overridden = computeVerdict(darkDropped, [OVERRIDE('ink-retention')]);
  assert.equal(overridden.verdict, 'SHIP-WITH-OVERRIDE', JSON.stringify(overridden.reasons));
  const inkLost = computeVerdict(withInkRetention('authored_ink_lost'), [OVERRIDE('ink-retention')]);
  assert.equal(inkLost.verdict, 'HOLD');
  assert.match(inkLost.reasons[0], /not overridable \(allowed: authored_white_dropped, authored_dark_dropped/);

  const panelWarn = computeVerdict(withFailure(fullPassResults(), 'interior', 'authored_dark_panel_on_dark_card'), []);
  assert.equal(panelWarn.verdict, 'SHIP', JSON.stringify(panelWarn.reasons));
  assert.equal(panelWarn.warnings.length, 1);
  const collision = computeVerdict(withFailure(fullPassResults(), 'interior', 'fill-collision: apply full knockout (knockout cmd) — do NOT ship outline-only or piecemeal recolors'), []);
  assert.equal(collision.verdict, 'HOLD');

  // the harness measurement itself: a near-black panel with gold ink on the near-black card is the warn verdict;
  // the same file on a navy card, and a mid-gray panel on the near-black card, are the fill-collision block
  const { interiorFillCheck } = await import('../harness/iterate-logo-rules.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boostly-interior-dark-panel-'));
  try {
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    const mark = (panelFill: string) => [
      { input: Buffer.from(`<svg width="560" height="260"><rect width="560" height="260" rx="12" fill="${panelFill}"/></svg>`), left: 20, top: 20 },
      { input: Buffer.from('<svg width="360" height="60"><rect width="360" height="60" rx="6" fill="#E4B76A"/></svg>'), left: 120, top: 80 },
    ];
    const black = path.join(directory, 'black-panel.png');
    const gray = path.join(directory, 'gray-panel.png');
    await sharp({ create: { width: 600, height: 300, channels: 4, background: transparent } }).composite(mark('#161819')).png().toFile(black);
    await sharp({ create: { width: 600, height: 300, channels: 4, background: transparent } }).composite(mark('#1E2A3A')).png().toFile(gray);
    const onDark = await interiorFillCheck(black, '#030607');
    assert.equal(onDark.verdict, 'authored_dark_panel_on_dark_card', JSON.stringify(onDark));
    assert(onDark.interiorLowContrastShare > 0.35);
    const onNavy = await interiorFillCheck(black, '#1D2F5D');
    assert.equal(onNavy.verdict, onNavy.interiorLowContrastShare > 0.35 ? 'fill-collision: apply full knockout (knockout cmd) — do NOT ship outline-only or piecemeal recolors' : 'ok', JSON.stringify(onNavy));
    assert.notEqual(onNavy.verdict, 'authored_dark_panel_on_dark_card');
    const grayOnDark = await interiorFillCheck(gray, '#030607');
    assert.match(grayOnDark.verdict, /^fill-collision/, JSON.stringify(grayOnDark));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('verdict: shipped-asset overrides are accepted only for gates that allow them, only when marked shipped_asset, and only when the run proves the asset is live', () => {
  const failing = withFailure(fullPassResults(), 'png-color-type', 'indexed_png_not_supported');
  const shippedRecord = { ...OVERRIDE('png-color-type'), shipped_asset: true };
  assert.equal(computeVerdict(failing, [shippedRecord], { shipped: true }).verdict, 'SHIP-WITH-OVERRIDE');
  assert.equal(computeVerdict(failing, [shippedRecord], { shipped: false }).verdict, 'HOLD', 'no proof the asset is live');
  assert.equal(computeVerdict(failing, [OVERRIDE('png-color-type')], { shipped: true }).verdict, 'HOLD', 'record not marked shipped_asset');
  const ship = withFailure(fullPassResults(), 'ship-gate', 'FAIL');
  assert.equal(computeVerdict(ship, [{ ...OVERRIDE('ship-gate'), shipped_asset: true }], { shipped: true }).verdict, 'HOLD', 'ship-gate has no shipped path');
});

test('verdict: an override on a non-overridable gate (or a hard verdict of a partly overridable gate) is refused and HOLDs', () => {
  const hard = computeVerdict(withFailure(fullPassResults(), 'png-color-type', 'indexed_png_not_supported'), [OVERRIDE('png-color-type')]);
  assert.equal(hard.verdict, 'HOLD');
  assert.equal(hard.refused.length, 1);
  assert.match(hard.reasons[0], /override refused: png-color-type is not overridable/);
  const counters = computeVerdict(withFailure(fullPassResults(), 'text-legibility', 'glyph_counters_filled'), [OVERRIDE('text-legibility')]);
  assert.equal(counters.verdict, 'HOLD');
  assert.match(counters.refused[0].why, /glyph_counters_filled/);
  const crop = computeVerdict(withFailure(fullPassResults(), 'logo-crop', 'excess_canvas_padding'), [OVERRIDE('logo-crop')]);
  assert.equal(crop.verdict, 'HOLD');
  const cropReview = computeVerdict(withFailure(fullPassResults(), 'logo-crop', 'crop_unassessed_nonuniform_border'), [OVERRIDE('logo-crop')]);
  assert.equal(cropReview.verdict, 'SHIP-WITH-OVERRIDE');
});

test('verdict: warn gates never hold, unassessable block gates do, an incomplete battery holds unless --partial', () => {
  const warn = computeVerdict(withFailure(fullPassResults(), 'holes', 'no_enclosed_counters'), []);
  assert.equal(warn.verdict, 'SHIP');
  assert.equal(warn.warnings.length, 1);
  const unassessable = computeVerdict(fullPassResults().map((r) => (r.gate === 'ink-retention' ? r : r.gate === 'interior' ? { ...r, pass: null, verdict: 'unassessable: boom' } : r)), []);
  assert.equal(unassessable.verdict, 'HOLD');
  const partialResults = fullPassResults().filter((r) => r.gate !== 'upload-size');
  assert.equal(computeVerdict(partialResults, []).verdict, 'HOLD');
  assert.equal(computeVerdict(partialResults, [], { partial: true }).verdict, 'SHIP');
  assert.equal(computeVerdict([], []).verdict, 'HOLD');
});

test('dedupe keeps the freshest structured result per (gate, asset) and canonicalizes migrated names', () => {
  const merged = dedupeResults([
    { gate: 'text_legibility_ocr', asset: 'a.png', pass: false, source: 'manifest' },
    { gate: 'text-legibility', asset: 'a.png', pass: false, verdict: 'business_name_unreadable_at_product_size', source: 'live_receipts' },
    { gate: 'ocr', asset: 'a.png', pass: true, verdict: 'ok', source: 'gates run', at: '2026-09-16T00:00:00Z' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].gate, 'text-legibility');
  assert.equal(merged[0].pass, true);
});

test('gates run writes the gates block with ids the override record shares; verdict reads both from run.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-run-'));
  const dir = path.join(root, 'runs-prod-2026-09-16', 'demo');
  initRun({ runDir: dir, request: { request_id: 'r', location_id: 'l', account_id: 'a', location_name: 'DEMO' } });
  const asset = path.join(dir, 'fix', 'card', 'final.png');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  // a 300px wordmark: fails ship-gate (700px floor); a hard, non-overridable gate
  await sharp(Buffer.from('<svg width="300" height="80" xmlns="http://www.w3.org/2000/svg"><text x="10" y="60" font-family="Arial" font-size="54" font-weight="700" fill="#fff">DEMO</text></svg>'))
    .ensureAlpha().png({ palette: false }).toFile(asset);
  const battery = await runBattery({ asset, primary: '#8B2C1D', expected: 'DEMO' }, { runDir: dir });
  assert.equal(battery.asset, 'fix/card/final.png');
  assert.ok(fs.existsSync(path.join(dir, 'fix', 'gates', 'final', 'gate-ship-gate.json')));
  writeGatesBlock(dir, battery.results, battery.skipped);
  const block = readRun(dir).gates as { results: Array<{ gate: string; asset: string; registry_sha256: string }> };
  assert.ok(block.results.some((r) => r.gate === 'ship-gate' && r.asset === 'fix/card/final.png'));
  assert.equal(block.results[0].registry_sha256, registrySha256());
  const held = verdictForRun(dir, { asset });
  assert.equal(held.verdict, 'HOLD');
  assert.ok(held.failing.some((f) => f.gate === 'ship-gate'));
  // a recorded override on ship-gate is refused: hard gate
  setBlock(dir, 'overrides', { gate: 'ship-gate', asset: 'fix/card/final.png', decided_by: 'travisse', reason: 'nope', at: '2026-09-16' });
  const refused = verdictForRun(dir, { asset });
  assert.equal(refused.verdict, 'HOLD');
  assert.equal(refused.refused.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 4. replay blocking
// ---------------------------------------------------------------------------------------------

async function replayFixtureRoot(): Promise<{ root: string; dir: string; asset: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-replay-root-'));
  const dir = path.join(root, 'runs-prod-2026-09-16', 'replay-demo');
  initRun({ runDir: dir, request: { request_id: 'r', location_id: 'l', account_id: 'a', location_name: 'DEMO' } });
  const asset = path.join(dir, 'fix', 'card', 'final.png');
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  await sharp(Buffer.from('<svg width="300" height="80" xmlns="http://www.w3.org/2000/svg"><text x="10" y="60" font-family="Arial" font-size="54" font-weight="700" fill="#fff">DEMO</text></svg>'))
    .ensureAlpha().png({ palette: false }).toFile(asset);
  // the run recorded the gate as passing at ship time (as if the floor were lower then) and shipped it
  setBlock(dir, 'gates', { results: [{ gate: 'ship_gate', asset: 'fix/card/final.png', pass: true, verdict: 'ok', source: 'live_receipts' }] });
  setBlock(dir, 'write', { status: 'applied', applied_at: '2026-09-16', logo_file: 'fix/card/final.png', logo_file_resolved: 'fix/card/final.png', colors_after: { web_primary_color: '#8B2C1D' } });
  return { root, dir, asset };
}

test('replay BLOCKs when a shipped asset now fails a block gate without an override, and clears with a recorded override', async () => {
  const { root, dir } = await replayFixtureRoot();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-replay-scratch-'));
  const blocked = await replay({ root, scratch, only: ['ship-gate', 'png-color-type'] });
  assert.equal(blocked.runs_replayed, 1);
  assert.equal(blocked.block, true);
  const row = blocked.rows.find((r) => r.gate === 'ship-gate');
  assert.ok(row);
  assert.equal(row.then, true);
  assert.equal(row.then_source, 'recorded');
  assert.equal(row.now, false);
  assert.equal(row.status, 'BLOCK');
  assert.equal(blocked.rows.find((r) => r.gate === 'png-color-type')?.status, 'new');
  await assert.rejects(replay({ root, scratch, only: ['ship-gate'], baseline: true }), /refusing to write a baseline/);

  // a human records an override; ship-gate is not overridable, so the replay still blocks and says why
  setBlock(dir, 'overrides', { gate: 'ship-gate', asset: 'fix/card/final.png', decided_by: 'travisse', reason: 'keep', at: '2026-09-16' });
  const stillBlocked = await replay({ root, scratch, only: ['ship-gate'] });
  assert.equal(stillBlocked.block, true);
  assert.equal(stillBlocked.rows[0].override, 'refused');

  // a sidecar override on an overridable gate (soft-fringe) that now fails would clear that gate
  const sidecar = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-replay-overrides-'));
  fs.writeFileSync(path.join(sidecar, 'overrides.json'), JSON.stringify({ 'runs-prod-2026-09-16/replay-demo': [{ gate: 'render-legibility', asset: 'fix/card/final.png', decided_by: 'travisse', reason: 'named words', at: '2026-09-16' }] }));
  const withSidecar = await replay({ root, scratch, only: ['render-legibility'], overridesDir: sidecar });
  const rl = withSidecar.rows.find((r) => r.gate === 'render-legibility');
  assert.ok(rl);
  assert.ok(rl.now === true || rl.override === 'yes', JSON.stringify(rl));
  assert.equal(withSidecar.block, false);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(sidecar, { recursive: true, force: true });
});

test('replay skips runs that were never applied and reads real run dirs read-only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-replay-root-'));
  const dir = path.join(root, 'runs-prod-2026-09-16', 'held-demo');
  initRun({ runDir: dir, request: { request_id: 'r', location_id: 'l', account_id: 'a', location_name: 'DEMO' } });
  setBlock(dir, 'write', { status: 'held', hold_reason: 'waiting' });
  const before = fs.readFileSync(path.join(dir, 'run.json'), 'utf8');
  const report = await replay({ root, scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'gates-replay-scratch-')), only: ['ship-gate'] });
  assert.equal(report.runs_scanned, 1);
  assert.equal(report.runs_replayed, 0);
  assert.match(report.runs_skipped[0].why, /not applied/);
  assert.equal(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'), before);
  assert.equal(report.block, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('battery selection: conditional gates need their inputs, ladder-floor only with --laddered, unknown ids are reported', () => {
  const base = selectGates({ asset: 'x.png', primary: '#000000', expected: 'X' });
  const ids = base.run.map((g) => g.id);
  assert.ok(ids.includes('interior') && ids.includes('text-legibility') && ids.includes('upload-size'));
  assert.ok(!ids.includes('ink-retention') && !ids.includes('ladder-floor') && !ids.includes('verify-erase'));
  assert.ok(base.skipped.some((s) => s.gate === 'ink-retention'));
  const laddered = selectGates({ asset: 'x.png', primary: '#000000', expected: 'X', source: 's.png', laddered: true });
  assert.ok(laddered.run.some((g) => g.id === 'ladder-floor') && laddered.run.some((g) => g.id === 'ink-retention'));
  const noColor = selectGates({ asset: 'x.png' });
  assert.ok(noColor.skipped.some((s) => s.gate === 'interior' && /--color/.test(s.why)));
  assert.ok(selectGates({ asset: 'x.png' }, ['bogus']).skipped.some((s) => s.gate === 'bogus'));
  assert.ok(fs.existsSync(GATES_JSON));
  assert.equal(typeof BASELINE_JSON, 'string');
});

// ---------------------------------------------------------------------------------------------
// 5. applied-logo resolution for the replay
// ---------------------------------------------------------------------------------------------

import { resolveAppliedLogo } from './gates.ts';
import crypto from 'node:crypto';

function resolverFixture(): { batch: string; run: string; png: (rel: string, seed: string) => string } {
  const batch = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-resolve-'));
  const run = path.join(batch, 'demo-reston');
  fs.mkdirSync(run, { recursive: true });
  const png = (rel: string, seed: string) => {
    const file = path.join(batch, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `png:${seed}`);
    return file;
  };
  return { batch, run, png };
}
const shaOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

test('resolver priority: run.json write block beats receipts beats manifest prose beats logo_files, with sha verification', () => {
  const { batch, run, png } = resolverFixture();
  png('demo-reston/fix/card-final.png', 'candidate');
  png('demo-reston/fix/card-notagline-1600.png', 'shipped');
  png('demo-reston/fix/live/applied-logo.png', 'shipped');
  fs.mkdirSync(path.join(run, 'fix', 'live'), { recursive: true });
  fs.writeFileSync(path.join(run, 'fix', 'live', 'apply.json'), JSON.stringify({ readback: { effective_branding: { logo_attachment_id: 'att1', logo_filename: 'card-notagline-1600.png', web_primary_color: '#111111' } } }));
  fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({
    production: { logo_attachment_id: 'att1', logo_filename: 'card-notagline-1600.png', web_primary_color: '#111111', files: { applied_logo_download: `fix/live/applied-logo.png (sha256 ${shaOf('png:shipped').slice(0, 8)}... byte-identical)` } },
    logo_files: { card_final: { path: 'fix/card-final.png' } },
  }));
  // 2. receipt wins over logo_files and points at the downloaded copy, sha verified against the manifest prose
  const fromReceipt = resolveAppliedLogo(run, null);
  assert.ok(fromReceipt);
  assert.equal(fromReceipt.source, 'apply.json:logo_filename');
  assert.equal(fromReceipt.logoRel, path.join('fix', 'live', 'applied-logo.png'));
  assert.equal(fromReceipt.sha_check, 'match');
  assert.equal(fromReceipt.attachment_id, 'att1');
  // 1. a run.json write block wins over everything and is verified against its own sha
  const fromWrite = resolveAppliedLogo(run, { status: 'applied', logo_file_resolved: 'fix/card-notagline-1600.png', logo_sha256: shaOf('png:shipped'), colors_after: { web_primary_color: '#222222' } });
  assert.equal(fromWrite?.source, 'run.json:write');
  assert.equal(fromWrite?.sha_check, 'match');
  assert.equal(fromWrite?.primary, '#222222');
  // a write block whose recorded sha does not match the file is reported as a mismatch, never silently replayed
  const mismatch = resolveAppliedLogo(run, { status: 'applied', logo_file_resolved: 'fix/card-final.png', logo_sha256: shaOf('png:shipped') });
  assert.equal(mismatch?.sha_check, 'mismatch');
  // 5. with no receipt and no production block, logo_files is the weakest source and says so
  fs.rmSync(path.join(run, 'fix', 'live'), { recursive: true, force: true });
  fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({ production_write: { status: 'APPLIED 2026-09-08' }, logo_files: { card_final: { path: 'fix/card-final.png', sha256_prefix: shaOf('png:candidate').slice(0, 12) } } }));
  const weakest = resolveAppliedLogo(run, null);
  assert.equal(weakest?.source, 'manifest:logo_files');
  assert.equal(weakest?.sha_check, 'match');
  assert.match(weakest?.note ?? '', /weakest/);
  // no applied evidence at all: null
  fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({ logo_files: { card_final: { path: 'fix/card-final.png' } } }));
  assert.equal(resolveAppliedLogo(run, null), null);
  fs.rmSync(batch, { recursive: true, force: true });
});

test('resolver: production-readback picks the live receipt and primary; sibling shorthand paths resolve; batch-wide basename hits never shadow the run', () => {
  const { batch, run, png } = resolverFixture();
  fs.mkdirSync(path.join(run, 'fix', 'live'), { recursive: true });
  fs.mkdirSync(path.join(run, 'fix', 'live-q'), { recursive: true });
  png('demo-reston/fix/first.png', 'first');
  png('demo-reston/fix/second.png', 'second');
  png('other-run/fix/second.png', 'impostor');
  fs.writeFileSync(path.join(run, 'fix', 'live', 'apply.json'), JSON.stringify({ readback: { effective_branding: { logo_attachment_id: 'old', logo_filename: 'first.png', web_primary_color: '#000001' } } }));
  fs.writeFileSync(path.join(run, 'fix', 'live-q', 'apply.json'), JSON.stringify({ readback: { effective_branding: { logo_attachment_id: 'new', logo_filename: 'second.png', web_primary_color: '#000002' } } }));
  // the newest receipt is a later color-only write on the same attachment: production-readback says which attachment and primary are live
  fs.writeFileSync(path.join(run, 'production-readback.json'), JSON.stringify({ effective_branding: { logo_attachment_id: 'new', web_primary_color: '#ABCDEF' } }));
  const resolved = resolveAppliedLogo(run, null);
  assert.equal(resolved?.logoRel, path.join('fix', 'second.png'));
  assert.equal(resolved?.attachment_id, 'new');
  assert.equal(resolved?.primary, '#ABCDEF');
  assert.equal(resolved?.actual_sha256, shaOf('png:second'), 'the run-local file wins over a same-named file in another run');
  assert.equal(resolved?.attachment_check, 'match');
  // production says something is live that no receipt in the run dir wrote: flagged, so the replay skips instead of guessing
  fs.writeFileSync(path.join(run, 'production-readback.json'), JSON.stringify({ effective_branding: { logo_attachment_id: 'unrecorded', web_primary_color: '#ABCDEF' } }));
  const unknownLive = resolveAppliedLogo(run, null);
  assert.equal(unknownLive?.attachment_check, 'mismatch');
  assert.match(unknownLive?.note ?? '', /no apply receipt carries/);
  fs.writeFileSync(path.join(run, 'production-readback.json'), JSON.stringify({ effective_branding: { logo_attachment_id: 'new', web_primary_color: '#ABCDEF' } }));
  // a sibling run records the namesake's path as "reston/fix/second.png"
  const sibling = path.join(batch, 'demo-potomac');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'manifest.json'), JSON.stringify({ applied_update_2026_09_15: { logo_file: `reston/fix/second.png (1600x544, sha256 ${shaOf('png:second').slice(0, 8)}...)`, logo_attachment_id: 'new', colors_after: { web_primary_color: '#000002' } } }));
  const viaSibling = resolveAppliedLogo(sibling, null);
  assert.equal(viaSibling?.source, 'manifest:logo_file');
  assert.equal(viaSibling?.sha_check, 'match');
  assert.match(viaSibling?.note ?? '', /sibling/);
  fs.rmSync(batch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 2026-09-21: edge-quality, sticker-ground, primary-too-light
// ---------------------------------------------------------------------------------------------
import { contrastVsWhite } from './gates.ts';

test('registry 2026-09-21: edge-quality is a block battery gate overridable only for traced_from_small_source; sticker-ground and primary-too-light are hard', () => {
  const eq = gateDefinition('edge-quality');
  assert.equal(eq.severity, 'block');
  assert.equal(eq.battery, true);
  assert.equal(eq.override_allowed, true);
  assert.deepEqual(eq.override_allowed_verdicts, ['traced_from_small_source']);
  assert.equal(eq.override_allowed_for_shipped, false);
  assert.equal(eq.thresholds.min_source_native_px, 700);
  assert.equal(eq.thresholds.binary_alpha_min_longest_px, 1000);
  assert.equal(gateDefinition('sticker-ground').override_allowed, false);
  assert.equal(gateDefinition('sticker-ground').battery, false);
  assert.equal(gateDefinition('primary-too-light').override_allowed, false);
  assert.equal(gateDefinition('primary-too-light').battery, true);
  assert.equal(gateDefinition('primary-too-light').thresholds.min_contrast_vs_white, 1.3);
  assert.ok(registryChangelogHas('primary-too-light', '2026-09-22'), 'Q8 = A changelog entry');
  assert.equal(canonicalGateId('edge_quality'), 'edge-quality');
  assert.equal(canonicalGateId('white_primary'), 'primary-too-light');
  const registry = loadGateRegistry();
  for (const id of ['edge-quality', 'sticker-ground', 'primary-too-light']) assert.ok(registry.changelog?.some((c) => c.gate === id && c.date === '2026-09-21'), `changelog entry for ${id}`);
});

function registryChangelogHas(gate: string, date: string): boolean {
  return Boolean(loadGateRegistry().changelog?.some((c) => c.gate === gate && c.date === date));
}

test('primary-too-light (Q8 = A): white and near-white HOLD under 1.3:1, authored tan and black pass; contrast is WCAG', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-primary-light-'));
  try {
    const asset = path.join(dir, 'mark.png');
    await sharp(Buffer.from('<svg width="900" height="300" xmlns="http://www.w3.org/2000/svg"><text x="450" y="220" text-anchor="middle" font-family="Arial" font-size="180" font-weight="700" fill="#111111">WRAP</text></svg>')).png().toFile(asset);
    assert.ok(Math.abs(contrastVsWhite('#000000') - 21) < 0.01);
    assert.ok(Math.abs(contrastVsWhite('#FFFFFF') - 1) < 0.001);
    const white = await runBattery({ asset, primary: '#FFFFFF' }, { only: ['primary-too-light'], writeFiles: false });
    assert.equal(white.results[0].pass, false);
    assert.equal(white.results[0].verdict, 'primary_too_light');
    const near = await runBattery({ asset, primary: '#F5F5F5' }, { only: ['primary-too-light'], writeFiles: false });
    assert.equal(near.results[0].pass, false, '#F5F5F5 (1.09:1) is near-white and fails');
    assert.match(String(near.results[0].result.reasons[0]), /authored cream or tan is allowed/);
    const tan = await runBattery({ asset, primary: '#D2B48C' }, { only: ['primary-too-light'], writeFiles: false });
    assert.equal(tan.results[0].pass, true, "Chubby's-style tan #D2B48C (1.94:1) is an authored light card and passes");
    const paleCream = await runBattery({ asset, primary: '#E8E4DD' }, { only: ['primary-too-light'], writeFiles: false });
    assert.equal(paleCream.results[0].pass, false, 'the Toscano site cream at 1.26:1 is near-white for a card and fails the 1.3 floor');
    const black = await runBattery({ asset, primary: '#161616' }, { only: ['primary-too-light'], writeFiles: false });
    assert.equal(black.results[0].pass, true);
    const verdict = computeVerdict(white.results as unknown as JsonObject[], [{ gate: 'primary-too-light', asset: 'mark.png', decided_by: 'x', reason: 'y', at: 'z' }], { partial: true });
    assert.equal(verdict.verdict, 'HOLD', 'no override path for a white primary');
    assert.equal(verdict.refused.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('battery selection: sticker-ground runs only with surface sticker; edge-quality runs in every battery and carries the source inputs', () => {
  const card = selectGates({ asset: '/x.png', primary: '#111111', expected: 'X' });
  assert.ok(card.run.some((g) => g.id === 'edge-quality'));
  assert.ok(!card.run.some((g) => g.id === 'sticker-ground'));
  assert.ok(card.skipped.every((s) => s.gate !== 'sticker-ground'), 'a battery:false gate without its input is not reported as skipped');
  const sticker = selectGates({ asset: '/x.png', primary: '#FFFFFF', expected: 'X', surface: 'sticker' });
  assert.ok(sticker.run.some((g) => g.id === 'sticker-ground'));
  const explicit = selectGates({ asset: '/x.png' }, ['sticker-ground']);
  assert.deepEqual(explicit.run, []);
  assert.ok(explicit.skipped.some((s) => s.gate === 'sticker-ground' && /surface sticker/.test(s.why)));
});

test('edge-quality through the battery: the source figures land in inputs and the Skyboxx-shaped case (800px binary trace of a 640px avatar) HOLDs with no override path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-edge-battery-'));
  try {
    const asset = path.join(dir, 'skyboxx-like.png');
    const svg = '<svg width="800" height="442" xmlns="http://www.w3.org/2000/svg"><circle cx="400" cy="221" r="180" fill="#FFFFFF"/></svg>';
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= 128 ? 255 : 0;
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(asset);
    const battery = await runBattery({ asset, primary: '#161616', sourceNativePx: 640, derivation: 'trace', sourceNote: 'fb avatar' }, { only: ['edge-quality'], writeFiles: false });
    const r = battery.results[0];
    assert.equal(r.verdict, 'binary_alpha');
    assert.equal((r.inputs as JsonObject).source_native_px, 640);
    assert.equal((r.inputs as JsonObject).derivation, 'trace');
    const v = computeVerdict(battery.results as unknown as JsonObject[], [{ gate: 'edge-quality', asset: 'skyboxx-like.png', decided_by: 'travisse', reason: 'ship it', at: 'now' }], { partial: true });
    assert.equal(v.verdict, 'HOLD');
    assert.equal(v.refused[0]?.verdict, 'binary_alpha');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
