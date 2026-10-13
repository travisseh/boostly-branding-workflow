// sheet-templates.js: the HTML/CSS templates behind every review-stage preview (tap card cell,
// sticker mock, POP tile, signage row, the variant sheet montage and the compare view).
// Pure functions of JSON; no DOM, no fs, no dependencies. One file that loads three ways:
//   Node ESM   : import templates from '../templates/sheet-templates.js'  (CommonJS default export)
//   Node CJS   : require('.../sheet-templates.js')
//   browser    : <script src="sheet-templates.js"> (classic script) -> window.BoostlySheet
// so the same markup renders in review-canvas.html from file://, the 127.0.0.1:3917 review server
// and the public review site, and in Playwright page.setContent when a raster is needed.
//
// Vendored sources (Travisse 2026-10-13, "don't worry about template drift"):
//   badge card   boostly src/lib/utils/generate-badge-html.ts + src/lib/constants/badge.ts at commit
//                8bf7a2e7cdd36ed45d155dab553c4c6bda9603b1 (the committed production badge template),
//                framed like the uncommitted src/app/public/badge-preview-harness/page.tsx shot box
//                (386x600, card scaled 1.7857, drop shadow) that the sheet used to screenshot.
//   sticker mock harness/sticker-mock.mjs (this skill): diagonal band, white lower area, logo left,
//                seeded mock QR right (never a real code).
//   POP tile     variant-sheet.mjs renderPopTile (this skill): plan.mjs popSign geometry scaled.
//   signage row  uncommitted boostly src/app/public/signage-preview-harness/signage-previews.tsx
//                (copy of the onboarding SignagePreviews: POP, tapcard tap side, table sticker,
//                bathroom sticker, perspective tilt, print sheen, layered shadows). Its QR is the
//                qrcode render of the constant sample sms URL, vendored as a fixed 33x33 matrix.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoostlySheet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- helpers ------------------------------------------------------------------------------
  function esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function luminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
  }
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  /** boostly src/lib/utils/color.ts computeTextColor: black on light, white otherwise. */
  function computeTextColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#ffffff';
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    return L > 0.179 ? '#000000' : '#ffffff';
  }
  /** FNV-1a seed of a string (sticker-mock.mjs seedFrom). */
  function seedFrom(text) {
    let h = 2166136261;
    for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return h >>> 0;
  }
  /** Deterministic 25x25 pseudo-QR (real finder patterns, LCG-filled body): a mock, never scannable. */
  function mockQrSvg(color, seed) {
    const N = 25;
    let state = seed >>> 0 || 1;
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const inFinder = (x, y) => (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
    const cells = [];
    const finderAt = (fx, fy) => {
      for (let y = 0; y < 7; y += 1) for (let x = 0; x < 7; x += 1) {
        const ring = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (ring || core) cells.push([fx + x, fy + y]);
      }
    };
    finderAt(0, 0); finderAt(N - 7, 0); finderAt(0, N - 7);
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
      if (inFinder(x, y)) continue;
      if (next() < 0.45) cells.push([x, y]);
    }
    // One path (relative moves) instead of a rect per module: a fifth of the bytes, the sheet repeats it per cell.
    let d = ''; let px = 0; let py = 0;
    for (const [x, y] of cells) { d += `m${x - px} ${y - py}h1v1h-1z`; px = x; py = y; }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.2 -0.2 ${N + 0.4} ${N + 0.4}" fill="${esc(color)}" stroke="${esc(color)}" stroke-width="0.3" stroke-linejoin="round"><path d="${d}"/></svg>`;
  }
  function svgDataUri(svg) {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  // ---- badge card (generate-badge-html.ts @ 8bf7a2e) ------------------------------------------
  const BADGE_DEFAULT_PRIMARY = '#6b7280';
  const BADGE_DEFAULT_SECONDARY = '#4b5563';
  const BADGE_DEFAULT_TEXT = '#ffffff';
  const BADGE_WIDTH_PX = 216;
  const BADGE_HEIGHT_PX = 336;
  const SCAN_ICON_PATHS = [
    'M481.65,157.675c-130.7-130.6-343.3-130.6-474,0c-10.2,10.2-10.2,26.8,0,37.1c10.2,10.2,26.8,10.2,37.1,0c110.2-110.3,289.6-110.3,399.9,0c5.1,5.1,11.8,7.7,18.5,7.7s13.4-2.6,18.5-7.7C491.85,184.575,491.85,167.975,481.65,157.675z',
    'M79.55,229.675c-10.2,10.2-10.2,26.8,0,37.1c10.2,10.2,26.8,10.2,37.1,0c70.6-70.6,185.5-70.6,256.1,0c5.1,5.1,11.8,7.7,18.5,7.7s13.4-2.6,18.5-7.7c10.2-10.2,10.2-26.8,0-37.1C318.75,138.575,170.55,138.575,79.55,229.675z',
    'M150.35,300.475c-10.2,10.2-10.2,26.8,0,37.1c10.2,10.2,26.8,10.2,37.1,0c31.5-31.6,82.9-31.6,114.4,0c5.1,5.1,11.8,7.7,18.5,7.7s13.4-2.6,18.5-7.7c10.2-10.2,10.2-26.8,0-37C286.95,248.475,202.35,248.475,150.35,300.475z',
  ];
  const SCAN_ICON_VIEWBOX = '0 0 489.3 489.3';
  const BADGE_LAYOUT = {
    borderRadius: 12,
    lanyardSlot: { top: 16, width: 56, height: 8 },
    issueId: { top: 18, left: 18, size: 32, fontSize: 16 },
    logo: { top: 52, widthPct: 58.33, height: 56 },
    centerContent: { topOffset: 16 },
    qr: { size: 72 },
    scanIcon: { size: 52 },
    label: { fontSize: 14, marginTop: 4 },
    accentStrip: { height: 80 },
  };
  function scanIconSvg(color, size) {
    const paths = SCAN_ICON_PATHS.map((d) => `<path d="${d}"/>`).join('');
    return `<svg viewBox="${SCAN_ICON_VIEWBOX}" width="${size}" height="${size}" fill="${esc(color)}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  }
  /**
   * The production badge markup (216x336 design px). `side` is 'back' (tap icon, what the sheet shows)
   * or 'front' (QR when qrDataUrl is given). Returns the HTML string, same as generateBadgeHtml.
   */
  function badgeCardHtml(config) {
    const L = BADGE_LAYOUT;
    const primary = config.primary || config.primaryColor || BADGE_DEFAULT_PRIMARY;
    const secondary = config.secondary || config.secondaryColor || BADGE_DEFAULT_SECONDARY;
    const text = config.text || config.textColor || BADGE_DEFAULT_TEXT;
    const textSecondary = config.textSecondary || config.textSecondaryColor || text;
    const lanyard = config.lanyardColor ?? 'white';
    const isFront = (config.side ?? 'back') === 'front';
    const issueId = config.issueId === undefined ? 1 : config.issueId;
    const logoAttrs = config.logoAttrs ? ` ${config.logoAttrs}` : '';
    const issueIdHtml = issueId != null
      ? `<div style="position: absolute; top: ${L.issueId.top}px; left: ${L.issueId.left}px; width: ${L.issueId.size}px; height: ${L.issueId.size}px; border-radius: 50%; background-color: ${esc(secondary)}; display: flex; align-items: center; justify-content: center;">
          <span style="color: ${esc(textSecondary)}; font-size: ${L.issueId.fontSize}px; font-weight: 600; line-height: ${L.issueId.size}px; text-align: center;">${esc(issueId)}</span>
        </div>`
      : '';
    const logoHtml = config.logoUrl
      ? `<div style="position: absolute; top: ${L.logo.top}px; left: 0; right: 0; width: ${L.logo.widthPct}%; height: ${L.logo.height}px; margin: 0 auto;">
        <img src="${esc(config.logoUrl)}"${logoAttrs} style="position: absolute; inset: 0; margin: auto; max-width: 100%; max-height: 100%; display: block;" />
      </div>`
      : '';
    let centerContentHtml;
    if (isFront && config.qrDataUrl) {
      centerContentHtml = `
      <div style="position: absolute; inset: 0; top: ${L.centerContent.topOffset}px; margin: auto; height: ${L.qr.size + L.label.fontSize + L.label.marginTop}px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;">
        <img src="${esc(config.qrDataUrl)}" style="display: block; width: ${L.qr.size}px; height: ${L.qr.size}px; margin: 0 auto;" />
        <div style="font-size: ${L.label.fontSize}px; font-weight: 600; margin-top: ${L.label.marginTop}px; color: ${esc(text)};">Scan for Options</div>
      </div>`;
    } else if (!isFront) {
      centerContentHtml = `
      <div style="position: absolute; inset: 0; top: ${L.centerContent.topOffset}px; margin: auto; height: ${L.scanIcon.size + L.label.fontSize}px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; color: ${esc(text)};">
        ${scanIconSvg(text, L.scanIcon.size)}
        <div style="font-size: ${L.label.fontSize}px; font-weight: 600; margin-top: -2px;">Tap for Options</div>
      </div>`;
    } else {
      centerContentHtml = '';
    }
    return `<div style="position: relative; width: ${BADGE_WIDTH_PX}px; height: ${BADGE_HEIGHT_PX}px; border-radius: ${L.borderRadius}px; overflow: hidden; background-color: ${esc(primary)}; text-align: center; color: ${esc(text)}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
    <div style="position: absolute; top: ${L.lanyardSlot.top}px; left: 0; right: 0; width: ${L.lanyardSlot.width}px; height: ${L.lanyardSlot.height}px; margin: 0 auto; border-radius: 9999px; background-color: ${esc(lanyard)};"></div>
    ${issueIdHtml}
    ${logoHtml}
    ${centerContentHtml}
    <div style="position: absolute; bottom: 0; left: 0; width: 100%; height: ${L.accentStrip.height}px; background-color: ${esc(secondary)};"></div>
  </div>`;
  }
  /**
   * The harness shot box around the card (what the sheet used to screenshot): a white 386x600 box with
   * the card scaled to fill it and a drop shadow. `width` scales the whole box (260 on the sheet).
   */
  function badgeShotHtml(config, { width = 386, background = '#ffffff' } = {}) {
    const shotW = 386; const shotH = 600;
    const s = width / shotW;
    const cardScale = 1.7857142857 * s;
    return `<div class="bs-badge-shot" style="position: relative; width: ${width}px; height: ${Math.round(shotH * s)}px; background: ${esc(background)}; overflow: hidden;">
    <div style="position: absolute; left: 50%; top: 50%; width: ${BADGE_WIDTH_PX}px; height: ${BADGE_HEIGHT_PX}px; transform: translate(-50%, -50%) scale(${cardScale.toFixed(6)}); transform-origin: center center; filter: drop-shadow(0 ${18 * s}px ${28 * s}px rgb(15 23 42 / 0.22));">${badgeCardHtml(config)}</div>
  </div>`;
  }

  // ---- sticker mock (harness/sticker-mock.mjs) -----------------------------------------------
  function stickerMockHtml({ logoUrl, band, headline = 'Join the club!', body = 'Be the first to know.|Receive exclusive deals.', seed = null, size = 720, logoAttrs = '' } = {}) {
    const qr = mockQrSvg(band, seed == null ? seedFrom(`${logoUrl}${band}`) : seed);
    const bodyLines = String(body).split('|').map((line) => `<div>${esc(line)}</div>`).join('');
    return `<div class="bs-sticker" style="position: relative; width: ${size}px; height: ${size}px; background: #ffffff; overflow: hidden; font-family: 'Helvetica Neue', Arial, sans-serif;">
    <div style="position: absolute; inset: 0; background: ${esc(band)}; clip-path: polygon(0 0, 100% 0, 100% 47%, 0 59%);"></div>
    <div style="position: absolute; left: ${size * 0.09}px; right: ${size * 0.09}px; top: ${size * 0.075}px; color: #ffffff;">
      <div style="font-size: ${size * 0.082}px; font-weight: 500; letter-spacing: -0.01em;">${esc(headline)}</div>
      <div style="margin-top: ${size * 0.135}px; font-size: ${size * 0.047}px; font-weight: 400; line-height: 1.45;">${bodyLines}</div>
    </div>
    <div style="position: absolute; left: ${size * 0.09}px; right: ${size * 0.09}px; top: ${size * 0.6}px; bottom: ${size * 0.07}px; display: flex; align-items: center;">
      <div style="flex: 1 1 0; height: 100%; display: flex; align-items: center; justify-content: center; padding-right: ${size * 0.045}px;"><img src="${esc(logoUrl)}"${logoAttrs ? ` ${logoAttrs}` : ''} style="max-width: 100%; max-height: 100%; object-fit: contain;"></div>
      <div style="width: 2px; align-self: stretch; background: ${esc(band)};"></div>
      <div style="flex: 1 1 0; height: 100%; display: flex; align-items: center; justify-content: center; padding-left: ${size * 0.045}px;"><img src="${svgDataUri(qr)}" style="width: ${size * 0.36}px; height: ${size * 0.36}px;"></div>
    </div>
  </div>`;
  }
  /** The tile drawn where a sticker mock was refused (opaque ground): white field, red words naming the fix. */
  function stickerPlaceholderHtml({ width = 150, height = 198 } = {}) {
    return `<div class="bs-sticker-missing" style="position: relative; width: ${width}px; height: ${height}px; background: #ffffff; box-sizing: border-box; border: 2px dashed #B71C1C; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; font-family: Helvetica, Arial, sans-serif;">
    <div style="font-size: 13px; font-weight: 700; color: #B71C1C;">sticker:</div>
    <div style="font-size: 13px; font-weight: 700; color: #B71C1C;">needs panel or strip</div>
    <div style="font-size: 10px; color: #555555; margin-top: 6px;">sticker-panel.mjs circle|strip</div>
  </div>`;
  }

  // ---- POP tile (variant-sheet.mjs renderPopTile) ---------------------------------------------
  function popTileHtml({ logoUrl, ground, offer = 'Join the club!', width = 300, logoAttrs = '' } = {}) {
    const W = width; const H = Math.round(width * 420 / 300);
    const s = W / 1500;
    return `<div class="bs-pop" style="position: relative; width: ${W}px; height: ${H}px; background: ${esc(ground)}; overflow: hidden; font-family: 'Figtree', 'Helvetica Neue', Arial, sans-serif; color: #fff;">
    <div style="position: absolute; left: ${120 * s}px; width: ${1260 * s}px; text-align: center; top: ${180 * s}px; font-size: ${140 * s}px; line-height: ${150 * s}px; font-weight: 500;">${esc(offer)}</div>
    <div style="position: absolute; left: ${120 * s}px; width: ${1260 * s}px; text-align: center; top: ${420 * s}px; font-size: ${70 * s}px; line-height: ${85 * s}px; font-weight: 500;">Scan to join our text club<br>for ongoing offers!</div>
    <div class="bs-pop-qr" style="position: absolute; left: ${412.5 * s}px; top: ${802 * s}px; width: ${675 * s}px; height: ${675 * s}px;"></div>
    <div style="position: absolute; left: ${585 * s}px; top: ${1675 * s}px; width: ${330 * s}px; height: ${245 * s}px; display: flex; align-items: center; justify-content: center;"><img src="${esc(logoUrl)}"${logoAttrs ? ` ${logoAttrs}` : ''} style="max-width: 100%; max-height: 100%; object-fit: contain;"></div>
    <div style="position: absolute; left: ${120 * s}px; width: ${1260 * s}px; text-align: center; top: ${1988 * s}px; font-size: ${26 * s}px; line-height: ${32 * s}px;">Consent not req'd for purchase. Msg &amp; data rates may apply.</div>
  </div>`;
  }

  // ---- signage row (signage-previews.tsx, uncommitted harness copy of the onboarding component) --
  // qrcode.toString('sms:+18015550142?&body=Sign%20me%20up%20for%20texts!%0A%0ABELLAS', { errorCorrectionLevel: 'M' }):
  // the 33x33 module matrix, vendored so the browser needs no QR library. margin 2 modules as in the component.
  const SIGNAGE_QR_ROWS = ['111111100111100111001011001111111', '100000100000100101110000101000001', '101110101111001000111000101011101', '101110101111100000101011101011101', '101110101000011110111010001011101', '100000101001010001100011101000001', '111111101010101010101010101111111', '000000001011100011101100100000000', '101111100110011000010111101111100', '011000011100110110110100011111001', '010101101001011000110100111101111', '110110000110110000110000101011101', '010110100011101000011011111001001', '100101000010000101001001001010101', '000001101001011101001111110100110', '000010000000101101101000100011111', '110001111111011010011110100110100', '001100000000000110011000001100101', '001101110010110000100100010101011', '000110010001010101010000000100100', '101101110101001111000010110101000', '111011011010010011001101000010011', '101100111101101110010110110100010', '101100010000100010100000001101110', '101111110100010100001110111110010', '000000001010100011111111100010001', '111111100001111100010010101010010', '100000101110001110000101100010100', '101110101000001101010110111110010', '101110101100100111001001011001100', '101110101001010001100011010100100', '100000100000001100110000001011100', '111111101000111001000111101110010'];
  function signageQrSvg(color) {
    const n = SIGNAGE_QR_ROWS.length; const m = 2;
    // One path with relative moves (the row draws this four times; a rect per module was 130 KB).
    let d = ''; let px = 0; let py = 0;
    for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) {
      if (SIGNAGE_QR_ROWS[y][x] !== '1') continue;
      d += `m${x + m - px} ${y + m - py}h1v1h-1z`; px = x + m; py = y + m;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" fill="${esc(color)}"><path d="${d}"/></svg>`;
  }
  const WIFI_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/></svg>';
  const AMBIENT_SHADOW = '0 32px 64px -24px rgba(23, 15, 60, 0.38), 0 16px 32px -16px rgba(23, 15, 60, 0.26), 0 4px 12px -4px rgba(23, 15, 60, 0.16)';
  const SIGNAGE_CONFIG = {
    perspective: 1200, overlap: -21, inch: 4.5, marginTop: 16, marginBottom: 16,
    items: [
      { id: 'pop', height: 8, rotateY: 18, fontScale: 1 },
      { id: 'tapcard', height: 4.5, rotateY: 10, fontScale: 2.1 },
      { id: 'table', height: 3.5, rotateY: -10, fontScale: 1.95 },
      { id: 'bathroom', height: 3, rotateY: -18, fontScale: 1.85 },
    ],
  };
  const PREVIEW_SAMPLE_PRIMARY = '#1B2327';
  const PREVIEW_SAMPLE_SECONDARY = '#111111';
  const SIGNAGE_FONT = "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  function sheen(radius, intensity = 1) {
    const a = (alpha) => (alpha * intensity).toFixed(3);
    return `<div aria-hidden="true" style="pointer-events: none; position: absolute; inset: 0; z-index: 20; border-radius: ${radius}px; background: linear-gradient(150deg, rgba(255,255,255,${a(0.1)}) 0%, rgba(255,255,255,${a(0.04)}) 18%, rgba(255,255,255,0) 40%); box-shadow: inset 0 1px 1px rgba(255,255,255,${a(0.28)}), inset 1px 0 1px rgba(255,255,255,${a(0.1)}), inset 0 -1.5px 2px rgba(0,0,0,0.28), inset -1px 0 1px rgba(0,0,0,0.10);"></div>`;
  }
  function qrImg(style, light) {
    return `<img src="${svgDataUri(signageQrSvg(light ? '#ffffff' : '#000000'))}" alt="QR code" style="${style}">`;
  }
  function popPieceHtml({ logoUrl, primary, offer, fs, logoAttrs }) {
    const bg = primary || PREVIEW_SAMPLE_PRIMARY;
    const logo = logoUrl
      ? `<img src="${esc(logoUrl)}"${logoAttrs ? ` ${logoAttrs}` : ''} alt="" style="height: 100%; width: 100%; object-fit: contain;">`
      : `<span style="text-align: center; font-weight: 600; line-height: 1.05; letter-spacing: -0.025em; color: #fff; font-size: clamp(0.55rem, ${8 * fs}cqi, 1.9rem);">Your Logo Here</span>`;
    return `<div style="position: relative; height: 100%; aspect-ratio: 3 / 5;">
      <div aria-hidden="true" style="pointer-events: none; position: absolute; inset: 0; box-shadow: ${AMBIENT_SHADOW};"></div>
      <div style="position: relative; display: flex; height: 100%; flex-direction: column; align-items: center; overflow: hidden; padding: 15% 10% 5%; text-align: center; background-color: ${esc(bg)}; container-type: inline-size;">
        <p style="margin: 0; color: #fff; font-weight: 600; letter-spacing: -0.025em; line-height: 1.02; font-size: clamp(1rem, ${13 * fs}cqi, 4rem);">${esc(offer)}</p>
        <p style="margin: 8% 0 0; color: #fff; font-weight: 500; line-height: 1.2; font-size: clamp(0.5rem, ${5.5 * fs}cqi, 1.8rem);">Scan to join our VIP text club<br>for ongoing offers!</p>
        <div style="margin-top: 12%; width: 45%;">${qrImg('aspect-ratio: 1 / 1; width: 100%; display: block;', true)}</div>
        <div style="margin-top: 12%; display: flex; width: 22%; aspect-ratio: 330 / 245; align-items: center; justify-content: center;">${logo}</div>
        ${sheen(0, 1.15)}
      </div>
    </div>`;
  }
  function tapcardPieceHtml({ logoUrl, primary, accent, fs, logoAttrs }) {
    const bg = primary || PREVIEW_SAMPLE_PRIMARY;
    const acc = accent || PREVIEW_SAMPLE_SECONDARY;
    const logo = logoUrl
      ? `<div style="height: 100%; width: 60%;"><img src="${esc(logoUrl)}"${logoAttrs ? ` ${logoAttrs}` : ''} alt="" style="height: 100%; width: 100%; object-fit: contain;"></div>`
      : `<span style="max-width: 72%; font-weight: 600; line-height: 1.05; letter-spacing: -0.025em; color: #fff; font-size: clamp(0.45rem, ${4 * fs}cqi, 1.2rem);">Your Logo Here</span>`;
    return `<div style="display: block; aspect-ratio: 216 / 336; position: relative; height: 100%; width: auto; perspective: 1000px;">
      <div style="position: relative; height: 100%; width: 100%; transform-style: preserve-3d;">
        <div style="border-radius: 12px; overflow: hidden; position: absolute; inset: 0; color: #fff; text-align: center; background-color: ${esc(bg)}; container-type: inline-size; box-shadow: ${AMBIENT_SHADOW}; backface-visibility: hidden;">
          <div style="position: absolute; z-index: 10; width: 26%; height: 2.4%; top: 4.8%; left: 50%; transform: translateX(-50%); border-radius: 9999px; background: rgba(255,255,255,0.8);"></div>
          <div style="position: absolute; z-index: 10; top: 5%; left: 7%; width: 18%; aspect-ratio: 1 / 1; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 600; background-color: ${esc(acc)}; color: ${computeTextColor(acc)}; font-size: clamp(0.4rem, ${5 * fs}cqi, 1.4rem);">1</div>
          <div style="position: absolute; left: 0; right: 0; top: 16%; display: flex; align-items: center; justify-content: center; height: 24%;">${logo}</div>
          <div style="position: absolute; left: 0; right: 0; top: 42%; display: flex; flex-direction: column; align-items: center;">
            <div style="width: 22%; opacity: 0.9; display: flex;">${WIFI_ICON}</div>
            <p style="margin: 3% 0 0; font-weight: 600; font-size: clamp(0.4rem, ${4 * fs}cqi, 1.1rem);">Tap for Options</p>
          </div>
          <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 19%; background-color: ${esc(acc)};"></div>
          ${sheen(12, 1)}
        </div>
      </div>
    </div>`;
  }
  function tablePieceHtml({ logoUrl, logoLightUrl, primary, offer, fs, logoAttrs }) {
    const bg = primary || PREVIEW_SAMPLE_PRIMARY;
    const lightLogo = logoLightUrl ?? logoUrl;
    const logo = lightLogo
      ? `<div style="width: 80%; aspect-ratio: 330 / 245;"><img src="${esc(lightLogo)}"${logoAttrs ? ` ${logoAttrs}` : ''} alt="" style="height: 100%; width: 100%; object-fit: contain;"></div>`
      : `<span style="max-width: 72%; text-align: center; font-weight: 600; line-height: 1.05; letter-spacing: -0.025em; color: #171717; font-size: clamp(0.45rem, ${4 * fs}cqi, 1.3rem);">Your Logo Here</span>`;
    return `<div style="border-radius: 16px; overflow: hidden; aspect-ratio: 1 / 1; position: relative; height: 100%; container-type: inline-size; box-shadow: ${AMBIENT_SHADOW};">
      <div style="position: absolute; inset: 0; background-color: ${esc(bg)}; clip-path: polygon(0 0, 100% 0, 100% 50%, 0 60%);"></div>
      <div style="position: absolute; inset: 0; background: #fff; clip-path: polygon(0 60%, 100% 50%, 100% 100%, 0 100%);"></div>
      <div style="position: absolute; top: 11%; left: 9%; right: 6%;">
        <p style="margin: 0; color: #fff; font-weight: 600; letter-spacing: -0.025em; line-height: 1.05; font-size: clamp(0.5rem, ${5 * fs}cqi, 2.5rem);">${esc(offer)}</p>
        <div style="margin-top: 8%;">
          <p style="margin: 0; color: #fff; font-weight: 500; line-height: 1.2; font-size: clamp(0.35rem, ${3.2 * fs}cqi, 1.4rem);">Be the first to know.</p>
          <p style="margin: 0; color: #fff; font-weight: 500; line-height: 1.2; font-size: clamp(0.35rem, ${3.2 * fs}cqi, 1.4rem);">Receive exclusive deals.</p>
        </div>
      </div>
      <div style="position: absolute; bottom: 6%; left: 6%; right: 6%; top: 56%; display: flex; align-items: center;">
        <div style="flex: 1; display: flex; align-items: center; justify-content: center;">${logo}</div>
        <div style="width: 2px; align-self: stretch; background: #171717; margin: 0 8px;"></div>
        <div style="flex: 1; display: flex; align-items: center; justify-content: center;">${qrImg('aspect-ratio: 1 / 1; width: 92%; display: block;', false)}</div>
      </div>
      ${sheen(16, 0.75)}
    </div>`;
  }
  function bathroomPieceHtml({ primary, fs, bathroomCopy }) {
    const bg = primary || PREVIEW_SAMPLE_PRIMARY;
    const copy = bathroomCopy ? esc(bathroomCopy).replace(/\n/g, '<br>') : 'Scan for a deal';
    return `<div style="border-radius: 16px; overflow: hidden; aspect-ratio: 2 / 1; position: relative; padding: 8%; height: 100%; box-sizing: border-box; background-color: ${esc(bg)}; container-type: inline-size; box-shadow: ${AMBIENT_SHADOW};">
      <div style="position: absolute; top: 10%; left: 8%; right: 42%;"><p style="margin: 0; color: #fff; font-weight: 600; letter-spacing: -0.025em; line-height: 1.1; font-size: clamp(0.4rem, ${3.5 * fs}cqi, 3rem);">Your phone&#8217;s already out&hellip;</p></div>
      <div style="position: absolute; top: 50%; transform: translateY(-50%); right: 6%; width: 32%;">${qrImg('aspect-ratio: 1 / 1; width: 100%; display: block;', true)}</div>
      <div style="position: absolute; bottom: 10%; left: 8%;"><p style="margin: 0; color: #fff; font-weight: 500; line-height: 1.15; font-size: clamp(0.4rem, ${3.5 * fs}cqi, 3rem);">${copy}</p></div>
      ${sheen(16, 0.55)}
    </div>`;
  }
  function signageItemHtml({ id, height, inch, rotateY, perspective, overlap, first, zIndex }, inner) {
    const transform = rotateY ? `perspective(${perspective}px) rotateY(${rotateY}deg)` : 'none';
    return `<div data-piece="${id}" style="transform-style: preserve-3d; z-index: ${zIndex};${first ? '' : ` margin-left: ${overlap}px;`}">
      <div style="position: relative; height: ${height * inch}rem; transform: ${transform}; transform-origin: center; backface-visibility: hidden; -webkit-font-smoothing: antialiased;">
        <div aria-hidden="true" style="pointer-events: none; position: absolute; left: 50%; height: 8%; width: 92%; border-radius: 50%; background: rgba(0,0,0,0.2); bottom: -5%; transform: translateX(-50%) rotateX(72deg); box-shadow: 0 0 16px 6px rgba(0, 0, 0, 0.18);"></div>
        ${inner}
      </div>
    </div>`;
  }
  function signageItemWidthRem(id, heightInches, inch) {
    const h = heightInches * inch;
    return id === 'pop' ? h * 3 / 5 : id === 'tapcard' ? h * 216 / 336 : id === 'bathroom' ? h * 2 : h;
  }
  /** Container size of the signage row in rem (getSignagePreviewLayout) plus the harness padding (+6 / +4 rem). */
  function signageLayout(config = SIGNAGE_CONFIG, scale = 1) {
    const inch = config.inch * scale;
    const tallest = Math.max(...config.items.map((i) => i.height));
    const maxRotate = Math.max(...config.items.map((i) => Math.abs(i.rotateY)));
    const overflow = tallest * inch * 0.6 * Math.sin((maxRotate * Math.PI) / 180) * 0.45;
    const order = ['pop', 'tapcard', 'table', 'bathroom'];
    let width = 0; let n = 0;
    for (const id of order) {
      const item = config.items.find((i) => i.id === id);
      if (!item) continue;
      width += signageItemWidthRem(id, item.height, inch) + (n ? (config.overlap * scale) / 16 : 0);
      n += 1;
    }
    return { containerWidthRem: width, containerHeightRem: tallest * inch + overflow + 2.5 * scale, shotWidthRem: width + 6, shotHeightRem: tallest * inch + overflow + 2.5 * scale + 4 };
  }
  /**
   * The signage row as shown in onboarding: POP sign, tap card (tap side), table sticker, bathroom sticker,
   * wrapped in the harness shot box (white, centered). logoUrl is the card/POP logo (knockout on the
   * primary); logoLightUrl the on-white sticker logo (falls back to logoUrl). Returns HTML; the shot
   * measures signageLayout().shotWidthRem x shotHeightRem at 16px/rem.
   */
  function signagePreviewHtml({ logoUrl = null, logoLightUrl = null, primary, accent, offer = 'Join the club!', scale = 1, bathroomCopy = null, config = SIGNAGE_CONFIG, logoAttrs = '' } = {}) {
    const inch = config.inch * scale;
    const perspective = config.perspective * scale;
    const overlap = config.overlap * scale;
    const cfg = (id) => config.items.find((i) => i.id === id);
    const z = { pop: 1, tapcard: 4, table: 3, bathroom: 2 };
    const pieces = [];
    let first = true;
    const push = (id, inner) => {
      const c = cfg(id);
      if (!c) return;
      pieces.push(signageItemHtml({ id, height: c.height, inch, rotateY: c.rotateY, perspective, overlap, first, zIndex: z[id] }, inner));
      first = false;
    };
    push('pop', popPieceHtml({ logoUrl, primary, offer, fs: cfg('pop')?.fontScale ?? 1, logoAttrs }));
    push('tapcard', tapcardPieceHtml({ logoUrl, primary, accent, fs: cfg('tapcard')?.fontScale ?? 1, logoAttrs }));
    push('table', tablePieceHtml({ logoUrl, logoLightUrl, primary, offer, fs: cfg('table')?.fontScale ?? 1, logoAttrs }));
    push('bathroom', bathroomPieceHtml({ primary, fs: cfg('bathroom')?.fontScale ?? 1, bathroomCopy }));
    const layout = signageLayout(config, scale);
    return `<div class="bs-signage-shot" style="width: ${layout.shotWidthRem}rem; height: ${layout.shotHeightRem}rem; background: #ffffff; display: flex; align-items: center; justify-content: center; overflow: visible; font-family: ${SIGNAGE_FONT}; font-size: 16px; line-height: 1.5; color: #111;">
    <div style="display: flex; align-items: flex-end;">${pieces.join('\n')}</div>
  </div>`;
  }

  // ---- the variant sheet montage (variant-sheet.mjs composeSheet geometry) -------------------
  const GEOMETRY = { CARD_W: 260, SIDE_W: 150, LABEL_H: 34, CELL_PAD: 8, ROW_HEADER_W: 120, COL_HEADER_H: 44 };
  function sheetGeometry(columns, rows) {
    const { CARD_W, SIDE_W, LABEL_H, CELL_PAD, ROW_HEADER_W, COL_HEADER_H } = GEOMETRY;
    const cardH = Math.round(CARD_W * 1200 / 772);
    const sideH = Math.round((cardH - CELL_PAD) / 2);
    const cellW = CARD_W + SIDE_W + CELL_PAD * 3;
    const cellH = LABEL_H + cardH + CELL_PAD * 2;
    return { cardH, sideH, cellW, cellH, sheetW: ROW_HEADER_W + columns * cellW, sheetH: COL_HEADER_H + rows * cellH };
  }
  const STATUS_STYLE = {
    fable_pick: { color: '#1565C0', text: '#FFFFFF', tag: 'FABLE PICK' },
    travisse_pick: { color: '#F9A825', text: '#000000', tag: 'TRAVISSE PICK' },
    rejected: { color: '#616161', text: '#FFFFFF', tag: 'REJECTED' },
    hold: { color: '#B71C1C', text: '#FFFFFF', tag: 'HOLD: traced from small source' },
  };
  const NOT_VIABLE_STYLE = { color: '#4A148C', text: '#FFFFFF', tag: 'NOT VIABLE' };
  const TILE_BG = '#E5E5E5';
  /** CSS shared by every sheet/cell/compare render (the page inlines it once). */
  const SHEET_CSS = `
.bs-pop-qr { background: url("${svgDataUri(mockQrSvg('#FFFFFF', 4242))}") center / contain no-repeat; }
.bs-sheet { position: relative; background: #C8C8C8; font-family: Helvetica, Arial, sans-serif; }
.bs-sheet, .bs-sheet *, .bs-signage-shot, .bs-signage-shot *, .bs-compare, .bs-compare * { box-sizing: border-box; }
.bs-signage-shot img, .bs-signage-shot svg { display: block; max-width: 100%; }
.bs-hdr { position: absolute; background: #222222; color: #fff; font-weight: 700; font-size: 14px; overflow: hidden; }
.bs-hdr.col { height: ${GEOMETRY.COL_HEADER_H}px; line-height: ${GEOMETRY.COL_HEADER_H}px; padding: 0 8px; white-space: nowrap; }
.bs-hdr.row { width: ${GEOMETRY.ROW_HEADER_W}px; padding: 8px; line-height: 1.2; display: flex; align-items: center; overflow-wrap: anywhere; }
.bs-cell { position: absolute; }
.bs-cell .bs-label { position: absolute; left: 0; top: 0; right: 0; height: ${GEOMETRY.LABEL_H}px; line-height: ${GEOMETRY.LABEL_H}px; padding: 0 8px; color: #fff; font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; }
.bs-cell .bs-tile { position: absolute; background: ${TILE_BG}; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.bs-cell.rejected .bs-tile { filter: grayscale(1) contrast(0.55) brightness(1.3); }
.bs-cell .bs-frame { position: absolute; inset: 0; pointer-events: none; border: 4px solid transparent; }
.bs-cell .bs-tag { position: absolute; height: 20px; line-height: 20px; padding: 0 7px; border-radius: 3px; font-size: 12px; font-weight: 700; white-space: nowrap; pointer-events: none; }
.bs-cell .bs-rejected-word { position: absolute; left: ${GEOMETRY.CELL_PAD}px; width: ${GEOMETRY.CARD_W}px; top: 50%; text-align: center; transform: rotate(-18deg); font-size: 40px; font-weight: 700; color: #616161; -webkit-text-stroke: 2px #fff; paint-order: stroke; pointer-events: none; }
.bs-cell.selectable { cursor: pointer; }
.bs-cell.selected .bs-frame { border-color: #00C853; box-shadow: inset 0 0 0 2px #fff; }
.bs-focus { position: absolute; pointer-events: none; border: 7px solid #1B5E20; }
.bs-focus.hold { border-color: #B71C1C; }
.bs-focus-tag { position: absolute; height: 32px; line-height: 32px; padding: 0 10px; background: #1B5E20; color: #fff; font-size: 22px; font-weight: 700; white-space: nowrap; }
.bs-focus-tag.hold { background: #B71C1C; }
.bs-compare { display: grid; gap: 16px; align-items: start; }
.bs-compare .col { border: 2px solid #ddd; padding: 10px; background: #fff; }
.bs-compare .col.travisse_pick { border-color: #B7791F; } .bs-compare .col.fable_pick { border-color: #1565C0; } .bs-compare .col.hold { border-color: #B71C1C; } .bs-compare .col.rejected { border-color: #616161; }
.bs-compare h3 { margin: 0 0 4px; font-size: 24px; } .bs-compare p { margin: 2px 0; font-size: 14px; } .bs-compare .piece { margin-top: 8px; background: ${TILE_BG}; display: flex; justify-content: center; }
.bs-compare small { font-weight: 400; color: #666; }
`;
  /**
   * One cell of the sheet from its view: header strip, card, sticker, POP, status frame/tag, NOT VIABLE badge.
   * `src(rel)` turns a run-dir-relative logo path into an img src. `at` positions it absolutely (sheet) or
   * leaves it static (compare / header).
   */
  function cellHtml(view, { src = (p) => p, at = null, selectable = false, logoAttrs = (rel) => `data-logo="${esc(rel)}"` } = {}) {
    const g = sheetGeometry(1, 1);
    const { CARD_W, SIDE_W, LABEL_H, CELL_PAD } = GEOMETRY;
    const status = view.status && STATUS_STYLE[view.status] ? STATUS_STYLE[view.status] : null;
    const rejected = view.status === 'rejected';
    const classes = ['bs-cell', view.status ?? '', selectable ? 'selectable' : ''].filter(Boolean).join(' ');
    const pos = at ? `left: ${at.left}px; top: ${at.top}px; ` : 'position: relative; ';
    const card = badgeShotHtml({ logoUrl: src(view.card.logo), primary: view.card.primary, secondary: view.card.secondary, text: view.card.text, textSecondary: view.card.text_secondary, issueId: view.card.issue_id ?? 1, side: 'back', logoAttrs: logoAttrs(view.card.logo) }, { width: CARD_W });
    const sticker = view.sticker && view.sticker.logo
      ? `<div style="width: ${SIDE_W}px; height: ${SIDE_W}px;">${stickerMockHtml({ logoUrl: src(view.sticker.logo), band: view.sticker.band, headline: view.sticker.headline, body: view.sticker.body, seed: view.sticker.seed, size: SIDE_W, logoAttrs: logoAttrs(view.sticker.logo) })}</div>`
      : stickerPlaceholderHtml({ width: SIDE_W, height: g.sideH });
    const popW = Math.round(g.sideH * 300 / 420);
    const pop = popTileHtml({ logoUrl: src(view.pop.logo), ground: view.pop.ground, offer: view.pop.offer, width: popW, logoAttrs: logoAttrs(view.pop.logo) });
    const tagText = status ? status.tag : null;
    const frame = status ? `<div class="bs-frame" style="border-color: ${status.color};"></div><div class="bs-tag" style="right: 4px; top: ${LABEL_H + CELL_PAD}px; background: ${status.color}; color: ${status.text};">${esc(tagText)}</div>` : '<div class="bs-frame"></div>';
    const rejectedWord = rejected ? '<div class="bs-rejected-word">REJECTED</div>' : '';
    const notViable = view.not_viable ? `<div class="bs-frame" style="border-color: ${NOT_VIABLE_STYLE.color};"></div><div class="bs-tag" style="left: 4px; bottom: 4px; background: ${NOT_VIABLE_STYLE.color}; color: ${NOT_VIABLE_STYLE.text}; font-size: 11px;">${esc(`${NOT_VIABLE_STYLE.tag}: ${view.not_viable.verdict}`)}</div>` : '';
    return `<div class="${classes}" data-letter="${esc(view.letter)}" style="${pos}width: ${g.cellW}px; height: ${g.cellH}px;">
  <div class="bs-label" style="background: ${esc(view.header.bg)};">${esc(view.header.text)}</div>
  <div class="bs-tile" style="left: ${CELL_PAD}px; top: ${LABEL_H + CELL_PAD}px; width: ${CARD_W}px; height: ${g.cardH}px;">${card}</div>
  <div class="bs-tile" style="left: ${CARD_W + CELL_PAD * 2}px; top: ${LABEL_H + CELL_PAD}px; width: ${SIDE_W}px; height: ${g.sideH}px;">${sticker}</div>
  <div class="bs-tile" style="left: ${CARD_W + CELL_PAD * 2}px; top: ${LABEL_H + CELL_PAD * 2 + g.sideH}px; width: ${SIDE_W}px; height: ${g.sideH}px;">${pop}</div>
  ${rejectedWord}${frame}${notViable}
</div>`;
  }
  /**
   * The whole montage from a sheet view ({ columns:[{index,hex,text}], rows:[{key,text}], cells:{L: view} }).
   * `focus` = { letter, hold } frames Fable's default (green) or the HOLD cell (red) like review-canvas did.
   */
  function sheetHtml(sheetView, { src = (p) => p, focus = null, selectable = false } = {}) {
    const columns = sheetView.columns ?? [];
    const rows = sheetView.rows ?? [];
    const g = sheetGeometry(columns.length, rows.length);
    const { ROW_HEADER_W, COL_HEADER_H } = GEOMETRY;
    const out = [];
    columns.forEach((col, c) => out.push(`<div class="bs-hdr col" style="left: ${ROW_HEADER_W + c * g.cellW}px; top: 0; width: ${g.cellW}px;">${esc(col.text ?? col.hex)}</div>`));
    rows.forEach((row, r) => out.push(`<div class="bs-hdr row" style="left: 0; top: ${COL_HEADER_H + r * g.cellH}px; height: ${g.cellH}px;">${esc(row.text ?? row.key)}</div>`));
    const place = (view) => {
      const r = rows.findIndex((row) => row.key === view.row);
      const c = view.column_index ?? columns.findIndex((col) => col.hex === view.card.secondary);
      if (r < 0 || c < 0) throw new Error(`Cell ${view.letter} points at a row/column that is not on the sheet`);
      return { left: ROW_HEADER_W + c * g.cellW, top: COL_HEADER_H + r * g.cellH };
    };
    for (const view of Object.values(sheetView.cells ?? {})) out.push(cellHtml(view, { src, at: place(view), selectable }));
    if (focus?.letter && sheetView.cells?.[focus.letter]) {
      const { left, top } = place(sheetView.cells[focus.letter]);
      const tag = focus.hold ? `HOLD ${focus.letter}: traced from small source` : `default ${focus.letter}`;
      out.push(`<div class="bs-focus${focus.hold ? ' hold' : ''}" style="left: ${left + 3}px; top: ${top + 3}px; width: ${g.cellW - 6}px; height: ${g.cellH - 6}px;"></div><div class="bs-focus-tag${focus.hold ? ' hold' : ''}" style="left: ${left}px; top: ${Math.max(0, top - 30)}px;">${esc(tag)}</div>`);
    }
    return `<div class="bs-sheet" style="width: ${g.sheetW}px; height: ${g.sheetH}px;">${out.join('\n')}</div>`;
  }
  /** Shortlisted cells side by side (card, sticker, POP, every color with its provenance). */
  function compareHtml(sheetView, letters, { src = (p) => p, colW = 300, provenance = {} } = {}) {
    const cols = letters.map((letter) => {
      const view = sheetView.cells?.[letter];
      if (!view) return `<div class="col"><h3>${esc(letter)}</h3><p>not on the sheet</p></div>`;
      const status = view.status ? ` <small>${esc(view.status.replace('_', ' '))}</small>` : '';
      const stickerW = colW; const popW = Math.round(colW * 0.62 * 300 / 420);
      const sticker = view.sticker && view.sticker.logo ? stickerMockHtml({ logoUrl: src(view.sticker.logo), band: view.sticker.band, headline: view.sticker.headline, body: view.sticker.body, seed: view.sticker.seed, size: stickerW }) : stickerPlaceholderHtml({ width: colW, height: Math.round(colW * 0.62) });
      const lines = [
        `<p><b>${esc(view.row_label ?? view.row)}</b></p>`,
        `<p>card ${esc(view.card.primary)}${provenance.primary?.[letter] ? ` (${esc(provenance.primary[letter])})` : ''}</p>`,
        `<p>band ${esc(view.card.secondary)}${provenance.secondary?.[letter] ? ` (${esc(provenance.secondary[letter])})` : ''}</p>`,
        `<p>text ${esc(view.card.text)}, print digit ${esc(view.print?.text_secondary ?? view.card.text_secondary)}${view.print?.fix ? ` -> fix ${esc(view.print.fix)}` : ''}${view.print?.digit_contrast != null ? `, digit ${esc(view.print.digit_contrast)}:1` : ''}</p>`,
      ];
      return `<div class="col${view.status ? ` ${esc(view.status)}` : ''}" data-letter="${esc(letter)}"><h3>${esc(letter)}${status}</h3>${lines.join('')}<div class="piece">${badgeShotHtml({ logoUrl: src(view.card.logo), primary: view.card.primary, secondary: view.card.secondary, text: view.card.text, textSecondary: view.card.text_secondary, issueId: view.card.issue_id ?? 1 }, { width: colW })}</div><div class="piece">${sticker}</div><div class="piece">${popTileHtml({ logoUrl: src(view.pop.logo), ground: view.pop.ground, offer: view.pop.offer, width: popW })}</div></div>`;
    });
    return `<div class="bs-compare" style="grid-template-columns: repeat(${Math.min(letters.length, 5)}, ${colW + 24}px);">${cols.join('\n')}</div>`;
  }
  /** A minimal standalone page around any template output (used for in-memory rasters and the sheet file). */
  function pageHtml(body, { title = 'preview', width = null, background = '#ffffff', extraCss = '' } = {}) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>html, body { margin: 0; padding: 0; background: ${esc(background)}; }${width ? ` body { width: ${width}px; }` : ''}${SHEET_CSS}${extraCss}</style></head><body>${body}</body></html>`;
  }

  return {
    esc, contrast, luminance, computeTextColor, seedFrom, mockQrSvg, svgDataUri,
    BADGE_LAYOUT, BADGE_WIDTH_PX, BADGE_HEIGHT_PX, badgeCardHtml, badgeShotHtml,
    stickerMockHtml, stickerPlaceholderHtml, popTileHtml,
    SIGNAGE_CONFIG, SIGNAGE_QR_ROWS, signageQrSvg, signageLayout, signagePreviewHtml,
    GEOMETRY, STATUS_STYLE, NOT_VIABLE_STYLE, SHEET_CSS, sheetGeometry, cellHtml, sheetHtml, compareHtml, pageHtml,
  };
});
