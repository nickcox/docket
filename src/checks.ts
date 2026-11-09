import { checkEvidenceKey, mandatoryChecks } from './check-policy.ts';
import { canonicalJson } from './configuration.ts';
import { CommandFailure } from './response.ts';
import { step } from './plans.ts';
import { acceptanceCheckFailure } from './storage/checks.ts';
import type { ContextChecks, ExecutionProfile } from './check-policy.ts';
import type { CheckRunner } from './adapters/checks.ts';
import type { GitRepository } from './adapters/repository.ts';
import { Database, StorageError } from './storage/database.ts';
import type { JsonObject } from './storage/database.ts';
import type { TrustedChecks } from './storage/reservations.ts';
import type { TaskActor } from './storage/tasks.ts';
import type { StoredRequest } from './storage/requests.ts';

export type CheckRepository = Pick<GitRepository, 'readCheckPolicy' | 'identity' | 'inspectWorkspace'>;
export interface CheckServices {
  repository: CheckRepository;
  profile: ExecutionProfile;
  run: CheckRunner;
}

/** No filesystem or process work is performed while SQLite holds its write lock. */
export async function runCandidateChecks(db: Database, attemptId: string, caller: TaskActor, services: CheckServices,
  requestKey?: string, expectedCommit?: string): Promise<StoredRequest> {
  caller = structuredClone(caller);
  const { repository, run } = services;
  const profile = structuredClone(services.profile);
  const attempt = db.attempt(attemptId);
  if (!attempt.candidate || !attempt.allocation) throw new StorageError('conflict', 'Checks require a recorded candidate and allocation');
  const commit = String(attempt.candidate.commit), workspace = attempt.allocation.path;
  if (expectedCommit !== undefined && commit !== expectedCommit) throw new CommandFailure('candidate_moved', { attemptId, commit: expectedCommit });
  const config = db.checkConfiguration();
  const target = config.targetBranch.startsWith('refs/') ? config.targetBranch : `refs/heads/${config.targetBranch}`;
  const current = await repository.readCheckPolicy(target, config.checks);
  if (profile.id !== current.executionProfile) throw new StorageError('conflict', 'Check execution profile does not match policy');
  const checks = mandatoryChecks(attempt.specification.checks as TrustedChecks, current);
  const admission = await db.beginChecks({ attemptId, commit, checks, profile, caller,
    expectedConfigRevision: config.revision, expectedConfigDigest: config.digest,
    ...(requestKey === undefined ? {} : { requestKey }) });
  if (!admission.execute) return admission.request;
  const commands: JsonObject[] = [];
  let status: 'passed' | 'failed' | 'uncertain' = 'passed';
  let heartbeat: Promise<void> | undefined, heartbeatFailed = false;
  const timer = setInterval(() => {
    if (heartbeat || heartbeatFailed) return;
    heartbeat = db.refreshClaim(admission.executor!, new Date().toISOString(), caller).then(() => {}, () => {
      heartbeatFailed = true;
      clearInterval(timer);
    }).finally(() => { heartbeat = undefined; });
  }, 5000);
  const clean = async (): Promise<boolean> => {
    if (heartbeatFailed) throw new Error('Check executor heartbeat failed');
    const state = await repository.inspectWorkspace(workspace, true, profile.ignoredGeneratedPaths ?? []);
    return state.status === 'confirmed' && state.value.head === commit && state.value.clean;
  };
  try {
    const identity = await repository.identity(), allocated = await repository.identity(workspace);
    const recordedPath = (attempt.specification.repository as JsonObject).path;
    const recorded = typeof recordedPath === 'string' ? await repository.identity(recordedPath) : identity;
    if (identity.status !== 'confirmed' || allocated.status !== 'confirmed' || recorded.status !== 'confirmed'
      || identity.value !== allocated.value || identity.value !== recorded.value || !await clean()) {
      status = 'failed';
      commands.push({ status: 'not_run', reason: 'Workspace is not clean at the candidate in the expected repository' });
    } else {
      for (const [kind, definitions] of [['fast', checks.fast], ['full', checks.full]] as const) {
        for (const check of definitions) {
          if (status !== 'passed') {
            commands.push({ kind, name: check.name, status: 'not_run', reason: 'An earlier check did not pass' });
            continue;
          }
          if (!await clean()) {
            status = 'failed'; commands.push({ kind, name: check.name, status: 'not_run', reason: 'Workspace changed before command' });
            continue;
          }
          db.checkRequestAuthority(admission.request.id);
          const result = await run(check, workspace);
          if (result.status === 'uncertain') clearInterval(timer);
          const unchanged = await clean();
          const commandStatus = result.status === 'uncertain' ? 'uncertain'
            : !unchanged || result.timedOut || (result.status === 'passed' && result.exitCode !== 0) ? 'failed' : result.status;
          commands.push({ kind, name: check.name, definition: check, ...result, status: commandStatus,
            ...(unchanged ? {} : { reason: 'Command changed the workspace or candidate' }) });
          if (commandStatus !== 'passed') status = commandStatus === 'uncertain' ? 'uncertain' : 'failed';
        }
      }
      if (!await clean() && status !== 'uncertain') status = 'failed';
    }
  } catch {
    // A thrown adapter call cannot establish that a started process is no longer running.
    status = 'uncertain'; commands.push({ status: 'uncertain', reason: 'Check owner or workspace observation interrupted' });
  } finally {
    clearInterval(timer);
    // Drain any write before recording the result, including an uncertain one.
    await heartbeat;
  }
  if (heartbeatFailed) status = 'uncertain';
  return db.finishChecks(admission.request.id, admission.executor!, { status,
    evidenceKey: String(admission.request.input.evidenceKey), commands });
}

export interface RunChecksInput {
  attemptId: string;
  commit: string;
  dryRun: boolean;
}

/** Explicit retries use the public request key; automatic runs keep their evidence-derived key. */
export async function runChecks(db: Database, input: RunChecksInput, caller: TaskActor, requestKey: string,
  services: CheckServices) {
  input = structuredClone(input);
  caller = structuredClone(caller);
  db.checkAuthority(caller, 'checks.run', { attemptId: input.attemptId });
  services = { ...services, profile: structuredClone(services.profile) };
  const previous = db.requests().find(request => request.requestKey === requestKey);
  if (previous) {
    if (previous.operation !== 'checks.run' || previous.input.attemptId !== input.attemptId
      || previous.input.commit !== input.commit || canonicalJson(previous.caller) !== canonicalJson(caller)) {
      throw new CommandFailure('request_input_mismatch', { requestId: requestKey });
    }
    // Replay a finished decision before reading mutable policy or candidate state.
    if (previous.state !== 'pending') {
      const response = checkResponse(db, input, previous, []);
      return input.dryRun ? { steps: [] } : response;
    }
  }
  const plan = await planChecks(db, input, services);
  if (input.dryRun) return plan;
  const request = await runCandidateChecks(db, input.attemptId, caller, services, requestKey, input.commit);
  return checkResponse(db, input, request, plan.steps);
}

function checkResponse(db: Database, input: RunChecksInput, request: StoredRequest,
  steps: ReturnType<typeof step>[]) {
  if (request.state !== 'succeeded' || request.result?.status !== 'passed') {
    const failure = acceptanceCheckFailure(input.attemptId, input.commit, request, db.claims(), db.requests());
    if (failure.code === 'checks_waiting') {
      throw new CommandFailure(failure.code, failure.data, { operation: 'checks.run', args: { ...input, dryRun: false },
        description: 'Retry this check request after the current run releases its slot.' });
    }
    throw failure;
  }
  return { request, steps };
}

async function planChecks(db: Database, input: RunChecksInput, services: CheckServices) {
  const attempt = db.attempt(input.attemptId);
  if (!attempt.candidate || attempt.candidate.commit !== input.commit) {
    throw new CommandFailure('candidate_missing', { attemptId: input.attemptId, commit: input.commit });
  }
  if (attempt.executionOpen || !attempt.allocation || !db.validatedWorkerResult(attempt.id)
    || !db.events().some(event => event.attemptId === attempt.id && event.kind === 'worker.observed' && event.payload.kind === 'terminal')) {
    throw new CommandFailure('not_ready', { attemptId: attempt.id });
  }
  const config = db.checkConfiguration();
  const target = config.targetBranch.startsWith('refs/') ? config.targetBranch : `refs/heads/${config.targetBranch}`;
  const current = await services.repository.readCheckPolicy(target, config.checks);
  if (services.profile.id !== current.executionProfile) throw new StorageError('conflict', 'Check execution profile does not match policy');
  const checks = mandatoryChecks(attempt.specification.checks as TrustedChecks, current);
  const key = checkEvidenceKey(attempt.specification.repository as JsonObject, input.commit,
    attempt.specification.criteria as string[], checks, services.profile);
  if (db.requests().some(request => request.operation === 'checks.run' && request.input.evidenceKey === key
    && request.state === 'succeeded' && request.result?.status === 'passed')) return { steps: [] };
  const state = await services.repository.inspectWorkspace(attempt.allocation.path, true, services.profile.ignoredGeneratedPaths ?? []);
  if (state.status !== 'confirmed') throw new CommandFailure('owner_unknown', { attemptId: attempt.id });
  if (state.value.head !== input.commit) throw new CommandFailure('candidate_moved', { attemptId: attempt.id, commit: input.commit });
  if (!state.value.clean) throw new CommandFailure('workspace_dirty', { attemptId: attempt.id });
  return { steps: [step('checks.run', attempt.id, ['terminal', 'exact_candidate', 'clean_workspace', 'check_slot'])] };
}

export type CheckConfiguration = { targetBranch: string; checks: ContextChecks };
