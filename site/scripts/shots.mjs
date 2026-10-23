#!/usr/bin/env node
// Viewport screenshots of this site for a visual check, light and dark.
//   NEW_BASE=http://127.0.0.1:3412 node scripts/shots.mjs / /l/il-capo   -> parity/shots/<name>-<width>-<scheme>.png
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.NEW_BASE ?? "http://127.0.0.1:3412";
const OUT = path.resolve(import.meta.dirname, "..", "parity", "shots");
const WIDTHS = (process.env.WIDTHS ?? "1440,400").split(",").map(Number);
const SCHEMES = (process.env.SCHEMES ?? "light,dark").split(",");
const FULL = process.env.FULL === "1";
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
for (const route of process.argv.slice(2)) {
  for (const w of WIDTHS) for (const scheme of SCHEMES) {
    const p = await b.newPage({ viewport: { width: w, height: w < 600 ? 860 : 1000 }, colorScheme: scheme });
    await p.goto(BASE + route, { waitUntil: "networkidle", timeout: 120000 });
    await p.waitForTimeout(500);
    const name = route === "/" ? "list" : route.replace(/^\/l\//, "").replace(/[^\w-]/g, "_");
    const file = path.join(OUT, `${name}-${w}-${scheme}.png`);
    await p.screenshot({ path: file, fullPage: FULL });
    const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(file, o > 0 ? `OVERFLOW ${o}px` : "no overflow");
    await p.close();
  }
}
await b.close();
