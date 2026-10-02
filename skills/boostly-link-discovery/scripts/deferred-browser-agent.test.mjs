import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferredBrowserAgent } from "./deferred-browser-agent.mjs";

test("browser calls run only when pumped, in the current invocation context", async () => {
  const context = new AsyncLocalStorage();
  const seen = [];
  const bridge = createDeferredBrowserAgent({ browsers: { list: async () => { seen.push(context.getStore()); return [{ id: "verified-profile" }]; } } });
  let done = false;
  const job = context.run("old-invocation", async () => {
    const profiles = await bridge.agent.browsers.list();
    assert.equal(profiles[0].id, "verified-profile");
    done = true;
  });
  assert.deepEqual(seen, []);
  await context.run("current-invocation", () => bridge.pump(() => done, 1000));
  await job;
  assert.deepEqual(seen, ["current-invocation"]);
});

test("provider failures propagate to discovery without inventing evidence", async () => {
  const bridge = createDeferredBrowserAgent({ browsers: { list: async () => { throw new Error("extension unavailable"); } } });
  let done = false;
  const job = assert.rejects(bridge.agent.browsers.list(), /extension unavailable/).finally(() => { done = true; });
  await bridge.pump(() => done, 1000);
  await job;
});
