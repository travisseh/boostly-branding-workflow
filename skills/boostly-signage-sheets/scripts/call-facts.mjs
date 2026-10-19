#!/usr/bin/env node
// call-facts.mjs: what the customer agreed to on the call, versus what the
// system pays and what the request says.
//
// Deterministic first (regex over transcript lines), then an optional bounded
// Claude pass (--llm) for fields the regexes left empty. Compares against the
// live V2 DB (SUBSCRIBE keyword -> promotion, fulfillment_items quantities,
// offer_text) and emits flags plus a drafted CSM question list. Writes
// nothing to production: the orchestrator decides.
//
// Usage:
//   node call-facts.mjs --run-dir <dir>            # reads <dir>/call/find-calls.json + transcripts
//                       [--location-id <id>]       # defaults to the id stored in find-calls.json
//                       [--llm] [--llm-model fable] [--json]
//   Writes <dir>/call/call-facts.json and <dir>/call/call-facts.md.
//
// Facts extracted per location (each with verbatim evidence lines):
//   invite_offer      percent, dollar, or free item agreed for the signup/invite
//   birthday          agreed birthday offer (free item), or explicitly off
//   tables / stalls / tap_cards   counts said on the call
//   sign_copy         pushback on "Join the club" or a stated wording preference
//   combine_lists     multi-store list merge agreed
//   not_discussed     topics with no lines at all
// Flags: OFFER_MISMATCH (with the exact `boostly-links offer set` command),
//   BIRTHDAY_PROMO_MISSING (with the `promotions create` command),
//   QUANTITIES_UNCONFIRMED (one line), QUANTITIES_CONFLICT, TRANSCRIPT_PENDING,
//   COMBINE_LISTS, COPY_REJECTED, SIBLING_IDENTICAL_QUANTITIES (another open
//   request on the account carries exactly the same table/stall/to-go counts).
// For QUANTITIES_CONFLICT, OFFER_MISMATCH and SIBLING_IDENTICAL_QUANTITIES the
// CSM Slack DM is drafted automatically to <dir>/call/csm-dm.txt (Travisse
// voice, plain text); the closeout names it and the finish sends it. It is
// never pasted as a question for Travisse.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadRequest, loadOffers, parseOffer, sameOffer, findPromotionFor, describeOffer, offerSetCommand, parseNumberToken, NUMBER_WORD_RE, WIZARD_DEFAULTS, v2DbRows, sqlLiteral } from './lib/v2-reads.mjs';

export const CSM_DM_CODES = ['QUANTITIES_CONFLICT', 'OFFER_MISMATCH', 'SIBLING_IDENTICAL_QUANTITIES'];

// Other OPEN requests on the account (not canceled, not shipped) with their sticker counts,
// so identical quantities across sibling locations are caught before the vendor order.
export async function loadSiblingRequests(accountId, requestId) {
  const rows = await v2DbRows(`
    select fr.id, fr.location_id, l.name as location_name, fr.created_at::text as created_at,
           coalesce((select max(quantity) from fulfillment_items fi where fi.fulfillment_request_id = fr.id and fi.item_type = 'stickers' and fi.placement = 'table'), 0)::int as tables,
           coalesce((select max(quantity) from fulfillment_items fi where fi.fulfillment_request_id = fr.id and fi.item_type = 'stickers' and fi.placement = 'bathroom'), 0)::int as stalls,
           coalesce((select max(quantity) from fulfillment_items fi where fi.fulfillment_request_id = fr.id and fi.item_type = 'stickers' and fi.placement = 'to_go'), 0)::int as to_go,
           coalesce((select max(quantity) from fulfillment_items fi where fi.fulfillment_request_id = fr.id and fi.item_type = 'tapcards'), 0)::int as tap_cards
    from fulfillment_requests fr join locations l on l.id = fr.location_id
    where l.account_id = ${sqlLiteral(accountId)} and fr.id <> ${sqlLiteral(requestId)} and fr.canceled_at is null and fr.tracking_number is null
    order by fr.created_at desc
  `);
  return rows.map((r) => ({ ...r, tables: Number(r.tables), stalls: Number(r.stalls), to_go: Number(r.to_go), tap_cards: Number(r.tap_cards) }));
}
import { parseTranscript, normText } from './find-calls.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// regex vocabulary
const INVITE_CTX_RE = /\binvite\b|welcome offer|first (?:text|offer|message)|opt[- ]?in offer|sign[- ]?up offer|text club offer|join(?:ing)? the (?:text )?club|when they (?:join|sign up|opt in)|initial (?:text|offer)|for joining|standard (?:invite )?offer|to sign up|get them in the door|the first one/i;
const ROTATION_RE = /rotation|rotational|\bweekly\b|once a week|list of offers|10% off an order|15% off|\$5\b|minimum|order of (?:30|40|50)/i;
const BIRTHDAY_RE = /\bbirthday|b-?day\b/i;
const PRICING_RE = /per month|a month\b|setup fee|set-up fee|payment|agreement|annually|invoice|contract|pricing|enrollment link|12 months|twelve months|per location|average ticket|\$\s*\d{3,}|texts? (?:a|per) month|6,?000|plan\b/i;
const EXISTING_DISCOUNT_RE = /already (?:do|get|have|run)|every day|daily|happy hour|munchie hour|between \d/i;
const AGREE_RE = /\b(?:go with|roll with|let'?s do|we'?ll do|let'?s go(?: with)?|let'?s just do|that works|sounds good|i like that|yeah,? let'?s|we can do|keep it at|stick with|is (?:really )?perfect|perfect,|we want(?: to do)?|we'?d like(?: to do)?|i want(?: to do)?|i'?d like(?: to do)?|we'?re (?:gonna|going to) do|put (?:it )?(?:down )?(?:as|at)|let'?s say|that'?s fine|that'?d be fine|that'?d be great|would be great|fine with me|works for me|yep|yes,? (?:let'?s|do)|i'?ll (?:just )?(?:set|put|make|change|update|leave|load)|i will (?:set|put|make|change|update|leave|load)|so we'?ll|we'?ll (?:set|put|make|go))\b/i;
const REP_SET_RE = /(?:i'?ll|i will|let me|we'?ll|so we'?ll|i'?m gonna|i'?m going to) (?:just )?(?:set|put|make|change|update|load|do) (?:that|it|this|the offer|the invite)?\s*(?:as|to|at|down as|for)?\s*(\d{1,2})\s*(?:%|percent)?/i;
const PERFECT_N_RE = /\b(?:perfect|okay|cool|great|awesome|got it),?\s*(\d{1,2})\s*(?:%|percent)/i;
const GO_N_RE = /\b(?:let'?s go|go with|we'?ll go|i'?d go|do)\s+(?:with\s+)?(\d{1,2})\s*(?:%|percent)?\b(?!\s*(?:minutes|min|days|tables|stalls|cards))/i;
const OFF_RE = /(\d{1,2})\s*(?:%|percent)\s*off|(\d{1,2})\s*(?:%|percent)|\$\s*(\d{1,3})\s*(?:off|dollars?\s*off)?|\b(\d{1,3})\s*(?:dollars?|bucks)\s*off\b/gi;
const FREE_ITEM_RE = /\bfree\s+((?:[a-z]+\s+){0,2}[a-z]+)/gi;
const FREE_STOP_RE = /^(to|of|for|and|the|up|on|in|with|from|text|texting|texts|trial|shipping|month|box|time|way|version|delivery|wifi|stuff|one|thing|things)\b/i;
const BIRTHDAY_OFF_RE = /leave (?:that|it|the birthday) off|skip (?:the )?birthday|no birthday|don'?t (?:want|need|do) (?:a |the )?birthday|turn (?:that|it) off/i;
const COPY_REJECT_RE = /not (?:be )?join(?:ing)? the club|don'?t (?:feel like|want to|wanna|like) join(?:ing)?|sounds like a bigger thing|cheapen(?:s|ing)? the brand|older clientele|not (?:really )?a club|don'?t (?:like|love) (?:the )?(?:word |phrase |term )?["“]?club|instead of (?:["“]?join the club|club)|(?:rather|instead) (?:say|have|put|call it|go with) (?!["“]?join the club)|(?:let'?s|we'?ll|i'?d|we'?d|could we|can we) (?:just )?(?:go with|call it|use) ["“]?(?!join the club)[^"”]{3,60}?(?:offers?|deals?|specials?|perks|rewards|club)/i;
// sign copy needs a sticker/sign noun in the same line: "wording" alone fires on sales talk
const SIGN_COPY_RE = /\b(?:on the stickers?|on the signs?|on the signage|the stickers? (?:say|says|to say|should say|would say)|write that on|(?:wording|headline|copy) (?:on|for) the (?:stickers?|signs?|signage|pop|qr)|what (?:do you want|should) (?:it|the stickers?|the signs?) (?:to )?say|say on the (?:stickers?|signs?)|(?:stickers?|signs?|signage) (?:wording|headline|copy))\b/i;
const COMBINE_RE = /combine (?:all of them|them|those|both|the two|the lists?|the two lists|(?:both|the) (?:stores?|locations?))|(?:one|a single|general|combined) list|merge (?:the|both) lists?/i;
const NO_TABLE_RE = /(?:don'?t|do not|not) (?:want|need) (?:any )?(?:stickers? )?(?:on|for) (?:the |our )?tables|none? for the tables|not for the tables|no table stickers|nothing on the tables|don'?t think we want any for the tables|skip the tables/i;

function clip(text, n = 240) { return text.length > n ? text.slice(0, n - 3).trimEnd() + '...' : text; }

function offersInLine(text) {
  const found = [];
  for (const m of text.matchAll(OFF_RE)) {
    if (m[1] || m[2]) found.push({ kind: 'pct', amount: Number(m[1] || m[2]) });
    else if (m[3] || m[4]) found.push({ kind: 'dollar', amount: Number(m[3] || m[4]) });
  }
  return found.filter((o) => (o.kind === 'pct' ? o.amount >= 5 && o.amount <= 60 : o.amount >= 2 && o.amount <= 100));
}

function freeItemsInLine(text) {
  const out = [];
  for (const m of text.matchAll(FREE_ITEM_RE)) {
    let item = m[1].toLowerCase().replace(/\b(?:maybe|like|for|on|in|with|and|or|the|a|an|their|your|our|that|would|be|great|is)\b.*$/, '').trim();
    if (!item || FREE_STOP_RE.test(item)) continue;
    out.push(item);
  }
  return out;
}

function numbersNear(text, nounRe) {
  const out = [];
  const re = new RegExp(`\\b(\\d{1,3}|${NUMBER_WORD_RE})\\b(?!\\s+of\\b)(?:\\s+\\w+){0,2}?\\s+(?:${nounRe})\\b`, 'gi');
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

// ---------------------------------------------------------------------------
// extraction
export function extractFacts(calls) {
  const ev = (call, l) => `${call.date} ${call.classification} [${l.t}] ${l.speaker}: ${clip(l.text)}`;
  const facts = {
    invite_offer: null, invite_candidates: [],
    birthday: null, birthday_candidates: [],
    tables: null, no_table_stickers: [], stalls: null, tap_cards: null,
    sign_copy: { rejected_join_the_club: false, lines: [] },
    combine_lists: null,
    other_offers: [],
    not_discussed: [],
    topic_lines: { invite_offer: 0, birthday: 0, tables: 0, stalls: 0, tap_cards: 0, sign_copy: 0 },
  };
  const facts_by_call = [];

  for (const call of calls) {
    if (!call.lines?.length) continue;
    const internal = new Set(call.internal || []);
    const lines = [];
    for (const l of call.lines) {
      const prev = lines[lines.length - 1];
      if (prev && prev.t === l.t && prev.text === l.text) continue;
      lines.push(l);
    }
    const isRep = (l) => internal.has(l.speaker);
    const ctxWindow = (i, re, back = 3) => { for (let k = Math.max(0, i - back); k <= i; k += 1) if (re.test(lines[k].text)) return true; return false; };
    const perCall = { id: call.id, date: call.date, classification: call.classification, invite: [], birthday: [], tables: [], stalls: [], tap_cards: [], sign_copy: [], combine: [] };
    let lastRepProposal = null; // {offer, i}

    lines.forEach((l, i) => {
      const text = l.text;
      const rep = isRep(l);
      const inviteCtx = ctxWindow(i, INVITE_CTX_RE, 4) && !BIRTHDAY_RE.test(text) && !PRICING_RE.test(text);
      const birthdayCtx = ctxWindow(i, BIRTHDAY_RE, 3);

      // ---- invite offer
      if (inviteCtx || (ctxWindow(i, /invite|sign ?up|first (?:text|offer)/i, 8) && /\d{1,2}\s*(?:%|percent)/.test(text))) {
        facts.topic_lines.invite_offer += 1;
        const offers = offersInLine(text);
        const setM = text.match(REP_SET_RE) || text.match(PERFECT_N_RE);
        const goM = text.match(GO_N_RE);
        if (rep && setM) {
          const amount = Number(setM[1]);
          perCall.invite.push({ offer: { kind: 'pct', amount }, by: 'rep', strength: 'confirmed', evidence: ev(call, l), i });
        } else if (!rep && goM && !EXISTING_DISCOUNT_RE.test(text)) {
          const amount = Number(goM[1]);
          perCall.invite.push({ offer: { kind: 'pct', amount }, by: 'customer', strength: 'agreed', evidence: ev(call, l), i });
        } else if (!rep && offers.length && AGREE_RE.test(text) && !EXISTING_DISCOUNT_RE.test(text) && !ROTATION_RE.test(text)) {
          perCall.invite.push({ offer: offers[offers.length - 1], by: 'customer', strength: 'agreed', evidence: ev(call, l), i });
        } else if (!rep && offers.length && !EXISTING_DISCOUNT_RE.test(text) && !ROTATION_RE.test(text)) {
          for (const o of offers) perCall.invite.push({ offer: o, by: 'customer', strength: 'mentioned', evidence: ev(call, l), i });
        } else if (rep && offers.length && !ROTATION_RE.test(text)) {
          lastRepProposal = { offer: offers[0], i, evidence: ev(call, l) };
          perCall.invite.push({ offer: offers[0], by: 'rep', strength: AGREE_RE.test(text) ? 'confirmed' : 'proposed', evidence: ev(call, l), i });
        } else if (!rep && lastRepProposal && i - lastRepProposal.i <= 4 && /^(?:yeah|yes|yep|sure|okay|ok|perfect|that'?s fine|that works|sounds good|fine|great|cool)\b/i.test(text) && !/\bbut\b|instead|rather|higher|lower|more|less/i.test(text)) {
          perCall.invite.push({ offer: lastRepProposal.offer, by: 'customer', strength: 'agreed', evidence: `${lastRepProposal.evidence} -> ${ev(call, l)}`, i });
          lastRepProposal = null;
        }
        // "20% off is really perfect" style customer confirmations of the rep's number
        if (!rep && lastRepProposal && offers.some((o) => sameOffer(o, lastRepProposal.offer)) && AGREE_RE.test(text)) lastRepProposal = null;
      }

      // ---- birthday
      if (birthdayCtx) {
        facts.topic_lines.birthday += 1;
        if (BIRTHDAY_OFF_RE.test(text)) perCall.birthday.push({ status: 'off', by: rep ? 'rep' : 'customer', evidence: ev(call, l), i });
        for (const item of freeItemsInLine(text)) {
          const summary = rep && /birthday (?:offer|hero|text|rotation)|so (?:the )?birthday|free \w+ (?:would be|it is|sounds)|would just recommend/i.test(text);
          perCall.birthday.push({ status: 'free', item, by: rep ? 'rep' : 'customer', strength: summary ? 'confirmed' : AGREE_RE.test(text) ? 'agreed' : 'mentioned', evidence: ev(call, l), i });
        }
        const offs = offersInLine(text);
        if (offs.length && /birthday/i.test(text) && !rep) perCall.birthday.push({ status: 'discount', offer: offs[0], by: 'customer', strength: 'mentioned', evidence: ev(call, l), i });
      }

      // ---- counts (not from sales demos: reps pitch box contents generically there)
      const countsOk = call.classification !== 'sales demo';
      if (countsOk && /\btables?\b/i.test(text) && !/tablet/i.test(text)) {
        facts.topic_lines.tables += 1;
        if (NO_TABLE_RE.test(text)) facts.no_table_stickers.push(ev(call, l));
        const near = numbersNear(text, 'tables?|tops|table stickers?');
        const totals = totalsIn(text);
        if (totals.length) perCall.tables.push({ n: totals[totals.length - 1], total: true, evidence: ev(call, l) });
        else if (near.length) perCall.tables.push({ n: Math.max(...near), total: false, evidence: ev(call, l) });
      }
      if (countsOk && /\bstalls?\b|\bbathrooms?\b|\brestrooms?\b/i.test(text)) {
        facts.topic_lines.stalls += 1;
        const stalls = numbersNear(text, 'stalls?|bathroom stalls?');
        const rooms = stalls.length ? [] : numbersNear(text, 'bathrooms?|restrooms?');
        if (stalls.length) perCall.stalls.push({ n: Math.max(...stalls), noun: 'stalls', evidence: ev(call, l) });
        else if (rooms.length && /stall|sticker|mirror/i.test(text)) perCall.stalls.push({ n: Math.max(...rooms), noun: 'bathrooms', evidence: ev(call, l) });
      }
      if (countsOk && /\btap ?cards?\b/i.test(text)) {
        facts.topic_lines.tap_cards += 1;
        const n = numbersNear(text, 'tap ?cards?');
        if (n.length) perCall.tap_cards.push({ n: Math.max(...n), evidence: ev(call, l) });
      }

      // ---- sign copy
      if (SIGN_COPY_RE.test(text) || (COPY_REJECT_RE.test(text) && /club|wording|brand|offers?|specials?|deals?/i.test(text))) {
        facts.topic_lines.sign_copy += 1;
        const rejected = !rep && COPY_REJECT_RE.test(text);
        perCall.sign_copy.push({ rejected_join_the_club: rejected, by: rep ? 'rep' : 'customer', evidence: ev(call, l) });
      }

      // ---- combine lists
      if (COMBINE_RE.test(text) && /list|store|location|both|two/i.test(text)) perCall.combine.push({ by: rep ? 'rep' : 'customer', agreed: AGREE_RE.test(text) || /we could|that would be fine|yeah/i.test(text), evidence: ev(call, l) });

      // ---- other offers heard (rotation, lottery) for context
      if (ROTATION_RE.test(text) && !rep) {
        for (const item of freeItemsInLine(text)) facts.other_offers.push({ kind: 'free', item, context: 'rotation', evidence: ev(call, l) });
      }
    });
    facts_by_call.push(perCall);
  }

  // ---- resolve: the LAST confirmation wins (20 -> 25 on Fox's; 20 -> 30 on Munchie)
  const order = { confirmed: 0, agreed: 1, proposed: 2, mentioned: 3 };
  const allInvite = facts_by_call.flatMap((c) => c.invite.map((x) => ({ ...x, call: c })));
  facts.invite_candidates = allInvite.map(({ call, ...x }) => ({ ...x, call_id: call.id }));
  const decisive = allInvite.filter((x) => x.strength === 'confirmed' || x.strength === 'agreed');
  if (decisive.length) {
    const launch = decisive.filter((x) => x.call.classification === 'launch prep');
    const pool = launch.length ? launch : decisive;
    // latest call, latest line
    pool.sort((a, b) => (a.call.date + String(a.i).padStart(6, '0')).localeCompare(b.call.date + String(b.i).padStart(6, '0')));
    const pick = pool[pool.length - 1];
    facts.invite_offer = { offer: pick.offer, by: pick.by, strength: pick.strength, evidence: pick.evidence, call_id: pick.call.id, call_date: pick.call.date, source: 'regex' };
  } else if (allInvite.some((x) => x.strength === 'proposed')) {
    const p = allInvite.filter((x) => x.strength === 'proposed').slice(-1)[0];
    facts.invite_offer = { offer: p.offer, by: p.by, strength: 'proposed (not confirmed by the customer)', evidence: p.evidence, call_id: p.call.id, call_date: p.call.date, source: 'regex' };
  }

  const allBday = facts_by_call.flatMap((c) => c.birthday.map((x) => ({ ...x, call: c })));
  facts.birthday_candidates = allBday.map(({ call, ...x }) => ({ ...x, call_id: call.id }));
  if (allBday.length) {
    const off = allBday.filter((x) => x.status === 'off');
    const frees = allBday.filter((x) => x.status === 'free');
    const confirmed = frees.filter((x) => x.strength === 'confirmed');
    const agreed = frees.filter((x) => x.strength === 'agreed');
    const lastOf = (arr) => arr[arr.length - 1];
    const pick = off.length && (!confirmed.length || lastOf(off).i > lastOf(confirmed).i) ? { status: 'off', ...lastOf(off) }
      : confirmed.length ? { status: 'free', ...lastOf(confirmed) }
      : agreed.length ? { status: 'free', ...lastOf(agreed) }
      : frees.length ? { status: 'free', ...lastOf(frees), strength: 'mentioned' }
      : { status: 'discussed', ...lastOf(allBday) };
    const { call, i, ...rest } = pick;
    facts.birthday = { ...rest, call_id: call.id, call_date: call.date, source: 'regex' };
  }

  const pickCount = (key, preferTotal) => {
    const all = facts_by_call.flatMap((c) => c[key].map((x) => ({ ...x, call_id: c.id, call_date: c.date })));
    if (!all.length) return null;
    const subset = preferTotal ? (all.filter((x) => x.total).length ? all.filter((x) => x.total) : all) : (all.filter((x) => x.noun === 'stalls').length ? all.filter((x) => x.noun === 'stalls') : all);
    const last = subset[subset.length - 1];
    return { n: last.n, evidence: last.evidence, call_id: last.call_id, call_date: last.call_date, all: all.map((x) => x.n), source: 'regex' };
  };
  facts.tables = pickCount('tables', true);
  facts.stalls = pickCount('stalls', false);
  {
    const all = facts_by_call.flatMap((c) => c.tap_cards.map((x) => ({ ...x, call_id: c.id, call_date: c.date })));
    facts.tap_cards = all.length ? { ...all[all.length - 1], source: 'regex' } : null;
  }
  {
    const all = facts_by_call.flatMap((c) => c.sign_copy);
    facts.sign_copy = { rejected_join_the_club: all.some((x) => x.rejected_join_the_club), lines: all.map((x) => x.evidence).slice(0, 6) };
  }
  {
    const all = facts_by_call.flatMap((c) => c.combine.map((x) => ({ ...x, call_id: c.id, launch: c.classification === 'launch prep' })));
    all.sort((a, b) => Number(b.launch) - Number(a.launch));
    facts.combine_lists = all.length ? { agreed: all.some((x) => x.agreed), evidence: all.map((x) => x.evidence).slice(0, 3) } : null;
  }
  const nd = [];
  if (!facts.topic_lines.invite_offer) nd.push('invite offer');
  if (!facts.topic_lines.birthday) nd.push('birthday promo');
  if (!facts.tables && !facts.no_table_stickers.length) nd.push('tables');
  if (!facts.stalls) nd.push('stalls');
  if (!facts.tap_cards) nd.push('tap card count');
  if (!facts.sign_copy.lines.length) nd.push('sign copy');
  facts.not_discussed = nd;
  facts.by_call = facts_by_call.map((c) => ({ id: c.id, date: c.date, classification: c.classification, invite: c.invite.length, birthday: c.birthday.length, tables: c.tables.length, stalls: c.stalls.length, tap_cards: c.tap_cards.length, sign_copy: c.sign_copy.length, combine: c.combine.length }));
  return facts;
}

// ---------------------------------------------------------------------------
// bounded Claude pass for the fields regex left empty
const TOPIC_RE = /\boffer\b|\bdiscount\b|%|percent|\bfree\b|\binvite\b|\bbirthday\b|\bjoin the club\b|\bsticker|\bsignage\b|\bsign\b|\btables?\b|\bstalls?\b|\bbathrooms?\b|\btap ?cards?\b|\bhow many\b|\bwording\b|\bsay on\b|\bcombine\b|\blist\b/i;

export async function llmPass(calls, facts, model = 'fable') {
  const missing = [];
  if (!facts.invite_offer) missing.push('invite_offer');
  if (!facts.birthday) missing.push('birthday');
  if (!facts.tables && !facts.no_table_stickers.length) missing.push('tables');
  if (!facts.stalls) missing.push('stalls');
  if (!facts.tap_cards) missing.push('tap_cards');
  if (!facts.sign_copy.lines.length) missing.push('sign_copy');
  if (!missing.length) return { ran: false, reason: 'all fields found by regex' };
  const withTranscript = calls.filter((c) => c.lines?.length && c.classification !== 'scheduling');
  if (!withTranscript.length) return { ran: false, reason: 'no transcript to read' };
  let budget = 14000;
  const excerpts = [];
  for (const c of withTranscript) {
    const picked = c.lines.filter((l) => TOPIC_RE.test(l.text)).map((l) => `[${l.t}] ${l.speaker}: ${clip(l.text, 300)}`);
    const block = `## ${c.date} ${c.classification} "${c.title}"\n${picked.join('\n')}`;
    if (block.length > budget) { excerpts.push(block.slice(0, budget)); break; }
    excerpts.push(block); budget -= block.length;
  }
  const prompt = `You are extracting fulfillment facts from Boostly customer call excerpts (Boostly reps: ${[...new Set(withTranscript.flatMap((c) => c.internal || []))].join(', ') || 'unknown'}). Only these fields are still unknown: ${missing.join(', ')}.
Return ONLY a JSON object with exactly these keys: ${missing.map((k) => `"${k}"`).join(', ')}. For each key give null when the topic was not decided on the call, otherwise an object {"value": <string or number>, "evidence": "<timestamp> <speaker>: <verbatim words>"}.
Definitions: invite_offer = the signup/welcome offer the customer agreed to (e.g. "25% off", "$10 off", "free cookie"), NOT rotation, birthday, or pricing numbers; birthday = the birthday offer agreed ("free dessert", or "off" if declined); tables/stalls/tap_cards = counts the customer stated; sign_copy = wording the customer wants on stickers or signs, or "rejected join the club".
Never invent. If a number was only proposed by the rep and not accepted, return null.

${excerpts.join('\n\n')}`;
  try {
    const { stdout } = await execFileAsync('claude', ['-p', '--model', model, '--output-format', 'json', '--max-turns', '1', prompt], { maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
    const wrapper = JSON.parse(stdout);
    const text = typeof wrapper.result === 'string' ? wrapper.result : JSON.stringify(wrapper.result);
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    return { ran: true, model, missing, result: parsed, raw: parsed ? undefined : text.slice(0, 500) };
  } catch (err) {
    return { ran: false, reason: `claude -p failed: ${String(err.message || err).split('\n')[0]}` };
  }
}

export function mergeLlm(facts, llm) {
  if (!llm?.ran || !llm.result) return facts;
  const r = llm.result;
  const asOffer = (v) => (typeof v === 'string' ? parseOffer(v) : typeof v === 'number' ? { kind: 'pct', amount: v, raw: `${v}%` } : null);
  if (!facts.invite_offer && r.invite_offer?.value) {
    const o = asOffer(String(r.invite_offer.value));
    if (o && o.kind !== 'phrase') facts.invite_offer = { offer: o, by: 'llm', strength: 'llm', evidence: r.invite_offer.evidence || '', source: `llm:${llm.model}` };
  }
  if (!facts.birthday && r.birthday?.value) {
    const v = String(r.birthday.value).toLowerCase();
    facts.birthday = v === 'off' ? { status: 'off', evidence: r.birthday.evidence || '', source: `llm:${llm.model}` } : { status: 'free', item: v.replace(/^free\s+/, ''), strength: 'llm', evidence: r.birthday.evidence || '', source: `llm:${llm.model}` };
  }
  for (const k of ['tables', 'stalls', 'tap_cards']) {
    if (!facts[k] && r[k]?.value != null && Number.isFinite(Number(r[k].value))) facts[k] = { n: Number(r[k].value), evidence: r[k].evidence || '', source: `llm:${llm.model}` };
  }
  if (!facts.sign_copy.lines.length && r.sign_copy?.value) {
    facts.sign_copy = { rejected_join_the_club: /reject/i.test(String(r.sign_copy.value)), preference: String(r.sign_copy.value), lines: [r.sign_copy.evidence || ''], source: `llm:${llm.model}` };
  }
  facts.not_discussed = facts.not_discussed.filter((t) => {
    if (t === 'invite offer') return !facts.invite_offer;
    if (t === 'birthday promo') return !facts.birthday;
    if (t === 'tables') return !facts.tables;
    if (t === 'stalls') return !facts.stalls;
    if (t === 'tap card count') return !facts.tap_cards;
    if (t === 'sign copy') return !facts.sign_copy.lines.length;
    return true;
  });
  return facts;
}

// ---------------------------------------------------------------------------
// compare with the live system
export function compareFacts({ facts, calls, req, offers, siblingRequests = [] }) {
  const flags = [];
  const push = (code, summary, evidence, command) => flags.push({ code, summary, evidence: evidence || [], ...(command ? { command } : {}) });
  const loc = req.location;
  const keyword = offers.signup_keyword;
  const keywordOffer = parseOffer(keyword?.title);
  const promoTitles = offers.promotions.map((p) => p.title);
  const withTranscript = calls.filter((c) => c.has_transcript && c.transcript_status === 'ok');
  const pending = calls.filter((c) => c.transcript_status === 'pending');

  if (!calls.length) push('NO_CALL', 'No AskElephant call matched this location in the window.', []);
  if (pending.length) push('TRANSCRIPT_PENDING', `${pending.length} matched call(s) have no transcript yet: ${pending.map((c) => `${c.date} "${c.title}" (${c.id})`).join('; ')}. Rerun preflight later; facts below come only from the calls that have one.`, []);

  // invite offer vs keyword
  if (facts.invite_offer && !/proposed/.test(facts.invite_offer.strength)) {
    const o = facts.invite_offer.offer;
    if (keywordOffer && sameOffer(o, keywordOffer)) {
      facts.invite_offer.live = `matches: keyword ${keyword.keyword} pays "${keyword.title}"`;
    } else {
      const promo = findPromotionFor(o, offers.promotions);
      facts.invite_offer.live = keyword ? `keyword ${keyword.keyword} pays "${keyword.title || 'nothing'}"` : 'no SUBSCRIBE keyword';
      push('OFFER_MISMATCH', `Call agreed ${describeOffer(o)} for the invite/signup (${facts.invite_offer.call_date}) but the signup keyword ${keyword?.keyword || '(none)'} pays "${keyword?.title || 'nothing'}"${promo ? `; a "${promo.title}" promotion already exists (${promo.id}), offer set will reuse it` : ''}.`,
        [facts.invite_offer.evidence], offerSetCommand(loc.id, o));
    }
  } else if (facts.invite_offer) {
    facts.invite_offer.live = keyword ? `keyword ${keyword.keyword} pays "${keyword.title}"` : 'no SUBSCRIBE keyword';
  }

  // birthday
  if (facts.birthday?.status === 'free') {
    const item = facts.birthday.item;
    const bdayPromos = offers.promotions.filter((p) => /birthday|b-?day/i.test(`${p.title} ${p.description || ''}`));
    const hit = bdayPromos.find((p) => new RegExp(item.split(' ').pop().replace(/s$/, ''), 'i').test(`${p.title} ${p.description || ''}`));
    if (hit) facts.birthday.live = `live: "${hit.title}" (${hit.id})`;
    else {
      facts.birthday.live = bdayPromos.length ? `live birthday promo says "${bdayPromos.map((p) => p.title).join(' | ')}", not ${item}` : 'no birthday promotion on the account';
      const title = `Happy Birthday! Free ${item}`;
      push('BIRTHDAY_PROMO_MISSING', `Call agreed a free ${item} birthday offer (${facts.birthday.call_date}) but ${facts.birthday.live}.`, [facts.birthday.evidence],
        `boostly-links promotions create ${loc.id} --title ${JSON.stringify(title)} --description ${JSON.stringify(`Free ${item} in store during your birthday window`)} --code BDAY${item.replace(/[^a-z]/gi, '').slice(0, 6).toUpperCase()} --value <estimated-value> --cookie-file <cookie-file> --apply   # then wire it to the birthday rotation in the app`);
    }
  } else if (facts.birthday?.status === 'off') {
    facts.birthday.live = 'customer declined a birthday offer; nothing to load';
  }

  // quantities
  const q = req.quantities;
  const isDefault = q.tables === WIZARD_DEFAULTS.tables && q.stalls === WIZARD_DEFAULTS.stalls && q.tap_cards === WIZARD_DEFAULTS.tap_cards;
  const confirmed = [];
  const unconfirmed = [];
  const conflicts = [];
  const check = (label, live, fact) => {
    if (!fact) { unconfirmed.push(label); return; }
    if (fact.n === live) confirmed.push(`${label} ${live}`); else conflicts.push(`${label}: request ${live}, call ${fact.n}`);
  };
  check('tables', q.tables, facts.no_table_stickers.length ? { n: 0 } : facts.tables);
  check('stalls', q.stalls, facts.stalls);
  check('tap cards', q.tap_cards, facts.tap_cards);
  facts.quantities = { request: { tables: q.tables, stalls: q.stalls, tap_cards: q.tap_cards }, wizard_defaults: isDefault, confirmed, unconfirmed, conflicts };
  if (unconfirmed.length && (isDefault || !withTranscript.length)) {
    push('QUANTITIES_UNCONFIRMED', `tables ${q.tables} / stalls ${q.stalls} / tap cards ${q.tap_cards}${isDefault ? ' are the wizard defaults' : ''}; the call did not confirm ${unconfirmed.join(', ')}${confirmed.length ? ` (confirmed: ${confirmed.join(', ')})` : ''}${withTranscript.length ? '' : ' (no transcript to check)'}.`, []);
  }
  if (conflicts.length) push('QUANTITIES_CONFLICT', `Call quantities beat wizard quantities: ${conflicts.join('; ')}.`, [facts.tables?.evidence, facts.stalls?.evidence, facts.tap_cards?.evidence, ...facts.no_table_stickers].filter(Boolean));
  const identical = siblingRequests.filter((s) => s.tables === q.tables && s.stalls === q.stalls && s.to_go === q.to_go && (q.tables + q.stalls + q.to_go) > 0);
  facts.quantities.sibling_identical = identical.map((s) => ({ request_id: s.id, location_name: s.location_name }));
  if (identical.length) push('SIBLING_IDENTICAL_QUANTITIES', `${identical.length} other open request${identical.length === 1 ? '' : 's'} on the account carr${identical.length === 1 ? 'ies' : 'y'} exactly tables ${q.tables} / stalls ${q.stalls} / to-go ${q.to_go}: ${identical.map((s) => `${s.location_name} (${s.id})`).join('; ')}. Likely one set of counts pasted across locations.`, []);

  if (facts.sign_copy.rejected_join_the_club) push('COPY_REJECTED', 'Customer pushed back on "Join the club" wording or asked for other wording.', facts.sign_copy.lines);
  if (facts.combine_lists?.agreed) push('COMBINE_LISTS', 'Customer wants the multi-store lists combined; check the account/location scope before sending.', facts.combine_lists.evidence);

  // request offer_text vs agreed
  if (facts.invite_offer && !/proposed/.test(facts.invite_offer.strength)) {
    const requestOffer = parseOffer(req.request?.offer_text);
    if (!requestOffer || requestOffer.kind === 'phrase') {
      push('GENERIC_DEFAULT', `Request offer_text is ${req.request?.offer_text ? `"${req.request.offer_text}"` : 'empty'}; the call agreed ${describeOffer(facts.invite_offer.offer)}, so a "Get ${describeOffer(facts.invite_offer.offer, 'title').replace(/OFF$/, 'Off')}" headline is possible once the keyword pays it.`, [facts.invite_offer.evidence]);
    }
  }

  const callCsm = calls.filter((c) => c.classification === 'launch prep').flatMap((c) => c.rep_detail || []).find((r) => r.role === 'csm')?.name || null;
  const csmFull = loc.manager_name || callCsm || null;
  const csm = (csmFull || 'CSM').split(' ')[0];
  const name = loc.name;
  const questions = [];
  for (const f of flags) {
    switch (f.code) {
      case 'NO_CALL': questions.push(`${csm}: I could not find a call for ${name} in AskElephant. Was there a launch prep call, and what offer and quantities did they agree to?`); break;
      case 'TRANSCRIPT_PENDING': questions.push(`${csm}: the ${pending.map((c) => c.date).join(', ')} call for ${name} has no transcript yet. Anything decided there on the invite offer, tables, stalls, or sign wording?`); break;
      case 'OFFER_MISMATCH': questions.push(`${csm}: on the ${facts.invite_offer.call_date} call ${name} agreed to ${describeOffer(facts.invite_offer.offer)} for the signup, but the keyword still pays ${keyword?.title || 'nothing'}. OK for us to run offer set to ${describeOffer(facts.invite_offer.offer, 'title')} and print "Get ${describeOffer(facts.invite_offer.offer, 'title').replace(/OFF$/, 'Off')}"?`); break;
      case 'BIRTHDAY_PROMO_MISSING': questions.push(`${csm}: ${name} agreed to a free ${facts.birthday.item} birthday offer on the call. Should we load it as the birthday promotion?`); break;
      case 'QUANTITIES_UNCONFIRMED': questions.push(`${csm}: ${name} is at ${isDefault ? 'the wizard defaults ' : ''}tables ${q.tables} / stalls ${q.stalls} / tap cards ${q.tap_cards} and the call did not cover ${unconfirmed.join(', ')}. Can you confirm the counts before we print?`); break;
      case 'QUANTITIES_CONFLICT': questions.push(`${csm}: the call says ${conflicts.join('; ')} for ${name}. We will build to the call numbers unless you say otherwise.`); break;
      case 'COPY_REJECTED': questions.push(`${csm}: ${name} pushed back on "Join the club" on the call. What exact headline do they want on the stickers and POP?`); break;
      case 'COMBINE_LISTS': questions.push(`${csm}: ${name} asked to combine the store lists. Should the text club run at account scope for all locations?`); break;
      case 'SIBLING_IDENTICAL_QUANTITIES': questions.push(`${csm}: ${identical.map((s) => s.location_name).join(' and ')} ${identical.length === 1 ? 'has' : 'have'} an open request with the same counts as ${name} (tables ${q.tables} / stalls ${q.stalls} / to-go ${q.to_go}). Did each store really ask for an identical set, or was one order pasted across them?`); break;
      default: break;
    }
  }
  return { flags, csm_questions: questions, csm_dm: csmDmText({ csm, name, flags, questions }) };
}

// The CSM Slack DM for quantity or offer conflicts and identical sibling counts (Travisse
// voice: direct, no filler). null when none of those flags fired.
export function csmDmText({ csm, name, flags, questions }) {
  const hits = flags.map((f, i) => ({ f, q: questions[i] })).filter(({ f }) => CSM_DM_CODES.includes(f.code));
  if (!hits.length) return null;
  const strip = (q) => (q.startsWith(`${csm}:`) ? q.slice(csm.length + 1).trim() : q);
  const lines = [`Hey ${csm}, quick check on ${name} before the print order goes out:`, ''];
  for (const { q } of hits) lines.push(`- ${strip(q)}`);
  lines.push('', 'Holding the vendor email until you confirm. Thanks!');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// the fixed "Call facts" block runners paste into their report
export function callFactsBlock({ calls, facts, flags, questions, search, csm_dm = null }) {
  const L = [];
  const withT = calls.filter((c) => c.transcript_status === 'ok').length;
  L.push(`Call facts (${calls.length} calls matched, ${withT} with transcript; reps searched: ${(search?.reps_searched || []).map((r) => r.split(' ')[0]).join(', ')})`);
  L.push(`- Calls: ${calls.length ? calls.map((c) => `${c.date.slice(5).replace('-', '/')} ${c.classification} (${c.reps.length ? c.reps.map((r) => r.split(' ')[0]).join('+') : c.owner || 'unknown'}, ${c.duration_min} min${c.transcript_status === 'ok' ? '' : c.transcript_status === 'pending' ? ', transcript pending' : ', transcript short'})`).join('; ') : 'none found'}`);
  const io = facts.invite_offer;
  const codes = new Set(flags.map((f) => f.code));
  L.push(`- Invite offer: ${io ? `${describeOffer(io.offer)} (${io.strength}, ${io.call_date || ''}${io.source && io.source !== 'regex' ? `, ${io.source}` : ''}); ${io.live || ''}${codes.has('OFFER_MISMATCH') ? ' -> OFFER_MISMATCH' : ''}` : 'not discussed'}`);
  const b = facts.birthday;
  L.push(`- Birthday: ${b ? (b.status === 'free' ? `free ${b.item} (${b.strength || 'agreed'}, ${b.call_date || ''}); ${b.live || ''}${codes.has('BIRTHDAY_PROMO_MISSING') ? ' -> BIRTHDAY_PROMO_MISSING' : ''}` : b.status === 'off' ? `declined on the call (${b.call_date || ''})` : `discussed, not settled (${b.call_date || ''})`) : 'not discussed'}`);
  const qf = facts.quantities;
  L.push(`- Quantities: ${qf ? `tables ${qf.request.tables} / stalls ${qf.request.stalls} / tap cards ${qf.request.tap_cards}${qf.wizard_defaults ? ' = wizard defaults' : ''}; ${qf.confirmed.length ? `confirmed ${qf.confirmed.join(', ')}` : 'none confirmed'}${qf.conflicts.length ? `; CONFLICT ${qf.conflicts.join('; ')}` : ''}${qf.unconfirmed.length ? `; unconfirmed ${qf.unconfirmed.join(', ')}` : ''}${codes.has('QUANTITIES_UNCONFIRMED') ? ' -> QUANTITIES_UNCONFIRMED' : ''}${codes.has('QUANTITIES_CONFLICT') ? ' -> QUANTITIES_CONFLICT' : ''}` : 'n/a'}`);
  L.push(`- Sign copy: ${facts.sign_copy.lines.length ? (facts.sign_copy.rejected_join_the_club ? 'customer rejected "Join the club"' : facts.sign_copy.preference || 'discussed') + `; ${clip(facts.sign_copy.lines[0], 160)}` : 'not discussed'}`);
  L.push(`- Lists: ${facts.combine_lists ? (facts.combine_lists.agreed ? 'combine both stores\' lists OK' : 'combining lists discussed') + ` (${clip(facts.combine_lists.evidence[0] || '', 120)})` : 'single list, nothing said'}`);
  L.push(`- Not discussed: ${facts.not_discussed.length ? facts.not_discussed.join(', ') : 'nothing missing'}`);
  L.push(`- Flags: ${flags.length ? flags.map((f) => f.code).join(', ') : 'none'}`);
  for (const f of flags.filter((x) => x.command)) L.push(`  ${f.code}: ${f.command}`);
  L.push(`- CSM questions: ${questions.length ? questions.map((q, i) => `(${i + 1}) ${q}`).join(' ') : 'none'}`);
  L.push(`- CSM DM: ${csm_dm ? `drafted to call/csm-dm.txt (${flags.filter((f) => CSM_DM_CODES.includes(f.code)).map((f) => f.code).join(', ')}); the finish sends it` : 'not needed'}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
export async function loadCallsFromRunDir(runDir) {
  const callDir = path.join(runDir, 'call');
  const fc = JSON.parse(await fs.readFile(path.join(callDir, 'find-calls.json'), 'utf8'));
  const calls = [];
  for (const m of fc.matches) {
    let lines = [];
    if (m.transcript_file) {
      try { lines = parseTranscript(await fs.readFile(m.transcript_file, 'utf8')); } catch { lines = []; }
    }
    calls.push({ ...m, lines });
  }
  return { search: fc, calls };
}

function parseArgs(argv) {
  const args = { json: false, llm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (name === 'json' || name === 'llm') { args[name] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    i += 1;
    args[name] = value;
  }
  if (!args.runDir) throw new Error('--run-dir is required');
  args.runDir = path.resolve(args.runDir);
  args.llmModel = args.llmModel || 'fable';
  return args;
}

export async function runCallFacts({ runDir, locationId, llm = false, llmModel = 'fable' }) {
  const { search, calls } = await loadCallsFromRunDir(runDir);
  const locId = locationId || search.context?.location_id;
  if (!locId) throw new Error('No location id: pass --location-id (find-calls.json was built without one)');
  const req = await loadRequest(locId);
  const offers = await loadOffers(locId, req.location.account_id);
  let facts = extractFacts(calls);
  const llmResult = llm ? await llmPass(calls, facts, llmModel) : { ran: false, reason: 'not requested (--llm)' };
  facts = mergeLlm(facts, llmResult);
  let siblingRequests = [];
  if (req.request?.id) { try { siblingRequests = await loadSiblingRequests(req.location.account_id, req.request.id); } catch (e) { console.error(`warning: sibling request read failed: ${e.message}`); } }
  const { flags, csm_questions, csm_dm } = compareFacts({ facts, calls, req, offers, siblingRequests });
  const block = callFactsBlock({ calls, facts, flags, questions: csm_questions, search, csm_dm });
  const report = {
    generated_at: new Date().toISOString(),
    location: { id: req.location.id, name: req.location.name, account_id: req.location.account_id, csm: req.location.manager_name || null, csm_on_call: calls.filter((c) => c.classification === 'launch prep').flatMap((c) => c.rep_detail || []).find((r) => r.role === 'csm')?.name || null },
    request: req.request ? { id: req.request.id, offer_text: req.request.offer_text, created_at: req.request.created_at } : null,
    quantities: req.quantities,
    signup_keyword: offers.signup_keyword ? { keyword: offers.signup_keyword.keyword, promotion_id: offers.signup_keyword.promotion_id, title: offers.signup_keyword.title } : null,
    promotions: offers.promotions.map((p) => ({ id: p.id, title: p.title })),
    calls: calls.map(({ lines, ...c }) => c),
    facts,
    llm: llmResult,
    sibling_requests: siblingRequests.map(({ id, location_name, tables, stalls, to_go }) => ({ id, location_name, tables, stalls, to_go })),
    flags,
    csm_questions,
    csm_dm,
    call_facts_block: block,
  };
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runCallFacts({ runDir: args.runDir, locationId: args.locationId, llm: args.llm, llmModel: args.llmModel });
  const callDir = path.join(args.runDir, 'call');
  await fs.mkdir(callDir, { recursive: true });
  await fs.writeFile(path.join(callDir, 'call-facts.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(callDir, 'call-facts.md'), report.call_facts_block + '\n');
  const dmFile = path.join(callDir, 'csm-dm.txt');
  if (report.csm_dm) await fs.writeFile(dmFile, report.csm_dm + '\n');
  else await fs.rm(dmFile, { force: true }); // a stale draft must not be sent at closeout
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else { console.log(report.call_facts_block); console.log(`\nWritten: ${path.join(callDir, 'call-facts.json')}${report.csm_dm ? ` and ${dmFile} (CSM DM drafted)` : ''}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}
