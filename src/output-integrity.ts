import { canonicalJson } from './configuration.ts';
import { CommandFailure } from './response.ts';
import { readWorkerResult } from './storage/results.ts';
import type { Database } from './storage/database.ts';
import type { GitRepository } from './adapters/repository.ts';

export type OutputRepository = Pick<GitRepository, 'inspectRef' | 'inspectWorkspace'>;

/** Re-read mutable output immediately before using the recorded evidence. */
export async function requireOutputIntegrity(db: Database, attemptId: string, repository: OutputRepository,
  selected?: { outputRef: string; commit: string }) {
  const attempt = db.attempt(attemptId), candidate = selected ?? attempt.candidate;
  if (candidate) {
    const output = await repository.inspectRef(String(candidate.outputRef));
    if (output.status !== 'confirmed') throw new CommandFailure('owner_unknown', { attemptId });
    if (output.value.state !== 'present' || output.value.commit !== candidate.commit) {
      throw new CommandFailure('candidate_moved', { attemptId, commit: candidate.commit });
    }
  }
  await requireResultIntegrity(db, attemptId);
  if (attempt.allocation && attempt.leaseState !== 'returned') {
    const state = await repository.inspectWorkspace(attempt.allocation.path, true, []);
    if (state.status !== 'confirmed') throw new CommandFailure('owner_unknown', { attemptId });
    if (!state.value.clean) throw new CommandFailure('workspace_dirty', { attemptId });
  }
}

export async function requireResultIntegrity(db: Database, attemptId: string) {
  const recorded = db.validatedWorkerResult(attemptId);
  if (!recorded) return;
  try {
    const current = await readWorkerResult(db.workerResultBinding(attemptId));
    if (recorded.digest === current.digest && canonicalJson(recorded.artefacts) === canonicalJson(current.artefacts)) return current;
  } catch {
    // Missing, linked and invalid files are discrepancies too; never replace the record.
  }
  throw new CommandFailure('result_discrepancy', { attemptId });
}
