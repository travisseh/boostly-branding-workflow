#!/usr/bin/env node
// Prints the filled-in figma-trim.js code for use_figma.
//   node figma-trim.mjs --section 2102:39168 --tables 6 --stalls 2 [--allow-zero]
// Paste the output as the `code` of a use_figma call (skillNames "figma-use").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const k = argv[i];
  if (!k.startsWith('--')) throw new Error(`Unexpected argument: ${k}`);
  if (k === '--allow-zero') { args.allowZero = true; continue; }
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`Missing value for ${k}`);
  args[k.slice(2)] = v;
  i += 1;
}
const usage = 'usage: node figma-trim.mjs --section <id like 2102:39168> --tables N --stalls N [--allow-zero]';
if (!args.section || !/^\d+:\d+$/.test(args.section) || args.tables === undefined || args.stalls === undefined) {
  console.error(usage);
  process.exit(1);
}
const tables = Number(args.tables);
const stalls = Number(args.stalls);
if (!Number.isInteger(tables) || !Number.isInteger(stalls) || tables < 0 || stalls < 0) {
  console.error('--tables and --stalls must be non-negative integers');
  process.exit(1);
}
if (tables === 0 && !args.allowZero) {
  console.error('refusing: --tables 0 would delete every table and review sheet; pass --allow-zero to confirm');
  process.exit(1);
}
const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'figma-trim.js'), 'utf8');
process.stdout.write(
  template
    .replaceAll("'__SECTION_ID__'", JSON.stringify(args.section))
    .replaceAll('__TABLES__', String(tables))
    .replaceAll('__STALLS__', String(stalls))
    .replaceAll('__ALLOW_ZERO__', args.allowZero ? 'true' : 'false'),
);
