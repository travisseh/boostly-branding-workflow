#!/usr/bin/env node
// capture-website-visual.mjs <url> <out-dir> [--headed]
// Captures desktop.png, mobile.png, home.html, assets.json, computed-styles.json
// in the shape build-branding-evidence.ts expects (6-digit hex colors, both viewports).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [url, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const headed = process.argv.includes("--headed");
if (!url || !outDir) {
  console.error("usage: capture-website-visual.mjs <url> <out-dir> [--headed]");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

function toHex(rgb) {
  const m = rgb && rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // transparent
  return (
    "#" +
    [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")
  );
}

const SURFACE_PROBES = [
  { role: "header", selectors: ["header", "[role=banner]", ".header", "#header", "nav"] },
  { role: "page_background", selectors: ["body"] },
  {
    role: "primary_cta",
    selectors: [
      "a.btn", "button.btn", "a[class*=button]", "button[class*=button]",
      "a[class*=cta]", ".elementor-button", "a[href*=order]", "a[href*=reserv]", "a[href*=menu]",
    ],
  },
  { role: "footer", selectors: ["footer", "[role=contentinfo]", ".footer", "#footer"] },
];

async function probeSurfaces(page, viewport) {
  return page.evaluate(
    ({ probes, viewport }) => {
      function effective(el, prop) {
        let node = el;
        while (node && node !== document.documentElement.parentNode) {
          const v = getComputedStyle(node)[prop];
          if (v && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(v) && v !== "transparent") return v;
          if (prop !== "backgroundColor") return v;
          node = node.parentElement;
        }
        return null;
      }
      const out = [];
      for (const probe of probes) {
        let el = null,
          sel = null;
        for (const s of probe.selectors) {
          const cand = Array.from(document.querySelectorAll(s)).find((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (cand) {
            el = cand;
            sel = s;
            break;
          }
        }
        if (!el) continue;
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        out.push({
          role: probe.role,
          selector: sel,
          viewport,
          visible: rect.width > 0 && rect.height > 0 && cs.visibility !== "hidden",
          background_color_raw: effective(el, "backgroundColor"),
          text_color_raw: cs.color,
          border_color_raw: cs.borderTopColor,
        });
      }
      return out;
    },
    { probes: SURFACE_PROBES, viewport }
  );
}

async function collectAssets(page) {
  return page.evaluate(() => {
    const abs = (u) => {
      try { return new URL(u, location.href).href; } catch { return null; }
    };
    const imgs = Array.from(document.images).map((i) => ({
      src: abs(i.currentSrc || i.src),
      alt: i.alt || null,
      w: i.naturalWidth,
      h: i.naturalHeight,
      inHeader: !!i.closest("header,nav,[role=banner],.header,#header"),
    })).filter((i) => i.src);
    const meta = {};
    for (const [k, sel, attr] of [
      ["og_image", 'meta[property="og:image"]', "content"],
      ["icon", 'link[rel~="icon"]', "href"],
      ["apple_icon", 'link[rel="apple-touch-icon"]', "href"],
    ]) {
      const el = document.querySelector(sel);
      if (el) meta[k] = abs(el.getAttribute(attr));
    }
    const bgLogos = Array.from(document.querySelectorAll("header *, nav *"))
      .map((e) => getComputedStyle(e).backgroundImage)
      .filter((b) => b && b !== "none" && b.includes("url("))
      .map((b) => abs(b.replace(/^url\(["']?/, "").replace(/["']?\)$/, "")))
      .filter(Boolean);
    return { images: imgs, meta, header_background_images: [...new Set(bgLogos)] };
  });
}


// Travisse 2026-10-22: many restaurant sites open a promo / newsletter / cookie modal on load, and the
// full-page screenshot then shows the modal instead of the site. Dismiss it before capturing:
// Escape, then visible close controls, then hide any remaining fixed overlay that covers the
// viewport and restore body scroll. Records what it did in popups.json next to the screenshots.
const CLOSE_SELECTORS = [
  '[aria-label*="close" i]', '[aria-label*="dismiss" i]', '[title*="close" i]',
  'button[class*="close" i]', 'a[class*="close" i]', '[class*="modal" i] [class*="close" i]',
  '[class*="popup" i] [class*="close" i]', '[class*="lightbox" i] [class*="close" i]',
  '[id*="close" i]', '.mfp-close', '.pum-close', '.sgpb-popup-close', '.elementor-popup-modal .dialog-close-button',
  '.wixui-popup-close', '[data-dismiss="modal"]', '[data-close]', '.fancybox-close-small',
];
const DECLINE_TEXT = /^(x|×|✕|close|no thanks|no, thanks|not now|maybe later|dismiss|skip|continue to site|got it|ok|okay|accept|accept all|i agree|agree|allow all)$/i;
async function dismissPopups(page) {
  const log = { escape: false, clicked: [], hidden: [], scroll_unlocked: false };
  const overlayCount = () => page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    return Array.from(document.querySelectorAll("body *")).filter((e) => {
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      const r = e.getBoundingClientRect();
      return r.width * r.height >= 0.3 * vw * vh && r.top < vh * 0.5 && r.bottom > vh * 0.5;
    }).length;
  });
  const before = await overlayCount().catch(() => 0);
  if (!before) return { ...log, overlays_before: 0, overlays_after: 0 };
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
  log.escape = true;
  if (await overlayCount().catch(() => 0)) {
    for (const sel of CLOSE_SELECTORS) {
      const loc = page.locator(sel).filter({ visible: true });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 3); i++) {
        try { await loc.nth(i).click({ timeout: 1200, force: false }); log.clicked.push(sel); await page.waitForTimeout(350); } catch {}
      }
      if (!(await overlayCount().catch(() => 0))) break;
    }
  }
  if (await overlayCount().catch(() => 0)) {
    const btns = page.locator("button, a, [role=button]").filter({ visible: true });
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 60); i++) {
      const t = ((await btns.nth(i).innerText().catch(() => "")) || "").trim();
      if (!DECLINE_TEXT.test(t)) continue;
      try { await btns.nth(i).click({ timeout: 1200 }); log.clicked.push(`text:${t}`); await page.waitForTimeout(350); } catch {}
      if (!(await overlayCount().catch(() => 0))) break;
    }
  }
  // Last resort: hide fixed overlays that still cover the viewport, and unlock body scroll.
  const hidden = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight; const out = [];
    for (const e of Array.from(document.querySelectorAll("body *"))) {
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed" || cs.display === "none") continue;
      const r = e.getBoundingClientRect();
      if (r.width * r.height >= 0.3 * vw * vh && r.top < vh * 0.5 && r.bottom > vh * 0.5 && !e.matches("header, nav, [role=banner]")) {
        e.style.setProperty("display", "none", "important");
        out.push((e.tagName + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "")).slice(0, 80));
      }
    }
    let unlocked = false;
    for (const el of [document.documentElement, document.body]) {
      if (/hidden/.test(getComputedStyle(el).overflow)) { el.style.setProperty("overflow", "visible", "important"); unlocked = true; }
    }
    return { out, unlocked };
  }).catch(() => ({ out: [], unlocked: false }));
  log.hidden = hidden.out; log.scroll_unlocked = hidden.unlocked;
  return { ...log, overlays_before: before, overlays_after: await overlayCount().catch(() => null) };
}

const launchOpts = headed
  ? { headless: false, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"] }
  : { headless: true };
const browser = await chromium.launch(launchOpts);
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(async (e) => {
    console.error("networkidle timeout, falling back to load:", e.message);
    await page.goto(url, { waitUntil: "load", timeout: 45000 });
  });
  await page.waitForTimeout(2500);
  const title = await page.title();
  if (/just a moment|attention required|access denied/i.test(title) && !headed) {
    console.error("BLOCKED: page title suggests bot challenge:", title, "— rerun with --headed");
    process.exit(2);
  }
  fs.writeFileSync(path.join(outDir, "home.html"), await page.content());
  const popups = await dismissPopups(page);
  fs.writeFileSync(path.join(outDir, "popups.json"), JSON.stringify(popups, null, 1));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "desktop.png"), fullPage: true });
  const desktopSurfaces = await probeSurfaces(page, "desktop");
  const assets = await collectAssets(page);
  fs.writeFileSync(path.join(outDir, "assets.json"), JSON.stringify(assets, null, 1));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  const mobilePopups = await dismissPopups(page);
  if (mobilePopups.overlays_before) fs.writeFileSync(path.join(outDir, "popups-mobile.json"), JSON.stringify(mobilePopups, null, 1));
  await page.screenshot({ path: path.join(outDir, "mobile.png"), fullPage: true });
  const mobileSurfaces = await probeSurfaces(page, "mobile");

  const surfaces = [...desktopSurfaces, ...mobileSurfaces].map((s) => {
    const o = { role: s.role, selector: s.selector, viewport: s.viewport, visible: s.visible };
    const bg = toHex(s.background_color_raw);
    const tc = toHex(s.text_color_raw);
    const bc = toHex(s.border_color_raw);
    if (bg) o.background_color = bg;
    if (tc) o.text_color = tc;
    if (bc) o.border_color = bc;
    return o;
  });
  fs.writeFileSync(
    path.join(outDir, "computed-styles.json"),
    JSON.stringify({ url, surfaces }, null, 1)
  );
  console.log("captured:", outDir, "title:", title, "popups:", popups.overlays_before ? `${popups.overlays_before}->${popups.overlays_after}` : "none", "surfaces:", surfaces.length, "images:", assets.images.length);
} finally {
  await browser.close();
}
