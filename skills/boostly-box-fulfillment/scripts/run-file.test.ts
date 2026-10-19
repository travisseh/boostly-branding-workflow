import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEPENDENTS,
  GATES_REGISTRY_PATH,
  appendOverride,
  decisionBlockFromFile,
  fulfillmentResultFromRun,
  initRun,
  migrateRun,
  preparationInputFromRun,
  readRun,
  requestBlockFromCanonical,
  selectLetter,
  setBlock,
  stripNote,
  validateBlock,
  validateRun,
  variantsBlockFromSheet,
} from "./run-file.ts";
import { buildFulfillmentPlan } from "./fulfillment-plan.ts";

const REQUEST = {
  request_id: "req_1",
  request_key: "v2:req_1",
  location_id: "loc_1",
  account_id: "acct_1",
  location_name: "Small Town Tavern",
  account_name: "Small Town Tavern",
  slack_thread_ts: "1783960267.741929",
  quantities: { tap_cards: 10, tables: 10, bathroom_stalls: 6, signage: 1, to_go_rolls: 0 },
  csm: { name: "Jonathan", email: "j@example.com" },
  identity: { account_name: "Small Town Tavern", location_name: "Small Town Tavern", street_address: "110 Sara Way", city: "Belle Vernon", state: "PA", postal_code: "15012" },
  location_candidates: [{ location_id: "loc_1", location_name: "Small Town Tavern", location_status: "enabled", account_id: "acct_1", account_name: "Small Town Tavern", address: "110 Sara Way, Belle Vernon, PA 15012", google_place_id: "ChIJ-x", is_general: false }],
  account_locations: [],
};

const DECISION = {
  logo_choice: "/packet/logo.png",
  palette: { web_primary_color: "#C93B18", web_secondary_color: "#000000", web_text_color: "#FFFFFF" },
  composition: "Words-only knockout centered.",
  confidence: "high",
  flags: ["mark_element_omitted"],
  rationale: "The arched wordmark is the verified mark.",
};

function tmpRun(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-file-"));
  const dir = path.join(root, "runs-prod-2026-09-16", "small-town-tavern");
  initRun({ runDir: dir, request: REQUEST });
  return dir;
}

test("init writes a valid run.json with the request block and derived run id", () => {
  const dir = tmpRun();
  const run = readRun(dir);
  assert.equal(run.schema_version, 1);
  assert.equal(run.run_id, "runs-prod-2026-09-16/small-town-tavern");
  assert.deepEqual(run.request, REQUEST);
  assert.deepEqual(validateRun(run), []);
  assert.equal(run.state.cursor, "request");
  assert.throws(() => initRun({ runDir: dir, request: REQUEST }), /already exists/);
});

test("set validates the block against the schema and refuses unknown blocks", () => {
  const dir = tmpRun();
  assert.throws(() => setBlock(dir, "decision", { logo_choice: null }), /Invalid decision block/);
  assert.throws(() => setBlock(dir, "manifest", {}), /Unknown block/);
  assert.throws(() => setBlock(dir, "legacy", {}), /migrate/);
  assert.deepEqual(validateBlock("write", { status: "applied", logo_sha256: "nothex" }).length > 0, true);
  setBlock(dir, "evidence", { evidence_fingerprint: "a".repeat(64), packet_path: "evidence/branding-evidence.json", logo_candidates: [] });
  assert.equal(readRun(dir).state.cursor, "evidence");
});

test("ownership: a block with live dependents is not overwritten without --force and a reason, and the force is recorded", () => {
  const dir = tmpRun();
  const evidence = { evidence_fingerprint: "b".repeat(64), packet_path: "evidence/branding-evidence.json", logo_candidates: [] };
  setBlock(dir, "evidence", evidence);
  // Re-running the same stage before anything depends on it is fine.
  setBlock(dir, "evidence", { ...evidence, generated_at: "2026-09-16T00:00:00Z" });
  setBlock(dir, "decision", { ...DECISION, decision_sha256: "c".repeat(64) });
  assert.deepEqual(DEPENDENTS.evidence.includes("decision"), true);
  assert.throws(() => setBlock(dir, "evidence", evidence), /Refusing to overwrite "evidence": decision already depend/);
  assert.throws(() => setBlock(dir, "evidence", evidence, { force: true }), /--force requires --reason/);
  const run = setBlock(dir, "evidence", evidence, { force: true, reason: "packet rebuilt after a new logo was supplied", by: "test" });
  const forces = run.state.forces as Array<Record<string, unknown>>;
  assert.equal(forces.length, 1);
  assert.equal(forces[0].block, "evidence");
  assert.deepEqual(forces[0].dependents, ["decision"]);
  assert.equal(typeof forces[0].previous_sha256, "string");
  // Renderer blocks never seal anything.
  setBlock(dir, "notion", { page_id: "p1" });
  setBlock(dir, "notion", { page_id: "p1", block_id: "b1" });
  setBlock(dir, "decision", { ...DECISION, decision_sha256: "d".repeat(64) });
});

test("overrides are append-only: set appends, nothing replaces, and records need gate/asset/who/why/when", () => {
  const dir = tmpRun();
  assert.throws(() => setBlock(dir, "overrides", [{ gate: "ocr" }]), /Invalid override record/);
  appendOverride(dir, { gate: "ocr", asset: "fix/card/card-final.png", decided_by: "Travisse", reason: "TRATTORIA is decorative at card size" });
  setBlock(dir, "overrides", { gate: "render-legibility", asset: "fix/card/card-final.png", decided_by: "Travisse", reason: "same", at: "2026-09-15T00:00:00Z" });
  setBlock(dir, "overrides", []);
  const overrides = readRun(dir).overrides as Array<Record<string, unknown>>;
  assert.equal(overrides.length, 2);
  // aliases (ocr) are normalized to the registry id so an override matches the gate runner's result ids
  assert.deepEqual(overrides.map((item) => item.gate), ["text-legibility", "render-legibility"]);
  assert.equal(typeof overrides[0].at, "string");
});

test("override is refused for a gate the registry marks override_allowed=false; overrides never edit a rule", () => {
  const dir = tmpRun();
  const registryBefore = fs.readFileSync(GATES_REGISTRY_PATH, "utf8");
  assert.throws(
    () => appendOverride(dir, { gate: "png-color-type", asset: "fix/card/card-final.png", decided_by: "Travisse", reason: "ship it anyway" }),
    /not overridable/,
  );
  assert.throws(
    () => appendOverride(dir, { gate: "ship_gate", asset: "fix/card/card-final.png", decided_by: "Travisse", reason: "alias of a hard gate" }),
    /not overridable/,
  );
  assert.equal((readRun(dir).overrides ?? []).length, 0);
  // the shipped path: refused without proof the asset is live, accepted with an apply receipt, never for gates without it
  assert.throws(
    () => appendOverride(dir, { gate: "png-color-type", asset: "fix/card/card-final.png", decided_by: "Travisse", reason: "live palette PNG" }, { shipped: true }),
    /needs proof the asset is live/,
  );
  fs.mkdirSync(path.join(dir, "fix", "live"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fix", "live", "apply.json"), JSON.stringify({ success: true }));
  appendOverride(dir, { gate: "png-color-type", asset: "fix/card/card-final.png", decided_by: "Travisse", reason: "live palette PNG" }, { shipped: true });
  assert.equal((readRun(dir).overrides as Array<Record<string, unknown>>)[0].shipped_asset, true);
  assert.throws(
    () => appendOverride(dir, { gate: "ship-gate", asset: "fix/card/card-final.png", decided_by: "Travisse", reason: "too small but live" }, { shipped: true }),
    /not overridable/,
  );
  assert.equal(fs.readFileSync(GATES_REGISTRY_PATH, "utf8"), registryBefore, "recording an override must never touch gates.json");
  // an allowed gate records, and the asset hash is captured when the file exists
  fs.mkdirSync(path.join(dir, "fix"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fix", "logo.png"), "not-really-a-png");
  appendOverride(dir, { gate: "tiny_text", asset: "fix/logo.png", decided_by: "travisse", reason: "TRATTORIA stays" });
  const record = (readRun(dir).overrides as Array<Record<string, unknown>>).find((item) => item.gate === "render-legibility") as Record<string, unknown>;
  assert.equal(record.gate, "render-legibility");
  assert.equal(record.asset_sha256, crypto.createHash("sha256").update("not-really-a-png").digest("hex"));
});

test("select records the human letter as data and appends a Fable-default override when it differs", () => {
  const dir = tmpRun();
  assert.throws(() => selectLetter(dir, "B", { by: "Travisse" }), /No variants block/);
  setBlock(dir, "variants", { sheet_png: "variants/variant-sheet.png", sheet_json: "variants/variant-sheet.json", fable_default_letter: "A", applied_letter: null, cells: { A: { letter: "A", row: "knockout", column_index: 0 }, B: { letter: "B", row: "knockout", column_index: 1 } } });
  assert.throws(() => selectLetter(dir, "Z", { by: "Travisse" }), /not a cell/);
  assert.throws(() => selectLetter(dir, "B", { by: "Travisse", printLetter: "Z" }), /not a cell/);
  const run = selectLetter(dir, "B", { by: "Travisse", reason: "black band reads better" });
  const variants = run.variants as Record<string, unknown>;
  assert.equal(variants.applied_letter, "B");
  // The pick is recorded by row key + column too, so an in-place asset swap keeps it resolvable.
  const selection = variants.selection as Record<string, unknown>;
  assert.equal(selection.decided_by, "Travisse");
  assert.equal(selection.row_key, "knockout");
  assert.equal(selection.column_index, 1);
  assert.equal(selection.print_letter, null);
  const overrides = run.overrides as Array<Record<string, unknown>>;
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].gate, "fable_default_letter");
  assert.equal(overrides[0].from_letter, "A");
  assert.equal(overrides[0].to_letter, "B");
  // Choosing Fable's own letter appends nothing.
  const again = selectLetter(dir, "A", { by: "Travisse" });
  assert.equal((again.overrides as unknown[]).length, 1);
  // A web/print split is a first-class pick: web = B, print = A, recorded in the same selection.
  const split = selectLetter(dir, "B", { by: "Travisse", reason: "web B, print A", printLetter: "A" });
  const splitSelection = (split.variants as Record<string, unknown>).selection as Record<string, unknown>;
  assert.equal((split.variants as Record<string, unknown>).applied_letter, "B");
  assert.equal(splitSelection.print_letter, "A");
  assert.equal(splitSelection.row_key, "knockout");
});

test("decision block is the decision file verbatim plus its sha256; the six keys are never retyped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decision-"));
  const file = path.join(root, "decision.json");
  const serialized = `${JSON.stringify({ ...DECISION, extra_key: "ignored by the block" }, null, 2)}\n`;
  fs.writeFileSync(file, serialized);
  const block = decisionBlockFromFile(file, { evidence_fingerprint: "e".repeat(64) });
  assert.equal(block.decision_sha256, crypto.createHash("sha256").update(serialized).digest("hex"));
  for (const key of Object.keys(DECISION)) assert.deepEqual(block[key], (DECISION as Record<string, unknown>)[key]);
  assert.equal("extra_key" in block, false);
  assert.deepEqual(validateBlock("decision", block), []);
});

test("preparation input from run.json carries the decision provenance so the immutability check runs against the file", () => {
  const dir = tmpRun();
  const decisionFile = path.join(dir, "decision.json");
  fs.writeFileSync(decisionFile, `${JSON.stringify(DECISION, null, 2)}\n`);
  setBlock(dir, "evidence", { evidence_fingerprint: "f".repeat(64), packet_path: "evidence/branding-evidence.json", logo_candidates: [] });
  setBlock(dir, "decision", { ...decisionBlockFromFile(decisionFile), source_path: "decision.json" });
  const input = preparationInputFromRun(readRun(dir), { discovery_report: { location_context: { location_id: "loc_1" } }, run_dir: dir });
  const request = input.request as Record<string, unknown>;
  assert.equal(request.request_key, "v2:req_1");
  assert.equal(request.expected_location_id, "loc_1");
  assert.equal(request.canonical_thread_ts, "1783960267.741929");
  const branding = input.branding as Record<string, unknown>;
  assert.equal(branding.status, "hold");
  assert.equal(branding.fable_decision_path, decisionFile);
  assert.deepEqual(branding.fable_output, DECISION);
});

test("request block from a canonical intake request keeps ids, quantities, thread ts, and csm", () => {
  const block = requestBlockFromCanonical({
    source: "v2-db",
    request_key: "v2:abc",
    fulfillment_request_id: "abc",
    canonical_thread_ts: "1783960267.741929",
    order_type: "full_order",
    status: "digital_fulfillment",
    created_at: "2026-09-16T00:00:00Z",
    fields: { account_name: "A", location_name: "A (City)", street_address: "1 St", city: "City", state: "PA", postal_code: "15012", offer: "20% Off" },
    csm: { name: "Jonathan", email: "j@x" },
    requested_by: null,
    slack_thread_ts: "1783960267.741929",
    quantities: { tap_cards: 10, tables: 10, bathroom_stalls: 6, signage: 1, to_go_rolls: 0 },
    shipping: { complete: false },
    expected_location_id: "loc",
    expected_account_id: "acct",
    location_candidates: [{ location_id: "loc", location_name: "A (City)", location_status: "enabled", account_id: "acct", account_name: "A", address: "1 St, City, PA 15012", google_place_id: "ChIJ", is_general: false }],
    account_locations: [],
  });
  assert.equal(block.request_id, "abc");
  assert.equal(block.location_id, "loc");
  assert.equal(block.slack_thread_ts, "1783960267.741929");
  assert.deepEqual(block.csm, { name: "Jonathan", email: "j@x" });
  assert.equal(block.offer_text, "20% Off");
  assert.equal(block.google_place_id, "ChIJ");
  assert.deepEqual(validateBlock("request", block), []);
});

test("migrate is lossless: mapped values match the manifest and everything else survives under legacy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  const dir = path.join(root, "runs-prod-2026-09-14", "fixture-location");
  fs.mkdirSync(path.join(dir, "fix", "live-1B"), { recursive: true });
  fs.mkdirSync(path.join(dir, "variants-v2"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.mkdirSync(path.join(dir, "links"), { recursive: true });
  const logoBytes = Buffer.from("not-really-a-png");
  fs.mkdirSync(path.join(dir, "fix", "card"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fix", "card", "card-full-tight.png"), logoBytes);
  const logoSha = crypto.createHash("sha256").update(logoBytes).digest("hex");
  const decisionText = `${JSON.stringify(DECISION, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, "fable-decision.json"), decisionText);
  const decisionSha = crypto.createHash("sha256").update(decisionText).digest("hex");
  fs.writeFileSync(path.join(dir, "evidence", "branding-evidence.json"), JSON.stringify({
    schema_version: 1, generated_at: "2026-09-14T00:00:00Z", evidence_fingerprint: "1".repeat(64),
    logo_candidates: [{ local_path: `${dir}/evidence/logo-candidates/04.png`, sha256: "2".repeat(64), provenance: "first_party_other", width: 1600, height: 433, measured_colors: [{ hex: "#FFFFFF", share: 1 }], sharpness: { value: 40, classification: "high" }, rank_score: 0.9 }],
  }));
  fs.writeFileSync(path.join(dir, "variants-v2", "variant-sheet.json"), JSON.stringify({
    generated_at: "2026-09-15", sheet: `${dir}/variants-v2/variant-sheet-all.png`,
    cells: { "1A": { letter: "1A", primary: "#C93B18", secondary: "#4A4238", text: "#FFFFFF", logo: `${dir}/fix/card/card-full-tight.png` }, "1B": { letter: "1B", primary: "#C93B18", secondary: "#000000", text: "#FFFFFF", logo: `${dir}/fix/card/card-full-tight.png` } },
  }));
  fs.writeFileSync(path.join(dir, "variants-v2", "variant-sheet-all.png"), "png");
  for (const name of ["readback-before", "dry", "apply", "readback-after"]) fs.writeFileSync(path.join(dir, "fix", "live-1B", `${name}.json`), JSON.stringify({ receipt: name }));
  fs.writeFileSync(path.join(dir, "fix", "live-1B", "proof.png"), "proof");
  const proofSha = crypto.createHash("sha256").update("proof").digest("hex");
  fs.writeFileSync(path.join(dir, "fix", "live-1B", "proof-branding.json"), JSON.stringify({ proof_path: "x/proof.png", proof_sha256: proofSha, logo_sha256: logoSha, rendered_at: "2026-09-16T03:15:26Z", rendered_colors: { primary: "#c93b18" } }));
  fs.writeFileSync(path.join(dir, "fix", "live-1B", "proof-validate.json"), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(dir, "fix", "live-1B", "gate-text-legibility.json"), JSON.stringify({ pass: false, verdict: "edit_distance_too_high" }));
  fs.writeFileSync(path.join(dir, "links", "catering-apply.json"), "{}");
  fs.writeFileSync(path.join(dir, "STATE.md"), "# state\nsome prose\n");
  const manifest = {
    run_id: "runs-prod-2026-09-14/fixture-location",
    generated_at: "2026-09-14T23:45Z",
    mode: "prose that has no typed home",
    location: { location_id: "loc_1", account_id: "acct_1", name: "Fixture (Reston)", address: "1428 North Point Village Center, Reston, VA 20194, USA", website: "https://example.com/ (note)", google_place_id: "ChIJ-fixture" },
    request: { id: "req_1", created_at: "2026-09-14T20:40:44Z", order_type: "full_order", offer_text: "20% Off", slack_thread_ts: "1789418445.935639 (channel C09MSM8MA9Y; noise)", quantities: { tap_cards: 10, tables: 10, bathroom_stalls: 6, wants_signage: true } },
    branding: { scope: "ACCOUNT acct_1 (four locations)", status: "APPLIED 2026-09-15", fable_decision: { path: "fable-decision.json", sha256: decisionSha, validated: true } },
    variant_sheet: { png: "variants/variant-sheet.png", json: "variants/variant-sheet.json", applied_letter: "1B", fable_default_letter: "A", applied_sheet: "v2", v2_png: "variants-v2/variant-sheet-all.png", v2_json: "variants-v2/variant-sheet.json" },
    links: { written: ["Catering -> https://example.com/catering"], held: ["Rewards"], not_found: ["events"] },
    signage: { figma_file: "file In-Store-Fulfillment-7", section_id: "2816:5", section_url: "https://www.figma.com/design/x?node-id=2816-5", band: "#C93B18 (7100 fills)", sheet_ids: { table: "2816:9" }, logos: "22 sticker fills -> fix/sticker.png (hash 76c720a5, FIT); POP Primary -> a.png (hash 037f55f5, FIT)", plan: "signage/plan.json" },
    notion: { page: "3d5c831c-671e-81f2-9521-ca351ff56f52", entry: 18, block_id: "3dcc831c-671e-81f7-ad71-fa74dc63d2bf", section: "Waiting" },
    open_for_travisse: ["(2) Menu link"],
    applied_update_2026_09_15: {
      decision: "Travisse picked variant sheet v2 cell 1B (2026-09-15) after asking for a black band.",
      cell: "variants-v2/variant-sheet.json cells['1B'] (row 1)",
      scope: "ACCOUNT acct_1 (one write covers all)",
      colors_after: { web_primary_color: "#C93B18", web_secondary_color: "#000000", web_text_color: "#FFFFFF", print_primary_color: "#C93B18", print_secondary_color: "#000000", print_text_color: "#FFFFFF", print_text_secondary_color: "#FFFFFF" },
      logo_file: "reston/fix/card/card-full-tight.png (1600x544, 36,611 B)",
      logo_attachment_id: "f6nziags7yhkmft601fx6gd8",
      gates: { interior: "0 ok", text_legibility_ocr: "FAIL edit distance 14", files: "reston/fix/live-1B/gate-*.json" },
      gate_override: { reason: "Travisse picked 1B knowing TRATTORIA is decorative at card size", gates_failed: ["render-legibility", "ocr"], approved_by: "Travisse", date: "2026-09-15" },
      figma: { section: "2816:5", pop_primary_logo: "037f55f5 (name-only) -> d0f56c53 (full, FIT)", sticker_logos: "22 x 76c720a5 unchanged" },
      notion: "entries 14 to 17 patched",
      slack: "slack-note.txt drafts updated (not posted)",
    },
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ business: "Fixture", city: "Reston", account_id: "acct_1" }));

  const run = migrateRun(dir);
  assert.deepEqual(validateRun(run), []);
  const request = run.request;
  assert.equal(request.request_id, "req_1");
  assert.equal(request.location_id, "loc_1");
  assert.equal(request.account_id, "acct_1");
  assert.equal(request.slack_thread_ts, "1789418445.935639");
  assert.equal(request.slack_channel, "C09MSM8MA9Y");
  assert.equal(request.website_url, "https://example.com/");
  assert.deepEqual((request.quantities as Record<string, unknown>).tables, 10);
  const write = run.write as Record<string, unknown>;
  assert.equal(write.status, "applied");
  assert.equal(write.scope, "account");
  assert.deepEqual(write.colors_after, manifest.applied_update_2026_09_15.colors_after);
  assert.equal(write.logo_attachment_id, "f6nziags7yhkmft601fx6gd8");
  assert.equal(write.logo_sha256, logoSha);
  assert.equal(write.logo_file_resolved, "fix/card/card-full-tight.png");
  assert.equal(write.gate_override, true);
  assert.equal((write.receipts as Record<string, Record<string, unknown>>).apply.path, "fix/live-1B/apply.json");
  const decision = run.decision as Record<string, unknown>;
  assert.equal(decision.decision_sha256, decisionSha);
  assert.equal(decision.manifest_sha256_matches, true);
  assert.deepEqual(decision.palette, DECISION.palette);
  const variants = run.variants as Record<string, unknown>;
  assert.equal(variants.applied_letter, "1B");
  assert.equal(variants.fable_default_letter, "A");
  assert.equal(variants.sheet_png, "variants-v2/variant-sheet-all.png");
  assert.equal((variants.cells as Record<string, Record<string, unknown>>)["1B"].secondary, "#000000");
  assert.equal((variants.cells as Record<string, Record<string, unknown>>)["1B"].logo, "fix/card/card-full-tight.png");
  const overrides = run.overrides as Array<Record<string, unknown>>;
  assert.deepEqual(overrides.map((item) => item.gate), ["render-legibility", "ocr", "fable_default_letter"]);
  assert.equal(overrides[0].decided_by, "Travisse");
  const gates = (run.gates as Record<string, unknown>).results as Array<Record<string, unknown>>;
  assert.equal(gates.find((gate) => gate.gate === "text-legibility")?.pass, false);
  const proofs = run.proofs as Record<string, unknown>;
  assert.equal(proofs.proof_png, "fix/live-1B/proof.png");
  assert.equal(proofs.proof_sha256, proofSha);
  assert.equal(proofs.proof_sha256_verified, true);
  assert.equal((proofs.validated as Record<string, unknown>).ok, true);
  const figma = run.figma as Record<string, unknown>;
  assert.equal(figma.section_node_id, "2816:5");
  assert.equal(figma.band, "#C93B18");
  assert.deepEqual(figma.logo_hashes, { sticker: "76c720a5", pop_primary: "d0f56c53" });
  const notion = run.notion as Record<string, unknown>;
  assert.equal(notion.page_id, "3d5c831c-671e-81f2-9521-ca351ff56f52");
  assert.equal(notion.block_id, "3dcc831c-671e-81f7-ad71-fa74dc63d2bf");
  assert.equal(notion.entry, 18);
  const links = run.links as Record<string, unknown>;
  assert.deepEqual(links.written, manifest.links.written);
  assert.deepEqual((links.receipts as Array<Record<string, unknown>>)[0].path, "links/catering-apply.json");
  // Lossless: the manifest, ledger and STATE are byte-for-byte under legacy.
  const legacy = run.legacy as Record<string, unknown>;
  assert.deepEqual(legacy.manifest, manifest);
  assert.equal(legacy.manifest_path, path.join(dir, "manifest.json"));
  assert.deepEqual(legacy.ledger, { business: "Fixture", city: "Reston", account_id: "acct_1" });
  assert.equal(legacy.state_markdown, "# state\nsome prose\n");
  assert.equal((run.state as Record<string, unknown>).cursor, "migrated");
  assert.throws(() => migrateRun(dir), /already exists/);
  migrateRun(dir, { force: true });
  assert.equal(fs.existsSync(path.join(dir, "run.json.bak")), true);
});

test("migrate marks a run applied from an apply receipt alone (Denise's live-q shape) and hashes the receipt's logo file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-receipt-"));
  const dir = path.join(root, "runs-prod-2026-09-08", "denises-delicacies-philadelphia");
  fs.mkdirSync(path.join(dir, "fix", "live-q"), { recursive: true });
  const logoBytes = Buffer.from("denise-card-notagline");
  fs.writeFileSync(path.join(dir, "fix", "card-notagline-1600.png"), logoBytes);
  const logoSha = crypto.createHash("sha256").update(logoBytes).digest("hex");
  const effective = {
    facebook_url: "https://www.facebook.com/DenisesDelicacies", instagram_url: "https://www.instagram.com/cakesbydenises",
    web_primary_color: "#8D4CED", web_secondary_color: "#6416D7", web_text_color: "#FFFFFF",
    print_primary_color: "#8D4CED", print_secondary_color: "#6416D7", print_text_color: "#FFFFFF", print_text_secondary_color: "#FFFFFF",
    logo_attachment_id: "xsmv19d7a5tacq5s225636ho", logo_url: "https://boostly-attachments.s3.us-west-2.amazonaws.com/x.png", logo_filename: "card-notagline-1600.png",
  };
  fs.writeFileSync(path.join(dir, "fix", "live-q", "before.json"), JSON.stringify({ effective_branding: { ...effective, logo_attachment_id: null } }));
  fs.writeFileSync(path.join(dir, "fix", "live-q", "dry.json"), JSON.stringify({ dry_run: true, after: effective }));
  fs.writeFileSync(path.join(dir, "fix", "live-q", "apply.json"), JSON.stringify({
    success_result: { success: true, errors: null }, selected_scope: "account", scope_reason: "Forced by --scope account.",
    readback: { selected_scope: "account", location: { id: "loc_d" }, account_branding: effective, override_branding: {}, effective_branding: effective },
  }));
  // Manifest in the older flat shape: no applied_update_* key at all.
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    run_id: "runs-prod-2026-09-08/denises-delicacies-philadelphia", generated_at: "2026-09-08T16:00Z",
    location_id: "loc_d", account_id: "acct_d", location_name: "Denise's Delicacies (Philadelphia)", address: "1 St, Philadelphia, PA 19100, USA",
    write_scope: "account", production_write: { status: "applied", applied_at: "2026-09-08" }, applied_colors: { web_primary_color: "#8D4CED" },
  }));
  const run = migrateRun(dir);
  assert.deepEqual(validateRun(run), []);
  const write = run.write as Record<string, unknown>;
  assert.equal(write.status, "applied");
  assert.equal(write.source, "migrated:apply_receipt");
  assert.equal(write.scope, "account");
  assert.equal(write.logo_attachment_id, "xsmv19d7a5tacq5s225636ho");
  assert.equal(write.logo_filename, "card-notagline-1600.png");
  assert.equal(write.logo_file, "fix/card-notagline-1600.png");
  assert.equal(write.logo_sha256, logoSha);
  assert.equal((write.colors_after as Record<string, unknown>).web_secondary_color, "#6416D7");
  const receipts = write.receipts as Record<string, Record<string, unknown> | null>;
  assert.equal(receipts.apply?.path, "fix/live-q/apply.json");
  assert.equal(receipts.readback_before?.path, "fix/live-q/before.json");
  // A downloaded copy next to the receipt wins over the run-dir file, and production-readback.json wins over the receipt.
  const cdnBytes = Buffer.from("cdn-copy");
  fs.writeFileSync(path.join(dir, "fix", "live-q", "applied-logo.png"), cdnBytes);
  fs.writeFileSync(path.join(dir, "production-readback.json"), JSON.stringify({ location: { id: "loc_d" }, effective_branding: { ...effective, logo_attachment_id: "newer_attachment", logo_filename: null } }));
  const again = migrateRun(dir, { force: true }).write as Record<string, unknown>;
  assert.equal(again.logo_attachment_id, "newer_attachment");
  assert.equal(again.logo_filename, "card-notagline-1600.png");
  assert.equal(again.logo_file, "fix/live-q/applied-logo.png");
  assert.equal(again.logo_sha256, crypto.createHash("sha256").update(cdnBytes).digest("hex"));
});

test("variants block from a fresh sheet json derives Fable's default letter and keeps paths run-relative", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-"));
  fs.mkdirSync(path.join(root, "variants"));
  const sheet = {
    generated_at: "2026-09-16T00:00:00Z", business_name: "Fixture", decision: path.join(root, "decision.json"),
    primary: "#8B2C1D", text: "#FFFFFF", chosen_secondary: { hex: "#E8E4DD", source: "fable" }, sheet: path.join(root, "variants", "variant-sheet.png"),
    rows: [{ key: "knockout", label: "card knockout", logo: path.join(root, "fix", "k.png") }, { key: "words_only", label: "words only", logo: path.join(root, "fix", "w.png") }],
    columns: [{ index: 0, hex: "#E8E4DD", source: "fable" }, { index: 1, hex: "#E65F28", source: "logo_ink" }],
    cells: {
      A: { letter: "A", row: "knockout", primary: "#8B2C1D", secondary: "#E8E4DD", logo: path.join(root, "fix", "k.png"), card: path.join(root, "variants", "card-A.png") },
      B: { letter: "B", row: "knockout", primary: "#8B2C1D", secondary: "#E65F28", logo: path.join(root, "fix", "k.png"), card: path.join(root, "variants", "card-B.png") },
      S: { letter: "S", row: "words_only", primary: "#8B2C1D", secondary: "#E65F28", logo: path.join(root, "fix", "w.png"), card: path.join(root, "variants", "card-S.png") },
    },
    contract: "Reviewer answers with one letter.",
  };
  fs.writeFileSync(path.join(root, "variants", "variant-sheet.json"), JSON.stringify(sheet));
  const block = variantsBlockFromSheet(path.join(root, "variants", "variant-sheet.json"), root);
  assert.equal(block.fable_default_letter, "A");
  assert.equal(block.sheet_png, "variants/variant-sheet.png");
  assert.equal(block.sheet_json, "variants/variant-sheet.json");
  assert.equal((block.cells as Record<string, Record<string, unknown>>).S.logo, "fix/w.png");
  assert.equal(block.applied_letter, null);
  assert.deepEqual(validateBlock("variants", block), []);
});

test("variants block accepts chosen_secondary as a plain hex string (current variant-sheet.mjs shape)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-str-"));
  fs.mkdirSync(path.join(root, "variants"));
  const sheet = {
    chosen_secondary: "#e65f28", sheet: path.join(root, "variants", "variant-sheet.png"),
    rows: [{ key: "knockout", label: "card knockout", logo: "k.png" }],
    cells: { A: { letter: "A", row: "knockout", secondary: "#E8E4DD" }, B: { letter: "B", row: "knockout", secondary: "#E65F28" } },
  };
  fs.writeFileSync(path.join(root, "variants", "variant-sheet.json"), JSON.stringify(sheet));
  const block = variantsBlockFromSheet(path.join(root, "variants", "variant-sheet.json"), root);
  assert.equal(block.fable_default_letter, "B");
  assert.equal(block.chosen_secondary, "#e65f28");
});

test("a FulfillmentResult renders from run.json (plan + links + derived artifacts) without retyping", () => {
  const dir = tmpRun();
  const plan = buildFulfillmentPlan({
    request: { request_key: "v2:req_1", canonical_thread_ts: "1783960267.741929", fulfillment_request_id: "req_1", badge_quantity: null, badge_quantity_status: "missing" },
    location: { location_id: "loc_1", location_name: "Small Town Tavern", account_id: "acct_1", account_name: "Small Town Tavern", website_url: "https://smalltowntavernpa.com", is_general: false, branding_scope: "account" },
    discovery_report: { category_results: [], proposed_location_updates: [], proposed_touchpoint_events: [], manual_review_items: [] },
  });
  setBlock(dir, "plan", { status: "ready", plan, dedupe: { links_already_processed: false } });
  setBlock(dir, "links", { plan_id: plan.plan_id, applied: false, execution: [] });
  setBlock(dir, "notion", { page_id: "3d5c831c-671e-81f2-9521-ca351ff56f52" });
  const result = fulfillmentResultFromRun(readRun(dir));
  const artifacts = result.artifacts as Record<string, unknown>;
  assert.equal(artifacts.boostly_account_url, "https://new.boostly.com/admin/accounts/acct_1");
  assert.equal(artifacts.notion_review_url, "https://www.notion.so/3d5c831c671e81f29521ca351ff56f52");
  assert.equal(artifacts.branding_outcome, "held");
  assert.deepEqual(result.execution, []);
  assert.equal((result.plan as Record<string, unknown>).plan_id, plan.plan_id);
});

test("stripNote drops a trailing parenthetical only", () => {
  assert.equal(stripNote("variants/variant-sheet.png (superseded by v2)"), "variants/variant-sheet.png");
  assert.equal(stripNote("fix/card.png (1600x544, 36,611 B, sha f199 (cdn))"), "fix/card.png");
  assert.equal(stripNote("plain"), "plain");
  assert.equal(stripNote(null), null);
});
