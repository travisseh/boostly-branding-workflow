#!/usr/bin/env node
// cut-words.mjs: deterministic "business name words only" cut of a logo.
//
// Labels the alpha mask into 8-connected components (two-pass union-find),
// clusters them into text lines by vertical overlap, keeps the lines whose
// letter height is at least --min-line-ratio of the tallest text line, and
// drops everything else: ring/gear/emblem art, taglines, "EST." and "since"
// lines, phone numbers, city lines, slice dots. Kept pixels are mask-stripped
// (never row/column cropped, per the BAND-CROP BAN) with their antialias
// fringe, then tight-cropped with a small pad.
//
// Usage:
//   node scripts/cut-words.mjs --in <knockout.png> --out <words.png> \
//     [--json <components.json>] [--band 0.29,0.57] [--keep-ids 3,4] \
//     [--drop-ids 9] [--white] [--width 1600] [--binary-alpha] [--pad 0.02] \
//     [--min-line-ratio 0.5] [--giant 0.6]
//   node scripts/cut-words.mjs --svg <page.svg> --out <words.png> \
//     [--region x0,y0,x1,y1] [--fill "rgb(100%, 100%, 100%)"] [--white|--color #hex] \
//     [--width 4000] [--band 0.3,0.6] [--keep-ids 3,4] [--drop-ids 9] [--json <sidecar>]
//
// The sidecar marks a dropped annular giant (ring, frame, gear; hole share > 0.3)
// with kind: 'ring' and reports its hole as `ring.inner_band` for an emblem-inner cut.
// --svg is the vector route (see the block below): --region is in page units, --band
// is a fraction of the region height, --width is the render width (4000 default) and
// <out>.svg keeps the vector cut.
//
// Exit codes: 0 ok, 1 usage/load error, 2 nothing kept, 3 (--svg) clip check failed.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sharp = require('sharp');

export const CUT_WORDS_DEFAULTS = {
  alphaThreshold: 128,
  minLineRatio: 0.5,
  giantShare: 0.6,
  enclosureShare: 0.25,
  minComponentPixels: 4,
  soloAspect: 2.0,
  pad: 0.02,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2);
    if (flag === 'white' || flag === 'binary-alpha') {
      args[flag] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[flag] = value;
    i += 1;
  }
  if ((!args.in && !args.svg) || !args.out) throw new Error('Usage: cut-words.mjs --in <png> | --svg <page.svg> --out <png> [options]');
  return args;
}

// Two-pass union-find labeling of an 8-connected binary mask.
export function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height).fill(0);
  const parent = [0];
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  let next = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (!mask[p]) continue;
      const neighbors = [];
      if (x > 0 && mask[p - 1]) neighbors.push(labels[p - 1]);
      if (y > 0) {
        const up = p - width;
        if (mask[up]) neighbors.push(labels[up]);
        if (x > 0 && mask[up - 1]) neighbors.push(labels[up - 1]);
        if (x < width - 1 && mask[up + 1]) neighbors.push(labels[up + 1]);
      }
      if (!neighbors.length) {
        labels[p] = next;
        parent.push(next);
        next += 1;
      } else {
        let min = neighbors[0];
        for (const n of neighbors) if (n < min) min = n;
        labels[p] = min;
        for (const n of neighbors) union(min, n);
      }
    }
  }
  const remap = new Map();
  const components = [];
  for (let p = 0; p < labels.length; p += 1) {
    if (!labels[p]) continue;
    const root = find(labels[p]);
    let id = remap.get(root);
    if (id === undefined) {
      id = components.length;
      remap.set(root, id);
      components.push({ id, area: 0, minX: width, maxX: -1, minY: height, maxY: -1 });
    }
    labels[p] = id + 1;
    const c = components[id];
    const x = p % width;
    const y = (p / width) | 0;
    c.area += 1;
    if (x < c.minX) c.minX = x;
    if (x > c.maxX) c.maxX = x;
    if (y < c.minY) c.minY = y;
    if (y > c.maxY) c.maxY = y;
  }
  for (const c of components) {
    c.width = c.maxX - c.minX + 1;
    c.height = c.maxY - c.minY + 1;
    c.cy = (c.minY + c.maxY) / 2;
  }
  return { labels, components };
}

// Share of a component's background-adjacent pixels that are ENCLOSED
// background (not reachable from the canvas border through background).
// A ring, gear, frame, or closed emblem outline sits against enclosed space on
// one side (about 0.5); an inner arc inside a ring sits entirely in enclosed
// space (1.0); a free-standing word touches only exterior space (near 0).
/** Background pixels reachable from the canvas border through background (4-connected flood). */
export function exteriorReach(mask, width, height) {
  const reach = new Uint8Array(width * height);
  const queue = [];
  const push = (p) => {
    if (mask[p] || reach[p]) return;
    reach[p] = 1;
    queue.push(p);
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const p = queue[head];
    const x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p + width < mask.length) push(p + width);
  }
  return reach;
}

/**
 * Hole share of a giant: enclosed background inside its bbox over the bbox area, with the
 * bbox of that enclosed space. A ring or frame scores about 0.5 to 0.8 (annular); a filled disc
 * or an open arc scores near 0. `inner_bbox` is where an inner emblem or ring text sits.
 */
export function holeShare(mask, reach, width, height, c) {
  let holes = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = c.minY; y <= c.maxY; y += 1) {
    for (let x = c.minX; x <= c.maxX; x += 1) {
      const p = y * width + x;
      if (mask[p] || reach[p]) continue;
      holes += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const share = holes / Math.max(1, c.width * c.height);
  return { share: Number(share.toFixed(3)), inner_bbox: maxX < 0 ? null : [minX, minY, maxX, maxY] };
}
export const RING_HOLE_SHARE = 0.3;

export function enclosedAdjacency(mask, labels, width, height, ids, reach = exteriorReach(mask, width, height)) {
  const counts = new Map([...ids].map((id) => [id, { enclosed: 0, exterior: 0 }]));
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const id = labels[p] - 1;
    const c = counts.get(id);
    if (!c) continue;
    const x = p % width;
    const check = (q) => {
      if (mask[q]) return;
      if (reach[q]) c.exterior += 1;
      else c.enclosed += 1;
    };
    if (x > 0) check(p - 1);
    if (x < width - 1) check(p + 1);
    if (p >= width) check(p - width);
    if (p + width < mask.length) check(p + width);
  }
  const result = new Map();
  for (const [id, c] of counts) result.set(id, c.enclosed / Math.max(1, c.enclosed + c.exterior));
  return result;
}

// Cluster components into text lines by vertical bbox overlap.
function clusterLines(components) {
  const sorted = [...components].sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const c of sorted) {
    let placed = null;
    for (const line of lines) {
      const overlap = Math.min(line.maxY, c.maxY) - Math.max(line.minY, c.minY) + 1;
      const shorter = Math.min(line.medianHeight, c.height);
      if (overlap > 0 && overlap / shorter >= 0.5) {
        placed = line;
        break;
      }
    }
    if (!placed) {
      lines.push({ members: [c], minY: c.minY, maxY: c.maxY, medianHeight: c.height, weightedHeight: c.height });
    } else {
      placed.members.push(c);
      placed.minY = Math.min(placed.minY, c.minY);
      placed.maxY = Math.max(placed.maxY, c.maxY);
      const heights = placed.members.map((m) => m.height).sort((a, b) => a - b);
      placed.medianHeight = heights[Math.floor(heights.length / 2)];
      const ink = placed.members.reduce((sum, m) => sum + m.area, 0);
      placed.weightedHeight = placed.members.reduce((sum, m) => sum + m.height * m.area, 0) / Math.max(1, ink);
    }
  }
  // Second pass: merge lines that overlap each other vertically (a swash
  // initial or fused script word can straddle pieces clustered earlier).
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < lines.length && !merged; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const a = lines[i];
        const b = lines[j];
        const overlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1;
        const shorter = Math.min(a.weightedHeight, b.weightedHeight);
        if (overlap > 0 && overlap / shorter >= 0.5) {
          a.members.push(...b.members);
          a.minY = Math.min(a.minY, b.minY);
          a.maxY = Math.max(a.maxY, b.maxY);
          const heights = a.members.map((m) => m.height).sort((x, y) => x - y);
          a.medianHeight = heights[Math.floor(heights.length / 2)];
          const ink = a.members.reduce((sum, m) => sum + m.area, 0);
          a.weightedHeight = a.members.reduce((sum, m) => sum + m.height * m.area, 0) / Math.max(1, ink);
          lines.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return lines.map((line, index) => ({
    id: index,
    members: line.members,
    minY: line.minY,
    maxY: line.maxY,
    medianHeight: line.medianHeight,
    weightedHeight: line.weightedHeight,
    minX: Math.min(...line.members.map((m) => m.minX)),
    maxX: Math.max(...line.members.map((m) => m.maxX)),
    area: line.members.reduce((sum, m) => sum + m.area, 0),
  }));
}

// A giant component is an emblem (arc, ring, frame, gear) when its bbox fully
// contains a word-like line of at least two other components: the words sit
// inside the art. A fused script word rarely contains a whole other line.
function containsWordLine(giant, components) {
  const inside = components.filter((c) => c !== giant && c.area >= 4
    && c.minX >= giant.minX && c.maxX <= giant.maxX && c.minY >= giant.minY && c.maxY <= giant.maxY);
  if (inside.length < 2) return false;
  return clusterLines(inside).some((line) => line.members.length >= 2
    && line.weightedHeight >= 0.1 * giant.height);
}

export function classifyComponents(components, width, height, options = {}) {
  const o = { ...CUT_WORDS_DEFAULTS, ...options };
  const totalInk = components.reduce((sum, c) => sum + c.area, 0);
  const decisions = new Map();
  const bandTop = o.band ? Math.round(o.band[0] * height) : 0;
  const bandBottom = o.band ? Math.round(o.band[1] * height) : height;
  const keepIds = new Set(o.keepIds ?? []);
  const dropIds = new Set(o.dropIds ?? []);

  const textCandidates = [];
  for (const c of components) {
    if (keepIds.has(c.id)) {
      decisions.set(c.id, 'kept:forced');
      continue;
    }
    if (dropIds.has(c.id)) {
      decisions.set(c.id, 'dropped:forced');
      continue;
    }
    if (c.area < o.minComponentPixels) {
      decisions.set(c.id, 'dropped:dust');
      continue;
    }
    const giant = c.width / width > o.giantShare || c.height / height > o.giantShare || c.area / totalInk > 0.4;
    // Emblem test: enclosed space beside it (ring, frame, closed outline), or a
    // wide arc (aspect >= 1.6) wrapped around a word line. A swash initial that
    // nests the rest of its word (Denise's "D") is squarer and stays text.
    const wideArc = c.width / c.height >= 1.6;
    if (giant && ((c.enclosedAdjacency ?? 0) >= o.enclosureShare || (wideArc && containsWordLine(c, components)))) {
      decisions.set(c.id, 'dropped:giant_emblem_or_ring');
      continue;
    }
    if (c.minY < bandTop || c.maxY > bandBottom) {
      decisions.set(c.id, 'dropped:outside_band');
      continue;
    }
    textCandidates.push(c);
  }

  const lines = clusterLines(textCandidates);
  // Word-like lines: at least 2 members, or a single wide component (a joined script word).
  const wordLines = lines.filter((line) => line.members.length >= 2
    || line.members.some((m) => m.width / m.height >= o.soloAspect));
  // Line size is the ink-weighted mean member height: a fused script word or a
  // swash capital dominates its line; many tiny members do not shrink it.
  const tallest = wordLines.reduce((max, line) => Math.max(max, line.weightedHeight), 0);
  for (const line of lines) {
    const wordLike = wordLines.includes(line);
    const ratio = tallest ? line.weightedHeight / tallest : 0;
    let reason;
    if (!wordLike) reason = 'dropped:solo_non_word_shape';
    else if (ratio < o.minLineRatio) reason = 'dropped:descriptor_line_below_ratio';
    else reason = 'kept:name_line';
    line.reason = reason;
    line.heightRatio = Number(ratio.toFixed(3));
    for (const m of line.members) {
      // Small members of a kept line that are far shorter than the line (slice dots, dashes)
      if (reason.startsWith('kept') && m.height < 0.3 * line.medianHeight && m.width < 0.3 * line.medianHeight) {
        decisions.set(m.id, 'dropped:small_mark_in_line');
      } else {
        decisions.set(m.id, reason);
      }
    }
  }
  return { decisions, lines, totalInk };
}

export async function cutWords(inPath, outPath, options = {}) {
  const o = { ...CUT_WORDS_DEFAULTS, ...options };
  const { data, info } = await sharp(path.resolve(inPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) mask[p] = data[p * 4 + 3] >= o.alphaThreshold ? 1 : 0;
  const { labels, components } = labelComponents(mask, width, height);
  const inkTotal = components.reduce((sum, c) => sum + c.area, 0);
  const giants = components.filter((c) => c.width / width > o.giantShare || c.height / height > o.giantShare || c.area / inkTotal > 0.4);
  const reach = exteriorReach(mask, width, height);
  const enclosure = enclosedAdjacency(mask, labels, width, height, giants.map((c) => c.id), reach);
  for (const c of giants) {
    c.enclosedAdjacency = Number(enclosure.get(c.id).toFixed(3));
    const hole = holeShare(mask, reach, width, height, c);
    c.holeShare = hole.share;
    c.innerBbox = hole.inner_bbox;
  }
  const { decisions, lines, totalInk } = classifyComponents(components, width, height, o);
  // kind: 'ring' marks a dropped annular giant (ring, frame, gear): the inner emblem row cuts inside its hole.
  for (const c of giants) {
    if (decisions.get(c.id) === 'dropped:giant_emblem_or_ring' && c.holeShare > RING_HOLE_SHARE) c.kind = 'ring';
  }
  const ring = giants.filter((c) => c.kind === 'ring').sort((a, b) => b.area - a.area)[0] ?? null;
  const keptIds = new Set([...decisions.entries()].filter(([, v]) => v.startsWith('kept')).map(([k]) => k));
  if (!keptIds.size) {
    return { ok: false, reason: 'no_components_kept', components, decisions: Object.fromEntries(decisions), lines };
  }

  // Kept mask = kept components + antialias fringe within 2px of them, excluding pixels of dropped components.
  const keptCore = new Uint8Array(width * height);
  for (let p = 0; p < labels.length; p += 1) if (labels[p] && keptIds.has(labels[p] - 1)) keptCore[p] = 1;
  const out = Buffer.alloc(width * height * 4, 0);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const alpha = data[p * 4 + 3];
      if (!alpha) continue;
      let keep = keptCore[p] === 1;
      if (!keep && !labels[p]) {
        // fringe pixel below threshold: keep when a kept core pixel is within 2px
        for (let dy = -2; dy <= 2 && !keep; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (keptCore[ny * width + nx]) {
              keep = true;
              break;
            }
          }
        }
      }
      if (!keep) continue;
      out[p * 4] = o.white ? 255 : data[p * 4];
      out[p * 4 + 1] = o.white ? 255 : data[p * 4 + 1];
      out[p * 4 + 2] = o.white ? 255 : data[p * 4 + 2];
      out[p * 4 + 3] = o.binaryAlpha ? (alpha >= o.alphaThreshold ? 255 : 0) : alpha;
      if (out[p * 4 + 3]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const pad = Math.round(o.pad * Math.max(maxX - minX + 1, maxY - minY + 1));
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const cropW = Math.min(width, maxX + 1 + pad) - left;
  const cropH = Math.min(height, maxY + 1 + pad) - top;
  let image = sharp(out, { raw: { width, height, channels: 4 } }).extract({ left, top, width: cropW, height: cropH });
  if (o.width && Number(o.width) < cropW) {
    const buffer = await image.png().toBuffer();
    image = sharp(buffer).resize({ width: Number(o.width), kernel: 'lanczos3' });
    if (o.binaryAlpha) {
      const resized = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let p = 0; p < resized.data.length; p += 4) {
        resized.data[p + 3] = resized.data[p + 3] >= 128 ? 255 : 0;
        if (!resized.data[p + 3]) {
          resized.data[p] = 0;
          resized.data[p + 1] = 0;
          resized.data[p + 2] = 0;
        } else if (o.white) {
          resized.data[p] = 255;
          resized.data[p + 1] = 255;
          resized.data[p + 2] = 255;
        }
      }
      image = sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: 4 } });
    }
  }
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await image.png({ palette: false, compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toFile(path.resolve(outPath));
  const meta = await sharp(path.resolve(outPath)).metadata();
  const bytes = (await fs.stat(path.resolve(outPath))).size;
  return {
    ok: true,
    in: path.resolve(inPath),
    out: path.resolve(outPath),
    width: meta.width,
    height: meta.height,
    bytes,
    source: { width, height, total_ink: totalInk },
    kept_component_count: keptIds.size,
    dropped_component_count: components.length - keptIds.size,
    kept_ink_share: Number((components.filter((c) => keptIds.has(c.id)).reduce((s, c) => s + c.area, 0) / totalInk).toFixed(4)),
    // the largest dropped ring, with its hole as a --band hint (fractions of the source height) for an emblem_inner cut
    ring: ring ? { id: ring.id, hole_share: ring.holeShare, inner_bbox: ring.innerBbox, inner_band: ring.innerBbox ? [Number((ring.innerBbox[1] / height).toFixed(4)), Number(((ring.innerBbox[3] + 1) / height).toFixed(4))] : null } : null,
    lines: lines.map((line) => ({
      id: line.id,
      reason: line.reason,
      height_ratio: line.heightRatio,
      median_height: line.medianHeight,
      weighted_height: Math.round(line.weightedHeight),
      members: line.members.map((m) => m.id),
      bbox: [line.minX, line.minY, line.maxX, line.maxY],
    })),
    components: components.map((c) => ({
      id: c.id,
      area: c.area,
      bbox: [c.minX, c.minY, c.maxX, c.maxY],
      width: c.width,
      height: c.height,
      enclosed_adjacency: c.enclosedAdjacency ?? null,
      hole_share: c.holeShare ?? null,
      inner_bbox: c.innerBbox ?? null,
      kind: c.kind ?? null,
      decision: decisions.get(c.id),
    })),
    options: { ...o, keepIds: [...(o.keepIds ?? [])], dropIds: [...(o.dropIds ?? [])] },
  };
}

// ---------------------------------------------------------------------------
// --svg mode: words from the glyph outlines of a pdftocairo page SVG (menu PDF
// or site SVG), never from a raster. The page keeps every glyph as
// <g id="glyph-F-N"><path d=.../></g> in <defs> and places it with
// <use xlink:href="#glyph-F-N" x= y=/> inside <g fill=...> groups. Each use is a
// component (bbox from the glyph's absolute path coordinates plus the ancestor
// transforms); the same line clustering and height-ratio rule pick the name
// lines; the kept uses are re-emitted with absolute matrices into a tight
// viewBox and rendered through sharp (librsvg). The clip check then proves no
// glyph box reaches the output edge and no ink touches it (Brothers 2026-10-12:
// raster band cuts clipped the descenders).
// ---------------------------------------------------------------------------
const IDENTITY = [1, 0, 0, 1, 0, 0];
function mulMatrix(m, n) {
  // m x n (apply n first, then m), SVG matrix(a b c d e f) convention
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export function parseTransform(text) {
  let m = [...IDENTITY];
  if (!text) return m;
  const re = /(matrix|translate|scale)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(text))) {
    const v = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t = [...IDENTITY];
    if (match[1] === 'matrix' && v.length === 6) t = v;
    else if (match[1] === 'translate') t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (match[1] === 'scale') t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    m = mulMatrix(m, t);
  }
  return m;
}
function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function bboxUnderMatrix(m, [x0, y0, x1, y1]) {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => applyMatrix(m, x, y));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}
/** Control-point bbox of absolute-coordinate path data (cairo emits M/L/C/Z only). */
export function pathBbox(d) {
  const nums = (d.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  if (nums.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (nums[i] < x0) x0 = nums[i];
    if (nums[i] > x1) x1 = nums[i];
    if (nums[i + 1] < y0) y0 = nums[i + 1];
    if (nums[i + 1] > y1) y1 = nums[i + 1];
  }
  return [x0, y0, x1, y1];
}
function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
/** Parse a page SVG into glyph defs (id -> {markup, bbox}) and placed uses with absolute matrices and fills. */
export function parsePageSvg(svg) {
  const root = /<svg[^>]*>/.exec(svg)?.[0] ?? '';
  const vb = (attr(root, 'viewBox') ?? '').split(/[\s,]+/).map(Number);
  const page = vb.length === 4 ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } : { x: 0, y: 0, width: Number(attr(root, 'width')) || 0, height: Number(attr(root, 'height')) || 0 };
  const glyphs = new Map();
  const defRe = /<g id="(glyph-[^"]+)">([\s\S]*?)<\/g>/g;
  let m;
  while ((m = defRe.exec(svg))) {
    const d = /\sd="([^"]*)"/.exec(m[2])?.[1] ?? '';
    glyphs.set(m[1], { markup: m[2].trim(), bbox: d ? pathBbox(d) : null });
  }
  const defsEnd = svg.indexOf('</defs>');
  const body = defsEnd >= 0 ? svg.slice(defsEnd + 7) : svg;
  const uses = [];
  const stack = [{ matrix: [...IDENTITY], fill: null }];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  while ((m = tagRe.exec(body))) {
    const [, close, name, attrs, selfClosing] = m;
    const top = stack[stack.length - 1];
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (name === 'use') {
      const href = (attr(m[0], 'xlink:href') ?? attr(m[0], 'href') ?? '').replace(/^#/, '');
      if (href.startsWith('glyph-')) {
        const glyph = glyphs.get(href);
        const x = Number(attr(m[0], 'x') ?? 0);
        const y = Number(attr(m[0], 'y') ?? 0);
        const matrix = mulMatrix(mulMatrix(top.matrix, parseTransform(attr(m[0], 'transform'))), [1, 0, 0, 1, x, y]);
        const bbox = glyph?.bbox ? bboxUnderMatrix(matrix, glyph.bbox) : null;
        uses.push({ index: uses.length, href, matrix, fill: attr(m[0], 'fill') ?? top.fill, bbox });
      }
      if (!selfClosing) stack.push({ ...top });
      continue;
    }
    if (selfClosing) continue;
    stack.push({ matrix: mulMatrix(top.matrix, parseTransform(attr(m[0], 'transform'))), fill: attr(m[0], 'fill') ?? top.fill });
  }
  return { page, glyphs, uses };
}
function fmt(n) {
  return Number(n.toFixed(4)).toString();
}

export async function cutWordsSvg(inPath, outPath, options = {}) {
  const o = { ...CUT_WORDS_DEFAULTS, minComponentPixels: 0, width: 4000, ...options };
  const svg = await fs.readFile(path.resolve(inPath), 'utf8');
  const { page, glyphs, uses } = parsePageSvg(svg);
  const region = o.region ?? [page.x, page.y, page.x + page.width, page.y + page.height];
  const [rx0, ry0, rx1, ry1] = region;
  const regionW = rx1 - rx0;
  const regionH = ry1 - ry0;
  const fillWanted = o.fill ? o.fill.replace(/\s+/g, '').toLowerCase() : null;
  // a use belongs to the region when its box centre falls inside it; the whole glyph box is kept afterwards (descenders included)
  const placed = uses.filter((u) => u.bbox).filter((u) => {
    const cx = (u.bbox[0] + u.bbox[2]) / 2;
    const cy = (u.bbox[1] + u.bbox[3]) / 2;
    if (cx < rx0 || cx > rx1 || cy < ry0 || cy > ry1) return false;
    if (fillWanted && (u.fill ?? '').replace(/\s+/g, '').toLowerCase() !== fillWanted) return false;
    return true;
  });
  const components = placed.map((u, id) => {
    const [x0, y0, x1, y1] = u.bbox;
    const c = { id, use: u, minX: x0 - rx0, maxX: x1 - rx0, minY: y0 - ry0, maxY: y1 - ry0 };
    c.width = Math.max(1e-6, c.maxX - c.minX);
    c.height = Math.max(1e-6, c.maxY - c.minY);
    c.area = c.width * c.height;
    c.cy = (c.minY + c.maxY) / 2;
    return c;
  });
  if (!components.length) return { ok: false, reason: 'no_glyph_uses_in_region', mode: 'svg', page, uses_total: uses.length, components: [], lines: [] };
  const { decisions, lines, totalInk } = classifyComponents(components, regionW, regionH, o);
  const kept = components.filter((c) => (decisions.get(c.id) ?? '').startsWith('kept'));
  const describe = () => ({
    mode: 'svg',
    in: path.resolve(inPath),
    page,
    region,
    glyph_defs: glyphs.size,
    uses_total: uses.length,
    uses_in_region: placed.length,
    lines: lines.map((line) => ({ id: line.id, reason: line.reason, height_ratio: line.heightRatio, median_height: line.medianHeight, weighted_height: line.weightedHeight, members: line.members.map((m) => m.id), bbox: [line.minX + rx0, line.minY + ry0, line.maxX + rx0, line.maxY + ry0] })),
    components: components.map((c) => ({ id: c.id, href: c.use.href, fill: c.use.fill, area: c.area, bbox: c.use.bbox, width: c.width, height: c.height, decision: decisions.get(c.id) })),
  });
  if (!kept.length) return { ok: false, reason: 'no_components_kept', ...describe() };

  const ux0 = Math.min(...kept.map((c) => c.use.bbox[0]));
  const uy0 = Math.min(...kept.map((c) => c.use.bbox[1]));
  const ux1 = Math.max(...kept.map((c) => c.use.bbox[2]));
  const uy1 = Math.max(...kept.map((c) => c.use.bbox[3]));
  const pad = o.pad * Math.max(ux1 - ux0, uy1 - uy0);
  const vx = ux0 - pad;
  const vy = uy0 - pad;
  const vw = ux1 - ux0 + 2 * pad;
  const vh = uy1 - uy0 + 2 * pad;
  const outW = Number(o.width);
  const outH = Math.max(1, Math.round(vh * outW / vw));
  const defIds = [...new Set(kept.map((c) => c.use.href))];
  const fillFor = (u) => (o.white ? '#FFFFFF' : o.color ?? u.fill ?? '#000000');
  const markup = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(vw)}" height="${fmt(vh)}" viewBox="${fmt(vx)} ${fmt(vy)} ${fmt(vw)} ${fmt(vh)}">`,
    '<defs>',
    ...defIds.map((id) => `<g id="${id}">${glyphs.get(id).markup}</g>`),
    '</defs>',
    ...kept.map((c) => `<use xlink:href="#${c.use.href}" fill="${fillFor(c.use)}" transform="matrix(${c.use.matrix.map(fmt).join(' ')})"/>`),
    '</svg>',
  ].join('\n');
  const svgOut = `${path.resolve(outPath)}.svg`;
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(svgOut, `${markup}\n`);
  const density = 72 * outW / vw;
  await sharp(Buffer.from(markup), { density }).resize({ width: outW, height: outH, fit: 'fill' }).ensureAlpha()
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toFile(path.resolve(outPath));

  // Clip check: no ink on the outermost row/column, every kept glyph box strictly inside the output.
  const { data, info } = await sharp(path.resolve(outPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const edge = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let x = 0; x < W; x += 1) {
    if (data[x * 4 + 3]) edge.top += 1;
    if (data[((H - 1) * W + x) * 4 + 3]) edge.bottom += 1;
  }
  for (let y = 0; y < H; y += 1) {
    if (data[(y * W) * 4 + 3]) edge.left += 1;
    if (data[(y * W + W - 1) * 4 + 3]) edge.right += 1;
  }
  const sx = W / vw;
  const sy = H / vh;
  const outside = kept.filter((c) => {
    const [x0, y0, x1, y1] = c.use.bbox;
    return (x0 - vx) * sx <= 0 || (y0 - vy) * sy <= 0 || (x1 - vx) * sx >= W || (y1 - vy) * sy >= H;
  }).map((c) => c.id);
  const clip = { pass: !outside.length && Object.values(edge).every((n) => n === 0), edge_ink: edge, glyphs_outside: outside };
  const bytes = (await fs.stat(path.resolve(outPath))).size;
  return {
    ok: true,
    out: path.resolve(outPath),
    svg: svgOut,
    width: W,
    height: H,
    bytes,
    view_box: [vx, vy, vw, vh],
    kept_component_count: kept.length,
    dropped_component_count: components.length - kept.length,
    kept_ink_share: Number((kept.reduce((s, c) => s + c.area, 0) / totalInk).toFixed(4)),
    clip_check: clip,
    ...describe(),
    options: { ...o, keepIds: [...(o.keepIds ?? [])], dropIds: [...(o.dropIds ?? [])] },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.svg) {
    const result = await cutWordsSvg(args.svg, args.out, {
      white: Boolean(args.white),
      color: args.color ?? null,
      fill: args.fill ?? null,
      width: args.width ? Number(args.width) : 4000,
      pad: args.pad ? Number(args.pad) : CUT_WORDS_DEFAULTS.pad,
      minLineRatio: args['min-line-ratio'] ? Number(args['min-line-ratio']) : CUT_WORDS_DEFAULTS.minLineRatio,
      region: args.region ? args.region.split(',').map(Number) : null,
      band: args.band ? args.band.split(',').map(Number) : null,
      keepIds: args['keep-ids'] ? args['keep-ids'].split(',').map(Number) : [],
      dropIds: args['drop-ids'] ? args['drop-ids'].split(',').map(Number) : [],
    });
    if (args.json) {
      await fs.mkdir(path.dirname(path.resolve(args.json)), { recursive: true });
      await fs.writeFile(path.resolve(args.json), `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify({ ...result, components: `${result.components?.length ?? 0} glyph uses (see --json)` }, null, 2)}\n`);
    if (!result.ok) process.exit(2);
    if (!result.clip_check.pass) process.exit(3);
    return;
  }
  const options = {
    white: Boolean(args.white),
    binaryAlpha: Boolean(args['binary-alpha']),
    width: args.width ? Number(args.width) : null,
    pad: args.pad ? Number(args.pad) : CUT_WORDS_DEFAULTS.pad,
    minLineRatio: args['min-line-ratio'] ? Number(args['min-line-ratio']) : CUT_WORDS_DEFAULTS.minLineRatio,
    giantShare: args.giant ? Number(args.giant) : CUT_WORDS_DEFAULTS.giantShare,
    band: args.band ? args.band.split(',').map(Number) : null,
    keepIds: args['keep-ids'] ? args['keep-ids'].split(',').map(Number) : [],
    dropIds: args['drop-ids'] ? args['drop-ids'].split(',').map(Number) : [],
  };
  const result = await cutWords(args.in, args.out, options);
  if (args.json) {
    await fs.mkdir(path.dirname(path.resolve(args.json)), { recursive: true });
    await fs.writeFile(path.resolve(args.json), `${JSON.stringify(result, null, 2)}\n`);
  }
  const summary = { ...result, components: `${result.components?.length ?? 0} components (see --json)` };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!result.ok) process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
