import assert from 'node:assert/strict';
import test from 'node:test';
import { openContext } from '../../src/context.ts';
import type { ExecutionProfile } from '../../src/check-policy.ts';
import type { TrustedChecks } from '../../src/storage/reservations.ts';
import { defer } from '../helpers/cleanup.ts';
import { definition, fixture, snapshot } from '../helpers/cli-operations.ts';

test('R08/R09/R16/R27/R30: CLI recovers an exact abandoned check and removes its unresolved-effect barriers without accepting it', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }).status, 0);
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
  const attemptId = dispatched.data.attempt.id;
  const context = await openContext({ config: f.file }, { home: f.home, readOnly: false });
  const db = context.database;
  defer(t, () => db.close());
  const existing = db.requests().find(r => r.operation === 'checks.run')!;
  // A distinct profile identity gives this explicitly authorised run fresh evidence.
  const profile = structuredClone(existing.input.profile) as unknown as ExecutionProfile;
  profile.dependencies.recoveryTest = 'fresh';
  const admission = await db.beginChecks({ attemptId, commit: String(existing.input.commit),
    checks: existing.input.checks as unknown as TrustedChecks, profile,
    caller: existing.caller as { kind: 'person'; id: string }, requestKey: 'abandoned-check' });
  assert.equal(admission.execute, true);
  const args = { checkRequestId: admission.request.id, confirmStopped: true,
    evidence: 'This fixture executor stopped before invoking any command.', dryRun: true };
  const before = await snapshot(f.home);
  const plan = f.invoke('checks.resolve', args, 'recovery-plan');
  assert.equal(plan.status, 0, JSON.stringify(plan.envelope));
  assert.deepEqual(await snapshot(f.home), before);
  assert.equal(f.invoke('checks.resolve', { ...args, confirmStopped: false }).envelope.code, 'process_confirmation_required');
  const blocked = f.invoke('attempt.rebase', { attemptId, dryRun: true });
  assert.notEqual(blocked.status, 0);
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  assert.equal(status.data.attempts.items[0].nextAction.operation, 'checks.resolve');
  const resolved = f.invoke('checks.resolve', { ...args, dryRun: false }, 'recovery');
  assert.equal(resolved.status, 0, JSON.stringify(resolved.envelope));
  assert.deepEqual(resolved.data.steps, plan.data.steps);
  assert.equal(resolved.data.request.state, 'withdrawn');
  assert.equal(resolved.data.request.result.status, 'uncertain');
  assert.deepEqual(f.invoke('checks.resolve', { ...args, dryRun: false }, 'recovery').data, resolved.data);
  assert.equal(f.invoke('checks.resolve', { ...args, dryRun: false, evidence: 'Changed' }, 'recovery').envelope.code, 'request_input_mismatch');
  const read = f.invoke('request.show', { requestId: 'abandoned-check' });
  assert.equal(read.data.resolution.evidence, args.evidence);
  assert.equal(read.data.resolution.previousState, 'claimed');
  assert.equal(f.invoke('checks.run', { attemptId, commit: existing.input.commit, dryRun: false }, 'abandoned-check').envelope.code, 'check_missing');
  const rebase = f.invoke('attempt.rebase', { attemptId, dryRun: true });
  assert.equal(rebase.status, 0, JSON.stringify(rebase.envelope));
  assert.equal(f.invoke('task.release', { taskId: 'feature' }).status, 0);
  const continuation = f.invoke('attempt.continue', { sourceAttemptId: attemptId, sourceCommit: null,
    profile: null, note: null, dryRun: true });
  assert.equal(continuation.status, 0, JSON.stringify(continuation.envelope));
  const returned = f.invoke('attempt.return', { attemptId, dryRun: true });
  assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
  assert.equal(db.acceptance(attemptId, String(db.attempt(attemptId).candidate!.id)), null);
});
