// Turn a styled QR SVG (plan.mjs generateStyledSvgQR output: one <g fill> of rounded modules
// plus three finder pairs) into the node tree Figma's SVG import produces when the master is
// cloned into a holder and rescaled: FRAME "qr-<key>" > [GROUP "Group" of module VECTORs,
// then (outer evenodd VECTOR, inner VECTOR) x 3]. Coordinates are scaled to the holder size.
import fs from 'node:fs';

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/g;

// Parse an SVG path (M/L/Q/Z with commas, as the generator writes them) into absolute segments.
export function parsePath(d) {
  const segs = [];
  const re = /([MLQZmlqz])([^MLQZmlqz]*)/g;
  let m;
  let cur = [0, 0];
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const nums = (m[2].match(NUM) || []).map(Number);
    if (cmd === 'Z' || cmd === 'z') { segs.push({ c: 'Z' }); continue; }
    if (cmd === 'M') { cur = [nums[0], nums[1]]; segs.push({ c: 'M', p: [cur[0], cur[1]] }); continue; }
    if (cmd === 'L') { cur = [nums[0], nums[1]]; segs.push({ c: 'L', p: [cur[0], cur[1]] }); continue; }
    if (cmd === 'Q') {
      // Quadratic -> cubic (Figma stores cubics): C1 = P0 + 2/3 (Q - P0), C2 = P2 + 2/3 (Q - P2).
      const [qx, qy, x, y] = nums;
      const c1 = [cur[0] + (2 / 3) * (qx - cur[0]), cur[1] + (2 / 3) * (qy - cur[1])];
      const c2 = [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y)];
      segs.push({ c: 'C', p: [c1[0], c1[1], c2[0], c2[1], x, y] });
      cur = [x, y];
      continue;
    }
    throw new Error(`unsupported path command ${cmd}`);
  }
  return segs;
}

function bbox(segs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    if (!s.p) continue;
    for (let i = 0; i < s.p.length; i += 2) { x0 = Math.min(x0, s.p[i]); x1 = Math.max(x1, s.p[i]); y0 = Math.min(y0, s.p[i + 1]); y1 = Math.max(y1, s.p[i + 1]); }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const r4 = (v) => Math.round(v * 10000) / 10000;

export function segsToData(segs, dx = 0, dy = 0, scale = 1) {
  return segs.map((s) => {
    if (s.c === 'Z') return 'Z';
    const p = s.p.map((v, i) => r4((v - (i % 2 === 0 ? dx : dy)) * scale));
    if (s.c === 'M') return `M${p[0]} ${p[1]}`;
    if (s.c === 'L') return `L${p[0]} ${p[1]}`;
    return `C${p[0]} ${p[1]} ${p[2]} ${p[3]} ${p[4]} ${p[5]}`;
  }).join('');
}

function vectorNode(d, fill, windingRule, scale) {
  const segs = parsePath(d);
  const b = bbox(segs);
  return {
    t: 'VECTOR', n: 'Vector', w: r4(b.w * scale), h: r4(b.h * scale), x: r4(b.x * scale), y: r4(b.y * scale),
    f: [{ c: fill }],
    vp: [{ windingRule, data: segsToData(segs, b.x, b.y, scale) }],
  };
}

// Returns { node, moduleCount, moduleSize, modules } for a holder of the given size.
export function qrSvgToNodes(svgFile, key, holderSize) {
  const svg = fs.readFileSync(svgFile, 'utf8');
  const vb = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!vb) throw new Error(`${svgFile}: no viewBox`);
  const size = Number(vb[1]);
  const scale = holderSize / size;
  const gm = svg.match(/<g fill="(#[0-9a-fA-F]{6})">([\s\S]*?)<\/g>/);
  if (!gm) throw new Error(`${svgFile}: no module group`);
  const fill = gm[1].toLowerCase();
  const modules = [...gm[2].matchAll(/<path d="([^"]+)"\s*\/>/g)].map((m) => vectorNode(m[1], fill, 'NONZERO', scale));
  const after = svg.slice(svg.indexOf('</g>') + 4);
  const finders = [...after.matchAll(/<path d="([^"]+)" fill="(#[0-9a-fA-F]{6})"(?: fill-rule="evenodd")?\s*\/>/g)]
    .map((m) => vectorNode(m[1], m[2].toLowerCase(), /fill-rule="evenodd"/.test(m[0]) ? 'EVENODD' : 'NONZERO', scale));
  if (finders.length !== 6) throw new Error(`${svgFile}: expected 6 finder paths, found ${finders.length}`);
  // The module group: Figma keeps the <g> as a GROUP whose box hugs its modules; children are
  // positioned relative to the group.
  const gx = Math.min(...modules.map((v) => v.x)), gy = Math.min(...modules.map((v) => v.y));
  const gx1 = Math.max(...modules.map((v) => v.x + v.w)), gy1 = Math.max(...modules.map((v) => v.y + v.h));
  const group = { t: 'GROUP', n: 'Group', x: r4(gx), y: r4(gy), w: r4(gx1 - gx), h: r4(gy1 - gy), k: modules.map((v) => ({ ...v, x: r4(v.x - gx), y: r4(v.y - gy) })) };
  const moduleCount = Math.round(size / (modules[0].w / scale)) - 4;
  const node = { t: 'FRAME', n: key, w: holderSize, h: holderSize, x: 0, y: 0, clip: false, k: [group, ...finders] };
  return { node, moduleCount, moduleSize: holderSize / (moduleCount + 4), modules: modules.length, fill };
}
