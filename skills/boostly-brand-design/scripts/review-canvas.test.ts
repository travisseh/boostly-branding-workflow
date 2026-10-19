import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approvedWebsiteSwap, buildLinkRows, candidateSource, collectPreviews, compareDefaultLetters, defaultFlag, displayUrl, evidenceWords, linkVerdict, overviewLinkChips, parsePreviewName, parsePromptsVerdicts, pickStatus, previewsSection } from './review-canvas.mjs';

test('parsePreviewName reads scene and letter and tolerates suffixes', () => {
  assert.deepEqual(parsePreviewName('signage-preview-K.png'), { kind: 'signage', scene: 'signage preview', letter: 'K', suffix: null, name: 'signage-preview-K' });
  assert.deepEqual(parsePreviewName('box-K.png'), { kind: 'mockup', scene: 'box', letter: 'K', suffix: null, name: 'box-K' });
  assert.deepEqual(parsePreviewName('box-K-red.png'), { kind: 'mockup', scene: 'box', letter: 'K', suffix: 'red', name: 'box-K-red' });
  assert.equal(parsePreviewName('scan-q.png')?.letter, 'Q');
  assert.equal(parsePreviewName('badges-Y-v2.png')?.scene, 'badges');
  for (const other of ['default-cell.png', 'logo-3x.png', 'variant-sheet-marked.png', 'compare-K-M-P.png', 'new-cells-YZ-zoom-3x.png', 'blue-cells-3x.png', 'google-maps-photos.png', 'box-K.log']) {
    assert.equal(parsePreviewName(other), null, other);
  }
});

test('parsePromptsVerdicts reads table rows and harness headings, placeholder never wins', () => {
  const md = `# Mockups
| output | ref | size | verdict |
|---|---|---|---|
| box-K.png | refs/box-ref-K.png | 1600x2400 | HELD: layout exact; QR minor drift |
| scan-R.png | refs/sticker-R.png | 1600x2400 | Sticker HELD. Phone INVENTED: fake domain |

### Box prompt (K and R)
- verdict: this bullet belongs to a prompt heading and must be ignored

## box-Q (2026-09-21T21:57:14.732Z)
- ref: x
- verdict: (fill in after 3x zoom check: QR intact? wordmark exact?)

## box-K (2026-09-21T22:00:00.000Z)
- verdict: (fill in after 3x zoom check)

## table-R (2026-09-21T22:01:00.000Z)
- drift: added a background sign
`;
  const v = parsePromptsVerdicts(md);
  assert.equal(v.get('box-k')?.verdict, 'HELD: layout exact; QR minor drift');
  assert.equal(v.get('box-k')?.placeholder, false);
  assert.equal(v.get('scan-r')?.verdict, 'Sticker HELD. Phone INVENTED: fake domain');
  assert.equal(v.get('box-q')?.placeholder, true);
  assert.equal(v.get('table-r')?.verdict, 'added a background sign');
  assert.equal(v.has('box prompt'), false);
});

test('collectPreviews groups by letter and previewsSection builds one header per letter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-canvas-'));
  try {
    const review = path.join(dir, 'review');
    await mkdir(path.join(review, 'mockups', 'refs'), { recursive: true });
    for (const f of ['signage-preview-K.png', 'signage-preview-R.png', 'default-cell.png', 'compare-K-R.png']) await writeFile(path.join(review, f), '');
    for (const f of ['box-K.png', 'box-K-red.png', 'scan-K.png', 'table-R.png', 'box-K.log']) await writeFile(path.join(review, 'mockups', f), '');
    await writeFile(path.join(review, 'mockups', 'refs', 'box-ref-K.png'), '');
    await writeFile(path.join(review, 'mockups', 'prompts.md'), '| output | verdict |\n|---|---|\n| box-K.png | HELD |\n');
    const previews = await collectPreviews(review);
    assert.deepEqual(Object.keys(previews.letters).sort(), ['K', 'R']);
    assert.equal(path.basename(previews.letters.K.signage), 'signage-preview-K.png');
    assert.deepEqual(previews.letters.K.mockups.map((m) => m.name), ['box-K', 'box-K-red', 'scan-K']);
    assert.equal(previews.letters.R.mockups.length, 1);
    assert.equal(previews.verdicts.get('box-k')?.verdict, 'HELD');

    const sheet = { fable_default_letter: 'A', applied_letter: 'K', marks: [{ letter: 'K', status: 'travisse_pick' }], cells: {
      K: { primary: '#CF000B', secondary: '#263950', text: '#FFFFFF', row_label: 'card knockout', secondary_source: 'override', status: 'travisse_pick' },
      R: { primary: '#CF000B', secondary: '#1A2A3F', text: '#FFFFFF', row_label: 'card knockout' },
    } };
    assert.deepEqual(pickStatus('K', sheet, {}), ['TRAVISSE PICK', 'applied']);
    assert.deepEqual(pickStatus('A', sheet, {}), ['FABLE PICK']);
    assert.deepEqual(pickStatus('R', sheet, {}), []);

    const sec = previewsSection({ runDir: dir, reviewDir: review, previews, sheet, run: {}, provenanceWords: (s) => s });
    assert.equal(sec.id, 'previews');
    assert.equal(sec.sizeGated, true);
    const headers = sec.parts.filter((p) => p.type === 'text').map((p) => p.items[0].text);
    assert.equal(headers[0], 'Cell K  TRAVISSE PICK, applied');
    assert.equal(headers[1], 'Cell R');
    assert.match(sec.parts[0].items[1].text, /^card knockout\. card #CF000B on #263950, text #FFFFFF/);
    assert.equal(sec.parts.filter((p) => p.type === 'image').length, 2);
    const grids = sec.parts.filter((p) => p.type === 'grid');
    assert.equal(grids.length, 2);
    assert.match(grids[0].items[0].label, /HELD/);
    assert.match(grids[0].items[1].label, /box \(AI\) · red/);
    assert.match(grids[0].items[2].label, /no verdict line/);
    assert.equal(sec.links[0].url, 'mockups/prompts.md');

    // previews are post-pick: no files means no section, and never a "how to generate" hint
    const empty = previewsSection({ runDir: dir, reviewDir: review, previews: { letters: {}, promptsFile: null, verdicts: new Map() }, sheet, run: {} });
    assert.equal(empty, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('evidenceWords turns report evidence keys into plain words', () => {
  const words = evidenceWords({
    page_evidence: { title: 'Home - Dogwood Pizza - Pizza Restaurant in Lawrenceville, GA', h1: ['DOGWOOD PIZZA'] },
    location_match_evidence: ['official_website_links_to_candidate=true', 'url_slug_or_provider_domain_matches_location=true'],
    validity_evidence: ['final_url=https://x.com/dogwoodpizza', 'http_status=403', 'security_or_bot_challenge_detected=true'],
    liveness: 'challenge',
    rejection_reason: 'Bot or security challenge blocked automated verification; the page may be live and needs a human check.',
  });
  assert.equal(words[0], 'title "Home - Dogwood Pizza - Pizza Restaurant in Lawrenceville, GA"');
  assert.ok(words.includes('the website links to it'));
  assert.ok(words.includes('URL slug names the business'));
  assert.ok(words.includes('HTTP 403'));
  assert.ok(words.includes('bot challenge blocked the automated check'));
  assert.ok(!words.some((w) => /final_url|challenge_signal/.test(w)));
  assert.deepEqual(evidenceWords({ page_evidence: {}, source_evidence: ['link_source=anchor'], rejection_reason: 'claude_chrome_result_missing: https://a.b/c' }), ['found as an anchor', 'no live Chrome result yet for https://a.b/c']);
  assert.deepEqual(evidenceWords(null), []);
});

test('buildLinkRows merges run.json links, report category_results, and pending browser URLs', () => {
  const rows = buildLinkRows({
    links: {
      website_bootstrap: { status: 'held', places_website_uri: 'http://dogwood.pizza/', resolves_to: 'https://www.dogwood.pizza/ (Popmenu)', apply: 'HELD: closeout applies it' },
      ordering_url_match: { stored: 'https://order.toasttab.com/online/dogwoodpizza', match: true },
      candidates: [
        { category: 'facebook', url: 'https://www.facebook.com/dogwoodpizza/', verification_status: 'verified_live_tab', action: 'hold', hold_reason: 'held with all writes' },
        { category: 'careers_jobs', url: 'https://form.jotform.com/1', verification_status: 'existing_verified', action: 'preserve' },
        { category: 'tiktok', url: 'https://www.tiktok.com/@someone', verification_status: 'found_rejected', action: 'skip', hold_reason: 'personal account' },
        { category: 'catering', url: null, verification_status: 'no_candidate', action: 'none', hold_reason: 'no catering page' },
      ],
      execution: [
        { operation: { type: 'location_update', field: 'website_url', value: 'http://dogwood.pizza/' }, outcome: 'held', reason: 'fulfill-location holds all link writes' },
        { operation: { type: 'branding_socials', instagram_url: 'https://www.instagram.com/dogwoodpizza/' }, outcome: 'applied', reason: 'closeout wrote it' },
      ],
      not_found: ['youtube'],
    },
    categoryResults: [
      { category: 'x_twitter', category_status: 'found_verified', proposed_action: 'create', selected_link: { final_url: 'https://x.com/dogwoodpizza', location_match_evidence: ['official_website_links_to_candidate=true'], page_evidence: {} } },
      { category: 'order', category_status: 'existing_needs_manual_review', proposed_action: 'noop', existing_link: { final_url: 'https://order.toasttab.com/online/dogwoodpizza', rejection_reason: 'Bot challenge blocked the check.', validity_evidence: ['security_or_bot_challenge_detected=true'], page_evidence: { title: 'Just a moment...' } } },
      { category: 'menu', category_status: 'needs_manual_review', proposed_action: 'noop', selected_link: { final_url: 'https://www.dogwood.pizza/lawrenceville-menu/', rejection_reason: 'claude_chrome_result_missing', page_evidence: {} } },
      { category: 'reservations', category_status: 'not_found', proposed_action: 'noop', selected_link: null },
      { category: 'catering', category_status: 'found_rejected', proposed_action: 'noop', selected_link: { final_url: 'https://www.dogwood.pizza/', page_evidence: { title: 'Home' } } },
      { category: 'facebook', category_status: 'needs_manual_review', proposed_action: 'noop', selected_link: { final_url: 'https://www.facebook.com/dogwoodpizza', page_evidence: {}, rejection_reason: 'claude_chrome_result_missing: https://www.facebook.com/dogwoodpizza' } },
    ],
    pendingUrls: ['https://www.dogwood.pizza/lawrenceville-menu/', 'https://www.facebook.com/dogwoodpizza/'],
  });
  const by = Object.fromEntries(rows.map((r) => [r.category, r]));
  assert.deepEqual(rows.map((r) => r.category), ['website', 'ordering', 'menu', 'facebook', 'instagram', 'x_twitter', 'tiktok', 'youtube', 'careers_jobs', 'catering', 'reservations']);
  assert.equal(by.website.status.kind, 'held');
  assert.equal(by.website.url, 'http://dogwood.pizza/');
  assert.match(by.website.reason, /holds all link writes/);
  assert.equal(by.ordering.status.kind, 'held'); // report says manual review; 'order' merged into ordering
  assert.equal(by.ordering.evidence[0], 'stored ordering URL matches the website');
  assert.equal(by.menu.status.kind, 'pending');
  assert.equal(by.facebook.status.kind, 'held'); // the agent's hold wins over a pending browser check
  assert.equal(by.tiktok.url, 'https://www.tiktok.com/@someone');
  assert.equal(by.catering.url, null);
  assert.equal(by.instagram.status.kind, 'written');
  assert.equal(by.instagram.url, 'https://www.instagram.com/dogwoodpizza/');
  assert.equal(by.x_twitter.status.kind, 'ready');
  assert.ok(by.x_twitter.evidence.includes('the website links to it'));
  assert.equal(by.tiktok.status.kind, 'rejected');
  assert.equal(by.tiktok.status.words, 'rejected: personal account'); // the grey chip carries the reason
  assert.equal(by.youtube.status.kind, 'none');
  assert.equal(by.careers_jobs.status.kind, 'existing');
  assert.equal(by.catering.status.kind, 'none');
  assert.equal(by.reservations.status.kind, 'none');
  assert.equal(by.website.status.chip, '#B7791F');
  assert.equal(by.instagram.status.chip, '#1B5E20');
  assert.equal(by.menu.status.chip, '#6B6B6B');
  assert.equal(buildLinkRows().length, 0);
});

test('buildLinkRows: rejected decisions (reason_code + reason) render a grey reason chip and never count as held', () => {
  const rows = buildLinkRows({
    links: {
      candidates: [
        { category: 'instagram', url: 'https://www.instagram.com/Chuys/', verification_status: 'rejected', action: 'reject', reason_code: 'identity_mismatch', reason: 'nameless personal account: 32 followers, 0 following, no bio, no website, dog and selfie photos', evidence: ['live tab 2026-09-22'] },
        { category: 'ordering', url: 'https://www.toasttab.com/local/order/chuys/r-1', verification_status: 'existing_verified', action: 'preserve', reason: 'stored ordering_url renders the Toast menu' },
        { category: 'youtube', url: null, verification_status: 'not_found', action: 'not_found', reason: 'no candidate' },
      ],
    },
    categoryResults: [
      { category: 'order', category_status: 'existing_needs_manual_review', proposed_action: 'noop', existing_link: { final_url: 'https://www.toasttab.com/local/order/chuys/r-1', rejection_reason: 'Bot challenge blocked the check.', validity_evidence: ['security_or_bot_challenge_detected=true'], page_evidence: {} } },
      { category: 'instagram', category_status: 'needs_manual_review', proposed_action: 'noop', selected_link: { final_url: 'https://www.instagram.com/Chuys/', rejection_reason: 'did not independently confirm the business', page_evidence: {} } },
    ],
  });
  const by = Object.fromEntries(rows.map((r) => [r.category, r]));
  assert.equal(by.instagram.status.kind, 'rejected');
  assert.equal(by.instagram.status.chip, '#6B6B6B');
  assert.match(by.instagram.status.words, /^rejected: identity mismatch: nameless personal account/);
  assert.ok(by.instagram.status.words.length <= 84);
  assert.deepEqual(by.instagram.evidence, ['live tab 2026-09-22']);
  assert.equal(by.ordering.status.kind, 'existing'); // the decision wins over the report's manual-review status
  assert.equal(by.youtube.status.kind, 'none');
  assert.equal(rows.filter((r) => r.status.kind === 'held').length, 0);
});

test('displayUrl strips scheme and www and middle-truncates long paths', () => {
  assert.equal(displayUrl('https://www.bc.pizza/'), 'bc.pizza/');
  assert.equal(displayUrl('http://bc.pizza/locations/harbor-springs/'), 'bc.pizza/locations/harbor-springs/');
  const long = displayUrl('https://www.theknot.com/marketplace/catering-harbor-springs-mi/food-truck/some/very/long/path/that/keeps/going', 60);
  assert.ok(long.length <= 60, long);
  assert.ok(long.includes('…'));
  assert.ok(long.startsWith('theknot.com/'));
  assert.ok(long.endsWith('keeps/going'));
});

test('candidateSource: real URL wins, first-party falls back to the website, local files show the file name with no link', () => {
  assert.deepEqual(candidateSource({ source_url: 'https://www.facebook.com/x/photos/123', provenance: 'facebook' }), { url: 'https://www.facebook.com/x/photos/123', text: 'facebook.com/x/photos/123' });
  assert.deepEqual(candidateSource({ source: 'Instagram avatar from instagram.com/hsbcpizza', provenance: 'instagram' }), { url: 'https://instagram.com/hsbcpizza', text: 'instagram.com/hsbcpizza' });
  assert.deepEqual(candidateSource({ source: 'franchisor site header logo bc-pizza-logo-2x.png', provenance: 'first_party_header' }, 'https://bc.pizza/'), { url: 'https://bc.pizza/', text: 'bc.pizza/' });
  assert.deepEqual(candidateSource({ source: 'onboarding wizard attachment logo-final.png, white knockout', provenance: 'wizard', local_path: '/tmp/x/01-wizard.png' }, 'https://bc.pizza/'), { url: null, text: 'file logo-final.png' });
  assert.deepEqual(candidateSource({ source: 'traced from the sign', provenance: 'gbp', local_path: '/tmp/x/03-gbp-trace.png' }, null), { url: null, text: 'file 03-gbp-trace.png' });
  assert.deepEqual(candidateSource(null), { url: null, text: null });
});

test('linkVerdict gives a one-line closeout verdict per status and strips operator command text', () => {
  const fb = linkVerdict({ status: { kind: 'ready' }, evidence: [], reason: "Page title 'Harbor Springs B.C. Pizza | Harbor Springs MI', 1.3K followers, intro 'Hometown, Handmade, Gourmet', address 930 State St Unit 9, Harbor Springs, MI 49740 (matches Places), phone (231) 526-2424 (matches Places), email x@y.z, website bc.pizza, avatar is the franchise badge. Discovery only surfaced facebook.com/tr (the site's tracking pixel): rejected. Write via branding set --facebook-url at closeout." });
  assert.equal(fb, "Will be written at closeout. Matches the store's address and phone.");
  assert.equal(linkVerdict({ status: { kind: 'rejected' }, evidence: [], reason: 'Meta pixel endpoint from the site\'s script tag, not a page.' }), 'Rejected: Meta pixel endpoint from the site\'s script tag, not a page.');
  const held = linkVerdict({ status: { kind: 'held' }, evidence: [], reason: 'Question for Travisse: replace the stored ordering_url (the HungerRush login page) with the store page\'s Order Online link? The destination could not be read. Write via location set --ordering-url at closeout.' });
  assert.equal(held, "Held: replace the stored ordering_url (the HungerRush login page) with the store page's Order Online link? Needs a yes to proceed.");
  assert.equal(linkVerdict({ status: { kind: 'written' }, evidence: ['the website links to it'], reason: null }), "Written to the location. Linked from the store's own website.");
  assert.equal(linkVerdict({ status: { kind: 'existing' }, evidence: [], reason: 'stored ordering_url renders the Toast menu' }), 'Already on the location, kept as is. stored ordering_url renders the Toast menu');
  assert.equal(linkVerdict({ status: { kind: 'pending' }, evidence: [], reason: 'waiting on the live Chrome check' }), 'Waiting on the live browser check before a decision.');
  assert.equal(linkVerdict({ status: { kind: 'none' }, evidence: [], reason: '' }), 'Nothing found.');
  assert.equal(linkVerdict({ status: 'none', evidence: [], reason: 'No first-party gift card page found. Dry run recorded.' }), 'Nothing found. No first-party gift card page found.');
  assert.ok(!/--|branding set|location set/.test(fb + held));
});

test('overviewLinkChips keeps written, live, ready, existing and held rows only, with bare hosts', () => {
  const rows = buildLinkRows({ links: { candidates: [
    { category: 'website', url: 'https://bc.pizza/', action: 'ready', reason: 'Places websiteUri' },
    { category: 'ordering', url: 'https://bcpizzaus.hungerrush.com/Order/Menu/1009', action: 'hold', reason: 'Question for Travisse: replace it?' },
    { category: 'ordering_rejected_stored_login_page', url: 'https://bcpizzaus.hungerrush.com/Account/LogOn', action: 'reject', reason: 'login wall' },
    { category: 'facebook_rejected_pixel', url: 'https://www.facebook.com/tr', action: 'reject', reason: 'tracking pixel' },
    { category: 'careers_jobs', url: 'https://bc.pizza/join-the-team/', action: 'ready', reason: 'linked from the store page' },
    { category: 'events', url: null, action: 'none', reason: 'none' },
  ] } });
  const chips = overviewLinkChips(rows);
  assert.deepEqual(chips.map((c) => [c.label, c.host, c.tag]), [['Website', 'bc.pizza/', null], ['Ordering', 'bcpizzaus.hungerrush.com/Order/Menu/1009', 'held'], ['Careers', 'bc.pizza/join-the-team/', null]]);
  assert.ok(rows.every((r) => typeof r.verdict === 'string' && r.verdict.length));
});

test('buildLinkRows: an approved website swap shows the approved URL as a ready row and says what it replaces', () => {
  const wb = { status: 'swap_approved_by_travisse', stored_website_url: 'http://www.creamerbykay.com/', places_website_uri: 'http://www.creamerbykay.com/', approved_website_url: 'https://creamerbykay.com/', closeout_action: 'At closeout, write location website_url = https://creamerbykay.com/' };
  assert.deepEqual(approvedWebsiteSwap(wb), { url: 'https://creamerbykay.com/', stored: 'http://www.creamerbykay.com/', note: 'replaces stored www.creamerbykay.com/ (approved)' });
  assert.equal(approvedWebsiteSwap({ status: 'held', places_website_uri: 'http://x.com/' }), null);
  const rows = buildLinkRows({ links: { website_bootstrap: wb } });
  const site = rows.find((r) => r.category === 'website');
  assert.equal(site.url, 'https://creamerbykay.com/');
  assert.equal(site.status.kind, 'ready');
  assert.deepEqual(site.evidence, ['replaces stored www.creamerbykay.com/ (approved)']);
  assert.match(site.verdict, /Will be written at closeout/);
  const chip = overviewLinkChips(rows).find((c) => c.label === 'Website');
  assert.equal(chip.url, 'https://creamerbykay.com/');
  assert.equal(chip.tag, null);
});

test('buildLinkRows: execution skipped_existing is a decided no-write, never held (Park Avenue BBQ 2026-10-19)', () => {
  const rows = buildLinkRows({
    links: {
      execution: [
        { outcome: 'skipped_existing', operation: { action: 'ready', category: 'website', url: 'https://www.pabbqgrille.com/' } },
        { outcome: 'skipped_existing', operation: { action: 'reject', category: 'gift_cards', url: 'https://order.toasttab.com/egiftcards/x' } },
        { outcome: 'applied', operation: { action: 'ready', category: 'facebook', url: 'https://www.facebook.com/PABBQ' } },
        { outcome: 'held', operation: { action: 'hold', category: 'tiktok', url: 'https://www.tiktok.com/@x' } },
      ],
    },
  });
  const by = Object.fromEntries(rows.map((r) => [r.category, r.status.kind ?? r.status]));
  assert.equal(by.website, 'existing');
  assert.equal(by.gift_cards, 'rejected');
  assert.equal(by.facebook, 'written');
  assert.equal(by.tiktok, 'held');
});

test('compareDefaultLetters: the default first, then the strongest passing cell of every other row (dark-step and site-token columns included), ties to the column nearest the default, rejected cells never', () => {
  const cell = (letter, row, column_index, contrast, extra = {}) => ({ letter, row, column_index, badge_digit_web: { contrast_with_text: contrast, pass: contrast >= 3 }, ...extra });
  const sheet = {
    fable_default_letter: 'B',
    rows: [{ key: 'knockout' }, { key: 'full_color' }, { key: 'dark_ground', primary_source: 'dark_ground' }, { key: 'empty_row' }, { key: 'all_fail' }],
    columns: [{ index: 0, source: 'fable_chosen' }, { index: 1, source: 'depth_darker_10' }, { index: 2, source: 'site_token' }],
    cells: {
      A: cell('A', 'knockout', 0, 4.1), B: cell('B', 'knockout', 1, 5.2), C: cell('C', 'knockout', 2, 6.0),
      D: cell('D', 'full_color', 0, 4.1), E: cell('E', 'full_color', 1, 2.5), F: cell('F', 'full_color', 2, 7.3), // site-token column wins
      G: cell('G', 'dark_ground', 0, 5.0), H: cell('H', 'dark_ground', 2, 5.0), // tie: column 0 is nearer the default's column 1
      I: cell('I', 'all_fail', 0, 2.1), J: cell('J', 'all_fail', 1, 2.8), // nothing passes: the best failing one
      K: cell('K', 'full_color', 1, 9.9, { status: 'rejected' }),
    },
  };
  assert.deepEqual(compareDefaultLetters(sheet, 'B'), ['B', 'F', 'G', 'J']);
  assert.deepEqual(compareDefaultLetters(sheet, null), []);
  assert.deepEqual(compareDefaultLetters(sheet, 'Z'), []);
});

test('defaultFlag: a small-source trace is a flag on the default (sheet.default_flag, else the decision marks), never without a default; an old hold manifest has no default and no flag', () => {
  const marks = { traced_from_small_source: true, source_native_longest_px: 499 };
  assert.deepEqual(defaultFlag({ decision_marks: marks }, {}, 'A'), { letter: 'A', flag: 'traced_from_small_source', native_px: 499, words: 'traced from 499px' });
  assert.deepEqual(defaultFlag({}, { decision: { marks } }, 'A')?.words, 'traced from 499px');
  assert.equal(defaultFlag({ default_flag: { letter: 'A', flag: 'traced_from_small_source', native_px: 300 } }, {}, 'A')?.native_px, 300);
  assert.equal(defaultFlag({ default_flag: { letter: 'B', flag: 'traced_from_small_source', native_px: 300 }, decision_marks: { traced_from_small_source: false } }, {}, 'A'), null);
  assert.equal(defaultFlag({ decision_marks: { traced_from_small_source: false } }, {}, 'A'), null);
  assert.equal(defaultFlag({ hold: { letter: 'A', native_px: 499 }, decision_marks: marks }, {}, null), null, 'old manifest: hold, no default');
});
