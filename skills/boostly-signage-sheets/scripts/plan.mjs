#!/usr/bin/env node
// Headless replacement for the Boostly brand-extractor Figma signage plugin.
// Fetches touchpoints + branding from the Boostly v2 signage endpoint and
// emits a plan.json describing the full signage set (band polygons, text,
// logo, QR PNGs) ready for a Figma driver to execute.
//
// Geometry mirrors DIGITAL_ARTWORK_LAYOUTS (Figma-parity-tested) from
// product2 src/lib/fulfillment/digital-artwork-layout.ts and the copy
// defaults in digital-design.ts (DEFAULT_DIGITAL_FULFILLMENT_DESIGN),
// wrap limits from digital-artwork-render.ts. Visual treatment applies the
// harness sticker band rule (see harness/sticker-mock.mjs): primary-color
// band with white copy, white area with on-white logo and band-colored QR.
// Band ink on white must be >= 3.0:1; the darkest authored role substitutes
// when the primary fails (noted in the plan summary).
//
// Usage:
//   node plan.mjs --location-id <id> --account-id <id> --logo <on-white.png> \
//     [--run-dir <run>] [--band #RRGGBB] --out-dir <dir>
// Band default with --run-dir: the applied cell's sticker_band from variants/variant-sheet.json
// (the print cell when run.json records a web/print split), never the cell secondary or
// decision.json; --band stays the explicit override; the darkest-authored-role fallback only
// when no sheet exists. The applied cell's sticker_panel is copied to plan.json logo_panel so
// the direct renderer draws the authored panel or gradient behind the mark on light surfaces.
//
// Auth: BOOSTLY_V2_API_BASE / BOOSTLY_V2_API_KEY (or BOOSTLY_V2_AUTH_TOKEN)
// are sourced from the brand-extractor-figma .env at runtime. Secrets are
// never printed or written into the plan.

import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { figmaTargetBlock, loadFigmaTarget } from './lib/figma-target.mjs';

const ENV_FILE = process.env.BOOSTLY_BRANDING_ENV_FILE
  || `${process.env.HOME}/.config/boostly-branding/.env`;

// ---------------------------------------------------------------------------
// args
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    i += 1;
    args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const required of ['locationId', 'logo', 'outDir']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} is required`);
  }
  if (args.band && !/^#[0-9a-fA-F]{6}$/.test(args.band)) {
    throw new Error('--band must be a 6-digit hex like #536658');
  }
  args.tables = args.tables ? Number(args.tables) : 32; // Davenport observed default
  // --offer "<text>": the fulfillment request's offer_text. A SPECIFIC offer
  // (anything other than empty / "Join the Club!") becomes "Get <offer>" on the
  // table promo stickers AND the POP sign, with the POP body switched to the
  // plain "text club" line (Travisse 2026-09-03: specific offers ~2x scans vs
  // the generic default; "Get ..." reads as a payoff, not a label). Generic
  // requests keep Cam's "Join the club!" copy untouched.
  args.offer = (args.offer || '').trim();
  args.stalls = args.stalls ? Number(args.stalls) : 4;  // Davenport observed default
  return args;
}

// ---------------------------------------------------------------------------
// env (never printed)
async function loadEnv() {
  const raw = await fs.readFile(ENV_FILE, 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// ---------------------------------------------------------------------------
// applied cell (rule: signage band = the applied cell's sticker_band). Reads run.json
// variants.{selection.print_letter, applied_letter} and variants/variant-sheet.json cells[L].
export async function appliedCellDefaults(runDir) {
  const out = { letter: null, band: null, logo_panel: null, source: null };
  if (!runDir) return out;
  let run = null;
  try { run = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8')); } catch { return out; }
  const variants = run.variants || {};
  const letter = variants.selection?.print_letter || variants.applied_letter || null;
  if (!letter) return out;
  const sheetRel = variants.sheet_json || 'variants/variant-sheet.json';
  let sheet = null;
  try { sheet = JSON.parse(await fs.readFile(path.resolve(runDir, sheetRel), 'utf8')); } catch { return { ...out, letter }; }
  const cell = sheet.cells?.[letter];
  if (!cell) return { ...out, letter };
  const row = (sheet.rows || []).find((r) => r.key === cell.row) || null;
  const panel = cell.sticker_panel ?? row?.sticker_panel ?? null;
  const band = typeof cell.sticker_band === 'string' && /^#[0-9a-fA-F]{6}$/.test(cell.sticker_band) ? cell.sticker_band.toUpperCase() : null;
  return { letter, band, logo_panel: normalizePanel(panel), source: band ? 'applied cell sticker_band' : null, row: cell.row ?? null };
}

// plan.json logo_panel: { hex } | { gradient: [c1, c2] } | null
export function normalizePanel(panel) {
  if (!panel || typeof panel !== 'object') return null;
  const hex = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : null);
  if (Array.isArray(panel.gradient) && panel.gradient.length >= 2 && hex(panel.gradient[0]) && hex(panel.gradient[1])) return { gradient: [hex(panel.gradient[0]), hex(panel.gradient[1])] };
  if (hex(panel.hex)) return { hex: hex(panel.hex) };
  return null;
}

// ---------------------------------------------------------------------------
// contrast
function relativeLuminance(hex) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrastOnWhite(hex) {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

// ---------------------------------------------------------------------------
// touchpoint parsing — ported from brand-extractor-figma api/touchpoints.js
const TOUCHPOINT_ORDER = [
  'Point of Purchase',
  'Tables - Subscribe',
  'Tables - Reviews',
  'To-Go - Subscribe',
  'To-Go - Reviews',
  'Bathroom',
  'Bathroom - Reviews',
];
const DIRECT_LINK_KEYS = ['link', 'url', 'href', 'touchpoint_url', 'touchpointUrl'];
const REVIEW_LINK_KEYS = ['review_link', 'reviewLink', 'reviews_link', 'reviewsLink'];
const SUBSCRIBE_LINK_KEYS = ['subscribe_link', 'subscribeLink', 'join_link', 'joinLink'];
const GENERIC_COLLECTION_KEYS = ['touchpoints', 'signage', 'items', 'results', 'data'];
const KNOWN_TYPE_NAME_PATTERNS = [
  { pattern: /square[\s_-]*review/, name: 'Tables - Reviews' },
  { pattern: /square[\s_-]*(promo|subscribe)/, name: 'Tables - Subscribe' },
  { pattern: /to[\s_-]*go[\s_-]*review|togo[\s_-]*review/, name: 'To-Go - Reviews' },
  { pattern: /to[\s_-]*go[\s_-]*(promo|subscribe)|togo[\s_-]*(promo|subscribe)/, name: 'To-Go - Subscribe' },
  { pattern: /table[\s_-]*review|bathroom[\s_-]*review/, name: 'Bathroom - Reviews' },
  { pattern: /table[\s_-]*(promo|subscribe)|bathroom(?!.*review)/, name: 'Bathroom' },
  { pattern: /point[\s_-]*of[\s_-]*purchase|pop|tall[\s_-]*(promo|subscribe)/, name: 'Point of Purchase' },
];

function findKnownTouchpointName(text) {
  if (!text) return null;
  const normalized = String(text).toLowerCase();
  const match = KNOWN_TYPE_NAME_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  return match ? match.name : null;
}
function inferArea(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/point[\s_-]*of[\s_-]*purchase|pop|counter|register|tall[\s_-]*promo/.test(t)) return 'point_of_purchase';
  if (/bathroom|restroom|stall|table[\s_-]*tent/.test(t)) return 'bathroom';
  if (/to[\s_-]*go|togo|take[\s_-]*out|takeout|pickup/.test(t)) return 'to_go';
  if (/table|tables|dine[\s_-]*in/.test(t)) return 'tables';
  return null;
}
function inferCta(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/review|google/.test(t)) return 'review';
  if (/subscribe|join|opt[\s_-]*in|text[\s_-]*club|vip/.test(t)) return 'subscribe';
  return null;
}
function canonicalTouchpointName(area, cta) {
  if (!area) return null;
  if (area === 'point_of_purchase') return 'Point of Purchase';
  if (area === 'tables') return cta === 'review' ? 'Tables - Reviews' : 'Tables - Subscribe';
  if (area === 'to_go') return cta === 'review' ? 'To-Go - Reviews' : 'To-Go - Subscribe';
  if (area === 'bathroom') return cta === 'review' ? 'Bathroom - Reviews' : 'Bathroom';
  return null;
}
function visitV2Node(value, pathParts, results, visited) {
  if (!value || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => visitV2Node(item, pathParts.concat(String(i)), results, visited));
    return;
  }
  const labelBits = [
    ...pathParts, value.name, value.title, value.display_title, value.displayTitle,
    value.label, value.type, value.touchpoint_type, value.touchpointType,
    value.signage_type, value.signageType, value.primary_button_text,
  ].filter(Boolean);
  const labelText = labelBits.join(' ');
  const directKnownName = findKnownTouchpointName(labelText);
  const directKnownArea = directKnownName ? inferArea(directKnownName) : null;
  const inferredArea = directKnownName ? null : inferArea(labelText);
  const resolvedArea = directKnownArea || inferredArea;
  const inferredCta = directKnownName ? null : inferCta(labelText);
  const push = (name, link) => { if (name && link) results.push({ name, link }); };

  if (directKnownName && typeof value.link === 'string') push(directKnownName, value.link);
  for (const key of REVIEW_LINK_KEYS) {
    if (typeof value[key] === 'string') push(canonicalTouchpointName(resolvedArea, 'review') || directKnownName, value[key]);
  }
  for (const key of SUBSCRIBE_LINK_KEYS) {
    if (typeof value[key] === 'string') push(canonicalTouchpointName(resolvedArea, 'subscribe') || directKnownName, value[key]);
  }
  for (const key of DIRECT_LINK_KEYS) {
    if (typeof value[key] !== 'string') continue;
    const name = directKnownName || canonicalTouchpointName(
      resolvedArea, inferredCta || (resolvedArea === 'point_of_purchase' ? 'subscribe' : null));
    push(name, value[key]);
  }
  for (const key of GENERIC_COLLECTION_KEYS) {
    if (value[key]) visitV2Node(value[key], pathParts.concat(key), results, visited);
  }
  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') continue;
    if (GENERIC_COLLECTION_KEYS.includes(key)) continue;
    visitV2Node(child, pathParts.concat(key), results, visited);
  }
}
function sortTouchpoints(touchpoints) {
  const deduped = [];
  const seen = new Set();
  for (const tp of touchpoints) {
    if (!tp || !tp.name || !tp.link) continue;
    const key = `${tp.name}::${tp.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tp);
  }
  deduped.sort((a, b) => {
    const ai = TOUCHPOINT_ORDER.indexOf(a.name);
    const bi = TOUCHPOINT_ORDER.indexOf(b.name);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return deduped;
}

// ---------------------------------------------------------------------------
// branding color resolution: signage_* -> print_* -> web_* wherever they
// appear in the payload (branding block preferred, then anything else).
function collectColorRoles(node, out, visited = new WeakSet()) {
  if (!node || typeof node !== 'object' || visited.has(node)) return;
  visited.add(node);
  if (Array.isArray(node)) { node.forEach((v) => collectColorRoles(v, out, visited)); return; }
  for (const [key, value] of Object.entries(node)) {
    const m = key.match(/^(signage|print|web)_(primary|secondary|text)_color$/);
    if (m && typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
      if (!out[`${m[1]}_${m[2]}`]) out[`${m[1]}_${m[2]}`] = value.toUpperCase();
    } else if (value && typeof value === 'object') {
      collectColorRoles(value, out, visited);
    }
  }
}
function resolveRole(roles, role) {
  return roles[`signage_${role}`] || roles[`print_${role}`] || roles[`web_${role}`] || null;
}

// Current Figma target (file + template section + grid). Fails fast when the
// config is missing or malformed so a build never targets a stale file.
const FIGMA_TARGET = loadFigmaTarget();

// ---------------------------------------------------------------------------
// PRINT SHEET FORMAT — measured verbatim from Cam's Davenport Diner
// production section (node 2054:699 in the retired In-Store-Fulfillment-7;
// current target lives in references/figma-target.json). Davenport's
// brand primary is #000000; every "primary" below is the location band color.
// The print unit is the SHEET FRAME: several stickers per frame, each frame
// exported as a PDF for printing.
const SHEET_FORMAT = {
  // Standard background for generated production sections (Travisse 2026-08-31)
  sectionBackground: '#EAEAEA',
  // Section grid: WHICH file and WHERE new sections go is configuration, not
  // code. references/figma-target.json (file_key, template_section_id, grid)
  // is the single source; lib/figma-target.mjs loads it and plan.json carries
  // it as `figma`. x = origin_x + col*col_step, y = origin_y + row*row_step,
  // row-major; row 0 col 0 is the template section. The nominal slot is a
  // starting point only: always confirm it is free with a live scan.
  sectionGrid: (() => {
    const g = FIGMA_TARGET.grid;
    return { origin: [g.origin_x, g.origin_y], colPitch: g.col_step, rowPitch: g.row_step, cols: g.cols_per_row, source: 'references/figma-target.json' };
  })(),
  stickerSheet: { w: 2186, h: 2829, cutRect: { inset: 4, stroke: '#CCCCCC', weight: 1, dash: [8, 8] } },
  popSheet: { w: 2550, h: 3300 },
  tableSticker: {
    w: 900, h: 900, bg: '#FFFFFF',
    // Karissa's cut line (2026-09-03): MANDATORY on the outer sticker frame, every sticker.
    // Matches File 6 reference 2102:218439: 1px solid black, INSIDE, no dash.
    stroke: '#000000', strokeWeight: 1, strokeAlign: 'INSIDE',
    bandPath: 'M 0 0 L 900 0 L 900 429 L 0 524 L 0 0 Z',
    title: { x: 56, y: 56, w: 788, size: 90, lh: 100, font: 'Figtree Medium', color: 'white' },
    bodyPromo: { x: 56, y: 216, w: 788, size: 50, lh: 60, font: 'Figtree SemiBold', color: 'white' },
    // A discount headline that wraps at 90 in 788px ("Get $10 off your next visit of $40+", Pyke's
    // Crossroads 2026-10-23) takes the two-line phraseTitle/phraseBodyPromo geometry below so the body
    // never sits under the title's second line (figma-recopy.js and direct-pdf retarget.mjs measure it).
    // Phrase-offer variant (Travisse's hand-tuned Fahrenheit reference 2154:42413,
    // 2026-09-03): a long headline like "Unlock the V.I.P Experience" wraps to two
    // lines, so title drops to 74 with AUTO line height and the body drops to 42/60
    // and moves down to y=274. Used when copy.tablePromo.layout === 'phrase'.
    // Two-line phrase (Fahrenheit "Unlock the V.I.P Experience"): 74 / 42, body y=274.
    phraseTitle: { x: 56, y: 56, w: 788, size: 74, lh: 'AUTO', font: 'Figtree Medium', color: 'white' },
    phraseBodyPromo: { x: 56, y: 274, w: 788, size: 42, lh: 60, font: 'Figtree SemiBold', color: 'white' },
    // One-line phrase (Tillie's "Tillie's Special Offers", Travisse 2026-09-03): 82 / 50, body y=216.
    // Pick by measuring: if the title fits 788px at 82, use this; otherwise the two-line variant.
    phraseOneLineTitle: { x: 56, y: 56, w: 788, size: 82, lh: 'AUTO', font: 'Figtree Medium', color: 'white' },
    phraseOneLineBodyPromo: { x: 56, y: 216, w: 788, size: 50, lh: 60, font: 'Figtree SemiBold', color: 'white' },
    bodyReview: { x: 56, y: 286, w: 788, size: 50, lh: 60, font: 'Figtree SemiBold', color: 'white' },
    divider: { x: 446.5, y: 420, w: 7, h: 440, color: 'primary' },
    logo: { x: 56, y: 542, w: 330, h: 244.9, fit: 'FIT' },
    qrTile: { x: 485, y: 485, w: 359, r: 14, fill: '#FFFFFF', moduleColor: 'primary' },
    grid: [[64, 64], [1041, 64], [64, 1041], [1041, 1041]],
  },
  bathroomSticker: {
    w: 1300, h: 612, bg: 'primary',
    title: { x: 56, y: 56, size: 70, lh: 80, font: 'Figtree SemiBold', color: 'white' },
    body: { x: 56, y: 476, size: 70, lh: 80, font: 'Figtree SemiBold', color: 'white' },
    qr: { x: 744, y: 56, w: 500, moduleColor: 'white' },
    stack: [[64, 64], [64, 753], [64, 1442], [64, 2131]],
  },
  popSign: {
    w: 1500, h: 2100, at: [525, 600],
    // Same mandatory 1px black INSIDE cut stroke on the outer sign frame (both POP variants).
    stroke: '#000000', strokeWeight: 1, strokeAlign: 'INSIDE',
    title: { x: 120, y: 180, w: 1260, size: 140, lh: 150, font: 'Figtree Medium', align: 'center' },
    body: { x: 120, y: 420, w: 1260, size: 70, lh: 85, font: 'Figtree Medium', align: 'center' },
    qr: { x: 412.5, y: 802, w: 675 },
    logo: { x: 585, y: 1675, w: 330, h: 245, fit: 'FIT' },
    legal: { x: 120, y: 1988, w: 1260, size: 26, lh: 32, font: 'Figtree Medium', align: 'center' },
    variants: {
      primary: { bg: 'primary', ink: 'white', qrModules: 'white', qrTile: null, logo: 'white-knockout' },
      light: { bg: '#FFFFFF', ink: 'primary', qrModules: 'primary', qrTile: { r: 27, fill: '#FFFFFF' }, logo: 'color' },
    },
  },
  togoLabel: {
    // Always BLACK ink (text + QR modules): to-go labels print on a B&W
    // printer, so band-color ink would just dither to gray (Travisse 2026-08-31).
    // Layout "A framed QR" (Travisse 2026-10-05, approved mockup
    // togo-labels/mockups/build4.mjs variant A): TEXT ONLY, NO LOGO. Headline
    // Figtree Bold, left aligned, vertically centered in a fixed 860x500
    // box at x72 y56 (textAutoResize NONE, textAlignVertical CENTER), letter
    // spacing -2px, line height 96%. Auto-fit: start at 150 and shrink in steps
    // of 2 until the rendered text is <= 500 tall, <= 3 lines and the longest
    // word is <= 860 wide; floor 56. No trailing arrow. The QR sits in a rounded
    // white tile with a 3px inside black stroke, r28, 500x500 at x982 y56; the
    // QR itself is 468 (16px padding) at x998 y72.
    w: 1538, h: 612, bg: '#FFFFFF',
    headline: { x: 72, y: 56, w: 860, h: 500, font: 'Figtree Bold', color: '#000000', align: 'LEFT', valign: 'CENTER', autoResize: 'NONE', letterSpacing: -2, lineHeightPct: 96, fit: { startSize: 150, step: 2, minSize: 56, maxLines: 3 } },
    logo: null,
    qrTile: { x: 982, y: 56, w: 500, r: 28, fill: '#FFFFFF', stroke: '#000000', strokeWeight: 3, strokeAlign: 'INSIDE', padding: 16, moduleColor: '#000000' },
  },
  layout: {
    header: { title: [392, 0], prodLabel: [391, 578], logo: [391, 798, 1500] },
    columns: { table: 2040.7, review: 4326.4, bathroom: 6582.7, popPrimary: 8829.4, popLight: 11453.1, labels: 8829.4 },
    pageY0: 798.4, pageStep: 2929, labelY: [4198.2, 4872.2],
  },
};

// Cam's production copy (NOT the digital-design schema defaults)
const SHEET_COPY = {
  tablePromo: { title: 'Join the club!', body: 'Be the first to know.\nReceive exclusive deals.' },
  tableReview: { title: 'Let Us Know\nHow We Did!', body: "We'd love to hear from you.\nScan to leave us a review." },
  bathroomPromo: { title: "Your phone's\nalready out...", body: 'Scan for a deal 👉' },
  bathroomReview: { title: 'Enjoyed your\nmeal?', body: 'Leave a review 👉' },
  pop: { title: 'Join the club!', body: 'Scan to join our VIP text club\nfor ongoing offers!' },
  togoPromo: 'Join the club!',          // text only, no arrow; builder auto-fits in the 860x500 box
  togoReview: 'Let us know how we did',
};

// Specific-offer copy (Travisse 2026-09-03). "Get " + the offer with OFF/Off
// normalized to title case ("$10 OFF" -> "Get $10 Off", "20% Off" -> "Get 20% Off").
// Offers that already start with a verb ("Unlock the V.I.P Experience", "Had a
// good time? Let us know!") are used verbatim on the POP only, stickers keep
// the default, because "Get Unlock..." is nonsense. Review-only and bathroom
// copy never change. The to-go SUBSCRIBE label headline (togoPromo) is the
// table promo title with NO trailing arrow (Travisse 2026-10-05, style A; Karissa
// was retyping it in the label printer); the review label keeps Cam's copy.
// An offer typed as "Get 20% Off!" is normalized to the discount "20% Off" so
// every surface reads "Get 20% Off"; phrase offers keep their own punctuation
// ("Get 4 Free Breadsticks!").
const GENERIC_OFFER = /^join the club!?$/i;
const DISCOUNT_RE = /^\$?\d+(\.\d+)?\s*%?\s*off\b/i;
function specificOfferCopy(offer) {
  if (!offer || GENERIC_OFFER.test(offer)) return {};
  const typedGet = offer.match(/^get\s+(.+?)!?\s*$/i);
  if (typedGet && DISCOUNT_RE.test(typedGet[1])) offer = typedGet[1];
  const startsWithVerb = /^(get|unlock|join|scan|had|order|free\b)/i.test(offer) && !/^free\b/i.test(offer);
  const isDiscount = /^\$?\d+(\.\d+)?\s*%?\s*off\b/i.test(offer) || /^free\b/i.test(offer);
  if (!isDiscount) {
    // Phrase offer ("Unlock the V.I.P Experience", "Tillie's Special Offers"):
    // verbatim on the POP AND on the table promo stickers using the phrase
    // layout (74/42 sizes, body = the POP body line). Review-style phrases
    // ("Had a good time? Let us know!") are POP-only, stickers keep the default.
    const reviewPhrase = /let us know|review|good time/i.test(offer);
    if (reviewPhrase) return { pop: { ...SHEET_COPY.pop, title: offer } };
    return {
      tablePromo: { title: offer, body: SHEET_COPY.pop.body, layout: 'phrase' },
      pop: { ...SHEET_COPY.pop, title: offer },
      togoPromo: offer,
    };
  }
  const title = 'Get ' + offer.replace(/\bOFF\b/g, 'Off').replace(/\s+/g, ' ').trim();
  return {
    tablePromo: { ...SHEET_COPY.tablePromo, title },
    pop: { title, body: 'Scan to join our text club\nfor ongoing offers!' },
    togoPromo: title,
  };
}

const POP_LEGAL_COPY =
  "Consent not req'd for purchase. Msg & data rates may apply. Freq varies. Text STOP to end & HELP for help. Terms & Privacy: boostly.com/mobile-terms-of-use";

// touchpoint per sticker context
const SHEET_TOUCHPOINTS = {
  tablePromo: 'Tables - Subscribe',
  tableReview: 'Tables - Reviews',
  bathroomPromo: 'Bathroom',
  bathroomReview: 'Bathroom - Reviews',
  pop: 'Point of Purchase',
  togoPromo: 'To-Go - Subscribe',
  togoReview: 'To-Go - Reviews',
};


// Styled QR — VERBATIM port of generateStyledSvgQR from the plugin proxy
// (brand-extractor-figma/api/touchpoints.js): ECC M, 2-module quiet zone,
// rounded modules (0.4 corner radius), custom rounded finder patterns. The
// plugin renders this SVG into Figma via figma.createNodeFromSvg.
function generateStyledSvgQR(data, color = '#000000', size = 600) {
  const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const modules = qr.modules;
  const moduleCount = modules.size;
  const margin = 2;
  const moduleSize = size / (moduleCount + margin * 2);
  const cornerRadius = moduleSize * 0.4;
  const isInFinderPattern = (row, col) => {
    const isTopLeft = row < 7 && col < 7;
    const isTopRight = row < 7 && col >= moduleCount - 7;
    const isBottomLeft = row >= moduleCount - 7 && col < 7;
    return isTopLeft || isTopRight || isBottomLeft;
  };
  const roundedModule = (x, y, s, r) => {
    return `M${x + r},${y} L${x + s - r},${y} Q${x + s},${y} ${x + s},${y + r} L${x + s},${y + s - r} Q${x + s},${y + s} ${x + s - r},${y + s} L${x + r},${y + s} Q${x},${y + s} ${x},${y + s - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
  };
  const finderPattern = (startRow, startCol) => {
    const x = (startCol + margin) * moduleSize;
    const y = (startRow + margin) * moduleSize;
    const outerSize = 7 * moduleSize;
    const innerRingSize = 5 * moduleSize;
    const innerSquareSize = 3 * moduleSize;
    const innerRingOffset = moduleSize;
    const innerSquareOffset = 2 * moduleSize;
    const outerR = moduleSize * 0.8;
    const innerRingR = moduleSize * 0.6;
    const innerSquareR = moduleSize * 0.4;
    const outerPath = `M${x + outerR},${y} L${x + outerSize - outerR},${y} Q${x + outerSize},${y} ${x + outerSize},${y + outerR} L${x + outerSize},${y + outerSize - outerR} Q${x + outerSize},${y + outerSize} ${x + outerSize - outerR},${y + outerSize} L${x + outerR},${y + outerSize} Q${x},${y + outerSize} ${x},${y + outerSize - outerR} L${x},${y + outerR} Q${x},${y} ${x + outerR},${y} Z`;
    const ix = x + innerRingOffset;
    const iy = y + innerRingOffset;
    const is = innerRingSize;
    const ir = innerRingR;
    const innerCutout = `M${ix + ir},${iy} L${ix},${iy + ir} L${ix},${iy + is - ir} Q${ix},${iy + is} ${ix + ir},${iy + is} L${ix + is - ir},${iy + is} Q${ix + is},${iy + is} ${ix + is},${iy + is - ir} L${ix + is},${iy + ir} Q${ix + is},${iy} ${ix + is - ir},${iy} L${ix + ir},${iy} Q${ix},${iy} ${ix},${iy + ir} Z`;
    const innerSquare = roundedModule(x + innerSquareOffset, y + innerSquareOffset, innerSquareSize, innerSquareR);
    return `
      <path d="${outerPath} ${innerCutout}" fill="${color}" fill-rule="evenodd"/>
      <path d="${innerSquare}" fill="${color}"/>
    `;
  };
  let paths = [];
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (modules.get(row, col) && !isInFinderPattern(row, col)) {
        const x = (col + margin) * moduleSize;
        const y = (row + margin) * moduleSize;
        paths.push(`<path d="${roundedModule(x, y, moduleSize, cornerRadius)}"/>`);
      }
    }
  }
  const finderPaths = [
    finderPattern(0, 0),
    finderPattern(0, moduleCount - 7),
    finderPattern(moduleCount - 7, 0),
  ].join('\n');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <g fill="${color}">
    ${paths.join('\n    ')}
  </g>
  ${finderPaths}
</svg>`;
  return { svg, moduleCount, margin };
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const base = env.BOOSTLY_V2_API_BASE || 'https://new.boostly.com/api/service/v1';
  const apiKey = (env.BOOSTLY_V2_API_KEY || env.BOOSTLY_V2_AUTH_TOKEN || '').trim().replace(/^(Bearer|Token)\s+/i, '');
  if (!apiKey) throw new Error('No BOOSTLY_V2_API_KEY / BOOSTLY_V2_AUTH_TOKEN in env file');

  const outDir = path.resolve(args.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const url = `${base}/touchpoints/signage?location_id=${encodeURIComponent(args.locationId)}`;
  console.log(`Fetching v2 signage touchpoints: ${url}`);
  const authRaw = (env.BOOSTLY_V2_AUTH_TOKEN || env.BOOSTLY_V2_API_KEY || '').trim();
  const authHeader = /^[A-Za-z-]+\s+.+$/.test(authRaw) ? authRaw : `Bearer ${authRaw}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'x-api-key': apiKey, Authorization: authHeader },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`v2 API returned ${response.status}: ${body.slice(0, 500) || response.statusText}`);
  }
  const data = await response.json();
  console.log(`Payload keys: ${Object.keys(data).join(', ')}`);

  const results = [];
  visitV2Node(data, [], results, new WeakSet());
  const touchpoints = sortTouchpoints(results);
  if (!touchpoints.length) throw new Error('Could not map any v2 signage links into touchpoints');
  const linkFor = new Map(touchpoints.map((tp) => [tp.name, tp.link]));

  // branding block (prod does not yet expose secondary_logo_url)
  const rawBranding = data && typeof data === 'object' ? data.branding : null;
  const branding = rawBranding
    ? {
        logo_url: rawBranding.logo_url || null,
        secondary_logo_url: rawBranding.secondary_logo_url || rawBranding.alternate_logo_url || rawBranding.white_logo_url || null,
      }
    : null;

  const roles = {};
  collectColorRoles(data, roles);
  const authored = {
    primary: resolveRole(roles, 'primary'),
    secondary: resolveRole(roles, 'secondary'),
    text: resolveRole(roles, 'text'),
  };

  // Band rule: >= 3.0:1 on white for colored ink on white; darkest authored
  // role substitutes when the primary fails.
  const warnings = [];
  const applied = await appliedCellDefaults(args.runDir ? path.resolve(args.runDir) : null);
  let band = args.band ? args.band.toUpperCase() : applied.band || authored.primary;
  let bandSource = args.band ? 'cli-override' : applied.band ? applied.source : 'branding primary';
  if (args.runDir && !applied.band && !args.band) warnings.push(`no applied cell sticker_band in ${args.runDir} (letter ${applied.letter || 'none'}); band fell back to the V2 branding primary`);
  if (!band) throw new Error('No band color: pass --band or ensure branding colors exist');
  if (contrastOnWhite(band) < 3.0) {
    const candidates = [authored.primary, authored.secondary, authored.text]
      .filter((c) => c && contrastOnWhite(c) >= 3.0)
      .sort((a, b) => contrastOnWhite(b) - contrastOnWhite(a));
    if (!candidates.length) throw new Error(`Band ${band} fails 3.0:1 on white and no authored role passes`);
    warnings.push(`band ${band} fails 3.0:1 on white; substituted darkest authored role ${candidates[0]}`);
    band = candidates[0];
    bandSource = 'darkest authored role (primary failed 3.0:1)';
  }
  const white = '#FFFFFF';

  const logoFile = path.resolve(args.logo);
  await fs.access(logoFile);
  // ON-WHITE GATE (2026-09-21): stickers and POP signs print on white; the logo input must be
  // transparent-ground and pass on white before any Figma work (The Place Pizza panel, Arnold's
  // cream badge). Runs the brand-design battery against #FFFFFF with --surface sticker.
  if (!args.skipLogoGate) {
    const { spawnSync } = await import('node:child_process');
    const gatesCli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'boostly-brand-design', 'scripts', 'gates.ts');
    // --run-dir lets overrides recorded in that run (e.g. authored_lockup_low_contrast) count; --treatment
    // fullcolor marks the logo as the brand's untouched lockup (2026-09-23, Soybean).
    const gateArgs = ['--experimental-strip-types', gatesCli, 'check', '--asset', logoFile, '--color', '#FFFFFF', '--surface', 'sticker', '--gates', 'sticker-ground,component-contrast,png-color-type,ship-gate,border-dust'];
    if (args.runDir) gateArgs.push('--overrides-run', path.resolve(args.runDir));
    if (args.treatment) gateArgs.push('--treatment', args.treatment);
    const r = spawnSync('node', gateArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let verdict = null;
    try { verdict = JSON.parse((r.stdout || '').trim()); } catch { /* fall through */ }
    if (!verdict) throw new Error(`sticker on-white gate could not run: ${(r.stderr || '').replace(/\(node:\d+\) ExperimentalWarning[^\n]*/g, '').trim().slice(0, 300)}`);
    if (verdict.verdict === 'HOLD') {
      throw new Error(`sticker logo fails on white: ${(verdict.reasons || []).join('; ')}. Cut the mark from its ground or use the authored dark variant of the same mark; pass --skip-logo-gate true only with a recorded shipped-asset override.`);
    }
    args.logoGate = { verdict: verdict.verdict, reasons: verdict.reasons ?? [] };
  }

  // white-knockout logo (for the primary POP sign) derived from the color logo
  const sharp = (await import('sharp')).default;
  const whiteLogoFile = path.join(outDir, 'sticker-logo-white.png');
  {
    const { data, info } = await sharp(logoFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; }
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(whiteLogoFile);
  }

  // styled QR SVGs per sticker context (plugin-parity generator); primary- and
  // white-module variants as the format demands
  const qrFiles = {};
  for (const [ctx, tpName] of Object.entries(SHEET_TOUCHPOINTS)) {
    const link = linkFor.get(tpName) || null;
    if (!link) {
      warnings.push(`missing touchpoint "${tpName}" — ${ctx} sheets emitted with qr:null`);
      qrFiles[ctx] = null;
      continue;
    }
    const colors = { primary: band, white: '#FFFFFF', black: '#000000' };
    qrFiles[ctx] = { link };
    const wanted = ctx === 'pop' ? ['primary', 'white']
      : ctx.startsWith('bathroom') ? ['white']
      : ctx.startsWith('togo') ? ['black'] // B&W printer: always black
      : ['primary'];
    for (const role of wanted) {
      const f = path.join(outDir, `qr-${ctx}-${role}.svg`);
      const { svg, moduleCount, margin } = generateStyledSvgQR(link, colors[role], 600);
      await fs.writeFile(f, svg);
      qrFiles[ctx][role] = { file: f, moduleCount, quietZoneModules: margin };
    }
  }

  // sheet plan: quantities scale from the fulfillment request
  const perSheet = 4; // 2x2 table grid; 4-strip bathroom stack
  const tablePages = Math.ceil(args.tables / perSheet);
  const stallPages = Math.ceil(args.stalls / perSheet);
  const L = SHEET_FORMAT.layout;
  const sheets = [];
  const page = (name, x, y, kind, count) => sheets.push({ name, x, y,
    w: kind === 'pop' ? SHEET_FORMAT.popSheet.w : SHEET_FORMAT.stickerSheet.w,
    h: kind === 'pop' ? SHEET_FORMAT.popSheet.h : SHEET_FORMAT.stickerSheet.h,
    kind, count });
  for (let i = 0; i < tablePages; i++) {
    page(`Print Sheet - Table Stickers (Primary) - Page ${i + 1}`, L.columns.table, L.pageY0 + i * L.pageStep,
      'tablePromo', Math.min(perSheet, args.tables - i * perSheet));
  }
  for (let i = 0; i < tablePages; i++) {
    page(`Print Sheet - Review Stickers (Primary)${i ? ` - Page ${i + 1}` : ''}`, L.columns.review, L.pageY0 + i * L.pageStep,
      'tableReview', Math.min(perSheet, args.tables - i * perSheet));
  }
  for (let i = 0; i < stallPages; i++) {
    page(`Print Sheet - Bathroom Stickers (Primary) - Page ${i + 1}`, L.columns.bathroom, L.pageY0 + i * L.pageStep,
      'bathroomPromo', Math.min(perSheet, args.stalls - i * perSheet));
  }
  for (let i = 0; i < stallPages; i++) {
    page(`Print Sheet - Bathroom Review Stickers (Primary) - Page ${i + 1}`, L.columns.bathroom, L.pageY0 + (stallPages + i) * L.pageStep,
      'bathroomReview', Math.min(perSheet, args.stalls - i * perSheet));
  }
  page('Print Sheet - POP Sign 5x7 (Primary)', L.columns.popPrimary, L.pageY0, 'popPrimary', 1);
  page('Print Sheet - POP Sign 5x7 (Light)', L.columns.popLight, L.pageY0, 'popLight', 1);
  sheets.push({ name: 'Print Sheet - To-Go Label - promo - Black', x: L.columns.labels, y: L.labelY[0], w: SHEET_FORMAT.togoLabel.w, h: SHEET_FORMAT.togoLabel.h, kind: 'togoPromo', count: 1 });
  sheets.push({ name: 'Print Sheet - To-Go Label - review - Black', x: L.columns.labels, y: L.labelY[1], w: SHEET_FORMAT.togoLabel.w, h: SHEET_FORMAT.togoLabel.h, kind: 'togoReview', count: 1 });

  const plan = {
    generated_at: new Date().toISOString(),
    location_id: args.locationId,
    account_id: args.accountId || null,
    logo: logoFile,
    logo_white_knockout: whiteLogoFile,
    logo_panel: applied.logo_panel,
    applied_cell: applied.letter ? { letter: applied.letter, row: applied.row ?? null } : null,
    request: { tables: args.tables, stalls: args.stalls },
    format: SHEET_FORMAT,
    figma: figmaTargetBlock(FIGMA_TARGET),
    copy: {
      ...SHEET_COPY,
      ...specificOfferCopy(args.offer),
      popLegal: POP_LEGAL_COPY,
    },
    qr: qrFiles,
    sheets,
    summary: {
      font: { family: 'Figtree', weights: { 500: 'Medium', 600: 'SemiBold' } },
      band_color: band,
      band_source: bandSource,
      band_contrast_on_white: Number(contrastOnWhite(band).toFixed(2)),
      authored_roles: authored,
      color_roles_found: roles,
      branding_block: branding,
      touchpoints_found: touchpoints,
      touchpoints_missing: TOUCHPOINT_ORDER.filter((n) => !linkFor.has(n)),
      warnings,
    },
  };

  const planPath = path.join(outDir, 'plan.json');
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
  console.log(`\nPlan written: ${planPath}`);
  console.log(`Figma target: ${plan.figma.file_name} (${plan.figma.file_key}) template ${plan.figma.template_section_id}, grid origin ${plan.figma.grid.origin_x},${plan.figma.grid.origin_y} step ${plan.figma.grid.col_step}/${plan.figma.grid.row_step} x ${plan.figma.grid.cols_per_row} cols`);
  console.log(`Band: ${band} (${bandSource}, ${contrastOnWhite(band).toFixed(2)}:1 on white)`);
  if (applied.logo_panel) console.log(`Logo panel: ${JSON.stringify(applied.logo_panel)} (drawn behind the mark on light surfaces)`);
  console.log(`Sheets: ${sheets.length} (tables=${args.tables} -> ${tablePages} promo + ${tablePages} review pages; stalls=${args.stalls} -> ${stallPages}+${stallPages} bathroom pages; 2 POP; 2 labels)`);
  console.log(`Touchpoints found: ${touchpoints.map((t) => t.name).join(' | ')}`);
  if (plan.summary.touchpoints_missing.length) console.log(`Missing: ${plan.summary.touchpoints_missing.join(' | ')}`);
  for (const w of warnings) console.log(`WARNING: ${w}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
