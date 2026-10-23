#!/usr/bin/env node
// Usage: node setup/axiom/otlp-receiver.mjs [port=3871] [capture dir=captures]  (2026-10-21, docs/telemetry.md)
// Tiny local OTLP/HTTP receiver: accepts POST /v1/metrics and /v1/logs (json or protobuf), logs a summary,
// writes each JSON body to ./captures, and records request headers with any Authorization value masked.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const port = Number(process.argv[2] || 3871); const dir = process.argv[3] || "captures"; fs.mkdirSync(dir, { recursive: true });
let n = 0;
const attrs = (a = []) => Object.fromEntries(a.map(x => [x.key, Object.values(x.value || {})[0]]));
http.createServer((req, res) => {
  const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
    const buf = Buffer.concat(chunks); const ct = req.headers["content-type"] || ""; n++;
    const hdr = { ...req.headers }; if (hdr.authorization) hdr.authorization = hdr.authorization.replace(/^(Bearer\s+).*/i, "$1<masked len=" + hdr.authorization.length + ">");
    const rec = { n, at: new Date().toISOString(), method: req.method, url: req.url, ct, bytes: buf.length, headers: hdr };
    let summary = "";
    if (ct.includes("json")) {
      const j = JSON.parse(buf.toString()); rec.body = j;
      if (req.url.endsWith("/v1/logs")) summary = (j.resourceLogs || []).flatMap(r => r.scopeLogs.flatMap(s => s.logRecords.map(l => Object.values(l.body || {})[0]))).join(", ");
      if (req.url.endsWith("/v1/metrics")) summary = (j.resourceMetrics || []).flatMap(r => r.scopeMetrics.flatMap(s => s.metrics.map(m => m.name))).join(", ");
    } else summary = "(protobuf, not decoded)";
    fs.writeFileSync(path.join(dir, String(n).padStart(3, "0") + req.url.replace(/\//g, "_") + ".json"), JSON.stringify(rec, null, 1));
    console.log(`${rec.at} ${req.method} ${req.url} ${ct} ${buf.length}B ${summary}`);
    res.writeHead(200, { "content-type": ct.includes("json") ? "application/json" : "application/x-protobuf" }); res.end(ct.includes("json") ? "{}" : "");
  });
}).listen(port, "127.0.0.1", () => console.log("otlp receiver on " + port));
