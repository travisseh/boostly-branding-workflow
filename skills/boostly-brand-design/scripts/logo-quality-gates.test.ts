import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  assessAuthoredColorRetention,
  assessCounterTopology,
  assessInkRetention,
  assessPngColorType,
  assessRenderLegibility,
  assessSourceOverlay,
  assessTextLegibility,
} from './logo-quality-gates.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

test('badge uploads must use truecolor PNG rather than indexed palette PNG', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-png-color-type-'));
  try {
    const indexed = path.join(directory, 'indexed.png');
    const rgba = path.join(directory, 'rgba.png');
    const source = Buffer.from('<svg width="300" height="80" xmlns="http://www.w3.org/2000/svg"><text x="10" y="60" font-size="54" fill="#fff">PAKKA</text></svg>');
    await sharp(source).png({ palette: true }).toFile(indexed);
    await sharp(source).ensureAlpha().png({ palette: false }).toFile(rgba);

    const [indexedResult, rgbaResult] = await Promise.all([
      assessPngColorType(indexed),
      assessPngColorType(rgba),
    ]);
    assert.equal(indexedResult.pass, false, JSON.stringify(indexedResult));
    assert.equal(indexedResult.verdict, 'indexed_png_not_supported');
    assert.equal(indexedResult.color_type, 3);
    assert.equal(rgbaResult.pass, true, JSON.stringify(rgbaResult));
    assert.equal(rgbaResult.color_type, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Luna Pizza full-lockup fixture fails at the true 126x56 product logo box', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-luna-legibility-bad-'));
  try {
    const logo = path.join(directory, 'luna-pizza-full-lockup-bad.png');
    await sharp(Buffer.from(`
      <svg width="1200" height="700" xmlns="http://www.w3.org/2000/svg">
        <rect width="1200" height="700" fill="none"/>
        <text x="600" y="270" text-anchor="middle" font-family="Arial" font-size="170" font-weight="700" fill="#FFFFFF">LUNA PIZZA</text>
        <text x="600" y="390" text-anchor="middle" font-family="Arial" font-size="42" letter-spacing="9" fill="#FFFFFF">RESTAURANT AND CATERING</text>
        <text x="600" y="475" text-anchor="middle" font-family="Arial" font-size="34" letter-spacing="7" fill="#FFFFFF">SIMSBURY CONNECTICUT</text>
      </svg>
    `)).png().toFile(logo);

    const result = await assessRenderLegibility(logo);
    assert.equal(result.pass, false);
    assert.equal(result.verdict, 'illegible_at_product_size');
    assert(result.proxy.small_component_ink_share > 0.08);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('text-dominant logo must expose the business name at the true product size', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-text-legibility-'));
  try {
    const bad = path.join(directory, 'detailed-lockup.png');
    const good = path.join(directory, 'simple-wordmark.png');
    await sharp(Buffer.from(`
      <svg width="2400" height="700" xmlns="http://www.w3.org/2000/svg">
        <rect x="20" y="20" width="2360" height="660" rx="40" fill="none" stroke="#FFFFFF" stroke-width="22"/>
        <text x="1200" y="245" text-anchor="middle" font-family="Arial" font-size="105" font-weight="700" fill="#FFFFFF">PAKKA LOCAL</text>
        <text x="1200" y="390" text-anchor="middle" font-family="Arial" font-size="54" letter-spacing="14" fill="#FFFFFF">AUTHENTIC INDIAN CUISINE</text>
        <text x="1200" y="510" text-anchor="middle" font-family="Arial" font-size="46" letter-spacing="12" fill="#FFFFFF">SAN RAMON CALIFORNIA</text>
      </svg>
    `)).png().toFile(bad);
    await sharp(Buffer.from(`
      <svg width="1200" height="300" xmlns="http://www.w3.org/2000/svg">
        <text x="600" y="220" text-anchor="middle" font-family="Arial" font-size="185" font-weight="700" fill="#FFFFFF">PAKKA LOCAL</text>
      </svg>
    `)).png().toFile(good);

    const [badResult, goodResult] = await Promise.all([
      assessTextLegibility(bad, 'PAKKA LOCAL'),
      assessTextLegibility(good, 'PAKKA LOCAL'),
    ]);
    assert.equal(badResult.pass, false, JSON.stringify(badResult));
    assert.equal(goodResult.pass, true, JSON.stringify(goodResult));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('counter-bearing wordmarks fail when enclosed letter space is filled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-counter-topology-'));
  try {
    const good = path.join(directory, 'counter-preserved.png');
    const bad = path.join(directory, 'counter-filled.png');
    const ring = '<path d="M20 20 H180 V180 H20 Z M65 60 H135 V140 H65 Z" fill="#fff" fill-rule="evenodd"/>';
    const block = '<path d="M20 20 H180 V180 H20 Z" fill="#fff"/>';
    await sharp(Buffer.from(`<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">${ring}</svg>`)).png().toFile(good);
    await sharp(Buffer.from(`<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">${block}</svg>`)).png().toFile(bad);

    const [goodResult, badResult] = await Promise.all([
      assessCounterTopology(good, 'O'),
      assessCounterTopology(bad, 'O'),
    ]);
    assert.equal(goodResult.pass, true, JSON.stringify(goodResult));
    assert.equal(goodResult.detected_counter_count, 1);
    assert.equal(badResult.pass, false, JSON.stringify(badResult));
    assert.deepEqual(badResult.reasons, ['counter_bearing_glyphs_have_filled_interiors']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('open-by-design counters pass only against a matching verified source (Hooligan\'s)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-counter-open-'));
  try {
    // Square annulus with a slit: the "counter" connects to the exterior, so it
    // is never an enclosed hole, the authored topology of graffiti faces.
    const open = path.join(directory, 'counter-open.png');
    const ring = path.join(directory, 'counter-enclosed.png');
    const block = path.join(directory, 'counter-filled.png');
    await sharp(Buffer.from(`<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><path d="M20 20 H180 V180 H110 V140 H135 V60 H65 V140 H90 V180 H20 Z" fill="#fff"/></svg>`)).png().toFile(open);
    await sharp(Buffer.from(`<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><path d="M20 20 H180 V180 H20 Z M65 60 H135 V140 H65 Z" fill="#fff" fill-rule="evenodd"/></svg>`)).png().toFile(ring);
    await sharp(Buffer.from(`<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg"><path d="M20 20 H180 V180 H20 Z" fill="#fff"/></svg>`)).png().toFile(block);

    const noSource = await assessCounterTopology(open, 'O');
    assert.equal(noSource.pass, false, JSON.stringify(noSource));

    const withOpenSource = await assessCounterTopology(open, 'O', open);
    assert.equal(withOpenSource.pass, true, JSON.stringify(withOpenSource));
    assert.equal(withOpenSource.source_detected_counter_count, 0);

    // Nonna direction: a source WITH enclosed counters never excuses a filled final.
    const filledVsRing = await assessCounterTopology(block, 'O', ring);
    assert.equal(filledVsRing.pass, false, JSON.stringify(filledVsRing));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Gold simple-wordmark fixture passes at the true 126x56 product logo box', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-gold-legibility-good-'));
  try {
    const logo = path.join(directory, 'gold-simple-wordmark-good.png');
    await sharp(Buffer.from(`
      <svg width="1000" height="300" xmlns="http://www.w3.org/2000/svg">
        <text x="500" y="220" text-anchor="middle" font-family="Arial" font-size="190" font-weight="700" fill="#FFFFFF">GOLDFINCH</text>
      </svg>
    `)).png().toFile(logo);

    const result = await assessRenderLegibility(logo);
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(result.verdict, 'ok');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Smoke on the Water missing-center fixture fails authored ink retention', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-smoke-ink-loss-bad-'));
  try {
    const source = path.join(directory, 'smoke-source.png');
    const final = path.join(directory, 'smoke-final-missing-bbq.png');
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    await sharp({ create: { width: 600, height: 240, channels: 4, background: transparent } })
      .composite([
        { input: Buffer.from('<svg width="220" height="160"><rect x="5" y="5" width="210" height="150" rx="18" fill="#111"/></svg>'), left: 20, top: 40 },
        { input: Buffer.from('<svg width="90" height="80"><rect x="5" y="5" width="80" height="70" rx="10" fill="#111"/></svg>'), left: 255, top: 80 },
        { input: Buffer.from('<svg width="220" height="160"><rect x="5" y="5" width="210" height="150" rx="18" fill="#111"/></svg>'), left: 360, top: 40 },
      ])
      .png()
      .toFile(source);
    await sharp({ create: { width: 600, height: 240, channels: 4, background: transparent } })
      .composite([
        { input: Buffer.from('<svg width="220" height="160"><rect x="5" y="5" width="210" height="150" rx="18" fill="#fff"/></svg>'), left: 20, top: 40 },
        { input: Buffer.from('<svg width="220" height="160"><rect x="5" y="5" width="210" height="150" rx="18" fill="#fff"/></svg>'), left: 360, top: 40 },
      ])
      .png()
      .toFile(final);

    const result = await assessInkRetention(source, final);
    assert.equal(result.pass, false);
    assert.equal(result.verdict, 'authored_ink_lost');
    assert((result.coverage_recall ?? 1) < 0.97);
    assert(result.vanished_components.some((component) => component.ink_share > 0.02));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserved silhouette and recolored knockout pass ink retention', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-ink-retention-good-'));
  try {
    const source = path.join(directory, 'verified-source.png');
    const final = path.join(directory, 'white-knockout.png');
    const svg = (fill: string) => Buffer.from(`<svg width="500" height="220" xmlns="http://www.w3.org/2000/svg"><path d="M25 35 H475 V185 H25 Z M120 80 H190 V140 H120 Z" fill="${fill}" fill-rule="evenodd"/></svg>`);
    await sharp(svg('#B51E2E')).png().toFile(source);
    await sharp(svg('#FFFFFF')).png().toFile(final);

    const result = await assessInkRetention(source, final);
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(result.verdict, 'ok');
    assert((result.coverage_recall ?? 0) >= 0.97);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a larger rebuild of a tiny source with a small recall shortfall is rebuilt_from_low_res_source; a large source, a deep shortfall, or a vanished part stays authored_ink_lost (Toscana 2026-09-29)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-ink-retention-low-res-rebuild-'));
  try {
    // three bars standing in for letters. The outer bars fix the ink box, so alignment cannot
    // scale the difference away; `inset` thins only the middle bar (lighter letter weight).
    const bars = (scale: number, inset: number, fill: string) => {
      const rects = [0, 1, 2].map((i) => {
        const k = i === 1 ? inset : 0;
        const x = (10 + i * 80) * scale + k;
        const y = 8 * scale + k;
        return `<rect x="${x}" y="${y}" width="${60 * scale - 2 * k}" height="${40 * scale - 2 * k}" fill="${fill}"/>`;
      }).join('');
      return Buffer.from(`<svg width="${250 * scale}" height="${56 * scale}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`);
    };
    const write = async (name: string, svg: Buffer) => {
      const file = path.join(directory, name);
      await sharp(svg).png().toFile(file);
      return file;
    };
    const tinySource = await write('tiny-source.png', bars(1, 0, '#A22326'));
    const largeSource = await write('large-source.png', bars(6, 0, '#A22326'));
    // rebuild at 6x with the middle bar thinned 15 px a side: about 0.93 of the ink
    const rebuild = await write('rebuild.png', bars(6, 15, '#FFFFFF'));
    // deep shortfall: middle bar thinned 60 px a side, about 0.78 of the ink (still present)
    const thin = await write('thin.png', bars(6, 60, '#FFFFFF'));
    // same size as the source: a cut, not a rebuild
    const sameSize = await write('same-size.png', bars(1, 3, '#FFFFFF'));

    const ok = await assessInkRetention(tinySource, rebuild);
    assert.equal(ok.pass, false, JSON.stringify(ok));
    assert.equal(ok.verdict, 'rebuilt_from_low_res_source', JSON.stringify(ok));
    assert((ok.coverage_recall ?? 0) >= 0.9 && (ok.coverage_recall ?? 1) < 0.97, JSON.stringify(ok));
    assert.deepEqual(ok.vanished_components, []);

    const bigSource = await assessInkRetention(largeSource, rebuild);
    assert.equal(bigSource.verdict, 'authored_ink_lost', JSON.stringify(bigSource));

    const deep = await assessInkRetention(tinySource, thin);
    assert.equal(deep.verdict, 'authored_ink_lost', JSON.stringify(deep));

    const cut = await assessInkRetention(tinySource, sameSize);
    assert.equal(cut.verdict, 'authored_ink_lost', JSON.stringify(cut));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authored white that becomes negative space is authored_white_dropped, not authored_ink_lost (Coloradough snow caps)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-ink-retention-white-dropped-'));
  try {
    const source = path.join(directory, 'verified-source.png');
    const openRidge = path.join(directory, 'open-ridge-knockout.png');
    const wordLost = path.join(directory, 'word-lost-knockout.png');
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    // blue mountain with white snow caps (about 15% of the ink) over a red word block
    const mountain = { input: Buffer.from('<svg width="400" height="240"><polygon points="200,10 390,230 10,230" fill="#247EBB"/></svg>'), left: 100, top: 20 };
    const snow = { input: Buffer.from('<svg width="120" height="50"><polygon points="60,0 118,48 2,48" fill="#FFFFFF"/></svg>'), left: 240, top: 40 };
    const word = { input: Buffer.from('<svg width="480" height="70"><rect width="480" height="70" rx="8" fill="#C51F2C"/></svg>'), left: 60, top: 280 };
    await sharp({ create: { width: 600, height: 380, channels: 4, background: transparent } }).composite([mountain, snow, word]).png().toFile(source);
    // open ridge: mountain + word white, snow caps transparent (card ground shows through)
    const whiteMountain = { input: Buffer.from('<svg width="400" height="240"><polygon points="200,10 390,230 10,230" fill="#FFFFFF"/></svg>'), left: 100, top: 20 };
    const cutSnow = { input: Buffer.from('<svg width="120" height="50"><polygon points="60,0 118,48 2,48" fill="#000"/></svg>'), left: 240, top: 40, blend: 'dest-out' as const };
    const whiteWord = { input: Buffer.from('<svg width="480" height="70"><rect width="480" height="70" rx="8" fill="#FFFFFF"/></svg>'), left: 60, top: 280 };
    await sharp({ create: { width: 600, height: 380, channels: 4, background: transparent } }).composite([whiteMountain, cutSnow, whiteWord]).png().toFile(openRidge);
    // word lost: mountain kept (snow filled), the red word cut down to a sliver so the lockup aspect survives
    const sliver = { input: Buffer.from('<svg width="480" height="70"><rect x="0" y="62" width="480" height="8" fill="#FFFFFF"/></svg>'), left: 60, top: 280 };
    await sharp({ create: { width: 600, height: 380, channels: 4, background: transparent } }).composite([whiteMountain, sliver]).png().toFile(wordLost);

    const ridge = await assessInkRetention(source, openRidge);
    assert.equal(ridge.pass, false, JSON.stringify(ridge));
    assert.equal(ridge.verdict, 'authored_white_dropped', JSON.stringify(ridge));
    assert((ridge.coverage_recall ?? 1) < 0.97);
    assert((ridge.dropped_ink_white_share ?? 0) >= 0.95, JSON.stringify(ridge));
    assert.deepEqual(ridge.vanished_components, []);

    const lost = await assessInkRetention(source, wordLost);
    assert.equal(lost.pass, false);
    assert.equal(lost.verdict, 'authored_ink_lost', JSON.stringify(lost));
    assert((lost.dropped_ink_white_share ?? 1) < 0.95);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authored near-black ground merging into a near-black card is authored_dark_dropped; the same drop on a contrasting card, without a primary, or with a gold word lost stays authored_ink_lost (Cellblock Sips 2026-09-21)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-ink-retention-dark-dropped-'));
  try {
    const source = path.join(directory, 'verified-source.png');
    const goldOnly = path.join(directory, 'gold-ink-only.png');
    const goldWordLost = path.join(directory, 'gold-word-lost.png');
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    // authored kit mark: near-black #161819 panel (about 75% of the ink) with two gold bars (the lettering) and a gold keyline
    const panel = { input: Buffer.from('<svg width="560" height="260"><rect width="560" height="260" rx="12" fill="#161819"/></svg>'), left: 20, top: 20 };
    // the keyline hugs the panel edge so the extraction keeps the lockup's aspect (the aspect tolerance is a separate rule)
    const keyline = { input: Buffer.from('<svg width="552" height="252"><rect x="4" y="4" width="544" height="244" rx="10" fill="none" stroke="#E4B76A" stroke-width="8"/></svg>'), left: 24, top: 24 };
    const wordA = { input: Buffer.from('<svg width="360" height="60"><rect width="360" height="60" rx="6" fill="#E4B76A"/></svg>'), left: 120, top: 80 };
    const wordB = { input: Buffer.from('<svg width="260" height="40"><rect width="260" height="40" rx="6" fill="#E4B76A"/></svg>'), left: 170, top: 170 };
    await sharp({ create: { width: 600, height: 300, channels: 4, background: transparent } }).composite([panel, keyline, wordA, wordB]).png().toFile(source);
    // the shaded gold extraction: keyline + both words, panel cut (the card ground shows through); keyline keeps the lockup aspect
    await sharp({ create: { width: 600, height: 300, channels: 4, background: transparent } }).composite([keyline, wordA, wordB]).png().toFile(goldOnly);
    // same cut but the second gold word is also gone
    await sharp({ create: { width: 600, height: 300, channels: 4, background: transparent } }).composite([keyline, wordA]).png().toFile(goldWordLost);

    const merged = await assessInkRetention(source, goldOnly, { primary: '#030607' });
    assert.equal(merged.pass, false, JSON.stringify(merged));
    assert.equal(merged.verdict, 'authored_dark_dropped', JSON.stringify(merged));
    assert((merged.dropped_ink_dark_share ?? 0) >= 0.95, JSON.stringify(merged));
    assert.equal(merged.dark_ground?.merges, true, JSON.stringify(merged.dark_ground));
    assert((merged.dark_ground?.contrast ?? 9) < 1.5);
    // the panel and its gold ink are one connected component in the source mask, so the drop shows as a
    // recall shortfall (no separate vanished component); either path must classify as dark ground
    assert(merged.reasons.some((reason) => reason.startsWith('dropped_ink_is_authored_dark_ground')), JSON.stringify(merged.reasons));

    const contrasting = await assessInkRetention(source, goldOnly, { primary: '#FFFFFF' });
    assert.equal(contrasting.verdict, 'authored_ink_lost', JSON.stringify(contrasting));
    assert.equal(contrasting.dark_ground?.merges, false);

    const noPrimary = await assessInkRetention(source, goldOnly);
    assert.equal(noPrimary.verdict, 'authored_ink_lost', JSON.stringify(noPrimary));
    assert.equal(noPrimary.dark_ground, null);

    const wordLost = await assessInkRetention(source, goldWordLost, { primary: '#030607' });
    assert.equal(wordLost.verdict, 'authored_ink_lost', JSON.stringify(wordLost));
    assert((wordLost.dropped_ink_dark_share ?? 1) < 0.95 || wordLost.vanished_components.length > 1, JSON.stringify(wordLost));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authored color retention rejects a destructive black knockout but accepts preservation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-authored-color-retention-'));
  try {
    const source = path.join(directory, 'source.png');
    const preserved = path.join(directory, 'preserved.png');
    const collapsed = path.join(directory, 'collapsed.png');
    const mark = (fill: string, outline: string) => Buffer.from(`<svg width="700" height="300" xmlns="http://www.w3.org/2000/svg"><text x="350" y="215" text-anchor="middle" font-family="Arial" font-size="180" font-weight="900" fill="${fill}" stroke="${outline}" stroke-width="12">HOOLIGANS</text></svg>`);
    await sharp(mark('#FCFC34', '#050505')).png().toFile(source);
    await sharp(mark('#FCFC34', '#050505')).resize(680, 291).png().toFile(preserved);
    await sharp(mark('#050505', '#050505')).png().toFile(collapsed);

    const [good, bad] = await Promise.all([
      assessAuthoredColorRetention(source, preserved),
      assessAuthoredColorRetention(source, collapsed),
    ]);
    assert.equal(good.pass, true, JSON.stringify(good));
    assert.equal(bad.pass, false, JSON.stringify(bad));
    assert.equal(bad.verdict, 'authored_color_treatment_lost');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('border-dust cleanup below two percent passes ink retention', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-ink-retention-dust-good-'));
  try {
    const source = path.join(directory, 'source-with-dust.png');
    const final = path.join(directory, 'clean-final.png');
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    const main = { input: Buffer.from('<svg width="360" height="160"><rect width="360" height="160" rx="24" fill="#161616"/></svg>'), left: 20, top: 20 };
    await sharp({ create: { width: 400, height: 200, channels: 4, background: transparent } })
      .composite([main, { input: Buffer.from('<svg width="2" height="2"><rect width="2" height="2" fill="#fff"/></svg>'), left: 0, top: 0 }])
      .png()
      .toFile(source);
    await sharp({ create: { width: 400, height: 200, channels: 4, background: transparent } })
      .composite([main])
      .png()
      .toFile(final);

    const result = await assessInkRetention(source, final);
    assert.equal(result.pass, true, JSON.stringify(result));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('thin stylized script fragments at product size are informational, not a hold', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-script-informational-'));
  try {
    const logo = path.join(directory, 'script.png');
    // Hairline cursive-like strokes: tall letterforms whose strokes vanish when
    // fitted into 126x56, with no small text line anywhere in the lockup.
    const strokes = Array.from({ length: 14 }, (_, i) => {
      const x = 60 + i * 95;
      return `<path d="M${x} 420 C ${x + 20} 200, ${x + 60} 200, ${x + 40} 420 S ${x + 90} 520, ${x + 70} 300" fill="none" stroke="#FFFFFF" stroke-width="7"/>`;
    }).join('');
    await sharp(Buffer.from(`<svg width="1500" height="600" xmlns="http://www.w3.org/2000/svg">${strokes}</svg>`)).png().toFile(logo);
    const result = await assessRenderLegibility(logo, { background: '#8E5DA6', cropOut: path.join(directory, 'crop4x.png') });
    assert.equal(result.verdict, 'stylized_script_informational', JSON.stringify(result));
    assert.equal(result.pass, true);
    assert.equal(result.attach_4x_crop_required, true);
    assert.equal(result.proxy.tiny_text_ink_share, 0);
    assert(result.proxy.small_component_ink_share > 0.08);
    const crop = await sharp(result.crop_4x).metadata();
    assert.equal(crop.width, 504);
    assert.equal(crop.height, 224);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a tiny descriptor line under a bold wordmark is still a hard render-legibility failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-tiny-text-hard-'));
  try {
    const logo = path.join(directory, 'est-line.png');
    await sharp(Buffer.from(`
      <svg width="1400" height="700" xmlns="http://www.w3.org/2000/svg">
        <text x="700" y="330" text-anchor="middle" font-family="Arial" font-size="230" font-weight="700" fill="#FFFFFF">ASTORIA</text>
        <text x="700" y="560" text-anchor="middle" font-family="Arial" font-size="150" font-weight="700" fill="#FFFFFF">PIZZA</text>
        <text x="700" y="660" text-anchor="middle" font-family="Arial" font-size="60" letter-spacing="14" fill="#FFFFFF">EST. 2014 QUEENS NEW YORK CITY</text>
      </svg>
    `)).png().toFile(logo);
    const result = await assessRenderLegibility(logo);
    assert.equal(result.pass, false, JSON.stringify(result));
    assert.equal(result.verdict, 'illegible_at_product_size');
    assert(result.proxy.tiny_text_ink_share > 0.08);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source-overlay passes a faithful reframed copy and fails a redrawn or glyph-dropped candidate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-source-overlay-'));
  try {
    const wordmark = (extra: string, dx = 0) => Buffer.from(`
      <svg width="1200" height="400" xmlns="http://www.w3.org/2000/svg">
        <text x="${100 + dx}" y="260" font-family="Arial" font-size="200" font-weight="700" fill="#FFFFFF">MARA'S</text>${extra}
      </svg>
    `);
    const reference = path.join(directory, 'reference.png');
    const reframed = path.join(directory, 'reframed.png');
    const noApostrophe = path.join(directory, 'no-apostrophe.png');
    const redrawn = path.join(directory, 'redrawn.png');
    await sharp(wordmark('')).png().toFile(reference);
    // Same glyphs on a bigger canvas at another offset: bbox alignment must absorb it.
    await sharp(wordmark('', 300)).extend({ top: 200, bottom: 200, left: 0, right: 600, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(reframed);
    await sharp(Buffer.from(`
      <svg width="1200" height="400" xmlns="http://www.w3.org/2000/svg">
        <text x="100" y="260" font-family="Arial" font-size="200" font-weight="700" fill="#FFFFFF">MARA S</text>
      </svg>
    `)).png().toFile(noApostrophe);
    await sharp(Buffer.from(`
      <svg width="1200" height="400" xmlns="http://www.w3.org/2000/svg">
        <text x="100" y="260" font-family="Georgia" font-size="200" font-style="italic" fill="#FFFFFF">MARA'S</text>
      </svg>
    `)).png().toFile(redrawn);

    const same = await assessSourceOverlay(reframed, reference, path.join(directory, 'overlay.png'));
    assert.equal(same.pass, true, JSON.stringify(same));
    assert(same.iou > 0.95);
    assert.equal(same.component_drift, 0);
    const dropped = await assessSourceOverlay(noApostrophe, reference);
    assert.equal(dropped.pass, false, JSON.stringify(dropped));
    assert(dropped.reasons.includes('component_count_drift'));
    const other = await assessSourceOverlay(redrawn, reference);
    assert.equal(other.pass, false, JSON.stringify(other));
    assert(other.reasons.includes('redrawn_low_overlap'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// edge-quality (Skyboxx 2026-09-21) and sticker-ground (The Place Pizza 2026-09-17)
// ---------------------------------------------------------------------------------------------
import { assessEdgeQuality, assessStickerGround, contourRunLengths } from './logo-quality-gates.ts';

const CIRCLE_SVG = (size: number) => `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.42}" fill="#FFFFFF"/><text x="${size / 2}" y="${size * 0.58}" text-anchor="middle" font-family="Arial" font-size="${size * 0.28}" font-weight="700" fill="#000000">Sky</text></svg>`;

test('edge-quality: binary alpha under 1000px is binary_alpha; the same mark anti-aliased or at 1600px passes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-edge-quality-'));
  try {
    const smooth800 = path.join(directory, 'smooth-800.png');
    const binary800 = path.join(directory, 'binary-800.png');
    const binary1600 = path.join(directory, 'binary-1600.png');
    await sharp(Buffer.from(CIRCLE_SVG(800))).png().toFile(smooth800);
    // snap alpha to 0/255 (what FINALIZE step 3 does to a flat knockout)
    const snap = async (src: string, out: string) => {
      const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= 128 ? 255 : 0;
      await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(out);
    };
    await snap(smooth800, binary800);
    const smooth1600 = path.join(directory, 'smooth-1600.png');
    await sharp(Buffer.from(CIRCLE_SVG(1600))).png().toFile(smooth1600);
    await snap(smooth1600, binary1600);

    const [soft, binary, big] = await Promise.all([assessEdgeQuality(smooth800), assessEdgeQuality(binary800), assessEdgeQuality(binary1600)]);
    assert.equal(soft.verdict, 'ok', JSON.stringify(soft));
    assert.ok((soft.soft_edge_share ?? 0) >= 0.15);
    assert.equal(binary.verdict, 'binary_alpha', JSON.stringify(binary));
    assert.equal(binary.pass, false);
    assert.equal(binary.soft_edge_share, 0);
    assert.equal(binary.alpha_levels, 1);
    assert.equal(big.verdict, 'ok', 'binary alpha at 1600px sits under the print raster and passes');
    assert.equal(big.soft_edge_share, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('edge-quality: a nearest-neighbour upscale is stair_stepped (no 1px contour runs); the smooth render of the same shape is not', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-edge-stairs-'));
  try {
    const small = path.join(directory, 'small-300.png');
    const stepped = path.join(directory, 'stepped-1200.png');
    const smooth = path.join(directory, 'smooth-1200.png');
    await sharp(Buffer.from(CIRCLE_SVG(300))).png().toFile(small);
    await sharp(small).resize(1200, 1200, { kernel: 'nearest' }).png().toFile(stepped);
    await sharp(Buffer.from(CIRCLE_SVG(1200))).png().toFile(smooth);
    const [a, b] = await Promise.all([assessEdgeQuality(stepped), assessEdgeQuality(smooth)]);
    assert.equal(a.verdict, 'stair_stepped', JSON.stringify(a));
    assert.ok((a.stair_step_score ?? 0) > 0.65);
    assert.equal(b.verdict, 'ok', JSON.stringify(b));
    assert.ok((b.stair_step_score ?? 1) < 0.65);
    // the statistic itself: a 4x block upscale has runs that are multiples of 4, never 1
    const { data, info } = await sharp(stepped).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = new Uint8Array(info.width * info.height);
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3];
    const runs = contourRunLengths(alpha, info.width, info.height);
    assert.ok(runs.length > 50);
    assert.equal(runs.filter((r) => r === 1).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('edge-quality: effective resolution records the source and flags a trace/upscale from a source under 700px; a native or vector source does not', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-edge-source-'));
  try {
    const file = path.join(directory, 'smooth-1600.png');
    await sharp(Buffer.from(CIRCLE_SVG(1600))).png().toFile(file);
    const traced = await assessEdgeQuality(file, { source_native_longest_px: 640, derivation: 'trace', note: 'Facebook avatar 640x394' });
    assert.equal(traced.verdict, 'traced_from_small_source', JSON.stringify(traced));
    assert.equal(traced.upscale_factor, 2.5);
    assert.equal(traced.source_native_longest_px, 640);
    const vector = await assessEdgeQuality(file, { source_native_longest_px: 640, derivation: 'vector' });
    assert.equal(vector.verdict, 'ok');
    const bigSource = await assessEdgeQuality(file, { source_native_longest_px: 896, derivation: 'trace' });
    assert.equal(bigSource.verdict, 'ok', 'a trace of a source over the floor is fine');
    const unknown = await assessEdgeQuality(file);
    assert.equal(unknown.verdict, 'ok');
    assert.equal(unknown.source_native_longest_px, null);
    assert.equal(unknown.upscale_factor, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sticker-ground: an authored opaque panel fails; the same mark cut from its ground passes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-sticker-ground-'));
  try {
    const panel = path.join(directory, 'copper-panel.png');
    const cut = path.join(directory, 'cut.png');
    await sharp(Buffer.from('<svg width="900" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="400" fill="#B87333"/><text x="450" y="250" text-anchor="middle" font-family="Arial" font-size="150" font-weight="700" fill="#FFFFFF">PLACE</text></svg>')).png().toFile(panel);
    await sharp(Buffer.from('<svg width="900" height="400" xmlns="http://www.w3.org/2000/svg"><text x="450" y="250" text-anchor="middle" font-family="Arial" font-size="150" font-weight="700" fill="#B87333">PLACE</text></svg>')).png().toFile(cut);
    const [bad, good] = await Promise.all([assessStickerGround(panel), assessStickerGround(cut)]);
    assert.equal(bad.verdict, 'opaque_panel_ground', JSON.stringify(bad));
    assert.equal(bad.opaque_corners, 4);
    assert.equal(good.verdict, 'ok', JSON.stringify(good));
    assert.ok((good.opaque_bbox_share ?? 1) < 0.9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// sheet-viability: refuse junk before the variant sheet renders it (Dogwood Pizza 2026-09-21)
// ---------------------------------------------------------------------------------------------
import { assessSheetViability, nameLineGlyphCount, rejectedLabelMatch } from './logo-quality-gates.ts';

const WORDS = (text: string, background: string | null, extra = '') => `<svg width="900" height="${extra ? 420 : 200}" xmlns="http://www.w3.org/2000/svg">${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ''}${extra}<text x="30" y="${extra ? 380 : 150}" font-family="Arial" font-size="110" font-weight="700" fill="#111111">${text}</text></svg>`;

test('sheet-viability: an opaque panel is opaque_ground; the same words on a transparent ground pass; a rejected label is refused without an image', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-sheet-viability-'));
  try {
    const panel = path.join(directory, 'panel.png');
    const clear = path.join(directory, 'clear.png');
    await sharp(Buffer.from(WORDS('DOGWOOD PIZZA', '#FFFFFF'))).png().toFile(panel);
    await sharp(Buffer.from(WORDS('DOGWOOD PIZZA', null))).png().toFile(clear);
    const opaque = await assessSheetViability(panel, { expected: 'Dogwood Pizza' });
    assert.equal(opaque.pass, false);
    assert.equal(opaque.verdict, 'opaque_ground', JSON.stringify(opaque));
    assert.equal(opaque.checks.opaque_ground.opaque_corners, 4);
    const ok = await assessSheetViability(clear, { expected: 'Dogwood Pizza', label: 'full color' });
    assert.equal(ok.pass, true, JSON.stringify(ok));
    assert.equal(ok.verdict, 'ok');
    const rejected = await assessSheetViability(clear, { label: 'words only (REJECTED: reads Do woo)' });
    assert.equal(rejected.pass, false);
    assert.equal(rejected.verdict, 'rejected_label');
    assert.equal(rejected.checks.rejected_label.matched, 'REJECTED');
    assert.equal(rejectedLabelMatch('full color', 'auto cut, rejected by Fable'), 'rejected');
    assert.equal(rejectedLabelMatch('projected sales'), null, 'the word must stand alone');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sheet-viability: a words cut that drops letters is wordmark_text_mismatch by OCR, and by letter count when no name is known; a cut that only drops the emblem passes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boostly-sheet-words-'));
  try {
    const source = path.join(directory, 'source.png');
    const bad = path.join(directory, 'bad-cut.png');
    const lockup = path.join(directory, 'lockup.png');
    const good = path.join(directory, 'good-cut.png');
    await sharp(Buffer.from(WORDS('DOGWOOD PIZZA', null))).png().toFile(source);
    await sharp(Buffer.from(WORDS('DO  WOO  PIZZA', null))).png().toFile(bad); // the g and d of Dogwood gone (Dogwood K-O)
    await sharp(Buffer.from(WORDS('DOGWOOD PIZZA', null, '<circle cx="450" cy="130" r="110" fill="#111111"/>'))).png().toFile(lockup);
    await sharp(Buffer.from(WORDS('DOGWOOD PIZZA', null))).png().toFile(good);

    const byOcr = await assessSheetViability(bad, { source, expected: 'Dogwood Pizza' });
    assert.equal(byOcr.pass, false);
    assert.equal(byOcr.verdict, 'wordmark_text_mismatch', JSON.stringify(byOcr.checks.wordmark));
    assert.equal(byOcr.checks.wordmark.method, 'ocr');
    assert.ok((byOcr.checks.wordmark.cut_edit_distance ?? 0) > (byOcr.checks.wordmark.maximum_edit_distance ?? 99));

    const byCount = await assessSheetViability(bad, { source });
    assert.equal(byCount.pass, false);
    assert.equal(byCount.verdict, 'wordmark_text_mismatch', JSON.stringify(byCount.checks.wordmark));
    assert.equal(byCount.checks.wordmark.method, 'components');
    // bold Arial fuses ZZ into one component, so the source counts 11 letter components; the cut lost the G and the D
    assert.equal(byCount.checks.wordmark.source_glyphs, 11);
    assert.equal(byCount.checks.wordmark.cut_glyphs, 10);
    assert.equal(byCount.checks.wordmark.missing_glyphs, 1);

    const legit = await assessSheetViability(good, { source: lockup, expected: 'Dogwood Pizza' });
    assert.equal(legit.pass, true, JSON.stringify(legit));
    const legitByCount = await assessSheetViability(good, { source: lockup });
    assert.equal(legitByCount.pass, true, JSON.stringify(legitByCount.checks.wordmark));
    assert.equal(legitByCount.checks.wordmark.missing_glyphs, 0, 'the emblem sits on its own line and is not a letter');

    // the letter counter itself: the emblem is a component but not a letter on the name line
    const { data, info } = await sharp(lockup).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(info.width * info.height);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = data[i * 4 + 3] >= 64 ? 1 : 0;
    const counted = nameLineGlyphCount({ pixels, width: info.width, height: info.height });
    assert.equal(counted.components, 12, JSON.stringify(counted));
    assert.equal(counted.glyphs, 11, JSON.stringify(counted));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
