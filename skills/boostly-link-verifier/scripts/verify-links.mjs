#!/usr/bin/env node
import { evaluateCsv, verifyLocation, writeJson } from "../lib/verify-core.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  if (args.csv) {
    if (!args["out-dir"]) throw new Error("--out-dir is required with --csv");
    await evaluateCsv(args.csv, args["out-dir"]);
    return;
  }

  if (!args["location-id"]) throw new Error("Provide --location-id or --csv");
  const report = await verifyLocation(args["location-id"]);
  if (args.out) writeJson(args.out, report);
  else console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else out[key] = next, i++;
  }
  return out;
}
