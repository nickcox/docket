import type { JsonObject } from './database.ts';
import type { TaskActor } from './tasks.ts';
import type { TrustedChecks } from './reservations.ts';
import type { ExecutionProfile } from '../check-policy.ts';
import type { StoredRequest } from './requests.ts';
import type { Claim, ClaimIdentity } from './claims.ts';
import { CommandFailure } from '../response.ts';
import { nextAction } from '../next-action.ts';

/** A missing or unfinished run is not evidence that checks failed. */
export function acceptanceCheckFailure(attemptId: string, commit: string, request: StoredRequest | null,
  claims: Claim[], requests: StoredRequest[]): CommandFailure {
  const data = { attemptId, checkRequest: request ? { id: request.id, requestId: request.requestKey,
    state: request.state, status: request.result?.status ?? null, evidenceKey: request.input.evidenceKey } : null };
  const slotHolders = claims.filter(claim => claim.role === 'check_executor' && !claim.releasedAt).map(claim => {
    const holder = requests.find(item => item.claimId === claim.id);
    return { claimId: claim.id, attemptId: claim.attemptId, ownerRef: claim.ownerRef,
      checkRequestId: holder?.id ?? null, requestId: holder?.requestKey ?? null, state: holder?.state ?? null };
  });
  if (request && ['claimed', 'uncertain'].includes(request.state)) return new CommandFailure(
    request.state === 'claimed' ? 'checks_waiting' : 'effect_uncertain', { ...data, slotHolders },
    nextAction('checks.resolve', { checkRequestId: request.id, confirmStopped: false,
      evidence: 'Inspect the stopped check owner.', dryRun: true },
    'If this run was interrupted, a person must confirm its owner has stopped and resolve this exact request.'));
  if (request && request.state === 'pending') {
    return new CommandFailure('checks_waiting', { ...data, slotHolders }, nextAction('attempt.accept',
      { attemptId, candidateCommit: commit, overrideReason: null, dryRun: false },
      'Retry acceptance after the current check run releases its slot.'));
  }
  const code = request?.result?.status === 'failed' ? 'check_failed'
    : request?.state !== 'withdrawn' && (request?.state === 'uncertain' || request?.result?.status === 'uncertain') ? 'effect_uncertain' : 'check_missing';
  if (code === 'check_failed' || code === 'check_missing') return new CommandFailure(code, data, nextAction('checks.run', { attemptId, commit, dryRun: false },
    'Run checks with a new request key, then retry acceptance if they pass.'));
  return new CommandFailure(code, data, request ? nextAction('request.show', { requestId: request.requestKey },
    'Inspect the check request before deciding how to proceed.') : null);
}

export interface CheckRunInput {
  attemptId: string;
  commit: string;
  checks: TrustedChecks;
  profile: ExecutionProfile;
  caller: TaskActor;
  requestKey?: string;
  expectedConfigRevision?: number;
  expectedConfigDigest?: string;
}
export interface CheckAdmission {
  request: StoredRequest;
  execute: boolean;
  executor: ClaimIdentity | null;
}
export interface CheckRunResult extends JsonObject {
  status: 'passed' | 'failed' | 'uncertain';
  evidenceKey: string;
  commands: JsonObject[];
}
