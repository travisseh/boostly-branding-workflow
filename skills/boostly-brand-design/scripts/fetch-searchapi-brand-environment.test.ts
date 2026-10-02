import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assignDuplicateGroups,
  evaluateIdentity,
  loadClassifications,
  rankCandidate,
  resolveCategories,
  selectCandidates,
  shouldIncludePage2,
  type EnvironmentCandidate,
} from "./fetch-searchapi-brand-environment.ts";

test("exact SearchAPI identity requires place ID, business name, street number, city, and official domain", () => {
  const expected = {
    placeId: "place_123",
    locationName: "Small Town Tavern",
    address: "110 Sara Way, Belle Vernon, PA 15012",
    officialDomain: "smalltowntavernpa.com",
  };
  const exact = evaluateIdentity(expected, {
    place_id: "place_123",
    title: "Small Town Tavern",
    address: "110 Sara Way, Belle Vernon, PA 15012, United States",
    website: "https://www.smalltowntavernpa.com/",
  });
  assert.equal(exact.exact_match, true);

  const transitioned = evaluateIdentity(expected, {
    place_id: "place_123",
    title: "Small Town Tavern",
    address: "999 Other Road, Pittsburgh, PA 15222",
    website: "https://smalltowntavernpa.com/",
  });
  assert.equal(transitioned.exact_match, false);
  assert.equal((transitioned.checks as Record<string, unknown>).street_number_consistent, false);
  assert.equal((transitioned.checks as Record<string, unknown>).city_consistent, false);
});

test("dedupe joins exact hashes and perceptually close images but preserves different aspect ratios", () => {
  const candidates = [
    { sha256: "a", perceptual_hash: "0000000000000000", width: 1200, height: 800 },
    { sha256: "a", perceptual_hash: "ffffffffffffffff", width: 1200, height: 800 },
    { sha256: "b", perceptual_hash: "0000000000000003", width: 1180, height: 800 },
    { sha256: "c", perceptual_hash: "0000000000000003", width: 800, height: 1200 },
  ];
  const groups = assignDuplicateGroups(candidates);
  assert.equal(groups[0], groups[1]);
  assert.equal(groups[0], groups[2]);
  assert.notEqual(groups[0], groups[3]);
});

test("ranking prioritizes classified Vibe environment evidence and heavily penalizes food-dominant candidates", () => {
  const base = {
    width: 1200,
    height: 800,
    subtype: "vibe" as const,
    preliminary_eligible: true,
  };
  const vibe = rankCandidate({ ...base, category: "Vibe", classification: "brand_environment" });
  const all = rankCandidate({ ...base, category: "All", classification: "brand_environment" });
  const food = rankCandidate({ ...base, category: "Vibe", classification: "food" });
  assert(vibe > all);
  assert(food < all);
});

test("auto pagination continues when evidence cannot yet be classified or the raw set is thin", () => {
  assert.equal(shouldIncludePage2("auto", true, 20, false), true);
  assert.equal(shouldIncludePage2("auto", true, 9, true), true);
  assert.equal(shouldIncludePage2("auto", true, 20, true), false);
  assert.equal(shouldIncludePage2("never", true, 0, false), false);
  assert.equal(shouldIncludePage2("always", false, 0, false), false);
});

test("dynamic atmosphere category keeps canonical Vibe ranking while using the returned ID", () => {
  const categories = resolveCategories({ categories: [{ title: "Atmosphere", id: "dynamic-vibe-id" }] });
  assert.deepEqual(categories.vibe, { title: "Vibe", id: "dynamic-vibe-id" });
});

test("eligible classification rows require a physical subtype", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boostly-environment-classification-"));
  const receipt = path.join(root, "classifications.json");
  fs.writeFileSync(receipt, JSON.stringify([{ sha256: "a".repeat(64), classification: "brand_environment" }]));
  assert.throws(() => loadClassifications(receipt), /physical subtype/);
});

test("unclassified handoff is Vibe-only while classified evidence may use other categories", () => {
  const candidate = (candidateId: string, category: string, group: string): EnvironmentCandidate => ({
    candidate_id: candidateId,
    source_type: "searchapi_google_maps_photos",
    category,
    category_id: null,
    source_url: `https://images.example.test/${candidateId}.jpg`,
    local_path: `/tmp/${candidateId}.jpg`,
    width: 1200,
    height: 800,
    bytes: 1000,
    sha256: candidateId.padEnd(64, "0"),
    perceptual_hash: "0000000000000000",
    duplicate_group: group,
    exact_identity_evidence: "exact place",
    author_attribution: null,
    classification: "unclassified",
    subtype: category === "Vibe" ? "vibe" : "unclassified",
    classification_source: null,
    usable_for_brand_environment: null,
    preliminary_eligible: true,
    rank_score: category === "Vibe" ? 100 : 80,
  });
  const vibe = candidate("vibe", "Vibe", "group-1");
  const owner = candidate("owner", "By owner", "group-2");
  assert.deepEqual(selectCandidates([vibe, owner], false).map((item) => item.candidate_id), ["vibe"]);

  owner.classification = "brand_environment";
  owner.subtype = "storefront";
  owner.usable_for_brand_environment = true;
  assert.deepEqual(selectCandidates([vibe, owner], true).map((item) => item.candidate_id), ["owner"]);
});
