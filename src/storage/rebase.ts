import type { JsonObject } from './database.ts';

/** Private retention for the immutable validated result, independent of candidate selection. */
export function originalCandidateRef(specification: JsonObject): string {
  return `refs/docket/original/${String(specification.databaseId)}/${String(specification.attemptId)}`;
}
export type RebaseEffect = 'pin' | 'rebase' | 'move' | 'attach';
export type CompletionEffect = 'integrate' | 'return' | 'cleanup' | 'cleanup-pin' | RebaseEffect;
