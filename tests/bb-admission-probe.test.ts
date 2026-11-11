import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { AdmissionPolicy, admissionSchema, firstInput, inputText } from '../bb/plugin/admission.ts';
import { ProbeReport, validateInputs } from '../bb/probes/report.ts';
import { defer } from './helpers/cleanup.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'docket-probe-policy-'));
  defer(t, () => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'probe.sqlite');
  const handles: DatabaseSync[] = [];
  defer(t, () => { for (const db of handles) db.close(); });
  const open = () => { const db = new DatabaseSync(path); handles.push(db); return db; };
  const db = open();
  for (const migration of admissionSchema) db.exec(migration);
  return { root, open, policy: new AdmissionPolicy(db) };
}
const initial = () => ({ text: firstInput, attempt: 'start-turn', origin: 'cli', messages: [] as { content: string; origin: string | null }[] });

// Fake host admission boundary: only a proceed answer can deliver provider input.
function host(policy: AdmissionPolicy) {
  const inputs: unknown[] = [];
  return { inputs, dispatch(thread: string, input: Parameters<AdmissionPolicy['dispatch']>[1] = initial()) {
    const action = policy.dispatch(thread, input);
    if (action === 'proceed') inputs.push({ threadId: thread, method: 'turn/start', at: Date.now(), input: [{ type: 'text', text: input.text }] });
    return action;
  } };
}

test('R06/R33/Q1a: held before/after bind, durable consumption survives new backend and database handles', t => {
  const f = fixture(t);
  let policy = f.policy;
  let boundary = host(policy);
  assert.equal(boundary.dispatch('t'), 'wait');
  assert.equal(policy.control('permit', 't').accepted, false);
  policy = new AdmissionPolicy(f.open()); boundary = host(policy);
  assert.equal(boundary.dispatch('t'), 'wait');
  assert.equal(policy.control('bind', 't').accepted, true);
  assert.equal(boundary.dispatch('t'), 'wait');
  policy = new AdmissionPolicy(f.open()); boundary = host(policy);
  assert.equal(boundary.dispatch('t'), 'wait');
  assert.equal(policy.control('permit', 't').accepted, true);
  assert.equal(boundary.dispatch('t'), 'proceed');
  assert.equal(boundary.dispatch('t'), 'reject');
  validateInputs(boundary.inputs, policy.events());
  const restored = new AdmissionPolicy(f.open());
  assert.equal(host(restored).dispatch('t'), 'reject');
  assert.equal(restored.control('bind', 't').accepted, false);
  assert.equal(restored.control('permit', 't').accepted, false);
});

test('R06/R07/Q1b: fenced pending and consumed rows never revive after reload/restart or controls', t => {
  const f = fixture(t);
  for (const consumed of [false, true]) {
    const id = String(consumed);
    f.policy.control('bind', id);
    if (consumed) { f.policy.control('permit', id); assert.equal(host(f.policy).dispatch(id), 'proceed'); }
    f.policy.control('refuse', id);
    for (const p of [new AdmissionPolicy(f.open()), new AdmissionPolicy(f.open())]) {
      for (const action of ['bind', 'permit'] as const) assert.equal(p.control(action, id).accepted, false);
      const h = host(p);
      for (const input of [initial(), { ...initial(), text: 'follow-up' }, { ...initial(), origin: null }, { ...initial(), attempt: 'join-turn' }]) assert.equal(h.dispatch(id, input), 'reject');
      assert.equal(h.inputs.length, 0);
    }
  }
});

test('R33/Q1a: every grouped member, non-text block and non-initial dispatch is refused before consume', t => {
  const { policy } = fixture(t);
  policy.control('bind', 't'); policy.control('permit', 't');
  const h = host(policy);
  for (const input of [
    { ...initial(), messages: [{ content: firstInput, origin: 'cli' }, { content: 'later', origin: null }] },
    { ...initial(), messages: [{ content: firstInput, origin: null }] },
    { ...initial(), origin: null }, { ...initial(), attempt: 'join-turn' },
  ]) assert.equal(h.dispatch('t', input), 'reject');
  assert.equal(inputText([{ type: 'image', text: firstInput }]), null);
  assert.equal(inputText([{ type: 'text', text: firstInput }, { type: 'image' }]), null);
  assert.equal(inputText([{ type: 'text', text: firstInput }]), firstInput);
  assert.equal(h.inputs.length, 0);
  assert.equal(h.dispatch('t'), 'proceed');
});

test('R06/Q1a: both durable permit/fence orderings admit at most once and only after permission', t => {
  for (const fenceFirst of [true, false]) {
    const f = fixture(t); const peer = new AdmissionPolicy(f.open()); const h = host(f.policy);
    f.policy.control('bind', 't');
    if (fenceFirst) peer.control('refuse', 't');
    f.policy.control('permit', 't'); h.dispatch('t');
    peer.control('refuse', 't'); h.dispatch('t');
    assert.equal(h.inputs.length, fenceFirst ? 0 : 1);
    validateInputs(h.inputs, peer.events());
    assert.equal(peer.control('permit', 't').accepted, false);
  }
});

test('R33: report validation refuses missing, reordered, duplicate or mismatched provider evidence', t => {
  const { policy } = fixture(t); const h = host(policy);
  policy.control('bind', 't'); policy.control('permit', 't'); h.dispatch('t');
  const events = policy.events(); validateInputs(h.inputs, events);
  assert.throws(() => validateInputs([...h.inputs, ...h.inputs], events), /More than one/);
  assert.throws(() => validateInputs(h.inputs, events.filter(e => e.action !== 'permit')), /precedes/);
  assert.throws(() => validateInputs(h.inputs, events.filter(e => e.action !== 'proceed')), /consumption/);
  assert.throws(() => validateInputs([{ ...(h.inputs[0] as object), at: 0 }], events), /precedes/);
  assert.throws(() => validateInputs([{ ...(h.inputs[0] as object), input: [{ text: 'wrong' }] }], events), /content/);
});

test('Q1a/Q1b: assertion failure retains failed/not-run stages and cleanup evidence without installed bb', async t => {
  const { root } = fixture(t); const path = join(root, 'report.json');
  const report = new ProbeReport(['first', 'broken', 'later', 'cleanup'], value => writeFileSync(path, JSON.stringify(value)));
  await report.stage('first', async () => ({ barrier: 'hook wait observed' }));
  await assert.rejects(report.stage('broken', async () => { assert.equal(1, 2, 'Observed rejection missing'); }));
  await report.stage('cleanup', async () => ({ fakeOwnedProcessesStopped: true }));
  const retained = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(retained.scenarios.map((row: any) => row.status), ['passed', 'failed', 'not-run', 'passed']);
  assert.match(retained.failure, /Observed rejection missing/);
  assert.equal(retained.active, null);
  assert.equal(retained.scenarios[3].evidence.fakeOwnedProcessesStopped, true);
});

test('Q1a/Q1b: interrupted active stage is retained as failed, never silently passed', async t => {
  const { root } = fixture(t); const path = join(root, 'interrupted.json');
  const report = new ProbeReport(['active', 'later'], value => writeFileSync(path, JSON.stringify(value)));
  await assert.rejects(report.stage('active', async () => {
    report.interrupt('Terminated');
    const retained = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(retained.scenarios[0].status, 'failed');
    assert.equal(retained.scenarios[1].status, 'not-run');
    assert.equal(retained.failure, 'Terminated');
    return { mustNotBecomePassed: true };
  }), /Terminated/);
});
