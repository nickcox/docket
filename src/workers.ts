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

/** Observations are retained before result processing, so a refusal cannot lose a terminal fact. */
export async function observeWorker(db: Database, observation: WorkerObservation, host: WorkerHost,
  repository?: Pick<GitRepository, 'compare' | 'verifyRetention'>,
  checks?: { caller: TaskActor; services: CheckServices }): Promise<Attempt> {
  await db.recordWorkerObservation(observation, host);
  if (observation.kind === 'result_available') await db.validateWorkerResult(observation.attemptId, host, repository);
  // Turn-end and idle are not completion evidence. They may reconcile facts already recorded.
  if (db.validatedWorkerResult(observation.attemptId)) {
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

/** A repeated call returns durable progress, never another prepare call. */
export async function prepareWorker(db: Database, attemptId: string, host: WorkerHost, launcher: Launcher): Promise<StoredRequest> {
  host = { ...host };
  const capabilities = launcher.capabilities(db.attempt(attemptId).specification.profile as JsonObject);
  if (capabilities.preparation === 'unsupported' || !capabilities.admission) {
    throw new StorageError('conflict', 'Launcher does not support protected preparation and admission');
  }
  const claimId = await db.registerWorkerOwner(attemptId, host);
  const intent = await db.beginWorkerPreparation(attemptId, claimId, host);
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
    return await db.recordEffectOutcome(effect.id, executor, result.status === 'rejected' ? 'rejected' : 'uncertain', evidence(result));
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
