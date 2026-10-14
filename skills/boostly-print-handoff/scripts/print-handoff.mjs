#!/usr/bin/env node
// One command for the whole hand-off: export (vector PDFs), logos + Drive upload + summary row, Gmail draft.
// Usage: node print-handoff.mjs --run-dir <dir> [--section <id[,id]>] [--file-key <key>] [--offline] [--redraft] [--skip-export] [--skip-draft] [--no-send] [--force] [--kinds <kind[,kind]>]
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, requireRunDir, readHandoff } from "./lib/common.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const runDir = requireRunDir(args);
const pass = (keys) => keys.flatMap((k) => (args[k] === undefined ? [] : args[k] === true ? [`--${k}`] : [`--${k}`, String(args[k])]));
const step = (script, extra) => {
  console.log(`\n== ${script} ==`);
  execFileSync("node", [path.join(here, script), "--run-dir", runDir, ...extra], { stdio: "inherit" });
};
if (!args["skip-export"]) step("export-sheets.mjs", pass(["section", "file-key", "force", "kinds"]));
step("drive-upload.mjs", pass(["offline", "skip-summary"]));
if (!args["skip-draft"]) step("draft-email.mjs", pass(["redraft", "no-send"]));
const h = readHandoff(runDir);
console.log("\n== hand-off ==");
console.log(JSON.stringify({
  location: h.location_name,
  folder: h.drive?.folder_link,
  master: h.drive?.master_link,
  summary: h.drive?.summary?.link,
  pages: Object.fromEntries(Object.entries(h.sheets || {}).map(([k, v]) => [k, `${v.pages}/${v.expected_pages}${v.vector ? " vector" : " NOT VECTOR"}`])),
  draft_id: h.draft?.id || null,
  email_sent: !!h.draft?.sent,
  message_id: h.draft?.message_id || null,
  order_placed: h.draft?.order_placed?.date || null,
}, null, 2));
