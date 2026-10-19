// node --test post-review.test.mjs : --reply parsing, the run.json thread source and the reply record (no Slack, no DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runSlackThread, replyRecord } from './post-review.mjs';

test('--reply takes the text, --force is a flag, dry-run stays the default', () => {
  const o = parseArgs(['--run-dir', '/r', '--reply', 'Holding the print order until the counts are confirmed.']);
  assert.equal(o.reply, 'Holding the print order until the counts are confirmed.');
  assert.equal(o.apply, false); assert.equal(o.force, undefined);
  const f = parseArgs(['--run-dir', '/r', '--reply', 'x', '--apply', '--force']);
  assert.equal(f.apply, true); assert.equal(f.force, true);
});

test('the run.json slack block is a thread source; a malformed ts is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  assert.equal(runSlackThread(dir), null);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ slack: { thread_ts: '1791928537.812589', channel: 'C09MSM8MA9Y' } }));
  assert.deepEqual(runSlackThread(dir), { threadTs: '1791928537.812589', channel: 'C09MSM8MA9Y' });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ slack: { thread_ts: 'nope' } }));
  assert.equal(runSlackThread(dir), null);
});

test('replyRecord carries the permalink and never the post receipt fields', () => {
  const r = replyRecord({ channel: 'C1', threadTs: '1791928537.812589', source: 'run.json slack block', text: 'hi', ts: '1792085672.421159', requestId: 'req', locationId: 'loc', locationName: 'X', botUser: 'bot' });
  assert.equal(r.permalink, 'https://slack.com/archives/C1/p1792085672421159?thread_ts=1791928537.812589&cid=C1');
  assert.equal(r.text, 'hi'); assert.equal(r.files, undefined); assert.equal(r.note, undefined);
  assert.equal(replyRecord({ channel: 'C1', threadTs: '1791928537.812589', text: 'hi', ts: null }).permalink, null);
});
