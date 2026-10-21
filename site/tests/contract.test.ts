// The data contract: the validators accept what site-data.mjs and run-progress.mjs publish today and reject
// what this site cannot read. Uses the two parity runs' review/site-data.json when they are on this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newestSiteData, validateIndex, validateManifest, validateSiteData, type SiteData } from "../lib/contract.ts";

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

test("newestSiteData: the valid copy with the newer generated_at wins; reasons when none is valid", () => {
  const sd = (t: string) => ({ schema_version: 1, kind: "boostly-review-site-data", generated_at: t }) as unknown as SiteData;
  const both = newestSiteData([{ from: "bundle", data: sd("2026-10-21T10:00:00Z") }, { from: "site-data", data: sd("2026-10-21T12:00:00Z") }]);
  assert.equal(both.kind === "ok" && both.from, "site-data");
  const bundleNewer = newestSiteData([{ from: "bundle", data: sd("2026-10-22T10:00:00Z") }, { from: "site-data", data: sd("2026-10-21T12:00:00Z") }]);
  assert.equal(bundleNewer.kind === "ok" && bundleNewer.from, "bundle");
  // an old bundle (no schema_version) does not block a backfilled site/data copy
  const old = newestSiteData([{ from: "bundle", errors: ["manifest has no schema_version"] }, { from: "site-data", data: sd("2026-10-21T12:00:00Z") }]);
  assert.equal(old.kind, "ok");
  const bad = newestSiteData([{ from: "bundle", errors: ["manifest has no schema_version"] }, { from: "site-data", missing: "no site/data file" }]);
  assert.deepEqual(bad, { kind: "invalid", errors: ["bundle: manifest has no schema_version"] });
  const none = newestSiteData([{ from: "bundle", missing: "no bundle" }, { from: "site-data", missing: "no site/data file" }]);
  assert.deepEqual(none, { kind: "missing", reason: "no bundle; no site/data file" });
});
