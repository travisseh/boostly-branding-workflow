#!/usr/bin/env node
// Prints the filled-in figma-recopy.js code for use_figma.
//   node figma-recopy.mjs --section 2102:39168 --offer '$10 OFF' [--mode auto|discount|phrase|generic]
// Paste the output as the `code` of a use_figma call (skillNames "figma-use").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const k = argv[i];
  if (!k.startsWith('--')) throw new Error(`Unexpected argument: ${k}`);
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`Missing value for ${k}`);
  args[k.slice(2)] = v;
  i += 1;
}
if (!args.section || !/^\d+:\d+$/.test(args.section)) {
  console.error("usage: node figma-recopy.mjs --section <id like 2102:39168> --offer '<offer_text>' [--mode auto|discount|phrase|generic]");
  process.exit(1);
}
const mode = args.mode || 'auto';
if (!['auto', 'discount', 'phrase', 'generic'].includes(mode)) throw new Error(`bad --mode ${mode}`);
const offer = args.offer ?? '';
const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'figma-recopy.js'), 'utf8');
process.stdout.write(
  template
    .replaceAll("'__SECTION_ID__'", JSON.stringify(args.section))
    .replaceAll('__OFFER_JSON__', JSON.stringify(offer))
    .replaceAll("'__MODE__'", JSON.stringify(mode)),
);
