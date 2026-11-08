import assert from "node:assert/strict";
import { test } from "node:test";
import { commandRunner, gitEnvironment } from "../../src/adapters/command.ts";

test("R31/R32 failed spawn, killed and truncated command output are incomplete, never successful reads", async () => {
  const missing = await commandRunner()("/docket-test-no-such-executable", [], process.cwd());
  assert.equal(missing.complete, false); assert.equal(missing.code, null);
  const killed = await commandRunner({ timeoutMs: 100 })(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], process.cwd());
  assert.equal(killed.complete, false); assert.equal(killed.code, null);
  const truncated = await commandRunner({ maxBuffer: 64 })(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000))'], process.cwd());
  assert.equal(truncated.complete, false);
});

test("R32 explicit repository paths cannot be redirected by inherited Git overrides", () => {
  assert.deepEqual(gitEnvironment({ PATH: "/bin", GIT_DIR: "/other", GIT_WORK_TREE: "/other", GIT_CONFIG_COUNT: "1", GIT_INDEX_FILE: "/other/index" }), { PATH: "/bin", GIT_TERMINAL_PROMPT: "0" });
});
