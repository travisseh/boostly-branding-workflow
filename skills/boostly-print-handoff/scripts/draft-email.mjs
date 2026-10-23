#!/usr/bin/env node
// Create the Gmail draft to customstickers.com from the boostly account and SEND it (Travisse 2026-10-14:
// "on the closeout now just send the email rather than creating a draft that waits on me").
// Usage: node draft-email.mjs --run-dir <dir> [--redraft] [--print-only] [--no-send] [--offline]
// --no-send leaves the draft unsent (the pre-2026-10-14 behaviour). A recorded draft that is not yet sent is sent on rerun.
// SHIP-TO GATE: no vendor email until locations.shipping_* is complete (Pig & Parrot 2026-10-15 went out with an empty
// ship-to). An incomplete ship-to exits 3 with handoff.draft = { blocked_on: 'ship-to', missing: [...] } and no draft; the
// next --live run (after the address lands) drafts and sends. --offline skips the live field read (missing from handoff facts).
// Zero quantities are stated plainly ("No table stickers in this order") instead of a bare 0.
// After a successful send the summary sheet's "Order placed (email sent)" column (N) gets the send date (vendor request,
// Gracie 2026-10-14); a sent draft whose stamp is missing (stamp failed, or sent before the column existed) is stamped on rerun.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs, requireRunDir, readRun, readHandoff, writeHandoff, handoffDir, KINDS, MASTER_REF, log, liveShipTo, shipToMissing, offerPlaceholder, ccList, senderEmail } from "./lib/common.mjs";
// lib/drive.mjs loads Google auth at import; it is imported only when a send actually gets stamped, so the
// ship-to gate and --print-only need no credentials.

export const VENDOR_TO = "ckbrandsmktg@gmail.com";
export const VENDOR_CC = ["Colin Dunn <colin@printiverse.com>", "Maren Dunn <maren@customstickers.com>"];
export const GMAIL_CLI = path.join(os.homedir(), ".config/gmail-tools/gmail.js");
// Karissa and Travisse are copied unless one of them is the sender (Travisse 2026-10-22).
const CC = ccList(VENDOR_CC, senderEmail(GMAIL_CLI));

const args = parseArgs(process.argv.slice(2));
const runDir = requireRunDir(args);
const run = readRun(runDir);
const h = readHandoff(runDir);
if (!h.drive?.folder_link) throw new Error("handoff.json has no drive block; run drive-upload.mjs first");
if (!h.sheets) throw new Error("handoff.json has no sheets block; run export-sheets.mjs first");
const f = h.facts;
const q = f.quantities || {};
const name = h.location_name || run.request?.location_name;

if (!f.ship_to_complete) {
  let missing;
  if (args.offline) missing = f.shipping ? shipToMissing(f.shipping) : f.ship_to?.length ? ["unknown (facts recorded without field detail; rerun without --offline)"] : shipToMissing(null);
  else { try { missing = shipToMissing(liveShipTo(run.request?.location_id)); } catch (e) { missing = [`unknown (live read failed: ${e.message})`]; } }
  if (!missing.length) missing = ["unknown (handoff facts say incomplete; rerun drive-upload.mjs to refresh)"];
  h.draft = { ...(h.draft?.id ? { previous_blocked: h.draft } : {}), blocked_on: "ship-to", missing, checked_at: new Date().toISOString(), sent: false };
  writeHandoff(runDir, h);
  log(JSON.stringify({ blocked_on: "ship-to", missing, location: name, hint: "no vendor email until locations.shipping_* is complete; rerun print-handoff.mjs --live after the address lands" }));
  process.exit(3);
}

// The offer printed on signage and stickers must be real copy: a placeholder ("TBD", empty with printed goods on the
// order) blocks the email the same way an incomplete ship-to does (exit 3, handoff.draft.blocked_on "offer").
{
  const ph = offerPlaceholder(f.offer_text);
  const printed = Number(q.signage || 0) + Number(q.tables || 0) + Number(q.bathroom_stalls || 0) > 0;
  if (ph && (ph !== "empty" || printed)) {
    const missing = [ph === "empty" ? "offer text is empty" : `offer text is a placeholder: "${f.offer_text}"`];
    h.draft = { ...(h.draft?.id ? { previous_blocked: h.draft } : {}), blocked_on: "offer", missing, checked_at: new Date().toISOString(), sent: false };
    writeHandoff(runDir, h);
    log(JSON.stringify({ blocked_on: "offer", missing, location: name, hint: "no vendor email until the offer is confirmed (call transcript or CSM) and set on the request; rerun print-handoff.mjs --live after" }));
    process.exit(3);
  }
}

// Zero of a unit is said plainly, never as a bare "0" the vendor has to interpret.
export function quantityLines(q) {
  const n = (v) => (v === undefined || v === null ? "?" : Number(v));
  return [
    n(q.tables) === 0 ? `- No table stickers in this order` : `- Tables: ${n(q.tables)} (one promo sticker and one review sticker per table)`,
    n(q.bathroom_stalls) === 0 ? `- No bathroom strips in this order` : `- Bathroom stalls: ${n(q.bathroom_stalls)} (one promo strip and one review strip per stall)`,
    n(q.to_go_rolls) === 0 ? `- No to-go label rolls in this order` : `- To-go label rolls: ${n(q.to_go_rolls)}`,
    `- POP sign sets: ${n(q.signage)}`,
  ];
}
const subject = `Boostly print order: ${name}`;
const body = [
  `Hi Gracie,`,
  ``,
  `Here is the next Boostly print order, for ${name}. Everything is in the Drive folder below.`,
  ``,
  `Location folder: ${h.drive.folder_link}`,
  ``,
  `Quantities:`,
  ...quantityLines(q),
  ``,
  `Offer on the signage: ${f.offer_text || "(none)"}`,
  ``,
  `Ship to:`,
  ...f.ship_to,
  ``,
  `Master folder with every Boostly order and the Boostly roll-binding logos: ${h.drive.master_link}`,
  `The "Print order summary" sheet in the master folder has this location's row with the same quantities and ship-to.`,
  ``,
  `Thanks,`,
  `Travisse`,
].join("\n");

const bodySha = crypto.createHash("sha256").update(body).digest("hex");
fs.writeFileSync(path.join(handoffDir(runDir), "draft-body.txt"), `To: ${VENDOR_TO}\nCc: ${CC.join(", ")}\nSubject: ${subject}\n\n${body}\n`);
if (args["print-only"]) { log(body); process.exit(0); }

// Stamp column N of the summary row with the send date. The send is already recorded in handoff.json,
// so a failure here never loses it; it is recorded under draft.order_placed_error and the rerun retries.
async function stampOrderDate() {
  const { stampSummaryOrderDate, orderDate } = await import("./lib/drive.mjs");
  const sheetId = h.drive?.summary?.id || (fs.existsSync(MASTER_REF) ? JSON.parse(fs.readFileSync(MASTER_REF, "utf8")).summary_sheet_id : null);
  const key = h.drive?.folder_name;
  const date = orderDate(h.draft.sent_at);
  try {
    const r = await stampSummaryOrderDate(sheetId, "Print order summary", key, date);
    h.draft.order_placed = { date, column: "N", row: r.row, range: r.range, action: r.action, previous: r.previous, sheet_id: r.id, stamped_at: new Date().toISOString() };
    delete h.draft.order_placed_error;
    writeHandoff(runDir, h);
    log(JSON.stringify({ order_placed: date, range: r.range, action: r.action }));
  } catch (e) {
    h.draft.order_placed_error = { message: e.message, at: new Date().toISOString() };
    writeHandoff(runDir, h);
    throw new Error(`vendor email sent (message ${h.draft.message_id}) but the summary sheet order date was not stamped: ${e.message}. Rerun draft-email.mjs to retry the stamp.`);
  }
}

async function sendRecordedDraft() {
  const out = execFileSync("node", [GMAIL_CLI, "drafts", "send", "boostly", h.draft.id], { encoding: "utf8" });
  const l = out.split("\n").find((x) => x.includes("draft_sent"));
  if (!l) throw new Error(`gmail.js did not report a send: ${out.slice(0, 300)}`);
  const r = JSON.parse(l);
  h.draft = { ...h.draft, sent: true, sent_at: new Date().toISOString(), message_id: r.message_id, thread_id: r.thread_id, via: "gmail.js draft + drafts send" };
  writeHandoff(runDir, h);
  log(JSON.stringify({ sent: true, draft_id: h.draft.id, message_id: r.message_id, subject: h.draft.subject }));
  await stampOrderDate();
}

if (h.draft?.blocked_on && !h.draft.id) { log(`${h.draft.blocked_on} block cleared (${h.draft.missing?.join(", ")}); drafting now`); h.draft = h.draft.previous_blocked || undefined; }
if (h.draft?.id && !args.redraft) {
  log("draft already recorded", h.draft.id, h.draft.body_sha256 === bodySha ? "(body unchanged)" : "(body differs; pass --redraft to make a new draft)");
  if (!h.draft.sent && !args["no-send"]) await sendRecordedDraft();
  else if (h.draft.sent && h.draft.sent_at && !h.draft.order_placed) await stampOrderDate();
  process.exit(0);
}
const outp = execFileSync("node", [GMAIL_CLI, "draft", "boostly", VENDOR_TO, subject, body, "--cc", CC.join(", ")], { encoding: "utf8" });
const line = outp.split("\n").find((l) => l.includes("draft_created"));
if (!line) throw new Error(`gmail.js did not report a draft: ${outp.slice(0, 300)}`);
const res = JSON.parse(line);
const prev = h.draft?.id ? [...(h.draft.previous || []), { id: h.draft.id, created_at: h.draft.created_at }] : [];
h.draft = { id: res.id, account: "boostly", to: VENDOR_TO, cc: CC, subject, body_sha256: bodySha, created_at: new Date().toISOString(), via: "gmail.js draft", sent: false, previous: prev };
writeHandoff(runDir, h);
log(JSON.stringify({ draft_id: res.id, subject }));
if (!args["no-send"]) await sendRecordedDraft();
