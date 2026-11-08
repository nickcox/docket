import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { catalogue } from "../../src/catalog.ts";
import type { Envelope } from "../../src/response.ts";

const entry = fileURLToPath(new URL("../../bin/docket.ts", import.meta.url));
const failureImport = fileURLToPath(new URL("./fixtures/fail-serialisation.ts", import.meta.url));
const secret = "ENV_SECRET_7a2efc_NOT_FOR_OUTPUT";

function invoke(args: string[], options: { input?: string | Buffer; unexpectedFailure?: boolean } = {}) {
  const result = spawnSync(process.execPath, [
    ...(options.unexpectedFailure ? ["--import", failureImport] : []), entry, ...args,
  ], {
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, DOCKET_TEST_SECRET: secret },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.split("\n").length, 2, "stdout contains exactly one JSON line");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret, "u"));
  const envelope = JSON.parse(result.stdout) as Envelope;
  assert.deepEqual(Object.keys(envelope).sort(), ["version", "operation", "requestId", "outcome", "code", "data", "diagnostics", "nextAction"].sort());
  assert.equal(envelope.version, 1);
  return { ...result, envelope };
}

test("R27/R28/A51/A52: docket catalog show --json emits the core catalogue without config", () => {
  const result = invoke(["catalog", "show", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.envelope.operation, "catalog.show");
  assert.equal(result.envelope.requestId, null);
  assert.equal(result.envelope.outcome, "succeeded");
  assert.deepEqual(result.envelope.data, catalogue);
});

test("R27/A51: real parser and unknown-operation errors use exit 2 and one envelope", () => {
  for (const args of [[], ["catalog"], ["catalog", "show", "--invalid", secret], ["task", "add", "--json"]]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.outcome, "refused");
    assert.equal(result.envelope.code, args[0] === "task" ? "unknown_operation" : "invalid_input");
    assert.ok(result.stderr.length > 0);
  }
});

test("R27/A51: the real entry point catches unexpected failures without exposing environment values", () => {
  const result = invoke(["catalog", "show", "--json", "--request-id", "read-42"], { unexpectedFailure: true });
  assert.equal(result.status, 3);
  assert.equal(result.envelope.outcome, "failed");
  assert.equal(result.envelope.code, "internal_failure");
  assert.equal(result.envelope.requestId, "read-42");
  assert.match(result.stderr, /Unexpected internal failure/u);
  assert.doesNotMatch(result.stdout + result.stderr, /Error:|at .*\.ts/u);
});

test("R27/R28/A51: file input consumes JSON args and refuses missing, malformed or unknown fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "docket-cli-"));
  const input = join(directory, "args.json");
  try {
    writeFileSync(input, "{}\n");
    assert.equal(invoke(["catalog", "show", "--input", input, "--json"]).status, 0);
    for (const contents of ["{", '{"unexpected":null}', "null", '{"objectiveId":"override"}']) {
      writeFileSync(input, contents);
      const result = invoke(["catalog", "show", "--input", input, "--json"]);
      assert.equal(result.status, 2);
      assert.equal(result.envelope.code, "invalid_input");
    }
    const result = invoke(["catalog", "show", "--input", join(directory, secret), "--json"]);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, "invalid_input");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("R27/R28/A51: stdin handles multiline JSON and refuses invalid UTF-8 and oversized input", () => {
  assert.equal(invoke(["catalog", "show", "--stdin", "--json"], { input: "\n{\n}\n" }).status, 0);
  for (const input of ["{", '{"version":2}', Buffer.from([0xff]), " ".repeat(256 * 1024 + 1)]) {
    const result = invoke(["catalog", "show", "--stdin", "--json"], { input });
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, "invalid_input");
  }
});
