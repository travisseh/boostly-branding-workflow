#!/usr/bin/env node
// AI product mockups for a run's variant cell via the image-generator skill (gpt-image-2.5-sunburst).
// usage: node ai-mockup.mjs --run-dir RUN_DIR --letter K --scene box|scan|table|badges [--phone link-tree.png] [--ground '#263950'] [--name tag] [--quality high] [--dry-run]
// --phone: a real screenshot of the location's live link page (tp.boostly.com/<short_id>, mobile viewport); the scan scene puts it on the phone so nothing is invented.
// Writes review/mockups/<scene>-<letter>[-<name>].png, a .log with elapsed + usage, refs under review/mockups/refs/,
// and appends the prompt to review/mockups/prompts.md. Review stage only; nothing here touches production.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (!k.startsWith('--')) continue;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = v; i++; }
}
const runDir = path.resolve(a['run-dir'] || a.run || '.');
const letter = String(a.letter || '').toUpperCase();
const scene = a.scene;
if (!letter || !['box', 'scan', 'table', 'badges'].includes(scene)) {
  console.error('usage: ai-mockup.mjs --run-dir RUN_DIR --letter K --scene box|scan|table|badges [--ground #hex] [--name tag] [--quality high] [--dry-run]');
  process.exit(2);
}
const GEN = path.join(process.env.HOME, '.claude/skills/image-generator');
const sheet = JSON.parse(await fs.readFile(path.join(runDir, 'variants/variant-sheet.json'), 'utf8'));
const cell = sheet.cells?.[letter];
if (!cell) { console.error(`no cell ${letter} in variant-sheet.json`); process.exit(2); }
const offer = sheet.offer || 'Join the club!';
const business = (sheet.business_name || 'the restaurant').replace(/\s*\([^)]*\)\s*$/, '');
const primary = cell.primary || sheet.primary;
const band = cell.sticker_band || cell.secondary || primary;
const outDir = path.join(runDir, 'review/mockups');
const refDir = path.join(outDir, 'refs');
await fs.mkdir(refDir, { recursive: true });

// --- reference sheets (the generator takes a single --ref, so pieces go side by side on white) ---
const flat = async (p) => sharp(p).flatten({ background: '#ffffff' }).png().toBuffer();
async function togoCrop() {
  // to-go sticker is only rendered inside the harness shot; crop the right-hand piece
  const shot = path.join(runDir, `review/signage-preview-${letter}.png`);
  try {
    const meta = await sharp(shot).metadata();
    if (meta.width === 2544 && meta.height === 1460) return sharp(shot).extract({ left: 1660, top: 862, width: 800, height: 456 }).png().toBuffer();
    // other scales: proportional crop of the same region
    const sx = meta.width / 2544, sy = meta.height / 1460;
    return sharp(shot).extract({ left: Math.round(1660 * sx), top: Math.round(862 * sy), width: Math.round(800 * sx), height: Math.round(456 * sy) }).png().toBuffer();
  } catch { return null; }
}
// Real physical sizes (inches). The reference sheet scales every piece at PPI so the model copies the true ratio.
const PPI = 300;
// to-go strip: real print sheet is 1538x612 px (2.5:1); the harness crop is ~1.75:1, so it goes 2.5 in wide and keeps its own height (~1.43 in), about the tap card's long side
const INCH = { pop: [5, 7], sticker: [3, 3], card: [2.125, 3.375], togo: [2.5, null], phone: [2.8, null] };
const PREROTATE = { togo: -8 }; // degrees; a slight tilt so the model does not default to a flat, head-on strip

// Box-scene layout spec (Travisse-approved composition, 2026-09-21). Percentages are of the 4:5 canvas
// (width for x, height for y); angles are degrees, positive = clockwise. Tune here, the prompt and the
// reference sheet both read from this object.
const LAYOUT = {
  canvas_in: [10, 12.5],          // 4:5 portrait at PPI
  headline_top_pct: 12,           // empty band for a headline
  yaw_deg: 8,                     // shared three-quarter turn, vanishing point to the right
  pop:     { left_pct: 4,  top_pct: 12, lean_back_deg: 5 },            // left two-thirds, top margin to ~70%
  sticker: { top_pct: 30, overlap_pop_pct: 15, tilt_deg: 0 },           // upper-right third, in front of POP
  card:    { top_pct: 60, center_x_pct: 50, tilt_deg: -6 },             // lower-center, in front of both
  togo:    { top_pct: 66, gap_in: 0.35, tilt_deg: 10 },                 // lower-right of the card, in front of sticker
  draw_order: ['pop', 'sticker', 'togo', 'card'],
};
const RADIUS = { sticker: 0.08, card: 0.037, pop: 0.02, togo: 0.06 }; // fraction of the short side (sticker ~1/4in on 3in, card ~1/8in)
async function rounded(buf, frac) {
  const m = await sharp(buf).metadata();
  const r = Math.round(Math.min(m.width, m.height) * frac);
  const mask = Buffer.from(`<svg width="${m.width}" height="${m.height}"><rect x="0" y="0" width="${m.width}" height="${m.height}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
  return sharp(buf).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}
async function piece(buf, kind) {
  const raw = kind === '_togo_raw'; if (raw) kind = 'togo';
  const [wIn, hIn] = INCH[kind];
  const m = await sharp(buf).metadata();
  const w = Math.round(wIn * PPI);
  const h = hIn ? Math.round(hIn * PPI) : Math.round(m.height * w / m.width);
  let out = await sharp(buf).resize(w, h, { fit: 'fill' }).png().toBuffer();
  if (RADIUS[kind]) out = await rounded(out, RADIUS[kind]);
  if (PREROTATE[kind] && !raw) { out = await sharp(out).rotate(PREROTATE[kind], { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(); const r = await sharp(out).metadata(); return { buf: out, w: r.width, h: r.height }; }
  return { buf: out, w, h };
}
// pieces: [{buf, kind}] laid out left to right at true relative scale, bottom-aligned, on light grey (so rounded white corners read)
async function rowSheet(pieces, out, gap = 150, pad = 150) {
  const tiles = [];
  for (const p of pieces) tiles.push(await piece(p.buf, p.kind));
  const H = Math.max(...tiles.map((t) => t.h));
  const W = tiles.reduce((s, t) => s + t.w, 0) + gap * (tiles.length - 1) + 2 * pad;
  let x = pad;
  const comp = tiles.map((t) => { const c = { input: t.buf, left: x, top: pad + H - t.h }; x += t.w + gap; return c; });
  await sharp({ create: { width: W, height: H + 2 * pad, channels: 4, background: '#d9d9d9' } }).composite(comp).flatten({ background: '#d9d9d9' }).png().toFile(out);
  return out;
}

async function rotated(buf, deg) {
  if (!deg) { const m = await sharp(buf).metadata(); return { buf, w: m.width, h: m.height }; }
  const out = await sharp(buf).rotate(deg, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const m = await sharp(out).metadata(); return { buf: out, w: m.width, h: m.height };
}
// Box scene: pieces pre-placed at the LAYOUT grid positions on a 4:5 canvas, true scale, on light grey.
async function layoutSheet(byKind, out) {
  const W = Math.round(LAYOUT.canvas_in[0] * PPI), H = Math.round(LAYOUT.canvas_in[1] * PPI);
  const px = (pct, axis) => Math.round((axis === 'x' ? W : H) * pct / 100);
  const pieces = {};
  for (const [kind, buf] of Object.entries(byKind)) {
    const base = await piece(buf, kind === 'togo' ? '_togo_raw' : kind); // togo: no PREROTATE here, layout tilt applies instead
    pieces[kind] = base;
  }
  const pos = {};
  const pop = await rotated(pieces.pop.buf, 0);
  pos.pop = { ...pop, left: px(LAYOUT.pop.left_pct, 'x'), top: px(LAYOUT.pop.top_pct, 'y') };
  const st = await rotated(pieces.sticker.buf, LAYOUT.sticker.tilt_deg);
  pos.sticker = { ...st, left: pos.pop.left + pop.w - Math.round(st.w * LAYOUT.sticker.overlap_pop_pct / 100), top: px(LAYOUT.sticker.top_pct, 'y') };
  const cd = await rotated(pieces.card.buf, LAYOUT.card.tilt_deg);
  pos.card = { ...cd, left: px(LAYOUT.card.center_x_pct, 'x') - Math.round(cd.w / 2), top: px(LAYOUT.card.top_pct, 'y') };
  if (pieces.togo) {
    const tg = await rotated(pieces.togo.buf, LAYOUT.togo.tilt_deg);
    pos.togo = { ...tg, left: pos.card.left + cd.w + Math.round(LAYOUT.togo.gap_in * PPI), top: px(LAYOUT.togo.top_pct, 'y') };
  }
  const comp = LAYOUT.draw_order.filter((k) => pos[k]).map((k) => ({ input: pos[k].buf, left: Math.min(pos[k].left, W - pos[k].w), top: Math.min(pos[k].top, H - pos[k].h) }));
  await sharp({ create: { width: W, height: H, channels: 4, background: '#d9d9d9' } }).composite(comp).flatten({ background: '#d9d9d9' }).png().toFile(out);
  return out;
}
function layoutPrompt(ground) {
  const L = LAYOUT;
  return `Composition, portrait 4:5, camera slightly below center looking up, single soft key light upper-left. The four pieces float in the same three-quarter perspective, all turned about ${L.yaw_deg} degrees clockwise around the vertical axis with one shared vanishing point to the right, each casting a soft shadow on the ground below. Layout on a 3x3 grid, exactly as in the attached image: the POP sign occupies the left two-thirds from the top margin down to about 70% of the height, leaning back ${L.pop.lean_back_deg} degrees. The table sticker sits in the upper-right third, its left edge overlapping the POP's right edge by ${L.sticker.overlap_pop_pct}%, top at ${L.sticker.top_pct}% of the height, in front of the POP. The tap card hangs lower-center in front of both, top at ${L.card.top_pct}% of the height, bottom near 92%, tilted ${Math.abs(L.card.tilt_deg)} degrees ${L.card.tilt_deg < 0 ? 'counterclockwise' : 'clockwise'}. The to-go strip is lower-right, top at ${L.togo.top_pct}% of the height, to the right of the tap card, tilted ${L.togo.tilt_deg} degrees clockwise, same perspective as the others, in front of the sticker. Leave the top ${L.headline_top_pct}% empty for a headline. Ground: solid ${ground} with a subtle low-contrast texture; no logos, letters, or marks in the ground.`;
}

let ref, prompt, size = '1600x2400';
const exact = `Reproduce every asset EXACTLY as attached: same colors, same layout, the QR codes as real scannable-looking QR codes, and the wordmark reading exactly "${business}". Do not add, remove, or reword any text.`;
const ground = a.ground || band;
const groundWords = `${ground} (a deep, slightly darker shade than the assets)`;
if (scene === 'box') {
  const togo = await togoCrop();
  const byKind = { pop: await flat(cell.pop), sticker: await flat(cell.sticker), card: await flat(cell.card) };
  if (togo) byKind.togo = togo; else console.error('note: no harness shot for the to-go sticker; box composition uses three pieces');
  ref = await layoutSheet(byKind, path.join(refDir, `box-ref-${letter}.png`));
  size = '1600x2000';
  const list = togo
    ? '1) a point-of-purchase sign (5 x 7 inches), 2) a square "Join the club" table sticker (3 x 3 inches, rounded corners), 3) an employee tap card used for guest interactions (2.125 x 3.375 inches, badge size, rounded corners), 4) a to-go/packaging sticker strip (2.5 inches wide, rounded corners)'
    : '1) a point-of-purchase sign (5 x 7 inches), 2) a square "Join the club" table sticker (3 x 3 inches, rounded corners), 3) an employee tap card used for guest interactions (2.125 x 3.375 inches, badge size, rounded corners)';
  prompt = `Attached is one image showing ${togo ? 'four' : 'three'} in-store assets our company provides for restaurants, already placed in the exact positions and at the exact relative sizes we want: ${list}. Create an awesome product mockup of these assets floating on a ${groundWords} background, keeping the attached positions, sizes and overlaps exactly. The POP sign is just a large floating card, not a stand. Keep the rounded corners as shown. ${layoutPrompt(ground)} ${exact}`;
} else if (scene === 'scan') {
  if (a.phone) {
    ref = await rowSheet([{ buf: await flat(cell.sticker), kind: 'sticker' }, { buf: await flat(path.resolve(a.phone)), kind: 'phone' }], path.join(refDir, `scan-ref-${letter}.png`));
    prompt = `Attached is one image with two items side by side: 1) on the left, a square restaurant table sticker that says "Join the club!" (3 x 3 inches, rounded corners), and 2) on the right, a screenshot of the mobile web page that loads when the sticker's QR code is scanned. Compose an awesome product mockup that conveys the idea of the sticker being scanned by a phone: the sticker floats at a slight angle on the left, a modern smartphone floats on the right, drawn at true scale so the sticker is about half the phone's height, showing exactly the attached web page screenshot on its screen (same logo, same headings, same rows, same buttons; do not invent, add, or reword anything on the screen), with subtle glowing waves or ripples in the background between them. Background: ${groundWords} with a subtle patterned texture. ${exact}`;
  } else {
    console.error('note: no --phone screenshot; the phone content will be model-invented');
    ref = path.join(refDir, `sticker-${letter}.png`);
    await sharp(await rounded(await flat(cell.sticker), RADIUS.sticker)).flatten({ background: '#ffffff' }).toFile(ref);
    prompt = `Attached is a square restaurant table sticker that says "Join the club!" (3 x 3 inches, rounded corners). Compose an awesome product mockup that conveys the idea of the sticker being scanned by a phone: the sticker floats at a slight angle on the left, a modern smartphone floats on the right (the sticker about half the phone's height), with subtle glowing waves or ripples in the background between them. The phone screen shows a simple mobile web page with a ${primary} header and a few white list rows (keep the row text generic and minimal). Background: ${groundWords} with a subtle patterned texture. ${exact}`;
  }
} else if (scene === 'table') {
  ref = path.join(refDir, `sticker-${letter}.png`);
  await sharp(await flat(cell.sticker)).toFile(ref);
  size = '2048x1536';
  const setting = a.setting || 'lying flat on a light wooden pizzeria table next to a whole pepperoni pizza on a metal tray with a pizza stand, a glass of beer, and a red-and-white checkered tile wall behind. Natural window light';
  prompt = `Attached is a square restaurant table sticker. Create a photorealistic in-situ photo: the sticker ${setting}, editorial food-photography style, shot from a slightly elevated angle. ${exact}`;
} else if (scene === 'badges') {
  ref = path.join(refDir, `card-${letter}.png`);
  await sharp(await rounded(await flat(cell.card), RADIUS.card)).flatten({ background: '#ffffff' }).toFile(ref);
  prompt = `Attached is an employee tap card (2.125 x 3.375 inches, badge size, rounded corners). Create an awesome product mockup of three copies of this badge floating at perspective, slightly fanned and overlapping, on a ${groundWords} background with a subtle patterned texture. ${exact} Leave enough room at the top for a headline to be added later.`;
}

const name = `${scene}-${letter}${a.name ? '-' + a.name : ''}`;
const args = ['tsx', 'generate-image.ts', prompt, '--ref', ref, '--size', size, '--res', '2K', '--out', outDir, '--name', name];
if (a.quality) args.push('--quality', a.quality);
const cmd = `cd ${GEN} && npx ${args.map((s) => (/[\s"#()]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s)).join(' ')}`;
if (a['dry-run']) { console.log(JSON.stringify({ ref, name, size, prompt, cmd }, null, 2)); process.exit(0); }

const t0 = Date.now();
const log = [];
const code = await new Promise((resolve) => {
  const p = spawn('npx', args, { cwd: GEN, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { process.stdout.write(d); log.push(String(d)); });
  p.stderr.on('data', (d) => { process.stderr.write(d); log.push(String(d)); });
  p.on('close', resolve);
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const text = log.join('');
const usage = (text.match(/usage[^\n]*/i) || [''])[0];
await fs.writeFile(path.join(outDir, `${name}.log`), text + `\nelapsed_s ${elapsed}\n`);
const md = `\n## ${name} (${new Date().toISOString()})\n- ref: ${ref}${a.phone ? `\n- phone: ${path.resolve(a.phone)}` : ''}\n- size: ${size}${a.quality ? ` quality: ${a.quality}` : ''}\n- elapsed: ${elapsed}s exit ${code}\n- ${usage || 'usage: (not reported)'}\n- verdict: (fill in after 3x zoom check: QR intact? wordmark exact?)\n\n\`\`\`\n${prompt}\n\`\`\`\n`;
await fs.appendFile(path.join(outDir, 'prompts.md'), md);
console.log(JSON.stringify({ ok: code === 0, out: path.join(outDir, `${name}.png`), elapsed_s: Number(elapsed), usage }));
process.exit(code);
