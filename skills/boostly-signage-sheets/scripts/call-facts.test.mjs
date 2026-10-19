// node --test call-facts.test.mjs : compareFacts flags and the CSM DM draft, on fixtures (no DB, no run dir).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, compareFacts, csmDmText, callFactsBlock, CSM_DM_CODES } from './call-facts.mjs';
import { parseOffer } from './lib/v2-reads.mjs';

const req = (quantities, offer_text = 'Join the Club!') => ({
  location: { id: 'loc1', name: 'The Pig & Parrot (Hoboken)', account_id: 'acct1', manager_name: 'Jonathan Watkins' },
  request: { id: 'req1', offer_text },
  quantities: { tables: 10, stalls: 6, to_go: 2, tap_cards: 10, pop: 1, ...quantities },
});
const offers = { signup_keyword: null, promotions: [] };
const call = { id: 'c1', date: '2026-10-12', classification: 'launch prep', has_transcript: true, transcript_status: 'ok', lines: [], reps: [], rep_detail: [], duration_min: 20 };

test('SIBLING_IDENTICAL_QUANTITIES fires only on an exact non-zero match of tables, stalls and to-go', () => {
  const facts = extractFacts([]);
  const siblings = [
    { id: 'req2', location_name: 'The Pig & Parrot (Jersey City)', tables: 10, stalls: 6, to_go: 2 },
    { id: 'req3', location_name: 'Other', tables: 10, stalls: 4, to_go: 2 },
  ];
  const r = compareFacts({ facts, calls: [call], req: req({}), offers, siblingRequests: siblings });
  const flag = r.flags.find((f) => f.code === 'SIBLING_IDENTICAL_QUANTITIES');
  assert.ok(flag, 'flag present');
  assert.match(flag.summary, /Jersey City\) \(req2\)/);
  assert.doesNotMatch(flag.summary, /Other/);
  assert.deepEqual(facts.quantities.sibling_identical, [{ request_id: 'req2', location_name: 'The Pig & Parrot (Jersey City)' }]);
  assert.ok(r.csm_questions.some((q) => /Jersey City.*same counts/.test(q)));
  assert.ok(r.csm_dm && /^Hey Jonathan, quick check on The Pig & Parrot \(Hoboken\)/.test(r.csm_dm), r.csm_dm);
  assert.match(r.csm_dm, /^- The Pig & Parrot \(Jersey City\) has an open request/m);
  assert.doesNotMatch(r.csm_dm, /Jonathan:/, 'the DM drops the "csm:" prefix');
  // zero everywhere never matches; a mismatch never matches
  const zero = compareFacts({ facts: extractFacts([]), calls: [call], req: req({ tables: 0, stalls: 0, to_go: 0 }), offers, siblingRequests: [{ id: 'x', location_name: 'X', tables: 0, stalls: 0, to_go: 0 }] });
  assert.ok(!zero.flags.some((f) => f.code === 'SIBLING_IDENTICAL_QUANTITIES'));
  assert.equal(zero.csm_dm, null);
});

test('quantity and offer conflicts draft the DM; unconfirmed defaults alone do not', () => {
  const facts = extractFacts([]);
  facts.tables = { n: 12, evidence: '2026-10-12 launch prep [00:10] Owner: we have twelve tables', call_date: '2026-10-12' };
  facts.invite_offer = { offer: parseOffer('20% off'), strength: 'agreed', call_date: '2026-10-12', evidence: '2026-10-12 launch prep [00:12] Owner: twenty percent off is fine' };
  const r = compareFacts({ facts, calls: [call], req: req({}), offers });
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes('QUANTITIES_CONFLICT') && codes.includes('OFFER_MISMATCH'), codes.join(','));
  assert.match(r.csm_dm, /tables: request 10, call 12/);
  assert.match(r.csm_dm, /OK for us to run offer set to 20% OFF/);
  assert.match(r.csm_dm, /Holding the vendor email until you confirm/);
  assert.doesNotMatch(r.csm_dm, /[—–]/);
  const block = callFactsBlock({ calls: [call], facts, flags: r.flags, questions: r.csm_questions, search: {}, csm_dm: r.csm_dm });
  assert.match(block, /- CSM DM: drafted to call\/csm-dm.txt \(OFFER_MISMATCH, QUANTITIES_CONFLICT\)/);
  // wizard defaults with nothing confirmed: a question for the note, no DM
  const u = compareFacts({ facts: extractFacts([]), calls: [], req: req({}), offers });
  assert.ok(u.flags.some((f) => f.code === 'QUANTITIES_UNCONFIRMED'));
  assert.equal(u.csm_dm, null);
  assert.equal(csmDmText({ csm: 'Sam', name: 'X', flags: [{ code: 'NO_CALL' }], questions: ['Sam: q'] }), null);
  assert.deepEqual(CSM_DM_CODES, ['QUANTITIES_CONFLICT', 'OFFER_MISMATCH', 'SIBLING_IDENTICAL_QUANTITIES']);
});
