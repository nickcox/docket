import assert from "node:assert/strict";
import test from "node:test";
import checks from "../../.docket/checks.json" with { type: "json" };

test("R29: repository checks declare types as fast and tests as full", () => {
  assert.equal(checks.version, 1);
  assert.deepEqual(checks.fast, [
    {
      name: "types",
      command: ["npm", "run", "check"],
      timeoutMs: 120000,
      goalMs: 10000,
    },
  ]);
  assert.deepEqual(checks.full, [
    {
      name: "tests",
      command: ["npm", "test"],
      timeoutMs: 300000,
    },
  ]);
});
