#!/usr/bin/env node
// Parity check between the static review pages and this site (both served locally).
//   OLD_BASE=http://127.0.0.1:3411 NEW_BASE=http://127.0.0.1:3412 node scripts/parity.mjs il-capo five-star-pizza-clearwater
// Writes parity/<slug>/<width>-{old,new}.png full-page shots, parity/<slug>/cells/<L>-{old,new,diff}.png
// per sheet cell at native size, parity/<slug>/signage-*.png, and parity/report.json with: per-section text
// facts (heading, subtitle, figure count, captions, link rows), horizontal overflow per width, and the
// pixel mismatch per cell and per signage preview.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const OLD = process.env.OLD_BASE ?? "http://127.0.0.1:3411";
const NEW = process.env.NEW_BASE ?? "http://127.0.0.1:3412";
const slugs = process.argv.slice(2);
const WIDTHS = [1440, 1100, 400];
const OUT = path.resolve(import.meta.dirname, "..", "parity");
fs.mkdirSync(OUT, { recursive: true });

const go = async (page, url) => {
  for (let i = 0; ; i++) {
    try { return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 }); }
    catch (e) { if (i >= 1) throw e; }
  }
};
const settle = async (page) => {
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts?.ready;
    const imgs = [...document.images];
    for (const i of imgs) i.loading = "eager";
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 15000); }))));
  });
  await page.waitForTimeout(400);
};

/** Section facts, read the same way from both pages. */
const facts = (page) => page.evaluate(() => {
  // Content facts only: the arrow glyphs, wrapper elements and the old "Top" nav item are presentation.
  const t = (el) => (el?.textContent ?? "").replace(/\u2197/g, "").replace(/\s+/g, " ").trim();
  const out = {};
  for (const sec of document.querySelectorAll("section[id]")) {
    if (sec.closest("#site-status")) continue;
    const own = (sel) => [...sec.querySelectorAll(sel)].filter((el) => !el.closest("figure, table, .tpl, .hdr, .compare-bar, .show-all"));
    out[sec.id] = {
      h2: t(sec.querySelector("h2")),
      sub: t(sec.querySelector("p.sub")),
      paragraphs: own("p:not(.sub):not(.cap):not(.links)").map(t).filter(Boolean),
      chips: [...sec.querySelectorAll("p.links a")].map(t),
      figures: sec.querySelectorAll("figure").length,
      captions: [...sec.querySelectorAll("figcaption")].map(t),
      gray: [...sec.querySelectorAll(".gray")].map(t),
      caps: [...sec.querySelectorAll("p.cap")].map(t),
      images: [...sec.querySelectorAll("img")].filter((i) => !i.closest(".bs-sheet, .signage-wrap, .tpl")).length,
      linkRows: [...sec.querySelectorAll("table.links tbody tr")].map((r) => [...r.querySelectorAll("td")].slice(0, 3).map(t).join(" | ")),
      cells: [...sec.querySelectorAll(".bs-cell[data-letter]")].map((c) => c.dataset.letter),
    };
  }
  // Each sheet cell's markup with asset hosts/paths normalized (old assets/<slug>/, new site/assets/<slug>/):
  // equal strings mean the templates drew the same cell from the same data.
  out.__cellMarkup = Object.fromEntries([...document.querySelectorAll(".bs-cell[data-letter]")].map((c) => [c.dataset.letter,
    c.outerHTML.replace(/https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/(?:site\/)?assets\/[^/]+\//g, "ASSET/").replace(/\s(?:class="[^"]*?)\bselected\b/g, (m) => m.replace(/\bselected\b/, ""))]));
  out.__toc = [...document.querySelectorAll("nav.toc a, nav#toc a")].map(t).filter((x) => x !== "Top" && x !== "← All locations" && x !== "All locations");
  return out;
});

const overflow = (page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

function diffPng(a, b, file) {
  const A = PNG.sync.read(fs.readFileSync(a));
  const B = PNG.sync.read(fs.readFileSync(b));
  if (A.width !== B.width || A.height !== B.height) return { size: [`${A.width}x${A.height}`, `${B.width}x${B.height}`], mismatch: null };
  const D = new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, D.data, A.width, A.height, { threshold: 0.1 });
  fs.writeFileSync(file, PNG.sync.write(D));
  // best mismatch with the new shot moved up to 2 px either way (zoomed sheets land on different sub-pixels)
  let aligned = { ratio: 1, dx: 0, dy: 0 };
  const w = A.width - 4, h = A.height - 4;
  const crop = (P, ox, oy) => { const out = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) P.data.copy(out, y * w * 4, ((y + oy) * P.width + ox) * 4, ((y + oy) * P.width + ox + w) * 4); return out; };
  const a0 = crop(A, 2, 2);
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    const m = pixelmatch(a0, crop(B, 2 + dx, 2 + dy), null, w, h, { threshold: 0.1 }) / (w * h);
    if (m < aligned.ratio) aligned = { ratio: +m.toFixed(5), dx, dy };
  }
  return { size: `${A.width}x${A.height}`, mismatch: n, ratio: +(n / (A.width * A.height)).toFixed(5), aligned };
}

const browser = await chromium.launch();
const report = { generated_at: new Date().toISOString(), old: OLD, new: NEW, list: {}, slugs: {} };
try {
  // list page
  for (const w of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    await go(page, `${NEW}/`); await settle(page);
    await page.screenshot({ path: path.join(OUT, `list-${w}-new.png`), fullPage: true });
    report.list[w] = { new: await overflow(page) };
    await go(page, `${OLD}/`); await settle(page);
    await page.screenshot({ path: path.join(OUT, `list-${w}-old.png`), fullPage: true });
    report.list[w].old = await overflow(page);
    await page.close();
  }
  for (const slug of slugs) {
    const dir = path.join(OUT, slug);
    fs.mkdirSync(path.join(dir, "cells"), { recursive: true });
    const r = (report.slugs[slug] = { widths: {}, cells: {}, signage: {} });
    for (const w of WIDTHS) {
      for (const [side, base] of [["old", OLD], ["new", NEW]]) {
        const page = await browser.newPage({ viewport: { width: w, height: 900 } });
        await go(page, `${base}/${side === "old" ? `${slug}/` : `l/${slug}`}`); await settle(page);
        await page.screenshot({ path: path.join(dir, `${w}-${side}.png`), fullPage: true });
        (r.widths[w] ??= {})[side] = await overflow(page);
        if (w === 1440) {
          r[side] = await facts(page);
          // native size, then one shot per cell
          const wrap = page.locator(".sheet-wrap").first();
          if (await wrap.count()) {
            await wrap.click({ position: { x: 3, y: 3 } });
            await page.waitForTimeout(300);
            // re-request any sheet image that failed (a transient CDN error must not read as a rendering diff)
            for (let k = 0; k < 3; k++) {
              const broken = await page.evaluate(async () => {
                const imgs = [...document.querySelectorAll(".bs-sheet img")];
                await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 15000); }))));
                const bad = imgs.filter((i) => i.complete && i.naturalWidth === 0);
                for (const i of bad) { const u = i.src; i.src = ""; i.src = u + (u.startsWith("data:") ? "" : (u.includes("?") ? "&" : "?") + "retry=" + Date.now()); }
                return bad.length;
              });
              r.broken_images = (r.broken_images ?? 0) + broken;
              if (!broken) break;
              await page.waitForTimeout(1500);
            }
            for (const cell of await page.locator(".bs-cell[data-letter]").all()) {
              const L = await cell.getAttribute("data-letter");
              await cell.scrollIntoViewIfNeeded();
              await cell.screenshot({ path: path.join(dir, "cells", `${L}-${side}.png`) });
            }
          }
          let k = 0;
          for (const sg of await page.locator(".signage-wrap").all()) {
            await sg.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
            await sg.screenshot({ path: path.join(dir, `signage-${k++}-${side}.png`) });
          }
        }
        await page.close();
      }
    }
    if (r.old?.__cellMarkup && r.new?.__cellMarkup) {
      const o = r.old.__cellMarkup, n = r.new.__cellMarkup;
      const strip = (h) => h.replace(/(class="bs-label" style="background: )#[0-9A-Fa-f]{6}/g, "$1HEADER");
      r.cell_markup = Object.fromEntries(Object.keys({ ...o, ...n }).map((L) => [L, o[L] === n[L] ? "identical" : strip(o[L] ?? "") === strip(n[L] ?? "") ? "identical except header colour" : "differs"]));
      fs.writeFileSync(path.join(dir, "cell-markup.json"), JSON.stringify({ old: o, new: n }, null, 1)); delete r.old.__cellMarkup; delete r.new.__cellMarkup;
    }
    for (const f of fs.readdirSync(path.join(dir, "cells")).filter((f) => f.endsWith("-old.png"))) {
      const L = f.replace("-old.png", "");
      const b = path.join(dir, "cells", `${L}-new.png`);
      r.cells[L] = fs.existsSync(b) ? diffPng(path.join(dir, "cells", f), b, path.join(dir, "cells", `${L}-diff.png`)) : { missing_new: true };
    }
    for (const f of fs.readdirSync(dir).filter((f) => /^signage-\d+-old\.png$/.test(f))) {
      const b = path.join(dir, f.replace("-old", "-new"));
      r.signage[f] = fs.existsSync(b) ? diffPng(path.join(dir, f), b, path.join(dir, f.replace("-old", "-diff"))) : { missing_new: true };
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`wrote ${path.join(OUT, "report.json")}`);
