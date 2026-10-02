import assert from "node:assert/strict";
import test from "node:test";
import { fetchDataForSeoWithRetry } from "./discover-links.mjs";

test("retries a transient search-engine task failure once", async () => {
  let calls = 0;
  const response = await fetchDataForSeoWithRetry([{}], "test", {
    pause: async () => {},
    request: async () => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: ++calls === 1 ? 40101 : 20000 }] })),
  });
  assert.equal(calls, 2);
  assert.equal(response.raw.tasks[0].status_code, 20000);
});

test("does not retry billing failures or multiple task responses", async () => {
  for (const tasks of [[{ status_code: 40200 }], [{ status_code: 40101 }, { status_code: 20000 }]]) {
    let calls = 0;
    await fetchDataForSeoWithRetry([{}], "test", {
      pause: async () => {},
      request: async () => { calls++; return new Response(JSON.stringify({ status_code: 20000, tasks })); },
    });
    assert.equal(calls, 1);
  }
});
