import { mandatoryChecks } from './check-policy.ts';
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
  requestKey?: string): Promise<StoredRequest> {
  const attempt = db.attempt(attemptId);
  if (!attempt.candidate || !attempt.allocation) throw new StorageError('conflict', 'Checks require a recorded candidate and allocation');
  const commit = String(attempt.candidate.commit), workspace = attempt.allocation.path;
  const config = db.checkConfiguration();
  const target = config.targetBranch.startsWith('refs/') ? config.targetBranch : `refs/heads/${config.targetBranch}`;
  const current = await services.repository.readCheckPolicy(target, config.checks);
  if (services.profile.id !== current.executionProfile) throw new StorageError('conflict', 'Check execution profile does not match policy');
  const checks = mandatoryChecks(attempt.specification.checks as TrustedChecks, current);
  const admission = await db.beginChecks({ attemptId, commit, checks, profile: services.profile, caller,
    ...(requestKey === undefined ? {} : { requestKey }) });
  if (!admission.execute) return admission.request;
  const commands: JsonObject[] = [];
  let status: 'passed' | 'failed' | 'uncertain' = 'passed';
  const clean = async (): Promise<boolean> => {
    const state = await services.repository.inspectWorkspace(workspace);
    return state.status === 'confirmed' && state.value.head === commit && state.value.clean;
  };
  try {
    const repository = await services.repository.identity(), allocated = await services.repository.identity(workspace);
    if (repository.status !== 'confirmed' || allocated.status !== 'confirmed' || repository.value !== allocated.value || !await clean()) {
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
          const result = await services.run(check, workspace);
          const unchanged = await clean();
          const commandStatus = result.status === 'uncertain' ? 'uncertain' : !unchanged ? 'failed' : result.status;
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
  }
  return db.finishChecks(admission.request.id, admission.executor!, { status,
    evidenceKey: String(admission.request.input.evidenceKey), commands });
}

export type CheckConfiguration = { targetBranch: string; checks: ContextChecks };
