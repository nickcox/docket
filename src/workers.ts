import type { Launcher, WorkerBinding } from './adapters/launcher.ts';
import type { Result } from './adapters/command.ts';
import { Database, StorageError } from './storage/database.ts';
import type { JsonObject } from './storage/database.ts';
import type { WorkerHost, WorkerReference } from './storage/launch.ts';
import type { StoredRequest } from './storage/requests.ts';
import type { WorkerObservation } from './storage/results.ts';
import type { Attempt } from './storage/reservations.ts';
import type { GitRepository } from './adapters/repository.ts';
import { runCandidateChecks } from './checks.ts';
import type { CheckServices } from './checks.ts';
import type { TaskActor } from './storage/tasks.ts';
import { canonicalJson } from './configuration.ts';
import { consumeQuestionFiles } from './questions.ts';
import { CommandFailure } from './response.ts';

/** Observations are retained before result processing, so a refusal cannot lose a terminal fact. */
export async function observeWorker(db: Database, observation: WorkerObservation, host: WorkerHost,
  repository?: Pick<GitRepository, 'compare' | 'verifyRetention'>,
  checks?: { caller: TaskActor; services: CheckServices }): Promise<Attempt> {
  await db.recordWorkerObservation(observation, host);
  await consumeQuestionFiles(db, observation.attemptId);
  if (observation.kind === 'result_available') await db.validateWorkerResult(observation.attemptId, host, repository);
  // Turn-end and idle are not completion evidence. They may reconcile facts already recorded.
  if (db.validatedWorkerResult(observation.attemptId) || observation.kind === 'terminal'
    && db.events().some(event => event.attemptId === observation.attemptId && event.kind === 'worker.observed' && event.payload.kind === 'result_available')) {
    const attempt = await db.completeWorker(observation.attemptId, host, repository);
    if (attempt.candidate && checks) {
      await runCandidateChecks(db, attempt.id, checks.caller, checks.services);
      return db.attempt(attempt.id);
    }
    return attempt;
  }
  return db.attempt(observation.attemptId);
}

function evidence(result: Result<unknown>): JsonObject {
  // Adapter diagnostics may contain Error objects or undefined fields. Retain a JSON value.
  return JSON.parse(JSON.stringify(result)) as JsonObject;
}

/** Only the bound owner consumes recorded control commands. Claimed effects are never retried. */
export async function controlWorker(db: Database, attemptId: string, reference: WorkerReference,
  host: WorkerHost, launcher: Launcher): Promise<void> {
  const owner = db.claims().find(c => c.attemptId === attemptId && c.role === 'worker_owner' && !c.releasedAt);
  if (!owner || canonicalJson(owner.ownerRef) !== canonicalJson(host)) throw new CommandFailure('owner_unresolved');
  const executor = { claimId: owner.id, generation: host.generation };
  for (const command of db.requests().filter(r => r.category === 'command' && r.attemptId === attemptId
    && ['attempt.stop', 'attempt.steer'].includes(r.operation))) {
    const stop = command.operation === 'attempt.stop';
    const operation = stop ? 'worker.stop' : 'worker.deliver';
    const existing = db.requests().find(r => r.parentId === command.id && r.operation === operation);
    if (existing) {
      if (existing.state === 'succeeded' || existing.state === 'rejected') continue;
      throw new CommandFailure('effect_uncertain', { effectId: existing.id });
    }
    const capabilities = launcher.capabilities(db.attempt(attemptId).specification.profile as JsonObject);
    if (!(stop ? capabilities.terminalFence : command.input.mode === 'active' ? capabilities.activeSteering : capabilities.afterTurnMessage)) {
      throw new CommandFailure('capability_missing');
    }
    if (!stop && db.workerStopRequested(attemptId)) continue;
    const effect = await db.recordEffect({ requestKey: `control:${command.id}`, operation, caller: command.caller,
      input: { reference, ...command.input }, fingerprint: command.fingerprint, parentId: command.id,
      executor, attemptId, target: { kind: 'worker', reference } });
    await db.claimEffect(effect.id, executor);
    try {
      // Fresh ownership and worker evidence immediately precede each external effect.
      const observed = await launcher.inspect(reference);
      if (observed.status !== 'known') throw new CommandFailure('owner_unknown');
      db.checkWorkerControlEffect(effect.id, host, reference);
      const result = observed.terminal ? { status: 'confirmed' as const, value: { alreadyTerminal: true } }
        : stop ? await launcher.fence(reference, effect.id)
        : await launcher.deliver(reference, String(command.input.message), command.input.mode === 'active' ? 'active_steering' : 'after_turn', effect.id);
      await db.recordEffectOutcome(effect.id, executor, result.status === 'confirmed' ? 'succeeded'
        : result.status === 'rejected' ? 'rejected' : 'uncertain', evidence(result));
      if (result.status !== 'confirmed') throw new CommandFailure(result.status === 'uncertain' ? 'effect_uncertain' : 'policy_refused');
    } catch (error) {
      if (db.request(effect.id).state === 'claimed') await db.recordEffectOutcome(effect.id, executor, 'uncertain', { reason: String(error) });
      throw error;
    }
  }
}

/** A repeated call returns durable progress, never another prepare call. */
export async function prepareWorker(db: Database, attemptId: string, host: WorkerHost, launcher: Launcher): Promise<StoredRequest> {
  host = { ...host };
  const capabilities = launcher.capabilities(db.attempt(attemptId).specification.profile as JsonObject);
  if (capabilities.preparation === 'unsupported' || !capabilities.admission) {
    throw new StorageError('conflict', 'Launcher does not support protected preparation and admission');
  }
  const claimId = await db.registerWorkerOwner(attemptId, host);
  const intent = await db.beginWorkerPreparation(attemptId, claimId, host, capabilities.usageMetrics);
  if (!intent.claimed) return intent.effect;
  const executor = { claimId, generation: host.generation };
  let prepared: Result<WorkerReference> | undefined;
  try {
    const effect = db.checkWorkerEffect(intent.effect.id, executor);
    const result = await launcher.prepare(effect.input as WorkerBinding, effect.id);
    prepared = result;
    if (result.status === 'confirmed') {
      await db.bindWorkerReference(attemptId, claimId, result.value, host);
      return db.request(effect.id);
    }
    const recorded = await db.recordEffectOutcome(effect.id, executor, result.status === 'rejected' ? 'rejected' : 'uncertain', evidence(result));
    if (result.status === 'rejected' && result.evidence !== null && typeof result.evidence === 'object'
      && (result.evidence as JsonObject).neverStarted === true) await db.recordUnstartedSession(attemptId, host);
    return recorded;
  } catch (error) {
    // Even a failure before the call is conservatively uncertain once intent was committed.
    if (db.request(intent.effect.id).state === 'claimed') {
      await db.recordEffectOutcome(intent.effect.id, executor, 'uncertain', {
        reason: String(error), ...(prepared ? { result: evidence(prepared) } : {}),
      });
    }
    throw error;
  }
}

/** The caller must have committed permission. Claim, recheck, then make exactly one call. */
export async function activateWorker(db: Database, attemptId: string, reference: WorkerReference,
  host: WorkerHost, launcher: Launcher): Promise<StoredRequest | null> {
  host = { ...host };
  reference = JSON.parse(JSON.stringify(reference)) as WorkerReference;
  if (!launcher.capabilities(db.attempt(attemptId).specification.profile as JsonObject).admission) {
    throw new StorageError('conflict', 'Launcher does not support activation admission');
  }
  const admission = await db.claimWorkerActivation(attemptId, reference, host);
  if (admission.kind !== 'admitted') return null;
  const effect = db.request(admission.effectId);
  const executor = { claimId: effect.claimId!, generation: host.generation };
  try {
    const checked = db.checkWorkerEffect(effect.id, executor);
    const result = await launcher.activate(reference, checked.input.specification as JsonObject, effect.id, host.generation);
    return await db.recordEffectOutcome(effect.id, executor,
      result.status === 'confirmed' ? 'succeeded' : result.status === 'rejected' ? 'rejected' : 'uncertain', evidence(result));
  } catch (error) {
    if (db.request(effect.id).state === 'claimed') {
      await db.recordEffectOutcome(effect.id, executor, 'uncertain', { reason: String(error) });
    }
    throw error;
  }
}
