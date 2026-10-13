#!/usr/bin/env node
// Review status for one run dir, shown on the hosted review site (fulfillment-reviews.vercel.app).
// Replaces the Notion review-queue entry (Travisse 2026-10-13: statuses live on the site).
//
//   review-status.mjs set --run RUN_DIR --status waiting|done [--waiting-on "<text>"] [--ease 1-5] [--by <agent>]
//   review-status.mjs get --run RUN_DIR
//
// Writes RUN_DIR/review/status.json. The checklist refresh (boostly-box-fulfillment/scripts/
// review-checklist.py) folds it into the status board and publishes it; the site build bakes it
// into the page. Never holds ship-to data or secrets. Fields not passed on `set` are kept.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--run") opt.run = argv[++i];
  else if (a === "--status") opt.status = argv[++i];
  else if (a === "--waiting-on") opt.waiting_on = argv[++i];
  else if (a === "--ease") opt.ease = argv[++i];
  else if (a === "--by") opt.by = argv[++i];
  else if (a === "--clear-waiting-on") opt.clearWaiting = true;
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}
if (!["set", "get"].includes(cmd) || !opt.run) {
  console.error('usage: review-status.mjs set --run RUN_DIR --status waiting|done [--waiting-on "..."] [--ease 1-5] [--by <agent>]\n       review-status.mjs get --run RUN_DIR');
  process.exit(2);
}
const file = path.join(path.resolve(opt.run), "review", "status.json");
const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
if (cmd === "get") { console.log(JSON.stringify(current, null, 1)); process.exit(0); }

const next = { ...current };
if (opt.status !== undefined) {
  const s = String(opt.status).toLowerCase();
  if (!["waiting", "done"].includes(s)) { console.error("status must be waiting|done"); process.exit(2); }
  next.status = s;
}
if (!next.status) { console.error("--status is required the first time"); process.exit(2); }
if (opt.waiting_on !== undefined) next.waiting_on = opt.waiting_on.trim() || null;
if (opt.clearWaiting || next.status === "done") next.waiting_on = null;
if (opt.ease !== undefined) {
  const e = Number(opt.ease);
  if (!Number.isInteger(e) || e < 1 || e > 5) { console.error("ease must be an integer 1-5"); process.exit(2); }
  next.ease = e;
}
if (opt.by) next.by = opt.by;
next.updated_at = new Date().toISOString();
if (/ship[ _-]?to|street|\d{5}(-\d{4})?\b/i.test(JSON.stringify([next.waiting_on]))) {
  console.error("waiting_on looks like it carries ship-to data; the site is public, keep it to the decision");
  process.exit(2);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(next, null, 1) + "\n");
console.log(`${file}: ${JSON.stringify(next)}`);
