// node --test run-progress.test.mjs: bundle manifest with Blob references, the freshness guard, the soft claim.
// No network: fetch is stubbed; the reviews clone is a temp dir with a data/blob-index.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const reviews = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-reviews-'));
process.env.BOOSTLY_REVIEWS_REPO_DIR = reviews;
process.env.BLOB_PUBLIC_ORIGIN = 'https://blob.example.test';
process.env.BOOSTLY_EDITOR = 'machine-a';
const rp = await import('./run-progress.mjs');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function makeRun(slug) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-root-'));
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, 'gbp-photos'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ request: { location_name: 'Test Pizza', ship_to: { street: '1 Main St' } } }));
  fs.writeFileSync(path.join(dir, 'evidence', 'branding-evidence.json'), JSON.stringify({ logo_candidates: [], formatted_address: '12 Oak Ave' }));
  fs.writeFileSync(path.join(dir, 'gbp-photos', 'gbp-photos.json'), JSON.stringify({ photos: [{ file: 'gbp-photo-01.jpg' }] }));
  return { root, dir, slug, progressFile: path.join(dir, 'review', 'progress.json'), statusFile: path.join(dir, 'review', 'status.json') };
}
function withFetch(routes, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0];
    const hit = Object.entries(routes).find(([k]) => u.endsWith(k));
    if (!hit) return { status: 404, ok: false, text: async () => 'nf' };
    return { status: 200, ok: true, json: async () => hit[1], text: async () => JSON.stringify(hit[1]) };
  };
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

test('collectRefs references images the site build already holds, by content hash, and uploads only small json', () => {
  const r = makeRun('test-pizza');
  const photo = Buffer.from('not really a jpeg but hashed all the same');
  fs.writeFileSync(path.join(r.dir, 'gbp-photos', 'gbp-photo-01.jpg'), photo);
  fs.writeFileSync(path.join(r.dir, 'gbp-photos', 'gbp-photo-02.jpg'), Buffer.from('unknown to the site'));
  fs.mkdirSync(path.join(reviews, 'data'), { recursive: true });
  fs.writeFileSync(path.join(reviews, 'data', 'blob-index.json'), JSON.stringify({
    [`assets/test-pizza/${sha(photo).slice(0, 12)}-gbp-photo-01.jpg`]: { url: 'https://blob.example.test/assets/test-pizza/x-gbp-photo-01.jpg', bytes: photo.length },
    [`assets/test-pizza/000000000000-gbp-photo-02.jpg`]: { url: 'https://blob.example.test/assets/test-pizza/y-gbp-photo-02.jpg', bytes: 5 },
    [`assets/other-slug/${sha(photo).slice(0, 12)}-gbp-photo-01.jpg`]: { url: 'https://blob.example.test/assets/other/x.jpg', bytes: photo.length },
  }));
  const { files, notes } = rp.collectBundle(r);
  assert.ok(files.has('evidence/branding-evidence.json'), 'evidence json is uploaded');
  assert.ok(files.has('gbp-photos/gbp-photos.json'), 'gbp manifest is uploaded');
  assert.ok(!files.has('gbp-photos/gbp-photo-01.jpg'), 'photos are never uploaded');
  const ev = JSON.parse(files.get('evidence/branding-evidence.json').toString());
  assert.equal(ev.formatted_address.redacted, true, 'address keys stay redacted');
  const refs = rp.collectRefs(r, files, JSON.parse(fs.readFileSync(path.join(reviews, 'data', 'blob-index.json'), 'utf8')), notes);
  assert.deepEqual([...refs.keys()], ['gbp-photos/gbp-photo-01.jpg']);
  assert.equal(refs.get('gbp-photos/gbp-photo-01.jpg').blob_url, 'https://blob.example.test/assets/test-pizza/x-gbp-photo-01.jpg');
  assert.equal(refs.get('gbp-photos/gbp-photo-01.jpg').sha256, sha(photo));
  assert.ok(notes.some((n) => n.includes('gbp-photo-02.jpg')), 'an unmatched same-name asset is noted, not uploaded');
  const prev = { files: { 'run.json': { sha256: sha(files.get('run.json')), bytes: 1, url: 'https://blob.example.test/bundles/test-pizza/run.json' } } };
  const { manifest, toUpload } = rp.buildManifest(r, files, refs, prev, { by: 'tester', total: 123 });
  assert.equal(manifest.files['run.json'].url, prev.files['run.json'].url, 'unchanged upload is reused');
  assert.ok(!toUpload.includes('run.json'));
  assert.ok(toUpload.includes('evidence/branding-evidence.json'));
  assert.equal(manifest.files['gbp-photos/gbp-photo-01.jpg'].blob_url, 'https://blob.example.test/assets/test-pizza/x-gbp-photo-01.jpg');
  assert.equal(manifest.files['gbp-photos/gbp-photo-01.jpg'].url, undefined, 'a reference carries no bundle url');
  assert.equal(manifest.refs, 1);
  assert.equal(manifest.bytes, 123, 'references do not count toward the bundle bytes');
});

test('check: exit 3 when the Blob bundle is newer than the last local sync, 0 after --allow-stale, 0 when fresh or local-only', async () => {
  const r = makeRun('test-pizza-2');
  const newer = { slug: r.slug, pushed_at: '2026-10-21T12:00:00.000Z', by: 'machine-b', files: {} };
  await withFetch({ '/bundles/test-pizza-2/manifest.json': newer }, async () => {
    let c = await rp.checkRun(r, {});
    assert.equal(c.code, 3, 'never synced here and a Blob bundle exists');
    assert.match(c.lines.join('\n'), /pull first: Blob bundle is newer \(pushed 2026-10-21T12:00:00.000Z by machine-b\)/);
    c = await rp.checkRun(r, { allowStale: true });
    assert.equal(c.code, 0);
    assert.match(c.warnings.join('\n'), /--allow-stale: pull first/);
    fs.writeFileSync(path.join(r.dir, 'review', 'bundle-manifest.json'), JSON.stringify({ pushed_at: '2026-10-21T11:00:00.000Z' }));
    c = await rp.checkRun(r, {});
    assert.equal(c.code, 3, 'local sync older than the Blob push');
    fs.writeFileSync(path.join(r.dir, 'review', 'bundle-manifest.json'), JSON.stringify({ pushed_at: '2026-10-21T12:00:00.000Z' }));
    c = await rp.checkRun(r, {});
    assert.equal(c.code, 0, 'same push: fresh');
    assert.match(c.lines.join('\n'), /^fresh:/);
    fs.rmSync(path.join(r.dir, 'review', 'bundle-manifest.json'));
    fs.writeFileSync(r.progressFile, JSON.stringify({ stage: 'review', bundle: { pushed_at: '2026-10-21T13:00:00.000Z' } }));
    c = await rp.checkRun(r, {});
    assert.equal(c.code, 0, 'progress.json bundle stamp counts as a local sync');
  });
  await withFetch({}, async () => {
    const c = await rp.checkRun(r, {});
    assert.equal(c.code, 0, 'no Blob bundle: local-only run');
    assert.match(c.lines.join('\n'), /local-only/);
  });
  const c = await rp.checkRun(r, { origin: null });
  assert.equal(c.code, 0);
  assert.match(c.warnings.join('\n'), /no Blob origin/);
});

test("check: another machine's claim under two hours old is a warning, never a failure", async () => {
  const r = makeRun('test-pizza-3');
  fs.writeFileSync(path.join(r.dir, 'review', 'bundle-manifest.json'), JSON.stringify({ pushed_at: '2026-10-21T12:00:00.000Z' }));
  const manifest = { slug: r.slug, pushed_at: '2026-10-21T12:00:00.000Z', by: 'machine-a', files: {} };
  const now = Date.parse('2026-10-21T12:30:00.000Z');
  const status = (by, since) => ({ slug: r.slug, editing: { by, since } });
  let c = await withFetch({ '/bundles/test-pizza-3/manifest.json': manifest, '/status/test-pizza-3.json': status('machine-b', '2026-10-21T12:10:00.000Z') }, () => rp.checkRun(r, { now }));
  assert.equal(c.code, 0);
  assert.match(c.warnings.join('\n'), /another machine is editing this run: machine-b since 2026-10-21T12:10:00.000Z/);
  c = await withFetch({ '/bundles/test-pizza-3/manifest.json': manifest, '/status/test-pizza-3.json': status('machine-b', '2026-10-21T09:00:00.000Z') }, () => rp.checkRun(r, { now }));
  assert.equal(c.warnings.length, 0, 'a claim older than two hours is silent');
  c = await withFetch({ '/bundles/test-pizza-3/manifest.json': manifest, '/status/test-pizza-3.json': status('machine-a', '2026-10-21T12:10:00.000Z') }, () => rp.checkRun(r, { now }));
  assert.equal(c.warnings.length, 0, 'my own claim is silent');
});

test('bundle walkers skip nested dirs as dirs and never follow symlinks (EISDIR on candidates/ladder/, Clearwater 2026-10-21)', () => {
  const r = makeRun('test-pizza-4');
  fs.mkdirSync(path.join(r.dir, 'candidates', 'ladder'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'candidates', 'ladder', 'a.png'), Buffer.from('png-a'));
  fs.writeFileSync(path.join(r.dir, 'candidates', 'b.png'), Buffer.from('png-b'));
  fs.mkdirSync(path.join(r.dir, 'fix', 'hq'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'fix', 'hq', 'c.png'), Buffer.from('png-c'));
  fs.symlinkSync(path.join(r.dir, 'fix'), path.join(r.dir, 'candidates', 'fix-link'));
  fs.symlinkSync(path.join(r.dir, 'fix', 'hq', 'c.png'), path.join(r.dir, 'candidates', 'c-link.png'));
  const { files, notes } = rp.collectBundle(r);
  assert.ok(files.has('candidates/ladder/a.png') && files.has('candidates/b.png'));
  assert.ok(!files.has('candidates/c-link.png') && ![...files.keys()].some((k) => k.startsWith('candidates/fix-link')));
  const refs = rp.collectRefs(r, files, { [`assets/test-pizza-4/${sha(Buffer.from('png-c')).slice(0, 12)}-c.png`]: { url: 'https://blob.example.test/c.png', bytes: 5 } }, notes);
  assert.deepEqual([...refs.keys()], ['fix/hq/c.png'], 'the real file is referenced, the symlink is not');
});

test('pull-side placeholders: a redacted run.json passes run-file validate again', () => {
  const { spawnSync } = require('node:child_process');
  const runFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'boostly-box-fulfillment', 'scripts', 'run-file.ts');
  if (!fs.existsSync(runFile)) return; // package layouts without the box-fulfillment skill
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-valid-'));
  const dir = path.join(root, 'test-pizza-5');
  const request = { request_id: 'req_test', location_id: 'loc_1', location_name: 'Test Pizza', address: '1110 S Main St, Clearwater, FL 33756',
    csm: { name: 'Jane Doe', email: 'jane@example.test' }, requested_by: { name: 'Jane Doe', email: 'jane@example.test' },
    shipping: { recipient_name: 'Test Pizza', address_line1: '1110 S Main St', city: 'Clearwater', state: 'FL', zip: '33756', complete: true },
    identity: { street_address: '1110 S Main St', postal_code: '33756' } };
  // every other key the request block requires, filled with a neutral value of the schema's type
  const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(runFile), '..', 'references', 'run-schema.json'), 'utf8'));
  const reqSchema = schema.properties?.request ?? {};
  for (const k of reqSchema.required ?? []) {
    if (k in request) continue;
    const t = [].concat(reqSchema.properties?.[k]?.type ?? 'string')[0];
    request[k] = t === 'array' ? [] : t === 'object' ? {} : t === 'number' || t === 'integer' ? 0 : t === 'boolean' ? false : t === 'null' ? null : 'x';
  }
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(request));
  const init = spawnSync(process.execPath, ['--experimental-strip-types', runFile, 'init', '--request', path.join(root, 'request.json'), '--dir', dir], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const redacted = rp.redactJson(run);
  assert.equal(redacted.request.address.redacted, true);
  assert.equal(redacted.request.shipping.redacted, true);
  const restored = rp.restorePlaceholders(redacted);
  assert.equal(restored.request.address, '[redacted: read live]');
  assert.deepEqual(restored.request.shipping, { complete: false, note: '[redacted: read live]', redacted: true });
  assert.equal(restored.request.csm.email, null);
  assert.ok(!JSON.stringify(restored).includes('Main St'), 'no street data comes back');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(restored, null, 2));
  const v = spawnSync(process.execPath, ['--experimental-strip-types', runFile, 'validate', dir], { encoding: 'utf8' });
  const out = JSON.parse(v.stdout);
  assert.equal(out.valid, true, JSON.stringify(out.errors));
});
