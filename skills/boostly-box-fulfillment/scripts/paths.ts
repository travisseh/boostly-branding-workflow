// Sibling-skill paths for the fulfillment scripts. Code paths resolve relative to this file so
// the same scripts run from either skills root (~/.claude/skills is canonical; ~/.codex/skills
// is the daily mirror). Shared STATE stays at one absolute location, see below.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const V2_DB = path.join(SKILLS_ROOT, "v2-database", "bin", "v2-db");
export const BOOSTLY_LINKS_CLI = path.join(SKILLS_ROOT, "boostly-instore-link-settings", "scripts", "boostly-links");
export const DISCOVER_LINKS = path.join(SKILLS_ROOT, "boostly-link-discovery", "scripts", "discover-links.mjs");
export const VALIDATE_DISCOVERY_REPORT = path.join(SKILLS_ROOT, "boostly-link-discovery", "scripts", "validate-discovery-report.mjs");
export const MESSAGE_ME = path.join(SKILLS_ROOT, "message-me", "scripts", "message_me.py");

// Shared heartbeat state and audit. The Codex heartbeat cron still reads and writes these files
// at the ~/.codex path, and the ~/.claude copy of runs/ is only a stale mirror of it, so every
// runtime (Codex or Claude) must point at this ONE location. Do not derive it from SKILLS_ROOT.
// If the Codex heartbeat is retired, move the files once and change only this constant.
export const HEARTBEAT_RUNS_ROOT = process.env.BOOSTLY_HEARTBEAT_ROOT || "/Users/travisse/.codex/skills/boostly-link-discovery/runs";
export const HEARTBEAT_STATE_FILE = path.join(HEARTBEAT_RUNS_ROOT, "boosted-box-heartbeat-state.json");
export const HEARTBEAT_AUDIT_LOG = path.join(HEARTBEAT_RUNS_ROOT, "boosted-box-heartbeat-audit.jsonl");
export const ACCOUNT_WRITE_LOCK_DIR = path.join(HEARTBEAT_RUNS_ROOT, "account-write-locks");

// Browser providers a fulfillment discovery report may carry (mirrors discover-links.mjs).
export const FULFILLMENT_BROWSER_PROVIDERS = ["codex-extension", "claude-chrome"] as const;
export type FulfillmentBrowserProvider = (typeof FULFILLMENT_BROWSER_PROVIDERS)[number];
