#!/usr/bin/env node
// Chrome profile fallback (2026-10-14): when the extension reports no profile name, the run may go
// on only when exactly one connected browser is on this computer AND Chrome's Local State has
// exactly one profile named like the required one. The name match stays the first path.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BROWSER_RESULTS_FORMAT,
  CLAUDE_CHROME_PROVIDER,
  FixtureStore,
  PROFILE_RESOLUTION_EXTENSION,
  PROFILE_RESOLUTION_LOCAL_STATE,
  PROFILE_RESOLUTION_USER_CONFIRMED,
  chromeProfileResolutionErrors,
  connectedBrowserRows,
  loadBrowserResults,
  resolveChromeProfileViaLocalState,
  resolveLocalStateProfile,
  selectSingleLocalBrowser,
} from "./discover-links.mjs";
import { initResults, probeLocalStateProfiles } from "./claude-chrome-browser.mjs";
import { validateBrowserRuntime } from "./validate-discovery-report.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chrome-profile-fallback-"));

function writeLocalState(dir, profiles) {
  const info_cache = {};
  for (const [directory, name] of Object.entries(profiles)) info_cache[directory] = { name, user_name: "" };
  const file = path.join(dir, "Local State");
  fs.writeFileSync(file, JSON.stringify({ profile: { info_cache, last_used: Object.keys(profiles)[0] } }));
  return file;
}

const oneBrowser = { browsers: [{ deviceId: "dev-1", name: "Browser 1", onThisComputer: true, type: "extension" }] };
const twoBrowsers = { browsers: [
  { deviceId: "dev-1", name: "Browser 1", onThisComputer: true, type: "extension" },
  { deviceId: "dev-2", name: "Browser 2", onThisComputer: true, type: "extension" },
] };
const namedBrowser = { browsers: [{ deviceId: "dev-9", name: "Browser 1", onThisComputer: true, type: "extension", metadata: { profileName: "Boostly.com" } }] };

const validRuntime = (resolution) => ({
  fulfillment_mode: true,
  browser_provider: CLAUDE_CHROME_PROVIDER,
  required_browser_provider: CLAUDE_CHROME_PROVIDER,
  browser_provider_preflighted: true,
  chrome_profile_requested: "Boostly.com",
  chrome_profile_resolved: "Boostly.com",
  chrome_profile_resolution: resolution,
  browser_needed: [],
});
const validatorOptions = { requiredBrowserProvider: CLAUDE_CHROME_PROVIDER, requiredChromeProfile: "Boostly.com" };

test("name path still passes: extension reports the profile name, no Local State is read", async () => {
  const dir = tmp();
  const file = path.join(dir, "browser-results.json");
  const results = initResults(file, { profile: "Boostly.com", env: {} });
  assert.equal(results.chrome_profile_resolved, "Boostly.com");
  assert.deepEqual(results.chrome_profile_resolution, { method: PROFILE_RESOLUTION_EXTENSION });
  assert.deepEqual(chromeProfileResolutionErrors(results.chrome_profile_resolution), []);
  // Reports written before the resolution object existed stay valid.
  assert.deepEqual(validateBrowserRuntime(validRuntime(undefined), validatorOptions), []);
  assert.deepEqual(validateBrowserRuntime(validRuntime({ method: PROFILE_RESOLUTION_EXTENSION }), validatorOptions), []);
  // A lower-case extension name still passes the name compare.
  const lower = initResults(path.join(dir, "lower.json"), { profile: "boostly.com", env: {} });
  const store = new FixtureStore("", "loc-1", { browserProvider: CLAUDE_CHROME_PROVIDER, chromeProfile: "boostly", browserResultsFile: path.join(dir, "lower.json") });
  await store.preflightBrowserProvider();
  assert.equal(store.browserProviderPreflighted, true);
  assert.equal(store.chromeProfileResolved(), lower.chrome_profile_resolved);
  assert.deepEqual(store.chromeProfileResolution(), { method: PROFILE_RESOLUTION_EXTENSION });
  // Codex-extension selection by name is untouched and never consults Local State.
  const picked = [];
  const agent = { browsers: { list: async () => namedBrowser.browsers.map((b) => ({ ...b, id: b.deviceId })), get: (id) => { picked.push(id); return { id }; } } };
  const codex = new FixtureStore("", "loc-1", { browserProvider: "codex-extension", chromeProfile: "boostly", chromeLocalStateFile: path.join(dir, "does-not-exist") });
  await codex.selectCodexExtensionBrowser(agent);
  assert.deepEqual(picked, ["dev-9"]);
  assert.equal(codex.chromeProfileResolved(), "Boostly.com");
  assert.deepEqual(codex.chromeProfileResolution(), { method: PROFILE_RESOLUTION_EXTENSION });
});

test("fallback passes: one browser on this computer and one Local State profile named boostly.com", async () => {
  const dir = tmp();
  const localState = writeLocalState(dir, { Default: "boostly.com" });
  const env = { BOOSTLY_CHROME_PROFILE: "Default" };
  const file = path.join(dir, "browser-results.json");
  const results = initResults(file, { profile: "Boostly.com", profileSource: "local-state", browsers: oneBrowser, localStateFile: localState, env });
  assert.equal(results.chrome_profile_resolved, "Boostly.com", "the canonical name is recorded, never the directory");
  assert.deepEqual(results.chrome_profile_resolution, {
    method: PROFILE_RESOLUTION_LOCAL_STATE,
    directory: "Default",
    local_state_name: "boostly.com",
    device_id: "dev-1",
    browser_label: "Browser 1",
  });
  assert.deepEqual(chromeProfileResolutionErrors(results.chrome_profile_resolution), []);
  assert.equal(loadBrowserResults(file).chrome_profile_resolution.device_id, "dev-1");
  assert.deepEqual(validateBrowserRuntime(validRuntime(results.chrome_profile_resolution), validatorOptions), []);

  const store = new FixtureStore("", "loc-1", { browserProvider: CLAUDE_CHROME_PROVIDER, chromeProfile: "boostly", browserResultsFile: file });
  await store.preflightBrowserProvider();
  assert.equal(store.browserProviderPreflighted, true);
  assert.equal(store.chromeProfileResolved(), "Boostly.com");
  assert.equal(store.chromeProfileResolution().method, PROFILE_RESOLUTION_LOCAL_STATE);

  // --device-id instead of the browsers file, and no env directory, both pass too.
  const byId = initResults(path.join(dir, "by-id.json"), { profile: "Boostly.com", profileSource: "local-state", deviceId: "dev-1", browserLabel: "Browser 1", localStateFile: localState, env: {} });
  assert.equal(byId.chrome_profile_resolution.device_id, "dev-1");
  assert.equal(byId.chrome_profile_resolution.directory, "Default");

  // The probe shows directory and name only.
  assert.deepEqual(probeLocalStateProfiles({ localStateFile: localState, env }), {
    local_state_file: localState,
    profile_count: 1,
    profiles: [{ directory: "Default", name: "boostly.com" }],
    env_profile_dir: "Default",
  });

  // Codex-extension selection takes the same fallback when no browser reports a name.
  const picked = [];
  const agent = { browsers: { list: async () => oneBrowser.browsers.map((b) => ({ ...b, id: b.deviceId })), get: (id) => { picked.push(id); return { id }; } } };
  const codex = new FixtureStore("", "loc-1", { browserProvider: "codex-extension", chromeProfile: "boostly", chromeLocalStateFile: localState });
  await codex.selectCodexExtensionBrowser(agent);
  assert.deepEqual(picked, ["dev-1"]);
  assert.equal(codex.chromeProfileResolved(), "Boostly.com");
  assert.equal(codex.chromeProfileResolution().method, PROFILE_RESOLUTION_LOCAL_STATE);
  assert.equal(codex.chromeProfileResolution().directory, "Default");
});

test("fallback fails with two Local State profiles", async () => {
  const dir = tmp();
  const localState = writeLocalState(dir, { Default: "boostly.com", "Profile 1": "Travisse" });
  assert.throws(() => resolveLocalStateProfile({ expected: "Boostly.com", localStateFile: localState, env: {} }), /lists 2 profiles/);
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profile: "Boostly.com", profileSource: "local-state", browsers: oneBrowser, localStateFile: localState, env: {} }),
    /chrome_profile_fallback_refused.*2 profiles/,
  );
  assert.equal(fs.existsSync(path.join(dir, "r.json")), false, "no results file is written on refusal");
  const agent = { browsers: { list: async () => oneBrowser.browsers.map((b) => ({ ...b, id: b.deviceId })), get: () => { throw new Error("must not bind"); } } };
  const codex = new FixtureStore("", "loc-1", { browserProvider: "codex-extension", chromeProfile: "boostly", chromeLocalStateFile: localState });
  await assert.rejects(() => codex.selectCodexExtensionBrowser(agent), /2 profiles/);
});

test("fallback fails with a wrong profile name or a wrong BOOSTLY_CHROME_PROFILE directory", () => {
  const dir = tmp();
  const wrongName = writeLocalState(dir, { Default: "Travisse" });
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profile: "Boostly.com", profileSource: "local-state", browsers: oneBrowser, localStateFile: wrongName, env: {} }),
    /only Chrome profile is named 'Travisse'/,
  );
  const rightName = writeLocalState(fs.mkdtempSync(path.join(dir, "x")), { "Profile 3": "Boostly.com" });
  assert.throws(
    () => resolveLocalStateProfile({ expected: "Boostly.com", localStateFile: rightName, env: { BOOSTLY_CHROME_PROFILE: "Default" } }),
    /BOOSTLY_CHROME_PROFILE is 'Default' but the only Chrome profile directory is 'Profile 3'/,
  );
  assert.deepEqual(resolveLocalStateProfile({ expected: "Boostly.com", localStateFile: rightName, env: { BOOSTLY_CHROME_PROFILE: "Profile 3" } }), {
    directory: "Profile 3", local_state_name: "Boostly.com", local_state_file: rightName,
  });
});

test("fallback fails with two connected browsers, none, or a device id that is not the local one", async () => {
  const dir = tmp();
  const localState = writeLocalState(dir, { Default: "boostly.com" });
  assert.throws(() => selectSingleLocalBrowser(twoBrowsers), /expected exactly one connected browser on this computer, found 2 of 2/);
  assert.throws(() => selectSingleLocalBrowser({ browsers: [{ deviceId: "dev-3", name: "Browser 1", onThisComputer: false }] }), /found 0 of 1/);
  assert.throws(() => selectSingleLocalBrowser(namedBrowser), /reports a profile name/);
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profile: "Boostly.com", profileSource: "local-state", browsers: twoBrowsers, localStateFile: localState, env: {} }),
    /found 2 of 2/,
  );
  assert.throws(
    () => resolveChromeProfileViaLocalState({ expected: "Boostly.com", browsers: oneBrowser, deviceId: "dev-2", localStateFile: localState, env: {} }),
    /--device-id 'dev-2' is not the connected browser/,
  );
  assert.throws(
    () => resolveChromeProfileViaLocalState({ expected: "Boostly.com", localStateFile: localState, env: {} }),
    /needs the selected browser's device id/,
  );
  const agent = { browsers: { list: async () => twoBrowsers.browsers.map((b) => ({ ...b, id: b.deviceId })), get: () => { throw new Error("must not bind"); } } };
  const codex = new FixtureStore("", "loc-1", { browserProvider: "codex-extension", chromeProfile: "boostly", chromeLocalStateFile: localState });
  await assert.rejects(() => codex.selectCodexExtensionBrowser(agent), /2 of 2 are on this computer/);
});

test("validator and results loader refuse a local-state resolution without device id and directory", async () => {
  const dir = tmp();
  assert.deepEqual(
    validateBrowserRuntime(validRuntime({ method: PROFILE_RESOLUTION_LOCAL_STATE, local_state_name: "boostly.com" }), validatorOptions),
    ["chrome_profile_resolution_missing:device_id", "chrome_profile_resolution_missing:directory"],
  );
  assert.deepEqual(
    validateBrowserRuntime(validRuntime({ method: "guessed" }), validatorOptions),
    ["chrome_profile_resolution_unknown_method:guessed"],
  );
  // The name compare still runs first and still fails on another profile, whatever the method.
  assert.deepEqual(
    validateBrowserRuntime({ ...validRuntime({ method: PROFILE_RESOLUTION_LOCAL_STATE, directory: "Default", device_id: "dev-1" }), chrome_profile_resolved: "Travisse" }, validatorOptions),
    ["chrome_profile_mismatch:expected=Boostly.com:actual=Travisse"],
  );
  const file = path.join(dir, "browser-results.json");
  fs.writeFileSync(file, JSON.stringify({
    format: BROWSER_RESULTS_FORMAT, provider: CLAUDE_CHROME_PROVIDER, chrome_profile_resolved: "Boostly.com",
    chrome_profile_resolution: { method: PROFILE_RESOLUTION_LOCAL_STATE, directory: "Default" }, results: {},
  }));
  assert.throws(() => loadBrowserResults(file), /chrome_profile_resolution: chrome_profile_resolution_missing:device_id/);
  const store = new FixtureStore("", "loc-1", { browserProvider: CLAUDE_CHROME_PROVIDER, chromeProfile: "boostly", browserResultsFile: file });
  await assert.rejects(() => store.preflightBrowserProvider(), /chrome_profile_resolution_missing:device_id/);
});

// Third path (2026-10-15): Travisse's Mac has 16 Chrome profiles, so the Local State fallback can
// never pass there. He confirmed in chat which connected device is the Boostly.com profile.
const liveBrowsers = [
  { deviceId: "82f89fc7-1beb-407a-836a-66b4c38cc2ec", name: "boostly browser", osPlatform: "macOS", connectedAt: 1792081190994, isLocal: true },
  { deviceId: "adb3f31a-2ecd-4bc7-a020-ab3a2b80f3a9", name: "Browser 2", osPlatform: "macOS", connectedAt: 1792080625028, isLocal: true, inUse: true },
];

function writeConfirmation(dir, overrides = {}) {
  const file = path.join(dir, "chrome-confirmed-device.json");
  fs.writeFileSync(file, JSON.stringify({
    device_id: "82f89fc7-1beb-407a-836a-66b4c38cc2ec",
    browser_label: "boostly browser",
    profile: "Boostly.com",
    confirmed_by: "travisse",
    confirmed_note: "the claude browser extension in the boostly profile should be connected to this same account",
    confirmed_at: "2026-10-15T16:00:00.000Z",
    ...overrides,
  }), { mode: 0o600 });
  return file;
}

test("connectedBrowserRows reads the current list_connected_browsers shape (isLocal, name)", () => {
  const rows = connectedBrowserRows(liveBrowsers);
  assert.deepEqual(rows.map((row) => [row.deviceId, row.label, row.onThisComputer]), [
    ["82f89fc7-1beb-407a-836a-66b4c38cc2ec", "boostly browser", true],
    ["adb3f31a-2ecd-4bc7-a020-ab3a2b80f3a9", "Browser 2", true],
  ]);
  assert.equal(connectedBrowserRows([{ deviceId: "x", name: "remote", isLocal: false }])[0].onThisComputer, false);
  // Two local browsers: the Local State fallback still refuses.
  assert.throws(() => selectSingleLocalBrowser(liveBrowsers), /found 2 of 2/);
});

test("user-confirmed passes with the confirmed device id, from flags or from the confirmation file", () => {
  const dir = tmp();
  const confirmationFile = writeConfirmation(dir);
  const env = { BOOSTLY_CHROME_CONFIRMED_DEVICE: confirmationFile };
  const fromFile = initResults(path.join(dir, "a.json"), { profileSource: "user-confirmed", browsers: liveBrowsers, env });
  assert.equal(fromFile.chrome_profile_resolved, "Boostly.com");
  assert.equal(fromFile.chrome_profile_resolution.method, PROFILE_RESOLUTION_USER_CONFIRMED);
  assert.equal(fromFile.chrome_profile_resolution.device_id, "82f89fc7-1beb-407a-836a-66b4c38cc2ec");
  assert.equal(fromFile.chrome_profile_resolution.browser_label, "boostly browser");
  assert.equal(fromFile.chrome_profile_resolution.confirmed_by, "travisse");
  assert.equal(fromFile.chrome_profile_resolution.confirmed_at, "2026-10-15T16:00:00.000Z");
  assert.deepEqual(chromeProfileResolutionErrors(fromFile.chrome_profile_resolution), []);
  assert.deepEqual(validateBrowserRuntime(validRuntime(fromFile.chrome_profile_resolution), validatorOptions), []);
  assert.equal(loadBrowserResults(path.join(dir, "a.json")).chrome_profile_resolved, "Boostly.com");

  const fromFlags = initResults(path.join(dir, "b.json"), {
    profile: "Boostly.com", profileSource: "user-confirmed", deviceId: "82f89fc7-1beb-407a-836a-66b4c38cc2ec",
    browserLabel: "boostly browser", confirmedBy: "travisse", confirmedNote: "connected to this same account",
    env: { BOOSTLY_CHROME_CONFIRMED_DEVICE: path.join(dir, "absent.json") },
  });
  assert.equal(fromFlags.chrome_profile_resolution.device_id, "82f89fc7-1beb-407a-836a-66b4c38cc2ec");
  assert.ok(fromFlags.chrome_profile_resolution.confirmed_at);
});

test("user-confirmed refuses a device id other than the confirmed one, and a device not connected locally", () => {
  const dir = tmp();
  const confirmationFile = writeConfirmation(dir);
  const env = { BOOSTLY_CHROME_CONFIRMED_DEVICE: confirmationFile };
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profileSource: "user-confirmed", deviceId: "adb3f31a-2ecd-4bc7-a020-ab3a2b80f3a9", browserLabel: "Browser 2", confirmedBy: "travisse", env }),
    /is not the confirmed device/,
  );
  assert.equal(fs.existsSync(path.join(dir, "r.json")), false);
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profileSource: "user-confirmed", browsers: [liveBrowsers[1]], env }),
    /is not among the connected browsers/,
  );
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profileSource: "user-confirmed", browsers: [{ ...liveBrowsers[0], isLocal: false }], env }),
    /not on this computer/,
  );
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profileSource: "user-confirmed", env: { BOOSTLY_CHROME_CONFIRMED_DEVICE: writeConfirmation(dir, { profile: "Travisse" }) } }),
    /confirms profile 'Travisse'/,
  );
  assert.throws(
    () => initResults(path.join(dir, "r.json"), { profileSource: "user-confirmed", env: { BOOSTLY_CHROME_CONFIRMED_DEVICE: path.join(dir, "absent.json") } }),
    /no --device-id and no confirmation file/,
  );
});

test("validator rejects a user-confirmed resolution missing device_id, browser_label, confirmed_by or confirmed_at", () => {
  const full = { method: PROFILE_RESOLUTION_USER_CONFIRMED, device_id: "dev-1", browser_label: "boostly browser", confirmed_by: "travisse", confirmed_at: "2026-10-15T16:00:00.000Z" };
  assert.deepEqual(validateBrowserRuntime(validRuntime(full), validatorOptions), []);
  for (const key of ["device_id", "browser_label", "confirmed_by", "confirmed_at"]) {
    const { [key]: _omit, ...partial } = full;
    assert.deepEqual(validateBrowserRuntime(validRuntime(partial), validatorOptions), [`chrome_profile_resolution_missing:${key}`]);
  }
  assert.deepEqual(
    validateBrowserRuntime(validRuntime({ method: PROFILE_RESOLUTION_USER_CONFIRMED }), validatorOptions),
    ["device_id", "browser_label", "confirmed_by", "confirmed_at"].map((key) => `chrome_profile_resolution_missing:${key}`),
  );
});
