#!/usr/bin/env node
// notion-ai-ntn.sh (boostly-branding-workflow shim)
//
// Drop-in replacement for the private ~/.config/notion-tools/notion-ai-ntn.sh wrapper that the
// notion-boostly, boostly-box-fulfillment, and boostly-review-queue skills call. The original
// embeds its token inline; this one reads NOTION_API_TOKEN from the environment or from
// ~/.config/boostly-branding/.env and talks to the Notion REST API directly (no `ntn` CLI).
//
// Usage (the --workspace flag is accepted and ignored; this shim is Boostly-only):
//   notion-ai-ntn.sh --workspace boostly whoami
//   notion-ai-ntn.sh --workspace boostly search "query" [page|database]
//   notion-ai-ntn.sh --workspace boostly read <pageId>
//   notion-ai-ntn.sh --workspace boostly create-page <parentPageId> [content|@file|-]
//   notion-ai-ntn.sh --workspace boostly edit <pageId> [content|@file|-]        (replaces the body)
//   notion-ai-ntn.sh --workspace boostly append <pageId> [content|@file|-]
//   notion-ai-ntn.sh --workspace boostly create "Title" "Category" [content|@file|-]
//     (entry in the Boostly "Travisse AI Output" database; Category: research | prds | marketing)
//
// Markdown supported: # ## ### headings, - * bullets, 1. numbered, [ ] / [x] todos, > quote,
// ---, | tables |, inline **bold** *italic* `code` [text](url). Fenced code blocks become code
// blocks. Never prints the token.

// CommonJS on purpose: the file keeps the .sh name the skills call, and Node loads unknown extensions as CommonJS.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NOTION_VERSION = "2022-06-28";
const AI_OUTPUT_DATABASE_ID = "33bc831c-671e-8137-a524-f62347485d71";
const RICH_TEXT_MAX = 2000;

function readToken() {
  if (process.env.NOTION_API_TOKEN) return process.env.NOTION_API_TOKEN;
  const envFile = process.env.BOOSTLY_BRANDING_ENV_FILE || path.join(os.homedir(), ".config/boostly-branding/.env");
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/^NOTION_API_TOKEN="?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  }
  throw new Error("NOTION_API_TOKEN is not set (environment or ~/.config/boostly-branding/.env).");
}

async function api(method, route, body) {
  const res = await fetch(`https://api.notion.com/v1${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${readToken()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${method} ${route} -> ${res.status}: ${json.message || JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ---------------------------------------------------------------- markdown -> blocks
function inline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(rt(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(rt(tok.slice(2, -2), { bold: true }));
    else if (tok.startsWith("`")) out.push(rt(tok.slice(1, -1), { code: true }));
    else if (tok.startsWith("*")) out.push(rt(tok.slice(1, -1), { italic: true }));
    else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(rt(lm[1], {}, lm[2]));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(rt(text.slice(last)));
  return out.length ? out : [rt("")];
}
function rt(content, annotations = {}, link = null) {
  const chunks = [];
  for (let i = 0; i < Math.max(content.length, 1); i += RICH_TEXT_MAX) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + RICH_TEXT_MAX), link: link ? { url: link } : null }, annotations });
  }
  return chunks.length === 1 ? chunks[0] : chunks;
}
function flat(list) { return list.flat(); }

function markdownToBlocks(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let m;
    if (line.startsWith("```")) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i += 1; }
      blocks.push({ object: "block", type: "code", code: { language: "plain text", rich_text: flat([rt(code.join("\n"))]) } });
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [];
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      rows.push(cells(line));
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(cells(lines[i])); i += 1; }
      i -= 1;
      const width = Math.max(...rows.map((r) => r.length));
      blocks.push({
        object: "block", type: "table",
        table: {
          table_width: width, has_column_header: true, has_row_header: false,
          children: rows.map((r) => ({ object: "block", type: "table_row", table_row: { cells: Array.from({ length: width }, (_, c) => flat([inline(r[c] || "")])) } })),
        },
      });
      continue;
    }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const t = `heading_${m[1].length}`;
      blocks.push({ object: "block", type: t, [t]: { rich_text: flat(inline(m[2])) } });
    } else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      blocks.push({ object: "block", type: "to_do", to_do: { rich_text: flat(inline(m[2])), checked: m[1].toLowerCase() === "x" } });
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: flat(inline(m[1])) } });
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: flat(inline(m[1])) } });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push({ object: "block", type: "quote", quote: { rich_text: flat(inline(m[1])) } });
    } else if (/^-{3,}\s*$/.test(line)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else {
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: flat(inline(line)) } });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------- blocks -> markdown
function richToMd(list = []) {
  return list.map((t) => {
    let s = t.plain_text || "";
    const a = t.annotations || {};
    if (a.code) s = `\`${s}\``;
    if (a.bold) s = `**${s}**`;
    if (a.italic) s = `*${s}*`;
    if (t.href) s = `[${s}](${t.href})`;
    return s;
  }).join("");
}
async function listChildren(id) {
  const out = [];
  let cursor;
  do {
    const page = await api("GET", `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}
async function blocksToMd(id, depth = 0) {
  const lines = [];
  const pad = "  ".repeat(depth);
  for (const b of await listChildren(id)) {
    const t = b.type;
    const v = b[t] || {};
    const text = richToMd(v.rich_text);
    if (t === "heading_1") lines.push(`# ${text}`);
    else if (t === "heading_2") lines.push(`## ${text}`);
    else if (t === "heading_3") lines.push(`### ${text}`);
    else if (t === "bulleted_list_item") lines.push(`${pad}- ${text}`);
    else if (t === "numbered_list_item") lines.push(`${pad}1. ${text}`);
    else if (t === "to_do") lines.push(`${pad}- [${v.checked ? "x" : " "}] ${text}`);
    else if (t === "quote") lines.push(`> ${text}`);
    else if (t === "divider") lines.push("---");
    else if (t === "code") lines.push("```", text, "```");
    else if (t === "toggle") lines.push(`${pad}- ${text}  <!-- toggle ${b.id} -->`);
    else if (t === "table") {
      const rows = await listChildren(b.id);
      rows.forEach((r, i) => {
        const cells = (r.table_row?.cells || []).map((c) => richToMd(c));
        lines.push(`| ${cells.join(" | ")} |`);
        if (i === 0) lines.push(`|${cells.map(() => "---").join("|")}|`);
      });
      lines.push(`<!-- table ${b.id} -->`);
      continue;
    } else if (t === "child_page") lines.push(`${pad}- [child page] ${v.title} (${b.id})`);
    else if (t === "image") lines.push(`![image](${v.file?.url || v.external?.url || ""})`);
    else if (text) lines.push(`${pad}${text}`);
    if (b.has_children && t !== "table" && t !== "child_page") lines.push(await blocksToMd(b.id, depth + 1));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- commands
function readContent(arg) {
  if (arg === undefined) return "";
  if (arg === "-") return fs.readFileSync(0, "utf8");
  if (arg.startsWith("@")) return fs.readFileSync(arg.slice(1), "utf8");
  return arg;
}
async function appendBlocks(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await api("PATCH", `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
  }
}
function pageTitle(p) {
  const prop = Object.values(p.properties || {}).find((x) => x.type === "title");
  return richToMd(prop?.title || []) || "(untitled)";
}

async function main() {
  const argv = process.argv.slice(2);
  const wi = argv.indexOf("--workspace");
  if (wi >= 0) argv.splice(wi, 2);
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "whoami": {
      const me = await api("GET", "/users/me");
      console.log(JSON.stringify({ id: me.id, name: me.name, type: me.type, bot_owner: me.bot?.owner?.type }, null, 2));
      return;
    }
    case "search": {
      const [query, kind] = rest;
      const body = { query: query || "", page_size: 25 };
      if (kind === "page" || kind === "database") body.filter = { property: "object", value: kind };
      const r = await api("POST", "/search", body);
      console.log(JSON.stringify(r.results.map((p) => ({ id: p.id, object: p.object, title: p.object === "database" ? richToMd(p.title) : pageTitle(p), url: p.url })), null, 2));
      return;
    }
    case "read": {
      const [id] = rest;
      if (!id) throw new Error("read <pageId>");
      const page = await api("GET", `/pages/${id}`);
      const props = Object.entries(page.properties || {}).map(([k, v]) => {
        const val = v.type === "title" ? richToMd(v.title) : v.type === "select" ? v.select?.name : v.type === "rich_text" ? richToMd(v.rich_text) : null;
        return val ? `${k}: ${val}` : null;
      }).filter(Boolean);
      console.log(`---\n${props.join("\n")}\n---\n`);
      console.log(await blocksToMd(id));
      return;
    }
    case "create-page": {
      const [parent, content] = rest;
      if (!parent) throw new Error("create-page <parentPageId> [content|@file|-]");
      const md = readContent(content);
      const blocks = markdownToBlocks(md);
      const first = blocks[0];
      let title = "Untitled";
      if (first && first.type.startsWith("heading")) { title = richToMd(first[first.type].rich_text.map((t) => ({ plain_text: t.text.content }))); blocks.shift(); }
      const page = await api("POST", "/pages", { parent: { page_id: parent }, properties: { title: { title: [{ type: "text", text: { content: title } }] } }, children: blocks.slice(0, 100) });
      if (blocks.length > 100) await appendBlocks(page.id, blocks.slice(100));
      console.log(JSON.stringify({ id: page.id, url: page.url }));
      return;
    }
    case "edit": {
      const [id, content] = rest;
      if (!id) throw new Error("edit <pageId> [content|@file|-]");
      const existing = await listChildren(id);
      for (const b of existing) {
        if (b.type === "child_page" || b.type === "child_database") continue;
        await api("DELETE", `/blocks/${b.id}`);
      }
      await appendBlocks(id, markdownToBlocks(readContent(content)));
      console.log(JSON.stringify({ id, replaced_blocks: existing.length }));
      return;
    }
    case "append": {
      const [id, content] = rest;
      if (!id) throw new Error("append <pageId> [content|@file|-]");
      const blocks = markdownToBlocks(readContent(content));
      await appendBlocks(id, blocks);
      console.log(JSON.stringify({ id, appended_blocks: blocks.length }));
      return;
    }
    case "create": {
      const [title, category, content] = rest;
      if (!title || !category) throw new Error('create "Title" "Category" [content|@file|-]');
      const blocks = markdownToBlocks(readContent(content));
      const page = await api("POST", "/pages", {
        parent: { database_id: process.env.NOTION_AI_OUTPUT_DATABASE_ID || AI_OUTPUT_DATABASE_ID },
        properties: { Name: { title: [{ type: "text", text: { content: title } }] }, Category: { select: { name: category } } },
        children: blocks.slice(0, 100),
      });
      if (blocks.length > 100) await appendBlocks(page.id, blocks.slice(100));
      console.log(JSON.stringify({ id: page.id, url: page.url }));
      return;
    }
    default:
      console.error("usage: notion-ai-ntn.sh [--workspace boostly] whoami | search <q> [page|database] | read <id> | create-page <parent> [content] | edit <id> [content] | append <id> [content] | create <title> <category> [content]");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
