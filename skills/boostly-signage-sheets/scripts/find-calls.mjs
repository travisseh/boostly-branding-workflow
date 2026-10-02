#!/usr/bin/env node
// find-calls.mjs: find every AskElephant call for one Boostly location.
//
// Reproduces what was done by hand on 2026-09-03..05 (STATE.md: Fox's, Astoria,
// Munchie, 2 Guys, David's, Mara's): pull the CSM/rep call windows, then match
// by normalized business name in the title, contact and participant names,
// transcript speakers, contact email, website domain, and city. Meetings
// without a transcript are returned as "transcript pending", never dropped.
//
// Usage:
//   node find-calls.mjs --location-id <id> --out <run-dir> [--days 45] [--since YYYY-MM-DD]
//                       [--mode all|per-person] [--ae-cache <ae-dump.json>] [--no-cache]
//                       [--fetch-limit 1500] [--json] [--no-save]
//   node find-calls.mjs --name "Fox's Pizza Den" --city Chicora --contact "Dan Weidenhof" \
//                       --email nmenterprisellc1@gmail.com --domain foxspizza.com --out <dir>
//
// Writes <out>/call/find-calls.json and <out>/call/<date>-<meeting-id>.txt for
// every matched transcript (same layout the manual runs used). Reads only.
//
// --mode all (default): one `search_meetings.py --all` fetch of the window,
//   then the per-rep filter is applied locally. search_meetings.py's own
//   --person is a local filter over the same fetch, so this is equivalent to
//   running it once per rep and unioning, at one REST round trip instead of N.
// --mode per-person: literally runs search_meetings.py --person <rep email>
//   for every rep in KNOWN_REPS and unions the results (slow; for audits).

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadRequest } from './lib/v2-reads.mjs';

const execFileAsync = promisify(execFile);
export const AE_SEARCH = new URL('../../askelephant/scripts/search_meetings.py', import.meta.url).pathname;

// Boostly reps whose calls carry fulfillment facts. Owner on an AskElephant
// engagement is the AE account owner, not always the person who spoke:
// Sterling's calls are owned by "Evan" (evan.fuller@boostly.com), so speakers
// in the transcript are matched too. Add a rep here, nowhere else.
export const KNOWN_REPS = [
  { name: 'Jonathan Watkins', emails: ['jonathan.watkins@boostly.com'], aliases: ['Jonathan'], role: 'csm' },
  { name: 'James Lowder', emails: ['james.lowder@boostly.com', 'james@boostly.com'], aliases: ['James'], role: 'csm' },
  { name: 'Sterling Evans', emails: ['sterling.evans@boostly.com', 'sterling@boostly.com'], aliases: ['Sterling'], role: 'sales' },
  { name: 'Ella Van Horn', emails: ['ella.vanhorn@boostly.com', 'ella@boostly.com'], aliases: ['Ella', 'Ella Horn'], role: 'sales' },
  { name: 'Kole Minnoch', emails: ['kole.minnoch@boostly.com', 'kole@boostly.com'], aliases: ['Kole'], role: 'sales' },
  { name: 'Cooper Bucalo', emails: ['cooper.bucalo@boostly.com', 'cooper@boostly.com'], aliases: ['Cooper'], role: 'sales' },
  { name: 'Evan Fuller', emails: ['evan.fuller@boostly.com'], aliases: ['Evan'], role: 'sales', note: 'AE owner on Sterling demos' },
];

const GENERIC_EMAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'me.com', 'live.com', 'msn.com', 'comcast.net', 'boostly.com']);

// ---------------------------------------------------------------------------
// text normalization
export const NAME_STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'at', 'in', 'on', 'deli', 'pub', 'grille', 'grill', 'pizza', 'pizzeria', 'smokehouse', 'bar', 'restaurant', 'cafe', 'kitchen', 'house', 'company', 'co', 'llc', 'inc', 'bbq', 'bakery', 'diner', 'eatery', 'tavern', 'lounge', 'bistro', 'market', 'shop', 'food', 'foods', 'brewing', 'brewery', 'coffee', 'taproom', 'catering', 'cantina', 'taqueria', 'sushi', 'burger', 'burgers', 'subs', 'wings', 'chicken', 'den', 'factory', 'place', 'spot', 'joint', 'express', 'street', 'st']);
export const SPOKEN_VARIANTS = { kabob: ['kebab', 'kabab', 'kebob'], kebab: ['kabob'], tillie: ['tilly', 'tillies'], bbq: ['barbecue', 'barbeque'], guys: ['guy'], hutt: ['hut'], grille: ['grill'], munchie: ['munchies'], denise: ['denises'] };

export function normText(s) {
  return String(s || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// "Fox's Pizza Den (Chicora)" -> words [fox], variants [foxs], phrase "foxs pizza den"
export function nameTerms(locationName) {
  const base = String(locationName || '').replace(/\(([^)]*)\)/g, ' ');
  const raw = base.toLowerCase().replace(/[’`]/g, "'").split(/[^a-z0-9']+/).filter(Boolean);
  const terms = new Set();
  const variants = new Set();
  const weakWords = new Set(); // "Denise's", "Vito's": a person's first name is not distinctive alone
  for (const r of raw) {
    const possessive = /'s$/.test(r);
    const word = possessive ? r.slice(0, -2) : r.replace(/'/g, '');
    if (NAME_STOPWORDS.has(word) || word.length < 2) continue;
    terms.add(word);
    if (possessive) { variants.add(`${word}s`); weakWords.add(word); }
    for (const v of SPOKEN_VARIANTS[word] || []) variants.add(v);
    if (!possessive && word.endsWith('s') && word.length > 4) variants.add(word.slice(0, -1));
  }
  for (const t of terms) variants.delete(t);
  const phrase = normText(base).split(' ').filter((w) => !['the', 'a', 'an'].includes(w)).join(' ');
  return { words: [...terms], variants: [...variants], weak_words: [...weakWords], phrase };
}

export function cityOf(loc) {
  const m = (loc.name || '').match(/\(([^)]*)\)/);
  if (m) return m[1].trim();
  if (loc.shipping_city) return loc.shipping_city;
  const addr = loc.address || '';
  const am = addr.match(/,\s*([A-Za-z .'-]+),\s*[A-Z]{2}\b/);
  if (am) return am[1].trim();
  return null;
}

export function domainOf(url) {
  if (!url) return null;
  try {
    const host = new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch { return null; }
}

// Build the match context from a loadRequest() packet (or a manual one).
export function buildContext(req, manual = {}) {
  const location = req.location;
  const names = new Map();
  const add = (n, src) => {
    const clean = String(n || '').replace(/\s+/g, ' ').replace(/\b(III|II|IV|Jr\.?|Sr\.?)$/i, '').trim();
    if (clean.length < 2) return;
    const key = clean.toLowerCase();
    if (!names.has(key)) names.set(key, { name: clean, source: src });
  };
  for (const u of req.users || []) add(u.name, 'account user');
  for (const e of req.enrollments || []) {
    add(`${e.tfv_first_name || ''} ${e.tfv_last_name || ''}`, 'enrollment tfv contact');
    add(e.contract_signed_by, 'contract signer');
  }
  if (req.session?.recipient_names) for (const n of req.session.recipient_names.split(',')) add(n, 'onboarding shipping recipient');
  add(location.shipping_recipient_name, 'location shipping recipient');
  const notes = req.request?.notes || '';
  for (const m of notes.matchAll(/\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b/g)) {
    if (/^(New|Join|The|Ship|Send|Figma|Boostly|Please|They|Just|Tap|Box)$/.test(m[1])) continue;
    add(`${m[1]} ${m[2]}`, 'fulfillment notes');
  }
  for (const n of manual.contacts || []) add(n, 'argument');
  // the CSM is a rep, not a customer contact
  const csm = location.manager_name || manual.csm || null;
  if (csm) names.delete(csm.toLowerCase());

  const emails = new Set();
  for (const u of req.users || []) if (u.email) emails.add(u.email.toLowerCase());
  for (const e of req.enrollments || []) if (e.tfv_email) emails.add(e.tfv_email.toLowerCase());
  for (const e of manual.emails || []) emails.add(e.toLowerCase());
  for (const e of [...emails]) if (/@boostly\.com$/.test(e)) emails.delete(e);

  const domains = new Set();
  for (const d of [domainOf(location.website_url), ...(req.enrollments || []).map((e) => domainOf(e.tfv_business_website)), ...(manual.domains || [])]) {
    if (d && !GENERIC_EMAIL_DOMAINS.has(d)) domains.add(d);
  }
  for (const e of emails) { const d = e.split('@')[1]; if (d && !GENERIC_EMAIL_DOMAINS.has(d)) domains.add(d); }

  const cities = new Set();
  for (const c of [cityOf(location), ...(req.enrollments || []).map((e) => e.tfv_address_city), manual.city]) if (c && c.trim()) cities.add(c.trim());

  const businessNames = new Set([location.name]);
  for (const e of req.enrollments || []) { if (e.tfv_dba) businessNames.add(e.tfv_dba.trim()); }
  if (manual.name) businessNames.add(manual.name);

  return {
    location_id: location.id || null,
    account_id: location.account_id || null,
    business_names: [...businessNames],
    name: nameTerms([...businessNames][0]),
    name_phrases: [...new Set([...businessNames].map((n) => nameTerms(n).phrase).filter((p) => p.length >= 4))],
    cities: [...cities],
    contacts: [...names.values()],
    emails: [...emails],
    domains: [...domains],
    csm,
  };
}

// ---------------------------------------------------------------------------
// AskElephant fetch
export async function fetchAeWindow({ since, until, fetchLimit = 1500, cachePath, noCache = false, mode = 'all', reps = KNOWN_REPS }) {
  if (!noCache && cachePath) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (cached.window_start?.startsWith(since) && Array.isArray(cached.meetings)) return { data: cached, from_cache: true };
    } catch { /* no cache */ }
  }
  const run = async (scopeArgs, source) => {
    const args = [AE_SEARCH, ...scopeArgs, '--since', since, '--until', until, '--include-transcript', '--fetch-limit', String(fetchLimit), '--limit', String(fetchLimit), '--source', source];
    const { stdout } = await execFileAsync('python3', args, { maxBuffer: 512 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const runWithFallback = async (scopeArgs) => {
    try { const d = await run(scopeArgs, 'live'); d.source_used = 'live'; return d; } catch (err) {
      // reporting-DB mirror only as a fallback (shell DATABASE_URL may point elsewhere)
      const d = await run(scopeArgs, 'auto'); d.source_used = 'auto'; d.live_error = String(err.message || err).split('\n')[0]; return d;
    }
  };
  let data;
  if (mode === 'per-person') {
    const seen = new Map();
    let scanned = 0;
    const perPerson = [];
    for (const rep of reps) {
      const email = rep.emails[0];
      const d = await runWithFallback(['--person', email]);
      scanned = Math.max(scanned, d.scanned || 0);
      perPerson.push({ rep: rep.name, person: email, count: d.count });
      for (const m of d.meetings || []) if (m.id && !seen.has(m.id)) seen.set(m.id, m);
    }
    data = { auth_mode: 'per-person', source_status: 'union', scope: 'per-person', per_person: perPerson, window_start: since, window_end: until, scanned, count: seen.size, meetings: [...seen.values()] };
  } else {
    data = await runWithFallback(['--all']);
  }
  if (cachePath) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(data));
  }
  return { data, from_cache: false };
}

// ---------------------------------------------------------------------------
// transcript parsing
const LINE_RE = /^\[(\d+:\d\d:\d\d)\]\s*([^:]+?):\s*(.*)$/;
export function parseTranscript(text) {
  const lines = [];
  for (const raw of (text || '').split(/\n+/)) {
    const m = raw.trim().match(LINE_RE);
    if (m) lines.push({ t: m[1], speaker: m[2].trim(), text: m[3].trim() });
    else if (lines.length && raw.trim()) lines[lines.length - 1].text += ' ' + raw.trim();
  }
  // AskElephant sometimes emits the transcript twice back to back; keep the first copy
  if (lines.length >= 20) {
    const half = Math.floor(lines.length / 2);
    const same = lines.length % 2 === 0 && lines[0].t === lines[half].t && lines[0].text === lines[half].text && lines[half - 1].text === lines[lines.length - 1].text;
    if (same) return lines.slice(0, half);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// reps and classification
function repMatchesName(rep, name) {
  const n = normText(name);
  if (!n) return false;
  if (n === normText(rep.name)) return true;
  return (rep.aliases || []).some((a) => normText(a) === n);
}

export function repsOn(m, lines, reps = KNOWN_REPS) {
  const found = new Map();
  const mark = (rep, how) => { if (!found.has(rep.name)) found.set(rep.name, { name: rep.name, role: rep.role, via: how }); };
  const ownerName = m.owner ? `${m.owner.first_name || ''} ${m.owner.last_name || ''}`.trim() || m.owner.name || '' : '';
  const ownerEmails = (m.owner?.emails || []).map((e) => (typeof e === 'string' ? e : e.email || '')).map((e) => e.toLowerCase());
  for (const rep of reps) {
    if (ownerEmails.some((e) => rep.emails.includes(e)) || repMatchesName(rep, ownerName)) mark(rep, 'owner');
    if (m.host?.name && repMatchesName(rep, m.host.name)) mark(rep, 'host');
    for (const p of m.participants || []) {
      if ((p.email && rep.emails.includes(String(p.email).toLowerCase())) || repMatchesName(rep, p.name)) mark(rep, 'participant');
    }
  }
  const speakers = new Set((lines || []).map((l) => l.speaker));
  for (const s of speakers) for (const rep of reps) if (repMatchesName(rep, s)) mark(rep, 'speaker');
  return [...found.values()];
}

export const CLASS = { SALES: 'sales demo', LAUNCH: 'launch prep', SCHEDULING: 'scheduling', OTHER: 'other' };
const LAUNCH_TITLE_RE = /launch prep|onboarding|kick ?off|go[- ]live|training/i;
const SALES_TITLE_RE = /marketing meeting|\bdemo\b|discovery|pilot proposal|increase your orders|\+\s*boostly|follow[- ]?up/i;
const SCHEDULING_TITLE_RE = /unknown contact|voicemail|schedul|reminder|confirm/i;

export function classify(m, lines, reps) {
  const title = m.title || '';
  const tags = (m.tags || []).map((t) => String(t).toLowerCase());
  const dur = Number(m.duration_seconds) || 0;
  const lineCount = (lines || []).length;
  const ownerJob = m.owner?.job_title || '';
  if (LAUNCH_TITLE_RE.test(title)) return CLASS.LAUNCH;
  // short calls are scheduling/voicemail even when tagged Onboarding
  if (dur > 0 && dur < 600) return CLASS.SCHEDULING;
  if (lineCount > 0 && lineCount < 40 && dur < 900) return CLASS.SCHEDULING;
  if (tags.includes('onboarding')) return CLASS.LAUNCH;
  if (tags.includes('demo') || tags.includes('sales-followup') || SALES_TITLE_RE.test(title)) return CLASS.SALES;
  if (SCHEDULING_TITLE_RE.test(title)) return CLASS.SCHEDULING;
  const repRoles = (reps || []).map((r) => r.role);
  if (repRoles.includes('csm') && !repRoles.includes('sales')) return CLASS.LAUNCH;
  if (/sales/i.test(ownerJob) || repRoles.includes('sales')) return CLASS.SALES;
  return CLASS.OTHER;
}

// ---------------------------------------------------------------------------
// matching
export function matchMeeting(m, ctx, lines) {
  const reasons = [];
  let score = 0;
  let strong = false;
  const title = normText(m.title);
  const transcript = normText(m.transcript);
  const aeContacts = (m.contacts || []).map((c) => ({ name: normText(c.name), emails: (c.emails || []).map((e) => String(e).toLowerCase()) }));
  const aeParticipants = (m.participants || []).filter((p) => !p.is_user).map((p) => ({ name: normText(p.name), email: String(p.email || '').toLowerCase() }));
  const companies = (m.companies || []).map((c) => normText(typeof c === 'string' ? c : c?.name));
  const companyDomains = (m.companies || []).map((c) => String(typeof c === 'string' ? c : c?.name || '').toLowerCase()).filter((c) => /\.[a-z]{2,}$/.test(c));
  const speakers = new Set((lines || []).map((l) => normText(l.speaker)));

  // 1. contact email (strongest)
  for (const e of ctx.emails) {
    if (aeContacts.some((c) => c.emails.includes(e)) || aeParticipants.some((p) => p.email === e)) { score += 10; strong = true; reasons.push(`contact email ${e}`); }
  }
  // 2. website / email domain
  const allEmailDomains = new Set([...aeContacts.flatMap((c) => c.emails), ...aeParticipants.map((p) => p.email)].filter(Boolean).map((e) => e.split('@')[1]).filter(Boolean));
  for (const d of ctx.domains) {
    if (allEmailDomains.has(d) || companyDomains.includes(d)) { score += 6; strong = true; reasons.push(`domain ${d}`); }
  }
  // 3. contact names: AE contact / participant / speaker / title. A last name
  // alone ("Davis") is corroboration, never a match by itself.
  let lastNameHits = 0;
  for (const c of ctx.contacts) {
    const n = normText(c.name);
    const parts = n.split(' ').filter((p) => p.length >= 2);
    const full = parts.length >= 2 && parts.every((p) => p.length >= 3);
    const first = parts[0];
    const last = parts[parts.length - 1];
    const lastOk = full && last.length >= 4;
    if (aeContacts.some((x) => x.name === n) || aeParticipants.some((p) => p.name === n)) { score += 8; strong = true; reasons.push(`AE contact "${c.name}" (${c.source})`); }
    else if (lastOk && (aeContacts.some((x) => x.name.endsWith(` ${last}`)) || aeParticipants.some((p) => p.name.endsWith(` ${last}`)))) { score += 3; lastNameHits += 1; reasons.push(`AE contact last name "${last}" (${c.source})`); }
    if (speakers.has(n)) { score += 8; strong = true; reasons.push(`transcript speaker "${c.name}"`); }
    else if (lastOk && [...speakers].some((s) => s.endsWith(` ${last}`))) { score += 3; lastNameHits += 1; reasons.push(`transcript speaker last name "${last}"`); }
    if (!full) continue;
    if (new RegExp(`\\b${escapeRe(n)}\\b`).test(title)) { score += 8; strong = true; reasons.push(`title contains "${c.name}"`); }
    else if (lastOk && new RegExp(`\\b${escapeRe(last)}\\b`).test(title)) { score += 3; lastNameHits += 1; reasons.push(`title contains last name "${last}"`); }
    else if (first.length >= 4 && new RegExp(`\\bcall with ${escapeRe(first)}\\b|\\|\\s*${escapeRe(first)}\\b`).test(title)) { score += 3; reasons.push(`title first name "${first}"`); }
    if (transcript && new RegExp(`\\b${escapeRe(n)}\\b`).test(transcript)) { score += 4; reasons.push(`transcript mentions "${c.name}"`); }
  }
  // city (corroboration only)
  let cityHit = false;
  for (const city of ctx.cities) {
    const re = new RegExp(`\\b${escapeRe(normText(city))}\\b`);
    if (re.test(title)) { score += 2; cityHit = true; reasons.push(`title city "${city}"`); }
    else if (transcript && re.test(transcript)) { score += 1; cityHit = true; reasons.push(`transcript city "${city}"`); }
  }
  // 4. business name: phrase in title / company, words in title, words in transcript
  for (const phrase of ctx.name_phrases) {
    if (phrase.length < 4) continue;
    if (title.includes(phrase)) { score += 8; strong = true; reasons.push(`title has business name "${phrase}"`); }
    else if (companies.some((c) => c && (c.includes(phrase) || phrase.includes(c) && c.length >= 6))) { score += 6; strong = true; reasons.push(`AE company "${phrase}"`); }
    else if (transcript.includes(phrase)) { score += 6; strong = true; reasons.push(`transcript has business name "${phrase}"`); }
  }
  const titleWords = new Set();
  const transcriptWords = new Set();
  for (const w of [...ctx.name.words, ...ctx.name.variants]) {
    const isVariant = ctx.name.variants.includes(w);
    const re = new RegExp(`\\b${escapeRe(w)}(?:s)?\\b`, 'g');
    const inTitle = re.test(title);
    const n = transcript ? (transcript.match(re) || []).length : 0;
    if (inTitle) { score += isVariant ? 2 : 5; reasons.push(`title word "${w}"`); if (!isVariant) titleWords.add(w); }
    if (n > 0) { score += Math.min(4, n); reasons.push(`transcript word "${w}" x${n}`); if (!isVariant) transcriptWords.add(w); }
  }
  // one distinctive (>=6 chars) real word in the title, or two real words anywhere, is strong;
  // a lone short word, a spoken variant ("hut" for Hutt), or a possessive first
  // name ("Denise" from Denise's) is not (Pizza Hut, "Call with Denise Dixon")
  const weakWords = new Set(ctx.name.weak_words || []);
  const distinctTitle = [...titleWords].filter((w) => !weakWords.has(w));
  const distinctTranscript = [...transcriptWords].filter((w) => !weakWords.has(w));
  if (titleWords.size >= 2 || transcriptWords.size >= 2 || distinctTitle.some((w) => w.length >= 6)) strong = true;
  if (!strong && lastNameHits && (distinctTitle.length || distinctTranscript.length || cityHit)) strong = true;
  // 5. chain / sibling guard: a name-only match whose external contacts are all
  // someone else (other emails, none of ours) is a different store of the same
  // brand (Fox's Pizza Den Robinson vs Chicora). Keep it listed, not matched.
  const identityHit = reasons.some((r) => /^contact email|^domain|^AE contact "|^transcript speaker "|^title contains "/.test(r));
  const foreignEmails = [...allEmailDomains].length > 0 && ctx.emails.length > 0 && !identityHit;
  const otherCity = /\(([^)]+)\)\s*$/.exec(m.title || '')?.[1];
  const cityConflict = otherCity && ctx.cities.length && !ctx.cities.some((c) => normText(c) === normText(otherCity)) && !/boostly/i.test(otherCity);
  let sibling = false;
  if (strong && !identityHit && (foreignEmails || cityConflict)) { strong = false; sibling = true; reasons.push(`same brand, different contact${cityConflict ? ` (${otherCity})` : ''}: not this location`); }
  // group sessions (webinars) list many contacts; they are not this account's call
  const dedupedReasons = [...new Set(reasons)]; reasons.length = 0; reasons.push(...dedupedReasons);
  const group = aeContacts.length > 5 || /increase your orders|webinar|workshop|office hours|\(boostly\)\s*$/i.test(m.title || '');
  if (group) reasons.push(`group session${aeContacts.length > 5 ? ` (${aeContacts.length} contacts)` : ''}: listed, not used for facts`);
  return { score, reasons, strong: score >= 5 && strong && !group, group, sibling };
}

// ---------------------------------------------------------------------------
export function transcriptStatus(m, lines) {
  const text = (m.transcript || '').trim();
  if (!text) return 'pending';
  if (lines.length < 6) return 'short';
  return 'ok';
}

export async function findCalls({ ctx, since, until, fetchLimit = 1500, cachePath, noCache = false, mode = 'all', reps = KNOWN_REPS }) {
  const { data: ae, from_cache } = await fetchAeWindow({ since, until, fetchLimit, cachePath, noCache, mode, reps });
  const staff = new Set();
  for (const m of ae.meetings || []) {
    if (m.owner?.first_name) staff.add(normText(`${m.owner.first_name} ${m.owner.last_name || ''}`));
    if (m.host?.name) staff.add(normText(m.host.name));
    for (const p of m.participants || []) if (p.is_user && p.name) staff.add(normText(p.name));
  }
  for (const r of reps) { staff.add(normText(r.name)); for (const a of r.aliases || []) staff.add(normText(a)); }

  const matches = [];
  const weak = [];
  const groups = [];
  const siblings = [];
  const seen = new Set();
  const seenTranscripts = new Set();
  for (const m of ae.meetings || []) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const tkey = (m.transcript || '').trim().slice(0, 4000);
    if (tkey.length > 200) { if (seenTranscripts.has(tkey)) continue; seenTranscripts.add(tkey); }
    const lines = parseTranscript(m.transcript);
    const match = matchMeeting(m, ctx, lines);
    if (!match.score) continue;
    const onCall = repsOn(m, lines, reps);
    const date = (m.start_at || '').slice(0, 10);
    const entry = {
      id: m.id, url: m.url, title: m.title, date, start_at: m.start_at,
      duration_seconds: m.duration_seconds || 0, duration_min: Math.round((m.duration_seconds || 0) / 60),
      has_transcript: !!(m.transcript || '').trim(), transcript_status: transcriptStatus(m, lines), transcript_lines: lines.length,
      classification: classify(m, lines, onCall),
      reps: onCall.map((r) => r.name), rep_detail: onCall,
      rep_known: onCall.length > 0,
      owner: m.owner ? `${m.owner.first_name || ''} ${m.owner.last_name || ''}`.trim() || m.owner.name || null : null,
      contacts: (m.contacts || []).map((c) => c.name).filter(Boolean),
      contact_emails: (m.contacts || []).flatMap((c) => c.emails || []),
      participants: (m.participants || []).map((p) => p.name).filter(Boolean),
      tags: m.tags || [],
      match,
    };
    if (!match.strong) { (match.group ? groups : match.sibling ? siblings : weak).push({ id: m.id, title: m.title, date, score: match.score, reasons: match.reasons }); continue; }
    entry.internal = [...new Set(lines.map((l) => l.speaker).filter((s) => staff.has(normText(s))))];
    entry.lines = lines;
    matches.push(entry);
  }
  matches.sort((a, b) => (a.start_at || '').localeCompare(b.start_at || ''));
  weak.sort((a, b) => b.score - a.score);
  return {
    matches, weak, groups, siblings,
    ae: { since, until, scanned: ae.scanned, mode, source: ae.auth_mode, source_status: ae.source_status, source_used: ae.source_used, from_cache, per_person: ae.per_person || null, live_error: ae.live_error || null },
    reps_searched: reps.map((r) => r.name),
  };
}

export async function saveTranscripts(matches, outDir) {
  const callDir = path.join(outDir, 'call');
  await fs.mkdir(callDir, { recursive: true });
  const saved = [];
  for (const m of matches) {
    if (!m.has_transcript) continue;
    const file = path.join(callDir, `${m.date}-${m.id}.txt`);
    const body = m.lines.map((l) => `[${l.t}] ${l.speaker}: ${l.text}`).join('\n\n') + '\n';
    await fs.writeFile(file, body);
    m.transcript_file = file;
    saved.push(file);
  }
  return { callDir, saved };
}

export function summaryLine(m) {
  const who = m.reps.length ? m.reps.map((r) => r.split(' ')[0]).join('+') : (m.owner || 'unknown rep');
  const ts = m.transcript_status === 'ok' ? '' : m.transcript_status === 'pending' ? ', transcript pending' : ', transcript short';
  return `${m.date} ${m.classification} (${who}, ${m.duration_min} min${ts}) "${m.title}" ${m.id}`;
}

export function mdReport(result, ctx) {
  const L = [];
  L.push(`# Calls: ${ctx.business_names[0]}${ctx.location_id ? ` (${ctx.location_id})` : ''}`);
  L.push(`Searched ${result.ae.scanned} meetings since ${result.ae.since} (${result.ae.mode}, ${result.ae.source_status}${result.ae.from_cache ? ', cached' : ''}); reps: ${result.reps_searched.join(', ')}`);
  L.push(`Match keys: names ${ctx.business_names.join(' | ')}; contacts ${ctx.contacts.map((c) => c.name).join(', ') || '-'}; emails ${ctx.emails.length}; domains ${ctx.domains.join(', ') || '-'}; cities ${ctx.cities.join(', ') || '-'}`);
  L.push('');
  L.push(`## Matched (${result.matches.length})`);
  for (const m of result.matches) {
    L.push(`- ${summaryLine(m)}${m.rep_known ? '' : ' [no known rep on this call]'}`);
    L.push(`    match: ${m.match.reasons.join('; ')} (score ${m.match.score})`);
    if (m.transcript_file) L.push(`    transcript: ${m.transcript_file}`);
  }
  if (!result.matches.length) L.push('- none');
  const listed = (label, arr) => { if (arr.length) { L.push(''); L.push(`## ${label}: ${arr.slice(0, 8).map((w) => `${w.date} "${w.title}" (${w.id}, ${w.reasons.join('; ')})`).join('; ')}`); } };
  listed('Same brand, other location (not used)', result.siblings);
  listed('Group sessions (not used)', result.groups);
  listed('Weak candidates (not used)', result.weak);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { json: false, noCache: false, noSave: false, contacts: [], emails: [], domains: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['json', 'noCache', 'noSave'].includes(name)) { args[name] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    i += 1;
    if (name === 'contact') args.contacts.push(value);
    else if (name === 'email') args.emails.push(value);
    else if (name === 'domain') args.domains.push(value);
    else args[name] = value;
  }
  if (!args.locationId && !args.name) throw new Error('--location-id or --name is required');
  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error('--since must be YYYY-MM-DD');
  args.days = args.days ? Number(args.days) : 45;
  args.fetchLimit = args.fetchLimit ? Number(args.fetchLimit) : 1500;
  args.mode = args.mode || 'all';
  if (!['all', 'per-person'].includes(args.mode)) throw new Error('--mode must be all or per-person');
  args.out = path.resolve(args.out || `find-calls-${args.locationId || normText(args.name).replace(/ /g, '-')}`);
  return args;
}

export async function resolveContext(args) {
  if (args.locationId) {
    const req = await loadRequest(args.locationId);
    return { req, ctx: buildContext(req, { contacts: args.contacts, emails: args.emails, domains: args.domains, city: args.city, csm: args.csm }) };
  }
  const req = { location: { id: null, name: args.name, account_id: null, website_url: args.domains[0] ? `https://${args.domains[0]}` : null, shipping_city: args.city || null, manager_name: args.csm || null }, users: [], enrollments: [], session: null, request: null, siblings: [] };
  return { req, ctx: buildContext(req, { contacts: args.contacts, emails: args.emails, domains: args.domains, city: args.city, csm: args.csm }) };
}

export function windowFor(args, req) {
  const anchor = req.request?.created_at ? new Date(req.request.created_at) : new Date();
  const since = args.since || new Date(anchor.getTime() - args.days * 86400000).toISOString().slice(0, 10);
  const until = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return { since, until };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { req, ctx } = await resolveContext(args);
  const { since, until } = windowFor(args, req);
  await fs.mkdir(path.join(args.out, 'call'), { recursive: true });
  // same cache file preflight.mjs uses, so a preflight rerun reuses the window
  const cachePath = args.aeCache ? path.resolve(args.aeCache) : path.join(args.out, 'preflight', 'ae-dump.json');
  const result = await findCalls({ ctx, since, until, fetchLimit: args.fetchLimit, cachePath, noCache: args.noCache, mode: args.mode });
  if (!args.noSave) await saveTranscripts(result.matches, args.out);
  const out = {
    generated_at: new Date().toISOString(),
    context: ctx,
    ae: result.ae,
    reps_searched: result.reps_searched,
    matches: result.matches.map(({ lines, ...m }) => ({ ...m, transcript_lines: lines?.length || 0 })),
    weak_candidates: result.weak,
    sibling_brand_calls: result.siblings,
    group_sessions: result.groups,
    transcript_pending: result.matches.filter((m) => m.transcript_status === 'pending').map((m) => m.id),
  };
  const jsonPath = path.join(args.out, 'call', 'find-calls.json');
  await fs.writeFile(jsonPath, JSON.stringify(out, null, 2));
  const md = mdReport(result, ctx);
  await fs.writeFile(path.join(args.out, 'call', 'find-calls.md'), md + '\n');
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else { console.log(md); console.log(`\nWritten: ${jsonPath}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}
