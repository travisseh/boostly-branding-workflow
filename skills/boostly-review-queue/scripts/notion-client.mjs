// Minimal raw Notion API client for the Boostly workspace.
// Token: BOOSTLY_TOKEN inside ~/.config/notion-tools/notion-ai-ntn.sh, read at runtime, never printed.
// Uses fetch (not the ntn CLI): `ntn api` hangs inside $(...) and with --data @file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_SOURCE_ID = '33bc831c-671e-8101-a3ca-000bab91f27a';
export const DATABASE_ID = '33bc831c-671e-8137-a524-f62347485d71';
export const NOTION_VERSION = '2025-09-03';
export const RICH_TEXT_MAX = 2000;

function readToken() {
  if (process.env.NOTION_API_TOKEN) return process.env.NOTION_API_TOKEN;
  const envFile = path.join(os.homedir(), '.config/boostly-branding/.env');
  if (fs.existsSync(envFile)) {
    const e = fs.readFileSync(envFile, 'utf8').match(/^NOTION_API_TOKEN="?([^"\n]+)"?/m);
    if (e) return e[1];
  }
  const file = path.join(os.homedir(), '.config/notion-tools/notion-ai-ntn.sh');
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^BOOSTLY_TOKEN="([^"]+)"/m);
  if (!m) throw new Error(`BOOSTLY_TOKEN not found in ${file}`);
  return m[1];
}

let TOKEN;
function headers(version = NOTION_VERSION) {
  TOKEN ??= readToken();
  return { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': version, 'Content-Type': 'application/json' };
}

export async function api(method, route, body, attempt = 0) {
  const res = await fetch(`https://api.notion.com/v1${route}`, {
    method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`Notion ${method} ${route} failed ${res.status} after retries`);
    const wait = Number(res.headers.get('retry-after') || 1) * 1000 + 500 * attempt;
    await new Promise(r => setTimeout(r, wait));
    return api(method, route, body, attempt + 1);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(`Notion ${method} ${route} -> ${res.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

export async function listChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const q = `?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const j = await api('GET', `/blocks/${blockId}/children${q}`);
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}

export async function appendChildren(parentId, children, after) {
  // Notion caps one append at 100 blocks. `after` inserts following a sibling (only meaningful on the first chunk).
  const created = [];
  for (let i = 0; i < children.length; i += 100) {
    const chunk = children.slice(i, i + 100);
    const body = { children: chunk };
    if (after && i === 0) body.after = after;
    const j = await api('PATCH', `/blocks/${parentId}/children`, body);
    created.push(...j.results);
  }
  return created;
}

export function normalizeId(id) {
  const hex = String(id).replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0];
  if (!hex) throw new Error(`Not a Notion id: ${id}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- rich text helpers ----
export function text(content, opts = {}) {
  // Splits long strings into <= 2000-char rich_text items.
  const items = [];
  const s = String(content ?? '');
  if (s === '') return items;
  for (let i = 0; i < s.length; i += RICH_TEXT_MAX) {
    const item = { type: 'text', text: { content: s.slice(i, i + RICH_TEXT_MAX) } };
    if (opts.url) item.text.link = { url: opts.url };
    if (opts.bold) item.annotations = { bold: true };
    items.push(item);
  }
  return items;
}

export function plain(richText) {
  return (richText || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
}

// ---- file uploads (images) ----
// Same two-step flow as ~/.config/notion-tools/notion-image-upload.js:
// POST /file_uploads {filename, content_type}, then POST the returned upload_url as multipart with field "file".
// Tries the client's API version first and falls back to 2022-06-28 for these two calls only if that version is rejected.
const FILE_UPLOAD_FALLBACK_VERSION = '2022-06-28';

export function imageContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/png';
}

async function uploadFileWithVersion(filePath, version) {
  const filename = path.basename(filePath);
  const ctype = imageContentType(filePath);
  const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST', headers: headers(version), body: JSON.stringify({ filename, content_type: ctype }),
  });
  const created = await createRes.json();
  if (!createRes.ok) { const e = new Error(`Notion POST /file_uploads -> ${createRes.status}: ${created.message || JSON.stringify(created)}`); e.status = createRes.status; throw e; }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: ctype }), filename);
  const { 'Content-Type': _ct, ...sendHeaders } = headers(version); // let fetch set the multipart boundary
  const sendRes = await fetch(created.upload_url, { method: 'POST', headers: sendHeaders, body: form });
  const sent = await sendRes.json();
  if (!sendRes.ok) { const e = new Error(`Notion POST upload_url -> ${sendRes.status}: ${sent.message || JSON.stringify(sent)}`); e.status = sendRes.status; throw e; }
  return created.id;
}

export async function uploadFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`uploadFile: no such file ${filePath}`);
  try {
    return await uploadFileWithVersion(filePath, NOTION_VERSION);
  } catch (e) {
    if (e.status === 400 && /version/i.test(e.message)) return uploadFileWithVersion(filePath, FILE_UPLOAD_FALLBACK_VERSION);
    throw e;
  }
}

export function imageBlock(uploadId, captionRichText = []) {
  return { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: uploadId }, caption: captionRichText } };
}
