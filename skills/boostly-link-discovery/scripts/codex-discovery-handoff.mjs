#!/usr/bin/env node
// Codex handoff for fulfillment link discovery (added 2026-09-29).
//
// A Claude session (or Travisse, from a terminal) runs this script. It starts ONE non-interactive
// Codex session that reads pages through the Codex Chrome extension in the Boostly.com profile
// and writes the discovery report. Codex is transport only: it makes no verdicts and no
// production writes. The Claude lead keeps ready/hold/reject, the write gate, and link writes.
//
//   node codex-discovery-handoff.mjs --run-dir <run_dir> --location-id <id>
//     [--out <file>]          default <run_dir>/link-discovery-report.json
//     [--overwrite]           allow replacing an existing --out file (a backup copy is kept)
//     [--no-cache]            skip the shared evidence cache (read every page live)
//     [--effort medium]       Codex reasoning effort; the model comes from ~/.codex/config.toml
//     [--timeout-min 40]
//     [--print-prompt]        print the Codex prompt and exit, nothing is run
//
// Exit code: 0 when the report was written and the validator passed, 2 when the validator
// failed, 3 when Codex did not produce a report (extension not attached, wrong profile, error).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(HERE, "validate-discovery-report.mjs");
// Codex runs the mirrored skill copy; node_repl trusts code under ~/.codex only.
const CODEX_DISCOVER = process.env.BOOSTLY_CODEX_DISCOVER || `${process.env.HOME}/.codex/skills/boostly-link-discovery/scripts/discover-links.mjs`;
const CODEX_BROWSER_CLIENT = process.env.BOOSTLY_CODEX_BROWSER_CLIENT || `${process.env.HOME}/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs`;

function parseArgs(argv) {
  const args = {};
  const flags = new Set(["overwrite", "no-cache", "print-prompt"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (flags.has(key)) { args[key] = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function buildPrompt({ locationId, out, statusFile, noCache }) {
  const options = [
    `mode: "discovery+verify"`,
    `codexAgent: globalThis.agent`,
    `chromeProfile: "boostly"`,
    `"chrome-profile": "boostly"`,
    `fulfillmentMode: true`,
    `requiredBrowserProvider: "codex-extension"`,
    ...(noCache ? [`"no-cache": true`] : []),
  ].join(",\n    ");
  return `You are a transport step in the Boostly fulfillment pipeline. Your ONLY job is to run the
link discovery script below through the Chrome extension runtime and confirm the report file was
written. You make no judgments about links and you change nothing else.

Rules, all mandatory:
- Use only the node_repl tool with the Chrome plugin browser runtime (the ChatGPT Chrome
  extension). Do not use chrome-devtools, computer use, Playwright, AppleScript, osascript, or
  the shell command \`open\`. Do not launch, activate, or show a browser window. Keep the browser
  in the background and never change the user's visible tab.
- Read-only. No production writes of any kind. Never open new.boostly.com or any Boostly app
  page. Never post to Slack or Notion.
- Do not create, edit, or delete any file except the two output files named below.
- Never print cookies, tokens, or page dumps. Report counts and error text only.
- If the extension runtime is missing, no extension browser is listed, or the Boostly.com
  profile is not available, STOP. Do not fall back to another browser or tool. Report the exact
  error text.
- Do not retry discovery more than once.

Step 1. Run this in ONE node_repl call, exactly as written. Discovery takes 3 to 15 minutes
and must finish inside this single call (browser calls only work while the cell is executing,
so do not move it into a background promise). Set the tool call timeout to the longest value
the tool allows, at least 20 minutes:

\`\`\`js
if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } = await import(${JSON.stringify(CODEX_BROWSER_CLIENT)});
  globalThis.agent = await setupBrowserRuntime();
}
{
  const fs = await import("node:fs");
  const OUT = ${JSON.stringify(out)};
  const STATUS = ${JSON.stringify(statusFile)};
  const listed = await globalThis.agent.browsers.list();
  const extension = listed.filter((b) => b.type === "extension").map((b) => b.profileName ?? b.metadata?.profileName ?? null);
  const state = { status: "running", started_at: new Date().toISOString(), extension_profiles: extension };
  const save = () => fs.writeFileSync(STATUS, JSON.stringify(state, null, 2) + "\\n", { mode: 0o600 });
  save();
  try {
    const { discoverLocation } = await import(${JSON.stringify(CODEX_DISCOVER)});
    const report = await discoverLocation(${JSON.stringify(locationId)}, {
    ${options}
    });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\\n", { mode: 0o600, flag: "wx" });
    state.status = "done";
    state.summary = {
      browser_provider: report.runtime?.browser_provider ?? null,
      browser_provider_preflighted: report.runtime?.browser_provider_preflighted ?? null,
      chrome_profile_resolved: report.runtime?.chrome_profile_resolved ?? null,
      source_pages: (report.source_pages ?? []).length,
      candidates: (report.discovered_candidates ?? []).length,
      verified_links: (report.verified_links ?? []).length,
    };
  } catch (error) {
    state.status = "error";
    state.error = String(error?.message ?? error).slice(0, 2000);
  }
  state.finished_at = new Date().toISOString();
  save();
  ({ status: state.status, error: state.error ?? null, summary: state.summary ?? null, extension_profiles: extension });
}
\`\`\`

Step 2. If the call timed out before it returned, do NOT start discovery again. Read the status
file named STATUS above once with node:fs and report what it says.

Step 3. Reply with a short plain-text report: whether the extension attached, the extension
profiles listed, the final status, the summary object, and the exact error text if any. Nothing
else.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["run-dir"]) throw new Error("--run-dir is required");
  if (!args["location-id"]) throw new Error("--location-id is required");
  if (!/^[a-z0-9]+$/.test(args["location-id"])) throw new Error("Invalid --location-id");
  const runDir = path.resolve(args["run-dir"]);
  if (!fs.statSync(runDir).isDirectory()) throw new Error(`Not a directory: ${runDir}`);
  const out = path.resolve(args.out || path.join(runDir, "link-discovery-report.json"));
  const effort = args.effort || "medium";
  if (!["low", "medium", "high"].includes(effort)) throw new Error("--effort must be low, medium, or high");
  const stem = path.basename(out).replace(/\.json$/, "");
  const statusFile = path.join(runDir, `${stem}.codex-status.json`);
  const logFile = path.join(runDir, `${stem}.codex-session.log`);
  const lastMessageFile = path.join(runDir, `${stem}.codex-last-message.txt`);
  const prompt = buildPrompt({ locationId: args["location-id"], out, statusFile, noCache: Boolean(args["no-cache"]) });

  if (args["print-prompt"]) {
    process.stdout.write(prompt);
    return 0;
  }

  if (fs.existsSync(out)) {
    if (!args.overwrite) throw new Error(`Refusing to overwrite ${out}; pass --overwrite (a backup is kept) or another --out`);
    const backup = `${out}.before-codex-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(out, backup);
    fs.chmodSync(backup, 0o600);
    fs.unlinkSync(out);
  }
  if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);

  const timeoutMin = Number(args["timeout-min"] || 40);
  const codexArgs = [
    "exec",
    "--skip-git-repo-check",
    "-C", runDir,
    "-c", `model_reasoning_effort="${effort}"`,
    "--color", "never",
    "-o", lastMessageFile,
    "-",
  ];
  const started = Date.now();
  const result = spawnSync("codex", codexArgs, {
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMin * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(logFile, `${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}\n`, { mode: 0o600 });

  const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, "utf8")) : null;
  const summary = {
    codex_exit: result.status,
    codex_error: result.error ? String(result.error.message) : null,
    seconds: Math.round((Date.now() - started) / 1000),
    report: fs.existsSync(out) ? out : null,
    status_file: status ? statusFile : null,
    discovery_status: status?.status ?? null,
    discovery_error: status?.error ?? null,
    extension_profiles: status?.extension_profiles ?? null,
    discovery_summary: status?.summary ?? null,
    session_log: logFile,
    last_message: fs.existsSync(lastMessageFile) ? lastMessageFile : null,
  };
  if (!summary.report) {
    console.log(JSON.stringify({ ...summary, valid: false }, null, 2));
    return 3;
  }
  const validation = spawnSync(process.execPath, [
    VALIDATOR, "--report", out, "--location-id", args["location-id"],
    "--require-browser-provider", "fulfillment", "--require-chrome-profile", "Boostly.com",
  ], { encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(validation.status === 0 ? validation.stdout : validation.stderr); } catch { /* keep null */ }
  console.log(JSON.stringify({ ...summary, validator_exit: validation.status, validator: parsed }, null, 2));
  return validation.status === 0 ? 0 : 2;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(JSON.stringify({ valid: false, errors: [String(error.message)] }, null, 2));
  process.exitCode = 3;
}
