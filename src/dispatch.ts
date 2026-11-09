import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from './configuration.ts';
import { Database, applicationId, schemaVersion } from './storage/database.ts';
import type { JsonObject } from './storage/database.ts';
import type { ReservationInput, Allocation } from './storage/reservations.ts';
import type { TaskActor } from './storage/tasks.ts';
import type { TurnFailure } from './adapters/launcher.ts';
import type { Runtime } from './runtime.ts';
import { consumeQuestionFiles, deliverAnswers } from './questions.ts';
import { prepareWorker, activateWorker, controlWorker } from './workers.ts';
import type { WorkerHost, WorkerReference } from './storage/launch.ts';
import { runCandidateChecks } from './checks.ts';
import { CommandFailure } from './response.ts';
import { nextAction } from './next-action.ts';
import { step } from './plans.ts';
import { known } from './operation-utils.ts';
import { automaticReturn, leaseReturnReason } from './completion.ts';
import { continuationEvidence, continuationHandover } from './continuation.ts';

export async function dispatch(db: Database, args: { taskId: string | null; profile: string | null; dryRun: boolean; sourceAttemptId?: string; sourceCommit?: string | null; note?: string | null },
  caller: TaskActor, requestKey: string, runtime: Runtime, progress: (message: string) => void) {
  db.checkAuthority(caller, args.sourceAttemptId ? 'attempt.continue' : 'attempt.dispatch', {
    taskId: args.taskId, ...(args.sourceAttemptId ? { sourceAttemptId: args.sourceAttemptId, sourceCommit: args.sourceCommit ?? null } : {}),
  });
  const continuationInput = args.sourceAttemptId ? { sourceAttemptId: args.sourceAttemptId, sourceCommit: args.sourceCommit ?? null,
    ...(args.note == null ? {} : { note: args.note }) } : {};
  const previous = db.requests().find(r => r.requestKey === requestKey);
  // A replay never starts another owner or resumes an interrupted remote call.
  if (previous) {
    const replay = await db.reserveAttempt({ requestKey, caller, ...continuationInput, ...(args.taskId === null ? {} : { taskId: args.taskId }),
      ...(args.profile === null ? {} : { profile: args.profile }), startingCommit: '', checks: {} as ReservationInput['checks'],
      delivery: {} as ReservationInput['delivery'] }, args.dryRun);
    const leaseReturn = replay.attempt.leaseState === 'returned'
      ? { state: 'returned', reason: null }
      : { state: 'kept', reason: await leaseReturnReason(db, replay.attempt.id, caller, runtime.completion) };
    return { attempt: replay.attempt, leaseReturn, replayed: true, skippedTasks: replay.skippedTasks, steps: [] };
  }
  const config = db.checkConfiguration();
  const configured = db.events().findLast(e => e.kind === 'context.configured')!.payload.resolved as JsonObject;
  const inherited = args.sourceAttemptId ? await continuationEvidence(db, args.sourceAttemptId, args.taskId!, runtime, args.sourceCommit ?? null) : null;
  const starting = inherited ? { state: 'present' as const, commit: inherited.startingCommit }
    : known(await runtime.repository.inspectRef(`refs/heads/${String(configured.baseBranch).replace(/^refs\/heads\//u, '')}`));
  if (starting.state !== 'present') throw new CommandFailure('candidate_missing');
  const checks = await runtime.repository.readCheckPolicy(config.targetBranch.startsWith('refs/') ? config.targetBranch : `refs/heads/${config.targetBranch}`, config.checks);
  const input: ReservationInput = { requestKey, caller, ...continuationInput,
    ...(inherited ? { handover: continuationHandover(db, args.sourceAttemptId!, starting.commit, args.sourceCommit != null, args.note ?? null) } : {}),
    startingCommit: starting.commit, checks,
    ...(args.taskId === null ? {} : { taskId: args.taskId }), ...(args.profile === null ? {} : { profile: args.profile }),
    expectedConfigRevision: config.revision, expectedConfigDigest: config.digest,
    delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } };
  const preview = await db.reserveAttempt(input, true);
  const task = db.task(preview.attempt.taskId);
  input.delivery.kind = task.kind === 'report' ? 'report' : 'code';
  const reviewTarget = task.reviewTarget;
  if (reviewTarget) {
    starting.commit = String(reviewTarget.commit);
    input.startingCommit = starting.commit;
    known(await runtime.repository.verifyRetention({ references: [{ ref: String(reviewTarget.outputRef), commit: starting.commit }],
      artefacts: [], recyclableRoots: [] }));
  }
  input.expectedDefinitionRevision = task.definitionRevision;
  input.expectedDecisionRevision = task.decisionRevision;
  const profile = preview.attempt.specification.profile as JsonObject;
  const capabilities = runtime.launcher.capabilities(profile);
  if (capabilities.preparation === 'unsupported' || !capabilities.admission) throw new CommandFailure('policy_refused');
  // Recorded acquisition uncertainty is checked by the same reservation builder.
  // Treehouse status initialises owner metadata on an empty pool, so it is not a
  // read-only prerequisite. Acquisition itself verifies the live pool identity.
  const steps = ['attempt.reserve', ...(inherited || reviewTarget ? ['continuation.pin'] : []), 'workspace.acquire',
    ...(inherited || reviewTarget ? ['continuation.cleanup-pin'] : []), 'attempt.start', 'worker.prepare', 'worker.bind', 'worker.permit',
    'worker.activate', 'worker.wait', 'worker.fence', 'attempt.complete', ...(reviewTarget ? [] : ['checks.run'])].map(operation => step(operation, task.id,
      operation === 'attempt.reserve' ? ['ready', 'capacity', 'resolved_owners'] : ['current_authority'], operation === 'checks.run'));
  if (args.dryRun) return { taskId: task.id, skippedTasks: preview.skippedTasks, steps,
    ...(inherited ? { startingCommit: starting.commit, subject: inherited.subject } : {}) };
  progress('attempt.reserve');
  if (args.sourceAttemptId) {
    const current = await continuationEvidence(db, args.sourceAttemptId, task.id, runtime, args.sourceCommit ?? null);
    starting.commit = current.startingCommit;
    input.startingCommit = current.startingCommit;
    input.handover = continuationHandover(db, args.sourceAttemptId, current.startingCommit, args.sourceCommit != null, args.note ?? null);
  }
  const reservation = await db.reserveAttempt(input);
  if (reservation.replayed) return { attempt: reservation.attempt,
    leaseReturn: reservation.attempt.leaseState === 'returned' ? { state: 'returned', reason: null }
      : { state: 'kept', reason: await leaseReturnReason(db, reservation.attempt.id, caller, runtime.completion) },
    replayed: true, skippedTasks: reservation.skippedTasks, steps: [] };
  const id = reservation.attempt.id;
  const objectiveScope = reservation.attempt.specification.objectiveId === null ? {}
    : { objectiveId: String(reservation.attempt.specification.objectiveId) };
  const generation = randomUUID(), host: WorkerHost = { kind: 'host', id: `cli:${process.pid}:${randomUUID()}`, generation };
  const [claim] = await db.registerClaims([{ resourceKey: `dispatch:${id}`, role: 'maintenance', generation, ownerRef: caller,
    schemaFamily: applicationId, schemaVersion, configRevision: config.revision, heartbeatAt: new Date().toISOString() }], caller);
  const executor = { claimId: claim!.id, generation };
  let reference: WorkerReference | undefined;
  let terminal = false, sequence = 0, stopRequested = false;
  const interrupt = () => { stopRequested = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const refresh = async () => {
    const now = new Date().toISOString();
    await db.refreshClaim(executor, now, caller);
    const owner = db.claims().find(c => c.attemptId === id && c.role === 'worker_owner' && !c.releasedAt);
    if (owner) await db.heartbeatWorkerOwner(id, owner.id, host);
  };
  const withHeartbeat = async <T>(pending: Promise<T>): Promise<T> => {
    while (true) {
      const timer = new AbortController();
      try {
        const result = await Promise.race([pending.then(value => ({ kind: 'result' as const, value })),
          delay(5000, undefined, { signal: timer.signal }).then(() => ({ kind: 'pulse' as const }))]);
        if (result.kind === 'result') return result.value;
        await refresh();
      } finally { timer.abort(); }
    }
  };
  const fence = async () => {
    const owner = db.claims().find(c => c.attemptId === id && c.role === 'worker_owner' && !c.releasedAt)!;
    const identity = { claimId: owner.id, generation };
    const effect = await db.recordEffect({ requestKey: `fence:${id}`, operation: 'worker.fence', caller,
      fingerprint: canonicalJson(reference), input: { reference: reference! }, parentId: reservation.requestId,
      executor: identity, attemptId: id, ...objectiveScope, target: { kind: 'worker', reference: reference! } });
    if (effect.state !== 'pending') throw new CommandFailure('effect_uncertain', { attemptId: id });
    await db.claimEffect(effect.id, identity);
    const result = await runtime.launcher.fence(reference!, effect.id);
    await db.recordEffectOutcome(effect.id, identity, result.status === 'confirmed' ? 'succeeded' : result.status === 'rejected' ? 'rejected' : 'uncertain', JSON.parse(JSON.stringify(result)));
    known(result);
  };
  const recheck = async () => {
    db.checkAuthority(caller, args.sourceAttemptId ? 'attempt.continue' : 'attempt.dispatch', { taskId: task.id, sourceCommit: args.sourceCommit ?? null });
    if (args.sourceAttemptId) await continuationEvidence(db, args.sourceAttemptId, task.id, runtime, args.sourceCommit ?? null, id, starting.commit);
  };
  const pin = `refs/docket/continuations/${id}`;
  const pinEffect = async (cleanup: boolean) => {
    await recheck();
    const operation = cleanup ? 'continuation.cleanup-pin' : 'continuation.pin';
    const effect = await db.recordEffect({ requestKey: `${operation}:${id}`, operation, caller, executor,
      parentId: reservation.requestId, attemptId: id, ...objectiveScope, input: { ref: pin, commit: starting.commit },
      fingerprint: canonicalJson({ ref: pin, commit: starting.commit }), target: { kind: 'repository', reference: { ref: pin } } });
    await db.claimEffect(effect.id, executor);
    const existing = await runtime.repository.inspectRef(pin);
    db.checkRequestAuthority(effect.id);
    const result = existing.status !== 'confirmed' ? existing
      : cleanup ? existing.value.state === 'absent' ? existing : await runtime.repository.conditionalDeleteRef(pin, starting.commit)
      : existing.value.state === 'present' ? existing.value.commit === starting.commit ? existing
        : { status: 'rejected' as const, reason: 'Pin moved; preserved', evidence: null }
        : await runtime.repository.createPinnedRef(pin, starting.commit);
    await db.recordEffectOutcome(effect.id, executor, result.status === 'confirmed' ? 'succeeded' : result.status === 'rejected' ? 'rejected' : 'uncertain', JSON.parse(JSON.stringify(result)));
    if (cleanup && result.status !== 'confirmed') progress(`${operation}: ${result.reason}`);
    if (result.status === 'uncertain') throw new CommandFailure('effect_uncertain', { effectId: effect.id, reason: result.reason });
    if (!cleanup) known<unknown>(result);
  };
  try {
    if (inherited || reviewTarget) await pinEffect(false);
    await recheck();
    progress('workspace.acquire');
    const acquisition = await db.beginWorkspaceAcquisition(id, reservation.requestId, executor, caller);
    try {
      const spec = reservation.attempt.specification;
      db.checkRequestAuthority(acquisition.effect.id);
      const allocation = known(await withHeartbeat(runtime.workspace.acquire({ databaseId: String(spec.databaseId), attemptId: id,
        holder: canonicalJson((spec.workspace as JsonObject).holder), branch: String(spec.outputRef).replace(/^refs\/heads\//u, ''), startingCommit: starting.commit })));
      const stored: Allocation = { leaseId: allocation.leaseId, holder: (spec.workspace as JsonObject).holder as JsonObject,
        path: allocation.path, pool: runtime.workspace.options.poolRoot, repository: spec.repository as JsonObject,
        outputRef: String(spec.outputRef), startingCommit: allocation.startingCommit };
      await db.recordAllocation(id, acquisition.effect.id, executor, stored);
    } catch (error) {
      await db.recordUncertainAcquisition(id, acquisition.effect.id, executor, { reason: 'Workspace acquisition could not be confirmed' });
      throw error;
    }
    if (inherited || reviewTarget) await pinEffect(true);
    await recheck();
    await refresh();
    progress('attempt.start'); await db.startAttempt(id, caller);
    await recheck();
    progress('worker.prepare');
    const prepared = await withHeartbeat(prepareWorker(db, id, host, runtime.launcher));
    if (prepared.state !== 'succeeded') {
      reference = prepared.result?.referenceHints as WorkerReference | undefined;
      throw new CommandFailure('effect_uncertain', { attemptId: id });
    }
    reference = prepared.result!.reference as WorkerReference;
    progress('worker.bind');
    await refresh();
    await recheck();
    progress('worker.permit'); await db.decideWorkerLaunch(id, prepared.claimId!, 'permit', host);
    await controlWorker(db, id, reference, host, runtime.launcher);
    if (stopRequested) throw new CommandFailure('policy_refused', { attemptId: id });
    await recheck();
    progress('worker.activate');
    const activation = await withHeartbeat(activateWorker(db, id, reference, host, runtime.launcher));
    if (activation?.state !== 'succeeded' && !db.workerStopRequested(id)) throw new CommandFailure('effect_uncertain', { attemptId: id });
    progress('worker.wait');
    const deadline = Date.now() + Number(profile.runMs);
    let refreshed = Date.now();
    let turnFailure: TurnFailure | undefined;
    while (true) {
      await consumeQuestionFiles(db, id);
      await deliverAnswers(db, id, reference, host, runtime.launcher);
      await controlWorker(db, id, reference, host, runtime.launcher);
      const observation = await runtime.launcher.inspect(reference);
      if (observation.status !== 'known') throw new CommandFailure('owner_unknown', { attemptId: id });
      turnFailure = observation.turnFailure;
      if (observation.terminal) { terminal = true; break; }
      if (observation.turn === 'ended' || Date.now() >= deadline || stopRequested) break;
      if (Date.now() - refreshed >= 5000) { await refresh(); refreshed = Date.now(); }
      await delay(50);
    }
    progress('worker.fence');
    if (!terminal) { await refresh(); await fence(); }
    const observed = await runtime.launcher.inspect(reference);
    if (observed.status !== 'known' || !observed.terminal) throw new CommandFailure('owner_unknown', { attemptId: id });
    terminal = true;
    await consumeQuestionFiles(db, id);
    await deliverAnswers(db, id, reference, host, runtime.launcher);
    await db.recordWorkerObservation({ sourceId: host.id, sourceSequence: ++sequence, attemptId: id, workerRef: reference,
      observedAt: new Date().toISOString(), kind: 'terminal', payloadVersion: 1,
      payload: reference.launcher === 'pi' ? { directChildExited: true } : { terminal: true, laterTurnsRefused: true } }, host);
    progress('attempt.complete');
    if (turnFailure) {
      await db.failWorkerTurn(id, host, turnFailure);
      const leaseReturn = await automaticReturn(db, id, caller, runtime.completion);
      throw new CommandFailure('worker_failed', { attemptId: id, profile: reservation.attempt.specification.profileName,
        failureKind: turnFailure.kind, message: turnFailure.message, leaseReturn: { state: leaseReturn.state, reason: leaseReturn.reason } },
        nextAction('attempt.show', { attemptId: id }, 'Inspect the failure before retrying; a person must clear a limited profile after its provider limit resets.'));
    }
    if (db.workerStopRequested(id)) {
      const attempt = await db.interruptWorker(id, host);
      const leaseReturn = reviewTarget ? await automaticReturn(db, id, caller, runtime.completion) : null;
      return { attempt: leaseReturn?.attempt ?? attempt,
        leaseReturn: leaseReturn ? { state: leaseReturn.state, reason: leaseReturn.reason }
          : { state: 'kept', reason: 'Stopped work is retained for inspection.' },
        skippedTasks: reservation.skippedTasks, steps };
    }
    await withHeartbeat(db.completeWorker(id, host, runtime.repository));
    if (db.attempt(id).candidate) {
      progress('checks.run');
      let checks = await withHeartbeat(runCandidateChecks(db, id, caller, runtime.completion));
      while (checks.state === 'pending') {
        if (stopRequested) throw new CommandFailure('policy_refused', { attemptId: id, checksRequestId: checks.id });
        await delay(250); await refresh();
        checks = await withHeartbeat(runCandidateChecks(db, id, caller, runtime.completion));
      }
      if (checks.state === 'uncertain' || checks.state === 'claimed') throw new CommandFailure('effect_uncertain', { attemptId: id, checksRequestId: checks.id });
    }
    const attempt = db.attempt(id);
    const leaseReturn = reviewTarget || ['held', 'failed'].includes(attempt.outcome ?? '')
      ? await automaticReturn(db, id, caller, runtime.completion) : null;
    return { attempt: leaseReturn?.attempt ?? attempt,
      leaseReturn: leaseReturn ? { state: leaseReturn.state, reason: leaseReturn.reason }
        : { state: 'kept', reason: 'Candidate is awaiting acceptance.' },
      skippedTasks: reservation.skippedTasks, steps };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    // A failed preparation can still own a non-acting child. Stop it using its
    // exact returned hints, but preserve the uncertain preparation for inspection.
    const preparation = db.requests().find(r => r.attemptId === id && r.operation === 'worker.prepare');
    reference ??= preparation?.result?.referenceHints as WorkerReference | undefined;
    if (reference && !terminal) {
      const owner = db.claims().find(c => c.attemptId === id && c.role === 'worker_owner' && !c.releasedAt);
      if (owner) {
        const identity = { claimId: owner.id, generation };
        const stop = await db.recordEffect({ requestKey: `emergency-stop:${id}`, operation: 'worker.emergency-stop', caller,
          input: { reference }, fingerprint: canonicalJson(reference), parentId: reservation.requestId, executor: identity,
          attemptId: id, ...objectiveScope, target: { kind: 'worker', reference } });
        if (stop.state === 'pending') {
          await db.claimEffect(stop.id, identity);
          const result = await runtime.launcher.fence(reference, stop.id);
          await db.recordEffectOutcome(stop.id, identity, result.status === 'confirmed' ? 'succeeded' : 'uncertain', JSON.parse(JSON.stringify(result)));
          // A confirmed exit of the direct child is terminal evidence (R07); record it so the
          // attempt can be settled or discarded instead of staying open behind a stale claim.
          if (result.status === 'confirmed' && (result.value as JsonObject).terminal === true) {
            try {
              await db.recordWorkerObservation({ sourceId: host.id, sourceSequence: ++sequence, attemptId: id, workerRef: reference,
                observedAt: new Date().toISOString(), kind: 'terminal', payloadVersion: 1,
                payload: reference.launcher === 'pi' ? { directChildExited: true } : { terminal: true, laterTurnsRefused: true } }, host);
              terminal = true;
            } catch { /* Leave the claim unreleased; a person can resolve it from the recorded stop. */ }
          }
        }
      }
    }
    await db.releaseClaim(executor, { stopped: true, attemptId: id }, caller);
    if (terminal) {
      const owner = db.claims().find(c => c.attemptId === id && c.role === 'worker_owner' && !c.releasedAt);
      if (owner) await db.releaseClaim({ claimId: owner.id, generation }, { terminal: true, attemptId: id }, caller);
    }
  }
}
