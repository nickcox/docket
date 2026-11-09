import type { Permissions } from './storage/objectives.ts';

/** An absent entry is not an implicit grant. */
export const supervisorPermissions: Readonly<Record<string, keyof Permissions | null>> = {
  'status.show': null, 'request.show': null, 'task.show': null, 'task.list': null, 'attempt.show': null, 'objective.show': null,
  'task.add': 'manageTasks', 'task.update': 'manageTasks', 'task.hold': 'manageTasks', 'task.release': 'manageTasks',
  'task.block': 'manageTasks', 'task.unblock': 'manageTasks', 'task.reorder': 'manageTasks', 'task.reopen': 'manageTasks',
  'task.done': 'completeTasks', 'objective.reopen': 'manageTasks', 'attempt.dispatch': 'dispatch',
  'attempt.continue': 'continueAttempts', 'attempt.review': 'manageTasks', 'attempt.rebase': 'rebase',
  'attempt.accept': 'acceptOutput', 'attempt.stop': 'stopWorkers', 'attempt.steer': 'steerWorkers', 'checks.run': 'acceptOutput',
};
