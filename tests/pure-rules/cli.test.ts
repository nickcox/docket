import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INPUT_BYTES, MAX_RESPONSE_BYTES, runCli } from "../../src/cli.ts";
import type { CliIO, OperationRunner } from "../../src/cli.ts";
import { CommandFailure, exitCodeFor, failureEnvelope } from "../../src/response.ts";
import type { Envelope } from "../../src/response.ts";

async function invoke(argv: string[], options: { input?: string; run?: OperationRunner; readError?: unknown } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const read = async () => {
    if (options.readError) throw options.readError;
    return options.input ?? "{}";
  };
  const io: CliIO = { readFile: read, readStdin: read, stdout: (text) => { stdout.push(text); }, stderr: (text) => { stderr.push(text); } };
  const exit = await runCli(argv, io, options.run);
  assert.equal(stdout.length, 1, "one stdout write");
  assert.equal(stdout[0]?.split("\n").length, 2, "one JSON line and its terminator");
  const envelope = JSON.parse(stdout[0]!) as Envelope;
  assert.deepEqual(Object.keys(envelope).sort(), ["version", "operation", "requestId", "outcome", "code", "data", "diagnostics", "nextAction"].sort());
  assert.equal(envelope.version, 1);
  assert.equal(typeof envelope.data, "object");
  assert.ok(Array.isArray(envelope.diagnostics));
  for (const diagnostic of envelope.diagnostics) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ["code", "message", "owner", "retryable"]);
    assert.equal(typeof diagnostic.code, "string");
    assert.equal(typeof diagnostic.message, "string");
    assert.ok(diagnostic.owner === null || typeof diagnostic.owner === "string");
    assert.equal(typeof diagnostic.retryable, "boolean");
  }
  return { exit, envelope, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("R27/A51: exit mapping includes accepted work, domain refusal and internal failure", () => {
  assert.equal(exitCodeFor("succeeded"), 0);
  assert.equal(exitCodeFor("accepted"), 0);
  assert.equal(exitCodeFor("refused"), 1);
  assert.equal(exitCodeFor("failed"), 3);
  assert.equal(failureEnvelope("unsupported_version", null, null).exitCode, 2);
});

test("R27/A51: a successful uncorrelated read has every envelope field", async () => {
  const result = await invoke(["catalog", "show", "--json"]);
  assert.equal(result.exit, 0);
  assert.equal(result.envelope.operation, "catalog.show");
  assert.equal(result.envelope.requestId, null);
  assert.equal(result.envelope.outcome, "succeeded");
  assert.equal(result.envelope.code, "catalog_shown");
  assert.equal(result.envelope.nextAction, null);
  assert.deepEqual(result.envelope.diagnostics, []);
  assert.equal(result.stderr, "");
});

test("R27/A51: known correlation survives expected and unexpected execution failures", async () => {
  for (const [error, exit, code] of [
    [new CommandFailure("policy_refused"), 1, "policy_refused"],
    [new CommandFailure("owner_unknown"), 1, "owner_unknown"],
    [new Error("secret runtime details"), 3, "internal_failure"],
  ] as const) {
    const result = await invoke(["catalog", "show", "--json", "--request-id", "read-17"], { run: () => { throw error; } });
    assert.equal(result.exit, exit);
    assert.equal(result.envelope.code, code);
    assert.equal(result.envelope.outcome, exit === 3 ? "failed" : "refused");
    assert.equal(result.envelope.operation, "catalog.show");
    assert.equal(result.envelope.requestId, "read-17");
    assert.equal(result.envelope.diagnostics[0]?.retryable, code === "owner_unknown");
    assert.doesNotMatch(result.stdout + result.stderr, /secret runtime details/u);
  }
});

const invalidArgv = [
  [], ["catalog"], ["--json"], ["catalog", "--json"],
  ["catalog", "show", "extra"], ["catalog", "show", "--unknown"],
  ["catalog", "show", "--json", "--json"], ["catalog", "show", "--input"],
  ["catalog", "show", "--input", "--json"], ["catalog", "show", "--request-id"],
  ["catalog", "show", "--request-id", "bad\nkey"],
  ["catalog", "show", "--stdin", "--input", "args.json"],
  ["catalog", "show", "--config", "config.json"],
];
for (const argv of invalidArgv) {
  test(`R27/A51: invalid arguments ${JSON.stringify(argv)} retain JSON framing`, async () => {
    const result = await invoke(argv);
    assert.equal(result.exit, 2);
    assert.equal(result.envelope.code, "invalid_input");
    assert.match(result.envelope.diagnostics[0]!.message, /\$/u);
  });
}

test("R27/A51: unknown operations refuse without reflecting arbitrary arguments", async () => {
  const result = await invoke(["secret-input", "unknown", "--json"]);
  assert.equal(result.exit, 2);
  assert.equal(result.envelope.code, "unknown_operation");
  assert.equal(result.envelope.operation, null);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-input/u);
});

for (const input of ["{", "null", "[]", "true", "17", '"text"', '{"version":2}', '{"extra":null}', '{"__proto__":{}}']) {
  test(`R27/R28/A51: invalid JSON or strict input ${input} refuses`, async () => {
    const result = await invoke(["catalog", "show", "--stdin"], { input });
    assert.equal(result.exit, 2);
    assert.equal(result.envelope.code, "invalid_input");
  });
}

test("R27/A51: file and stdin accept explicit empty args including whitespace", async () => {
  for (const flags of [["--stdin"], ["--input", "args.json"]]) {
    const result = await invoke(["catalog", "show", ...flags, "--json"], { input: "\n{\n}\n" });
    assert.equal(result.exit, 0);
  }
});

test("R27/A51: input read failures are invalid input and do not expose filesystem errors", async () => {
  const result = await invoke(["catalog", "show", "--input", "private"], { readError: new Error("private environment value") });
  assert.equal(result.exit, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /private environment value/u);
});

test("R27/A51: oversized input is bounded and never executed", async () => {
  const result = await invoke(["catalog", "show", "--stdin"], { input: " ".repeat(MAX_INPUT_BYTES + 1), run: () => { assert.fail("must not run"); } });
  assert.equal(result.exit, 2);
});

test("R27/A51: oversized UTF-8 responses become one bounded failure envelope", async () => {
  const result = await invoke(["catalog", "show"], { run: () => ({ text: "🦘".repeat(MAX_RESPONSE_BYTES / 4) }) });
  assert.equal(result.exit, 3);
  assert.equal(result.envelope.code, "response_too_large");
  assert.ok(Buffer.byteLength(result.stdout) <= MAX_RESPONSE_BYTES);
});

test("R27/A51: serialisation failures become one internal failure envelope", async () => {
  const data: Record<string, unknown> = {};
  data.circular = data;
  const result = await invoke(["catalog", "show"], { run: () => data });
  assert.equal(result.exit, 3);
  assert.equal(result.envelope.code, "internal_failure");
});

test("R27/A51: successful data is serialised only once before the size check", async () => {
  let calls = 0;
  const result = await invoke(["catalog", "show"], { run: () => ({ toJSON() { calls++; return {}; } }) });
  assert.equal(result.exit, 0);
  assert.equal(calls, 1);
});

test("R27/A51: progress and diagnostics stay on stderr; environment values are not included", async () => {
  const secret = "ENV_CREDENTIAL_SHOULD_NOT_BE_PRINTED";
  process.env.DOCKET_TEST_SECRET = secret;
  try {
    const result = await invoke(["catalog", "show", "--json"], { run: (_operation, _args, progress) => {
      progress("Reading the catalogue.");
      throw new Error(process.env.DOCKET_TEST_SECRET);
    } });
    assert.equal(result.exit, 3);
    assert.match(result.stderr, /Reading the catalogue\./u);
    assert.match(result.stderr, /Unexpected internal failure/u);
    assert.doesNotMatch(result.stdout, /Reading the catalogue\./u);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret, "u"));
  } finally {
    delete process.env.DOCKET_TEST_SECRET;
  }
});
