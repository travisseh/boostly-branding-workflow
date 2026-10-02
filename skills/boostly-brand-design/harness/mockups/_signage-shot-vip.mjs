// Same as _signage-shot.mjs but replaces the hardcoded bathroom "Scan for a deal" copy in the DOM
// with --bathroom text (\n allowed) before the screenshot. No repo edits.
import fs from 'node:fs/promises'; import path from 'node:path'; import { createServer } from 'node:http';
import { chromium } from 'playwright';
const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) a[argv[i].slice(2)] = argv[i + 1];
const base = a.base || 'http://localhost:3457';
const files = {}; let port = 0;
const serve = async (key, p) => { if (!p || /^https?:/.test(p)) return p; files[key] = await fs.readFile(path.resolve(p)); return `http://127.0.0.1:${port}/${key}.png`; };
const server = createServer((req, res) => { const k = req.url.replace(/^\//, '').replace(/\.png$/, ''); if (!files[k]) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }); res.end(files[k]); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port;
const logo = await serve('logo', a.logo); const logoLight = await serve('logoLight', a['logo-light']);
const url = new URL('/public/signage-preview-harness', base);
if (logo) url.searchParams.set('logo', logo); if (logoLight) url.searchParams.set('logoLight', logoLight);
if (a.primary) url.searchParams.set('primary', a.primary); if (a.accent) url.searchParams.set('accent', a.accent);
url.searchParams.set('offer', a.offer || 'Join the club!'); url.searchParams.set('scale', a.scale || '1');
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(url.toString(), { waitUntil: 'networkidle' });
await page.waitForSelector('#signage-shot[data-ready="true"]', { timeout: 30000 });
const bathroom = (a.bathroom || '').replace(/\\n/g, '\n');
if (bathroom) {
  const n = await page.evaluate((txt) => {
    let count = 0;
    for (const p of document.querySelectorAll('#signage-shot p')) {
      if (p.textContent.trim() === 'Scan for a deal') { p.textContent = txt; p.style.whiteSpace = 'pre-line'; count++; }
    }
    return count;
  }, bathroom);
  if (n !== 1) throw new Error(`bathroom copy nodes replaced: ${n}`);
}
await page.waitForTimeout(500);
await page.locator('#signage-shot').screenshot({ path: a.out });
await browser.close(); server.close();
console.log(JSON.stringify({ ok: true, url: url.toString().replace(/127\.0\.0\.1:\d+/g, 'local'), out: a.out }));
