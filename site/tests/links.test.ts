// The site's Links section (lib/links.ts) against the skill's own review-canvas.mjs functions, over every
// local run dir: identical rows (category, label, URL, status, reason, evidence, source, verdict), identical
// summary lines and held count. Skips when the skill or the runs are not on this machine.
//   SKILL_DIR (default ~/.claude/skills/boostly-brand-design)  RUNS_GLOB_ROOT (default the spike project)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { linksSection } from "../lib/links.ts";

const SKILL = process.env.SKILL_DIR ?? path.join(os.homedir(), ".claude/skills/boostly-brand-design");
const ROOT = process.env.RUNS_GLOB_ROOT ?? path.join(os.homedir(), "Programming/projects/brand-design-spike-2026-07-06");
const canvasPath = path.join(SKILL, "scripts/review-canvas.mjs");

const runDirs = (): string[] => {
  if (!fs.existsSync(ROOT)) return [];
  const out: string[] = [];
  for (const d of fs.readdirSync(ROOT).filter((d) => d.startsWith("runs-prod-"))) {
    for (const r of fs.readdirSync(path.join(ROOT, d))) {
      const dir = path.join(ROOT, d, r);
      if (fs.existsSync(path.join(dir, "run.json"))) out.push(dir);
    }
  }
  return out.sort();
};

const project = (r: any) => ({ category: r.category, label: r.label, url: r.url ?? null, status: r.status, reason: r.reason ?? null, evidence: r.evidence ?? [], source: r.source ?? null, verdict: r.verdict });

test("links section matches review-canvas.mjs on every local run", { skip: !fs.existsSync(canvasPath) || !runDirs().length }, async () => {
  const skill = await import(pathToFileURL(canvasPath).href);
  let compared = 0;
  for (const runDir of runDirs()) {
    let run: any;
    try { run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")); } catch { continue; }
    const sources = await skill.collectLinkSources(runDir, run);
    const theirs = skill.linksSection({ runDir, sources });
    const rel = (f: string) => path.relative(runDir, f);
    const r = sources.report;
    const v = sources.validations[0];
    const mine = linksSection({
      links: sources.links,
      report: r ? { file: rel(r.file), checked_at: r.checked_at, summary: r.report.summary ?? null, category_results: r.report.category_results } : null,
      pendingUrls: sources.pendingUrls,
      manifest: sources.manifests[0] ? rel(sources.manifests[0].file) : null,
      validation: v ? { file: rel(v.file), valid: v.valid, errors: v.errors } : null,
    });
    const name = path.basename(runDir);
    if (!theirs) { assert.equal(mine, null, `${name}: the skill has no links section`); continue; }
    assert.ok(mine, `${name}: the site has no links section`);
    const theirRows = theirs.parts.find((p: any) => p.type === "links").rows;
    const theirText = theirs.parts.find((p: any) => p.type === "text").items.map((i: any) => i.text);
    assert.deepEqual(mine.rows.map(project), theirRows.map(project), `${name}: rows`);
    assert.deepEqual(mine.summary.map((l) => l.text), theirText, `${name}: summary lines`);
    assert.equal(`Links (${mine.held} held for review)`, theirs.navLabel, `${name}: held count`);
    compared += 1;
  }
  assert.ok(compared > 0, "no run had link data");
  console.log(`compared ${compared} runs`);
});
