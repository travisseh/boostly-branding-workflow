// Shared helpers for the customstickers.com print hand-off. Never prints secrets.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
export const REFERENCES = path.join(SKILL_DIR, "references");
export const MASTER_REF = path.join(REFERENCES, "drive-master.json");
export const ENV_FILE = process.env.BOOSTLY_BRANDING_ENV_FILE || path.join(os.homedir(), ".config/boostly-branding/.env");
export const V2DB = path.join(os.homedir(), ".claude/skills/v2-database/bin/v2-db");

// The six print units, in vendor order. Tap cards are made elsewhere and never exported here.
export const KINDS = [
  { kind: "table-stickers", label: "Table stickers (promo)" },
  { kind: "review-stickers", label: "Table stickers (review)" },
  { kind: "bathroom-stickers", label: "Bathroom strips (promo)" },
  { kind: "bathroom-review-stickers", label: "Bathroom strips (review)" },
  { kind: "pop-sign", label: "POP signs 5x7 (primary + light)" },
  { kind: "togo-label", label: "To-go labels (promo + review)" },
];

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[k] = next; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function requireRunDir(args) {
  const rd = args["run-dir"] || args._[0];
  if (!rd) throw new Error("usage: --run-dir <absolute run dir>");
  const abs = path.resolve(rd);
  if (!fs.existsSync(path.join(abs, "run.json"))) throw new Error(`no run.json in ${abs}`);
  return abs;
}

export function readRun(runDir) { return JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")); }
export function handoffDir(runDir) { const d = path.join(runDir, "print-handoff"); fs.mkdirSync(d, { recursive: true }); return d; }
export function handoffFile(runDir) { return path.join(handoffDir(runDir), "handoff.json"); }
export function readHandoff(runDir) { const f = handoffFile(runDir); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; }
export function writeHandoff(runDir, data) {
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(handoffFile(runDir), JSON.stringify(data, null, 2) + "\n");
}

export function figmaToken() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN;
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const m = env.match(/^FIGMA_TOKEN=["']?([^"'\n]+)/m);
  if (!m) throw new Error(`FIGMA_TOKEN not set (env or ${ENV_FILE})`);
  return m[1].trim();
}

export function md5File(p) { return crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex"); }
export function sha256File(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

// Figma target for the run: file key and section ids. CLI flags win; then run.json figma block.
export function figmaTarget(run, args) {
  const fig = run.figma || {};
  const fileKey = args["file-key"] || fig.file_key;
  let sections = [];
  if (args.section) sections = String(args.section).split(",").map((s) => s.trim()).filter(Boolean);
  else {
    if (fig.section_node_id) sections.push(fig.section_node_id);
    for (const k of ["extra_section_ids", "sections", "section_node_ids"]) {
      const v = fig[k];
      if (Array.isArray(v)) for (const s of v) { const id = typeof s === "string" ? s : s?.section_node_id || s?.id; if (id && !sections.includes(id)) sections.push(id); }
    }
  }
  sections = sections.map((s) => s.replace("-", ":"));
  if (!fileKey || !sections.length) throw new Error("no Figma target: pass --file-key <key> --section <id[,id]> or record run.json figma.file_key + figma.section_node_id");
  return { fileKey, sections };
}

// Live V2 reads through the read-only v2-db CLI. Output is sliced from the first "[".
export function v2Query(sql) {
  const out = execFileSync(V2DB, ["query", "--json", "--sql", sql], { encoding: "utf8", maxBuffer: 1 << 24 });
  const i = out.indexOf("[");
  if (i < 0) throw new Error(`v2-db returned no JSON array: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(i));
}

function lit(s) { return `'${String(s).replace(/'/g, "''")}'`; }

export function liveShipTo(locationId) {
  const rows = v2Query(`select name, shipping_recipient_name, shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip from locations where id = ${lit(locationId)}`);
  if (!rows.length) throw new Error(`location ${locationId} not found`);
  const r = rows[0];
  return {
    location_name: r.name,
    recipient_name: r.shipping_recipient_name, address_line1: r.shipping_address_line1, address_line2: r.shipping_address_line2,
    city: r.shipping_city, state: r.shipping_state, zip: r.shipping_zip,
    complete: !!(r.shipping_recipient_name && r.shipping_address_line1 && r.shipping_city && r.shipping_state && r.shipping_zip),
    source: "live locations row",
  };
}

export function liveQuantities(requestId) {
  const items = v2Query(`select item_type, placement, focus, quantity from fulfillment_items where fulfillment_request_id = ${lit(requestId)}`);
  const q = (type, placement, focus) => items.filter((i) => i.item_type === type && (placement === undefined || i.placement === placement) && (focus === undefined || i.focus === focus)).reduce((a, i) => a + Number(i.quantity || 0), 0);
  return {
    tap_cards: q("tapcards"),
    tables: Math.max(q("stickers", "table", "subscribe"), q("stickers", "table", "review")),
    bathroom_stalls: Math.max(q("stickers", "bathroom", "subscribe"), q("stickers", "bathroom", "review")),
    to_go_rolls: q("stickers", "to_go"),
    signage: q("signage"),
    items, source: "live fulfillment_items",
  };
}

export function liveOffer(requestId) {
  const rows = v2Query(`select offer_text, location_id from fulfillment_requests where id = ${lit(requestId)}`);
  return rows[0] || null;
}

// Request facts: live first, run.json fallback only with --offline.
export function requestFacts(run, args) {
  const req = run.request || {};
  const facts = { request_id: req.request_id, location_id: req.location_id, account_name: req.account_name, location_name: req.location_name, offer_text: req.offer_text, quantities: req.quantities, shipping: req.shipping, source: "run.json" };
  if (args.offline) return facts;
  const ship = liveShipTo(req.location_id);
  const qty = liveQuantities(req.request_id);
  const off = liveOffer(req.request_id);
  if (off && off.location_id && off.location_id !== req.location_id) throw new Error(`request ${req.request_id} is on location ${off.location_id}, run.json says ${req.location_id}`);
  return { ...facts, location_name: ship.location_name || facts.location_name, offer_text: off?.offer_text ?? facts.offer_text, quantities: qty, shipping: ship, source: "live v2-db" };
}

export function folderNameFor(facts) {
  return `${String(facts.location_name).replace(/\//g, " ").replace(/’/g, "'").trim()} - ${facts.request_id.slice(0, 8)}`;
}

export function shipLines(s) {
  const lines = [s.recipient_name, s.address_line1, s.address_line2, [s.city, s.state].filter(Boolean).join(", ") + (s.zip ? ` ${s.zip}` : "")];
  return lines.map((x) => (x || "").trim()).filter(Boolean);
}

export function log(...a) { console.log(...a); }
