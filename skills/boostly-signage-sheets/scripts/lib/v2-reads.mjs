// lib/v2-reads.mjs: read-only V2 DB access and offer parsing shared by
// preflight.mjs, find-calls.mjs, and call-facts.mjs.
//
// Data access goes through the v2-database skill's `v2-db query` wrapper
// (credentials live in its own env file and are never printed here).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const V2_DB = new URL('../../../v2-database/bin/v2-db', import.meta.url).pathname;

export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function v2DbRows(sql) {
  const { stdout } = await execFileAsync(V2_DB, ['query', '--sql', sql, '--json'], { maxBuffer: 16 * 1024 * 1024 });
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

// Wizard defaults for a fresh box configuration. When a request carries exactly
// these and no call confirms them, the numbers are unconfirmed, not chosen.
export const WIZARD_DEFAULTS = { tables: 10, stalls: 6, tap_cards: 10 };

export async function loadRequest(locationId) {
  const [loc] = await v2DbRows(`
    select l.id, l.name, l.account_id, l.website_url, l.google_place_id, l.address, l.shipping_city, l.shipping_state,
           l.shipping_recipient_name, l.touchpoints_initialized_at::text as touchpoints_initialized_at,
           a.name as account_name, a.manager_user_id, mu.name as manager_name, mu.email as manager_email,
           a.hubspot_company_id
    from locations l
    join accounts a on a.id = l.account_id
    left join users mu on mu.id = a.manager_user_id
    where l.id = ${sqlLiteral(locationId)}
  `);
  if (!loc) throw new Error(`Location ${locationId} not found in V2 DB`);

  const requests = await v2DbRows(`
    select fr.id, fr.order_type, fr.offer_text, fr.offer_promotion_id, fr.notes, fr.created_at::text as created_at,
           fr.slack_thread_ts, fr.onboarding_session_id, fr.digital_fulfilled_at::text as digital_fulfilled_at,
           fr.tracking_number, fr.canceled_at::text as canceled_at, cu.name as created_by_name
    from fulfillment_requests fr
    left join users cu on cu.id = fr.created_by_user_id
    where fr.location_id = ${sqlLiteral(locationId)}
    order by (fr.canceled_at is null) desc, fr.created_at desc
  `);
  const request = requests[0] || null;
  let items = [];
  if (request) {
    items = await v2DbRows(`
      select item_type, placement, focus, quantity, printed_at::text as printed_at
      from fulfillment_items where fulfillment_request_id = ${sqlLiteral(request.id)}
      order by item_type, placement, focus
    `);
  }
  const qty = (pred) => items.filter(pred).reduce((max, it) => Math.max(max, Number(it.quantity) || 0), 0);
  const quantities = {
    tables: qty((it) => it.item_type === 'stickers' && it.placement === 'table'),
    stalls: qty((it) => it.item_type === 'stickers' && it.placement === 'bathroom'),
    to_go: qty((it) => it.item_type === 'stickers' && it.placement === 'to_go'),
    tap_cards: qty((it) => it.item_type === 'tapcards'),
    pop: qty((it) => it.item_type === 'signage'),
  };

  let session = null;
  if (request?.onboarding_session_id) {
    const [s] = await v2DbRows(`
      select id, status, completed_at::text as completed_at,
             (account_settings_payload - 'branding' - 'gbp_locations')::text as box_payload,
             (select string_agg(coalesce(v->'shipping_address'->>'recipient_name',''), ', ')
                from jsonb_each(coalesce(account_settings_payload->'gbp_locations','{}'::jsonb)) as g(k, v)) as recipient_names
      from onboarding_sessions where id = ${sqlLiteral(request.onboarding_session_id)}
    `);
    if (s) {
      let box = null;
      try { box = JSON.parse(s.box_payload || 'null'); } catch { box = null; }
      session = { id: s.id, status: s.status, completed_at: s.completed_at, box_configurations: box?.box_configurations || null, recipient_names: s.recipient_names || '' };
    }
  }

  const users = await v2DbRows(`
    select u.name, u.email, u.phone, au.role
    from account_users au join users u on u.id = au.user_id
    where au.account_id = ${sqlLiteral(loc.account_id)} and au.deleted_at is null and u.deleted_at is null
    order by au.created_at
  `);

  // Enrollment (contract) session: the signer and TFV contact are often the
  // only names the CSM's AskElephant call carries ("Call with Keshia Davis").
  const enrollments = await v2DbRows(`
    select id, tfv_first_name, tfv_last_name, tfv_email, tfv_dba, tfv_legal_name, contract_signed_by,
           tfv_address_city, tfv_business_website, created_at::text as created_at
    from enrollment_sessions where created_account_id = ${sqlLiteral(loc.account_id)}
    order by created_at desc
  `);

  const siblings = await v2DbRows(`
    select l.id, l.name, l.status,
           (select count(*)::int from fulfillment_requests fr where fr.location_id = l.id and fr.canceled_at is null
              and (fr.digital_fulfilled_at is not null or fr.tracking_number is not null)) as prior_fulfillments,
           (select max(fr.created_at)::text from fulfillment_requests fr where fr.location_id = l.id) as last_request_at
    from locations l
    where l.account_id = ${sqlLiteral(loc.account_id)} and l.id <> ${sqlLiteral(locationId)} and l.is_general = false
    order by l.created_at
  `);

  return { location: loc, request, items, quantities, session, users, enrollments, siblings, all_requests: requests.length };
}

export async function loadOffers(locationId, accountId) {
  const keywords = await v2DbRows(`
    select k.id, k.keyword, k.type, k.promotion_id, k.offer_expires_in_days, p.title, p.description, p.estimated_value
    from keywords k left join promotions p on p.id = k.promotion_id
    where k.location_id = ${sqlLiteral(locationId)} and k.deleted_at is null and k.keyword ilike 'SUBSCRIBE%'
    order by k.created_at
  `);
  const subscribeLinks = await v2DbRows(`
    select sl.id, sl.name, sl.attribution_source, sl.keyword_id, k.keyword, k.promotion_id, p.title as promotion_title
    from subscribe_links sl
    left join keywords k on k.id = sl.keyword_id
    left join promotions p on p.id = k.promotion_id
    where sl.location_id = ${sqlLiteral(locationId)} and sl.deleted_at is null
    order by sl.created_at
  `);
  const promotions = await v2DbRows(`
    select id, title, description, estimated_value, created_at::text as created_at
    from promotions where account_id = ${sqlLiteral(accountId)} and deleted_at is null
    order by created_at
  `);
  const inviteTemplates = await v2DbRows(`
    select ct.id, ct.meta::text as meta, ct.created_at::text as created_at,
           (select string_agg(coalesce(p.title, '(no promotion)') || ' [' || cmd.name || ']', ' | ')
              from campaign_message_data cmd left join promotions p on p.id = cmd.promotion_id
              where cmd.campaign_template_id = ct.id) as message_offers
    from campaign_templates ct
    where ct.account_id = ${sqlLiteral(accountId)} and ct.type = 'invite' and ct.deleted_at is null
    order by ct.created_at desc
  `);
  const invite = inviteTemplates.map((t) => {
    let meta = null;
    try { meta = JSON.parse(t.meta); } catch { meta = t.meta; }
    return { id: t.id, created_at: t.created_at, message_offers: t.message_offers, meta };
  });
  const signup = keywords[0] || null;
  const textClub = subscribeLinks.find((s) => s.attribution_source === 'touchpoint') || null;
  return {
    signup_keyword: signup,
    text_club_subscribe_link: textClub,
    subscribe_links: subscribeLinks,
    promotions,
    invite_templates: invite,
  };
}

// ---------------------------------------------------------------------------
// offer parsing
export const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
export const NUMBER_WORD_RE = Object.keys(WORD_NUMBERS).join('|');

export function parseNumberToken(tok) {
  const t = tok.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUMBERS[t] ?? null;
}

const GENERIC_OFFER = /^join the club!?$/i;
export function isGenericOffer(text) {
  return !text || !text.trim() || GENERIC_OFFER.test(text.trim());
}

// "$10 OFF" -> {kind:'dollar', amount:10}; "20% Off" -> {kind:'pct', amount:20};
// "Free appetizer" -> {kind:'free', item:'appetizer'}; anything else -> {kind:'phrase'}
export function parseOffer(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  let m = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:off|discount)?/i);
  if (m && /\$/.test(t)) return { kind: 'dollar', amount: Number(m[1]), raw: t };
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:off|discount)?/i);
  if (m) return { kind: 'pct', amount: Number(m[1]), raw: t };
  m = t.match(/\bfree\s+([a-z' -]+?)\s*$/i);
  if (m) return { kind: 'free', item: m[1].trim().toLowerCase(), raw: t };
  if (/\bfree\b/i.test(t)) return { kind: 'free', item: t.replace(/.*\bfree\b\s*/i, '').toLowerCase(), raw: t };
  return { kind: 'phrase', raw: t };
}

export function sameOffer(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'phrase') return a.raw.trim().toLowerCase() === b.raw.trim().toLowerCase();
  if (a.kind === 'free') return a.item.replace(/s$/, '') === b.item.replace(/s$/, '') || a.item.includes(b.item) || b.item.includes(a.item);
  return a.amount === b.amount;
}

export function findPromotionFor(offer, promotions) {
  if (!offer) return null;
  return promotions.find((p) => sameOffer(offer, parseOffer(p.title))) || null;
}

export function describeOffer(o, style = 'short') {
  if (!o) return '';
  if (o.kind === 'pct') return style === 'title' ? `${o.amount}% OFF` : `${o.amount}%`;
  if (o.kind === 'dollar') return style === 'title' ? `$${o.amount} OFF` : `$${o.amount}`;
  if (o.kind === 'free') return style === 'title' ? `Free ${o.item}` : `free ${o.item}`;
  return o.raw || '';
}

// The exact boostly-links command that makes the signup pay `offer`.
export function offerSetCommand(locationId, offer) {
  if (!offer || offer.kind === 'phrase') return null;
  const title = describeOffer(offer, 'title');
  const code = offer.kind === 'free' ? 'FREE' + offer.item.replace(/[^a-z]/gi, '').slice(0, 8).toUpperCase() : `SAVE${offer.amount}`;
  const value = offer.kind === 'free' ? '<estimated-value>' : offer.amount;
  return `boostly-links offer set ${locationId} --title ${JSON.stringify(title)} --code ${code} --value ${value} --cookie-file <cookie-file> --apply`;
}
