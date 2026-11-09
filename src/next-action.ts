export const nextActionOperations = [
  'question.answer', 'task.show', 'attempt.dispatch', 'attempt.show', 'attempt.accept', 'attempt.rebase',
  'attempt.return', 'attempt.continue', 'checks.run', 'claim.resolve', 'request.show', 'profile.clear', 'status.show',
] as const;

/** Keep operation-bearing next actions in the catalogue's tested set. */
export function nextAction(operation: typeof nextActionOperations[number], args: Record<string, unknown>, description: string) {
  return { operation, args, description };
}
