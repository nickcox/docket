import type { Database, JsonObject } from './storage/database.ts';
import type { Runtime } from './runtime.ts';
import { CommandFailure } from './response.ts';
import { known } from './operation-utils.ts';

/** R12 does not require or select a candidate. Retention is of the output ref. */
export async function continuationEvidence(db: Database, sourceId: string, taskId: string, runtime: Runtime,
  sourceCommit: string | null, newAttemptId?: string, recordedCommit?: string) {
  const source = db.continuationSource(sourceId, taskId, newAttemptId);
  const output = known(await runtime.repository.inspectRef(String(source.specification.outputRef)));
  if (output.state !== 'present') throw new CommandFailure('not_retained');
  if (source.leaseState === 'held') {
    if (!source.allocation || known(await runtime.completion.workspace.inspect(source.allocation)).state !== 'matching') {
      throw new CommandFailure('owner_unresolved');
    }
    if (!known(await runtime.repository.inspectWorkspace(source.allocation.path)).clean) throw new CommandFailure('workspace_dirty');
  } else if (source.leaseState === 'unknown') throw new CommandFailure('owner_unresolved');
  const startingCommit = recordedCommit ?? sourceCommit ?? output.commit;
  if (!recordedCommit && sourceCommit !== null && (!known(await runtime.repository.compare(String(source.specification.startingCommit), sourceCommit))
    || !known(await runtime.repository.compare(sourceCommit, output.commit)))) throw new CommandFailure('policy_refused');
  const subject = await runtime.repository.command(['show', '-s', '--format=%s', startingCommit]);
  if (!subject.complete || subject.code !== 0) throw new CommandFailure('not_retained');
  return { startingCommit, subject: subject.stdout.trim().slice(0, 4096), source };
}

export function continuationHandover(db: Database, sourceId: string, startingCommit: string, chosen: boolean, note: string | null): JsonObject {
  const source = db.attempt(sourceId);
  const preparation = db.requests().find(r => r.attemptId === sourceId && r.operation === 'worker.prepare');
  const handover: JsonObject = {
    identity: { databaseId: source.specification.databaseId!, contextId: source.specification.contextId!, taskId: source.taskId,
      attemptId: source.id, leaseId: source.allocation?.leaseId ?? null, sessionId: preparation?.input.sessionId ?? null },
    sourceRevision: source.revision, candidate: source.candidate, startingCommit, personChoseCommit: chosen, outcome: source.outcome,
    failure: db.validatedWorkerResult(sourceId)?.content.reason
      ?? db.events().findLast(e => e.attemptId === sourceId && e.kind === 'attempt.completed')?.payload ?? null,
    criteria: source.specification.criteria!,
    checks: db.requests().filter(r => r.attemptId === sourceId && r.operation === 'checks.run').map(r => ({ requestId: r.id, state: r.state, result: r.result })),
    // R21 will add question history.
    reviewFindings: db.reviewEvidence(sourceId).findings.map(event => event.payload), openQuestions: [], answeredQuestions: [], note };
  if (JSON.stringify(handover).length > 262144) throw new CommandFailure('policy_refused', { reason: 'Continuation handover exceeds 262144 characters' });
  return handover;
}
