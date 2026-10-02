#!/usr/bin/env node
// capture-dom-lockup.mjs <url> <selector> <out.png> [--scale 4] [--hide "sel1,sel2"] [--headed] [--viewport 1440x900]
// Captures a site's OWN rendered wordmark/lockup element (exact webfonts, exact authored
// composition) as a transparent PNG. This is a first-party derivation: it renders nothing
// the site does not render itself. Use when the dominant on-screen identity is live HTML
// text rather than an image asset (Skyvibe lesson, 2026-08-21).
import { chromium } from "playwright";

const pos = process.argv.slice(2).filter((a, i, arr) => !a.startsWith("--") && !(arr[i - 1] || "").match(/^--(scale|hide|viewport)$/));
const [url, selector, out] = pos;
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const scale = Number(argOf("scale", "4"));
const hide = argOf("hide", "");
const headed = process.argv.includes("--headed");
const [vw, vh] = argOf("viewport", "1440x900").split("x").map(Number);
if (!url || !selector || !out) {
  console.error('usage: capture-dom-lockup.mjs <url> <selector> <out.png> [--scale 4] [--hide "sel,sel"] [--headed] [--viewport WxH]');
  process.exit(1);
}

const browser = await chromium.launch(
  headed
    ? { headless: false, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"] }
    : { headless: true }
);
try {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => page.goto(url, { waitUntil: "load", timeout: 45000 }));
  await page.waitForTimeout(2500);
  await page.evaluate(async () => { try { await document.fonts.ready; } catch {} });

  // Screenshot the element IN PLACE (cloning breaks descendant CSS selectors):
  // hide everything outside the element's ancestor path, strip backgrounds on the
  // path and inside the element, then omitBackground element screenshot.
  await page.evaluate(({ selector, hide }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error("selector not found: " + selector);
    el.id = el.id || "__lockup_target__";
    el.setAttribute("data-lockup-target", "1");
    const onPath = new Set();
    for (let n = el; n; n = n.parentElement) onPath.add(n);
    for (const n of document.querySelectorAll("body *")) {
      if (onPath.has(n) || el.contains(n)) continue;
      const anc = [...onPath].some((p) => p.contains(n));
      if (!anc) continue; // will be hidden via its own hidden ancestor anyway; but hide all non-path anyway:
    }
    for (const n of document.querySelectorAll("body *")) {
      if (!onPath.has(n) && !el.contains(n)) n.style.visibility = "hidden";
    }
    for (const n of onPath) {
      if (n === document.documentElement) continue;
      n.style.background = "transparent";
      n.style.backgroundImage = "none";
      n.style.boxShadow = "none";
      n.style.visibility = "visible";
    }
    const keepEffects = hide.includes("__keep_effects__");
    for (const n of [el, ...el.querySelectorAll("*")]) {
      n.style.background = "transparent";
      n.style.backgroundImage = "none";
      n.style.boxShadow = "none";
      if (!keepEffects) {
        n.style.textShadow = "none";
        n.style.filter = "none";
        n.style.animation = "none";
      }
    }
    if (hide) for (const h of hide.split(",")) el.querySelectorAll(h.trim()).forEach((n) => (n.style.display = "none"));
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, { selector, hide });
  await page.waitForTimeout(500);
  const handle = await page.$('[data-lockup-target="1"]');
  await handle.screenshot({ path: out, omitBackground: true });
  const box = await handle.boundingBox();
  console.log("captured", out, `css ${Math.round(box.width)}x${Math.round(box.height)} @${scale}x = ~${Math.round(box.width * scale)}px wide`);
} finally {
  await browser.close();
}
