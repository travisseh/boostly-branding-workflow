import assert from "node:assert/strict";
import test from "node:test";
import { dataForSeoCredentials } from "./dataforseo-credentials.mjs";

test("discovery uses the configured Boostly account", () => {
  assert.deepEqual(dataForSeoCredentials({}, () => "test-secret"), { login: "travisse@boostly.com", password: "test-secret" });
});
test("alternate credentials cannot silently replace the configured account", () => {
  for (const args of [{ dataForSeoLogin: "other@example.com" }, { "dataforseo-password": "wrong" }]) {
    assert.throws(() => dataForSeoCredentials(args, () => "test-secret"), /refusing alternate/);
  }
});
test("empty or unavailable credentials fail closed", () => {
  assert.throws(() => dataForSeoCredentials({}, () => ""), /empty/);
  assert.throws(() => dataForSeoCredentials({}, () => { throw new Error("unavailable"); }), /unavailable/);
});
test("ambient credentials from other projects are ignored", () => {
  const previous = process.env.DATAFORSEO_LOGIN;
  process.env.DATAFORSEO_LOGIN = "other@example.com";
  try { assert.equal(dataForSeoCredentials({}, () => "test-secret").login, "travisse@boostly.com"); }
  finally { if (previous === undefined) delete process.env.DATAFORSEO_LOGIN; else process.env.DATAFORSEO_LOGIN = previous; }
});
