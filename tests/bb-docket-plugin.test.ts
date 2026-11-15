import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register, type Port, type Dispatch } from '../bb/docket/plugin.ts';
import type { Run } from '../bb/docket/command.ts';

function fixture(config = { executable: 'fake-docket', binding: join('private', 'binding.json') }) {
  const order: string[] = [];
  let hook!: Parameters<Port['experimental_hooks']['on']>[1];
  let cli!: Parameters<Port['cli']['register']>[0];
  let result: Record<string, unknown> = { decision: 'hold' };
  let failure = false, rechecks = 0;
  let rawReply: string | null = null;
  const calls: { operation: string; input: unknown }[] = [];
  const execute: Run = async (file, args) => {
    assert.equal(file, 'fake-docket');
    assert.deepEqual(args.slice(0, 2), ['host', 'invoke']);
    const operation = args[2]!;
    assert.equal(args[args.indexOf('--binding') + 1], join('private', 'binding.json'));
    calls.push({ operation, input: JSON.parse(await readFile(args[args.indexOf('--input') + 1]!, 'utf8')) });
    if (failure) throw new Error('lost response');
    if (rawReply !== null) return rawReply;
    return JSON.stringify({ version: 1, operation, requestId: args[args.indexOf('--request-id') + 1], outcome: 'succeeded', data: result });
  };
  register({
    experimental_hooks: {
      on(_name, handler) { order.push('hook'); hook = handler; },
      async recheck() { rechecks++; },
    },
    settings: { define() { order.push('settings'); return { async get() { return config; } }; } },
    cli: { register(value) { order.push('cli'); cli = value; } },
  }, execute);
  return { order, calls, hook, cli, set(value: Record<string, unknown>) { result = value; }, fail() { failure = true; }, malformed(raw: string) { rawReply = raw; }, rechecks: () => rechecks };
}
const context = (): Dispatch => ({ thread: { id: 'thr_worker' },
  input: { blocks: [{ type: 'text', text: 'inline text' }] }, initiator: 'user', queuedMessages: [
  { id: 'queued_1', initiator: 'user', senderThreadId: null, content: [{ type: 'text', text: 'first' }] },
  { id: 'queued_2', initiator: 'agent', senderThreadId: 'thr_sender', content: [{ type: 'text', text: 'second' }] },
] });

test('R33 registers hook first and maps every result, unknowns and failures fail closed', async () => {
  const f = fixture();
  assert.deepEqual(f.order, ['hook', 'settings', 'cli']);
  for (const [decision, action] of [['hold', 'wait'], ['admit', 'proceed'], ['refuse', 'reject'], ['pass-through', 'proceed'], ['unknown', 'wait']]) {
    f.set({ decision });
    assert.equal((await f.hook(context())).action, action);
  }
  assert.deepEqual(f.calls[0]!.input, { threadId: 'thr_worker', members: [
    { id: 'queued_1', author: 'user', content: 'first' },
    { id: 'queued_2', author: 'agent', content: 'second' },
  ] });
  for (const raw of ['not json', JSON.stringify({ version: 1, outcome: 'succeeded', data: { decision: 'admit' } })]) {
    f.malformed(raw);
    assert.equal((await f.hook(context())).action, 'wait');
  }
  f.fail();
  assert.equal((await f.hook(context())).action, 'wait');
});

test('R33 R34 inline sends use content and author category', async () => {
  const f = fixture();
  f.set({ decision: 'admit' });
  assert.equal((await f.hook({ ...context(), queuedMessages: [] })).action, 'proceed');
  assert.deepEqual(f.calls.at(-1)!.input, { threadId: 'thr_worker', members: [
    { id: 'inline', author: 'user', content: 'inline text' },
  ] });
});

test('R33 R34 launcher readiness and bounded recheck commands register without bb', async () => {
  const f = fixture();
  f.set({ operations: [{ name: 'host.bb-admit' }] });
  const readiness = await f.cli.run(['ready']);
  assert.equal(readiness.exitCode, 0);
  assert.deepEqual(JSON.parse(readiness.stdout!), { version: 1, ready: true });
  assert.equal((await f.cli.run(['recheck', 'thr_worker'])).exitCode, 0);
  assert.equal(f.rechecks(), 1);
  assert.equal((await f.cli.run(['recheck', 'bad', 'extra'])).exitCode, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.operation, 'catalog.show');
  f.set({ operations: [{ name: 'catalog.show' }] });
  assert.equal((await f.cli.run(['ready'])).exitCode, 1);
  f.fail();
  assert.equal((await f.cli.run(['ready'])).exitCode, 1);
  assert.equal((await fixture({ executable: 'fake-docket', binding: '' }).cli.run(['ready'])).exitCode, 1);
  assert.equal((await fixture({ executable: '', binding: 'configured' }).cli.run(['ready'])).exitCode, 1);
});

test('R33 unsupported blocks hold without a command; normal reload registers the hook first again', async () => {
  for (let load = 0; load < 2; load++) {
    const f = fixture();
    assert.equal(f.order[0], 'hook');
    const value = context();
    value.queuedMessages[1]!.content = [{ type: 'image' }];
    assert.equal((await f.hook(value)).action, 'wait');
    assert.equal(f.calls.length, 0);
  }
});
