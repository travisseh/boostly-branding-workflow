// Font loading for the direct signage renderer. Figtree static TTFs ship with the skill
// (references/fonts, OFL); the emoji used by the bathroom strips ("👉") comes from the macOS
// Apple Color Emoji bitmap font, which is what Figma rasterized into its exports (140x140 PNG).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit');

export const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
export const FONTS_DIR = path.join(SKILL_DIR, 'references', 'fonts');
export const EMOJI_FONT_CANDIDATES = [
  '/System/Library/Fonts/Apple Color Emoji.ttc',
  path.join(os.homedir(), 'Library/Fonts/Apple Color Emoji.ttc'),
];

const cache = new Map();

// Figma font style name ("Medium", "SemiBold", "Bold") -> static TTF file.
export function fontFile(family, style) {
  const fam = String(family).replace(/\s+/g, '');
  const sty = String(style).replace(/\s+/g, '');
  const candidates = [
    path.join(FONTS_DIR, `${fam}-${sty}.ttf`),
    path.join(os.homedir(), 'Library/Fonts', `${fam}-${sty}.ttf`),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`font ${family} ${style} not found (looked in ${candidates.join(', ')})`);
  return hit;
}

export function loadFont(family, style) {
  const key = `${family}|${style}`;
  if (cache.has(key)) return cache.get(key);
  const file = fontFile(family, style);
  const font = fontkit.openSync(file);
  const rec = { family, style, file, font, bytes: fs.readFileSync(file) };
  cache.set(key, rec);
  return rec;
}

export function loadEmojiFont() {
  if (cache.has('emoji')) return cache.get('emoji');
  const file = EMOJI_FONT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) { cache.set('emoji', null); return null; }
  const opened = fontkit.openSync(file);
  const font = opened.fonts ? opened.fonts[0] : opened;
  const rec = { family: 'Apple Color Emoji', style: 'Regular', file, font };
  cache.set('emoji', rec);
  return rec;
}

// Largest sbix strike at or above the requested pixel size (Figma drew the 70px emoji from a
// 140px raster; the 160 strike is the closest the font has).
export function emojiImage(glyph, px) {
  const im = glyph.getImageForSize(Math.max(px * 2, 160));
  if (!im || !im.data) return null;
  return im.data;
}
