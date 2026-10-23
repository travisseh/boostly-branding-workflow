#!/usr/bin/env node
// Prints an APL query that joins Claude Code sessions in Axiom to Boostly fulfillment runs (2026-10-21).
//
//   node skills/boostly-brand-design/scripts/run-progress.mjs list --json | node setup/axiom/run-join.mjs
//   node setup/axiom/run-join.mjs --run-root ~/boostly-branding/runs      (local review/progress.json files instead)
//   [--dataset claude-logs] [--slug <slug>]
//
// run-progress.mjs `set` stamps progress.session_id (latest) and progress.sessions (every distinct Claude Code session
// that stamped the run) from CLAUDE_CODE_SESSION_ID; Claude Code exports the same id as session.id on every event.
// Subagents share their lead's session id, and one lead session can fulfill several runs, so a session's tool time
// and cost cannot be split between the runs it touched: `runs_in_session` says how many runs share each row.
// Paste the output into Axiom's query tab.
import fs from "node:fs";
import path from "node:path";
import { prelude, a } from "./apl.mjs";

const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const ds = val("--dataset") || process.env.AXIOM_DATASET || "claude-logs";
const only = val("--slug");
let rows = [];
if (val("--run-root")) {
  const root = val("--run-root");
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, "review", "progress.json");
    if (fs.existsSync(f)) { try { rows.push({ slug: d, progress: JSON.parse(fs.readFileSync(f, "utf8")) }); } catch {} }
  }
} else {
  const input = fs.readFileSync(0, "utf8").trim();
  if (!input) { console.error("run-join: pipe `run-progress.mjs list --json` in, or pass --run-root DIR"); process.exit(2); }
  rows = JSON.parse(input);
}
const clean = (s) => String(s ?? "").replace(/[^A-Za-z0-9._:-]/g, "");
const pairs = [];
for (const r of rows) {
  const slug = clean(r.slug); if (!slug || (only && slug !== only)) continue;
  const p = r.progress || {};
  const ids = new Set([...(p.sessions || []), ...(p.session_id ? [p.session_id] : [])].map(clean).filter(Boolean));
  for (const sid of ids) pairs.push({ sid, slug, stage: clean(p.stage) });
}
if (!pairs.length) { console.error("run-join: no run has a session id yet (stamped by run-progress.mjs set since 2026-10-21)"); process.exit(1); }
const shared = {};
for (const p of pairs) shared[p.sid] = (shared[p.sid] || 0) + 1;
const table = pairs.map((p) => `  '${p.sid}', '${p.slug}', '${p.stage}', ${shared[p.sid]}`).join(",\n");
console.log(`let runs = datatable(sid:string, slug:string, stage:string, runs_in_session:long)[
${table}
];
${prelude(ds)}
| where ev in ('tool_result', 'api_request')
| extend dur_ms = todouble(${a("duration_ms")}), cost = todouble(${a("cost_usd")}), ok = tostring(${a("success")}) == 'true'
| summarize started = min(_time), ended = max(_time), tool_calls = countif(ev == 'tool_result'), tool_errors = countif(ev == 'tool_result' and not(ok)), tool_s = round(sumif(dur_ms, ev == 'tool_result') / 1000, 1), api_s = round(sumif(dur_ms, ev == 'api_request') / 1000, 1), cost_usd = round(sum(cost), 2) by sid, operator
| lookup kind=inner runs on sid
| extend wall_min = round(datetime_diff('second', ended, started) / 60.0, 1)
| project slug, stage, operator, sid, runs_in_session, started, wall_min, tool_calls, tool_errors, tool_s, api_s, cost_usd
| order by slug asc, started asc`);
