// figma-recopy.js — use_figma code template: retrofit OFFER COPY onto an
// ALREADY BUILT Boostly signage section (boostly-signage-sheets skill).
//
// Paste the whole file into `use_figma` (skillNames "figma-use") after
// substituting the three parameters below, or let the CLI fill them in:
//   node figma-recopy.mjs --section 2102:39168 --offer '$10 OFF' [--mode auto|discount|phrase|generic]
//
// PARAMETERS (substituted verbatim, keep the quotes):
//   SECTION_ID  '__SECTION_ID__'  section node id ("2102:39168")
//   OFFER       __OFFER_JSON__    the request offer_text as a JSON string ("$10 OFF")
//   MODE        '__MODE__'        auto | discount | phrase | generic
//
// MODE=auto mirrors plan.mjs specificOfferCopy():
//   discount ("$10 OFF", "20% Off", "Free Dessert")  -> headline "Get <offer>" (OFF -> Off)
//       on every table promo sticker (default 90/100 + 50/60 layout; a headline that wraps at
//       90 takes the two-line 74/42 layout with the body at y=274) and both POP
//       titles; POP body = "Scan to join our text club / for ongoing offers!" (no VIP).
//   phrase ("Unlock the V.I.P Experience", "Tillie's Special Offers") -> title verbatim
//       on stickers using the phrase layout (one-line 82/50 at y=216 if the title fits
//       788px at 82, else two-line 74/42 at y=274; body = POP VIP body line) and POP
//       title verbatim + VIP body. Review-style phrases ("Had a good time? Let us
//       know!") are POP-only: stickers get the generic default.
//   generic (empty / "Join the Club!") -> Cam defaults everywhere ("Join the club!"
//       90/100, "Be the first to know. / Receive exclusive deals." 50/60 at y=216,
//       POP "Join the club!" + VIP body).
// The POP title is auto-fit to ONE line at 1260px wide: 140 first, stepping down
// by 10 to a floor of 80 (matches shipped Fahrenheit=100 / Tillie's=130). A phrase
// that still wraps at 80 gets a TWO-line title (largest of 130..80 that holds two
// lines, lh 1.15em) with the body pushed 40px below it (Coriander 2026-09-18).
// Review stickers, bathroom strips, and to-go labels are NEVER touched.
// Idempotent: state is a pure function of (OFFER, MODE), so re-running with a new
// offer fully replaces a previous phrase/discount layout.
// Ends with the STROKE GATE from SKILL.md (outer 900x900 / 1500x2100 frames that
// are direct children of a Print Sheet get the 1px black INSIDE cut stroke).

const SECTION_ID = '__SECTION_ID__';
const OFFER = __OFFER_JSON__;
const MODE = '__MODE__';

// ---- copy rules (keep in sync with plan.mjs SHEET_COPY / specificOfferCopy) ----
const DEFAULTS = {
  stickerTitle: 'Join the club!',
  stickerBody: 'Be the first to know.\nReceive exclusive deals.',
  popTitle: 'Join the club!',
  popBodyVip: 'Scan to join our VIP text club\nfor ongoing offers!',
  popBodyDiscount: 'Scan to join our text club\nfor ongoing offers!',
};
const GENERIC_OFFER = /^join the club!?$/i;
function classify(offer, mode) {
  if (mode !== 'auto') return mode;
  if (!offer || GENERIC_OFFER.test(offer.trim())) return 'generic';
  const isDiscount = /^\$?\d+(\.\d+)?\s*%?\s*off\b/i.test(offer) || /^free\b/i.test(offer);
  return isDiscount ? 'discount' : 'phrase';
}
const offer = (OFFER || '').replace(/\s+/g, ' ').trim();
const kind = classify(offer, MODE);
if ((kind === 'discount' || kind === 'phrase') && !offer) throw new Error(`MODE=${kind} requires a non-empty OFFER`);
const reviewPhrase = kind === 'phrase' && /let us know|review|good time/i.test(offer);
const headline = kind === 'discount' ? 'Get ' + offer.replace(/\bOFF\b/g, 'Off') : kind === 'phrase' ? offer : DEFAULTS.popTitle;
const stickerTitle = kind === 'phrase' && !reviewPhrase ? offer : kind === 'discount' ? headline : DEFAULTS.stickerTitle;
const stickerBody = kind === 'phrase' && !reviewPhrase ? DEFAULTS.popBodyVip : DEFAULTS.stickerBody;
const popBody = kind === 'discount' ? DEFAULTS.popBodyDiscount : DEFAULTS.popBodyVip;

// ---- helpers ----
const MEDIUM = { family: 'Figtree', style: 'Medium' };
const SEMIBOLD = { family: 'Figtree', style: 'SemiBold' };
await figma.loadFontAsync(MEDIUM);
await figma.loadFontAsync(SEMIBOLD);
async function loadCurrent(t) {
  for (const s of t.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(s.fontName);
}
async function setText(t, { font, size, lh, chars, x, y, w }) {
  await loadCurrent(t);
  t.fontName = font;
  t.fontSize = size;
  t.lineHeight = lh === 'AUTO' ? { unit: 'AUTO' } : { unit: 'PIXELS', value: lh };
  t.characters = chars;
  t.textAutoResize = 'HEIGHT';
  t.resize(w, t.height);
  t.x = x; t.y = y;
}
const sec = await figma.getNodeByIdAsync(SECTION_ID);
if (!sec || sec.type !== 'SECTION') throw new Error(`SECTION_ID ${SECTION_ID} is not a SECTION`);
const sheets = sec.children.filter(n => /^Print Sheet - /.test(n.name));
const mutated = [];
const summary = { section: sec.name, kind, headline, stickerLayout: null, popTitleSize: null, stickers: 0, popSigns: 0 };

// ---- table promo stickers (sheets named "Print Sheet - Table Stickers ...") ----
let stickerLayout = kind === 'phrase' && !reviewPhrase ? null : 'default';
for (const sheet of sheets.filter(s => /^Print Sheet - Table Stickers/.test(s.name))) {
  for (const f of sheet.children.filter(c => c.type === 'FRAME' && c.width === 900 && c.height === 900)) {
    const texts = f.children.filter(t => t.type === 'TEXT');
    const title = texts.find(t => t.y < 150);
    const body = texts.find(t => t.y >= 150);
    if (!title || !body) continue;
    if (stickerLayout === null) {
      // measure once: does the phrase fit one line at 82 in 788px?
      await setText(title, { font: MEDIUM, size: 82, lh: 'AUTO', chars: stickerTitle, x: 56, y: 56, w: 788 });
      stickerLayout = title.height <= 100 ? 'phraseOneLine' : 'phraseTwoLine';
    }
    if (stickerLayout === 'default') {
      // Cam's default is a ONE-line 90/100 title over the body at y216. A discount headline that
      // wraps at 90 in 788px ("Get $10 off your next visit of $40+", Pyke's Crossroads 2026-10-23)
      // would draw its second line over the body, so it takes the two-line layout instead (copy
      // unchanged). Same rule as direct-pdf/lib/retarget.mjs recopy() 'defaultTwoLine'.
      await setText(title, { font: MEDIUM, size: 90, lh: 100, chars: stickerTitle, x: 56, y: 56, w: 788 });
      if (title.height > 100) stickerLayout = 'defaultTwoLine';
    }
    if (stickerLayout === 'default') {
      await setText(title, { font: MEDIUM, size: 90, lh: 100, chars: stickerTitle, x: 56, y: 56, w: 788 });
      await setText(body, { font: SEMIBOLD, size: 50, lh: 60, chars: stickerBody, x: 56, y: 216, w: 788 });
    } else if (stickerLayout === 'phraseOneLine') {
      await setText(title, { font: MEDIUM, size: 82, lh: 'AUTO', chars: stickerTitle, x: 56, y: 56, w: 788 });
      await setText(body, { font: SEMIBOLD, size: 50, lh: 60, chars: stickerBody, x: 56, y: 216, w: 788 });
    } else {
      // two-line layout (phraseTwoLine / defaultTwoLine): title 74 auto-lh, body 42/60 at y274; a
      // title that still runs past y274 shrinks in steps of 2 (floor 40) so it never overlaps the body
      let size = 74;
      await setText(title, { font: MEDIUM, size, lh: 'AUTO', chars: stickerTitle, x: 56, y: 56, w: 788 });
      while (56 + title.height > 274 && size > 40) { size -= 2; title.fontSize = size; }
      await setText(body, { font: SEMIBOLD, size: 42, lh: 60, chars: stickerBody, x: 56, y: 274, w: 788 });
    }
    mutated.push(title.id, body.id);
    summary.stickers += 1;
  }
}
summary.stickerLayout = stickerLayout;

// ---- POP signs (both variants): title auto-fit to one line, body per kind ----
for (const sheet of sheets.filter(s => /^Print Sheet - POP Sign/.test(s.name))) {
  for (const f of sheet.children.filter(c => c.type === 'FRAME' && c.width === 1500 && c.height === 2100)) {
    const texts = f.children.filter(t => t.type === 'TEXT').sort((a, b) => a.y - b.y);
    const [title, body] = texts; // legal line is last and untouched
    if (!title || !body) continue;
    let size = 140;
    await setText(title, { font: MEDIUM, size, lh: 150, chars: headline, x: 120, y: 180, w: 1260 });
    while (title.height > 150 && size > 80) {
      size -= 10;
      title.fontSize = size;
    }
    let bodyY = 420;
    if (title.height > 150) {
      // Still wraps at the 80 floor (long phrase, e.g. Coriander's "Buy One Get One
      // Chicken Tikka Masala", 2026-09-18): lay the title out on TWO lines at the
      // largest size 130..80 that holds two lines (lh = 1.15em), and push the body
      // 40px under it. Title 300 tall at 130/150 ends at 480, body 520-690, QR at 802.
      for (size = 130; size >= 80; size -= 10) {
        const lh = Math.round(size * 1.15);
        title.fontSize = size;
        title.lineHeight = { unit: 'PIXELS', value: lh };
        if (title.height <= 2 * lh + 1) break;
      }
      bodyY = 180 + title.height + 40;
      summary.popTitleLines = 2;
    }
    summary.popTitleSize = size;
    await setText(body, { font: MEDIUM, size: 70, lh: 85, chars: popBody, x: 120, y: bodyY, w: 1260 });
    mutated.push(title.id, body.id);
    summary.popSigns += 1;
  }
}

// ---- STROKE GATE (SKILL.md): outer sticker + POP frames only ----
const fixed = [];
for (const f of sec.findAll(n => n.type === 'FRAME' && ((n.width === 900 && n.height === 900) || (n.width === 1500 && n.height === 2100)) && /Print Sheet/i.test(n.parent && n.parent.name || ''))) {
  const s = f.strokes.find(p => p.type === 'SOLID');
  const ok = s && s.color.r === 0 && s.color.g === 0 && s.color.b === 0 && f.strokeWeight === 1 && f.strokeAlign === 'INSIDE';
  if (!ok) { f.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; f.strokeWeight = 1; f.strokeAlign = 'INSIDE'; fixed.push(f.id); }
}
return { summary, strokeGateFixed: fixed, mutatedNodeIds: mutated };
