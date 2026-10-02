import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

type Call = (...args: string[]) => string;
type Snapshot = { page_id: string; generated_digest: string; markdown: string };
export type ContentUpdate = { old_str: string; new_str: string; replace_all_matches?: boolean };

// Notion drops blank lines and converts bare URLs to links on readback.
export function normalizedLines(markdown: string): string[] {
  return markdown.split("\n").map(line => line.trimEnd()
    .replace(/\[(https?:\/\/[^\]]+)\]\(\1\)/g, "$1")
    .replace(/\[([a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,})\]\(https?:\/\/\1\/?\)/gi, "$1")
    .replace(/https:\/\/app\.notion\.com\/p\/[^\s)]*?([a-f0-9]{32})(?=[)\s]|$)/g, "https://app.notion.com/p/$1"))
    .filter(line => line.trim() !== "");
}

export function findGeneratedSnapshot(markdown: string, generated: string): string {
  const source = markdown.split("\n");
  const offsets = source.flatMap((line, index) => line.trim() ? [index] : []);
  const actual = normalizedLines(markdown);
  const expected = normalizedLines(generated);
  // Page creation consumes the initial H1 as the page title.
  const variants = expected[0]?.startsWith("# ") ? [expected, expected.slice(1)] : [expected];
  for (const candidate of variants) {
    const matches: Array<[number, number]> = [];
    for (let i = 0; i <= actual.length - candidate.length; i++) {
      if (candidate.every((line, j) => actual[i + j] === line)) matches.push([i, i + candidate.length - 1]);
    }
    if (matches.length > 1) throw new Error("Ambiguous generated Notion snapshot; preserve user content");
    if (matches.length === 1) return source.slice(offsets[matches[0][0]], offsets[matches[0][1]] + 1).join("\n");
  }
  throw new Error("No exact generated snapshot found; preserve page edits and reconcile before refreshing");
}

export function readMarkdown(call: Call, pageId: string): string {
  const response = JSON.parse(call("read-markdown", pageId));
  if (response.truncated || response.unknown_block_ids?.length || typeof response.markdown !== "string") {
    throw new Error("Incomplete Notion markdown readback");
  }
  return response.markdown;
}

export function patchMarkdown(call: Call, pageId: string, updates: ContentUpdate[], staging: string): void {
  if (!updates.length) return;
  const file = path.join(staging, "notion-content-updates.json");
  fs.writeFileSync(file, JSON.stringify({ type: "update_content", update_content: { content_updates: updates } }), { mode: 0o600 });
  call("patch-markdown", pageId, `@${file}`);
}

export function refreshReview(call: Call, pageId: string, generated: string, stateFile: string, staging: string): void {
  const digest = createHash("sha256").update(generated).digest("hex");
  let markdown = readMarkdown(call, pageId);
  const previous: Snapshot | undefined = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : undefined;
  if (previous && previous.page_id !== pageId) throw new Error("Notion snapshot page identity mismatch");
  if (previous && previous.generated_digest !== digest) {
    // Recover after a successful patch but interrupted local receipt write.
    let alreadyPublished = false;
    try { findGeneratedSnapshot(markdown, generated); alreadyPublished = true; } catch { /* Check the old snapshot below. */ }
    if (!alreadyPublished) {
      if (!previous.markdown || markdown.split(previous.markdown).length !== 2) {
        throw new Error("Published review was edited or is ambiguous; refusing to overwrite or append a duplicate");
      }
      patchMarkdown(call, pageId, [{ old_str: previous.markdown, new_str: generated.trim() }], staging);
      markdown = readMarkdown(call, pageId);
    }
  }
  const snapshot = findGeneratedSnapshot(markdown, generated);
  fs.writeFileSync(stateFile, JSON.stringify({ page_id: pageId, generated_digest: digest, markdown: snapshot } satisfies Snapshot, null, 2) + "\n", { mode: 0o600 });
}
