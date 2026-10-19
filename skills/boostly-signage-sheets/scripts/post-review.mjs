#!/usr/bin/env node
// post-review.mjs: post a fulfillment run's review previews (proof + signage
// shots + note) into the request's Slack thread in #fulfillment.
//
// Usage:
//   node post-review.mjs --run-dir <dir>
//     [--location-id <id> | --thread-ts <ts> | --permalink <url>]
//     [--channel <C...>] [--note <file>] [--files a.png,b.png] [--apply]
//   node post-review.mjs --run-dir <dir> --reply "<text>" [--apply] [--force]
//
// Dry-run by default. --apply uploads and writes <run-dir>/slack-post.json.
// --reply posts exactly ONE plain thread reply (the hold reply after a CSM hold
// lands once the vendor email is out), recorded in <run-dir>/slack-reply.json;
// slack-post.json is never touched; a second reply needs --force.
// Thread ts resolution order: --thread-ts, --permalink, run.json slack block
// (the post receipt), DB lookup of fulfillment_requests.slack_thread_ts by
// location id (--location-id or the run manifest). NEVER guesses; refuses to
// post without a thread ts so nothing lands top-level. Never prints the token.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_CHANNEL = 'C09MSM8MA9Y'; // #fulfillment (Boostly)
const V2_DB = new URL('../../v2-database/bin/v2-db', import.meta.url).pathname;
const SLACK_CONFIG = path.join(process.env.HOME || '', '.config/slack-tools/config.json');
const TS_RE = /^\d{10}\.\d{6}$/;

// Default preview set, in post order. Paths are relative to the run dir.
const DEFAULT_FILES = [
  { rel: 'proof.png', title: (loc) => `${loc} tap card proof` },
  { rel: 'signage/shots/table-p1.png', title: () => 'Table sticker sheet p1' },
  { rel: 'signage/shots/pop-primary.png', title: () => 'POP sign (solid)' },
  { rel: 'signage/shots/pop-light.png', title: () => 'POP sign (light)' },
  { rel: 'signage/shots/bathroom-p1.png', title: () => 'Bathroom sheet p1' },
];

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    'usage: node post-review.mjs --run-dir <dir> [--location-id <id> | --thread-ts <ts> | --permalink <url>]\n' +
      '                            [--channel <C...>] [--note <file>] [--files a.png,b.png] [--apply]',
  );
  process.exit(2);
}

export function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--run-dir': out.runDir = take(); break;
      case '--location-id': out.locationId = take(); break;
      case '--thread-ts': out.threadTs = take(); break;
      case '--permalink': out.permalink = take(); break;
      case '--channel': out.channel = take(); break;
      case '--note': out.note = take(); break;
      case '--files': out.files = take(); break;
      case '--reply': out.reply = take(); break;
      case '--force': out.force = true; break;
      case '--apply': out.apply = true; break;
      case '-h': case '--help': usage(); break;
      default: usage(`unknown argument ${a}`);
    }
  }
  if (!out.runDir) usage('--run-dir is required');
  return out;
}

function warn(msg) { console.error(`warn: ${msg}`); }
function fail(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }

function readManifest(runDir) {
  const p = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { warn(`manifest.json unreadable: ${e.message}`); return null; }
}

function manifestLocationId(m) {
  return m?.location_id || m?.location?.location_id || m?.location?.id || null;
}
function manifestLocationName(m) {
  return m?.location_name || m?.location?.location_name || m?.location?.name || null;
}
// run.json slack block: the receipt of the review post (thread_ts + channel).
export function runSlackThread(runDir) {
  const p = path.join(runDir, 'run.json');
  if (!fs.existsSync(p)) return null;
  try {
    const sl = JSON.parse(fs.readFileSync(p, 'utf8')).slack || {};
    return sl.thread_ts && TS_RE.test(String(sl.thread_ts)) ? { threadTs: String(sl.thread_ts), channel: sl.channel || null } : null;
  } catch { return null; }
}

// The slack-reply.json record for one thread reply.
export function replyRecord({ channel, threadTs, source, text, ts, requestId, locationId, locationName, botUser }) {
  return {
    posted_at: new Date().toISOString(), channel, thread_ts: threadTs, thread_source: source, message_ts: ts,
    permalink: ts ? `https://slack.com/archives/${channel}/p${ts.replace('.', '')}?thread_ts=${threadTs}&cid=${channel}` : null,
    request_id: requestId, location_id: locationId, location_name: locationName, bot_user: botUser, text,
  };
}

function manifestThreadTs(m) {
  const ts = m?.fulfillment_request?.slack_thread_ts;
  return ts && TS_RE.test(String(ts)) ? String(ts) : null;
}

// Slack permalink: https://<ws>.slack.com/archives/C09MSM8MA9Y/p1788447294990169[?thread_ts=...]
function parsePermalink(url) {
  let u;
  try { u = new URL(url); } catch { fail(`--permalink is not a URL: ${url}`); }
  const m = u.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) fail(`--permalink does not look like a Slack message link (expected /archives/<channel>/p<16 digits>): ${url}`);
  const channel = m[1];
  const messageTs = `${m[2]}.${m[3]}`;
  // If the link points at a reply inside a thread, the thread parent is in ?thread_ts.
  const qts = u.searchParams.get('thread_ts');
  const threadTs = qts && TS_RE.test(qts) ? qts : messageTs;
  return { channel, threadTs };
}

function sqlLiteral(v) { return `'${String(v).replace(/'/g, "''")}'`; }

async function v2DbRows(sql) {
  if (!fs.existsSync(V2_DB)) fail(`v2-db CLI not found at ${V2_DB}`);
  const { stdout } = await execFileAsync(V2_DB, ['query', '--sql', sql, '--json'], { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function dbThreadTs(locationId) {
  const rows = await v2DbRows(`
    select fr.id, fr.slack_thread_ts, fr.canceled_at, fr.created_at, l.name as location_name
    from fulfillment_requests fr
    join locations l on l.id = fr.location_id
    where fr.location_id = ${sqlLiteral(locationId)}
    order by fr.created_at desc
  `);
  if (!rows.length) fail(`no fulfillment_requests rows for location ${locationId}`);
  const live = rows.filter((r) => !r.canceled_at);
  const pool = live.length ? live : rows;
  const withTs = pool.filter((r) => r.slack_thread_ts && TS_RE.test(String(r.slack_thread_ts)));
  if (!withTs.length) fail(`fulfillment_requests for location ${locationId} has no slack_thread_ts (${rows.length} row(s)); pass --thread-ts or --permalink explicitly`);
  if (withTs.length > 1) warn(`${withTs.length} requests with a thread ts for this location; using the newest (${withTs[0].id}, created ${withTs[0].created_at})`);
  return { threadTs: String(withTs[0].slack_thread_ts), requestId: withTs[0].id, locationName: withTs[0].location_name };
}

function loadToken() {
  if (!fs.existsSync(SLACK_CONFIG)) fail(`Slack config not found at ${SLACK_CONFIG}`);
  const cfg = JSON.parse(fs.readFileSync(SLACK_CONFIG, 'utf8'));
  const token = cfg?.workspaces?.boostly?.token;
  if (!token) fail('workspaces.boostly.token missing in Slack config');
  return token;
}

async function slack(token, method, { query, json, form } = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (json) { headers['Content-Type'] = 'application/json; charset=utf-8'; body = JSON.stringify(json); }
  else if (form) { body = new URLSearchParams(form); }
  const res = await fetch(url, { method: json || form ? 'POST' : 'GET', headers, body });
  const data = await res.json();
  return data;
}

function stripEmDashes(text) {
  // Travisse's rule: no em dashes. Every em (or en) dash becomes a comma
  // pause; a period would be safer grammatically in some spots but risks
  // splitting a sentence around a proper noun, so keep it predictable.
  return text.replace(/\s*[—–]\s*/g, ', ');
}

function resolveNote(opts, runDir) {
  const p = opts.note ? path.resolve(opts.note) : path.join(runDir, 'slack-note.txt');
  if (!fs.existsSync(p)) fail(`note file not found: ${p}`);
  const raw = fs.readFileSync(p, 'utf8');
  const note = stripEmDashes(raw).trim();
  if (!note) fail(`note is empty: ${p}`);
  if (/[—–]/.test(note)) fail('note still contains a dash after stripping (bug)');
  if (note !== raw.trim()) warn('em dashes were stripped from the note');
  return { path: p, note };
}

function resolveFiles(opts, runDir, locationName) {
  const list = [];
  if (opts.files) {
    for (const entry of opts.files.split(',').map((s) => s.trim()).filter(Boolean)) {
      const abs = path.isAbsolute(entry) ? entry : path.join(runDir, entry);
      if (!fs.existsSync(abs)) { warn(`skipping missing file ${abs}`); continue; }
      list.push({ path: abs, filename: path.basename(abs), title: path.basename(abs, path.extname(abs)) });
    }
  } else {
    for (const d of DEFAULT_FILES) {
      const abs = path.join(runDir, d.rel);
      if (!fs.existsSync(abs)) { warn(`skipping missing default file ${d.rel}`); continue; }
      list.push({ path: abs, filename: path.basename(abs), title: d.title(locationName) });
    }
  }
  if (!list.length) fail('no files to post');
  for (const f of list) f.bytes = fs.statSync(f.path).size;
  return list;
}

// Read-only check that the thread parent actually exists at that ts in that
// channel. Guards against a wrong ts, which would post top-level.
async function verifyThread(token, channel, threadTs) {
  const d = await slack(token, 'conversations.replies', { query: { channel, ts: threadTs, limit: 1 } });
  if (!d.ok) {
    if (d.error === 'thread_not_found' || d.error === 'message_not_found') fail(`no message at ts ${threadTs} in ${channel}; refusing to post (would land top-level)`);
    if (d.error === 'channel_not_found') fail(`channel ${channel} not found or bot not a member`);
    warn(`could not verify thread (${d.error}); continuing on the resolved ts`);
    return null;
  }
  const parent = d.messages?.[0];
  if (!parent || parent.ts !== threadTs) fail(`thread parent ${threadTs} not returned by Slack; refusing to post`);
  return { replyCount: parent.reply_count ?? 0, preview: (parent.text || '').replace(/\s+/g, ' ').slice(0, 100) };
}

async function uploadFile(token, f) {
  const d = await slack(token, 'files.getUploadURLExternal', { query: { filename: f.filename, length: f.bytes } });
  if (!d.ok) fail(`files.getUploadURLExternal failed for ${f.filename}: ${d.error}`);
  const buf = fs.readFileSync(f.path);
  const res = await fetch(d.upload_url, { method: 'POST', body: buf });
  if (!res.ok) fail(`byte upload failed for ${f.filename}: HTTP ${res.status}`);
  return d.file_id;
}

async function findPostedMessageTs(token, channel, threadTs, fileIds, botUserId) {
  // files.info exposes the share ts once Slack has attached the file to the message.
  for (let attempt = 0; attempt < 5; attempt++) {
    const d = await slack(token, 'files.info', { query: { file: fileIds[0] } });
    const shares = d?.file?.shares?.public?.[channel] || d?.file?.shares?.private?.[channel] || [];
    const hit = shares.find((s) => s.thread_ts === threadTs) || shares[0];
    if (hit?.ts) return hit.ts;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Fallback: scan the thread for the newest bot reply carrying our file.
  const d = await slack(token, 'conversations.replies', { query: { channel, ts: threadTs, limit: 200 } });
  if (d.ok) {
    const mine = (d.messages || []).filter((m) => m.ts !== threadTs && (m.user === botUserId || m.bot_id) && (m.files || []).some((f) => fileIds.includes(f.id)));
    if (mine.length) return mine[mine.length - 1].ts;
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(opts.runDir);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) fail(`run dir not found: ${runDir}`);

  const manifest = readManifest(runDir);
  let locationId = opts.locationId || manifestLocationId(manifest);
  let locationName = manifestLocationName(manifest);
  let channel = opts.channel || null;
  let threadTs = null;
  let source = null;
  let requestId = manifest?.fulfillment_request?.id || null;

  const explicitCount = [opts.threadTs, opts.permalink].filter(Boolean).length;
  if (explicitCount > 1) usage('pass only one of --thread-ts or --permalink');

  if (opts.threadTs) {
    if (!TS_RE.test(opts.threadTs)) fail(`--thread-ts must look like 1234567890.123456, got ${opts.threadTs}`);
    threadTs = opts.threadTs; source = '--thread-ts';
  } else if (opts.permalink) {
    const p = parsePermalink(opts.permalink);
    threadTs = p.threadTs; source = '--permalink';
    if (channel && channel !== p.channel) fail(`--channel ${channel} disagrees with the permalink channel ${p.channel}`);
    channel = p.channel;
  } else if (runSlackThread(runDir)) {
    const r = runSlackThread(runDir);
    threadTs = r.threadTs; source = 'run.json slack block';
    if (r.channel) { if (channel && channel !== r.channel) fail(`--channel ${channel} disagrees with run.json slack.channel ${r.channel}`); channel = r.channel; }
    requestId = requestId || JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).request?.request_id || null;
    locationName = locationName || JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).request?.location_name || null;
  } else {
    if (!locationId) fail('no thread source: pass --thread-ts, --permalink, or --location-id (manifest.json has no location id)');
    const r = await dbThreadTs(locationId);
    threadTs = r.threadTs; source = `db fulfillment_requests.slack_thread_ts (request ${r.requestId})`;
    requestId = r.requestId;
    locationName = locationName || r.locationName;
    const mts = manifestThreadTs(manifest);
    if (mts && mts !== threadTs) warn(`manifest slack_thread_ts ${mts} differs from DB ${threadTs}; using DB`);
  }
  if (!threadTs || !TS_RE.test(threadTs)) fail('could not resolve a thread ts; refusing to post top-level');
  channel = channel || DEFAULT_CHANNEL;
  locationName = locationName || locationId || path.basename(runDir);

  const token = loadToken();
  const auth = await slack(token, 'auth.test');
  if (!auth.ok) fail(`auth.test failed: ${auth.error}`);

  if (opts.reply !== undefined) {
    const text = stripEmDashes(opts.reply).trim();
    if (!text) fail('--reply text is empty');
    const replyFile = path.join(runDir, 'slack-reply.json');
    if (fs.existsSync(replyFile) && !opts.force) fail(`a thread reply is already recorded in ${replyFile}; the hold reply is sent once (pass --force for a deliberate second reply)`);
    const thread = await verifyThread(token, channel, threadTs);
    console.log(`mode:      ${opts.apply ? 'APPLY (reply)' : 'dry-run (reply)'}`);
    console.log(`bot:       ${auth.user} (${auth.team})`);
    console.log(`location:  ${locationName}${locationId ? ` [${locationId}]` : ''}`);
    console.log(`channel:   ${channel}`);
    console.log(`thread_ts: ${threadTs}  (from ${source})`);
    if (thread) console.log(`thread:    verified, ${thread.replyCount} replies, parent: "${thread.preview}"`);
    console.log(`reply (${text.length} chars):`);
    console.log(text.split('\n').map((l) => `  | ${l}`).join('\n'));
    if (!opts.apply) { console.log('\ndry-run only; pass --apply to post the reply.'); return; }
    const d = await slack(token, 'chat.postMessage', { json: { channel, thread_ts: threadTs, text } });
    if (!d.ok) fail(`chat.postMessage failed: ${d.error}`);
    const record = replyRecord({ channel, threadTs, source, text, ts: d.ts, requestId, locationId, locationName, botUser: auth.user });
    if (fs.existsSync(replyFile)) { try { record.previous = JSON.parse(fs.readFileSync(replyFile, 'utf8')); } catch { /* keep going */ } }
    fs.writeFileSync(replyFile, JSON.stringify(record, null, 2) + '\n');
    console.log(`\nreplied in ${channel} thread ${threadTs} (ts ${d.ts})`);
    console.log(`wrote ${replyFile}`);
    return;
  }

  const { path: notePath, note } = resolveNote(opts, runDir);
  const files = resolveFiles(opts, runDir, locationName);
  const thread = await verifyThread(token, channel, threadTs);

  console.log(`mode:      ${opts.apply ? 'APPLY' : 'dry-run'}`);
  console.log(`bot:       ${auth.user} (${auth.team})`);
  console.log(`location:  ${locationName}${locationId ? ` [${locationId}]` : ''}`);
  console.log(`channel:   ${channel}`);
  console.log(`thread_ts: ${threadTs}  (from ${source})`);
  if (thread) console.log(`thread:    verified, ${thread.replyCount} replies, parent: "${thread.preview}"`);
  console.log(`files (${files.length}):`);
  for (const f of files) console.log(`  ${String(f.bytes).padStart(8)} B  ${path.relative(runDir, f.path)}  "${f.title}"`);
  const noteRel = path.relative(runDir, notePath);
  console.log(`note (${note.length} chars, from ${noteRel && !noteRel.startsWith('..') ? noteRel : notePath}):`);
  console.log(note.split('\n').map((l) => `  | ${l}`).join('\n'));

  if (!opts.apply) { console.log('\ndry-run only; pass --apply to post.'); return; }

  const uploaded = [];
  for (const f of files) {
    const id = await uploadFile(token, f);
    uploaded.push({ id, title: f.title, filename: f.filename, bytes: f.bytes });
    console.log(`uploaded ${f.filename} -> ${id}`);
  }
  const done = await slack(token, 'files.completeUploadExternal', {
    json: { files: uploaded.map((u) => ({ id: u.id, title: u.title })), channel_id: channel, thread_ts: threadTs, initial_comment: note },
  });
  if (!done.ok) fail(`files.completeUploadExternal failed: ${done.error}`);

  const messageTs = await findPostedMessageTs(token, channel, threadTs, uploaded.map((u) => u.id), auth.user_id);
  const record = {
    posted_at: new Date().toISOString(),
    channel,
    thread_ts: threadTs,
    thread_source: source,
    message_ts: messageTs,
    permalink: messageTs ? `https://slack.com/archives/${channel}/p${messageTs.replace('.', '')}?thread_ts=${threadTs}&cid=${channel}` : null,
    request_id: requestId,
    location_id: locationId,
    location_name: locationName,
    bot_user: auth.user,
    files: uploaded,
    note,
  };
  fs.writeFileSync(path.join(runDir, 'slack-post.json'), JSON.stringify(record, null, 2) + '\n');
  if (fs.existsSync(path.join(runDir, 'run.json'))) {
    // run.json slack block: the post receipt, so the thread state is never retyped.
    const previous = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).slack || {};
    const block = { ...previous, thread_ts: threadTs, channel, posted_at: record.posted_at, message_ts: messageTs, permalink: record.permalink, files: uploaded.map((u) => ({ id: u.id, filename: u.filename })), note_chars: note.length };
    const tmp = path.join(runDir, `.slack-block.${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(block));
    try {
      const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'boostly-box-fulfillment', 'scripts', 'run-file.ts');
      const r = await execFileAsync(process.execPath, ['--experimental-strip-types', cli, 'set', runDir, 'slack', '--from', tmp, '--by', 'post-review']);
      console.log(`run.json slack block recorded (${JSON.parse(r.stdout).cursor})`);
    } catch (e) {
      console.error(`warning: run.json slack block not recorded: ${e?.message || e}`);
    } finally { fs.unlinkSync(tmp); }
  }
  console.log(`\nposted to ${channel} thread ${threadTs}`);
  console.log(`message_ts: ${messageTs ?? '(not resolved; check thread)'}`);
  console.log(`file ids:   ${uploaded.map((u) => u.id).join(', ')}`);
  console.log(`wrote ${path.join(runDir, 'slack-post.json')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().catch((e) => { console.error(`error: ${e?.message || e}`); process.exit(1); });
