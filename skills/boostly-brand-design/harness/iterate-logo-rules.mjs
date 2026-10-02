#!/usr/bin/env node
// Spike iteration: (a) edge-connected flood-fill background removal that preserves
// interior whites, (b) edge-band legibility metric — only the silhouette boundary
// of the mark needs contrast against the card primary, not its interior fill.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Gate thresholds live in ../references/gates.json (the gate registry), never here.
// Every gate function defaults its options to that entry, so the CLI and the
// typed callers run the shipped values; an explicit option still wins.
const GATES_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'references', 'gates.json');
let gateRegistryCache = null;
export function gateRegistry() {
  if (!gateRegistryCache) gateRegistryCache = JSON.parse(readFileSync(GATES_JSON, 'utf8'));
  return gateRegistryCache;
}
export function gateThresholds(id) {
  const entry = gateRegistry().gates.find((gate) => gate.id === id);
  if (!entry) throw new Error(`gate "${id}" is not in ${GATES_JSON}`);
  return { ...entry.thresholds };
}
const T = gateThresholds;

function srgbToLin(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(r, g, b) {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrast(l1, l2) {
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// Remove the background by flood-filling ONLY from the canvas border: pixels
// near-background-colored AND connected to the border go transparent. Interior
// whites (flag stripes, script fills) survive. Global color keying is the bug
// this replaces.
export async function removeBackgroundFloodFill(inPath, outPath, { tolerance = 28 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  // Background reference = median of border pixel colors
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const ref = [0, 1, 2].map((c) => {
    const vals = border.map((p) => data[p * 4 + c]).sort((a, b) => a - b);
    return vals[vals.length >> 1];
  });
  const isBg = (p) =>
    Math.abs(data[p * 4] - ref[0]) <= tolerance &&
    Math.abs(data[p * 4 + 1] - ref[1]) <= tolerance &&
    Math.abs(data[p * 4 + 2] - ref[2]) <= tolerance;
  const visited = new Uint8Array(w * h);
  const queue = border.filter((p) => isBg(p));
  for (const p of queue) visited[p] = 1;
  while (queue.length) {
    const p = queue.pop();
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (!visited[np] && isBg(np)) { visited[np] = 1; queue.push(np); }
    }
  }
  for (let p = 0; p < w * h; p++) if (visited[p]) data[p * 4 + 3] = 0;
  let img = sharp(data, { raw: { width: w, height: h, channels: 4 } }).png();
  await img.toFile(outPath);
  return { removed: visited.reduce((s, v) => s + v, 0), total: w * h };
}

// Edge-band legibility: dilate outward from the opaque silhouette and look at the
// opaque pixels within `band` px of a transparent neighbor. Share of those with
// contrast < minContrast against the primary must stay under maxShare.
export async function edgeBandLegibility(logoPath, primaryHex, { band = T('edge').band, minContrast = T('edge').minContrast } = {}) {
  const { data, info } = await sharp(logoPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const opaque = (p) => data[p * 4 + 3] > 128;
  // edge set: opaque pixels with a transparent 4-neighbor, then dilate inward `band-1` times
  let current = new Set();
  for (let p = 0; p < w * h; p++) {
    if (!opaque(p)) continue;
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !opaque(ny * w + nx)) { current.add(p); break; }
    }
  }
  const bandSet = new Set(current);
  for (let i = 1; i < band; i++) {
    const next = new Set();
    for (const p of current) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (opaque(np) && !bandSet.has(np)) { bandSet.add(np); next.add(np); }
      }
    }
    current = next;
  }
  const [pr, pg, pb] = hexToRgb(primaryHex);
  const lp = luminance(pr, pg, pb);
  let low = 0;
  for (const p of bandSet) {
    const l = luminance(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    if (contrast(l, lp) < minContrast) low++;
  }
  return { edgePixels: bandSet.size, lowContrastShare: bandSet.size ? low / bandSet.size : 1 };
}

// Flood-fill background removal + restore interior background-colored pixels that
// sit BETWEEN large saturated blocks on the same row (an Italian flag's white
// stripe). Restoring the whole saturated bbox is the bug this replaces — it also
// filled the gaps between script strokes below the blocks with opaque white.
export async function removeBackgroundRestoreBlocks(inPath, outPath, { tolerance = 28, minBlockShare = 0.01, satThreshold = 70 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const ref = [0, 1, 2].map((c) => {
    const vals = border.map((p) => data[p * 4 + c]).sort((a, b) => a - b);
    return vals[vals.length >> 1];
  });
  const isBg = (p) => [0, 1, 2].every((c) => Math.abs(data[p * 4 + c] - ref[c]) <= tolerance);
  const removed = new Uint8Array(w * h);
  const stack = border.filter(isBg);
  for (const p of stack) removed[p] = 1;
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (!removed[np] && isBg(np)) { removed[np] = 1; stack.push(np); }
    }
  }
  // label saturated components, keep the large ones (solid brand blocks)
  const sat = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > satThreshold) sat[p] = 1;
  }
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  for (let p = 0; p < w * h; p++) {
    if (!sat[p] || label[p] >= 0) continue;
    const st = [p];
    label[p] = sizes.length;
    let sz = 0;
    while (st.length) {
      const c = st.pop();
      sz++;
      const x = c % w, y = (c / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (sat[np] && label[np] < 0) { label[np] = sizes.length; st.push(np); }
      }
    }
    sizes.push(sz);
  }
  const big = new Set(sizes.map((s, i) => [s, i]).filter(([s]) => s >= minBlockShare * w * h).map(([, i]) => i));
  let restored = 0;
  for (let y = 0; y < h; y++) {
    let minx = -1, maxx = -1;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (label[p] >= 0 && big.has(label[p])) { if (minx < 0) minx = x; maxx = x; }
    }
    if (minx < 0 || maxx <= minx) continue;
    for (let x = minx; x <= maxx; x++) {
      const p = y * w + x;
      if (removed[p]) { removed[p] = 0; restored++; }
    }
  }
  for (let p = 0; p < w * h; p++) if (removed[p]) data[p * 4 + 3] = 0;
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).trim().png().toFile(outPath);
  return { blocks: big.size, restored };
}

// Vanishing-element fix: a color cluster that (a) has < minContrast against the
// card primary AND (b) faces the transparent background on most of its boundary
// disappears entirely on the card (Mil's orange bread on the orange primary).
// Recolor it to the ink color, the way the human designers' mono renditions do.
export async function fixVanishingElements(inPath, outPath, primaryHex, inkHex, { minContrast = 1.5, minClusterShare = 0.05, bgBoundaryShare = 0.6 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const [pr, pg, pb] = hexToRgb(primaryHex);
  const lp = luminance(pr, pg, pb);
  const ink = hexToRgb(inkHex);
  const opaque = (p) => data[p * 4 + 3] > 128;
  const bins = new Map();
  for (let p = 0; p < w * h; p++) {
    if (!opaque(p)) continue;
    const key = ((data[p * 4] >> 5) << 10) | ((data[p * 4 + 1] >> 5) << 5) | (data[p * 4 + 2] >> 5);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(p);
  }
  const totalOpaque = [...bins.values()].reduce((s, a) => s + a.length, 0);
  const fixed = [];
  for (const pixels of bins.values()) {
    if (pixels.length < minClusterShare * totalOpaque) continue;
    let mr = 0, mg = 0, mb = 0;
    for (const p of pixels) { mr += data[p * 4]; mg += data[p * 4 + 1]; mb += data[p * 4 + 2]; }
    mr /= pixels.length; mg /= pixels.length; mb /= pixels.length;
    if (contrast(luminance(mr, mg, mb), lp) >= minContrast) continue;
    let bTrans = 0, bOpaque = 0;
    const set = new Set(pixels);
    for (const p of pixels) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { bTrans++; continue; }
        const np = ny * w + nx;
        if (set.has(np)) continue;
        if (opaque(np)) bOpaque++; else bTrans++;
      }
    }
    if (bTrans / (bTrans + bOpaque) <= bgBoundaryShare) continue; // outline survives via opaque neighbors
    for (const p of pixels) { data[p * 4] = ink[0]; data[p * 4 + 1] = ink[1]; data[p * 4 + 2] = ink[2]; }
    fixed.push(pixels.length);
  }
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPath);
  return { clustersRecolored: fixed.length, pixelsRecolored: fixed.reduce((s, n) => s + n, 0) };
}

// Vibrant-pole palette extraction. Cluster MEANS are the vibrancy bug: averaging
// a color region blends in antialiased edges, shading, and gradient midpoints,
// always dragging chroma down (muddy #284e9d instead of the logo's actual #0057B8
// blue). Human designers snap to the purest instance of the brand color. Per hue
// bucket, the pole = median color of the top-decile saturation*value pixels.
export async function paletteVibrant(imgPath, { bucketDeg = 15, minShare = 0.03, minSat = 0.25, minVal = 0.2 } = {}) {
  const { data } = await sharp(imgPath)
    .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb2hsv = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hue = 0;
    if (d) {
      if (mx === r) hue = ((g - b) / d) % 6;
      else if (mx === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return [hue, mx ? d / mx : 0, mx / 255];
  };
  const buckets = new Map();
  let neutrals = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    total++;
    const [hue, s, v] = rgb2hsv(data[i], data[i + 1], data[i + 2]);
    if (s < minSat || v < minVal) { neutrals++; continue; }
    const key = Math.floor(hue / bucketDeg);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([s * v, data[i], data[i + 1], data[i + 2], s]);
  }
  const hex = (r, g, b) => `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
  const out = [];
  for (const [key, arr] of buckets) {
    if (arr.length < minShare * total) continue;
    arr.sort((a, b) => b[0] - a[0]);
    const top = arr.slice(0, Math.max(1, Math.floor(arr.length * 0.1)));
    const med = (c) => { const vals = top.map((p) => p[c]).sort((a, b) => a - b); return vals[vals.length >> 1]; };
    out.push({
      hueBucket: `${key * bucketDeg}-${(key + 1) * bucketDeg}`,
      share: Number((arr.length / total).toFixed(3)),
      vibrantPole: hex(med(1), med(2), med(3)),
      saturation: Number((top.map((p) => p[4]).reduce((s2, x) => s2 + x, 0) / top.length).toFixed(3)),
    });
  }
  out.sort((a, b) => b.share - a.share);
  return { clusters: out, neutralShare: Number((neutrals / total).toFixed(3)) };
}

// Render-scale stroke analysis. A mark whose strokes render at ~1-2px on the card
// reads as faint noise no matter how good its contrast is (hairline line-art
// emblems). Resize the mark to its on-card width, then measure median stroke
// thickness of the ink via erosion rounds: each 3x3 erosion strips ~1px from each
// side, so a pixel surviving k rounds sits in a stroke >= (2k+1)px thick.
// Also reports ink coverage and component count for the "overly detailed" case.
export async function strokeAnalysis(logoPath, { renderWidth = T('stroke').renderWidth, minStrokePx = T('stroke').minStrokePx } = {}) {
  const { data, info } = await sharp(logoPath)
    .resize({ width: renderWidth, fit: 'inside', withoutEnlargement: false })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let mask = new Uint8Array(w * h);
  let ink = 0;
  for (let p = 0; p < w * h; p++) if (data[p * 4 + 3] > 128) { mask[p] = 1; ink++; }
  const survival = new Uint16Array(w * h);
  let current = mask;
  let alive = ink;
  let round = 0;
  while (alive > 0 && round < 30) {
    round++;
    const next = new Uint8Array(w * h);
    alive = 0;
    for (let p = 0; p < w * h; p++) {
      if (!current[p]) continue;
      const x = p % w, y = (p / w) | 0;
      let keep = x > 0 && x < w - 1 && y > 0 && y < h - 1;
      if (keep) {
        for (let dy = -1; dy <= 1 && keep; dy++)
          for (let dx = -1; dx <= 1 && keep; dx++)
            if (!current[(y + dy) * w + (x + dx)]) keep = false;
      }
      if (keep) { next[p] = 1; survival[p] = round; alive++; }
    }
    current = next;
  }
  const rounds = [];
  for (let p = 0; p < w * h; p++) if (mask[p]) rounds.push(survival[p]);
  rounds.sort((a, b) => a - b);
  const medianRounds = rounds.length ? rounds[rounds.length >> 1] : 0;
  // component count on the original mask (4-conn)
  const label = new Int32Array(w * h).fill(-1);
  let ncomp = 0;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || label[p] >= 0) continue;
    const st = [p];
    label[p] = ncomp;
    while (st.length) {
      const c = st.pop();
      const x = c % w, y = (c / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (mask[np] && label[np] < 0) { label[np] = ncomp; st.push(np); }
      }
    }
    ncomp++;
  }
  return {
    renderWidth: w,
    medianStrokePx: 2 * medianRounds + 1,
    inkCoverage: Number((ink / (w * h)).toFixed(3)),
    components: ncomp,
    verdict: (2 * medianRounds + 1) < minStrokePx ? 'too-faint: extract wordmark or use bolder variant' : 'ok',
  };
}

// Real-ESRGAN upscale via Replicate — for when the current brand mark only
// exists at low resolution and no vector source is available. Raster upscaling
// by sharp/resize produces soft, unacceptable wordmarks; ESRGAN keeps edges
// crisp. Token comes from REPLICATE_API_TOKEN or the brand-extractor .env.
async function replicateToken() {
  if (process.env.REPLICATE_API_TOKEN) return process.env.REPLICATE_API_TOKEN;
  const envPath = `${process.env.HOME}/.config/boostly-branding/.env`;
  try {
    const txt = await fs.readFile(envPath, 'utf8');
    const m = txt.match(/^REPLICATE_API_TOKEN=(\S+)/m);
    if (m) return m[1];
  } catch {}
  throw new Error('REPLICATE_API_TOKEN not found (env or brand-extractor .env)');
}

export async function upscaleESRGAN(inPath, outPath, { scale = 4 } = {}) {
  const token = await replicateToken();
  const b64 = (await fs.readFile(inPath)).toString('base64');
  const create = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: '42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
      input: { image: `data:image/png;base64,${b64}`, scale, face_enhance: false },
    }),
  });
  if (!create.ok) throw new Error(`replicate create ${create.status}: ${await create.text()}`);
  const { id } = await create.json();
  let output = null;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Token ${token}` },
    });
    const data = await res.json();
    if (data.status === 'succeeded') { output = data.output; break; }
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(`replicate ${data.status}: ${data.error || 'unknown'}`);
    }
  }
  if (!output) throw new Error('replicate prediction timed out');
  const img = await fetch(output);
  await fs.writeFile(outPath, Buffer.from(await img.arrayBuffer()));
  const meta = await sharp(outPath).metadata();
  return { width: meta.width, height: meta.height, scale };
}

// Full-silhouette knockout: recolor EVERY opaque pixel to the target ink,
// preserving alpha (so counters/holes stay holes). This is the sanctioned way
// to knock a lockup out — piecemeal per-cluster recolors leave outline-only
// letters (MCHC red-fill-on-red shipped as outlines) or mixed-color lockups
// (Pizzati slices stayed colored when gold went full white).
export async function knockoutSilhouette(inPath, outPath, hex = '#ffffff') {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = hexToRgb(hex);
  let recolored = 0;
  for (let p = 0; p < info.width * info.height; p++) {
    if (data[p * 4 + 3] === 0) continue;
    data[p * 4] = r; data[p * 4 + 1] = g; data[p * 4 + 2] = b;
    recolored++;
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(outPath);
  return { recolored, hex };
}

// Detect baked-in soft effects (outer glow / drop shadow) in a transparent
// mark. Effects exported into the PNG live as a wide band of LOW-alpha pixels;
// clean antialiasing is only a 1-2px rim, so its share of nonzero-alpha pixels
// stays small. softShare > 0.30 = the file carries an effect layer that a
// silhouette knockout would recolor into a halo (Paolo's 2026-07-09 failure:
// white outer glow + black drop shadow became a white emboss around the mark).
export async function softFringeCheck(inPath, { maxSoftShare = T('soft-fringe').maxSoftShare } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let nonzero = 0, soft = 0, opaque = 0;
  for (let p = 0; p < info.width * info.height; p++) {
    const a = data[p * 4 + 3];
    if (a === 0) continue;
    nonzero++;
    if (a < 128) soft++;
    if (a >= 250) opaque++;
  }
  const softShare = nonzero ? soft / nonzero : 0;
  return {
    nonzero, softShare: +softShare.toFixed(3), opaqueShare: +(opaque / nonzero || 0).toFixed(3),
    hasBakedEffects: softShare > maxSoftShare,
    verdict: softShare > maxSoftShare ? 'FAIL: baked-in glow/shadow — run deglow before knockout' : 'ok',
  };
}

// Strip baked-in glow/shadow from a mark before knockout. Ink is kept by COLOR
// (dark pixels) x ALPHA (solid pixels); the white glow fails the luma test and
// the offset black shadow fails the alpha test. The smoothsteps keep genuine
// edge antialiasing; the 0.4px blur restores a natural rim on the cut edges.
// For DARK-ink marks only (the common knockout input). A light-ink mark on
// transparent would need the luma ramp inverted — check `vibrant`/ink color first.
export async function deglow(inPath, outPath, { lumaLo = 120, lumaHi = 210, alphaLo = 90, alphaHi = 190 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  const ss = (lo, hi, x) => { let t = (x - lo) / (hi - lo); t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const inkiness = 1 - ss(lumaLo, lumaHi, luma); // 1 = dark ink, 0 = light glow
    const alpha = 255 * ss(alphaLo, alphaHi, a * inkiness); // kills low-alpha shadow
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = Math.round(alpha);
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .blur(0.4)
    .png()
    .toFile(outPath);
  return softFringeCheck(outPath);
}

// Minimum-shipped-resolution gate (River Grille 2026-07-09 lesson: a 221px mark
// shipped native and rendered visibly low-res on the card; ESRGAN 4x of the same
// cleaned asset was clean). Run on the FINAL file you ship — if it fails, clean
// at native res first, then `upscale` until it passes. minLongest matches the
// Mozzarella compose floor (~700px into the ~680px badge logo box).
export async function shipResolutionGate(inPath, { minLongest = T('ship-gate').minLongest } = {}) {
  const meta = await sharp(inPath).metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  return {
    width: meta.width, height: meta.height, longest, minLongest,
    pass: longest >= minLongest,
    verdict: longest >= minLongest ? 'ok' : `FAIL: ${longest}px < ${minLongest}px — ESRGAN-upscale the cleaned asset before shipping`,
  };
}

// Shared native-res component labeling (4-conn on alpha>128), components sorted
// by area desc so ids are stable between `components` and `remove-components`.
async function labelNativeComponents(inPath) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const mask = new Uint8Array(w * h);
  let ink = 0;
  for (let p = 0; p < w * h; p++) if (data[p * 4 + 3] > 128) { mask[p] = 1; ink++; }
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || label[p] >= 0) continue;
    const st = [p];
    const idx = comps.length;
    label[p] = idx;
    const c = { pixels: [], minX: w, maxX: 0, minY: h, maxY: 0 };
    while (st.length) {
      const q = st.pop();
      c.pixels.push(q);
      const x = q % w, y = (q / w) | 0;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (mask[np] && label[np] < 0) { label[np] = idx; st.push(np); }
      }
    }
    comps.push(c);
  }
  const order = comps.map((c, i) => [c.pixels.length, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  return { data, w, h, ink, comps, order };
}

// Per-component erosion-based median stroke, in NATIVE px for a pixel set.
function componentMedianStroke(pixelSet, w, h) {
  let current = new Set(pixelSet);
  const survival = new Map();
  for (const p of current) survival.set(p, 0);
  let round = 0;
  while (current.size && round < 60) {
    round++;
    const next = new Set();
    for (const p of current) {
      const x = p % w, y = (p / w) | 0;
      let keep = x > 0 && x < w - 1 && y > 0 && y < h - 1;
      if (keep) {
        for (let dy = -1; dy <= 1 && keep; dy++)
          for (let dx = -1; dx <= 1 && keep; dx++)
            if (!current.has((y + dy) * w + (x + dx))) keep = false;
      }
      if (keep) { next.add(p); survival.set(p, round); }
    }
    current = next;
  }
  const rounds = [...survival.values()].sort((a, b) => a - b);
  return 2 * rounds[rounds.length >> 1] + 1;
}

// Component inventory for lockup simplification. Native-res labeling; stroke is
// reported scaled to what it would measure at renderWidth so the <3px too-faint
// threshold applies directly. Row-cropping a component out is BANNED (it chopped
// the top of Pizzati's P) — inspect this list, then remove by id with
// remove-components, which masks exactly the component's own pixels.
export async function listComponentsCmd(inPath, { renderWidth = 380, maxList = 25 } = {}) {
  const { data, w, h, ink, comps, order } = await labelNativeComponents(inPath);
  const scale = renderWidth / w;
  const out = [];
  for (let rank = 0; rank < Math.min(order.length, maxList); rank++) {
    const c = comps[order[rank]];
    if (c.pixels.length < 0.0005 * ink && rank >= 10) break; // dust
    let mr = 0, mg = 0, mb = 0, nearWhite = 0;
    for (const p of c.pixels) {
      mr += data[p * 4]; mg += data[p * 4 + 1]; mb += data[p * 4 + 2];
      if (data[p * 4] > 220 && data[p * 4 + 1] > 220 && data[p * 4 + 2] > 215) nearWhite++;
    }
    const n = c.pixels.length;
    const strokeNative = componentMedianStroke(new Set(c.pixels), w, h);
    out.push({
      id: rank,
      areaShareOfInk: Number((n / ink).toFixed(4)),
      bbox: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 },
      meanColor: `#${[mr / n, mg / n, mb / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`,
      nearWhiteShare: Number((nearWhite / n).toFixed(3)),
      medianStrokeAtRender: Number((strokeNative * scale).toFixed(1)),
      tooFaintAtRender: strokeNative * scale < 3,
    });
  }
  return { width: w, height: h, inkPixels: ink, totalComponents: comps.length, renderWidth, components: out };
}

// Mask-based component removal: deletes exactly the listed component ids (same
// deterministic ordering as `components`), touches no other pixels, then trims
// to the new content bbox. The ONLY sanctioned way to strip a lockup element.
export async function removeComponentsCmd(inPath, outPath, ids) {
  const { data, w, h, comps, order } = await labelNativeComponents(inPath);
  let removedPx = 0;
  const removedFront = [];
  for (const id of ids) {
    const c = comps[order[id]];
    if (!c) throw new Error(`component id ${id} out of range (${order.length} components)`);
    for (const p of c.pixels) { data[p * 4 + 3] = 0; removedPx++; removedFront.push(p); }
  }
  // Antialias-fringe sweep (Hooligan's lesson): the ink mask is alpha>128, so a
  // removed glyph leaves its soft edge (0<alpha<=128) behind as ghost rows that
  // stretch the content bbox and smudge the card. Clear ONLY sub-ink pixels
  // reachable from removed pixels — kept components' own antialiasing survives
  // because it hangs off ink that was not removed.
  let fringePx = 0;
  let front = removedFront;
  for (let round = 0; round < 4 && front.length; round++) {
    const next = [];
    for (const p of front) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        const a = data[np * 4 + 3];
        if (a > 0 && a <= 128) { data[np * 4 + 3] = 0; fringePx++; next.push(np); }
      }
    }
    front = next;
  }
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).trim().png().toFile(outPath);
  const meta = await sharp(outPath).metadata();
  return { removedComponents: ids.length, removedPixels: removedPx, removedFringePixels: fringePx, out: { width: meta.width, height: meta.height } };
}

// Per-component contrast gate (Hooligan's lesson, 2026-08-11): the aggregate
// interior gate reported 2.8% low-contrast while the black "SPORTS BAR & GRILL"
// descriptor sat at 1.79:1 on the navy card — invisible. Both existing nets
// straddled it: vanish-fix and interior use minContrast 1.5 (black-on-navy is
// 1.79), and interior averages over the whole mark so a subordinate band can be
// 100% illegible while the aggregate passes. This gate judges each component
// individually at a text-legibility threshold: any component holding >=
// minAreaShare of ink whose pixels are >= lowShareFail low-contrast (< 3.0)
// against the actual card primary is invisible on the card, full stop. Fix by
// stripping the component (free-standing descriptor) or knocking the full
// lockup out — never by waiving the gate.
export async function componentContrastCheck(logoPath, primaryHex, { minContrast = T('component-contrast').minContrast, minAreaShare = T('component-contrast').minAreaShare, lowShareFail = T('component-contrast').lowShareFail } = {}) {
  const { data, ink, comps, order } = await labelNativeComponents(logoPath);
  const lp = luminance(...hexToRgb(primaryHex));
  const report = [];
  const failing = [];
  for (let rank = 0; rank < order.length; rank++) {
    const c = comps[order[rank]];
    const share = c.pixels.length / ink;
    if (share < minAreaShare) continue;
    let low = 0;
    for (const p of c.pixels) {
      if (contrast(luminance(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]), lp) < minContrast) low++;
    }
    const lowShare = low / c.pixels.length;
    const entry = {
      id: rank,
      areaShareOfInk: Number(share.toFixed(4)),
      lowContrastShare: Number(lowShare.toFixed(3)),
      bbox: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 },
    };
    report.push(entry);
    if (lowShare >= lowShareFail) failing.push(rank);
  }
  return {
    primary: primaryHex,
    minContrast,
    lowShareFail,
    pass: failing.length === 0,
    failingComponents: failing,
    components: report,
    verdict: failing.length ? 'component_invisible_on_primary' : 'ok',
  };
}

// Color-family ink extraction (State Fare / Say Cheese lessons, 2026-08-11):
// deterministically lift ONE authored ink family out of a fused multi-color
// lockup — the yellow SAY CHEESE! letters with their black keylines, or the
// black STATE FARE serif text without its box. Selection is by color, not
// position: a chromatic target selects same-hue saturated pixels; a dark
// neutral target selects low-luma pixels. Optional `grow` geodesically dilates
// the selection into ADJACENT dark keyline pixels (bounded steps, so a letter's
// keyline is captured without flooding down a connected emblem outline). Kept
// pixels preserve their exact authored RGBA; everything else goes transparent.
// Follow with `components` to inspect and `remove-components` to drop
// unwanted survivors (an emblem's border-connected outline, crossing nubs).
export async function extractColorFamily(inPath, outPath, targetHex, { hueTol = 40, satMin = 0.3, valMin = 0.3, lumaMax = 90, grow = 0, lightMin = 170 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const [tr, tg, tb] = hexToRgb(targetHex);
  const tmax = Math.max(tr, tg, tb) / 255, tmin = Math.min(tr, tg, tb) / 255;
  const tSat = tmax === 0 ? 0 : (tmax - tmin) / tmax;
  const chromatic = tSat >= 0.3 && tmax >= 0.3;
  // light-neutral target (El Guapo lesson): white/cream letterforms select by
  // HIGH luma + low saturation, then grow into their dark keylines as usual.
  const lightNeutral = !chromatic && (0.2126 * tr + 0.7152 * tg + 0.0722 * tb) >= 170;
  const hueOf = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    let hu;
    if (mx === r) hu = ((g - b) / d) % 6; else if (mx === g) hu = (b - r) / d + 2; else hu = (r - g) / d + 4;
    return ((hu * 60) + 360) % 360;
  };
  const tHue = hueOf(tr, tg, tb);
  const keep = new Uint8Array(w * h);
  let selected = 0;
  for (let p = 0; p < w * h; p++) {
    if (data[p * 4 + 3] <= 128) continue;
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    let hit;
    if (chromatic) {
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      let hd = Math.abs(hueOf(r, g, b) - tHue);
      if (hd > 180) hd = 360 - hd;
      hit = sat >= satMin && mx >= valMin && hd <= hueTol;
    } else if (lightNeutral) {
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      hit = 0.2126 * r + 0.7152 * g + 0.0722 * b >= lightMin && sat <= 0.2;
    } else {
      hit = 0.2126 * r + 0.7152 * g + 0.0722 * b <= lumaMax;
    }
    if (hit) { keep[p] = 1; selected++; }
  }
  // Drop tiny seed islands before growing: stray 1px target-hue antialias
  // specks sitting on an emblem's dark outline otherwise seed growth that
  // captures whole foreign arcs (Say Cheese ring lesson).
  const minSeed = Math.max(20, Math.round(selected * 0.0005));
  {
    const label = new Int32Array(w * h).fill(-1);
    for (let p0 = 0; p0 < w * h; p0++) {
      if (!keep[p0] || label[p0] >= 0) continue;
      const st = [p0]; label[p0] = 1; const pixels = [p0];
      while (st.length) {
        const q = st.pop();
        const x = q % w, y = (q / w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const np = ny * w + nx;
          if (keep[np] && label[np] < 0) { label[np] = 1; st.push(np); pixels.push(np); }
        }
      }
      if (pixels.length < minSeed) { for (const q of pixels) keep[q] = 0; selected -= pixels.length; }
    }
  }
  // Growth is restricted to NEUTRAL dark keyline pixels (low luma AND low
  // saturation): a saturated red disc can sit under the luma ceiling (Say
  // Cheese red is luma ~72) and must not be absorbed as "keyline".
  let grown = 0;
  let f = [];
  for (let p = 0; p < w * h; p++) if (keep[p]) f.push(p);
  for (let round = 0; round < grow && f.length; round++) {
    const next = [];
    for (const p of f) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (keep[np] || data[np * 4 + 3] <= 128) continue;
        const r = data[np * 4], g = data[np * 4 + 1], b = data[np * 4 + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        if (luma <= lumaMax && sat <= 0.5) { keep[np] = 1; next.push(np); grown++; }
      }
    }
    f = next;
  }
  // carry each kept pixel's sub-ink antialias rim (alpha<=128 neighbors) so
  // edges stay soft instead of jaggy
  for (let p = 0; p < w * h; p++) if (!keep[p] && data[p * 4 + 3] > 0 && data[p * 4 + 3] <= 128) {
    const x = p % w, y = (p / w) | 0;
    let adj = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && keep[ny * w + nx]) { adj = true; break; }
    }
    if (adj) keep[p] = 2;
  }
  for (let p = 0; p < w * h; p++) if (!keep[p]) data[p * 4 + 3] = 0;
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).trim().png({ palette: false }).toFile(outPath);
  const meta = await sharp(outPath).metadata();
  return { target: targetHex, chromatic, selectedPixels: selected, grownKeylinePixels: grown, out: { width: meta.width, height: meta.height } };
}

// Interior-fill legibility: the edge gate only proves the SILHOUETTE reads; a
// letterform lockup whose fill matches the card ships as outline-only text
// (MCHC) or invisible letters (Pizzati red TI on red). Measures the share of
// opaque pixels OUTSIDE the 3px edge band with <1.5 contrast vs the primary.
// For text-dominant marks, a high share means: full knockout, not per-cluster
// recolors.
export async function interiorFillCheck(logoPath, primaryHex, { band = T('interior').band, minContrast = T('interior').minContrast, maxLowContrastShare = T('interior').maxLowContrastShare, darkPanelMaxChannel = T('interior').darkPanelMaxChannel ?? 40, darkPanelMinShare = T('interior').darkPanelMinShare ?? 0.95, darkPanelMergeMaxContrast = T('interior').darkPanelMergeMaxContrast ?? 1.5 } = {}) {
  const { data, info } = await sharp(logoPath)
    .resize({ width: 420, height: 420, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const opaque = (p) => data[p * 4 + 3] > 128;
  const inBand = new Uint8Array(w * h);
  let frontier = [];
  for (let p = 0; p < w * h; p++) {
    if (!opaque(p)) continue;
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !opaque(ny * w + nx)) { inBand[p] = 1; frontier.push(p); break; }
    }
  }
  for (let i = 1; i < band; i++) {
    const next = [];
    for (const p of frontier) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (opaque(np) && !inBand[np]) { inBand[np] = 1; next.push(np); }
      }
    }
    frontier = next;
  }
  const [pr, pg, pb] = hexToRgb(primaryHex);
  const lp = luminance(pr, pg, pb);
  let interior = 0, low = 0, lowDark = 0;
  const nearBlack = (p) => data[p * 4] <= darkPanelMaxChannel && data[p * 4 + 1] <= darkPanelMaxChannel && data[p * 4 + 2] <= darkPanelMaxChannel;
  for (let p = 0; p < w * h; p++) {
    if (!opaque(p) || inBand[p]) continue;
    interior++;
    if (contrast(luminance(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]), lp) < minContrast) {
      low++;
      if (nearBlack(p)) lowDark++;
    }
  }
  const share = interior ? low / interior : 0;
  // authored_dark_panel_on_dark_card (Cellblock Sips 2026-09-21, extend-the-rule decision): when the
  // colliding interior is the mark's own authored near-black panel and the card primary merges with
  // black (< darkPanelMergeMaxContrast against #000), the panel disappears into the brand's dark
  // card by design; the registry carries this verdict as a warn. Any other collision stays a block.
  const lowDarkShare = low ? lowDark / low : 0;
  const primaryVsBlack = contrast(lp, luminance(0, 0, 0));
  const darkPanelOnDarkCard = share > maxLowContrastShare && lowDarkShare >= darkPanelMinShare && primaryVsBlack < darkPanelMergeMaxContrast;
  return {
    interiorPixels: interior,
    interiorLowContrastShare: Number(share.toFixed(4)),
    lowContrastDarkShare: Number(lowDarkShare.toFixed(4)),
    primaryVsBlackContrast: Number(primaryVsBlack.toFixed(3)),
    verdict: share > maxLowContrastShare
      ? (darkPanelOnDarkCard ? 'authored_dark_panel_on_dark_card' : 'fill-collision: apply full knockout (knockout cmd) — do NOT ship outline-only or piecemeal recolors')
      : 'ok',
    ...(darkPanelOnDarkCard ? { note: `the low-contrast interior is ${Math.round(lowDarkShare * 100)}% authored near-black (channels <= ${darkPanelMaxChannel}) and the card primary ${primaryHex} is ${primaryVsBlack.toFixed(2)}:1 against black: the authored dark panel merges into the brand's dark card by design (warn, not block)` } : {}),
  };
}

// Stray-background-blob check: after cleaning, an opaque near-white component
// whose boundary mostly faces transparency is almost always leftover background
// or a half-keyed interior (Healthy Bistro's top-left splotch: one wedge of the
// disc interior stayed opaque white while the rest went transparent). WARNs for
// eyeballing; enclosed whites (bounded by ink) are fine and expected.
export async function whiteblobCheck(logoPath, { minShare = T('whiteblob').minShare, whiteTol = T('whiteblob').whiteTol, transThreshold = T('whiteblob').transThreshold, bigRegionShare = T('whiteblob').bigRegionShare, bigRegionTransThreshold = T('whiteblob').bigRegionTransThreshold } = {}) {
  const { data, info } = await sharp(logoPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const opaque = (p) => data[p * 4 + 3] > 128;
  const isWhite = (p) => opaque(p)
    && data[p * 4] > whiteTol && data[p * 4 + 1] > whiteTol && data[p * 4 + 2] > whiteTol - 10;
  let ink = 0;
  for (let p = 0; p < w * h; p++) if (opaque(p)) ink++;
  // label near-white opaque regions directly (they can be fused to ink in
  // alpha space — the HB splotch touches the emblem ring, so alpha-component
  // labeling never isolates it)
  const label = new Int32Array(w * h).fill(-1);
  const warns = [];
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!isWhite(p0) || label[p0] >= 0) continue;
    const st = [p0];
    label[p0] = 1;
    const pixels = [];
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (st.length) {
      const q = st.pop();
      pixels.push(q);
      const x = q % w, y = (q / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (isWhite(np) && label[np] < 0) { label[np] = 1; st.push(np); }
      }
    }
    if (pixels.length < minShare * ink) continue;
    const set = new Set(pixels);
    let bTrans = 0, bOpaque = 0;
    for (const p of pixels) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { bTrans++; continue; }
        const np = ny * w + nx;
        if (set.has(np)) continue;
        if (opaque(np)) bOpaque++; else bTrans++;
      }
    }
    const transShare = bTrans / (bTrans + bOpaque);
    const areaShare = pixels.length / ink;
    // big near-white regions are suspicious at much lower transparency shares —
    // the HB half-keyed wedge was 17% of ink with only 0.26 transparent boundary
    if (transShare > transThreshold || (areaShare > bigRegionShare && transShare > bigRegionTransThreshold)) {
      warns.push({
        areaShareOfInk: Number((pixels.length / ink).toFixed(4)),
        bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        boundaryTransparentShare: Number(transShare.toFixed(3)),
      });
    }
  }
  return {
    pass: warns.length === 0,
    warnings: warns,
    note: warns.length ? 'opaque near-white region(s) facing transparency — likely leftover background or half-keyed interior; fix before rendering' : 'clean',
  };
}

// Tiny near-white regions connected to the canvas border are a different failure
// from whiteblob's large leftover-background regions. They are easy to miss on a
// white checkerboard, but become bright ticks on a dark badge and can be amplified
// by an AI upscaler. Restrict this gate to small, thin, border-touching regions so
// authored white bands and letterforms are not classified as dust.
async function borderWhiteDustRegions(
  logoPath,
  { minShare = T('border-dust').minShare, maxShare = T('border-dust').maxShare, whiteTol = T('border-dust').whiteTol, maxThicknessShare = T('border-dust').maxThicknessShare } = {},
) {
  const { data, info } = await sharp(logoPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const opaque = (p) => data[p * 4 + 3] > 128;
  const isWhite = (p) => opaque(p)
    && data[p * 4] > whiteTol && data[p * 4 + 1] > whiteTol && data[p * 4 + 2] > whiteTol - 5;
  let ink = 0;
  for (let p = 0; p < w * h; p++) if (opaque(p)) ink++;
  const seen = new Uint8Array(w * h);
  const regions = [];
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!isWhite(p0) || seen[p0]) continue;
    const stack = [p0];
    seen[p0] = 1;
    const pixels = [];
    let minX = w, maxX = 0, minY = h, maxY = 0, touchesBorder = false;
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (isWhite(np) && !seen[np]) { seen[np] = 1; stack.push(np); }
      }
    }
    const areaShare = pixels.length / Math.max(1, ink);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const thin = Math.min(bw, bh) <= Math.max(2, Math.round(Math.min(w, h) * maxThicknessShare));
    if (touchesBorder && thin && areaShare >= minShare && areaShare <= maxShare) {
      regions.push({ pixels, areaShare, bbox: { x: minX, y: minY, w: bw, h: bh } });
    }
  }
  return { data, info, ink, regions };
}

export async function borderWhiteDustCheck(logoPath, options = {}) {
  const { info, regions } = await borderWhiteDustRegions(logoPath, options);
  return {
    width: info.width,
    height: info.height,
    pass: regions.length === 0,
    regions: regions.map((region) => ({
      areaShareOfInk: Number(region.areaShare.toFixed(5)),
      bbox: region.bbox,
    })),
    note: regions.length
      ? 'FAIL: small near-white border artifact(s); inspect on the target dark matte and run remove-border-dust before any upscale'
      : 'clean',
  };
}

export async function removeBorderWhiteDust(
  inPath,
  outPath,
  { maxRemovalShare = 0.02, ...options } = {},
) {
  const { data, info, regions } = await borderWhiteDustRegions(inPath, options);
  const { width: w, height: h } = info;
  const remove = new Uint8Array(w * h);
  for (const region of regions) {
    for (const p of region.pixels) remove[p] = 1;
  }
  // Include the low-alpha near-white antialiasing immediately around each
  // opaque seed; leaving it behind is enough for an upscaler to regrow a halo.
  const seeds = [];
  for (let p = 0; p < w * h; p++) if (remove[p]) seeds.push(p);
  for (const p of seeds) {
    const x = p % w, y = (p / w) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx, i = np * 4;
      if (data[i + 3] > 0 && data[i] > 210 && data[i + 1] > 210 && data[i + 2] > 205) remove[np] = 1;
    }
  }
  const opaquePixels = data.reduce((count, value, index) =>
    index % 4 === 3 && value > 128 ? count + 1 : count, 0);
  const plannedRemoval = remove.reduce((count, value) => count + value, 0);
  const removalShare = plannedRemoval / Math.max(1, opaquePixels);
  if (removalShare > maxRemovalShare) {
    throw new Error(
      `border-dust cleanup would remove ${(removalShare * 100).toFixed(2)}% of opaque ink; `
      + `limit is ${(maxRemovalShare * 100).toFixed(2)}%. Hold for manual_review: tooling_gap.`,
    );
  }
  let removedPixels = 0;
  for (let p = 0; p < w * h; p++) {
    if (!remove[p]) continue;
    const i = p * 4;
    data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
    removedPixels++;
  }
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).trim().png().toFile(outPath);
  return {
    removedRegions: regions.length,
    removedPixels,
    removalShareOfInk: Number(removalShare.toFixed(5)),
  };
}

// AI upscalers may hallucinate alpha/color into transparent pixels. Keep their
// RGB detail, but restore the silhouette from the cleaned pre-upscale source.
// This must run after upscale and before the final dark-matte proof.
export async function restoreAlphaFromSource(sourcePath, candidatePath, outPath) {
  const candidate = await sharp(candidatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(sourcePath)
    .ensureAlpha()
    .extractChannel(3)
    .resize(candidate.info.width, candidate.info.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  for (let p = 0; p < candidate.info.width * candidate.info.height; p++) {
    candidate.data[p * 4 + 3] = alpha[p];
  }
  await sharp(candidate.data, { raw: candidate.info }).trim().png().toFile(outPath);
  const meta = await sharp(outPath).metadata();
  return { width: meta.width, height: meta.height };
}

// Alpha-safe production resize. macOS `sips` has produced visible white fringes
// on transparent logos, so it is not allowed in the branding write path.
export async function resizeAlphaSafe(inPath, outPath, maxPx = 800) {
  await sharp(inPath)
    .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .png()
    .toFile(outPath);
  const meta = await sharp(outPath).metadata();
  return { width: meta.width, height: meta.height, maxPx };
}

// Counter-punch: convert baked-in near-white counters/negative space into REAL
// transparent holes. Many source logos bake letter counters and inter-element
// gaps as opaque white fused to the ink via antialiasing; knocking such a mark
// out produces stencil blobs (Pariwaar wordmark, Fat Cat's A/F counters).
// Any near-white opaque region whose boundary faces mostly ink (not
// transparency) is punched to alpha 0. Run BEFORE `knockout` on any mark with
// text or enclosed negative space.
export async function counterPunch(inPath, outPath, { whiteTol = 208, inkBoundaryShare = 0.55, maxShare = 0.35 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const opaque = (p) => data[p * 4 + 3] > 128;
  const isWhite = (p) => opaque(p)
    && data[p * 4] > whiteTol && data[p * 4 + 1] > whiteTol && data[p * 4 + 2] > whiteTol - 10;
  let ink = 0;
  for (let p = 0; p < w * h; p++) if (opaque(p)) ink++;
  const label = new Int32Array(w * h).fill(-1);
  let punched = 0, regions = 0;
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!isWhite(p0) || label[p0] >= 0) continue;
    const st = [p0];
    label[p0] = 1;
    const pixels = [];
    while (st.length) {
      const q = st.pop();
      pixels.push(q);
      const x = q % w, y = (q / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (isWhite(np) && label[np] < 0) { label[np] = 1; st.push(np); }
      }
    }
    if (pixels.length > maxShare * ink) continue; // huge white areas are grounds/keylines, not counters
    const set = new Set(pixels);
    let bInk = 0, bOther = 0;
    for (const p of pixels) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { bOther++; continue; }
        const np = ny * w + nx;
        if (set.has(np)) continue;
        if (opaque(np) && !isWhite(np)) bInk++; else bOther++;
      }
    }
    if (bInk / (bInk + bOther) >= inkBoundaryShare) {
      for (const p of pixels) data[p * 4 + 3] = 0;
      punched += pixels.length; regions++;
    }
  }
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPath);
  return { regionsPunched: regions, pixelsPunched: punched };
}

// Counter-integrity check: counts enclosed holes (transparent regions not
// touching the image border) in a mark's alpha. Letterform counters (D, B, A,
// O, R...) are holes; a wordmark whose holes vanished through upscale/threshold
// shipped with filled-in letters (Mozzarella D/B/A). Compare hole count across
// pipeline stages — it must not decrease.
export async function countHoles(imgPath, { minHolePx = T('holes').minHolePx } = {}) {
  const { data, info } = await sharp(imgPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const transparent = (p) => data[p * 4 + 3] <= 128;
  const label = new Int32Array(w * h).fill(-1);
  let holes = 0;
  const holeList = [];
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!transparent(p0) || label[p0] >= 0) continue;
    const st = [p0];
    label[p0] = 1;
    const pixels = [];
    let touchesBorder = false;
    while (st.length) {
      const q = st.pop();
      pixels.push(q);
      const x = q % w, y = (q / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (transparent(np) && label[np] < 0) { label[np] = 1; st.push(np); }
      }
    }
    if (!touchesBorder && pixels.length >= minHolePx) {
      holes++;
      if (holeList.length < 40) holeList.push(pixels.length);
    }
  }
  return { holes, holeSizes: holeList.sort((a, b) => b - a) };
}

// Remove dark NEUTRAL ink to transparency (B&B Social lesson, 2026-08-20:
// convert an opaque dark monogram into the sibling-authored cutout
// construction so the card ground reads through). Chromatic pixels never
// match; a feather band above lumaMax keeps antialiased edges smooth.
async function removeDarkInk(inPath, outPath, { lumaMax = 80 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let cleared = 0, feathered = 0;
  const out = Buffer.from(data);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] === 0) continue;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (sat > 0.3) continue; // chromatic ink never matches
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma <= lumaMax) { out[o + 3] = 0; cleared++; }
    else if (luma <= lumaMax * 1.5) { out[o + 3] = Math.round(data[o + 3] * ((luma - lumaMax) / (lumaMax * 0.5))); feathered++; }
  }
  await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPath);
  return { width: w, height: h, cleared, feathered, lumaMax };
}

// Remove one chromatic ink family to transparency (Fox's Pizza Den lesson,
// 2026-08-19: reviewer-directed "remove the red and put what remains on a red
// background"). Pixels whose hue matches the target within tolerance and whose
// chroma is comparable go fully transparent; near-family antialias pixels get
// proportional alpha so edges stay smooth on the matching card.
async function removeColorFamily(inPath, outPath, targetHex, { tolerance = 30 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const hex = targetHex.replace('#', '');
  const tr = parseInt(hex.slice(0, 2), 16), tg = parseInt(hex.slice(2, 4), 16), tb = parseInt(hex.slice(4, 6), 16);
  const hue = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return -1; // neutral, no hue
    let hh;
    if (mx === r) hh = ((g - b) / (mx - mn)) % 6;
    else if (mx === g) hh = (b - r) / (mx - mn) + 2;
    else hh = (r - g) / (mx - mn) + 4;
    return ((hh * 60) + 360) % 360;
  };
  const sat = (r, g, b) => { const mx = Math.max(r, g, b); return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx; };
  const th = hue(tr, tg, tb);
  let cleared = 0, feathered = 0;
  const out = Buffer.from(data);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] === 0) continue;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const s = sat(r, g, b);
    if (s < 0.25) continue; // neutrals (black keylines, white) never match
    const ph = hue(r, g, b);
    if (ph < 0) continue;
    let dh = Math.abs(ph - th);
    if (dh > 180) dh = 360 - dh;
    if (dh <= tolerance && s >= 0.45) { out[o + 3] = 0; cleared++; }
    else if (dh <= tolerance * 1.6 && s >= 0.3) { out[o + 3] = Math.round(data[o + 3] * 0.4); feathered++; }
  }
  await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPath);
  return { width: w, height: h, cleared, feathered, targetHex, tolerance };
}

// Remove ONLY the outer background canvas, bridging small gaps in an authored
// enclosing keyline (Papa's Raw Bar lesson, 2026-08-11: a broken circular ring
// lets a plain border flood-fill leak into the authored disc interior and strip
// it in stripes). Ink mask is dilated by bridgePx to close ring gaps before the
// outside flood; the cleared region is then grown back only across non-ink
// background pixels so no authored ink is ever removed. Interior ground
// (authored disc/panel semantics) is preserved untouched.
async function removeOuterCanvas(inPath, outPath, { bridgePx = 6, tolerance = 12 } = {}) {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;
  // border reference color (median of border pixels)
  const border = [];
  for (let x = 0; x < w; x++) { border.push((0 * w + x) * 4, ((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y++) { border.push((y * w + 0) * 4, (y * w + (w - 1)) * 4); }
  const med = (idx) => { const v = border.map((i) => data[i + idx]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const ref = [med(0), med(1), med(2)];
  const isBg = (i) => data[i * 4 + 3] === 0 || (Math.abs(data[i * 4] - ref[0]) <= tolerance && Math.abs(data[i * 4 + 1] - ref[1]) <= tolerance && Math.abs(data[i * 4 + 2] - ref[2]) <= tolerance);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = isBg(i) ? 0 : 1;
  // dilate ink by bridgePx (chebyshev) to close keyline gaps
  const dilate = (src, r) => {
    let cur = src;
    for (let step = 0; step < r; step++) {
      const next = new Uint8Array(cur);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])
          || (x > 0 && y > 0 && cur[i - w - 1]) || (x < w - 1 && y > 0 && cur[i - w + 1])
          || (x > 0 && y < h - 1 && cur[i + w - 1]) || (x < w - 1 && y < h - 1 && cur[i + w + 1])) next[i] = 1;
      }
      cur = next;
    }
    return cur;
  };
  const closed = dilate(ink, bridgePx);
  // flood outside over pixels not in closed mask
  const outside = new Uint8Array(n);
  const stack = [];
  for (let x = 0; x < w; x++) { if (!closed[x]) stack.push(x); if (!closed[(h - 1) * w + x]) stack.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { if (!closed[y * w]) stack.push(y * w); if (!closed[y * w + w - 1]) stack.push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (outside[i] || closed[i]) continue;
    outside[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  // grow cleared region back across non-ink background pixels only (recovers
  // the dilation band without touching authored ink or interior ground, which
  // stays unreachable behind the true ink ring)
  let grown = outside;
  for (let step = 0; step < bridgePx + 1; step++) {
    const next = new Uint8Array(grown);
    let changed = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (grown[i] || ink[i]) continue;
      if ((x > 0 && grown[i - 1]) || (x < w - 1 && grown[i + 1]) || (y > 0 && grown[i - w]) || (y < h - 1 && grown[i + w])) { next[i] = 1; changed = true; }
    }
    grown = next;
    if (!changed) break;
  }
  let cleared = 0;
  const out = Buffer.from(data);
  for (let i = 0; i < n; i++) {
    if (grown[i] && !ink[i]) { out[i * 4 + 3] = 0; cleared++; }
  }
  await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPath);
  return { width: w, height: h, cleared, bridgePx, tolerance, borderRef: `#${ref.map((v) => v.toString(16).padStart(2, '0')).join('')}` };
}

// CLI (only when run directly; gates.ts imports the functions above)
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const [cmd, ...rest] = isMain ? process.argv.slice(2) : [];
if (!isMain) {
  // imported as a library
} else if (cmd === 'floodfill') {
  const [inPath, outPath, tol] = rest;
  const r = await removeBackgroundFloodFill(inPath, outPath, { tolerance: tol ? Number(tol) : undefined });
  console.log(JSON.stringify(r));
} else if (cmd === 'remove-dark') {
  const [inPath, outPath, lumaMax] = rest;
  const r = await removeDarkInk(inPath, outPath, { lumaMax: lumaMax ? Number(lumaMax) : undefined });
  console.log(JSON.stringify(r));
} else if (cmd === 'remove-family') {
  const [inPath, outPath, hex, tol] = rest;
  const r = await removeColorFamily(inPath, outPath, hex, { tolerance: tol ? Number(tol) : undefined });
  console.log(JSON.stringify(r));
} else if (cmd === 'remove-outer-canvas') {
  const [inPath, outPath, bridge, tol] = rest;
  const r = await removeOuterCanvas(inPath, outPath, { bridgePx: bridge ? Number(bridge) : undefined, tolerance: tol ? Number(tol) : undefined });
  console.log(JSON.stringify(r));
} else if (cmd === 'restore-blocks') {
  const [inPath, outPath, tol] = rest;
  const r = await removeBackgroundRestoreBlocks(inPath, outPath, { tolerance: tol ? Number(tol) : undefined });
  console.log(JSON.stringify(r));
} else if (cmd === 'vanish-fix') {
  const [inPath, outPath, primaryHex, inkHex] = rest;
  const r = await fixVanishingElements(inPath, outPath, primaryHex, inkHex);
  console.log(JSON.stringify(r));
} else if (cmd === 'edge') {
  const [logoPath, hex] = rest;
  const r = await edgeBandLegibility(logoPath, hex);
  console.log(JSON.stringify(r));
} else if (cmd === 'vibrant') {
  const [imgPath] = rest;
  const r = await paletteVibrant(imgPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'stroke') {
  const [logoPath] = rest;
  const r = await strokeAnalysis(logoPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'upscale') {
  const [inPath, outPath, scale] = rest;
  const r = await upscaleESRGAN(inPath, outPath, { scale: scale ? Number(scale) : undefined });
  console.log(JSON.stringify(r));
} else if (cmd === 'knockout') {
  const [inPath, outPath, hex] = rest;
  const r = await knockoutSilhouette(inPath, outPath, hex || '#ffffff');
  console.log(JSON.stringify(r));
} else if (cmd === 'components') {
  const [inPath] = rest;
  const r = await listComponentsCmd(inPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'remove-components') {
  const [inPath, outPath, idsCsv] = rest;
  const ids = idsCsv.split(',').map((s) => Number(s.trim()));
  const r = await removeComponentsCmd(inPath, outPath, ids);
  console.log(JSON.stringify(r));
} else if (cmd === 'interior') {
  const [logoPath, hex] = rest;
  const r = await interiorFillCheck(logoPath, hex);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'extract-family') {
  const [inPath, outPath, hex, growArg, lightMinArg] = rest;
  const r = await extractColorFamily(inPath, outPath, hex, { grow: growArg ? Number(growArg) : 0, ...(lightMinArg ? { lightMin: Number(lightMinArg) } : {}) });
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'component-contrast') {
  const [logoPath, hex] = rest;
  const r = await componentContrastCheck(logoPath, hex);
  console.log(JSON.stringify(r, null, 2));
  if (!r.pass) process.exit(2);
} else if (cmd === 'whiteblob') {
  const [logoPath] = rest;
  const r = await whiteblobCheck(logoPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'border-dust') {
  const [logoPath] = rest;
  const r = await borderWhiteDustCheck(logoPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'remove-border-dust') {
  const [inPath, outPath] = rest;
  const r = await removeBorderWhiteDust(inPath, outPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'restore-alpha') {
  const [sourcePath, candidatePath, outPath] = rest;
  const r = await restoreAlphaFromSource(sourcePath, candidatePath, outPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'resize-alpha') {
  const [inPath, outPath, maxPx] = rest;
  const r = await resizeAlphaSafe(inPath, outPath, maxPx ? Number(maxPx) : 800);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'holes') {
  const [imgPath] = rest;
  const r = await countHoles(imgPath);
  console.log(JSON.stringify(r));
} else if (cmd === 'counter-punch') {
  const [inPath, outPath] = rest;
  const r = await counterPunch(inPath, outPath);
  console.log(JSON.stringify(r));
} else if (cmd === 'ship-gate') {
  const [imgPath, minPx] = rest;
  const r = await shipResolutionGate(imgPath, minPx ? { minLongest: Number(minPx) } : {});
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'soft-fringe') {
  const [imgPath] = rest;
  const r = await softFringeCheck(imgPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'deglow') {
  const [inPath, outPath] = rest;
  const r = await deglow(inPath, outPath);
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'verify-erase') {
  // verify-erase <original> <edited> <x0> <y0> <x1> <y1>
  // Mechanical proof for any in-mark region repaint/fill (Mad Claw lesson, 2026-08-24):
  //  1. every pixel OUTSIDE the rect must be byte-identical between original and edited;
  //  2. no glyph ink may CROSS the rect boundary in the ORIGINAL — ink adjacent to and
  //     continuing across an edge means the fill amputated a neighboring glyph.
  // "Ink" = pixels whose color differs from the edited rect's fill (sampled at rect center)
  // by >60 luma, with alpha >64. Any edge with a crossing run >=6px fails.
  const [origPath, editPath, x0s, y0s, x1s, y1s] = rest;
  const x0 = Number(x0s), y0 = Number(y0s), x1 = Number(x1s), y1 = Number(y1s);
  const { minAlpha, lumaDelta, minCrossingRunPx } = T('verify-erase');
  const o = await sharp(origPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const e = await sharp(editPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (o.info.width !== e.info.width || o.info.height !== e.info.height) {
    console.log(JSON.stringify({ pass: false, verdict: 'dimension_mismatch' }));
    process.exit(2);
  }
  const W = o.info.width, Hh = o.info.height;
  let outsideDiff = 0;
  for (let y = 0; y < Hh; y += 1) for (let x = 0; x < W; x += 1) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
    const i = (y * W + x) * 4;
    if (o.data[i] !== e.data[i] || o.data[i+1] !== e.data[i+1] || o.data[i+2] !== e.data[i+2] || o.data[i+3] !== e.data[i+3]) outsideDiff += 1;
  }
  const ci = ((Math.round((y0 + y1) / 2)) * W + Math.round((x0 + x1) / 2)) * 4;
  const fillLuma = 0.2126 * e.data[ci] + 0.7152 * e.data[ci+1] + 0.0722 * e.data[ci+2];
  const isInk = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= Hh) return false;
    const i = (y * W + x) * 4;
    if (o.data[i+3] <= minAlpha) return false;
    const l = 0.2126 * o.data[i] + 0.7152 * o.data[i+1] + 0.0722 * o.data[i+2];
    return Math.abs(l - fillLuma) > lumaDelta;
  };
  const crossRun = (len, inkAt) => {
    let best = 0, cur = 0;
    for (let t = 0; t < len; t += 1) {
      if (inkAt(t)) { cur += 1; best = Math.max(best, cur); } else cur = 0;
    }
    return best;
  };
  const edges = {
    top:    crossRun(x1 - x0 + 1, t => isInk(x0 + t, y0) && isInk(x0 + t, y0 - 1)),
    bottom: crossRun(x1 - x0 + 1, t => isInk(x0 + t, y1) && isInk(x0 + t, y1 + 1)),
    left:   crossRun(y1 - y0 + 1, t => isInk(x0, y0 + t) && isInk(x0 - 1, y0 + t)),
    right:  crossRun(y1 - y0 + 1, t => isInk(x1, y0 + t) && isInk(x1 + 1, y0 + t)),
  };
  const clipped = Object.entries(edges).filter(([, run]) => run >= minCrossingRunPx).map(([k]) => k);
  const pass = outsideDiff === 0 && clipped.length === 0;
  console.log(JSON.stringify({ pass, verdict: pass ? 'ok' : (outsideDiff ? 'FAIL: pixels outside rect were modified' : `FAIL: glyph ink crosses rect ${clipped.join('+')} edge — fill amputates a neighboring glyph`), outside_pixels_modified: outsideDiff, max_ink_crossing_run_px: edges }, null, 2));
  if (!pass) process.exitCode = 2;
} else if (cmd) {
  console.error('usage: iterate-logo-rules.mjs floodfill <in> <out> [tol] | restore-blocks <in> <out> [tol] | vanish-fix <in> <out> <primaryHex> <inkHex> | edge <logo> <primaryHex> | vibrant <img> | stroke <logo> | upscale <in> <out> [scale] | knockout <in> <out> [hex] | components <in> | remove-components <in> <out> <id,id,...> | interior <logo> <primaryHex> | component-contrast <logo> <primaryHex> | extract-family <in> <out> <targetHex> [growPx] [lightMin] | whiteblob <logo> | border-dust <logo> | remove-border-dust <in> <out> | restore-alpha <clean-source> <upscaled-candidate> <out> | resize-alpha <in> <out> [maxPx] | holes <img> | counter-punch <in> <out> | soft-fringe <img> | deglow <in> <out> | ship-gate <logo> [minPx] | verify-erase <original> <edited> <x0> <y0> <x1> <y1>');
  process.exit(1);
}
