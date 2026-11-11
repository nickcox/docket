// Offline SDK contract check. Run only in the scratch plugin with pinned dependencies.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimental_createBridgeJsonRpcTestHarness, experimental_createBridgeDeltaEventCollector } from '@get-bb/plugin-sdk/provider-bridge/testing';
import { experimental_providerBridge as bridge } from './host.ts';

assert.equal(process.version, 'v26.7.0');
const sdk = JSON.parse(readFileSync(new URL('./node_modules/@get-bb/plugin-sdk/package.json', import.meta.url), 'utf8'));
assert.equal(sdk.version, '0.6.132');
const root = mkdtempSync(join(tmpdir(), 'docket-bridge-contract-'));
const harness = experimental_createBridgeJsonRpcTestHarness(line => bridge.handleLine(line));
const collector = experimental_createBridgeDeltaEventCollector('docket-synthetic');
const results: unknown[] = [];
const sessions = new Map<string, string>();
const options = { permissionMode: 'full', permissionScope: 'full', permissionEscalation: null, approvalReviewer: null };
let request = 0;
async function call(method: string, params: Parameters<typeof harness.sendRequest>[2]) {
  const id = ++request;
  harness.sendRequest(id, method, params);
  const response = await harness.waitForResponse(id);
  assert.equal(response.error, undefined, `${method} must succeed`);
  const messages = harness.takeMessages();
  assert.equal(messages.filter(row => row.id === id).length, 1, 'One reply per request');
  assert.ok(messages.every(row => row.id === undefined || row.id === id), 'No mismatched replies');
  return { response, messages, events: messages.flatMap(row => collector.assembleMessage(row)) };
}
try {
  // Interleave threads and resume into a different cwd to expose accidental
  // process-global cwd use. Start/resume itself must never consume task input.
  for (const status of ['failed', 'completed'] as const) {
    const threadId = `contract-${status}`;
    const firstCwd = join(root, `${status}-start`);
    const resumedCwd = join(root, `${status}-resume`);
    mkdirSync(firstCwd); mkdirSync(resumedCwd);
    const started = await call('thread/start', { threadId, cwd: firstCwd, options, instructionMode: 'replace' });
    const providerThreadId = (started.response.result as { providerThreadId: string }).providerThreadId;
    assert.equal(typeof providerThreadId, 'string'); assert.ok(providerThreadId.length);
    sessions.set(threadId, providerThreadId);
    assert.ok(started.messages.some(row => row.method === 'thread/identity' &&
      (row.params as { providerThreadId: string }).providerThreadId === providerThreadId));
    assert.deepEqual(started.events, [], 'Session reset is not a turn or input admission');
    const resumed = await call('thread/resume', { threadId, providerThreadId, cwd: resumedCwd, options, instructionMode: 'replace' });
    assert.deepEqual(resumed.response.result, { providerThreadId });
    assert.deepEqual(resumed.events, []);
    assert.ok(resumed.messages.some(row => row.method === 'thread/identity' &&
      (row.params as { threadId: string }).threadId === threadId &&
      (row.params as { providerThreadId: string }).providerThreadId === providerThreadId));
    for (const cwd of [firstCwd, resumedCwd]) assert.equal(existsSync(join(cwd, 'provider-inputs.jsonl')), false);
    if (status === 'completed') writeFileSync(join(resumedCwd, 'completed-threads.json'), JSON.stringify([threadId]));
  }
  for (const status of ['failed', 'completed'] as const) {
    const threadId = `contract-${status}`;
    const clientRequestId = status === 'failed' ? 'creq_abcdefghij' : 'creq_23456789ab';
    const input = [{ type: 'text', text: `Synthetic ${status} contract input`, mentions: [] }];
    const { messages, events } = await call('turn/start', { threadId, providerThreadId: sessions.get(threadId)!, clientRequestId, input, options });
    // Assert consumer events, not the delta array. The old fixture also emitted
    // completion, but storage refused acceptance because start came second.
    assert.deepEqual(events.map(row => row.type), ['turn/started', 'turn/input/accepted', 'turn/completed']);
    const deltas = messages.filter(row => row.method === 'thread/delta');
    assert.equal(deltas.length, 1);
    assert.equal((deltas[0]!.params as { threadId: string }).threadId, threadId, 'Runtime routing identity');
    const [started, accepted, boundary] = events;
    assert.equal(started!.scope.kind, 'turn');
    assert.ok('turnId' in started!.scope && started!.scope.turnId);
    for (const event of events) {
      // The public assembler leaves identities unstamped. The installed runtime
      // resolves params.threadId then stamps thread/provider identity in VF/KY.
      assert.equal(event.threadId, '');
      assert.ok('providerThreadId' in event);
      assert.equal(event.providerThreadId, '');
      assert.deepEqual(event.scope, started!.scope, 'Start, acceptance and boundary share one bb turn');
    }
    assert.ok(accepted!.type === 'turn/input/accepted');
    assert.equal(accepted.clientRequestId, clientRequestId);
    assert.ok(boundary!.type === 'turn/completed');
    assert.equal(boundary.status, status);
    if (status === 'failed') assert.equal(boundary.error?.message, 'Intentional synthetic failure for ordinary retry');
    else assert.equal(boundary.error, undefined);
    const cwd = join(root, `${status}-resume`);
    const records = readFileSync(join(cwd, 'provider-inputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.deepEqual({ ...records[0], at: undefined }, { at: undefined, method: 'turn/start', threadId, clientRequestId, input });
    assert.equal(existsSync(join(root, `${status}-start`, 'provider-inputs.jsonl')), false, 'Resume replaced the thread cwd');
    results.push({ status: 'passed', scenario: status, threadId, providerThreadId: sessions.get(threadId), clientRequestId, events });
  }
} finally {
  harness.restore();
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ check: 'Q1 synthetic bridge SDK consumer event order', sdk: sdk.version, node: process.version,
  results, cleanup: 'temporary directories removed; stdout restored', liveQualification: 'not-run' }, null, 2));
