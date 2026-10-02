#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  FixtureStore,
  defaultBrowserProvider,
  resolveBrowserRuntime,
} from "./discover-links.mjs";

assert.equal(defaultBrowserProvider({ "browser-provider": "codex-extension" }), "codex-extension");
assert.equal(
  resolveBrowserRuntime({
    fulfillmentMode: true,
    "browser-provider": "codex-extension",
  }).requiredBrowserProvider,
  "codex-extension",
);
assert.throws(
  () => resolveBrowserRuntime({ fulfillmentMode: true, "browser-provider": "playwright" }),
  /fulfillment requires 'codex-extension'/,
);

const browser = {
  tabs: {
    finalize: async () => undefined,
  },
};
const agent = {
  browsers: {
    list: async () => [{
      id: "boostly-browser",
      type: "extension",
      metadata: { profileName: "Boostly.com" },
    }],
    get: async (id) => {
      assert.equal(id, "boostly-browser");
      return browser;
    },
  },
};
const store = new FixtureStore("", "location-1", {
  browserProvider: "codex-extension",
  chromeProfile: "boostly",
  codexAgent: agent,
});
await store.preflightBrowserProvider();
assert.equal(store.browserProviderPreflighted, true);
assert.equal(store.requestedChromeProfileName, "Boostly.com");
assert.equal(store.codexExtensionProfileName, "Boostly.com");
await store.close();

const wrongProfileStore = new FixtureStore("", "location-1", {
  browserProvider: "codex-extension",
  chromeProfile: "boostly",
  codexAgent: {
    browsers: {
      list: async () => [{
        id: "personal-browser",
        type: "extension",
        metadata: { profileName: "Travisse" },
      }],
      get: async () => browser,
    },
  },
});
await assert.rejects(
  () => wrongProfileStore.preflightBrowserProvider(),
  /No Codex Chrome extension session matches required profile 'Boostly.com'/,
);

console.log("browser-provider: ok");
