#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  buildAuditRows,
  buildStatePatch,
  parseFulfillmentResult,
  renderNotionChecklist,
  renderBatchNotionReview,
  renderSlackSummary,
  type FulfillmentResult,
  type BatchReviewFailure,
} from "./fulfillment-artifacts.ts";
import { fulfillmentResultFromRun, readRun } from "./run-file.ts";

export function generateBatchReview(results: unknown[], failures: BatchReviewFailure[] = []): string {
  return renderBatchNotionReview(results, failures);
}

export function generateFulfillmentArtifacts(result: FulfillmentResult): Record<string, unknown> {
  result = parseFulfillmentResult(result);
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const output = {
    slack_summary: renderSlackSummary(result),
    notion_checklist: renderNotionChecklist(result),
    audit_rows: buildAuditRows(result),
    state_patch: buildStatePatch(result),
  };
  return {
    ...output,
    stage_metrics: [{
      stage: "artifact_generation",
      started_at: startedAt,
      duration_ms: Number((performance.now() - startedMs).toFixed(3)),
      counters: {
        audit_rows: output.audit_rows.length,
        slack_characters: output.slack_summary.length,
        notion_characters: output.notion_checklist.length,
      },
      outcome: "ok",
    }],
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.run ? path.resolve(args.run) : null;
  if ((!args.input && !runDir) || (!args["out-dir"] && !runDir)) {
    throw new Error("Usage: --input <fulfillment-result.json> --out-dir <dir> | --run <run_dir> [--input <json>] [--out-dir <dir>]");
  }
  // Pure renderer: with --run the Slack text, Notion checklist, audit rows, and state patch are
  // rendered from run.json (plan + links + derived artifacts); nothing is retyped.
  const result = args.input
    ? JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8")) as FulfillmentResult
    : fulfillmentResultFromRun(readRun(runDir as string)) as unknown as FulfillmentResult;
  const output = generateFulfillmentArtifacts(result);
  const outDir = path.resolve(args["out-dir"] ?? path.join(runDir as string, "artifacts"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "slack-summary.txt"), String(output.slack_summary));
  fs.writeFileSync(path.join(outDir, "notion-checklist.md"), String(output.notion_checklist));
  fs.writeFileSync(path.join(outDir, "audit-rows.json"), `${JSON.stringify(output.audit_rows, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "state-patch.json"), `${JSON.stringify(output.state_patch, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "artifact-generation.json"), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: outDir, stage_metrics: output.stage_metrics })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
