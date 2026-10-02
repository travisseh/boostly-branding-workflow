#!/usr/bin/env node
import fs from "node:fs";
const pageId=process.argv[2];
if(!pageId) throw new Error("usage: verify-notion-qa.mjs <page-id>");
const source=fs.readFileSync(`${process.env.HOME}/.config/notion-tools/notion-image-upload.js`,"utf8");
const token=source.match(/const BOOSTLY_TOKEN = "([^"]+)"/)?.[1];
if(!token) throw new Error("Boostly Notion credential unavailable");
const headers={Authorization:`Bearer ${token}`,"Notion-Version":"2022-06-28"};
async function children(id){let cursor;const out=[];do{const url=new URL(`https://api.notion.com/v1/blocks/${id}/children`);url.searchParams.set("page_size","100");if(cursor)url.searchParams.set("start_cursor",cursor);const res=await fetch(url,{headers});const body=await res.json();if(!res.ok)throw new Error(`Notion block read failed: ${res.status}`);out.push(...body.results);cursor=body.has_more?body.next_cursor:null;}while(cursor);return out;}
const plain=(rich=[])=>rich.map(x=>x.plain_text||x.text?.content||"").join("");
const top=await children(pageId);
const toggles=top.flatMap(block=>block.type==="toggle"?[{id:block.id,title:plain(block.toggle.rich_text)}]:block.type==="heading_2"&&block.heading_2?.is_toggleable?[{id:block.id,title:plain(block.heading_2.rich_text)}]:[]);
const results=[];
for(const toggle of toggles){const nested=await children(toggle.id);results.push({...toggle,imageCount:nested.filter(x=>x.type==="image").length,childCount:nested.length});}
console.log(JSON.stringify({pageId,toggleCount:results.length,imageCount:results.reduce((n,x)=>n+x.imageCount,0),toggles:results},null,2));
