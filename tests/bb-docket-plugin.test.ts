import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register, type Port, type Dispatch } from '../bb/docket/plugin.ts';
import type { Run } from '../bb/docket/command.ts';

function fixture(config = { executable: 'fake-docket', binding: join('private', 'binding.json'), projects: 'proj_worker' }) {
  const order: string[] = [];
  let hook!: Parameters<Port['experimental_hooks']['on']>[1];
  let cli!: Parameters<Port['cli']['register']>[0];
  let result: Record<string, unknown> = { decision: 'hold' };
  let failure = false, settingsFailure = false, rechecks = 0;
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
    settings: { define() { order.push('settings'); return { async get() { if (settingsFailure) throw new Error('Settings unavailable'); return config; } }; } },
    cli: { register(value) { order.push('cli'); cli = value; } },
  }, execute);
  return { order, calls, hook, cli, set(value: Record<string, unknown>) { result = value; }, fail() { failure = true; }, failSettings() { settingsFailure = true; }, malformed(raw: string) { rawReply = raw; }, rechecks: () => rechecks };
}
const context = (): Dispatch => ({ thread: { id: 'thr_worker' }, project: { id: 'proj_worker' },
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

test('R33 R34 A55 launcher readiness requires a listed project and bounded recheck commands register without bb', async () => {
  const f = fixture();
  f.set({ operations: [{ name: 'host.bb-admit' }] });
  for (const args of [['ready'], ['ready', 'proj_other'], ['ready', 'bad/id'], ['ready', 'proj_worker', 'extra']]) {
    assert.notEqual((await f.cli.run(args)).exitCode, 0);
  }
  assert.equal(f.calls.length, 0);
  const readiness = await f.cli.run(['ready', 'proj_worker']);
  assert.equal(readiness.exitCode, 0);
  assert.deepEqual(JSON.parse(readiness.stdout!), { version: 1, ready: true });
  assert.equal((await f.cli.run(['recheck', 'thr_worker'])).exitCode, 0);
  assert.equal(f.rechecks(), 1);
  assert.equal((await f.cli.run(['recheck', 'bad', 'extra'])).exitCode, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.operation, 'catalog.show');
  f.set({ operations: [{ name: 'catalog.show' }] });
  assert.equal((await f.cli.run(['ready', 'proj_worker'])).exitCode, 1);
  f.fail();
  assert.equal((await f.cli.run(['ready', 'proj_worker'])).exitCode, 1);
  assert.equal((await fixture({ executable: 'fake-docket', binding: '', projects: 'proj_worker' }).cli.run(['ready', 'proj_worker'])).exitCode, 1);
  assert.equal((await fixture({ executable: '', binding: 'configured', projects: 'proj_worker' }).cli.run(['ready', 'proj_worker'])).exitCode, 1);
});

test('R33 R34 A55 unlisted projects bypass content and Docket even on command failure', async () => {
  for (const projects of ['', 'proj_other', 'proj_one, proj_two\nproj_three']) {
    const f = fixture({ executable: 'fake-docket', binding: '', projects });
    f.fail();
    const value = context();
    value.queuedMessages[0]!.content = [{ type: 'image' }, { type: 'file' }];
    assert.equal((await f.hook(value)).action, 'proceed');
    Object.defineProperty(value, 'queuedMessages', { get() { throw new Error('Content accessed'); } });
    Object.defineProperty(value, 'input', { get() { throw new Error('Content accessed'); } });
    assert.equal((await f.hook(value)).action, 'proceed');
    assert.equal(f.calls.length, 0);
  }
});

test('R33 R34 A55 missing project, unreadable settings and invalid project lists hold', async () => {
  const f = fixture();
  const value = context();
  Reflect.deleteProperty(value, 'project');
  assert.equal((await f.hook(value)).action, 'wait');
  f.failSettings();
  assert.equal((await f.hook(context())).action, 'wait');
  assert.equal((await f.cli.run(['ready', 'proj_worker'])).exitCode, 1);
  assert.equal(f.calls.length, 0);
  const invalid = fixture({ executable: 'fake-docket', binding: 'configured', projects: 'proj_worker, bad/id' });
  assert.equal((await invalid.hook(context())).action, 'wait');
  assert.equal((await invalid.cli.run(['ready', 'proj_worker'])).exitCode, 1);
  assert.equal(invalid.calls.length, 0);
});

test('R33 R34 project lists accept commas and whitespace and match whole IDs', async () => {
  const f = fixture({ executable: 'fake-docket', binding: join('private', 'binding.json'), projects: 'proj_other,\nproj_worker proj_last' });
  f.set({ decision: 'admit' });
  assert.equal((await f.hook(context())).action, 'proceed');
  assert.equal(f.calls.length, 1);
  f.set({ operations: [{ name: 'host.bb-admit' }] });
  assert.equal((await f.cli.run(['ready', 'proj_worker'])).exitCode, 0);
  assert.notEqual((await f.cli.run(['ready', 'proj_work'])).exitCode, 0);
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
