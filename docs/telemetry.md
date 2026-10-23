# Claude Code telemetry (Axiom)

Since 2026-10-21 `setup/setup.sh` turns on Claude Code's built-in OpenTelemetry export on each fulfillment machine,
so Travisse can see what the agents are doing on a run: which tools they call, how long each takes, which fail,
how slow the API is, and what each session costs. Data goes straight from Claude Code to Axiom over OTLP/HTTP.
There is no collector and no extra process.

## What is exported, and what is not

Verified on 2026-10-21 against Claude Code 2.1.304 with a local OTLP receiver (`claude -p` with a Bash call and a
custom subagent).

**Events** (the logs dataset, default `claude-logs`). One record per event, with `session.id`, `prompt.id`,
`event.sequence`, `user.email`, `app.version`, `terminal.type` and the resource attributes below on every record.

| Event | Fields that matter |
|---|---|
| `tool_result` | `tool_name`, `success` ("true"/"false"), `duration_ms` (string), `error_type`, `tool_input_size_bytes`, `tool_result_size_bytes` |
| `tool_decision` | `tool_name`, `decision`, `source`, `permission_mode` |
| `api_request` | `model`, `duration_ms`, `ttft_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `query_source` (`agent:custom` for a subagent call), `agent.name` |
| `api_error` | `model`, `status_code`, `error`, `attempt`, `duration_ms` |
| `user_prompt` | `prompt_length` only; `prompt` arrives as `<REDACTED>` |
| `assistant_response` | `response_length`, `model`; `response` arrives as `<REDACTED>` |
| also | `mcp_server_connection`, `hook_execution_start/complete`, `hook_registered`, `plugin_loaded` (plugin names), `managed_settings_resolved` |

**Metrics** (the metrics dataset, default `claude-metrics`, delta temporality, every 60 s): `claude_code.session.count`,
`claude_code.cost.usage`, `claude_code.token.usage` (by `type`), `claude_code.active_time.total` (by `type`: user/cli),
and, when they happen, `lines_of_code.count`, `commit.count`, `pull_request.count`, `code_edit_tool.decision`.
Every data point carries `session.id` and the resource attributes.

**Never exported.** Prompt text, assistant text, tool arguments (Bash commands, file paths, cookies, URLs), tool
output, and raw API bodies. Those are gated by `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
`OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES`. `setup/bin/telemetry-settings.mjs`
deletes all five from settings.json on every run, because Claude Code treats any set value as on. The cost of that
choice: custom subagent names show as `custom` (`agent.name`, `query_source = agent:custom`), and a tool failure
carries its `error_type` but not its message. Traces are not enabled (beta; tool spans are the only thing they add).

## The settings.json block

`setup.sh` (section 6b) merges this into `~/.claude/settings.json` and never touches other keys:

| Variable | Value | Why |
|---|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` | master switch |
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` | `otlp` | metrics plus events; no traces |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Axiom's recommended encoding (smaller than JSON) |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `https://<AXIOM_DOMAIN>/v1/logs` | Axiom edge ingest; `AXIOM_DOMAIN` defaults to `us-east-1.aws.edge.axiom.co` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `https://<AXIOM_DOMAIN>/v1/metrics` | same |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | default, stated explicitly |
| `OTEL_LOGS_EXPORT_INTERVAL` | `5000` | default; Claude Code also flushes on exit, so short `-p` runs are not lost |
| `OTEL_METRICS_INCLUDE_VERSION` | `true` | `app.version` on metrics, to spot a slow Claude Code release |
| `OTEL_RESOURCE_ATTRIBUTES` | `operator=<name>,host.name=<host>,service.namespace=boostly-fulfillment,boostly.package.version=<git sha>` | splits every chart by machine and operator |
| `otelHeadersHelper` (top-level key, not env) | `~/.config/boostly-branding/bin/otel-headers.sh` | supplies the auth and dataset headers at runtime |

**Why a headers helper.** settings.json env values are literal strings and cannot reference other variables, so a
static `OTEL_EXPORTER_OTLP_HEADERS` would have to contain the token. Instead Claude Code runs
`otel-headers.sh` at startup and every 29 minutes. The script reads `AXIOM_TOKEN`, `AXIOM_DATASET` and
`AXIOM_METRICS_DATASET` from `~/.config/boostly-branding/.env` (Travisse's machine: `~/Programming/.env`) and prints
`{"Authorization": "Bearer …", "X-Axiom-Dataset": …, "X-Axiom-Metrics-Dataset": …}`. Axiom's `/v1/logs` routes on
`X-Axiom-Dataset` and `/v1/metrics` on `X-Axiom-Metrics-Dataset`, so both go on every request. With no token it
prints `{}`: exports are rejected with a 401 and Claude Code stays silent (verified: exit 0, no stderr). Adding
the token later needs only a Claude Code restart, not a setup rerun.

**operator.** `BOOSTLY_EDITOR` from the env file (the same name run-progress uses for its editing claim), else the
login name. It and the host and package version are frozen into settings.json at install time, so rerun `setup.sh`
after changing `BOOSTLY_EDITOR` or `AXIOM_DOMAIN`. `BOOSTLY_TELEMETRY=0` plus a setup rerun removes the block.

## Splitting by operator and machine

Claude Code copies every `OTEL_RESOURCE_ATTRIBUTES` key onto each event, and Axiom files attributes that match no
OTel semantic convention under the `attributes.custom` map. So the split field is `['attributes.custom']['operator']`,
and the same holds for `tool_name`, `duration_ms`, `cost_usd` and the rest. `event.name` and `session.id` are
semantic-convention names, so depending on the dataset's semconv version they are either in `attributes.custom` or
in their own columns. Every query starts with a prelude that takes whichever exists:

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
```

**First thing to run once data arrives** (the queries were written against the documented Axiom field layout and
have not run against live Axiom data yet): the shape check below. If `ev`, `sid` or `operator` come back empty,
open one event, find where the field actually landed, and fix the prelude in `setup/axiom/apl.mjs`. Then rebuild
the dashboard with `node setup/axiom/build-dashboard.mjs --write` and run `create-dashboard.sh --overwrite`.

## Joining sessions to runs

`run-progress.mjs set` stamps `progress.session_id` (latest) and `progress.sessions` (every distinct session that
stamped the run) from `CLAUDE_CODE_SESSION_ID`. Claude Code passes that variable to every tool subprocess, and it
is the same id it exports as `session.id`. The stamp reaches `status/<slug>.json` on the next publish. To get
per-run tool time, failures and cost:

```bash
cd ~/Programming/projects/boostly-branding-workflow
node skills/boostly-brand-design/scripts/run-progress.mjs list --json | node setup/axiom/run-join.mjs > /tmp/run-join.apl
# or from local run dirs: node setup/axiom/run-join.mjs --run-root ~/boostly-branding/runs
```

Paste the output into Axiom's query tab. Two limits:

- **Subagents share their lead's session id.** A fulfill-location or closeout agent's tool calls are in the lead's
  session, so per-run numbers cover the lead session as a whole.
- **One lead session often runs several locations.** Its cost and tool time cannot be split between those runs;
  the `runs_in_session` column says how many runs share each row. Runs stamped before 2026-10-21 have no session id.

## The queries

Generated from `setup/axiom/apl.mjs`; the dashboard in `setup/axiom/dashboard.json` uses the same text.

### 1. Tool duration p50/p95 by tool and operator

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev == 'tool_result'
| extend tool = tostring(['attributes.custom']['tool_name']), dur_ms = todouble(['attributes.custom']['duration_ms'])
| summarize calls = count(), p50_ms = percentile(dur_ms, 50), p95_ms = percentile(dur_ms, 95), total_s = round(sum(dur_ms) / 1000, 1) by tool, operator
| order by p95_ms desc
```

### 1b. Tool duration p95 over time

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev == 'tool_result'
| extend tool = tostring(['attributes.custom']['tool_name']), dur_ms = todouble(['attributes.custom']['duration_ms'])
| summarize p95_ms = percentile(dur_ms, 95) by bin_auto(_time), tool
```

### 2. Slowest sessions

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev in ('tool_result', 'api_request')
| extend dur_ms = todouble(['attributes.custom']['duration_ms']), cost = todouble(['attributes.custom']['cost_usd'])
| summarize started = min(_time), ended = max(_time), tool_calls = countif(ev == 'tool_result'), tool_s = round(sumif(dur_ms, ev == 'tool_result') / 1000, 1), api_s = round(sumif(dur_ms, ev == 'api_request') / 1000, 1), cost_usd = round(sum(cost), 2) by sid, operator
| extend wall_min = round(datetime_diff('second', ended, started) / 60.0, 1)
| order by wall_min desc
| take 25
```

### 3. Tool error rate by tool and operator

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev == 'tool_result'
| extend tool = tostring(['attributes.custom']['tool_name']), ok = tostring(['attributes.custom']['success']) == 'true'
| summarize calls = count(), errors = countif(not(ok)) by tool, operator
| extend error_pct = round(100.0 * errors / calls, 1)
| order by errors desc
```

### 3b. Tool errors by type

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev == 'tool_result' and tostring(['attributes.custom']['success']) != 'true'
| extend tool = tostring(['attributes.custom']['tool_name']), error_type = tostring(['attributes.custom']['error_type'])
| summarize errors = count() by tool, error_type, operator
| order by errors desc
| take 25
```

### 4. Cost per day by operator

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev == 'api_request'
| extend cost = todouble(['attributes.custom']['cost_usd'])
| summarize cost_usd = sum(cost) by bin(_time, 1d), operator
```

### 4b. Tokens and cost per session

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev == 'api_request'
| extend cost = todouble(['attributes.custom']['cost_usd']), input = tolong(['attributes.custom']['input_tokens']), output = tolong(['attributes.custom']['output_tokens']), cache_read = tolong(['attributes.custom']['cache_read_tokens']), cache_write = tolong(['attributes.custom']['cache_creation_tokens']), qs = tostring(['attributes.custom']['query_source'])
| summarize started = min(_time), requests = count(), subagent_requests = countif(qs startswith 'agent:'), input = sum(input), output = sum(output), cache_read = sum(cache_read), cache_write = sum(cache_write), cost_usd = round(sum(cost), 2) by sid, operator
| order by started desc
| take 50
```

### 5. API latency p50/p95 over time

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev == 'api_request'
| extend dur_ms = todouble(['attributes.custom']['duration_ms'])
| summarize p50_ms = percentile(dur_ms, 50), p95_ms = percentile(dur_ms, 95) by bin_auto(_time), operator
```

### 5b. API latency and errors by model

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev in ('api_request', 'api_error')
| extend model = tostring(['attributes.custom']['model']), dur_ms = todouble(['attributes.custom']['duration_ms']), ttft_ms = todouble(['attributes.custom']['ttft_ms'])
| summarize requests = countif(ev == 'api_request'), api_errors = countif(ev == 'api_error'), p50_ms = percentileif(dur_ms, 50, ev == 'api_request'), p95_ms = percentileif(dur_ms, 95, ev == 'api_request'), p95_ttft_ms = percentileif(ttft_ms, 95, ev == 'api_request') by model, operator
| order by requests desc
```

### Shape check (run first)

```kusto
['claude-logs']
| extend ev = coalesce(tostring(['attributes.custom']['event.name']), tostring(column_ifexists('attributes.event.name', '')))
| extend sid = coalesce(tostring(['attributes.custom']['session.id']), tostring(column_ifexists('attributes.session.id', '')))
| extend operator = coalesce(tostring(['attributes.custom']['operator']), 'unknown')
| where ev in ('tool_result', 'api_request')
| take 5
```

### 6. Sessions per run

Generated by `setup/axiom/run-join.mjs` (see Joining sessions to runs); it embeds the run-to-session table as a `datatable` and uses `lookup` on `sid`.

## Axiom setup (Travisse, once)

1. Create the Axiom account (free tier) and note the org's region; US is the default here.
2. **Datasets > Correlations > New correlation group > From new datasets**, prefix `claude`. That creates
   `claude-logs` (events), `claude-metrics` (Metrics kind) and `claude-traces` (unused). Other names work if
   `AXIOM_DATASET` / `AXIOM_METRICS_DATASET` match.
3. **Settings > API tokens > New token**, ingest only, limited to `claude-logs` and `claude-metrics`. This is
   `AXIOM_TOKEN`. Put the same token on both machines: `~/Programming/.env` on Travisse's machine,
   `~/.config/boostly-branding/.env` on Karissa's. Send it to Karissa outside Slack history if possible.
4. A second token with **Dashboards create and update** is `AXIOM_ADMIN_TOKEN`, only in `~/Programming/.env`.
   Then run `bash setup/axiom/create-dashboard.sh` (it reads the token from the env file and never prints it).
   Editing the dashboard by hand in Axiom works too; rerunning with `--overwrite` replaces it with the file version.
5. EU org: set `AXIOM_DOMAIN=eu-central-1.aws.edge.axiom.co` in both env files and rerun `setup.sh` (Karissa).
   On Travisse's machine run the merge command in the PATCHES entry with `--domain`.

## Verifying locally without Axiom

settings.json env values win over the shell environment, so point one run at a local receiver with a `--settings`
file that carries its own env block (verified 2026-10-21):

```bash
node setup/axiom/otlp-receiver.mjs 3871 /tmp/otlp-captures &
cat > /tmp/otel-local.json <<'JSON'
{"env":{"OTEL_EXPORTER_OTLP_PROTOCOL":"http/json",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT":"http://127.0.0.1:3871/v1/logs",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT":"http://127.0.0.1:3871/v1/metrics",
  "OTEL_LOGS_EXPORT_INTERVAL":"1000","OTEL_METRIC_EXPORT_INTERVAL":"2000"}}
JSON
claude -p "reply with the word ok" --model haiku --settings /tmp/otel-local.json < /dev/null
```

The receiver prints one line per POST with the event or metric names and writes each body (Authorization masked)
to the capture directory.
