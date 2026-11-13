import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register, leaseInputs, type Port, type Dispatch } from '../bb/docket/plugin.ts';
import type { Run } from '../bb/docket/command.ts';

function fixture() {
  const order: string[] = [];
  let hook!: Parameters<Port['experimental_hooks']['on']>[1];
  let environment!: Parameters<Port['experimental_environments']['register']>[0];
  let cli!: Parameters<Port['cli']['register']>[0];
  let result: Record<string, unknown> = { decision: 'hold' };
  let failure = false, rechecks = 0;
  const calls: { operation: string; input: unknown }[] = [];
  const execute: Run = async (file, args) => {
    assert.equal(file, 'fake-docket');
    assert.deepEqual(args.slice(0, 2), ['host', 'invoke']);
    const operation = args[2]!;
    assert.equal(args[args.indexOf('--binding') + 1], join('private', 'binding.json'));
    calls.push({ operation, input: JSON.parse(await readFile(args[args.indexOf('--input') + 1]!, 'utf8')) });
    if (failure) throw new Error('lost response');
    return JSON.stringify({ version: 1, operation, requestId: args[args.indexOf('--request-id') + 1], outcome: 'succeeded', data: result });
  };
  register({
    experimental_hooks: {
      on(_name, handler) { order.push('hook'); hook = handler; },
      async recheck() { rechecks++; },
    },
    settings: { define() { order.push('settings'); return { async get() { return { executable: 'fake-docket', binding: join('private', 'binding.json') }; } }; } },
    experimental_environments: { register(value) { order.push('environment'); environment = value; } },
    cli: { register(value) { order.push('cli'); cli = value; } },
  }, execute);
  return { order, calls, hook, environment, cli, set(value: Record<string, unknown>) { result = value; }, fail() { failure = true; }, rechecks: () => rechecks };
}
const context = (): Dispatch => ({ thread: { id: 'thr_worker' }, environmentIntent: null, queuedMessages: [
  { id: 'queued_1', initiator: 'user', senderThreadId: null, content: [{ type: 'text', text: 'first' }] },
  { id: 'queued_2', initiator: 'agent', senderThreadId: 'thr_sender', content: [{ type: 'text', text: 'second' }] },
] });

test('R33 registers hook first and maps every result, unknowns and failures fail closed', async () => {
  const f = fixture();
  assert.deepEqual(f.order, ['hook', 'settings', 'environment', 'cli']);
  for (const [decision, action] of [['hold', 'wait'], ['admit', 'proceed'], ['refuse', 'reject'], ['pass-through', 'proceed'], ['unknown', 'wait']]) {
    f.set({ decision });
    assert.equal((await f.hook(context())).action, action);
  }
  assert.deepEqual(f.calls[0]!.input, { threadId: 'thr_worker', members: [
    { id: 'queued_1', author: 'user', content: 'first' },
    { id: 'queued_2', author: 'agent:thr_sender', content: 'second' },
  ] });
  f.fail();
  assert.equal((await f.hook(context())).action, 'wait');
});

test('R33 unbound Docket provider intent holds even on core pass-through; inline input cannot admit a worker', async () => {
  const f = fixture();
  f.set({ decision: 'pass-through' });
  assert.equal((await f.hook({ ...context(), environmentIntent: { kind: 'provider', environmentProviderId: 'docket' } })).action, 'wait');
  f.set({ decision: 'refuse' });
  assert.equal((await f.hook({ ...context(), queuedMessages: [] })).action, 'reject');
});

test('R34 returns only the verified recorded allocation, repeats safely and refuses removal', async () => {
  const f = fixture(), path = join(process.cwd(), 'recorded-workspace');
  f.set({ path, untrustedExtra: 'ignored' });
  assert.deepEqual(f.environment.policy, { retireGraceMs: null });
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.environment.create({ inputs: { leaseId: 'lease' } }), { status: 'created', path, ownsPath: false });
  assert.deepEqual(f.calls.map(c => c.input), [{ leaseId: 'lease' }, { leaseId: 'lease' }]);
  assert.equal((await f.environment.remove()).status, 'failed');
  assert.equal(f.calls.length, 2);
  f.set({ path: 'relative' });
  assert.equal((await f.environment.create({ inputs: { leaseId: 'lease' } })).status, 'failed');
  f.fail();
  assert.equal((await f.environment.create({ inputs: { leaseId: 'lease' } })).status, 'failed');
  assert.ok('issues' in leaseInputs['~standard'].validate({ path }));
});

test('R33 R34 launcher readiness and bounded recheck commands register without bb', async () => {
  const f = fixture();
  const readiness = await f.cli.run(['ready']);
  assert.equal(readiness.exitCode, 1);
  assert.equal(JSON.parse(readiness.stdout!).reason, 'queue_identity_unresolved');
  assert.equal((await f.cli.run(['recheck', 'thr_worker'])).exitCode, 0);
  assert.equal(f.rechecks(), 1);
  assert.equal((await f.cli.run(['recheck', 'bad', 'extra'])).exitCode, 2);
  assert.equal(f.calls.length, 0);
});
