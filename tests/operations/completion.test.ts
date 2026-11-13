import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, writeFile, unlink, link } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dispatch } from '../../src/dispatch.ts';
import type { Runtime } from '../../src/runtime.ts';
import { cleanDiagnostics } from '../../src/diagnostics.ts';
import { DiagnosticsDirectory } from '../../src/adapters/diagnostics.ts';
import type { DiagnosticManifest } from '../../src/adapters/diagnostics.ts';
import { acceptCandidate, returnAttempt, selectCandidate, planCandidateAcceptance, planAttemptReturn, automaticReturn, leaseReturnReason } from '../../src/completion.ts';
import { rebaseAttempt, planAttemptRebase } from '../../src/rebase.ts';
import { observeWorker } from '../../src/workers.ts';
import { buildBriefing } from '../../src/briefing.ts';
import { originalCandidateRef } from '../../src/storage/rebase.ts';
import type { CompletionServices } from '../../src/completion.ts';
import { confirmed, rejected, uncertain } from '../../src/adapters/command.ts';
import { mandatoryChecks, parseCheckPolicy } from '../../src/check-policy.ts';
import type { TrustedChecks } from '../../src/storage/reservations.ts';
import { runCandidateChecks, runChecks } from '../../src/checks.ts';
import { canonicalJson } from '../../src/configuration.ts';
import { Database, StorageError } from '../../src/storage/database.ts';
import { CommandFailure } from '../../src/response.ts';
import { checkFixture, contextChecks, head, host, person, policyContent, profile, start } from '../helpers/check-attempt.ts';
import { permissions, unlimitedBudget } from '../../src/storage/objectives.ts';
import type { TaskActor } from '../../src/storage/tasks.ts';

async function fixture(t: Parameters<typeof checkFixture>[0], local = false, piDiagnostics = false) {
  const f = await checkFixture(t, 1, piDiagnostics);
  if (local) {
    const config = f.db.events().find(event => event.kind === 'context.configured')!;
    const resolved = structuredClone(config.payload.resolved) as Record<string, any>;
    resolved.finalisation.kind = 'local-merge';
    await f.db.appendEvents([{ sourceKey: 'config:local', kind: 'context.configured', payloadVersion: 1,
      correlationId: 'config:local', actor: person, occurredAt: new Date().toISOString(), payload: { ...config.payload, resolved } }]);
  }
  const a = await f.attempt('task'), candidate = f.db.attempt(a.id).candidate!;
  const activation = f.db.requests().find(request => request.attemptId === a.id && request.operation === 'worker.activate')!;
  await f.db.closePendingEffect(activation.id, 'withdrawn', { reason: 'Synthetic worker is already terminal; no activation will be called' }, person);
  const refs = new Map([['refs/heads/main', start], [a.binding.outputRef, head]]);
  const calls: string[] = [];
  let live = true, clean = true, protection = false, policyReadable = true, retained = true;
  const services: CompletionServices = {
    profile,
    repository: {
      createPinnedRef: async () => { throw new Error('Rebase not configured'); },
      conditionalMoveRef: async () => { throw new Error('Rebase not configured'); },
      prepareRebase: async () => { throw new Error('Rebase not configured'); },
      command: async () => { throw new Error('No actual Git in operation tests'); },
      identity: async () => confirmed('/repo'),
      readCheckPolicy: async () => parseCheckPolicy(start, policyContent, contextChecks),
      inspectRef: async ref => confirmed(refs.has(ref) ? { state: 'present', commit: refs.get(ref)! } : { state: 'absent' }),
      inspectWorkspace: async () => confirmed({ branch: a.binding.outputRef, head, clean, uncommitted: clean ? [] : ['dirty'], untracked: [] }),
      compare: async (ancestor, descendant) => confirmed(ancestor === descendant || ancestor === start),
      verifyRetention: async () => retained ? confirmed({ retained: true }) : rejected('Output is not retained'),
      conditionalFastForward: async (ref, expected, commit) => {
        calls.push('integrate');
        if (refs.get(ref) !== expected) return rejected('Target moved');
        refs.set(ref, commit); return confirmed({ ref, commit });
      },
      conditionalDeleteRef: async (ref, expected) => {
        calls.push('cleanup');
        if (refs.get(ref) !== expected) return rejected('Output moved');
        refs.delete(ref); return confirmed({ ref, commit: null });
      },
    },
    run: async check => { calls.push(check.name); return { status: 'passed', exitCode: 0, timedOut: false, stdout: '', stderr: '', truncated: false }; },
    readPolicy: async () => policyReadable ? confirmed({ digest: 'policy', forbidden: false, protected: protection }) : uncertain('Protection is unreadable'),
    workspace: {
      inspect: async () => confirmed({ state: live ? 'matching' : 'absent' }),
      returnLease: async () => {
        calls.push('return');
        if (!clean) return rejected('Dirty workspace');
        live = false; return confirmed({ returned: true });
      },
    },
  };
  const accept = { requestKey: 'accept', attemptId: a.id, candidateId: String(candidate.id), commit: head, caller: person };
  const returns = { requestKey: 'return', attemptId: a.id, caller: person };
  return { ...f, a, services, refs, calls, accept, returns,
    dirty: () => { clean = false; }, cleanWorkspace: () => { clean = true; }, protect: () => { protection = true; }, unreadable: () => { policyReadable = false; },
    loseRetention: () => { retained = false; } };
}

for (const operation of ['checks', 'acceptance', 'integration', 'return'] as const) {
  for (const change of ['ref', 'result', 'missing_result', 'linked_result', 'dirty', 'untracked'] as const) {
    test(`A18 R11: ${operation} refuses ${change} immediately before its effect`, async t => {
      const f = await fixture(t, operation === 'integration');
      const recorded = f.db.validatedWorkerResult(f.a.id);
      const mutate = async () => {
        if (change === 'ref') f.refs.set(f.a.binding.outputRef, 'c'.repeat(40));
        else if (change === 'result') await writeFile(f.a.binding.resultPath, '{}');
        else if (change === 'missing_result') await unlink(f.a.binding.resultPath);
        else if (change === 'linked_result') await link(f.a.binding.resultPath, join(f.root, 'result-link'));
        else if (change === 'dirty') f.dirty();
        else f.services.repository.inspectWorkspace = async () => confirmed({
          branch: f.a.binding.outputRef, head, clean: false, uncommitted: [], untracked: ['new-file'],
        });
      };
      if (operation === 'integration') {
        const record = f.db.recordAcceptance.bind(f.db);
        f.db.recordAcceptance = async (...args) => {
          const accepted = await record(...args);
          await mutate();
          return accepted;
        };
      } else await mutate();
      const code = change === 'ref' ? 'candidate_moved'
        : change === 'result' || change === 'missing_result' || change === 'linked_result' ? 'result_discrepancy' : 'workspace_dirty';
      const run = operation === 'checks' ? () => runCandidateChecks(f.db, f.a.id, person, f.services)
        : operation === 'return' ? () => returnAttempt(f.db, f.returns, f.services)
          : () => acceptCandidate(f.db, { ...f.accept, overrideReason: 'Exercise integrity independently of checks' }, f.services);
      await assert.rejects(run, { code });
      assert.deepEqual(f.db.validatedWorkerResult(f.a.id), recorded, 'Recorded output is immutable');
      assert.deepEqual(f.calls, [], 'No check, integration or lease return was called');
      assert.equal(f.db.attempt(f.a.id).leaseState, 'held');
      if (operation === 'acceptance') assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
    });
  }
}

test('A18 R11: acceptance rechecks result integrity after checks finish', async t => {
  const f = await fixture(t);
  const run = f.services.run;
  f.services.run = async (...args) => {
    const result = await run(...args);
    if (args[0].name === 'full') await writeFile(f.a.binding.resultPath, '{}');
    return result;
  };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'result_discrepancy' });
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
});

test('A18 R11: reused passing checks do not waive acceptance workspace integrity', async t => {
  const f = await fixture(t);
  await runCandidateChecks(f.db, f.a.id, person, f.services);
  f.dirty();
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'workspace_dirty' });
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
});

test('A17/A18 R11/R33: a later-turn observation requires terminal evidence and a strict empty payload', async t => {
  const f = await checkFixture(t);
  const a = await f.attempt('not-terminal', ['Criterion'], undefined, head, start, policyContent, 'prepared');
  const later = { ...a.observation('terminal', 3), kind: 'later_turn' as const, payload: {} };
  const before = f.db.events();
  await assert.rejects(observeWorker(f.db, later, host), { code: 'result_invalid' });
  assert.deepEqual(f.db.events(), before);
  await f.db.recordWorkerObservation(a.observation('terminal', 2), host);
  for (const patch of [{ payloadVersion: 2 }, { payload: { terminal: true } }, { sourceSequence: -1 }, { observedAt: 'invalid' }]) {
    await assert.rejects(observeWorker(f.db, { ...later, ...patch } as typeof later, host), { code: 'result_invalid' });
  }
  await observeWorker(f.db, later, host);
  assert.equal(f.db.laterTurnDiscrepancy(a.id)?.code, 'result_discrepancy');
  assert.equal(f.db.attempt(a.id).outcome, null, 'A later turn cannot complete an attempt');
});

test('A17/A18 R07/R11/R33: later turns preserve terminal output, block checks, acceptance and return, and explicit selection resolves them', async t => {
  const f = await fixture(t);
  await f.db.addObjective({ id: 'goal', request: 'Finish', criteria: ['Works'], scope: '', constraints: '', permissions: null, budget: null, deadline: null }, person);
  await f.db.moveTask('task', f.db.task('task').definitionRevision, 'goal', person);
  const before = f.db.attempt(f.a.id), result = f.db.validatedWorkerResult(f.a.id);
  const terminal = f.db.events().find(e => e.attemptId === f.a.id && e.kind === 'worker.observed' && e.payload.kind === 'terminal')!;
  const later = { ...f.a.observation('terminal', 3), kind: 'later_turn' as const, payload: {} };
  await assert.rejects(observeWorker(f.db, { ...later, payload: { noProcesses: true } }, host), { code: 'result_invalid' });
  await assert.rejects(observeWorker(f.db, { ...later, workerRef: { launcher: 'bb', threadId: 'other' } }, host), { code: 'result_identity_mismatch' });
  await observeWorker(f.db, later, host, f.services.repository, { caller: person, services: f.services });
  await observeWorker(f.db, later, host);
  assert.deepEqual(f.db.attempt(f.a.id), before);
  assert.deepEqual(f.db.validatedWorkerResult(f.a.id), result);
  assert.deepEqual(f.db.events().find(e => e.id === terminal.id), terminal);
  assert.equal(f.db.events().filter(e => e.attemptId === f.a.id && e.payload.kind === 'later_turn').length, 1);
  assert.deepEqual(f.calls, []);
  for (const run of [
    () => runCandidateChecks(f.db, f.a.id, person, f.services),
    () => runChecks(f.db, { attemptId: f.a.id, commit: head, dryRun: true }, person, 'plan-check', f.services),
    () => planCandidateAcceptance(f.db, f.accept, f.services),
    () => acceptCandidate(f.db, { ...f.accept, overrideReason: 'Person override' }, f.services),
    () => planAttemptReturn(f.db, f.returns, f.services),
    () => returnAttempt(f.db, f.returns, f.services),
  ]) await assert.rejects(run, { code: 'result_discrepancy' });
  assert.match((await leaseReturnReason(f.db, f.a.id, person, f.services))!, /result_discrepancy/);
  const briefing = buildBriefing(f.db, 'goal', person).attempts[0]!;
  assert.equal(briefing.discrepancy?.code, 'result_discrepancy');
  assert.match(briefing.nextAction!.description, /select a candidate explicitly.*discard/i);
  assert.deepEqual(f.calls, []);
  const selected = await selectCandidate(f.db, { attemptId: f.a.id, commit: head, caller: person }, f.services);
  assert.notEqual(selected.candidate!.id, before.candidate!.id, 'Selecting even the same commit explicitly resolves the discrepancy');
  assert.equal(f.db.laterTurnDiscrepancy(f.a.id), null);
  await observeWorker(f.db, later, host);
  assert.equal(f.db.laterTurnDiscrepancy(f.a.id), null, 'Replayed observation is not a new later turn');
  await runCandidateChecks(f.db, f.a.id, person, f.services);
  await acceptCandidate(f.db, { ...f.accept, candidateId: String(selected.candidate!.id) }, f.services);
  await returnAttempt(f.db, f.returns, f.services);
  assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
});

test('A18 R11/R33: a later turn after acceptance prevents integration and a person can discard instead', async t => {
  const f = await fixture(t, true);
  await runCandidateChecks(f.db, f.a.id, person, f.services);
  const authorise = f.db.recordAcceptance.bind(f.db);
  f.db.recordAcceptance = async (...args) => {
    const accepted = await authorise(...args);
    await observeWorker(f.db, { ...f.a.observation('terminal', 3), kind: 'later_turn', payload: {} }, host);
    return accepted;
  };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'result_discrepancy' });
  assert.ok(!f.calls.includes('integrate'));
  await assert.rejects(returnAttempt(f.db, f.returns, f.services), { code: 'result_discrepancy' });
  await returnAttempt(f.db, { ...f.returns, requestKey: 'discard', discard: { leaseId: f.a.allocation.leaseId, confirmed: true, reason: 'Discard later turn output' } }, f.services);
  assert.equal(f.db.laterTurnDiscrepancy(f.a.id), null);
  assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
});

test('R19/A38: exact accepted-output statements close only the objective, refuse bad evidence atomically and replay safely', async t => {
  const f = await fixture(t), db = f.db;
  const definition = { id: 'goal', request: 'Finish', criteria: ['Works', 'Explained'], scope: '', constraints: '', permissions: null, budget: null, deadline: null };
  await db.addObjective(definition, person);
  await db.addObjective({ ...definition, id: 'other' }, person);
  await db.moveTask('task', db.task('task').definitionRevision, 'goal', person);
  await acceptCandidate(db, f.accept, f.services);
  const accepted = db.acceptance(f.a.id, f.accept.candidateId)!;
  const reference = { kind: 'accepted_output' as const, attemptId: f.a.id, candidateId: f.accept.candidateId,
    candidateCommit: head, artefactDigests: [], evidenceEventId: accepted.id, reviewAttemptId: null };
  const statements = [1, 2].map(position => ({ position, statement: 'Verified', references: [reference] }));
  const snapshot = () => ({ objectives: db.objectives(), tasks: db.tasks(), attempts: db.attempt(f.a.id), events: db.events(), requests: db.requests(), claims: db.claims() });
  for (const invalid of [[], statements.slice(0, 1), [...statements, statements[0]!],
    statements.map(item => ({ ...item, position: 1 })), statements.map(item => ({ ...item, position: 3 })),
    statements.map(item => ({ ...item, statement: '  ' })), statements.map(item => ({ ...item, references: [] })),
    ...[{ evidenceEventId: 'invented' }, { attemptId: 'invented' }, { candidateId: 'invented' }, { candidateCommit: start },
      { artefactDigests: ['invented'] }, { reviewAttemptId: f.a.id }, { kind: 'review' as const }].map(patch =>
      statements.map(item => ({ ...item, references: [{ ...reference, ...patch }] })))]) {
    const before = snapshot();
    await assert.rejects(db.completeObjective('goal', invalid, person));
    assert.deepEqual(snapshot(), before);
  }
  const before = snapshot();
  await assert.rejects(db.completeObjective('other', statements, person));
  assert.deepEqual(snapshot(), before);
  const caller = { kind: 'supervisor' as const, id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
  const goal = db.objective('goal', person);
  await db.updateObjective('goal', goal.revision, { ...goal, permissions: { ...goal.permissions, completeObjective: false } }, person);
  await assert.rejects(db.completeObjective('goal', statements, caller), { code: 'permission_denied' });
  await db.updateObjective('goal', goal.revision + 1, { ...goal, permissions: { ...goal.permissions, manageTasks: false } }, person);
  const mechanical = { attempt: db.attempt(f.a.id), tasks: db.tasks(), claims: db.claims(), calls: [...f.calls] };
  const command = { requestKey: 'complete', caller, operation: 'objective.complete', input: {}, fingerprint: 'complete' };
  const internals = db as unknown as { insertEvent: (event: { kind: string }) => unknown };
  const original = internals.insertEvent;
  internals.insertEvent = function (event) { const result = original.call(db, event); if (event.kind === 'request.succeeded') throw new Error('last-event failure'); return result; };
  const rollback = snapshot();
  try { await assert.rejects(db.completeObjective('goal', statements, caller, command), /last-event failure/u); }
  finally { internals.insertEvent = original; }
  assert.deepEqual(snapshot(), rollback);
  const completed = await db.completeObjective('goal', statements, caller, command);
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.completion, statements);
  assert.deepEqual(await db.completeObjective('goal', statements, caller, command), completed);
  assert.deepEqual({ attempt: db.attempt(f.a.id), tasks: db.tasks(), claims: db.claims(), calls: f.calls }, mechanical);
  await db.closeOrReopenObjective('goal', 'reopen', 'More work', person);
  assert.deepEqual(db.objective('goal', person).completion, []);
  assert.deepEqual((db.events().find(e => e.kind === 'objective.complete')!.payload.after as any).completion, statements);
});

async function diagnosticFixture(t: Parameters<typeof checkFixture>[0]) {
  const f = await fixture(t, false, true);
  for (const claim of f.db.claims().filter(c => c.attemptId === f.a.id && !c.releasedAt)) {
    await f.db.releaseClaim({ claimId: claim.id, generation: claim.generation }, { terminal: true }, host);
  }
  return f;
}

test('A58/R40/R04: diagnostic deletion keeps exact evidence and old reservation replay', async t => {
  const f = await diagnosticFixture(t);
  const input = { attemptId: f.a.id, noProcesses: true, includeTranscript: false, dryRun: false };
  const root = join(f.db.diagnosticPaths(f.a.id).root, 'home');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested', 'transcript.txt'), 'Diagnostic only');
  const resultBefore = await readFile(f.a.binding.resultPath, 'utf8');
  await assert.rejects(cleanDiagnostics(f.db, input, person, 'clean'), /returned lease/);
  await returnAttempt(f.db, f.returns, f.services);
  const eventsBefore = f.db.events(), requestsBefore = f.db.requests();
  const plan = await cleanDiagnostics(f.db, { ...input, dryRun: true }, person, 'plan-clean');
  assert.equal(plan.steps[0]?.operation, 'diagnostics.delete');
  assert.deepEqual(f.db.events(), eventsBefore);
  assert.deepEqual(f.db.requests(), requestsBefore);
  await cleanDiagnostics(f.db, input, person, 'clean');
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  assert.equal(await readFile(f.a.binding.resultPath, 'utf8'), resultBefore);
  const intent = f.db.events().find(e => e.kind === 'diagnostics.authorised')!;
  const entries = intent.payload.entries as unknown as DiagnosticManifest['entries'];
  assert.deepEqual(entries.map(e => e.path), ['home/nested/transcript.txt', 'home/nested', 'home']);
  assert.equal(entries[0]!.size, 15);
  assert.match(entries[0]!.digest!, /^[a-f0-9]{64}$/);
  assert.ok(f.db.requests().find(r => r.operation === 'completion.diagnostics')!.result);
  for (const event of eventsBefore) assert.deepEqual(f.db.events().find(e => e.id === event.id), event);
  for (const request of requestsBefore) assert.deepEqual(f.db.request(request.id), request);
  const recorded = f.db.requests().find(r => r.requestKey === 'dispatch:task')!;
  const replay = await f.db.reserveAttempt({ taskId: 'task', requestKey: recorded.requestKey, caller: person } as Parameters<Database['reserveAttempt']>[0]);
  assert.equal(replay.attempt.id, f.a.id);
  assert.equal(replay.attempt.leaseState, 'returned');
  const noCalls = new Proxy({} as Runtime, { get() { throw new Error('Dispatch replay must not call an external owner'); } });
  const progress = await dispatch(f.db, { taskId: 'task', profile: null, dryRun: false }, person, recorded.requestKey, noCalls, () => {});
  assert.equal(progress.attempt!.id, f.a.id);
  assert.equal(progress.replayed, true);
  assert.equal((await cleanDiagnostics(f.db, input, person, 'clean')).steps.length, 0);
  assert.equal((await cleanDiagnostics(f.db, { ...input, dryRun: true }, person, 'plan-clean')).steps.length, 0);
});

test('A58/R40: worker cleanup preserves attempt evidence and keeps transcripts unless explicitly included', async t => {
  for (const includeTranscript of [false, true]) {
    const f = await diagnosticFixture(t);
    await returnAttempt(f.db, f.returns, f.services);
    const { root, transcript } = f.db.diagnosticPaths(f.a.id);
    await mkdir(join(root, 'home', 'private'), { recursive: true });
    await mkdir(dirname(transcript!), { recursive: true });
    await writeFile(join(root, 'home', 'private', 'credentials'), 'private');
    await writeFile(join(root, 'sdk.json'), 'startup');
    await writeFile(transcript!, 'transcript');
    await writeFile(join(root, 'unrelated'), 'keep');
    const evidenceRoot = dirname(f.a.binding.resultPath);
    const evidence = [f.a.binding.resultPath];
    for (const folder of ['artefacts', 'questions', 'diagnostics']) {
      await mkdir(join(evidenceRoot, folder), { recursive: true });
      const path = join(evidenceRoot, folder, 'evidence.json');
      await writeFile(path, 'evidence');
      evidence.push(path);
    }
    const before = await Promise.all(evidence.map(path => readFile(path, 'utf8')));
    const input = { attemptId: f.a.id, noProcesses: true, includeTranscript, dryRun: false };
    await cleanDiagnostics(f.db, input, person, 'clean-worker');
    await assert.rejects(readdir(join(root, 'home')), { code: 'ENOENT' });
    assert.deepEqual(await Promise.all(evidence.map(path => readFile(path, 'utf8'))), before);
    assert.equal(await readFile(join(root, 'unrelated'), 'utf8'), 'keep');
    if (!includeTranscript) {
      assert.equal(await readFile(transcript!, 'utf8'), 'transcript');
      assert.equal(await readFile(join(root, 'sdk.json'), 'utf8'), 'startup');
      // A later explicit request can remove the retained transcript with its own manifest.
      await cleanDiagnostics(f.db, { ...input, includeTranscript: true }, person, 'clean-transcript');
      assert.equal(f.db.events().filter(e => e.kind === 'diagnostics.authorised').length, 2);
    }
    await assert.rejects(readFile(transcript!), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, 'sdk.json')), { code: 'ENOENT' });
    assert.deepEqual(await Promise.all(evidence.map(path => readFile(path, 'utf8'))), before);
  }
});

test('A58/R40: cleanup refuses an attempt without recorded Pi directory evidence', async t => {
  const f = await fixture(t);
  await returnAttempt(f.db, f.returns, f.services);
  await assert.rejects(cleanDiagnostics(f.db, { attemptId: f.a.id, noProcesses: true, includeTranscript: true, dryRun: false }, person, 'clean'), /cannot be identified exactly/);
});

test('A58/R09: interrupted diagnostic deletion resumes the exact manifest after reopening SQLite', async t => {
  const f = await diagnosticFixture(t);
  await returnAttempt(f.db, f.returns, f.services);
  const root = join(f.db.diagnosticPaths(f.a.id).root, 'home');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a'), 'first');
  await writeFile(join(root, 'b'), 'second');
  class Interrupted extends DiagnosticsDirectory {
    override async remove(_manifest: DiagnosticManifest) {
      await unlink(join(root, 'a'));
      throw new Error('Interrupted after first unlink');
    }
  }
  const input = { attemptId: f.a.id, noProcesses: true, includeTranscript: false, dryRun: false };
  await assert.rejects(cleanDiagnostics(f.db, input, person, 'clean', new Interrupted()), /did not succeed/);
  const intent = f.db.events().find(e => e.kind === 'diagnostics.authorised')!;
  const noCalls = new Proxy({} as Runtime, { get() { throw new Error('Uncertain cleanup must not cause a dispatch owner call'); } });
  const replay = await dispatch(f.db, { taskId: 'task', profile: null, dryRun: false }, person, 'dispatch:task', noCalls, () => {});
  assert.equal(replay.replayed, true);
  assert.equal(await readFile(join(root, 'b'), 'utf8'), 'second');
  assert.equal(f.db.requests().find(r => r.operation === 'completion.diagnostics')!.state, 'uncertain');
  f.db.close();
  const db = await Database.open(f.path, f.options);
  defer(t, () => db.close());
  await cleanDiagnostics(db, input, person, 'clean');
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  assert.deepEqual(db.events().find(e => e.id === intent.id), intent);
  assert.equal(db.requests().filter(r => r.operation === 'completion.diagnostics').length, 1);
  assert.equal(db.requests().find(r => r.operation === 'completion.diagnostics')!.state, 'succeeded');
});

test('A58/R40: returned diagnostics still refuse an unresolved owner or effect', async t => {
  const f = await fixture(t, false, true);
  await returnAttempt(f.db, f.returns, f.services);
  const input = { attemptId: f.a.id, noProcesses: true, includeTranscript: false, dryRun: false };
  await assert.rejects(cleanDiagnostics(f.db, input, person, 'clean'), /owner is unresolved/);
  for (const claim of f.db.claims().filter(c => c.attemptId === f.a.id && !c.releasedAt)) {
    await f.db.releaseClaim({ claimId: claim.id, generation: claim.generation }, { terminal: true }, host);
  }
  const executor = f.db.claims().find(c => c.resourceKey === 'dispatch')!;
  const parent = await f.db.recordCommand({ requestKey: 'unresolved-parent', operation: 'test', caller: person, fingerprint: 'test', input: {} });
  await f.db.recordEffect({ requestKey: 'unresolved', operation: 'test.effect', caller: person, fingerprint: 'test', input: {},
    parentId: parent.id, attemptId: f.a.id, executor: { claimId: executor.id, generation: executor.generation },
    target: { kind: 'diagnostics', reference: {} } });
  await assert.rejects(cleanDiagnostics(f.db, input, person, 'clean'), /unresolved effect/);
  assert.equal(f.db.events().some(e => e.kind === 'diagnostics.authorised'), false);
});

test('A58/R40: diagnostics refuse missing confirmation and authoritative references', async t => {
  const f = await diagnosticFixture(t);
  await returnAttempt(f.db, f.returns, f.services);
  const root = join(f.db.diagnosticPaths(f.a.id).root, 'home');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'log'), 'keep');
  const input = { attemptId: f.a.id, noProcesses: true, includeTranscript: false, dryRun: false };
  await assert.rejects(cleanDiagnostics(f.db, { ...input, noProcesses: false }, person, 'clean'), e => e instanceof CommandFailure && e.code === 'process_confirmation_required');
  await f.db.appendEvents([{ sourceKey: 'retained-diagnostic', kind: 'deliverable.retained', payloadVersion: 1,
    correlationId: 'retained-diagnostic', actor: person, occurredAt: new Date().toISOString(), payload: { path: join(root, 'log') } }]);
  await assert.rejects(cleanDiagnostics(f.db, input, person, 'clean'), /referenced/);
  assert.equal(await readFile(join(root, 'log'), 'utf8'), 'keep');
});

test('R11: person discards terminal missing/invalid results without retention and frees execution capacity', async t => {
  for (const invalid of [false, true]) {
    const f = await fixture(t);
    const a = await f.attempt(`missing-${invalid}`, ['Criterion'], undefined, head, start, policyContent, 'prepared');
    const activation = f.db.requests().find(r => r.attemptId === a.id && r.operation === 'worker.activate')!;
    await f.db.closePendingEffect(activation.id, 'withdrawn', { reason: 'No activation in fixture' }, person);
    if (invalid) await writeFile(a.binding.resultPath, 'invalid');
    else await unlink(a.binding.resultPath);
    const input = { requestKey: `discard-${invalid}`, attemptId: a.id, caller: person,
      discard: { leaseId: a.allocation.leaseId, confirmed: true as const, reason: 'Result unavailable' } };
    await assert.rejects(returnAttempt(f.db, input, f.services), /terminal/);
    await f.db.recordWorkerObservation(a.observation('terminal', 2), host);
    f.dirty();
    await assert.rejects(returnAttempt(f.db, input, f.services), { code: 'workspace_dirty' });
    assert.equal(f.db.attempt(a.id).outcome, 'failed', 'discard settles the outcome but keeps dirty work');
    assert.equal(f.db.attempt(a.id).leaseState, 'held');
    f.cleanWorkspace();
    f.services.repository.verifyRetention = async () => { throw new Error('Must not require retained output'); };
    await returnAttempt(f.db, input, f.services);
    await returnAttempt(f.db, input, f.services);
    assert.equal(f.db.attempt(a.id).outcome, 'failed');
    assert.equal(f.db.attempt(a.id).executionOpen, false);
    assert.equal(f.db.attempt(a.id).leaseState, 'returned');
    assert.equal(f.db.task(a.binding.identity.taskId as string).holdReason, 'discarded');
    assert.equal(f.db.events().filter(e => e.sourceKey === `attempt.discard_failed:${a.id}`).length, 1);
  }
});

test('A21/R11: automatic return records its origin, cleans integrated refs and keeps manual output', async t => {
  for (const local of [true, false]) {
    const f = await fixture(t, local);
    await acceptCandidate(f.db, f.accept, f.services);
    const returned = await automaticReturn(f.db, f.a.id, person, f.services);
    assert.equal(returned.state, 'returned');
    assert.equal(returned.attempt.leaseState, 'returned');
    assert.equal(f.refs.has(f.a.binding.outputRef), !local);
    const event = f.db.events().find(e => e.kind === 'return.authorised')!;
    assert.equal(event.payload.automatic, true);
    assert.equal('noProcesses' in event.payload, false);
    assert.equal((await automaticReturn(f.db, f.a.id, person, f.services)).state, 'returned');
    assert.equal(f.calls.filter(call => call === 'return').length, 1);
  }
});

test('A21/R11: automatic return keeps dirty, unretained, mismatched and unresolved work with current reasons', async t => {
  for (const failure of ['dirty', 'retention', 'allocation', 'effect']) {
    const f = await fixture(t);
    await acceptCandidate(f.db, { ...f.accept, overrideReason: 'Independently verified' }, f.services);
    if (failure === 'dirty') f.dirty();
    if (failure === 'retention') f.loseRetention();
    if (failure === 'allocation') f.services.workspace.inspect = async () => confirmed({ state: 'mismatch' });
    if (failure === 'effect') {
      f.services.run = async () => ({ status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false });
      await runCandidateChecks(f.db, f.a.id, person, f.services, 'uncertain-check');
    }
    const kept = await automaticReturn(f.db, f.a.id, person, f.services);
    assert.equal(kept.state, 'kept', failure);
    assert.equal(kept.attempt.leaseState, 'held');
    assert.match(kept.reason!, /workspace_dirty|retained|match|unresolved/);
    assert.equal(await leaseReturnReason(f.db, f.a.id, person, f.services), kept.reason);
    assert.equal(f.calls.includes('return'), false);
  }
});

test('R11: discard records the person decision before keeping dirt, then explicit return needs no retained output', async t => {
  const f = await fixture(t);
  f.dirty(); f.loseRetention();
  const discard = { leaseId: f.a.allocation.leaseId, confirmed: true as const, reason: 'No longer needed' };
  const kept = await automaticReturn(f.db, f.a.id, person, f.services, discard, 'person-discard');
  assert.equal(kept.state, 'kept');
  assert.equal(f.db.task('task').holdReason, 'discarded');
  const authorisation = f.db.events().find(e => e.kind === 'return.authorised')!;
  assert.equal(authorisation.payload.automatic, false);
  assert.equal(authorisation.payload.discardReason, discard.reason);
  f.cleanWorkspace();
  await returnAttempt(f.db, f.returns, f.services);
  assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
});

test('R11: discard keeps an unresolved effect without losing the person decision', async t => {
  const f = await fixture(t);
  f.services.run = async () => ({ status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false });
  await runCandidateChecks(f.db, f.a.id, person, f.services, 'uncertain-before-discard');
  const kept = await automaticReturn(f.db, f.a.id, person, f.services,
    { leaseId: f.a.allocation.leaseId, confirmed: true, reason: 'Stop work on this task' }, 'discard-unresolved');
  assert.equal(kept.state, 'kept');
  assert.match(kept.reason!, /unresolved effect/);
  assert.equal(f.db.task('task').holdReason, 'discarded');
  assert.equal(f.calls.includes('return'), false);
});

test('R11: an invalid discard is refused rather than reported as a successful decision with a kept lease', async t => {
  const f = await fixture(t);
  const running = await f.attempt('running-discard', ['Criterion'], undefined, head, start, policyContent, 'validated');
  await assert.rejects(automaticReturn(f.db, running.id, person, f.services,
    { leaseId: running.allocation.leaseId, confirmed: true, reason: 'Not stopped' }, 'invalid-discard'), /terminal/);
  assert.equal(f.db.events().some(e => e.attemptId === running.id && e.kind === 'return.authorised'), false);
});

test('R30: acceptance plans missing checks and conditional acceptance without writes; execution runs those checks', async t => {
  const f = await fixture(t, true);
  const events = f.db.events(), requests = f.db.requests(), claims = f.db.claims();
  const plan = await planCandidateAcceptance(f.db, f.accept, f.services);
  assert.deepEqual(plan.steps.map(s => s.operation), ['checks.run', 'candidate.accept', 'repository.integrate', 'task.complete']);
  assert.equal(plan.steps[1]!.conditional, true);
  assert.deepEqual(f.db.events(), events); assert.deepEqual(f.db.requests(), requests); assert.deepEqual(f.db.claims(), claims);
  assert.deepEqual(f.calls, []);
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full', 'integrate']);
  assert.deepEqual((await planCandidateAcceptance(f.db, f.accept, f.services)).steps, []);
  const returnPlan = await planAttemptReturn(f.db, f.returns, f.services);
  assert.deepEqual(returnPlan.steps.map(s => s.target), [f.a.allocation.leaseId]);
});

test('R10: acceptance runs fast/full checks once, records the exact candidate and keeps manual output and lease', async t => {
  const f = await fixture(t);
  await acceptCandidate(f.db, f.accept, f.services);
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full']);
  assert.equal(f.db.task('task').state, 'done');
  assert.equal(f.db.attempt(f.a.id).leaseState, 'held');
  const accepted = f.db.acceptance(f.a.id, f.accept.candidateId)!;
  assert.equal((accepted.payload.candidate as any).commit, head);
  assert.equal(accepted.payload.overrideReason, null);
  await returnAttempt(f.db, f.returns, f.services);
  await returnAttempt(f.db, f.returns, f.services);
  assert.ok(f.refs.has(f.a.binding.outputRef));
  assert.deepEqual(f.calls, ['fast', 'full', 'return']);
});

test('R10: failed and missing checks require a nonblank person reason scoped to the exact candidate', async t => {
  const f = await fixture(t);
  f.services.run = async () => ({ status: 'failed', exitCode: 1, timedOut: false, stdout: '', stderr: 'failure', truncated: false });
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'check_failed' });
  await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), { code: 'check_failed' });
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, overrideReason: '  ' }, f.services), /nonblank/);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, requestKey: 'override-wrong', commit: start, overrideReason: 'Known failure' }, f.services), /candidate/);
  await acceptCandidate(f.db, { ...f.accept, requestKey: 'override', overrideReason: 'Known unrelated failure' }, f.services);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId)!.payload.overrideReason, 'Known unrelated failure');
  const other = await fixture(t);
  await acceptCandidate(other.db, { ...other.accept, overrideReason: 'Checks unavailable; reviewed by person' }, other.services);
  assert.deepEqual(other.calls, []);
});

test('R10: acceptance reuses an explicit successful retry after the automatic check request failed', async t => {
  const f = await fixture(t), run = f.services.run;
  f.services.run = async () => ({ status: 'failed', exitCode: 1, timedOut: false, stdout: '', stderr: '', truncated: false });
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'check_failed' });
  f.services.run = run;
  await runCandidateChecks(f.db, f.a.id, person, f.services, 'explicit-check-retry');
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full']);
  assert.equal(f.db.task('task').state, 'done');
});

test('R08/R09/R10/R16/R30: acceptance reuses an explicit pass after exact check recovery without rerunning the withdrawn key', async t => {
  for (const state of ['claimed', 'uncertain'] as const) {
    const f = await fixture(t), run = f.services.run;
    let original;
    if (state === 'claimed') {
      original = (await f.db.beginChecks({ attemptId: f.a.id, commit: head,
        checks: mandatoryChecks(f.db.attempt(f.a.id).specification.checks as TrustedChecks,
          parseCheckPolicy(start, policyContent, contextChecks)), profile, caller: person })).request;
    } else {
      f.services.run = async check => {
        f.calls.push(check.name);
        return { status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: 'Interrupted diagnostic', truncated: false };
      };
      original = await runCandidateChecks(f.db, f.a.id, person, f.services);
      f.services.run = run;
    }
    await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), { code: state === 'claimed' ? 'checks_waiting' : 'effect_uncertain' });
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: state === 'claimed' ? 'checks_waiting' : 'effect_uncertain' });
    const input = { checkRequestId: original.id, confirmStopped: true, evidence: 'Inspected exact check executor and commands; all stopped', dryRun: false };
    const command = { requestKey: 'resolve', operation: 'checks.resolve', caller: person, input, fingerprint: canonicalJson(input) };
    const resolved = await f.db.resolveChecksByPerson(original.id, true, input.evidence, false, person, command);
    const snapshot = () => ({ events: f.db.events(), requests: f.db.requests(), claims: f.db.claims(), attempt: f.db.attempt(f.a.id) });
    const afterResolution = snapshot(), callsBeforeRetry = [...f.calls];
    assert.deepEqual(await f.db.resolveChecksByPerson(original.id, true, input.evidence, false, person, command), resolved);
    assert.deepEqual(snapshot(), afterResolution);
    await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), { code: 'check_missing' });
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'check_missing' });
    assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
    assert.deepEqual(f.calls, callsBeforeRetry);
    const retryInput = { attemptId: f.a.id, commit: head, dryRun: false };
    await runChecks(f.db, retryInput, person, 'explicit-retry', f.services);
    const retry = f.db.requests().find(request => request.requestKey === 'explicit-retry')!;
    assert.equal(retry.state, 'succeeded');
    assert.equal(retry.input.evidenceKey, original.input.evidenceKey);
    const beforePlan = snapshot();
    assert.deepEqual((await planCandidateAcceptance(f.db, f.accept, f.services)).steps.map(step => step.operation), ['candidate.accept', 'task.complete']);
    assert.deepEqual(snapshot(), beforePlan);
    await acceptCandidate(f.db, f.accept, f.services);
    const accepted = f.db.acceptance(f.a.id, f.accept.candidateId)!;
    assert.equal(accepted.payload.checksRequestId, retry.id);
    assert.equal(accepted.payload.overrideReason, null);
    assert.equal(f.db.task('task').state, 'done');
    const afterAcceptance = snapshot();
    await acceptCandidate(f.db, f.accept, f.services);
    await runChecks(f.db, retryInput, person, 'explicit-retry', f.services);
    assert.equal((await runCandidateChecks(f.db, f.a.id, person, f.services)).state, 'withdrawn');
    await assert.rejects(runChecks(f.db, retryInput, person, original.requestKey, f.services), { code: 'check_missing' });
    assert.deepEqual(snapshot(), afterAcceptance);
    assert.deepEqual(f.calls, [...callsBeforeRetry, 'fast', 'full']);
    assert.equal(f.db.request(original.id).state, 'withdrawn');
    assert.equal(f.db.request(original.id).result?.status, 'uncertain');
    if (original.result) assert.deepEqual(f.db.request(original.id).result, original.result);
  }
});

test('R16/R27: acceptance names waiting checks and their slot holder, then retries the pending run and accepts', async t => {
  const f = await fixture(t), other = await f.attempt('slot-holder', ['Other criterion']);
  const checks = mandatoryChecks(f.db.attempt(other.id).specification.checks as TrustedChecks,
    parseCheckPolicy(start, policyContent, contextChecks));
  const holder = await f.db.beginChecks({ attemptId: other.id, commit: head, checks, profile, caller: person });
  const assertWaiting = (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.code, 'checks_waiting');
    const waiting = f.db.requests().find(r => r.attemptId === f.a.id && r.operation === 'checks.run')!;
    assert.deepEqual(error.data.checkRequest, { id: waiting.id, requestId: waiting.requestKey,
      state: 'pending', status: null, evidenceKey: waiting.input.evidenceKey });
    assert.deepEqual(error.data.slotHolders, [{ claimId: holder.executor!.claimId, attemptId: other.id,
      ownerRef: person, checkRequestId: holder.request.id, requestId: holder.request.requestKey, state: 'claimed' }]);
    assert.equal(error.nextAction?.operation, 'attempt.accept');
    assert.deepEqual(error.nextAction?.args, { attemptId: f.a.id, candidateCommit: head, overrideReason: null, dryRun: false });
    return true;
  };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), assertWaiting);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), assertWaiting);
  assert.equal(f.db.attempt(f.a.id).phase, 'awaiting_checks');
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.deepEqual(f.calls, []);
  assert.ok((await planCandidateAcceptance(f.db, f.accept, f.services)).steps.some(s => s.operation === 'checks.run'));
  const waiting = f.db.requests().find(r => r.attemptId === f.a.id && r.operation === 'checks.run')!;
  await f.db.finishChecks(holder.request.id, holder.executor!, { status: 'failed',
    evidenceKey: String(holder.request.input.evidenceKey), commands: [] });
  await acceptCandidate(f.db, f.accept, f.services);
  assert.equal(f.db.request(waiting.id).state, 'succeeded');
  assert.deepEqual(f.calls, ['fast', 'full']);
  assert.equal(f.db.task('task').state, 'done');
});

test('R16/R27: claimed and uncertain checks report their actual state in acceptance and planning', async t => {
  for (const state of ['claimed', 'uncertain'] as const) {
    const f = await fixture(t);
    const admission = await f.db.beginChecks({ attemptId: f.a.id, commit: head,
      checks: mandatoryChecks(f.db.attempt(f.a.id).specification.checks as TrustedChecks,
        parseCheckPolicy(start, policyContent, contextChecks)), profile, caller: person });
    if (state === 'uncertain') await f.db.finishChecks(admission.request.id, admission.executor!, {
      status: 'uncertain', evidenceKey: String(admission.request.input.evidenceKey), commands: [] });
    const inspect = (error: unknown) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.code, state === 'claimed' ? 'checks_waiting' : 'effect_uncertain');
      assert.equal((error.data.checkRequest as any).state, state);
      assert.equal((error.data.checkRequest as any).requestId, admission.request.requestKey);
      return true;
    };
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), inspect);
    await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), inspect);
    assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
    assert.deepEqual(f.calls, []);
  }
});

test('R10: a person can override checks waiting for a slot without leaving an authorised check behind', async t => {
  const f = await fixture(t, true), other = await f.attempt('other');
  const checks = parseCheckPolicy(start, policyContent, contextChecks);
  await f.db.beginChecks({ attemptId: other.id, commit: head, checks, profile, caller: person });
  const waiting = await f.db.beginChecks({ attemptId: f.a.id, commit: head, checks, profile, caller: person });
  assert.equal(waiting.request.state, 'pending');
  await acceptCandidate(f.db, { ...f.accept, overrideReason: 'Person has independently verified the output' }, f.services);
  assert.equal(f.db.request(waiting.request.id).state, 'withdrawn');
  assert.deepEqual(f.calls, ['integrate']);
  assert.equal(f.db.task('task').state, 'done');
});

test('R10/R11: a check override never waives repository or allocation identity', async t => {
  const f = await fixture(t);
  f.services.repository.identity = async path => confirmed(path === f.a.allocation.path ? '/different-repository' : '/repo');
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, overrideReason: 'Known check failure' }, f.services), /different repository/);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.deepEqual(f.calls, []);
});

test('R10/R15: changed mandatory policy after checks cannot reuse an old pass for acceptance', async t => {
  const f = await fixture(t), read = f.services.repository.readCheckPolicy;
  let reads = 0;
  f.services.repository.readCheckPolicy = async (...args) => ++reads === 1 ? read(...args) : parseCheckPolicy(start, policyContent + '\n', contextChecks);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /policy changed/);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.deepEqual(f.calls, ['fast', 'full']);
});

test('R10/R17: incomplete trusted callers and changed candidate identity cannot accept, even on replay', async t => {
  const f = await fixture(t);
  await acceptCandidate(f.db, f.accept, f.services);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, caller: { kind: 'supervisor', id: 'model' } as any }, f.services), TypeError);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, candidateId: 'other' }, f.services), /candidate/);
});

test('R10/R32: local-merge integrates once; a target already containing the candidate needs no mutation', async t => {
  for (const contains of [false, true]) {
    const f = await fixture(t, true);
    if (contains) f.refs.set('refs/heads/main', head);
    await acceptCandidate(f.db, f.accept, f.services);
    await acceptCandidate(f.db, f.accept, f.services);
    assert.equal(f.calls.filter(call => call === 'integrate').length, contains ? 0 : 1);
    assert.equal(f.db.task('task').state, 'done');
    await returnAttempt(f.db, f.returns, f.services);
    assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
    assert.equal(f.refs.has(f.a.binding.outputRef), false);
    assert.equal(f.calls.filter(call => call === 'cleanup').length, 1);
  }
});

test('R10/R32: protected or unreadable target protection refuses local-merge and preserves output', async t => {
  for (const failure of ['protected', 'unknown', 'absent']) {
    const f = await fixture(t, true);
    if (failure === 'protected') f.protect();
    if (failure === 'unknown') f.unreadable();
    if (failure === 'absent') f.refs.delete('refs/heads/main');
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services));
    assert.ok(f.refs.has(f.a.binding.outputRef));
    assert.equal(f.calls.includes('integrate'), false);
    assert.notEqual(f.db.task('task').state, 'done');
  }
});

test('R27/R30: target restrictions refuse planning and execution before divergent-target handling', async t => {
  for (const restriction of ['protected', 'forbidden']) {
    const f = await fixture(t, true);
    f.refs.set('refs/heads/main', 'c'.repeat(40));
    f.services.readPolicy = async () => confirmed({ digest: 'policy',
      forbidden: restriction === 'forbidden', protected: restriction === 'protected' });
    const events = f.db.events(), requests = f.db.requests();
    const refusal = (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, 'conflict');
      assert.equal(error.message, 'Protected target or finalisation policy refuses local-merge');
      return true;
    };
    await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), refusal);
    assert.deepEqual(f.db.events(), events);
    assert.deepEqual(f.db.requests(), requests);
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), refusal);
    assert.equal(f.refs.get(f.a.binding.outputRef), head);
    assert.equal(f.refs.get('refs/heads/main'), 'c'.repeat(40));
    assert.equal(f.calls.includes('integrate'), false);
  }
});

test('R27/R30: a divergent target refuses planning and execution with exact commits and a rebase action', async t => {
  const f = await fixture(t, true), moved = 'c'.repeat(40);
  f.refs.set('refs/heads/main', moved);
  const events = f.db.events(), requests = f.db.requests();
  const refusal = (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.code, 'not_fast_forward');
    assert.deepEqual(error.data, { attemptId: f.a.id, targetRef: 'refs/heads/main', targetCommit: moved, candidateCommit: head });
    assert.deepEqual(error.nextAction?.args, { attemptId: f.a.id, dryRun: true });
    assert.equal(error.nextAction?.operation, 'attempt.rebase');
    return true;
  };
  await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), refusal);
  assert.deepEqual(f.db.events(), events);
  assert.deepEqual(f.db.requests(), requests);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), refusal);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.equal(f.calls.includes('integrate'), false);
  assert.ok(f.refs.has(f.a.binding.outputRef));
});

test('R27/R32: target movement after acceptance planning refuses without moving or deleting output', async t => {
  const f = await fixture(t, true), record = f.db.recordAcceptance.bind(f.db);
  f.db.recordAcceptance = async (...args) => {
    const result = await record(...args);
    f.refs.set('refs/heads/main', 'c'.repeat(40));
    return result;
  };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.code, 'not_fast_forward');
    assert.equal(error.data.targetCommit, 'c'.repeat(40));
    return true;
  });
  assert.equal(f.calls.includes('integrate'), false);
  assert.ok(f.refs.has(f.a.binding.outputRef));
});

// Each injected crash occurs after the durable step, as if its response was lost.
test('R10/A24: interrupted acceptance resumes every durable step without repeating checks or integration', async t => {
  for (const step of ['recordCommand', 'finishChecks', 'recordAcceptance', 'beginCompletionEffect', 'claimEffect', 'recordEffectOutcome', 'finishAcceptance'] as const) {
    const f = await fixture(t, true);
    const original = (f.db[step] as Function).bind(f.db);
    let interrupted = false;
    (f.db as any)[step] = async (...args: any[]) => {
      const value = await original(...args);
      if (!interrupted) { interrupted = true; throw new Error(`crash:${step}`); }
      return value;
    };
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /crash/);
    if (step === 'claimEffect') {
      // A claimed intent is uncertain, not permission to call. Owner evidence of integration settles it.
      assert.equal(f.calls.includes('integrate'), false);
      await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /unresolved/);
      f.refs.set('refs/heads/main', head);
    }
    const reopened = await Database.open(f.path, f.options); defer(t, () => reopened.close());
    await acceptCandidate(reopened, f.accept, f.services);
    await acceptCandidate(reopened, f.accept, f.services);
    assert.equal(reopened.task('task').state, 'done', step);
    assert.equal(f.calls.filter(call => call === 'fast').length, 1, step);
    assert.equal(f.calls.filter(call => call === 'full').length, 1, step);
    assert.equal(f.calls.filter(call => call === 'integrate').length, step === 'claimEffect' ? 0 : 1, step);
  }
});

test('R10/A24: integration performed before a lost response is reconciled, never repeated', async t => {
  const f = await fixture(t, true), integrate = f.services.repository.conditionalFastForward;
  f.services.repository.conditionalFastForward = async (...args) => { await integrate(...args); throw new Error('Lost owner response'); };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /did not succeed/);
  await acceptCandidate(f.db, f.accept, f.services);
  assert.equal(f.calls.filter(call => call === 'integrate').length, 1);
  assert.equal(f.db.task('task').state, 'done');
});

test('R10: a newer person hold or reopen wins over interrupted acceptance completion', async t => {
  const f = await fixture(t, true), finish = f.db.finishAcceptance.bind(f.db);
  f.db.finishAcceptance = async accepted => { await f.db.holdTask('task', 'Person decision', person); return finish(accepted); };
  await acceptCandidate(f.db, f.accept, f.services);
  assert.equal(f.db.task('task').holdReason, 'Person decision');
  assert.notEqual(f.db.task('task').state, 'done');
});

test('R10: a person decision after acceptance but before integration prevents the effect', async t => {
  const f = await fixture(t, true), record = f.db.recordAcceptance.bind(f.db);
  f.db.recordAcceptance = async (...args) => { const value = await record(...args); await f.db.holdTask('task', 'Wait', person); return value; };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /newer person/);
  assert.equal(f.calls.includes('integrate'), false);
});

test('R10: a person decision after claiming but immediately before the owner call prevents integration', async t => {
  const f = await fixture(t, true), claim = f.db.claimEffect.bind(f.db);
  f.db.claimEffect = async (...args) => { const result = await claim(...args); await f.db.holdTask('task', 'Stop before owner call', person); return result; };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /did not succeed/);
  assert.equal(f.calls.includes('integrate'), false);
  assert.equal(f.db.task('task').holdReason, 'Stop before owner call');
});

test('R11: return refuses dirty work, mismatched allocation, missing retention and invalid discard confirmation', async t => {
  for (const failure of ['dirty', 'mismatch', 'retention', 'discard']) {
    const f = await fixture(t);
    let input: any = f.returns;
    if (failure === 'dirty') f.dirty();
    if (failure === 'mismatch') f.services.workspace.inspect = async () => confirmed({ state: 'mismatch' });
    if (failure === 'retention') f.loseRetention();
    if (failure === 'discard') input = { ...input, discard: { leaseId: f.a.allocation.leaseId, confirmed: false } };
    await assert.rejects(returnAttempt(f.db, input, f.services));
    assert.equal(f.calls.includes('return'), false, failure);
    assert.equal(f.db.attempt(f.a.id).leaseState, 'held');
  }
});

test('R11: a non-terminal worker and unresolved check effect refuse return, including with an override', async t => {
  const f = await fixture(t);
  const running = await f.attempt('running', ['Criterion'], undefined, head, start, policyContent, 'validated');
  await assert.rejects(returnAttempt(f.db, { ...f.returns, requestKey: 'running-return', attemptId: running.id,
    }, f.services), /stopped terminal/);
  f.services.run = async () => ({ status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false });
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services));
  await assert.rejects(returnAttempt(f.db, f.returns, f.services), /unresolved effect/);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, requestKey: 'override', overrideReason: 'Accept failure' }, f.services), /unresolved effect/);
});

test('R03/R11: discard returns once, holds unfinished work and preserves a newer done decision', async t => {
  for (const done of [false, true]) {
    const f = await fixture(t);
    if (done) await f.db.markTaskDone('task', person);
    const input = { ...f.returns, discard: { leaseId: f.a.allocation.leaseId, confirmed: true as const, reason: 'Output is no longer needed' } };
    await returnAttempt(f.db, input, f.services);
    await returnAttempt(f.db, input, f.services);
    assert.equal(f.db.task('task').state, done ? 'done' : 'queued');
    assert.equal(f.db.task('task').holdReason, done ? null : 'discarded');
    assert.deepEqual(f.calls, ['return', 'cleanup']);
  }
});

test('R11: lost return response reconciles from the matching pool and never repeats return', async t => {
  const f = await fixture(t), original = f.services.workspace.returnLease;
  f.services.workspace.returnLease = async (...args) => { await original(...args); throw new Error('Lost return response'); };
  await assert.rejects(returnAttempt(f.db, f.returns, f.services));
  await returnAttempt(f.db, f.returns, f.services);
  assert.deepEqual(f.calls, ['return']);
  assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
});

test('R11: moved refs, failed cleanup and unknown cleanup never reverse a confirmed return', async t => {
  for (const failure of ['moved', 'rejected', 'uncertain']) {
    const f = await fixture(t, true);
    await acceptCandidate(f.db, f.accept, f.services);
    if (failure === 'moved') {
      const returnLease = f.services.workspace.returnLease;
      f.services.workspace.returnLease = async (...args) => {
        const result = await returnLease(...args);
        f.refs.set(f.a.binding.outputRef, 'c'.repeat(40));
        return result;
      };
    }
    else f.services.repository.conditionalDeleteRef = async () => failure === 'rejected' ? rejected('Checked out elsewhere') : uncertain('Lost delete response');
    await returnAttempt(f.db, f.returns, f.services);
    assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
    assert.ok(f.refs.has(f.a.binding.outputRef));
    await returnAttempt(f.db, f.returns, f.services);
    assert.ok(f.refs.has(f.a.binding.outputRef));
  }
});

test('R11: changed validated output refuses acceptance and return, even with a check override', async t => {
  const f = await fixture(t);
  await writeFile(f.a.binding.resultPath, '{}');
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, overrideReason: 'Ignore checks' }, f.services));
  await assert.rejects(returnAttempt(f.db, f.returns, f.services));
  assert.deepEqual(f.calls, []);
});

test('R10/A24: unknown owner reads before and after integration intent retry without another check or effect', async t => {
  for (const failAt of [1, 2]) {
    const f = await fixture(t, true), read = f.services.readPolicy!;
    let reads = 0;
    f.services.readPolicy = async (...args) => ++reads === failAt ? uncertain('Owner read failed') : read(...args);
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /Owner read failed/);
    await acceptCandidate(f.db, f.accept, f.services);
    assert.deepEqual(f.calls, ['fast', 'full', 'integrate']);
    assert.equal(f.db.task('task').state, 'done');
  }
});

test('R10/A24: concurrent acceptance inspects claimed integration and cannot call it again', async t => {
  const f = await fixture(t, true), integrate = f.services.repository.conditionalFastForward;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  f.services.repository.conditionalFastForward = async (...args) => { entered(); await ready; return integrate(...args); };
  const first = acceptCandidate(f.db, f.accept, f.services);
  await waiting;
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /unresolved/);
  release(); await first;
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full', 'integrate']);
});

test('R11/A24: return resumes after each durable step and never repeats the lease effect', async t => {
  for (const step of ['recordCommand', 'authoriseReturn', 'beginCompletionEffect', 'recordEffectOutcome', 'finishReturn'] as const) {
    const f = await fixture(t), original = (f.db[step] as Function).bind(f.db);
    let interrupted = false;
    (f.db as any)[step] = async (...args: any[]) => {
      const value = await original(...args);
      if (!interrupted) { interrupted = true; throw new Error(`crash:${step}`); }
      return value;
    };
    await assert.rejects(returnAttempt(f.db, f.returns, f.services), /crash/);
    const reopened = await Database.open(f.path, f.options); defer(t, () => reopened.close());
    await returnAttempt(reopened, f.returns, f.services);
    await returnAttempt(reopened, f.returns, f.services);
    assert.equal(reopened.attempt(f.a.id).leaseState, 'returned');
    assert.deepEqual(f.calls, ['return']);
  }
});

test('R11: a recreated output ref is not deleted again after successful cleanup', async t => {
  const f = await fixture(t, true);
  await acceptCandidate(f.db, f.accept, f.services);
  await returnAttempt(f.db, f.returns, f.services);
  f.refs.set(f.a.binding.outputRef, head);
  await returnAttempt(f.db, f.returns, f.services);
  assert.equal(f.refs.get(f.a.binding.outputRef), head);
  assert.equal(f.calls.filter(call => call === 'cleanup').length, 1);
});

test('R10/R11/R25: task completion and returned state roll back with failed explanatory events', async t => {
  for (const kind of ['acceptance.finished', 'lease.returned']) {
    for (const after of [false, true]) {
      const f = await fixture(t, true), target = f.db as any, original = target.insertEvent;
      let failed = false;
      target.insertEvent = function (event: any) {
        if (!failed && event.kind === kind) {
          failed = true;
          if (after) original.call(this, event);
          throw new Error('Injected event failure');
        }
        return original.call(this, event);
      };
      if (kind === 'acceptance.finished') {
        await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /Injected/);
        assert.notEqual(f.db.task('task').state, 'done');
        await acceptCandidate(f.db, f.accept, f.services);
        assert.equal(f.db.task('task').state, 'done');
        assert.equal(f.calls.filter(call => call === 'integrate').length, 1);
      } else {
        await assert.rejects(returnAttempt(f.db, f.returns, f.services), /Injected/);
        assert.equal(f.db.attempt(f.a.id).leaseState, 'held');
        await returnAttempt(f.db, f.returns, f.services);
        assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
        assert.deepEqual(f.calls, ['return']);
      }
      assert.equal(f.db.events().filter(event => event.kind === kind).length, 1);
    }
  }
});

test('R11: explicit retained branch selection creates a fresh exact candidate and requires fresh checks', async t => {
  const f = await fixture(t), commit = 'c'.repeat(40);
  f.refs.set(f.a.binding.outputRef, commit);
  f.services.repository.inspectWorkspace = async () => confirmed({ branch: f.a.binding.outputRef, head: commit, clean: true, uncommitted: [], untracked: [] });
  const beforeSelection = f.db.attempt(f.a.id);
  const plan = await planCandidateAcceptance(f.db, { ...f.accept, candidateId: 'planned-selection', commit }, f.services, true);
  assert.equal(plan.steps[0]!.operation, 'candidate.select');
  assert.deepEqual(f.db.attempt(f.a.id), beforeSelection);
  await selectCandidate(f.db, { attemptId: f.a.id, commit, caller: person }, f.services);
  const selected = f.db.attempt(f.a.id).candidate!;
  assert.notEqual(selected.id, f.accept.candidateId);
  assert.equal(selected.commit, commit);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /candidate/);
  await assert.rejects(selectCandidate(f.db, { attemptId: f.a.id, commit: head, caller: person }, f.services), /exact candidate/);
});

test('R11/A18: output rechecks use the ordinary workspace read, so declared generated files do not refuse checks or acceptance', async t => {
  const f = await fixture(t);
  const reads: unknown[][] = [];
  // The real adapter rejects a check-mode read when ignored files such as node_modules/ are not declared.
  f.services.repository.inspectWorkspace = async (...args: unknown[]) => {
    reads.push(args);
    return args[1] === true && (args[2] as string[] | undefined)?.length === 0 ? rejected('Workspace has ignored files not allowed by the execution profile')
      : confirmed({ branch: f.a.binding.outputRef, head, clean: true, uncommitted: [], untracked: [] });
  };
  await runChecks(f.db, { attemptId: f.a.id, commit: head, dryRun: true }, person, 'plan-integrity-read', f.services);
  await planCandidateAcceptance(f.db, f.accept, f.services);
  assert.ok(reads.length > 0);
});

async function rebaseFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t, true);
  let state = { branch: f.a.binding.outputRef as string | null, head, clean: true, uncommitted: [] as string[], untracked: [] as string[] };
  let merge = false, conflict = false, abortUnknown = false;
  const target = 'c'.repeat(40), rebased = 'd'.repeat(40), second = 'e'.repeat(40);
  f.refs.set('refs/heads/main', target);
  const repository = f.services.repository;
  repository.inspectWorkspace = async () => confirmed(state);
  repository.compare = async (ancestor, descendant) => confirmed(ancestor === descendant || ancestor === start || (ancestor === target && descendant === rebased));
  repository.command = async args => {
    if (args[0] === 'switch') { f.calls.push('attach'); state.branch = f.a.binding.outputRef; }
    return { complete: true, code: 0, stdout: args[0] === 'merge-base' ? start + '\n' : args[0] === 'rev-list' && merge ? head + '\n' : '', stderr: '' };
  };
  repository.createPinnedRef = async (ref, commit) => { f.calls.push('pin'); if (f.refs.has(ref)) return rejected('Exists'); f.refs.set(ref, commit); return confirmed({ ref, commit }); };
  repository.prepareRebase = async (_workspace, original, upstream, onto) => {
    f.calls.push('rebase'); assert.equal(upstream, original === head ? start : target); assert.equal(onto, f.refs.get('refs/heads/main'));
    if (abortUnknown) return uncertain('Abort unknown');
    if (conflict) return rejected('rebase_conflict');
    state = { ...state, branch: null, head: original === head ? rebased : second };
    return confirmed({ commit: state.head });
  };
  repository.conditionalMoveRef = async (ref, expected, commit) => {
    f.calls.push('move'); assert.equal(state.branch, null);
    if (f.refs.get(ref) !== expected) return rejected('Moved');
    f.refs.set(ref, commit); return confirmed({ ref, commit });
  };
  repository.verifyRetention = async request => {
    for (const reference of request.references) {
      const retained = f.refs.get(reference.ref);
      if (!retained || !knownState(await repository.compare(reference.commit, retained))) return rejected('Output is not retained');
    }
    return confirmed({ retained: true });
  };
  return { ...f, target, rebased, second, input: { requestKey: 'rebase', attemptId: f.a.id, caller: person },
    changeState: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; },
    merges: () => { merge = true; }, conflict: () => { conflict = true; }, abortUnknown: () => { abortUnknown = true; } };
}

test('A25/R14/R09/R30: rebase retains original, records new candidate, replays once and accepts with fresh checks', async t => {
  const f = await rebaseFixture(t);
  await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), (e: any) => e.code === 'not_fast_forward');
  const before = [f.db.events(), f.db.requests(), f.db.claims()];
  const plan = await planAttemptRebase(f.db, f.input, f.services);
  assert.deepEqual(plan.steps.map(s => s.operation), ['rebase.pin', 'rebase.rebase', 'rebase.move', 'rebase.attach', 'candidate.record']);
  assert.deepEqual([f.db.events(), f.db.requests(), f.db.claims()], before);
  await rebaseAttempt(f.db, f.input, f.services);
  const candidate = f.db.attempt(f.a.id).candidate!;
  assert.notEqual(candidate.id, f.accept.candidateId); assert.equal(candidate.commit, f.rebased);
  assert.deepEqual(f.calls, ['pin', 'rebase', 'move', 'attach']);
  await rebaseAttempt(f.db, f.input, f.services);
  assert.deepEqual((await planAttemptRebase(f.db, f.input, f.services)).steps, []);
  assert.deepEqual(f.calls, ['pin', 'rebase', 'move', 'attach']);
  const event = f.db.events().find(e => e.kind === 'output.rebased')!;
  assert.deepEqual([event.payload.original, event.payload.upstream, event.payload.target, event.payload.rebased], [head, start, f.target, f.rebased]);
  assert.equal(f.refs.get(originalCandidateRef(f.db.attempt(f.a.id).specification)), head);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /candidate/);
  await acceptCandidate(f.db, { ...f.accept, candidateId: String(candidate.id), commit: String(candidate.commit) }, f.services);
  assert.ok(f.calls.includes('fast') && f.calls.includes('full'));
  await returnAttempt(f.db, f.returns, f.services);
  assert.equal(f.refs.has(originalCandidateRef(f.db.attempt(f.a.id).specification)), false);
  assert.equal(f.refs.has(f.a.binding.outputRef), false);
});

test('A25: dirty, moved, merge and accepted candidates refuse before any rebase effect', async t => {
  for (const scenario of ['dirty', 'moved', 'merge', 'accepted']) {
    const f = await rebaseFixture(t);
    if (scenario === 'dirty') f.changeState({ clean: false });
    if (scenario === 'moved') f.refs.set(f.a.binding.outputRef, f.rebased);
    if (scenario === 'merge') f.merges();
    if (scenario === 'accepted') {
      f.refs.set('refs/heads/main', start);
      await acceptCandidate(f.db, { ...f.accept, overrideReason: 'Person checked' }, f.services);
      f.calls.length = 0;
    }
    const refs = [...f.refs];
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services));
    assert.deepEqual(f.calls, []); assert.deepEqual([...f.refs], refs);
  }
});

test('A25/R09: conflict is a stable refusal; an unconfirmed abort stays uncertain and is not repeated', async t => {
  for (const unknown of [false, true]) {
    const f = await rebaseFixture(t);
    if (unknown) f.abortUnknown(); else f.conflict();
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services), unknown ? /did not succeed/ : (e: any) => e.code === 'rebase_conflict');
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services));
    assert.equal(f.calls.filter(c => c === 'rebase').length, 1);
    assert.equal(f.refs.get(f.a.binding.outputRef), head);
    const state = knownState(await f.services.repository.inspectWorkspace(f.a.allocation.path));
    assert.equal(state.branch, f.a.binding.outputRef); assert.equal(state.head, head);
    assert.equal(f.db.requests().find(r => r.operation === 'completion.rebase')!.state, unknown ? 'uncertain' : 'rejected');
  }
});
function knownState<T>(result: import('../../src/adapters/command.ts').Result<T>): T {
  assert.equal(result.status, 'confirmed'); return (result as { value: T }).value;
}

test('R14/R11: target moving again permits another rebase; discard keeps a moved pin and reports it', async t => {
  const f = await rebaseFixture(t);
  await rebaseAttempt(f.db, f.input, f.services);
  const first = f.db.attempt(f.a.id).candidate!;
  f.refs.set('refs/heads/main', 'f'.repeat(40));
  await assert.rejects(planCandidateAcceptance(f.db, { ...f.accept, candidateId: String(first.id), commit: String(first.commit) }, f.services), (e: any) => e.code === 'not_fast_forward');
  const compareBefore = f.services.repository.compare, commandBefore = f.services.repository.command;
  const comparisons: string[][] = [], ranges: string[] = [];
  f.services.repository.compare = async (ancestor, descendant) => {
    comparisons.push([ancestor, descendant]);
    return compareBefore(ancestor, descendant);
  };
  f.services.repository.command = async (args, cwd) => {
    if (args[0] === 'rev-list') ranges.push(args[2]!);
    return commandBefore(args, cwd);
  };
  const secondInput = { ...f.input, requestKey: 'second' };
  const events = f.db.events(), requests = f.db.requests(), refs = [...f.refs];
  const plan = await planAttemptRebase(f.db, secondInput, f.services);
  assert.deepEqual(f.db.events(), events);
  assert.deepEqual(f.db.requests(), requests);
  assert.deepEqual([...f.refs], refs);
  assert.ok(comparisons.some(([ancestor, descendant]) => ancestor === f.target && descendant === f.rebased));
  assert.deepEqual(ranges, [`${f.target}..${f.rebased}`]);
  ranges.length = 0;
  const secondPlan = await planAttemptRebase(f.db, secondInput, f.services);
  assert.deepEqual(secondPlan.steps, plan.steps);
  await rebaseAttempt(f.db, secondInput, f.services);
  assert.ok(ranges.length > 0 && ranges.every(range => range === `${f.target}..${f.rebased}`));
  assert.equal(f.db.attempt(f.a.id).candidate!.commit, f.second);
  const event = f.db.events().findLast(e => e.kind === 'output.rebased')!;
  assert.deepEqual([event.payload.original, event.payload.upstream, event.payload.target, event.payload.rebased],
    [f.rebased, f.target, 'f'.repeat(40), f.second]);
  const pin = originalCandidateRef(f.db.attempt(f.a.id).specification);
  f.refs.set(pin, f.target);
  // A moved pin may still retain the original as an ancestor, but cleanup must not delete it.
  const compare = f.services.repository.compare;
  f.services.repository.compare = async (ancestor, descendant) => ancestor === head && descendant === f.target
    ? confirmed(true) : compare(ancestor, descendant);
  await returnAttempt(f.db, { ...f.returns, discard: { leaseId: f.a.allocation.leaseId, confirmed: true, reason: 'Discard rebased work' } }, f.services);
  assert.equal(f.refs.get(pin), f.target);
  assert.equal(f.db.requests().find(r => r.operation === 'completion.cleanup-pin')!.state, 'rejected');
});

test('R09: interrupted rebase resumes durable steps and never replays a successful detached rebase', async t => {
  for (const stage of ['pin', 'rebase', 'move', 'attach']) {
    const f = await rebaseFixture(t);
    const original = f.db.recordEffectOutcome.bind(f.db);
    let interrupted = false;
    f.db.recordEffectOutcome = async (...args) => {
      const request = await original(...args);
      if (!interrupted && request.operation === `completion.${stage}`) { interrupted = true; throw new Error('Lost durable response'); }
      return request;
    };
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services), /Lost durable response/);
    const reopened = await Database.open(f.path, f.options); defer(t, () => reopened.close());
    await planAttemptRebase(reopened, f.input, f.services);
    await rebaseAttempt(reopened, f.input, f.services);
    assert.equal(reopened.attempt(f.a.id).candidate!.commit, f.rebased);
    assert.equal(f.calls.filter(call => call === 'rebase').length, 1);
  }
});

test('R09: lost conditional move response reconciles from the output owner, without repeating rebase or move', async t => {
  const f = await rebaseFixture(t), move = f.services.repository.conditionalMoveRef;
  f.services.repository.conditionalMoveRef = async (...args) => { await move(...args); throw new Error('Lost move response'); };
  await assert.rejects(rebaseAttempt(f.db, f.input, f.services), /did not succeed/);
  await planAttemptRebase(f.db, f.input, f.services);
  await rebaseAttempt(f.db, f.input, f.services);
  assert.equal(f.db.attempt(f.a.id).candidate!.commit, f.rebased);
  assert.equal(f.calls.filter(call => call === 'rebase').length, 1);
  assert.equal(f.calls.filter(call => call === 'move').length, 1);
});

test('R11/R14: discarding a rebased candidate deletes the exact original pin after return', async t => {
  const f = await rebaseFixture(t);
  await rebaseAttempt(f.db, f.input, f.services);
  await returnAttempt(f.db, { ...f.returns, discard: { leaseId: f.a.allocation.leaseId, confirmed: true, reason: 'No longer needed' } }, f.services);
  assert.equal(f.refs.has(originalCandidateRef(f.db.attempt(f.a.id).specification)), false);
  assert.equal(f.calls.indexOf('return') < f.calls.indexOf('cleanup'), true);
});

for (const verdict of ['missing', 'failed', 'passed'] as const) test(`R13/R18/A36: supervisor acceptance requires an exact ${verdict} review; person acceptance does not`, async t => {
  const f = await fixture(t);
  const supervisor: TaskActor = { kind: 'supervisor', id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
  await f.db.addObjective({ id: 'goal', request: 'Build', criteria: ['Works'], scope: '', constraints: '', permissions: null, budget: null, deadline: null }, person);
  await f.db.moveTask('task', f.db.task('task').definitionRevision, 'goal', person);
  if (verdict !== 'missing') await f.db.appendEvents([{ sourceKey: `review:${verdict}`, kind: 'review.recorded', payloadVersion: 1,
    correlationId: 'review', actor: host, occurredAt: new Date().toISOString(), payload: { sourceAttemptId: f.a.id,
      candidateId: f.accept.candidateId, commit: head, criteria: f.db.task('task').criteria, verdict } }]);
  const input = { ...f.accept, caller: supervisor };
  if (verdict === 'passed') {
    await planCandidateAcceptance(f.db, input, f.services);
    await acceptCandidate(f.db, input, f.services);
    assert.ok(f.db.acceptance(f.a.id, f.accept.candidateId));
  } else {
    const code = verdict === 'missing' ? 'review_missing' : 'review_failed';
    await assert.rejects(planCandidateAcceptance(f.db, input, f.services), { code });
    await assert.rejects(acceptCandidate(f.db, input, f.services), { code });
    assert.deepEqual(f.calls, []);
    await acceptCandidate(f.db, f.accept, f.services);
  }
  await assert.rejects(acceptCandidate(f.db, { ...input, overrideReason: 'Approved in task text' }, f.services), { code: 'person_required' });
  await assert.rejects(planAttemptReturn(f.db, { ...f.returns, caller: supervisor }, f.services), { code: 'person_required' });
});

test('R18/A39: permission revocation before integration prevents the external call and retains the candidate', async t => {
  const f = await fixture(t, true);
  const supervisor: TaskActor = { kind: 'supervisor', id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
  const definition = { criteria: ['Works'], scope: '', constraints: '', permissions: permissions({}), budget: unlimitedBudget, deadline: null };
  await f.db.addObjective({ ...definition, id: 'goal', request: 'Build', permissions: null, budget: null }, person);
  await f.db.moveTask('task', f.db.task('task').definitionRevision, 'goal', person);
  await f.db.appendEvents([{ sourceKey: 'review:pass', kind: 'review.recorded', payloadVersion: 1,
    correlationId: 'review', actor: host, occurredAt: new Date().toISOString(), payload: { sourceAttemptId: f.a.id,
      candidateId: f.accept.candidateId, commit: head, criteria: f.db.task('task').criteria, verdict: 'passed' } }]);
  const inspect = f.services.repository.inspectRef;
  let revoked = false;
  f.services.repository.inspectRef = async ref => {
    if (!revoked && f.db.acceptance(f.a.id, f.accept.candidateId)) {
      revoked = true;
      await f.db.updateObjective('goal', f.db.objective('goal', person).revision,
        { ...definition, permissions: permissions({ integrate: false }) }, person);
    }
    return inspect(ref);
  };
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, caller: supervisor }, f.services));
  assert.equal(revoked, true);
  assert.equal(f.calls.includes('integrate'), false);
  assert.equal(f.db.attempt(f.a.id).candidate!.commit, head);
});
