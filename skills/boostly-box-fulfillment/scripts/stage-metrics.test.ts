import assert from "node:assert/strict";
import test from "node:test";

import { StageRecorder } from "./stage-metrics.ts";

test("stage recorder emits explicit duration and counters", async () => {
  const recorder = new StageRecorder();
  recorder.start("slack_parse");
  recorder.increment("slack_parse", "messages", 4);
  recorder.increment("slack_parse", "paired_requests", 2);
  recorder.finish("slack_parse");
  await recorder.measure("plan_build", async () => ({ ok: true }));
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.stages.length, 2);
  assert.deepEqual(snapshot.stages[0].counters, { messages: 4, paired_requests: 2 });
  assert(snapshot.stages.every((stage) => stage.duration_ms >= 0));
});
