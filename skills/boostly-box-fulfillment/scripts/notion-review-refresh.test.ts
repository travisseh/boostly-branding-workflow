import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findGeneratedSnapshot, refreshReview } from "./notion-review-refresh.ts";

test("locates only the exact generated snapshot, allowing Notion URL rendering", () => {
  assert.equal(findGeneratedSnapshot("User note\n## Result\n- https://example.com\nOther note", "# Title\n\n## Result\n- https://example.com\n"), "## Result\n- https://example.com");
  assert.equal(findGeneratedSnapshot("## Result\n- [https://example.com](https://example.com)", "## Result\n\n- https://example.com"), "## Result\n- [https://example.com](https://example.com)");
  assert.throws(() => findGeneratedSnapshot("## Result\nEdited", "## Result\nOriginal"), /No exact/);
  assert.throws(() => findGeneratedSnapshot("Result\nResult", "Result"), /Ambiguous/);
  assert.equal(findGeneratedSnapshot("[Evidence](https://app.notion.com/p/123456789012345678901234567890ab)", "[Evidence](https://app.notion.com/p/Title-123456789012345678901234567890ab)"), "[Evidence](https://app.notion.com/p/123456789012345678901234567890ab)");
});

test("allows bare-domain autolinks but rejects changed destinations", () => {
  const rendered = "A shared [facebook.com](http://facebook.com) domain is not identity evidence.";
  assert.equal(findGeneratedSnapshot(rendered, "A shared facebook.com domain is not identity evidence."), rendered);
  assert.throws(() => findGeneratedSnapshot("[facebook.com](https://other.example)", "facebook.com"), /No exact/);
  assert.throws(() => findGeneratedSnapshot("[facebook.com](https://facebook.com/changed)", "facebook.com"), /No exact/);
});

test("refresh replaces the previous snapshot, preserves notes, is idempotent, and rejects edits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-refresh-test-"));
  try {
    let markdown = "User note\n## Current Result 1\nOld content\nAnother note";
    let writes = 0;
    const call = (command: string, _id: string, file?: string) => {
      if (command === "read-markdown") return JSON.stringify({ markdown, truncated: false, unknown_block_ids: [] });
      assert.equal(command, "patch-markdown");
      writes++;
      const body = JSON.parse(fs.readFileSync(file!.slice(1), "utf8"));
      for (const update of body.update_content.content_updates) markdown = markdown.replace(update.old_str, update.new_str);
      return "{}";
    };
    const state = path.join(dir, "snapshot.json");
    refreshReview(call, "page", "## Current Result 1\nOld content", state, dir);
    refreshReview(call, "page", "## Current Result 2\nNew content", state, dir);
    refreshReview(call, "page", "## Current Result 2\nNew content", state, dir);
    assert.equal(writes, 1);
    assert.equal(markdown, "User note\n## Current Result 2\nNew content\nAnother note");
    markdown = markdown.replace("New content", "User edited content");
    assert.throws(() => refreshReview(call, "page", "## Current Result 3\nThird content", state, dir), /edited/);
    assert.equal(writes, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a legacy page cannot silently accumulate another snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-refresh-test-"));
  try {
    const call = (command: string) => {
      assert.equal(command, "read-markdown");
      return JSON.stringify({ markdown: "Old snapshot with user edits", truncated: false });
    };
    assert.throws(() => refreshReview(call, "page", "New snapshot", path.join(dir, "state.json"), dir), /No exact/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
