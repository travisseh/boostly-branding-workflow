// The data contract: the validators accept what site-data.mjs and run-progress.mjs publish today and reject
// what this site cannot read. Uses the two parity runs' review/site-data.json when they are on this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateIndex, validateManifest, validateSiteData } from "../lib/contract.ts";

const RUNS = path.join(os.homedir(), "Programming/projects/brand-design-spike-2026-07-06/runs-prod-2026-09-18");
const local = ["il-capo", "five-star-pizza-clearwater"].map((s) => path.join(RUNS, s, "review/site-data.json")).filter((f) => fs.existsSync(f));

test("published site-data files validate and carry no ship-to fields", { skip: !local.length }, () => {
  for (const f of local) {
    const text = fs.readFileSync(f, "utf8");
    const d = JSON.parse(text);
    assert.deepEqual(validateSiteData(d), { ok: true, errors: [] }, f);
    assert.equal(d.schema_version, 1);
    assert.doesNotMatch(text, /"(ship_to|street_address|postal_code|shipping_[a-z_]+)"\s*:/, `${f} has a ship-to key`);
  }
});

test("site-data with an unknown schema or kind is rejected", () => {
  assert.equal(validateSiteData({ schema_version: 99, kind: "boostly-review-site-data" }).ok, false);
  assert.equal(validateSiteData({ schema_version: 1, kind: "something-else" }).ok, false);
  assert.equal(validateSiteData(null).ok, false);
});

test("bundle manifests need a schema_version this site reads", () => {
  assert.equal(validateManifest({ slug: "x", files: {} }).ok, false);
  assert.equal(validateManifest({ schema_version: 2, slug: "x", files: {} }).ok, false);
  assert.equal(validateManifest({ schema_version: 1, slug: "x", files: {} }).ok, true);
});

test("the index needs schema_version 1 and an entries object", () => {
  assert.equal(validateIndex({ schema_version: 1, entries: {} }).ok, true);
  assert.equal(validateIndex({ schema_version: 1 }).ok, false);
  assert.equal(validateIndex({ entries: {} }).ok, false);
});
