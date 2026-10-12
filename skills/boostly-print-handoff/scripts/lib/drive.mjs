// Google Drive v3 helpers (boostly OAuth account via ~/.config/google-tools/auth.js). Never prints tokens.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { md5File } from "./common.mjs";

const require = createRequire(import.meta.url);
const { getOAuthAuthClient } = require(path.join(process.env.GOOGLE_TOOLS_DIR || path.join(os.homedir(), ".config", "google-tools"), "auth.js"));

export const ACCOUNT = "boostly";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const MIME = { ".png": "image/png", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".md": "text/markdown", ".json": "application/json", ".txt": "text/plain", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".csv": "text/csv" };

let tokenCache = null;
async function token() {
  if (tokenCache) return tokenCache;
  const client = await getOAuthAuthClient(ACCOUNT);
  const { token: t } = await client.getAccessToken();
  if (!t) throw new Error("no access token for boostly");
  tokenCache = t;
  return t;
}

export async function api(method, url, { body, headers = {}, raw = false } = {}, attempt = 0) {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await token()}`, ...headers }, body });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return api(method, url, { body, headers, raw }, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${url.split("?")[0]} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return raw ? res : res.json();
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
export const folderLink = (id) => `https://drive.google.com/drive/folders/${id}`;

export async function getFile(id, fields = "id,name,mimeType,trashed,webViewLink,md5Checksum") {
  return api("GET", `${API}/files/${id}?fields=${encodeURIComponent(fields)}`);
}

export async function findChild(parentId, name, mimeType) {
  let q = `name = '${esc(name)}' and '${parentId}' in parents and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;
  const j = await api("GET", `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,md5Checksum,size,webViewLink)&pageSize=10&spaces=drive`);
  return j.files[0] || null;
}

export async function ensureFolder(parentId, name) {
  const found = await findChild(parentId, name, FOLDER_MIME);
  if (found) return { ...found, action: "existing" };
  const j = await api("POST", `${API}/files?fields=id,name,webViewLink`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) });
  return { ...j, action: "created" };
}

export async function listChildren(parentId) {
  const out = [];
  let pageToken = "";
  do {
    const q = `'${parentId}' in parents and trashed = false`;
    const j = await api("GET", `${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,md5Checksum,size,webViewLink)&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`);
    out.push(...j.files);
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

// Upload one file. Same name + same md5 -> skipped; same name, different bytes -> content updated in place.
export async function uploadFile(parentId, localPath, name = path.basename(localPath), existing) {
  const mime = MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
  const data = fs.readFileSync(localPath);
  const localMd5 = md5File(localPath);
  const found = existing === undefined ? await findChild(parentId, name) : existing;
  if (found && found.md5Checksum === localMd5) return { id: found.id, name, md5Checksum: localMd5, webViewLink: found.webViewLink, action: "skipped" };
  const meta = { name, mimeType: mime };
  if (!found) meta.parents = [parentId];
  const boundary = "boostly_" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    data, Buffer.from(`\r\n--${boundary}--`),
  ]);
  const url = found ? `${UPLOAD}/files/${found.id}?uploadType=multipart&fields=id,name,md5Checksum,webViewLink` : `${UPLOAD}/files?uploadType=multipart&fields=id,name,md5Checksum,webViewLink`;
  const j = await api(found ? "PATCH" : "POST", url, { headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  if (j.md5Checksum !== localMd5) throw new Error(`md5 mismatch after upload for ${name}`);
  return { ...j, action: found ? "updated" : "created" };
}

export async function uploadDir(parentId, localDir, filter = () => true) {
  const byName = Object.fromEntries((await listChildren(parentId)).map((f) => [f.name, f]));
  const results = [];
  for (const f of fs.readdirSync(localDir).sort()) {
    const p = path.join(localDir, f);
    if (!fs.statSync(p).isFile() || !filter(f)) continue;
    results.push(await uploadFile(parentId, p, f, byName[f] || null));
  }
  return results;
}

export async function copyFile(fileId, parentId, name) {
  return api("POST", `${API}/files/${fileId}/copy?fields=id,name,md5Checksum,webViewLink`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, parents: [parentId] }) });
}

export async function shareAnyoneReader(fileId) {
  const meta = await api("GET", `${API}/files/${fileId}?fields=permissions(id,type,role)`);
  if ((meta.permissions || []).some((p) => p.type === "anyone")) return { action: "existing" };
  await api("POST", `${API}/files/${fileId}/permissions`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "reader", type: "anyone", allowFileDiscovery: false }) });
  return { action: "created" };
}

// Google Sheet maintained from CSV text: export the current sheet as CSV, merge, re-upload with conversion.
export async function exportSheetCsv(fileId) {
  const res = await api("GET", `${API}/files/${fileId}/export?mimeType=text/csv`, { raw: true });
  return res.text();
}

export async function uploadCsvAsSheet(parentId, name, csvText, existingId) {
  const meta = { name, mimeType: SHEET_MIME };
  if (!existingId) meta.parents = [parentId];
  const boundary = "boostly_" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(csvText, "utf8"), Buffer.from(`\r\n--${boundary}--`),
  ]);
  const url = existingId ? `${UPLOAD}/files/${existingId}?uploadType=multipart&fields=id,name,webViewLink` : `${UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`;
  return api(existingId ? "PATCH" : "POST", url, { headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
}

// Minimal RFC 4180 CSV.
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ""));
}
export function toCsv(rows) {
  const enc = (v) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map((r) => r.map(enc).join(",")).join("\r\n") + "\r\n";
}
