import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defer } from '../helpers/cleanup.ts';
import { configuration } from '../fixtures/configuration.ts';
import { initialiseContext, openContext } from '../../src/context.ts';
import { createBinding } from '../../src/binding.ts';
import { PiSupervisor } from '../../src/adapters/pi-supervisor.ts';
import { latestBriefingContext } from '../../src/supervisor.ts';
import { canonicalJson } from '../../src/configuration.ts';
import { CommandFailure } from '../../src/response.ts';

const person = { kind: 'person' as const, id: 'operator' };
const args = { objectiveId: 'goal', host: 'pi', profile: null, restricted: true };
async function fixture(t: test.TestContext, mode = 'normal') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-supervisor-')));
  defer(t, () => rm(home, { recursive: true, force: true }));
  const file = join(home, 'docket.json'), record = join(home, 'peer.jsonl');
  const config = configuration(home);
  config.profiles.worker.launcher = 'pi';
  await writeFile(file, JSON.stringify(config));
  await writeFile(record, '');
  await initialiseContext({ config: file }, { home, recyclableRoots: [], caller: person });
  const context = await openContext({ config: file }, { home, readOnly: false });
  defer(t, () => context.database.close());
  const peers: PiSupervisor[] = [];
  const power = { starts: 0, stops: 0 };
  defer(t, async () => { for (const peer of peers) await peer.stop(); });
  const binding = createBinding(person, { config: file }, { home,
    keepAwake: () => { power.starts++; if (mode === 'helper-failure') throw new Error('Synthetic helper failure'); return () => { power.stops++; }; },
    supervisorPeer: async () => {
    const peer = new PiSupervisor({ stateDirectory: join(home, 'supervisors'), ...(mode === 'lost-ack' ? { requestMs: 300 } : {}),
      profile: { provider: 'synthetic', model: 'synthetic', reasoning: null },
      execution: { executable: process.execPath, ...(mode === 'sdk' ? { sdkModule: resolve('tests', 'fixtures', 'pi-supervisor-sdk.ts') }
        : { entrypoint: resolve('tests', 'fixtures', 'pi-supervisor-peer.ts') }), passEnvironment: ['PEER_RECORD', 'PEER_MODE'] },
      environment: { PATH: process.env.PATH, PEER_RECORD: record, PEER_MODE: mode, DOCKET_SECRET: 'never inherit' } });
    peers.push(peer); return peer;
  } });
  for (const id of ['goal', 'other']) await binding.execute('objective.add', { id, request: 'Supervise safely', criteria: ['Safe'],
    scope: 'Project', constraints: '', permissions: null, budget: null, deadline: null });
  const records = async () => (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { binding, db: context.database, peers, records, home, config, power };
}
const refusal = (code: string) => (error: unknown) => error instanceof CommandFailure && error.code === code;

test('R19/R28/R35/A57: restricted Pi starts with the supervisor catalogue, objective registration, briefing and durable notification admission', async t => {
  const f = await fixture(t);
  const result = await f.binding.execute('supervisor.start', args, 'start');
  const session = result.session as any;
  assert.equal(session.restricted, true);
  assert.deepEqual(f.power, { starts: 1, stops: 1 });
  const events = f.db.events();
  const registered = events.find(e => e.kind === 'session.registered' && e.payload.sessionId === session.sessionId)!;
  assert.equal(registered.objectiveId, 'goal');
  assert.equal(registered.payload.restricted, true);
  assert.ok(events.some(e => e.kind === 'supervisor.admitted'));
  assert.ok(events.some(e => e.kind === 'supervisor.note' && e.objectiveId === 'goal'));
  assert.ok(events.some(e => e.kind === 'supervisor.stopped'));
  const records = await f.records(), spawn = records[0];
  assert.equal(spawn.environment.DOCKET_SECRET, undefined);
  const definitions = createBinding({ kind: 'supervisor', id: session.sessionId, sessionId: session.sessionId, objectiveId: 'goal' }, { context: 'unused' }).catalogue.operations;
  assert.deepEqual(spawn.config.operations, definitions);
  assert.ok(!definitions.some(o => o.name === 'supervisor.start' || o.name === 'status.watch'));
  const prompt = records.find(r => r.type === 'prompt').message;
  assert.match(prompt, /<docket-briefing>/u);
  assert.match(prompt, /Notifications:/u);
  const briefing = records.find(r => r.type === 'tool_result' && r.toolCallId === 'briefing').value.briefing;
  assert.equal(briefing.objective.id, 'goal');
  assert.equal(briefing.authority[0].kind, 'restricted');
  assert.deepEqual(await f.binding.execute('supervisor.start', args, 'start'), result);
  assert.equal((await f.records()).filter(r => r.type === 'spawn').length, 1);
});

test('R19/A57: another active objective supervisor is refused, including a concurrent start', async t => {
  const f = await fixture(t, 'running');
  const starting = f.binding.execute('supervisor.start', args, 'first').catch(error => { assert.ok(refusal('effect_uncertain')(error)); });
  // Observe the direct peer rather than assuming that registration means a prompt ran.
  for (let i = 0; i < 6000 && !(await f.records()).some(r => r.type === 'prompt'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok((await f.records()).some(r => r.type === 'prompt'));
  await assert.rejects(f.binding.execute('supervisor.start', { ...args, objectiveId: 'other' }, 'second'), refusal('owner_unresolved'));
  await f.peers[0]!.stop();
  await starting;
  assert.equal((await f.records()).filter(r => r.type === 'spawn').length, 1);
});

test('R22/R35/A57: lost prompt acknowledgement never resends or adopts; pending IDs survive for a fresh session', async t => {
  const f = await fixture(t, 'lost-ack');
  await assert.rejects(f.binding.execute('supervisor.start', args, 'lost'), refusal('effect_uncertain'));
  const before = f.db.events().find(e => e.kind === 'supervisor.delivery')!.payload.eventIds;
  await assert.rejects(f.binding.execute('supervisor.start', args, 'lost'));
  const records = await f.records();
  assert.equal(records.filter(r => r.type === 'prompt').length, 1);
  assert.equal(records.filter(r => r.type === 'spawn').length, 1);
  const host = createBinding({ kind: 'host', id: 'restarted' }, { config: join(f.home, 'docket.json') }, { home: f.home });
  const pending = await host.execute('supervisor.pending', { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 }, 'pending');
  assert.deepEqual(pending.eventIds, before);
  assert.equal(pending.admitted, false);
});

test('R22/A57: a durable start intent survives owner loss and blocks replay and replacement without adopting a session', async t => {
  const f = await fixture(t);
  const command = { operation: 'supervisor.start', input: args, caller: person, requestKey: 'interrupted', fingerprint: canonicalJson(args) };
  const session = await f.db.reserveSupervisor('goal', {}, command);
  assert.equal(await f.db.supervisorIntent(session.sessionId, 'start'), true);
  await assert.rejects(f.binding.execute('supervisor.start', args, 'interrupted'), refusal('effect_uncertain'));
  await assert.rejects(f.binding.execute('supervisor.start', args, 'replacement'), refusal('owner_unresolved'));
  assert.deepEqual(await f.records(), []);
});

test('R28/R35/A57: unsupported host/restriction and a peer with general tools refuse before the first model prompt', async t => {
  const f = await fixture(t, 'unrestricted');
  for (const unsupported of [{ ...args, restricted: false }, { ...args, host: 'bb' }]) {
    await assert.rejects(f.binding.execute('supervisor.start', unsupported), refusal('capability_missing'));
  }
  assert.equal(f.db.events().filter(e => e.kind === 'session.registered').length, 0);
  await assert.rejects(f.binding.execute('supervisor.start', args), refusal('effect_uncertain'));
  assert.equal((await f.records()).filter(r => r.type === 'prompt').length, 0);
});

for (const mode of ['model-error', 'crash']) test(`R22/R35/A57: ${mode} is visible and never retried`, async t => {
  const f = await fixture(t, mode);
  await assert.rejects(f.binding.execute('supervisor.start', args, mode), refusal('effect_uncertain'));
  assert.ok(f.db.events().some(e => e.kind === 'session.failed'));
  assert.ok(f.db.events().some(e => e.kind === 'supervisor.stopped'));
  await f.binding.execute('supervisor.start', args, mode);
  assert.equal((await f.records()).filter(r => r.type === 'prompt').length, 1);
});

test('R35/A57: keep-awake failure warns without preventing supervision', async t => {
  const f = await fixture(t, 'helper-failure');
  await f.binding.execute('supervisor.start', args);
  assert.equal(f.power.starts, 1);
  assert.ok(f.db.events().some(e => e.kind === 'supervisor.note'));
});

test('R35/A57: cold SDK preparation has a separate limit from ordinary requests', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-supervisor-cold-')));
  defer(t, () => rm(home, { recursive: true, force: true }));
  const peer = new PiSupervisor({ stateDirectory: join(home, 'supervisors'), requestMs: 100,
    profile: { provider: 'synthetic', model: 'synthetic', reasoning: null },
    execution: { executable: process.execPath, sdkModule: resolve('tests', 'fixtures', 'pi-supervisor-sdk.ts'),
      passEnvironment: ['PEER_RECORD', 'PEER_MODE'] },
    environment: { PEER_RECORD: join(home, 'peer.jsonl'), PEER_MODE: 'slow-sdk' } });
  defer(t, async () => { await peer.stop(); });
  // The SDK import alone waits 500 ms, longer than the ordinary 100 ms limit.
  // Preparation must still validate the session and restrictions without retrying.
  await peer.prepare('cold-start', [], async () => ({}));
  assert.equal(peer.exited, false);
});

test('R23/R35/A57: private SDK path removes built-ins and resource discovery, bridges questions, and filters actual model context', async t => {
  const f = await fixture(t, 'sdk');
  await f.binding.execute('supervisor.start', args);
  const records = await f.records();
  const resources = records.find(r => r.kind === 'resources');
  assert.deepEqual(resources.tools, resources.customTools);
  assert.ok(!resources.tools.some((name: string) => ['read', 'write', 'bash', 'edit'].includes(name)));
  assert.deepEqual(resources.extensions.extensions, []);
  assert.deepEqual(resources.skills.skills, []);
  assert.deepEqual(resources.agents.agentsFiles, []);
  assert.ok(resources.customTools.every((name: string) => name.startsWith('dk_')));
  const messages = records.find(r => r.kind === 'modelContext').messages;
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[2].content, [{ type: 'text', text: 'Superseded briefing.' }]);
  assert.deepEqual(messages[2].details, {});
  assert.ok(!JSON.stringify(messages[0]).includes('<docket-briefing>'));
  assert.equal(messages[4].details.briefing.objective.id, 'goal');
  const question = f.db.questions()[0]!;
  assert.deepEqual(question.recipient, { kind: 'person' });
  assert.equal(question.scope.objectiveId, 'goal');
  assert.equal(f.db.events().filter(e => e.kind === 'supervisor.note').length, 1, 'A duplicate tool call reuses its durable request key');
  const sessionId = f.db.events().find(e => e.kind === 'session.registered')!.payload.sessionId;
  assert.equal(f.db.requests().filter(r => r.requestKey === `${sessionId}:note`).length, 1);
});

test('R23/A57: only the latest briefing remains in model context without deleting tool-call pairs or notification IDs', () => {
  const messages = [
    { role: 'user', content: '<docket-briefing>initial large payload</docket-briefing> Notifications: [one]' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'one', name: 'dk_supervisor_briefing' }, { type: 'toolCall', id: 'note', name: 'dk_supervisor_note' }] },
    { role: 'toolResult', toolCallId: 'one', toolName: 'dk_supervisor_briefing', content: [{ type: 'text', text: 'old large payload' }], details: { old: true } },
    { role: 'toolResult', toolCallId: 'note', toolName: 'dk_supervisor_note', content: 'note' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'two', name: 'dk_supervisor_briefing' }] },
    { role: 'toolResult', toolCallId: 'two', toolName: 'dk_supervisor_briefing', content: 'latest payload' },
  ];
  const compact = latestBriefingContext(messages);
  assert.equal(compact.length, messages.length);
  assert.deepEqual(compact.map(m => m.toolCallId), messages.map(m => m.toolCallId));
  assert.ok(!JSON.stringify(compact).includes('large payload'));
  assert.match(JSON.stringify(compact), /Notifications: \[one\]/u);
  assert.equal(compact.at(-1), messages.at(-1));
  assert.deepEqual(compact[2]!.details, {});
  assert.match(JSON.stringify(messages), /old large payload/u, 'visible history is unchanged');
});
