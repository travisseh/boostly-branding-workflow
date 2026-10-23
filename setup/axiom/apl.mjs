// Shared APL pieces for the Claude Code telemetry dataset in Axiom (2026-10-21, docs/telemetry.md).
// Axiom stores OTel attributes that match no semantic convention under the `attributes.custom` map, so Claude Code's
// event fields (tool_name, duration_ms, cost_usd, ...) are read from there. event.name and session.id ARE semantic
// convention names, so depending on the dataset's semconv version they land in attributes.custom or in their own
// columns; the prelude takes whichever exists. Claude Code also copies the OTEL_RESOURCE_ATTRIBUTES keys (operator,
// host.name, boostly.package.version) onto every event, which is where `operator` comes from.
export const a = (k) => `['attributes.custom']['${k}']`;
export const prelude = (ds = "claude-logs") => [
  `['${ds}']`,
  `| extend ev = coalesce(tostring(${a("event.name")}), tostring(column_ifexists('attributes.event.name', '')))`,
  `| extend sid = coalesce(tostring(${a("session.id")}), tostring(column_ifexists('attributes.session.id', '')))`,
  `| extend operator = coalesce(tostring(${a("operator")}), 'unknown')`,
].join("\n");

export const queries = (ds) => {
  const P = prelude(ds);
  return {
    toolDuration: `${P}
| where ev == 'tool_result'
| extend tool = tostring(${a("tool_name")}), dur_ms = todouble(${a("duration_ms")})
| summarize calls = count(), p50_ms = percentile(dur_ms, 50), p95_ms = percentile(dur_ms, 95), total_s = round(sum(dur_ms) / 1000, 1) by tool, operator
| order by p95_ms desc`,
    toolDurationSeries: `${P}
| where ev == 'tool_result'
| extend tool = tostring(${a("tool_name")}), dur_ms = todouble(${a("duration_ms")})
| summarize p95_ms = percentile(dur_ms, 95) by bin_auto(_time), tool`,
    slowestSessions: `${P}
| where ev in ('tool_result', 'api_request')
| extend dur_ms = todouble(${a("duration_ms")}), cost = todouble(${a("cost_usd")})
| summarize started = min(_time), ended = max(_time), tool_calls = countif(ev == 'tool_result'), tool_s = round(sumif(dur_ms, ev == 'tool_result') / 1000, 1), api_s = round(sumif(dur_ms, ev == 'api_request') / 1000, 1), cost_usd = round(sum(cost), 2) by sid, operator
| extend wall_min = round(datetime_diff('second', ended, started) / 60.0, 1)
| order by wall_min desc
| take 25`,
    toolErrors: `${P}
| where ev == 'tool_result'
| extend tool = tostring(${a("tool_name")}), ok = tostring(${a("success")}) == 'true'
| summarize calls = count(), errors = countif(not(ok)) by tool, operator
| extend error_pct = round(100.0 * errors / calls, 1)
| order by errors desc`,
    toolErrorTypes: `${P}
| where ev == 'tool_result' and tostring(${a("success")}) != 'true'
| extend tool = tostring(${a("tool_name")}), error_type = tostring(${a("error_type")})
| summarize errors = count() by tool, error_type, operator
| order by errors desc
| take 25`,
    costPerDay: `${P}
| where ev == 'api_request'
| extend cost = todouble(${a("cost_usd")})
| summarize cost_usd = sum(cost) by bin(_time, 1d), operator`,
    tokensPerSession: `${P}
| where ev == 'api_request'
| extend cost = todouble(${a("cost_usd")}), input = tolong(${a("input_tokens")}), output = tolong(${a("output_tokens")}), cache_read = tolong(${a("cache_read_tokens")}), cache_write = tolong(${a("cache_creation_tokens")}), qs = tostring(${a("query_source")})
| summarize started = min(_time), requests = count(), subagent_requests = countif(qs startswith 'agent:'), input = sum(input), output = sum(output), cache_read = sum(cache_read), cache_write = sum(cache_write), cost_usd = round(sum(cost), 2) by sid, operator
| order by started desc
| take 50`,
    apiLatencySeries: `${P}
| where ev == 'api_request'
| extend dur_ms = todouble(${a("duration_ms")})
| summarize p50_ms = percentile(dur_ms, 50), p95_ms = percentile(dur_ms, 95) by bin_auto(_time), operator`,
    apiLatencyByModel: `${P}
| where ev in ('api_request', 'api_error')
| extend model = tostring(${a("model")}), dur_ms = todouble(${a("duration_ms")}), ttft_ms = todouble(${a("ttft_ms")})
| summarize requests = countif(ev == 'api_request'), api_errors = countif(ev == 'api_error'), p50_ms = percentileif(dur_ms, 50, ev == 'api_request'), p95_ms = percentileif(dur_ms, 95, ev == 'api_request'), p95_ttft_ms = percentileif(ttft_ms, 95, ev == 'api_request') by model, operator
| order by requests desc`,
    shapeCheck: `${P}
| where ev in ('tool_result', 'api_request')
| take 5`,
  };
};
