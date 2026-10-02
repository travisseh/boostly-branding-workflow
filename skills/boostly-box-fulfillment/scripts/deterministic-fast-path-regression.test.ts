import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildLinkDecisions } from "./fulfillment-plan.ts";
import { validateDiscoveryReport } from "../../boostly-link-discovery/scripts/validate-discovery-report.mjs";

type CorpusCase = {
  id: string;
  discovery_report?: string;
  discovery_sha256?: string;
  validator_exit?: number;
  validator_errors?: string[];
  fulfillment_report?: string;
  fulfillment_sha256?: string;
  branding_manifest: string;
  branding_sha256: string;
  quality_contract: string[];
};

type JsonObject = Record<string, unknown>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.resolve(HERE, "../fixtures/deterministic-fast-path-corpus.json");
const corpus = readJson(CORPUS_PATH) as { schema_version: number; cases: CorpusCase[] };

test("the named regression corpus is immutable and complete", () => {
  assert.equal(corpus.schema_version, 1);
  assert.deepEqual(corpus.cases.map((item) => item.id), [
    "river_grille",
    "taste_of_beauty",
    "paolos",
    "small_town_tavern",
    "goldfinch",
    "pilonis_brazil",
    "pilonis_terre_haute",
  ]);

  for (const item of corpus.cases) {
    assertFileHash(item.branding_manifest, item.branding_sha256);
    if (item.discovery_report && item.discovery_sha256) {
      assertFileHash(item.discovery_report, item.discovery_sha256);
    }
    if (item.fulfillment_report && item.fulfillment_sha256) {
      assertFileHash(item.fulfillment_report, item.fulfillment_sha256);
    }
    assert(item.quality_contract.length > 0, `${item.id} must have explicit quality contracts`);
  }
});

test("historical discovery reports retain their exact verification outcomes", () => {
  for (const item of corpus.cases.filter((candidate) => candidate.discovery_report)) {
    const report = readJson(item.discovery_report!) as JsonObject;
    const errors = validateDiscoveryReport(report);
    const expectedExit = item.validator_exit ?? 0;
    assert.equal(errors.length ? 2 : 0, expectedExit, `${item.id} validator exit drifted: ${errors.join(", ")}`);
    assert.deepEqual(errors, item.validator_errors ?? [], `${item.id} validator errors drifted`);
  }
});

test("deterministic plan decisions preserve recall while holding known unsafe writes", () => {
  const decisions = Object.fromEntries(
    corpus.cases
      .filter((item) => item.discovery_report)
      .map((item) => [item.id, buildLinkDecisions(readJson(item.discovery_report!) as JsonObject)]),
  );

  for (const [caseId, links] of Object.entries(decisions)) {
    const unsafeWrites = links.filter((link) => link.action === "write" && [
      "reservations",
      "gift_cards",
      "loyalty_rewards",
      "ios_app",
      "android_app",
      "app_downloads",
    ].includes(link.category));
    assert.deepEqual(unsafeWrites, [], `${caseId} auto-wrote a review-only category`);
  }

  assert.equal(actionFor(decisions.taste_of_beauty, "instagram"), "write");
  assert.equal(actionFor(decisions.taste_of_beauty, "facebook"), "write");
  assert.equal(actionFor(decisions.taste_of_beauty, "order"), "hold");
  assert.equal(reasonFor(decisions.taste_of_beauty, "order"), "challenge_or_timeout_requires_review");
  assert.equal(actionFor(decisions.taste_of_beauty, "events"), "hold");
  assert.equal(reasonFor(decisions.taste_of_beauty, "events"), "events_missing_upcoming_structured_date");

  assert.equal(actionFor(decisions.goldfinch, "menu"), "write");
  assert.equal(actionFor(decisions.goldfinch, "careers_jobs"), "write");
  assert.equal(actionFor(decisions.goldfinch, "events"), "hold");

  const careers = decisions.pilonis_terre_haute.find((link) => link.category === "careers_jobs");
  assert.equal(careers?.action, "write");
  assert.deepEqual(careers?.presentation, {
    title: "Careers",
    display_title: "Join Our Team",
    description: "Grow with our team",
    button_text: "Apply Now",
  });
});

test("branding manifests preserve the expected identity, palette, and mechanical-QA evidence", () => {
  const manifests = Object.fromEntries(
    corpus.cases.map((item) => [item.id, readJson(item.branding_manifest) as JsonObject]),
  );

  assert.deepEqual(proposedColors(manifests.river_grille), ["#060809", "#008FD6", "#FFFFFF"]);
  assert.deepEqual(proposedColors(manifests.taste_of_beauty), ["#F0EEE4", "#1A1A1A", "#1A1A1A"]);
  assert.deepEqual(proposedColors(manifests.paolos), ["#00472a", "#000000", "#ffffff"]);
  assert.deepEqual(proposedColors(manifests.small_town_tavern), ["#100e0f", "#caa668", "#ffffff"]);
  assert.deepEqual(proposedColors(manifests.goldfinch), ["#000000", "#c05700", "#ffffff"]);
  assert.deepEqual(proposedColors(manifests.pilonis_brazil), ["#ff0003", "#005d2d", "#000000"]);
  assert.deepEqual(proposedColors(manifests.pilonis_terre_haute), ["#000000", "#fe0002", "#ffffff"]);

  assert.equal(nested(manifests.small_town_tavern, "gates", "border_dust", "cleaned_native", "pass"), true);
  assert.equal(nested(manifests.small_town_tavern, "gates", "border_dust", "original_native", "pass"), false);
  assert.equal(nested(manifests.pilonis_terre_haute, "logo_files", 0, "sha256"), "185c1dfaff2941a46679dc514d8764b425cb2e82d5cd5943bec6b02c5d6f7e95");
  assert.equal(nested(manifests.taste_of_beauty, "production", "confidence"), "medium");
  assert((nested(manifests.taste_of_beauty, "production", "flags") as unknown[]).includes("location_address_unverified"));
});

test("Small Town Tavern retains exact badge idempotency evidence", () => {
  const item = corpus.cases.find((candidate) => candidate.id === "small_town_tavern")!;
  const report = readJson(item.fulfillment_report!) as JsonObject;
  assert.equal(nested(report, "badges", "requested"), 10);
  assert.equal(nested(report, "badges", "created"), 10);
  assert.equal(nested(report, "badges", "after_count"), 10);
  assert.equal((nested(report, "badges", "ids") as unknown[]).length, 10);
});

function actionFor(links: ReturnType<typeof buildLinkDecisions>, category: string): string | undefined {
  return links.find((link) => link.category === category)?.action;
}

function reasonFor(links: ReturnType<typeof buildLinkDecisions>, category: string): string | undefined {
  return links.find((link) => link.category === category)?.reason;
}

function proposedColors(manifest: JsonObject): unknown[] {
  return [
    nested(manifest, "proposed", "web_primary_color"),
    nested(manifest, "proposed", "web_secondary_color"),
    nested(manifest, "proposed", "web_text_color"),
  ];
}

function nested(value: unknown, ...keys: Array<string | number>): unknown {
  let current = value;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertFileHash(filePath: string, expected: string): void {
  assert(fs.existsSync(filePath), `missing fixture: ${filePath}`);
  const actual = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  assert.equal(actual, expected, `fixture changed: ${filePath}`);
}
