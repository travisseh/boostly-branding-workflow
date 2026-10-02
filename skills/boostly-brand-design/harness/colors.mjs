#!/usr/bin/env node

async function loadSharp() {
  const mod = await import('sharp');
  return mod.default;
}

export function normalizeHex(hex) {
  if (typeof hex !== 'string') throw new Error(`Expected hex string, got ${typeof hex}`);
  let value = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    value = value.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`Invalid hex color: ${hex}`);
  return `#${value.toLowerCase()}`;
}

export function hexToRgb(hex) {
  const value = normalizeHex(hex).slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }) {
  h = ((h % 360) + 360) % 360;
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  return {
    r: hue2rgb(p, q, hk + 1 / 3) * 255,
    g: hue2rgb(p, q, hk) * 255,
    b: hue2rgb(p, q, hk - 1 / 3) * 255,
  };
}

export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v) => {
    const srgb = v / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToXyz({ r, g, b }) {
  const pivot = (v) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  r = pivot(r) * 100; g = pivot(g) * 100; b = pivot(b) * 100;
  return {
    x: r * 0.4124 + g * 0.3576 + b * 0.1805,
    y: r * 0.2126 + g * 0.7152 + b * 0.0722,
    z: r * 0.0193 + g * 0.1192 + b * 0.9505,
  };
}

function xyzToLab({ x, y, z }) {
  x /= 95.047; y /= 100.0; z /= 108.883;
  const f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function hexToLab(hex) {
  return xyzToLab(rgbToXyz(hexToRgb(hex)));
}

export function deltaE00(hexA, hexB) {
  const lab1 = hexToLab(hexA);
  const lab2 = hexToLab(hexB);
  const kL = 1, kC = 1, kH = 1;
  const c1 = Math.hypot(lab1.a, lab1.b);
  const c2 = Math.hypot(lab2.a, lab2.b);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt((cBar ** 7) / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * lab1.a;
  const a2p = (1 + g) * lab2.a;
  const c1p = Math.hypot(a1p, lab1.b);
  const c2p = Math.hypot(a2p, lab2.b);
  const h1p = Math.atan2(lab1.b, a1p) * 180 / Math.PI + (Math.atan2(lab1.b, a1p) < 0 ? 360 : 0);
  const h2p = Math.atan2(lab2.b, a2p) * 180 / Math.PI + (Math.atan2(lab2.b, a2p) < 0 ? 360 : 0);
  const dLp = lab2.L - lab1.L;
  const dCp = c2p - c1p;
  let dhp = h2p - h1p;
  if (c1p * c2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * Math.PI / 180);
  const lBarp = (lab1.L + lab2.L) / 2;
  const cBarp = (c1p + c2p) / 2;
  let hBarp;
  if (c1p * c2p === 0) hBarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hBarp = (h1p + h2p) / 2;
  else hBarp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  const t = 1 - 0.17 * Math.cos((hBarp - 30) * Math.PI / 180)
    + 0.24 * Math.cos((2 * hBarp) * Math.PI / 180)
    + 0.32 * Math.cos((3 * hBarp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * hBarp - 63) * Math.PI / 180);
  const dTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt((cBarp ** 7) / (cBarp ** 7 + 25 ** 7));
  const sL = 1 + (0.015 * ((lBarp - 50) ** 2)) / Math.sqrt(20 + ((lBarp - 50) ** 2));
  const sC = 1 + 0.045 * cBarp;
  const sH = 1 + 0.015 * cBarp * t;
  const rT = -Math.sin(2 * dTheta * Math.PI / 180) * rC;
  return Math.sqrt(
    (dLp / (kL * sL)) ** 2 +
    (dCp / (kC * sC)) ** 2 +
    (dHp / (kH * sH)) ** 2 +
    rT * (dCp / (kC * sC)) * (dHp / (kH * sH)),
  );
}

export function deriveDarker(hex, amount = 0.15) {
  const hsl = rgbToHsl(hexToRgb(hex));
  const delta = Math.max(0.12, Math.min(0.18, amount));
  return rgbToHex(hslToRgb({ ...hsl, l: Math.max(0, hsl.l - delta) }));
}

export async function dominantPalette(imagePath, topN = 8) {
  const sharp = await loadSharp();
  const { data, info } = await sharp(imagePath)
    .rotate()
    .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = new Map();
  let counted = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const alpha = data[i + 3];
    if (alpha < 32) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.max(r, g, b) > 245 && Math.min(r, g, b) > 235) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    bins.set(key, (bins.get(key) || 0) + 1);
    counted += 1;
  }
  return [...bins.entries()]
    .map(([key, count]) => {
      const [r, g, b] = key.split(',').map((n) => Number.parseInt(n, 10) * 16 + 8);
      return { hex: rgbToHex({ r, g, b }), population: counted ? count / counted : 0 };
    })
    .sort((a, b) => b.population - a.population)
    .slice(0, topN);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'palette') {
    if (!args[0]) throw new Error('Usage: node colors.mjs palette <img> [topN]');
    console.log(JSON.stringify(await dominantPalette(args[0], Number(args[1] || 8)), null, 2));
  } else if (cmd === 'contrast') {
    if (args.length < 2) throw new Error('Usage: node colors.mjs contrast <hex> <hex>');
    console.log(contrastRatio(args[0], args[1]).toFixed(3));
  } else if (cmd === 'deltae') {
    if (args.length < 2) throw new Error('Usage: node colors.mjs deltae <hex> <hex>');
    console.log(deltaE00(args[0], args[1]).toFixed(3));
  } else if (cmd === 'derive') {
    if (!args[0]) throw new Error('Usage: node colors.mjs derive <hex> [amount]');
    console.log(deriveDarker(args[0], args[1] ? Number(args[1]) : undefined));
  } else {
    throw new Error('Usage: node colors.mjs <palette|contrast|deltae|derive> ...');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
