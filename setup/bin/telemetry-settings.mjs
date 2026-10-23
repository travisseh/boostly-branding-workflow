#!/usr/bin/env node
// Merge (or remove) the Claude Code OpenTelemetry block in a settings.json (2026-10-21). Used by setup.sh.
//
//   node telemetry-settings.mjs --settings ~/.claude/settings.json --helper PATH --operator karissa \
//        --version <git sha> [--domain us-east-1.aws.edge.axiom.co] [--host NAME] [--remove] [--check] [--dry-run]
//
// Merge, never clobber: only the keys in TELEMETRY_ENV, the content-gate keys in FORBIDDEN, and otelHeadersHelper
// are touched; every other key and env entry is kept as is. A backup is written next to the file before any change.
// No secrets: the Axiom token is never in settings.json; otelHeadersHelper (otel-headers.sh) reads it from the env
// file at Claude Code startup. --check exits 0 when the file already matches, 1 when it would change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, "");
  if (["remove", "check", "dry-run"].includes(k)) opt[k] = true; else opt[k] = args[++i];
}
const die = (m) => { console.error(`telemetry-settings: ${m}`); process.exit(2); };
if (!opt.settings) die("--settings is required");
// Attribute values go into OTEL_RESOURCE_ATTRIBUTES (comma/equals separated): keep them to a safe charset.
const safe = (v, label) => { const s = String(v ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "-"); if (!s) die(`empty ${label}`); return s; };

// Prompt, response, tool-argument, tool-output and raw-body logging stay off. Claude Code treats any of these
// as enabled when set, so they are removed rather than set to 0.
export const FORBIDDEN = ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES"];

function telemetryEnv() {
  const domain = safe(opt.domain || "us-east-1.aws.edge.axiom.co", "domain");
  const attrs = {
    operator: safe(opt.operator, "operator"),
    "host.name": safe(opt.host || os.hostname().split(".")[0], "host"),
    "service.namespace": "boostly-fulfillment",
    "boostly.package.version": safe(opt.version || "unknown", "version"),
  };
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `https://${domain}/v1/logs`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `https://${domain}/v1/metrics`,
    OTEL_METRIC_EXPORT_INTERVAL: "60000",
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
    OTEL_METRICS_INCLUDE_VERSION: "true",
    OTEL_RESOURCE_ATTRIBUTES: Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(","),
  };
}
const TELEMETRY_KEYS = ["CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_METRIC_EXPORT_INTERVAL", "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_METRICS_INCLUDE_VERSION", "OTEL_RESOURCE_ATTRIBUTES"];

const file = opt.settings.replace(/^~(?=\/)/, os.homedir());
const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}\n";
let s;
try { s = JSON.parse(before); } catch (e) { die(`${file} is not valid JSON (${e.message}); fix it by hand, nothing written`); }
s.env = s.env && typeof s.env === "object" ? s.env : {};
const removed = [];
for (const k of FORBIDDEN) if (k in s.env) { removed.push(k); delete s.env[k]; }
if (opt.remove) {
  for (const k of TELEMETRY_KEYS) delete s.env[k];
  delete s.otelHeadersHelper;
} else {
  if (!opt.helper) die("--helper is required");
  Object.assign(s.env, telemetryEnv());
  s.otelHeadersHelper = opt.helper.replace(/^~(?=\/)/, os.homedir());
}
const after = JSON.stringify(s, null, 2) + "\n";
const changed = after !== before;
if (removed.length) console.log(`telemetry-settings: removed content-logging keys ${removed.join(", ")} (prompts and tool arguments stay off)`);
if (opt.check) { console.log(changed ? "telemetry-settings: would change" : "telemetry-settings: up to date"); process.exit(changed ? 1 : 0); }
if (!changed) { console.log("telemetry-settings: up to date"); process.exit(0); }
if (opt["dry-run"]) { process.stdout.write(after); process.exit(0); }
fs.mkdirSync(path.dirname(file), { recursive: true });
if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-telemetry-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, after); fs.renameSync(tmp, file);
JSON.parse(fs.readFileSync(file, "utf8"));
console.log(`telemetry-settings: ${opt.remove ? "removed telemetry from" : "merged telemetry into"} ${file}`);
