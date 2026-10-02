#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const MIME_BY_EXTENSION = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function parseArgs(argv) {
  const args = {
    urlBase: 'http://localhost:3000',
    issueId: '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    i += 1;
    args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return args;
}

// Serve the logo over a throwaway local HTTP server: a data: URL in the query
// string exceeds Next's request-line limit (HTTP 431) for real-world logos.
async function serveLogoFile(logoPath) {
  const absolute = path.resolve(logoPath);
  const buffer = await fs.readFile(absolute);
  const ext = path.extname(absolute).toLowerCase();
  const mime = MIME_BY_EXTENSION[ext] || 'image/png';
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': mime, 'access-control-allow-origin': '*' });
    res.end(buffer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/logo${ext || '.png'}`, close: () => server.close() };
}

async function assertReachable(urlBase) {
  let response;
  try {
    response = await fetch(urlBase, { method: 'GET' });
  } catch (err) {
    throw new Error(`Dev server is not reachable at ${urlBase}. Start the Boostly dev server and install harness/dev-page/page.tsx first. ${err.message}`);
  }
  if (!response.ok && response.status >= 500) {
    throw new Error(`Dev server at ${urlBase} returned HTTP ${response.status}. Start a healthy Boostly dev server before running screenshots.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) throw new Error('Missing required --out <path>');
  await assertReachable(args.urlBase);
  const outPath = path.resolve(args.out);

  const query = new URLSearchParams();
  let logoServer = null;
  if (args.logo) {
    logoServer = await serveLogoFile(args.logo);
    query.set('logo', logoServer.url);
  }
  if (args.primary) query.set('primary', args.primary);
  if (args.secondary) query.set('secondary', args.secondary);
  if (args.text) query.set('text', args.text);
  if (args.textSecondary) query.set('textSecondary', args.textSecondary);
  if (args.issueId) query.set('issueId', args.issueId);

  const url = new URL(args.path || '/public/badge-preview-harness', args.urlBase);
  url.search = query.toString();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#badge-shot[data-ready="true"]', { timeout: 15000 });
    await page.evaluate(async () => {
      const image = document.querySelector('#badge-shot img');
      if (image instanceof HTMLImageElement) {
        if (!image.complete || image.naturalWidth === 0) {
          await new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', reject, { once: true });
          });
        }
        await image.decode();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const element = page.locator('#badge-shot');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await element.screenshot({ path: outPath, omitBackground: false });
    console.log(JSON.stringify({ ok: true, url: url.toString(), out: pathToFileURL(outPath).href }, null, 2));
  } finally {
    await browser.close();
    logoServer?.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
