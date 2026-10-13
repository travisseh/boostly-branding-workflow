#!/usr/bin/env node
// render-preview.mjs: the ONE in-memory raster path for the HTML previews (templates/sheet-templates.js).
// Playwright page.setContent on a blank page, no dev server, no Boostly app: relative <img src> paths
// resolve through a route handler that reads files under `baseDir`. The PNG buffer is returned and
// discarded unless the caller writes it. Used by variant-sheet.mjs --raster / render, review-canvas.mjs
// --png, signage-preview.mjs --png, and available to any gate that wants card pixels.
//
//   import { renderHtmlPng, renderCellPngs, renderSheetPng, renderSignagePng } from './render-preview.mjs';
//
// CLI (debug): node render-preview.mjs --html <file> --base-dir <dir> --out <png> [--scale 2] [--selector css]
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import templates from '../templates/sheet-templates.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', 'harness');
const require = createRequire(path.join(HARNESS_DIR, 'package.json'));
const ORIGIN = 'http://preview.local';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.js': 'text/javascript', '.css': 'text/css' };

/** One browser for a batch of renders: `await withBrowser(async (browser) => ...)`. */
export async function withBrowser(fn) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try { return await fn(browser); } finally { await browser.close(); }
}

/**
 * Render an HTML string to a PNG buffer. `baseDir` is the directory relative <img src> paths resolve
 * against (the HTML gets a <base href> for the fake origin and the route handler serves the files).
 * `selector` screenshots one element; otherwise the viewport (width x height, or fullPage).
 */
export async function renderHtmlPng(html, { baseDir = null, width = 1200, height = 800, scale = 2, selector = null, fullPage = false, browser = null, omitBackground = false, waitMs = 0 } = {}) {
  const run = async (b) => {
    const page = await b.newPage({ viewport: { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }, deviceScaleFactor: scale });
    try {
      await page.route(`${ORIGIN}/**`, async (route) => {
        // The fake origin mirrors the file system: <base href="http://preview.local/<abs baseDir>/"> so a
        // relative ../candidates/x.png climbs like it does on disk, and the pathname IS the absolute file path.
        const url = new URL(route.request().url());
        const file = decodeURIComponent(url.pathname);
        if (!baseDir || !existsSync(file) || !(await fs.stat(file)).isFile()) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', body: await fs.readFile(file) });
      });
      const baseHref = baseDir ? `${ORIGIN}${path.resolve(baseDir).split(path.sep).map(encodeURIComponent).join('/')}/` : null;
      const withBase = baseHref && !/<base\s/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`) : html;
      await page.setContent(withBase, { waitUntil: 'load' });
      await page.evaluate(async () => {
        await Promise.all([...document.images].map((img) => (img.complete ? Promise.resolve() : new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); }))));
        await Promise.all([...document.images].filter((img) => img.complete && img.naturalWidth > 0).map((img) => img.decode().catch(() => {})));
        if (document.fonts?.ready) await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      if (waitMs) await page.waitForTimeout(waitMs);
      if (selector) return await page.locator(selector).first().screenshot({ omitBackground });
      return await page.screenshot({ fullPage, omitBackground });
    } finally {
      await page.close();
    }
  };
  return browser ? run(browser) : withBrowser(run);
}

/** A standalone page for a template fragment, rendered with the sheet CSS; `rel` paths resolve against baseDir. */
export function fragmentPage(body, { width, title = 'preview', background = '#ffffff' } = {}) {
  return templates.pageHtml(body, { title, width, background });
}

/** The three tiles of one cell view (card 772x1200, sticker 1440x1440, POP 600x840 like the old renders). */
export async function renderCellPngs(view, { baseDir, browser = null, src = (p) => p }) {
  const g = templates.GEOMETRY;
  const run = async (b) => {
    const card = await renderHtmlPng(fragmentPage(templates.badgeShotHtml({ logoUrl: src(view.card.logo), primary: view.card.primary, secondary: view.card.secondary, text: view.card.text, textSecondary: view.card.text_secondary, issueId: view.card.issue_id ?? 1, side: 'back' }, { width: 386 }), { width: 386 }), { baseDir, width: 386, height: 600, scale: 2, selector: '.bs-badge-shot', browser: b });
    const sticker = view.sticker?.logo
      ? await renderHtmlPng(fragmentPage(templates.stickerMockHtml({ logoUrl: src(view.sticker.logo), band: view.sticker.band, headline: view.sticker.headline, body: view.sticker.body, seed: view.sticker.seed, size: 720 }), { width: 720 }), { baseDir, width: 720, height: 720, scale: 2, selector: '.bs-sticker', browser: b })
      : null;
    const pop = await renderHtmlPng(fragmentPage(templates.popTileHtml({ logoUrl: src(view.pop.logo), ground: view.pop.ground, offer: view.pop.offer, width: 300 }), { width: 300 }), { baseDir, width: 300, height: 420, scale: 2, selector: '.bs-pop', browser: b });
    return { card, sticker, pop, geometry: g };
  };
  return browser ? run(browser) : withBrowser(run);
}

/** The whole montage (sheet HTML page from variant-sheet.mjs composeSheet) at 1x, like the old stitched PNG. */
export async function renderSheetPng(sheetPageHtml, { baseDir, width, height, browser = null, scale = 1 }) {
  // baseDir is the directory the sheet html lives in (its <img src> are relative to it).
  return renderHtmlPng(sheetPageHtml, { baseDir, width, height, scale, selector: '.bs-sheet', browser });
}

/** The signage row (2x like the old harness shot). */
export async function renderSignagePng(spec, { baseDir, browser = null, src = (p) => p, scale = 1 }) {
  const layout = templates.signageLayout(templates.SIGNAGE_CONFIG, scale);
  const html = templates.signagePreviewHtml({ ...spec, logoUrl: spec.logo ? src(spec.logo) : null, logoLightUrl: spec.logo_light ? src(spec.logo_light) : null, scale });
  const w = Math.ceil(layout.shotWidthRem * 16); const h = Math.ceil(layout.shotHeightRem * 16);
  return renderHtmlPng(fragmentPage(html, { width: w }), { baseDir, width: w, height: h, scale: 2, selector: '.bs-signage-shot', browser });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  if (!args.html || !args.out) throw new Error('usage: render-preview.mjs --html <file> --out <png> [--base-dir <dir>] [--scale 2] [--selector css] [--width 1200] [--height 800]');
  const html = await fs.readFile(path.resolve(args.html), 'utf8');
  const png = await renderHtmlPng(html, { baseDir: args.baseDir ? path.resolve(args.baseDir) : path.dirname(path.resolve(args.html)), width: Number(args.width ?? 1200), height: Number(args.height ?? 800), scale: Number(args.scale ?? 2), selector: args.selector ?? null, fullPage: !args.selector });
  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(path.resolve(args.out), png);
  console.log(JSON.stringify({ ok: true, out: path.resolve(args.out), bytes: png.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
