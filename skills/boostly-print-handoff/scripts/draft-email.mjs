#!/usr/bin/env node
// Create the Gmail DRAFT (never sends) to customstickers.com from the boostly account.
// Usage: node draft-email.mjs --run-dir <dir> [--redraft] [--print-only]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs, requireRunDir, readRun, readHandoff, writeHandoff, handoffDir, KINDS, log } from "./lib/common.mjs";

export const VENDOR_TO = "ckbrandsmktg@gmail.com";
export const VENDOR_CC = ["Colin Dunn <colin@printiverse.com>", "Maren Dunn <maren@customstickers.com>"];
export const GMAIL_CLI = path.join(process.env.GMAIL_TOOLS_DIR || path.join(os.homedir(), ".config/gmail-tools"), "gmail.js");

const args = parseArgs(process.argv.slice(2));
const runDir = requireRunDir(args);
const run = readRun(runDir);
const h = readHandoff(runDir);
if (!h.drive?.folder_link) throw new Error("handoff.json has no drive block; run drive-upload.mjs first");
if (!h.sheets) throw new Error("handoff.json has no sheets block; run export-sheets.mjs first");
const f = h.facts;
const q = f.quantities || {};
const name = h.location_name || run.request?.location_name;

const pdfLine = (kind) => { const s = h.sheets[kind]; return s ? `${s.pages} page${s.pages === 1 ? "" : "s"}` : "not included"; };
const subject = `Boostly print order: ${name}`;
const body = [
  `Hi Gracie,`,
  ``,
  `Here is the next Boostly print order, for ${name}. Everything is in the Drive folder below as vector PDFs exported straight from Figma (text and QR codes are live vectors, logos are embedded images).`,
  ``,
  `Location folder: ${h.drive.folder_link}`,
  ``,
  `What is in it:`,
  `- table-stickers.pdf: table stickers, promo (${pdfLine("table-stickers")})`,
  `- review-stickers.pdf: table stickers, review (${pdfLine("review-stickers")})`,
  `- bathroom-stickers.pdf: bathroom strips, promo (${pdfLine("bathroom-stickers")})`,
  `- bathroom-review-stickers.pdf: bathroom strips, review (${pdfLine("bathroom-review-stickers")})`,
  `- pop-sign.pdf: POP signs 5x7, primary and light (${pdfLine("pop-sign")})`,
  `- togo-label.pdf: to-go labels, promo and review (${pdfLine("togo-label")})`,
  `- logos/: the location's card logo and sticker logo`,
  ``,
  `Quantities:`,
  `- Tables: ${q.tables ?? "?"} (one promo sticker and one review sticker per table)`,
  `- Bathroom stalls: ${q.bathroom_stalls ?? "?"} (one promo strip and one review strip per stall)`,
  `- To-go label rolls: ${q.to_go_rolls ?? "?"}`,
  `- POP sign sets: ${q.signage ?? "?"}`,
  ``,
  `Offer on the signage: ${f.offer_text || "(none)"}`,
  ``,
  `Ship to:`,
  ...(f.ship_to?.length ? f.ship_to : ["(ship-to not on file yet, I will send it separately)"]),
  ``,
  `Master folder with every Boostly order and the Boostly roll-binding logos: ${h.drive.master_link}`,
  `The "Print order summary" sheet in the master folder has this location's row with the same quantities and ship-to.`,
  ``,
  `Let me know if anything in the files needs a tweak before it goes to print.`,
  ``,
  `Thanks,`,
  `Travisse`,
].join("\n");

const bodySha = crypto.createHash("sha256").update(body).digest("hex");
fs.writeFileSync(path.join(handoffDir(runDir), "draft-body.txt"), `To: ${VENDOR_TO}\nCc: ${VENDOR_CC.join(", ")}\nSubject: ${subject}\n\n${body}\n`);
if (args["print-only"]) { log(body); process.exit(0); }

if (h.draft?.id && !args.redraft) {
  log("draft already recorded", h.draft.id, h.draft.body_sha256 === bodySha ? "(body unchanged)" : "(body differs; pass --redraft to make a new draft)");
  process.exit(0);
}
const outp = execFileSync("node", [GMAIL_CLI, "draft", "boostly", VENDOR_TO, subject, body, "--cc", VENDOR_CC.join(", ")], { encoding: "utf8" });
const line = outp.split("\n").find((l) => l.includes("draft_created"));
if (!line) throw new Error(`gmail.js did not report a draft: ${outp.slice(0, 300)}`);
const res = JSON.parse(line);
const prev = h.draft?.id ? [...(h.draft.previous || []), { id: h.draft.id, created_at: h.draft.created_at }] : [];
h.draft = { id: res.id, account: "boostly", to: VENDOR_TO, cc: VENDOR_CC, subject, body_sha256: bodySha, created_at: new Date().toISOString(), via: "gmail.js draft", sent: false, previous: prev };
writeHandoff(runDir, h);
log(JSON.stringify({ draft_id: res.id, subject }));
