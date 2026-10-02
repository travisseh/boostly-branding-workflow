import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ACCOUNT_WRITE_LOCK_DIR,
  BOOSTLY_LINKS_CLI,
  DISCOVER_LINKS,
  HEARTBEAT_AUDIT_LOG,
  HEARTBEAT_RUNS_ROOT,
  HEARTBEAT_STATE_FILE,
  MESSAGE_ME,
  SKILLS_ROOT,
  V2_DB,
  VALIDATE_DISCOVERY_REPORT,
} from "./paths.ts";

test("sibling-skill code paths resolve relative to this skills root and exist", () => {
  assert.equal(SKILLS_ROOT, path.resolve(import.meta.dirname, "..", ".."));
  for (const file of [V2_DB, BOOSTLY_LINKS_CLI, DISCOVER_LINKS, VALIDATE_DISCOVERY_REPORT, MESSAGE_ME]) {
    assert.ok(file.startsWith(SKILLS_ROOT), file);
    assert.ok(fs.existsSync(file), `missing sibling skill file ${file}`);
  }
});

test("shared heartbeat state stays at the single ~/.codex location the Codex heartbeat uses", () => {
  assert.equal(HEARTBEAT_RUNS_ROOT, process.env.BOOSTLY_HEARTBEAT_ROOT || "/Users/travisse/.codex/skills/boostly-link-discovery/runs");
  assert.equal(HEARTBEAT_STATE_FILE, path.join(HEARTBEAT_RUNS_ROOT, "boosted-box-heartbeat-state.json"));
  assert.equal(HEARTBEAT_AUDIT_LOG, path.join(HEARTBEAT_RUNS_ROOT, "boosted-box-heartbeat-audit.jsonl"));
  assert.equal(ACCOUNT_WRITE_LOCK_DIR, path.join(HEARTBEAT_RUNS_ROOT, "account-write-locks"));
});
