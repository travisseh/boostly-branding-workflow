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

// Drive's existing OAuth scope also authorizes the Sheets API. Write typed values
// directly: CSV conversion infers numeric ZIPs and used to turn "07940" into 7940.
// `request` is injectable so regression tests never authenticate or call Google.
export async function upsertSummarySheet(parentId, name, header, row, existingId, request = api) {
  if (header.length !== 13 || header[12] !== "Zip" || row.length !== header.length) {
    throw new Error("Unexpected print order summary columns; refusing to overwrite the sheet");
  }
  if (!row[1] || typeof row[12] !== "string") {
    throw new Error("A Drive folder key and a text postal code are required; do not guess missing leading zeroes");
  }

  let id = existingId;
  if (!id) {
    const created = await request("POST", `${API}/files?fields=id`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: SHEET_MIME, parents: [parentId] }),
    });
    id = created.id;
  }
  if (!id) throw new Error("No spreadsheet id returned");

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
  const meta = await request("GET", `${url}?fields=sheets.properties`);
  const sheet = meta.sheets?.find((s) => s.properties.title === name)?.properties
    || meta.sheets?.find((s) => s.properties.index === 0)?.properties;
  if (!sheet || sheet.sheetType !== "GRID") throw new Error("Print order summary has no grid sheet");
  const tab = `'${sheet.title.replace(/'/g, "''")}'`;
  const current = await request("GET", `${url}/values/${encodeURIComponent(`${tab}!A:M`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const rows = current.values || [];
  if (rows.length && header.some((value, i) => rows[0]?.[i] !== value)) {
    throw new Error("Print order summary header changed; refusing to overwrite existing cells");
  }
  const matches = rows.flatMap((r, i) => i > 0 && r[1] === row[1] ? [i] : []);
  if (matches.length > 1) throw new Error(`Duplicate print order summary rows for ${row[1]}`);
  const index = matches[0] ?? Math.max(rows.length, 1);
  const rowNumber = index + 1;
  if (sheet.gridProperties.columnCount < header.length) {
    throw new Error("Print order summary grid has too few columns");
  }
  if (rowNumber > sheet.gridProperties.rowCount) {
    await request("POST", `${url}:batchUpdate`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ appendDimension: {
        sheetId: sheet.sheetId, dimension: "ROWS", length: rowNumber - sheet.gridProperties.rowCount,
      } }] }),
    });
  }

  const values = rows.length ? [row] : [header, row];
  const firstRow = rows.length ? rowNumber : 1;
  const range = `${tab}!A${firstRow}:M${rowNumber}`;
  const saved = await request("PUT", `${url}/values/${encodeURIComponent(range)}?valueInputOption=RAW&includeValuesInResponse=true&responseValueRenderOption=UNFORMATTED_VALUE`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ range, majorDimension: "ROWS", values }),
  });
  // Verify stored values and their types, not display formatting. An unknown or
  // coerced write stops the handoff before its vendor-email step can run.
  const actual = saved.updatedData?.values || [];
  if (actual.length !== values.length || values.some((r, i) => r.some((value, j) => (actual[i]?.[j] ?? "") !== value))) {
    throw new Error("Print order summary readback differs from the submitted values or types");
  }
  return {
    id, webViewLink: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${sheet.sheetId}`,
    row_action: matches.length ? "updated" : "appended",
    rows: Math.max(rows.length - 1, 0) + (matches.length ? 0 : 1),
  };
}
