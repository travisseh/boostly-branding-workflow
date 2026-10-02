#!/usr/bin/env node
import fs from "node:fs";
const pageId = process.argv[2];
if (!pageId) throw new Error("usage: list-notion-toggles.mjs <page-id>");
const uploader = fs.readFileSync(`${process.env.HOME}/.config/notion-tools/notion-image-upload.js`, "utf8");
const token = uploader.match(/const BOOSTLY_TOKEN = "([^"]+)"/)?.[1];
if (!token) throw new Error("Boostly Notion credential unavailable");
const headers = { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" };
let cursor; const blocks = [];
do {
  const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
  url.searchParams.set("page_size", "100");
  if (cursor) url.searchParams.set("start_cursor", cursor);
  const res = await fetch(url, { headers });
  const body = await res.json();
  if (!res.ok) throw new Error(`Notion block read failed: ${res.status}`);
  blocks.push(...body.results); cursor = body.has_more ? body.next_cursor : null;
} while (cursor);
const plain = (rich = []) => rich.map((part) => part.plain_text || part.text?.content || "").join("");
const toggles = blocks.flatMap((block) => {
  if (block.type === "toggle") return [{ id: block.id, title: plain(block.toggle.rich_text), type: block.type }];
  if (block.type === "heading_2" && block.heading_2?.is_toggleable) {
    return [{ id: block.id, title: plain(block.heading_2.rich_text), type: block.type }];
  }
  return [];
});
console.log(JSON.stringify({ pageId, toggles }, null, 2));
