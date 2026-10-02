import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { derivationFromProse, inferSourceForRun, ladderRecord, loadLadder, pngSize, sizesFromProse, sourceInfoForCandidate } from './logo-sources.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

test('the ladder JSON is ordered data: site rungs first, gbp last, google images locator-only, floor 700', () => {
  const ladder = loadLadder();
  assert.equal(ladder.min_source_px_for_trace, 700);
  const ids = ladder.rungs.map((r) => r.id);
  assert.equal(ids[0], 'site_svg');
  assert.equal(ids[ids.length - 1], 'gbp');
  assert.ok(ids.indexOf('facebook_full') < ids.indexOf('instagram_profile_live'));
  assert.ok(ids.indexOf('toast') > ids.indexOf('menu_pdf'));
  for (const r of ladder.rungs) { assert.ok(r.fetch_hint.length > 20, r.id); assert.ok(typeof r.min_useful_px === 'number'); assert.ok(r.provenance); }
  assert.equal(ladder.rungs.find((r) => r.id === 'google_images')?.locator_only, true);
  assert.equal(new Set(ids).size, ids.length, 'rung ids unique');
});

test('ladderRecord: records every rung, the best authored source, and whether a trace is allowed', () => {
  const skyboxx = ladderRecord([
    { rung: 'site_png_original', tried: true, width: 230, height: 123, url: 'https://img1.wsimg.com/...' },
    { rung: 'facebook_full', tried: true, width: 640, height: 394 },
    { rung: 'google_images', tried: true, longest_px: 4000, note: 'locator, not a source' },
  ]);
  assert.equal(skyboxx.best?.rung, 'facebook_full', 'google images never counts as a source');
  assert.equal(skyboxx.best?.longest_px, 640);
  assert.equal(skyboxx.best_under_floor, true);
  assert.equal(skyboxx.complete_for_trace, false);
  assert.ok(skyboxx.untried_over_floor.includes('instagram_profile_live'));
  assert.ok(skyboxx.untried_over_floor.includes('toast'));
  assert.equal(skyboxx.rungs.length, loadLadder().rungs.length);

  const complete = ladderRecord(loadLadder().rungs.map((r) => ({ rung: r.id, tried: true, longest_px: r.id === 'instagram_profile_live' ? 896 : 640 })));
  assert.equal(complete.complete_for_trace, true);
  assert.equal(complete.best?.rung, 'instagram_profile_live');
  assert.equal(complete.best_under_floor, false);
  const empty = ladderRecord([]);
  assert.equal(empty.best, null);
  assert.equal(empty.complete_for_trace, false);
});

test('prose heuristics for runs that predate the ladder: sizes and derivation words', () => {
  assert.deepEqual(sizesFromProse('Source = the Facebook page avatar (640x394 JPEG), potrace at 2x, rendered 1600x889', { width: 1600, height: 889 }), [640]);
  assert.equal(derivationFromProse('potrace of the 640px avatar'), 'trace');
  assert.equal(derivationFromProse('lanczos upsampled 2.5x'), 'upscale');
  assert.equal(derivationFromProse('the authored SVG from the site header'), 'vector');
  assert.equal(derivationFromProse('Official site header logo, native 724x292 RGBA'), 'unknown');
  const info = sourceInfoForCandidate(null, { source: 'PROVENANCE NOTE: Source = the Facebook page avatar (640x394)', width: 1600, height: 889 });
  assert.equal(info.source_native_longest_px, 640);
  assert.equal(info.derivation, 'upscale');
  assert.equal(info.inferred, true);
  const recorded = sourceInfoForCandidate(null, { source: 'x', width: 1600, height: 800, source_native_px: 896, derivation: 'trace' });
  assert.equal(recorded.source_native_longest_px, 896);
  assert.equal(recorded.inferred, false);
  const viaLadder = sourceInfoForCandidate({ logo_sources: { ladder: ladderRecord([{ rung: 'facebook_full', tried: true, longest_px: 640 }]) } }, { source: 'traced', width: 1600, height: 800 });
  assert.equal(viaLadder.from, 'ladder');
  assert.equal(viaLadder.derivation, 'trace');
});

test('inferSourceForRun: chosen first-party candidate is its own native source; raw files under candidates/ are the fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-sources-run-'));
  try {
    fs.mkdirSync(path.join(dir, 'evidence', 'logo-candidates'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
    const cand = path.join(dir, 'evidence', 'logo-candidates', '01-first_party_header.png');
    await sharp({ create: { width: 719, height: 662, channels: 4, background: '#ffffff' } }).png().toFile(cand);
    const applied = path.join(dir, 'fix-words.png');
    await sharp({ create: { width: 719, height: 262, channels: 4, background: '#ffffff' } }).png().toFile(applied);
    const packet = { logo_candidates: [{ local_path: cand, provenance: 'first_party_header', width: 719, height: 662, source: 'Official site HEADER logo, decoded AVIF, transparent' }] };
    fs.writeFileSync(path.join(dir, 'evidence', 'branding-evidence.json'), JSON.stringify(packet));
    const run = { evidence: { packet_path: 'evidence/branding-evidence.json' }, decision: { logo_choice: cand } };
    const a = inferSourceForRun(dir, run, applied);
    assert.equal(a.source_native_longest_px, 719);
    assert.equal(a.derivation, 'native');
    assert.equal(a.from, 'candidate_size');
    assert.deepEqual(pngSize(cand), { width: 719, height: 662 });

    // no packet: the raw Facebook avatar on disk is the source, and a bigger applied file means upscale
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-sources-run2-'));
    fs.mkdirSync(path.join(dir2, 'candidates'));
    await sharp({ create: { width: 640, height: 394, channels: 3, background: '#003860' } }).jpeg().toFile(path.join(dir2, 'candidates', 'fb-og-image.jpg'));
    const applied2 = path.join(dir2, 'card.png');
    await sharp({ create: { width: 800, height: 442, channels: 4, background: '#ffffff' } }).png().toFile(applied2);
    const b = inferSourceForRun(dir2, {}, applied2);
    assert.equal(b.source_native_longest_px, 640);
    assert.equal(b.derivation, 'upscale');
    assert.equal(b.from, 'raw_file');
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
