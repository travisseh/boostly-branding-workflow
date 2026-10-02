import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { runtimeEnvironment } from "./discover-links.mjs";

test("shell runtime passes its environment to child commands", () => {
  assert.equal(runtimeEnvironment(), process.env);
});

test("extension runtime without process inherits the child host environment", () => {
  const environment = vm.runInNewContext(`(${runtimeEnvironment.toString()})()`);
  assert.equal(environment, undefined);
});
