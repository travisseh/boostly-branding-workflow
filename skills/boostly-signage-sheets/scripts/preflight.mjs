#!/usr/bin/env node
// preflight.mjs: mandatory audit BEFORE branding and plan.mjs for a Boostly fulfillment.
//
// Compares three sources for one location and flags disagreements:
//   1. the fulfillment request (offer_text, wizard quantities, notes),
//   2. what the system actually pays (SUBSCRIBE_ keyword -> promotion, invite
//      campaign template -> promotion, all promotions on the account),
//   3. what the customer said on AskElephant calls (verbatim lines).
//
// Usage:
//   node preflight.mjs --location-id <id> --run-dir <run-dir>
//                      [--since YYYY-MM-DD] [--days 45] [--json] [--fetch-limit N] [--no-cache]
//                      [--llm] [--llm-model fable] [--out <dir>]
//
// Writes <run-dir>/preflight/preflight.json + preflight.md, and through
// find-calls.mjs / call-facts.mjs also <run-dir>/call/find-calls.json,
// <run-dir>/call/<date>-<meeting-id>.txt (every matched transcript),
// <run-dir>/call/call-facts.json + call-facts.md (the fixed "Call facts" block).
// `--out` alone (legacy) puts preflight files there and call files next to it.
//
// Data access: read-only SQL through the v2-database skill's `v2-db query`
// wrapper (lib/v2-reads.mjs; credentials come from its own env file and are
// never printed here). Calls come from the askelephant skill's
// search_meetings.py via find-calls.mjs (REST/DB creds likewise stay inside it).
//
// Lessons baked in (2026-09-03..08 audits, STATE.md):
//   - AskElephant titles are often "Call with <person>", and the query matches
//     transcript WORDS, so match by restaurant name, contact names, transcript
//     speakers, contact email, website domain, and city (find-calls.mjs).
//     Tillie's, 2 Guys, David's, Mara's were all missed by title-only search.
//   - A matched call with no transcript yet is TRANSCRIPT_PENDING, not NO_CALL.
//     Rerun later; the transcript usually lands within a day.
//   - Call quantities beat wizard quantities (Tillie's: 10 tables said on the
//     call vs 20 in the wizard; Fahrenheit: "none for the tables"). Wizard
//     defaults (10/6/10) that no call confirms are QUANTITIES_UNCONFIRMED.
//   - A sign that names a discount the signup keyword does not pay is a print
//     blocker (Butt Hutt "$10 OFF" vs keyword "20% OFF"; Fox's 25% vs 20%).
//     OFFER_MISMATCH carries the exact `boostly-links offer set` command.
//     Nothing is auto-applied here; the orchestrator decides.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRequest, loadOffers, parseOffer, sameOffer, findPromotionFor, isGenericOffer, parseNumberToken, NUMBER_WORD_RE, offerSetCommand } from './lib/v2-reads.mjs';
import { buildContext, findCalls, saveTranscripts, windowFor, summaryLine } from './find-calls.mjs';
import { extractFacts, llmPass, mergeLlm, compareFacts, callFactsBlock } from './call-facts.mjs';

// ---------------------------------------------------------------------------
// args
function parseArgs(argv) {
  const args = { json: false, noCache: false, llm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (name === 'json' || name === 'noCache' || name === 'llm') { args[name] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    i += 1;
    args[name] = value;
  }
  if (!args.locationId) throw new Error('--location-id is required');
  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error('--since must be YYYY-MM-DD');
  if (args.runDir) {
    args.runDir = path.resolve(args.runDir);
    args.out = path.resolve(args.out || path.join(args.runDir, 'preflight'));
  } else {
    args.out = path.resolve(args.out || `preflight-${args.locationId}`);
    args.runDir = path.basename(args.out) === 'preflight' ? path.dirname(args.out) : args.out;
  }
  args.fetchLimit = args.fetchLimit ? Number(args.fetchLimit) : 3000;
  args.days = args.days ? Number(args.days) : 45;
  args.llmModel = args.llmModel || 'fable';
  return args;
}

// ---------------------------------------------------------------------------
// Copy plan.mjs specificOfferCopy() would produce (kept in sync by hand; the
// single implementation lives in plan.mjs, this is a preview for the report).
const DEFAULT_COPY = {
  tablePromo: { title: 'Join the club!', body: 'Be the first to know.\nReceive exclusive deals.' },
  pop: { title: 'Join the club!', body: 'Scan to join our VIP text club\nfor ongoing offers!' },
};
function previewOfferCopy(offer) {
  if (isGenericOffer(offer)) return { mode: 'default', ...DEFAULT_COPY };
  const isDiscount = /^\$?\d+(\.\d+)?\s*%?\s*off\b/i.test(offer) || /^free\b/i.test(offer);
  if (!isDiscount) {
    const reviewPhrase = /let us know|review|good time/i.test(offer);
    if (reviewPhrase) return { mode: 'review-phrase (POP only)', tablePromo: DEFAULT_COPY.tablePromo, pop: { ...DEFAULT_COPY.pop, title: offer } };
    return { mode: 'phrase', tablePromo: { title: offer, body: DEFAULT_COPY.pop.body, layout: 'phrase' }, pop: { ...DEFAULT_COPY.pop, title: offer } };
  }
  const title = 'Get ' + offer.replace(/\bOFF\b/g, 'Off').replace(/\s+/g, ' ').trim();
  return { mode: 'discount', tablePromo: { ...DEFAULT_COPY.tablePromo, title }, pop: { title, body: 'Scan to join our text club\nfor ongoing offers!' } };
}

// ---------------------------------------------------------------------------
// topic lines for the report
const TOPIC_RE = /\boffer\b|\bdiscount\b|%\s*off|\$\s*\d+\s*off|\bfree\s|\bbogo\b|\binvite\b|\blaunch text\b|\bjoin the club\b|\bsticker|\bsignage\b|\btables?\b|\btents?\b|\bcadd(?:y|ies)\b|\bpostcards?\b|\bstalls?\b|\bbathrooms?\b|\bmirrors?\b|\btap ?cards?\b|\bhow many\b|\bquantity\b|\bwording\b|\bsay on\b|\d+\s*percent\b/i;

const MAX_LINE_CHARS = 320;
function clip(text) {
  return text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS - 3).trimEnd() + '...' : text;
}

// All topic lines, deduped by timestamp+text (AE sometimes emits the same line
// under two speaker spellings, e.g. "Ella Van Horn" / "Ella Horn"). Used for flags.
function extractLines(lines) {
  const out = [];
  const seen = new Set();
  lines.forEach((l, i) => {
    if (!TOPIC_RE.test(l.text)) return;
    const key = `${l.t}|${l.text.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...l, i });
  });
  return out;
}

const SALES_TITLE_RE = /marketing meeting|\bdemo\b|increase your orders|pilot proposal|discovery/i;
const SALES_JOB_RE = /sales|account executive|\bae\b|sdr|bdr|business development|growth/i;
const CORE_TOPIC_RE = /\boffer\b|\bdiscount\b|%\s*off|\$\s*\d+\s*off|\d+\s*percent\b|\bfree\s|\btables?\b|\bsticker/i;

// Display subset for the report: customer lines first, staff lines only when
// within 2 transcript lines of a customer line or carrying an agreement
// phrase, 40 per call; sales/demo calls keep only offer/table/sticker lines, 10.
function displayLines(all, lines, internal, isSales) {
  const customerIdx = lines.map((l, i) => (internal.has(l.speaker) ? -1 : i)).filter((i) => i >= 0);
  const nearCustomer = (i) => customerIdx.some((c) => Math.abs(c - i) <= 2);
  let pool = all;
  let cap = 40;
  if (isSales) { pool = all.filter((l) => CORE_TOPIC_RE.test(l.text)); cap = 10; }
  const customer = pool.filter((l) => !internal.has(l.speaker));
  const staff = pool.filter((l) => internal.has(l.speaker) && (AGREE_RE.test(l.text) || nearCustomer(l.i)));
  const picked = [...customer.slice(0, cap), ...staff.slice(0, Math.max(0, cap - Math.min(customer.length, cap)))];
  return picked.sort((a, b) => a.i - b.i).map(({ i, ...l }) => ({ ...l, text: clip(l.text) }));
}

// ---------------------------------------------------------------------------
// flags
const COPY_REJECT_RE = /not (?:be )?join(?:ing)? the club|don'?t (?:feel like|want to|wanna|like) join(?:ing)?|sounds like a bigger thing|cheapen(?:s|ing)? the brand|older clientele|not (?:really )?a club|don'?t (?:like|love) (?:the )?(?:word |phrase |term )?["“]?club|instead of (?:["“]?join the club|club)|(?:rather|instead) (?:say|have|put|call it|go with) (?!["“]?join the club)|(?:let'?s|we'?ll|i'?d|we'?d|could we|can we) (?:just )?(?:go with|call it|use) ["“]?(?!join the club)[^"”]{3,60}?(?:offers?|deals?|specials?|perks|rewards|club)/i;
const NO_TABLE_RE = /(?:don'?t|do not|not) (?:want|need) (?:any )?(?:stickers? )?(?:on|for) (?:the |our )?tables|none? for the tables|not for the tables|move (?:our|the) tables|no table stickers|nothing on the tables|don'?t think we want any for the tables|skip the tables/i;
const BATHROOM_CONCERN_RE = /shared bathroom|public bathroom|communal bathroom|\bgross\b|start with the tables|hold off on the bathroom|not (?:the |our )?bathrooms?|bathroom (?:is|are) (?:shared|public|not ours)/i;
const AGREE_RE = /\b(?:go with|roll with|let'?s do|we'?ll do|let'?s go with|let'?s just do|that works|sounds good|i like that|yeah,? let'?s|we can do|keep it at|stick with|is (?:really )?perfect|we want(?: to do)?|we'?d like(?: to do)?|i want(?: to do)?|i'?d like(?: to do)?|we'?re (?:gonna|going to) do|put (?:it )?(?:down )?(?:as|at)|let'?s say)\b/i;
const PRICING_RE = /per month|a month\b|setup fee|set-up fee|payment|agreement|annually|invoice|contract|pricing|enrollment link|12 months|twelve months|per location|locations with us|average ticket|off of \d/i;
const EXAMPLE_RE = /\bexample\b|\bfor instance\b|\brotation\b|\brotate\b|\bbirthday\b|\bconsolation\b|\bgrand prize\b|\blottery\b|\bgame\b|\bgamif|\bwebinar\b|\bsome people\b|\bother(?:s| people| restaurants)\b|\btypically\b|\bhistorically\b|\bwe recommend\b|\bno lower than\b|\bcould do\b|\bcould be\b|\bwhatever it might be\b|\blike,? (?:a )?free\b|\bsuch as\b/i;
const OFFER_CONTEXT_RE = /\boffer|discount|invite|sign ?up|join|club|welcome|coupon|first (?:text|message)|opt[- ]?in|scan/i;

function numbersNear(text, nounRe) {
  const out = [];
  const re = new RegExp(`\\b(\\d{1,3}|${NUMBER_WORD_RE})\\b(?:\\s+\\w+){0,2}?\\s+(?:${nounRe})\\b`, 'gi');
  for (const m of text.matchAll(re)) {
    const n = parseNumberToken(m[1]);
    if (n !== null && n > 0 && n <= 200) out.push(n);
  }
  return out;
}

function totalsIn(text) {
  const out = [];
  const re = new RegExp(`\\b(?:that'?s|so that'?s|total(?: of)?|about|around|roughly|probably|maybe|we have|we'?ve got|there(?:'s| are| is))\\s+(?:like\\s+)?(\\d{1,3}|${NUMBER_WORD_RE})\\b\\s*(?:tables?\\b|total\\b|of them\\b|or so\\b|not including\\b|inside\\b|outside\\b|,|\\.|$)`, 'gi');
  for (const m of text.matchAll(re)) {
    const n = parseNumberToken(m[1]);
    if (n !== null && n > 0 && n <= 200) out.push(n);
  }
  return out;
}

function offersInLine(text) {
  const found = [];
  for (const m of text.matchAll(/(\d{1,2})\s*(?:%|percent)/gi)) found.push({ kind: 'pct', amount: Number(m[1]) });
  for (const m of text.matchAll(/\$\s*(\d{1,3})(?:\s*(?:off|dollars?\s*off))?/gi)) found.push({ kind: 'dollar', amount: Number(m[1]) });
  for (const m of text.matchAll(/\b(\d{1,3})\s*(?:dollars?|bucks)\s*off\b/gi)) found.push({ kind: 'dollar', amount: Number(m[1]) });
  for (const m of text.matchAll(/\bfree\s+([a-z]+(?:\s+[a-z]+)?)/gi)) {
    const item = m[1].toLowerCase();
    if (!/^(to|of|for|and|the|up|on|in|with|from|text|texting|trial|shipping|month|box)\b/.test(item)) found.push({ kind: 'free', item });
  }
  return found;
}

function computeFlags(ctx) {
  const { request, quantities, offers, calls, siblings } = ctx;
  const flags = [];
  const push = (code, summary, evidence) => flags.push({ code, summary, evidence: evidence || [] });
  const ev = (call, l) => `${call.date} ${call.title} [${l.t}] ${l.speaker}: ${clip(l.text)}`;

  const requestOffer = parseOffer(request?.offer_text);
  const keywordOffer = parseOffer(offers.signup_keyword?.title);
  const promoTitles = offers.promotions.map((p) => p.title);

  // ---- calls: collect agreed offers, table counts, stall counts, rejections
  const agreedOffers = [];   // {offer, line, call}
  const tableCounts = [];    // {n, line, call}
  const noTables = [];
  const stallCounts = [];
  const bathroomConcerns = [];
  const copyRejected = [];
  for (const call of calls) {
    for (const l of call.all_lines) {
      const text = l.text;
      if (COPY_REJECT_RE.test(text) && /club|wording|brand|offers?|specials?|deals?/i.test(text) && !call.internal.has(l.speaker)) copyRejected.push({ call, l });
      if (NO_TABLE_RE.test(text)) noTables.push({ call, l });
      if (/\btables?\b/i.test(text)) {
        const near = numbersNear(text, 'tables?|tops|table stickers?');
        const totals = totalsIn(text);
        // "three big ones, two long ones... so that's ten" -> the total wins
        if (totals.length) tableCounts.push({ n: totals[totals.length - 1], call, l, total: true });
        else if (near.length) tableCounts.push({ n: Math.max(...near), call, l, total: false });
      }
      {
        const stalls = numbersNear(text, 'stalls?|bathroom stalls?');
        const rooms = stalls.length ? [] : numbersNear(text, 'bathrooms?|restrooms?');
        if (stalls.length) stallCounts.push({ n: Math.max(...stalls), call, l, noun: 'stalls' });
        else if (rooms.length && /stall|sticker|mirror/i.test(text)) stallCounts.push({ n: Math.max(...rooms), call, l, noun: 'bathrooms' });
      }
      if (BATHROOM_CONCERN_RE.test(text) && /bathroom|restroom|stall|tables/i.test(text)) bathroomConcerns.push({ call, l });
      if ((OFFER_CONTEXT_RE.test(text) || AGREE_RE.test(text)) && !EXAMPLE_RE.test(text) && !PRICING_RE.test(text)) {
        const found = offersInLine(text).filter((o) => !(o.kind === 'dollar' && (o.amount > 100 || o.amount < 2)) && !(o.kind === 'pct' && (o.amount > 60 || o.amount < 5)));
        const internal = call.internal.has(l.speaker);
        // customer stating an amount in offer context counts; a Boostly rep only
        // counts when the line carries an agreement phrase ("we'll roll with 20%")
        if (found.length && (AGREE_RE.test(text) || !internal)) {
          for (const o of found) agreedOffers.push({ offer: o, call, l, by: internal ? 'boostly' : 'customer', agreed: AGREE_RE.test(text) || !internal });
        }
      }
    }
  }

  // ---- NO_CALL (matched calls with no transcript are TRANSCRIPT_PENDING, emitted by call-facts)
  if (!calls.length && !ctx.anyMatches) push('NO_CALL', 'No AskElephant call matched this location in the search window.', [`window since ${ctx.since}; searched: ${ctx.searchTerms.filter((t) => !t.includes('@')).join(', ')}${ctx.searchTerms.some((t) => t.includes('@')) ? ' + contact emails' : ''}`]);

  // ---- OFFER_MISMATCH: request vs keyword
  if (requestOffer && requestOffer.kind !== 'phrase' && keywordOffer && !sameOffer(requestOffer, keywordOffer)) {
    push('OFFER_MISMATCH', `Request offer_text "${request.offer_text}" but the signup keyword ${offers.signup_keyword.keyword} pays "${offers.signup_keyword.title}".`,
      [`keyword ${offers.signup_keyword.keyword} -> promotion ${offers.signup_keyword.promotion_id} "${offers.signup_keyword.title}"`, `promotions on account: ${promoTitles.join(' | ') || '(none)'}`]);
  }
  // ---- OFFER_MISMATCH / INVITE_NOT_LOADED: call agreed offer with no promotion
  const SIGNUP_RE = /sign ?up|signup|join|scan|qr|sticker|sign\b|welcome|opt[- ]?in|first (?:text|offer)|invite|launch/i;
  const rank = (a) => (a.by === 'customer' ? 0 : 2) + (SIGNUP_RE.test(a.l.text) ? 0 : 1) + (a.agreed ? 0 : 0.5);
  const agreedDistinct = [];
  for (const a of [...agreedOffers].sort((x, y) => rank(x) - rank(y))) {
    if (!a.agreed && a.by !== 'customer') continue;
    if (!agreedDistinct.some((x) => sameOffer(x.offer, a.offer))) agreedDistinct.push(a);
  }
  const unloaded = agreedDistinct.filter((a) => !findPromotionFor(a.offer, offers.promotions));
  if (unloaded.length) {
    const describe = (o) => (o.kind === 'pct' ? `${o.amount}%` : o.kind === 'dollar' ? `$${o.amount}` : `free ${o.item}`);
    const inviteish = unloaded.filter((a) => SIGNUP_RE.test(a.l.text) || a.offer.kind !== 'free');
    push('INVITE_NOT_LOADED', `Call mentions ${unloaded.map((a) => describe(a.offer)).join(', ')} as an offer but no promotion with that value exists on the account (promotions: ${promoTitles.join(' | ') || 'none'}).`,
      unloaded.slice(0, 6).map((a) => ev(a.call, a.l)));
    if (!flags.some((f) => f.code === 'OFFER_MISMATCH') && inviteish.length) {
      push('OFFER_MISMATCH', `Call shows an offer (${inviteish.map((a) => describe(a.offer)).join(', ')}) that the signup keyword does not pay ("${offers.signup_keyword?.title || 'none'}").`, inviteish.slice(0, 4).map((a) => ev(a.call, a.l)));
    }
  }

  // ---- COPY_REJECTED
  if (copyRejected.length) push('COPY_REJECTED', 'Customer pushed back on "Join the club" wording or chose other wording on a call.', copyRejected.slice(0, 6).map((x) => ev(x.call, x.l)));

  // ---- GENERIC_DEFAULT
  if (isGenericOffer(request?.offer_text) && agreedDistinct.length) {
    const describe = (o) => (o.kind === 'pct' ? `${o.amount}% Off` : o.kind === 'dollar' ? `$${o.amount} Off` : `Free ${o.item}`);
    push('GENERIC_DEFAULT', `Request offer_text is ${request?.offer_text ? `"${request.offer_text}"` : 'empty'} but a call shows a specific offer (${agreedDistinct.map((a) => describe(a.offer)).join(', ')}); a specific "Get X" headline is possible.`,
      agreedDistinct.slice(0, 4).map((a) => ev(a.call, a.l)));
  }

  // ---- TABLES_MISMATCH
  const tableMismatch = tableCounts.filter((t) => t.n !== quantities.tables);
  if (noTables.length || tableMismatch.length) {
    const evs = [...noTables.map((x) => ev(x.call, x.l)), ...tableMismatch.map((x) => ev(x.call, x.l))].slice(0, 8);
    const said = noTables.length ? 'the customer does not want table stickers' : `call gives ${[...new Set(tableMismatch.map((t) => t.n))].join('/')} tables`;
    push('TABLES_MISMATCH', `Request has ${quantities.tables} table stickers but ${said}.`, evs);
  }

  // ---- BATHROOM_CONCERN
  const stallMismatch = stallCounts.filter((s) => s.n !== quantities.stalls);
  if (bathroomConcerns.length || stallMismatch.length) {
    const evs = [...bathroomConcerns.map((x) => ev(x.call, x.l)), ...stallMismatch.map((x) => ev(x.call, x.l))].slice(0, 8);
    const said = bathroomConcerns.length ? 'call raises a bathroom concern (shared/public/gross/start with tables)' : `call gives ${[...new Set(stallMismatch.map((s) => s.n))].join('/')} stalls`;
    push('BATHROOM_CONCERN', `Request has ${quantities.stalls} bathroom stalls but ${said}.`, evs);
  }

  // ---- MULTI_LOCATION
  const fulfilledSiblings = siblings.filter((s) => Number(s.prior_fulfillments) > 0);
  if (fulfilledSiblings.length) push('MULTI_LOCATION', `Account has ${fulfilledSiblings.length} sibling location(s) with prior fulfillments; inherit branding and match the existing signage set.`, fulfilledSiblings.map((s) => `${s.name} (${s.id}) prior_fulfillments=${s.prior_fulfillments}`));

  const callSignals = {
    agreed_offers: agreedDistinct.map((a) => ({ offer: a.offer, by: a.by, agreed: a.agreed, evidence: ev(a.call, a.l) })),
    table_counts: tableCounts.map((t) => ({ n: t.n, total: t.total, evidence: ev(t.call, t.l) })),
    no_table_stickers: noTables.map((x) => ev(x.call, x.l)),
    stall_counts: stallCounts.map((s) => ({ n: s.n, noun: s.noun, evidence: ev(s.call, s.l) })),
    bathroom_concerns: bathroomConcerns.map((x) => ev(x.call, x.l)),
  };
  return { flags, callSignals };
}

function buildRecommendation(ctx, flags, signals) {
  const { request, quantities, offers } = ctx;
  const codes = new Set(flags.map((f) => f.code));
  const notes = [];

  // quantities: call beats wizard
  let tables = quantities.tables;
  if (signals.no_table_stickers.length) { tables = 0; notes.push('tables=0: customer said no table stickers on the call (call quantities beat wizard quantities)'); }
  else if (signals.table_counts.length) {
    const totals = signals.table_counts.filter((t) => t.total);
    const pick = (totals.length ? totals : signals.table_counts).slice(-1)[0].n;
    if (pick !== quantities.tables) { tables = pick; notes.push(`tables=${pick} from the call (wizard said ${quantities.tables}); confirm with the CSM`); }
  }
  let stalls = quantities.stalls;
  if (signals.stall_counts.length) {
    const exact = signals.stall_counts.filter((s) => s.noun === 'stalls');
    const pick = (exact.length ? exact : signals.stall_counts).slice(-1)[0].n;
    if (pick !== quantities.stalls) { stalls = pick; notes.push(`stalls=${pick} from the call (wizard said ${quantities.stalls}); confirm with the CSM`); }
  }
  if (signals.bathroom_concerns.length && !signals.stall_counts.length) notes.push('bathroom concern on the call: consider building bathroom sheets only after the CSM confirms');

  // offer
  let offer = (request?.offer_text || '').trim();
  const describe = (o) => (o.kind === 'pct' ? `${o.amount}% Off` : o.kind === 'dollar' ? `$${o.amount} Off` : `Free ${o.item}`);
  if (codes.has('GENERIC_DEFAULT') && signals.agreed_offers.length) {
    const a = signals.agreed_offers[0];
    notes.push(`offer: request says ${offer ? `"${offer}"` : 'nothing'}; the call shows ${describe(a.offer)}. Ask Travisse/CSM before using the specific number (skill rule).`);
  }
  if (codes.has('OFFER_MISMATCH')) {
    const target = parseOffer(offer)?.kind && parseOffer(offer).kind !== 'phrase' ? parseOffer(offer) : signals.agreed_offers[0]?.offer;
    const title = target ? (target.kind === 'pct' ? `${target.amount}% OFF` : target.kind === 'dollar' ? `$${target.amount} OFF` : `Free ${target.item}`) : '<offer>';
    const code = target ? (target.kind === 'free' ? 'FREE' + target.item.replace(/[^a-z]/gi, '').slice(0, 8).toUpperCase() : `SAVE${target.amount}`) : '<CODE>';
    const value = target && target.kind !== 'free' ? target.amount : '<n>';
    notes.push(`OFFER_MISMATCH: do not print until the signup keyword pays the offer on the sign. Fix with: ${offerSetCommand(ctx.location.id, target) || `boostly-links offer set ${ctx.location.id} --title ${JSON.stringify(title)} --code ${code} --value ${value} --cookie-file <cookie-file> --apply`}`);
  }
  const copy = previewOfferCopy(offer);
  const cmd = `node ~/.claude/skills/boostly-signage-sheets/scripts/plan.mjs --location-id ${ctx.location.id} --account-id ${ctx.location.account_id} --logo <color-sticker-logo.png> --offer ${JSON.stringify(offer)} --tables ${tables} --stalls ${stalls} --out-dir <run-dir>`;
  return { offer, tables, stalls, wizard: { tables: quantities.tables, stalls: quantities.stalls }, command: cmd, copy_preview: copy, notes, signup_pays: offers.signup_keyword?.title || null };
}

function csmQuestions(ctx, flags, signals) {
  const q = [];
  const csm = ctx.location.manager_name ? ctx.location.manager_name.split(' ')[0] : 'CSM';
  const name = ctx.location.name;
  for (const f of flags) {
    switch (f.code) {
      case 'NO_CALL': q.push(`${csm}: no call transcript found for ${name}. Was there an onboarding/launch call, and what offer + quantities did they agree to?`); break;
      case 'OFFER_MISMATCH': q.push(`${csm}: ${f.summary} Which offer should the sign and the signup pay? (we can load the promo and repoint the keyword)`); break;
      case 'INVITE_NOT_LOADED': q.push(`${csm}: the call mentions an offer that is not loaded as a promotion on ${name}. Should we create it and point the invite/signup at it?`); break;
      case 'COPY_REJECTED': q.push(`${csm}: ${name} pushed back on "Join the club" on the call. Confirm the exact headline they want on the stickers/POP.`); break;
      case 'GENERIC_DEFAULT': q.push(`${csm}: ${name}'s request says "${ctx.request?.offer_text || ''}" but the call agreed a specific offer. OK to print "Get <offer>" instead of the generic headline?`); break;
      case 'TABLES_MISMATCH': q.push(`${csm}: how many table stickers for ${name}? Wizard says ${ctx.quantities.tables}; the call says ${signals.no_table_stickers.length ? 'none' : [...new Set(signals.table_counts.map((t) => t.n))].join('/')}.`); break;
      case 'BATHROOM_CONCERN': q.push(`${csm}: bathroom stickers for ${name}: wizard says ${ctx.quantities.stalls} stalls; the call raised ${signals.stall_counts.length ? `${[...new Set(signals.stall_counts.map((s) => s.n))].join('/')} stalls` : 'a concern about the bathroom'}. Print them, and how many?`); break;
      case 'MULTI_LOCATION': q.push(`${csm}: ${name} is a new location on an account with fulfilled siblings. Same branding/offer/quantities as the existing stores?`); break;
      default: break;
    }
  }
  return q;
}

// ---------------------------------------------------------------------------
// markdown
function md(report) {
  const L = [];
  const r = report;
  L.push(`# Preflight: ${r.location.name} (${r.location.id})`);
  L.push('');
  L.push(`Account: ${r.location.account_name} (${r.location.account_id}) | CSM: ${r.location.manager_name || 'none'} | website: ${r.location.website_url || '-'} | place: ${r.location.google_place_id || '-'}`);
  if (r.request) {
    L.push(`Request ${r.request.id} (${r.request.created_at}, ${r.request.order_type}${r.request.canceled_at ? ', CANCELED' : ''}) offer_text: "${r.request.offer_text || ''}" | thread ${r.request.slack_thread_ts || '-'} | session ${r.request.onboarding_session_id || '-'} | by ${r.request.created_by_name || '-'}`);
    if (r.request.notes) L.push(`Notes: ${r.request.notes.replace(/\s+/g, ' ').slice(0, 300)}`);
  } else L.push('Request: NONE');
  L.push(`Quantities (wizard): tables ${r.quantities.tables}, stalls ${r.quantities.stalls}, to-go ${r.quantities.to_go}, tap cards ${r.quantities.tap_cards}, POP ${r.quantities.pop}`);
  L.push(`Contacts: ${r.contacts.map((c) => `${c.name} (${c.source})`).join(', ') || '-'}`);
  if (r.siblings.length) L.push(`Siblings: ${r.siblings.map((s) => `${s.name} [${s.status}, prior_fulfillments=${s.prior_fulfillments}]`).join('; ')}`);
  L.push('');
  L.push(`## Flags (${r.flags.length})`);
  for (const f of r.flags) {
    L.push(`- **${f.code}**: ${f.summary}`);
    for (const e of f.evidence) L.push(`    - ${e}`);
  }
  if (!r.flags.length) L.push('- none');
  L.push('');
  L.push('## Call facts');
  L.push(r.call_facts_block || '(no call facts)');
  L.push('');
  L.push('## Questions for the CSM');
  for (const q of r.csm_questions) L.push(`- ${q}`);
  if (!r.csm_questions.length) L.push('- none');
  L.push('');
  L.push('## Suggested build inputs (call quantities beat wizard quantities)');
  const b = r.build;
  L.push(`- offer: ${JSON.stringify(b.offer)} | tables: ${b.tables} (wizard ${b.wizard.tables}) | stalls: ${b.stalls} (wizard ${b.wizard.stalls}) | signup pays: ${b.signup_pays || 'none'}`);
  L.push(`- copy (${b.copy_preview.mode}): sticker "${b.copy_preview.tablePromo.title.replace(/\n/g, ' / ')}" / POP "${b.copy_preview.pop.title.replace(/\n/g, ' / ')}" + "${b.copy_preview.pop.body.replace(/\n/g, ' / ')}"`);
  for (const n of b.notes) L.push(`- ${n}`);
  L.push('```');
  L.push(b.command);
  L.push('```');
  if (r.call_signals.agreed_offers.length) {
    L.push('');
    L.push('Offers heard on calls (ranked: customer + signup context first):');
    for (const a of r.call_signals.agreed_offers.slice(0, 5)) L.push(`- ${a.offer.kind === 'pct' ? `${a.offer.amount}%` : a.offer.kind === 'dollar' ? `$${a.offer.amount}` : `free ${a.offer.item}`} (${a.by}${a.agreed ? ', agreed' : ''}): ${a.evidence.slice(0, 220)}`);
  }
  L.push('');
  L.push('## Signup offer (system)');
  const k = r.offers.signup_keyword;
  L.push(k ? `- Keyword ${k.keyword} -> ${k.promotion_id || 'NO PROMOTION'} "${k.title || ''}" / ${k.description || ''} (value ${k.estimated_value ?? '-'})` : '- No SUBSCRIBE_ keyword on this location');
  const tc = r.offers.text_club_subscribe_link;
  L.push(tc ? `- Text club subscribe link ${tc.id} -> keyword ${tc.keyword} -> promotion ${tc.promotion_id || 'none'} "${tc.promotion_title || ''}"` : '- No touchpoint subscribe link');
  L.push(`- Promotions on account (${r.offers.promotions.length}): ${r.offers.promotions.map((p) => `"${p.title}" [${p.id}, ${p.created_at.slice(0, 10)}]`).join('; ') || 'none'}`);
  for (const t of r.offers.invite_templates) L.push(`- Invite template ${t.id}: ${t.message_offers || '(no promotion wired)'}${t.meta?.initialMessage?.body ? ` | initial: ${JSON.stringify(t.meta.initialMessage.body).slice(0, 160)}` : ''}`);
  if (!r.offers.invite_templates.length) L.push('- No invite campaign template');
  L.push('');
  L.push(`## Calls (${r.calls.length} matched of ${r.ae.scanned} scanned since ${r.ae.since}${r.ae.from_cache ? ', cached' : ''}; reps searched: ${(r.ae.reps_searched || []).join(', ')})`);
  for (const c of r.calls) {
    L.push(`### ${c.date} ${c.classification} | ${c.title} (${c.id}, ${Math.round((c.duration_seconds || 0) / 60)} min, reps ${c.reps.join(', ') || c.owner || '-'}; contacts ${c.contacts.join(', ') || '-'}${c.transcript_status === 'ok' ? '' : `; TRANSCRIPT ${c.transcript_status.toUpperCase()}`})`);
    L.push(`match: ${c.match.reasons.join('; ')} (score ${c.match.score})`);
    if (c.transcript_file) L.push(`transcript: ${c.transcript_file}`);
    for (const l of c.lines) L.push(`- [${l.t}] ${l.speaker}: ${l.text}`);
    if (!c.lines.length) L.push(c.transcript_status === 'pending' ? '- (transcript pending: rerun preflight once AskElephant has it)' : '- (no topic lines)');
  }
  if (r.sibling_brand_calls?.length) L.push(`Same brand, other location (not used): ${r.sibling_brand_calls.map((w) => `${w.date} ${w.title} (${w.id})`).join('; ')}`);
  if (r.weak_candidates.length) L.push(`Weak candidates (not used): ${r.weak_candidates.slice(0, 8).map((w) => `${w.date} ${w.title} (${w.id})`).join('; ')}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.out, { recursive: true });
  await fs.mkdir(path.join(args.runDir, 'call'), { recursive: true });

  const req = await loadRequest(args.locationId);
  const offers = await loadOffers(args.locationId, req.location.account_id);
  const { since, until } = windowFor(args, req);
  const ctx = buildContext(req);
  const searchTerms = [...ctx.name.words, ...ctx.cities, ...ctx.contacts.map((c) => c.name), ...ctx.emails];

  // 1. find every call (find-calls.mjs): matched, weak, sibling-brand, group
  const cachePath = path.join(args.out, 'ae-dump.json');
  const found = await findCalls({ ctx, since, until, fetchLimit: args.fetchLimit, cachePath, noCache: args.noCache });
  await saveTranscripts(found.matches, args.runDir);
  const findOut = {
    generated_at: new Date().toISOString(), context: ctx, ae: found.ae, reps_searched: found.reps_searched,
    matches: found.matches.map(({ lines, ...m }) => ({ ...m, transcript_lines: lines?.length || 0 })),
    weak_candidates: found.weak, sibling_brand_calls: found.siblings, group_sessions: found.groups,
    transcript_pending: found.matches.filter((m) => m.transcript_status === 'pending').map((m) => m.id),
  };
  await fs.writeFile(path.join(args.runDir, 'call', 'find-calls.json'), JSON.stringify(findOut, null, 2));

  // 2. legacy topic-line view per call (kept for the report and the original flags)
  const calls = found.matches.map((m) => {
    const internal = new Set(m.internal || []);
    const isSales = m.classification === 'sales demo';
    const allLines = extractLines(m.lines || []);
    return { ...m, is_sales_call: isSales, internal, all_lines: allLines, lines: displayLines(allLines, m.lines || [], internal, isSales) };
  });
  const callsWithTranscript = calls.filter((c) => c.transcript_status === 'ok');

  // 3. original flags (request vs keyword vs verbatim lines)
  const fctx = { ...req, offers, calls: callsWithTranscript, since, searchTerms, anyMatches: calls.length > 0 };
  const { flags, callSignals } = computeFlags(fctx);
  const build = buildRecommendation(fctx, flags, callSignals);

  // 4. call facts (call-facts.mjs): agreed offer / birthday / counts / copy vs live DB
  let facts = extractFacts(found.matches);
  const llmResult = args.llm ? await llmPass(found.matches, facts, args.llmModel) : { ran: false, reason: 'not requested (--llm)' };
  facts = mergeLlm(facts, llmResult);
  const compared = compareFacts({ facts, calls: found.matches, req, offers });
  const block = callFactsBlock({ calls: found.matches, facts, flags: compared.flags, questions: compared.csm_questions, search: found });
  // merge: call-facts flags win on shared codes because they carry the command and the agreed value
  const merged = [...compared.flags];
  for (const f of flags) if (!merged.some((x) => x.code === f.code)) merged.push(f);
  // legacy questions only for flag codes call-facts did not already ask about
  const comparedCodes = new Set(compared.flags.map((f) => f.code));
  const legacyOnly = flags.filter((f) => !comparedCodes.has(f.code));
  const allQuestions = [...compared.csm_questions];
  for (const q of csmQuestions(fctx, legacyOnly, callSignals)) if (!allQuestions.includes(q)) allQuestions.push(q);
  const factsReport = {
    generated_at: new Date().toISOString(),
    location: { id: req.location.id, name: req.location.name, account_id: req.location.account_id, csm: req.location.manager_name || null },
    request: req.request ? { id: req.request.id, offer_text: req.request.offer_text, created_at: req.request.created_at } : null,
    quantities: req.quantities,
    signup_keyword: offers.signup_keyword ? { keyword: offers.signup_keyword.keyword, promotion_id: offers.signup_keyword.promotion_id, title: offers.signup_keyword.title } : null,
    promotions: offers.promotions.map((p) => ({ id: p.id, title: p.title })),
    calls: found.matches.map(({ lines, ...c }) => c),
    facts, llm: llmResult, flags: compared.flags, csm_questions: compared.csm_questions, call_facts_block: block,
  };
  await fs.writeFile(path.join(args.runDir, 'call', 'call-facts.json'), JSON.stringify(factsReport, null, 2));
  await fs.writeFile(path.join(args.runDir, 'call', 'call-facts.md'), block + '\n');

  const report = {
    generated_at: new Date().toISOString(),
    location: req.location,
    request: req.request,
    items: req.items,
    quantities: req.quantities,
    onboarding_session: req.session,
    users: req.users.map((u) => ({ name: u.name, email: u.email, role: u.role })),
    contacts: ctx.contacts,
    siblings: req.siblings,
    offers,
    ae: { since, until, scanned: found.ae.scanned, source: found.ae.source, source_status: found.ae.source_status, from_cache: found.ae.from_cache, search_terms: searchTerms, reps_searched: found.reps_searched, mode: found.ae.mode },
    calls: calls.map(({ all_lines, ...c }) => ({ ...c, internal: [...c.internal], topic_lines_total: all_lines.length })),
    weak_candidates: found.weak,
    sibling_brand_calls: found.siblings,
    group_sessions: found.groups,
    transcript_pending: findOut.transcript_pending,
    call_signals: callSignals,
    call_facts: facts,
    call_facts_block: block,
    llm: llmResult,
    flags: merged,
    csm_questions: allQuestions,
    build,
    files: { find_calls: path.join(args.runDir, 'call', 'find-calls.json'), call_facts: path.join(args.runDir, 'call', 'call-facts.json'), transcripts: found.matches.map((m) => m.transcript_file).filter(Boolean) },
  };
  const jsonPath = path.join(args.out, 'preflight.json');
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  const summary = md(report);
  await fs.writeFile(path.join(args.out, 'preflight.md'), summary);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else { console.log(summary); console.log(`\nWritten: ${jsonPath}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}
