import type { JsonSchema, OperationDefinition, Role } from './catalog.ts';
import { permissionNames } from './storage/objectives.ts';

const string = { type: 'string', minLength: 1, maxLength: 65536, pattern: '\\S' };
const id = { ...string, pattern: '^[A-Za-z0-9._-]+$' };
const uuid = { ...string, pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$' };
const bool = { type: 'boolean' };
const nullable = (schema: JsonSchema) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object',
  properties: Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, { description: `${key.replace(/([A-Z])/gu, ' $1').toLowerCase()}.`, ...schema }])),
  required: Object.keys(properties), additionalProperties: false });
const page = object({ after: nullable(string), limit: { type: 'integer', minimum: 1, maximum: 100 } });
const definition = (review: boolean) => object({ title: string, instructions: { type: 'string', maxLength: 65536 },
  criteria: { type: 'array', maxItems: 100, items: { ...string, maxLength: 2048, pattern: '^[^\\r\\n\\u2028\\u2029]*\\S[^\\r\\n\\u2028\\u2029]*$' } },
  kind: { enum: review ? ['code', 'report', 'review'] : ['code', 'report'] }, profile: nullable(string) });
const criteria = { type: 'array', maxItems: 100, items: { ...string, maxLength: 2048, pattern: '^[^\\r\\n\\u2028\\u2029]*\\S[^\\r\\n\\u2028\\u2029]*$' } };
const permissions = { ...object(Object.fromEntries(permissionNames.map(name => [name, bool]))), required: [] };
const budget = object({ maxCost: nullable({ type: 'number', minimum: 0 }), currency: nullable(string),
  maxTokens: nullable({ type: 'integer', minimum: 0 }), maxWorkerTimeMs: nullable({ type: 'integer', minimum: 0 }) });
const deadline = nullable({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$' });
const objectiveFields = { criteria, scope: { type: 'string' }, constraints: { type: 'string' }, permissions, budget, deadline };
const attempt = { attemptId: uuid };
const planAttempt = { ...attempt, dryRun: bool };
const view = { type: 'object' };
const leaseReturn = object({ state: { enum: ['returned', 'kept'] }, reason: nullable(string) });
const steps = { type: 'array', items: object({ operation: string, target: string, requires: { type: 'array', items: string }, conditional: bool }) };
const paginated = (items: JsonSchema) => object({ items: { type: 'array', items }, next: nullable(string), total: { type: 'integer', minimum: 0 } });
const attention = { reason: nullable(string), nextAction: nullable(object({ operation: string, args: view, description: string })) };
const statusTask = object({ id, title: string, state: { enum: ['queued', 'in_flight', 'done'] }, ready: bool,
  holdReason: nullable(string), blockedBy: { type: 'array', items: id }, ...attention });
const statusAttempt = object({ id: uuid, taskId: id, number: { type: 'integer', minimum: 1 }, phase: string,
  outcome: nullable({ enum: ['completed', 'held', 'failed', 'interrupted', 'over_budget'] }), leaseState: string,
  candidateCommit: nullable({ type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }), review: view, checksState: string, resultInvalid: nullable(object({ message: { ...string, maxLength: 1024 } })), ...attention });
function outputSchema(name: string): JsonSchema {
  if (name === 'context.configure') return object({ revision: { type: 'integer', minimum: 1 }, digest: string,
    changedFields: { type: 'array', items: string }, steps });
  if (name === 'profile.clear') return object({ profile: string, steps });
  if (name === 'request.show') {
    const identity = { id: uuid, requestId: string, operation: string,
      state: { enum: ['pending', 'claimed', 'succeeded', 'rejected', 'withdrawn', 'uncertain'] } };
    return object({ ...identity, category: { enum: ['command', 'effect'] }, caller: view,
      attemptId: nullable(uuid), objectiveId: nullable(id), parent: nullable(object(identity)),
      target: nullable(object({ kind: { enum: ['workspace', 'worker', 'answer', 'checks', 'repository', 'diagnostics'] }, reference: view })),
      input: view, result: nullable(view), effects: { type: 'array', maxItems: 20, items: object(identity) },
      effectsTotal: { type: 'integer', minimum: 0 } });
  }
  if (name.startsWith('objective.')) return object({ objective: view });
  if (name === 'task.list') return paginated(view);
  if (name === 'task.reorder') return object({ tasks: { type: 'array', items: view } });
  if (name.startsWith('task.')) return object({ task: view });
  if (name === 'attempt.show') return { type: 'object', required: ['identity', 'phase', 'executionOpen', 'specification', 'allocation', 'candidate', 'terminalEvidence', 'outcome', 'leaseState', 'revision'],
    properties: Object.fromEntries(['id', 'taskId', 'number', 'revision', 'executionOpen', 'phase', 'launchState', 'specification', 'allocation', 'leaseState', 'outcome', 'candidate', 'identity', 'workerRef', 'result', 'resultInvalid', 'nextAction', 'terminalEvidence', 'taskTransitionApplied', 'acceptance', 'review', 'effects'].map(key => [key, {}])), additionalProperties: false };
  if (name === 'status.show') return object({ contextId: string, databaseId: string, configurationRevision: { type: 'integer' }, migrationState: string,
    limitedProfiles: { type: 'array', items: view }, capacity: view, tasks: paginated(statusTask), attempts: paginated(statusAttempt), page: object({ next: nullable(string), total: { type: 'integer', minimum: 0 } }), claims: { type: 'array', items: view }, effects: { type: 'array', items: view },
    blockers: { type: 'array', items: view }, objectives: { type: 'array', items: view }, openPersonQuestions: { type: 'array', items: view } });
  const variants: JsonSchema[] = [object({ steps })];
  if (name === 'attempt.dispatch') {
    const skippedTasks = { type: 'array', items: object({ taskId: id, reason: string }) };
    variants.push(object({ taskId: id, skippedTasks, steps }), object({ attempt: view, leaseReturn, skippedTasks, steps }), object({ attempt: view, leaseReturn, replayed: bool, skippedTasks, steps }));
  }
  else if (name === 'attempt.continue') {
    const skippedTasks = { type: 'array', items: object({ taskId: id, reason: string }) };
    variants.push(object({ taskId: id, skippedTasks, steps, startingCommit: string, subject: { type: 'string' } }),
      object({ attempt: view, leaseReturn, skippedTasks, steps }), object({ attempt: view, leaseReturn, replayed: bool, skippedTasks, steps }));
  }
  else if (name === 'attempt.review') variants.push(object({ task: view, steps }));
  else if (['attempt.accept', 'attempt.return', 'attempt.discard'].includes(name)) {
    variants.push(object({ attempt: view, leaseReturn, steps }), object({ attempt: view, leaseReturn }));
  }
  else if (name === 'checks.run') variants.push(object({ request: view, steps }));
  else if (name.startsWith('attempt.')) variants.push(object({ attempt: view, steps }));
  else if (name === 'claim.resolve') variants.push(object({ steps, scope: view }), object({ claim: view, steps, scope: view }));
  else if (name === 'effect.resolve') variants.push(object({ steps, target: nullable(view) }), object({ effect: view, steps, target: nullable(view) }));
  return { type: 'object', anyOf: variants };
}
function operation(name: string, description: string, properties: Record<string, JsonSchema>, mutates = true,
  roles: readonly Role[] = ['person', 'supervisor']): OperationDefinition {
  return { name, description, inputSchema: object(properties), roles, bindingDerivedFields: name === 'task.add' || (name.startsWith('objective.') && Object.hasOwn(properties, 'objectiveId')) ? ['objectiveId'] : [], mutates,
    plans: Object.hasOwn(properties, 'dryRun'), outputSchema: outputSchema(name),
    tool: { name: `dk_${name.replaceAll('.', '_')}`, description } };
}
export const coreOperations: OperationDefinition[] = [
  operation('context.configure', 'Validate and apply the selected configuration while quiescent.', { dryRun: bool }, true, ['person']),
  operation('profile.clear', 'Clear a limited profile after its provider limit resets.', { profile: string, dryRun: bool }, true, ['person']),
  operation('status.show', 'Read context status, capacity and unresolved owners.', { attentionOnly: bool, page }, false),
  operation('request.show', 'Read a request by its exact public replay key, with bounded and redacted evidence.', { requestId: string }, false),
  operation('task.add', 'Add a task at the end of the queue.', { id: nullable(id), definition: definition(false), objectiveId: nullable(id) }),
  operation('task.show', 'Read a task and its readiness.', { taskId: id }, false),
  operation('task.list', 'Read a page of tasks in queue order.', { state: { enum: ['queued', 'in_flight', 'done', null] }, readyOnly: bool, page }, false),
  operation('task.update', 'Replace task definition at the expected revision.', { taskId: id, expectedRevision: { type: 'integer', minimum: 0 }, definition: definition(true) }),
  operation('task.move', 'Move a task to an open objective or unlink it.', { taskId: id, expectedRevision: { type: 'integer', minimum: 0 }, objectiveId: nullable(id) }, true, ['person']),
  operation('task.hold', 'Hold a task with a single-line reason.', { taskId: id, reason: { ...string, maxLength: 200, pattern: '^[^\\r\\n\\u2028\\u2029]+$' } }),
  operation('task.release', 'Release a task hold.', { taskId: id }),
  ...['block', 'unblock'].map(action => operation(`task.${action}`, `${action === 'block' ? 'Add' : 'Remove'} a task dependency.`, { taskId: id, blockerId: id })),
  operation('task.reorder', 'Reorder the tasks in this scope.', { orderedTaskIds: { type: 'array', items: id, uniqueItems: true } }),
  ...['done', 'reopen'].map(action => operation(`task.${action}`, `Record a ${action} judgement without inventing acceptance evidence.`, { taskId: id, note: nullable(string) })),
  operation('objective.add', 'Create an open objective; null permissions and budget select all permissions and unlimited usage.',
    { id, request: string, ...objectiveFields, permissions: nullable(permissions), budget: nullable(budget) }, true, ['person']),
  operation('objective.show', 'Read an objective and its current closure.', { objectiveId: id }, false),
  operation('objective.update', 'Replace objective fields at the expected revision; protected fields require the creator.',
    { objectiveId: id, expectedRevision: { type: 'integer', minimum: 0 }, ...objectiveFields }, true, ['person']),
  operation('objective.abandon', 'Abandon an objective without stopping workers or returning leases.', { objectiveId: id, reason: string }, true, ['person']),
  operation('objective.reopen', 'Reopen an objective, preserving closure history.', { objectiveId: id, reason: string }),
  operation('attempt.dispatch', 'Dispatch a ready task and wait in the foreground through completion and checks.', { taskId: nullable(id), profile: nullable(string), dryRun: bool }),
  operation('attempt.continue', 'Continue a terminal settled source in a new attempt without accepting its work.', {
    sourceAttemptId: uuid, sourceCommit: nullable({ type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }),
    profile: nullable(string), note: nullable(string), dryRun: bool }, true, ['person']),
  operation('attempt.review', 'Create an independent review task for an exact retained candidate.', planAttempt),
  operation('attempt.show', 'Read full attempt identity and evidence.', attempt, false),
  operation('checks.run', 'Run checks for a recorded candidate of a terminal attempt, reusing matching passing evidence.', {
    ...planAttempt, commit: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' } }),
  operation('attempt.stop', 'Request that the owning dispatch fence the worker; terminal evidence remains separate.', planAttempt),
  operation('attempt.steer', 'Deliver a message only when the launcher supports the requested mode.', { ...planAttempt, message: string, mode: { enum: ['active', 'after_turn'] } }),
  operation('attempt.accept', 'Accept an exact retained candidate and apply finalisation policy.', { ...planAttempt, candidateCommit: nullable({ type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }), overrideReason: nullable(string) }),
  operation('attempt.rebase', 'Rebase an unaccepted candidate onto the current target without accepting output.', planAttempt, true, ['person']),
  operation('attempt.return', 'Return the exact lease when no work could be lost.', { ...planAttempt }, true, ['person']),
  operation('attempt.discard', 'Discard output and return the exact lease after scoped confirmations.', { ...planAttempt, confirmDiscard: bool, reason: string }, true, ['person']),
  operation('claim.resolve', 'Resolve exact owner scope with stopped-owner confirmation and evidence, never age alone.', { claimId: uuid, confirmStopped: bool, evidence: string, dryRun: bool }, true, ['person']),
  operation('effect.resolve', 'Resolve an uncertain effect with owner evidence and stopped-owner confirmation.', { effectId: uuid, outcome: { enum: ['happened', 'not_happened'] }, evidence: string, confirmStopped: bool, dryRun: bool }, true, ['person']),
];

/** The catalogue uses this deliberately small JSON Schema vocabulary in CLI and host transports. */
export function validateSchema(schema: JsonSchema, value: unknown, path = '$'): string | null {
  if (schema.anyOf) return (schema.anyOf as JsonSchema[]).some(s => validateSchema(s, value, path) === null) ? null : path;
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return path;
  if (schema.type === 'null') return value === null ? null : path;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return path;
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || Number(value) < Number(schema.minimum ?? -Infinity) || Number(value) > Number(schema.maximum ?? Infinity))) return path;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < Number(schema.minimum ?? -Infinity) || value > Number(schema.maximum ?? Infinity))) return path;
  if (schema.type === 'string') {
    if (typeof value !== 'string' || [...value].length < Number(schema.minLength ?? 0) || [...value].length > Number(schema.maxLength ?? Infinity)
      || (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value))) return path;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > Number(schema.maxItems ?? Infinity) || (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length)) return path;
    for (let i = 0; i < value.length; i++) { const invalid = validateSchema(schema.items as JsonSchema, value[i], `${path}[${i}]`); if (invalid) return invalid; }
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return path;
    const record = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(record, key)) return `${path}.${key}`;
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(properties, key)) { if (schema.additionalProperties === false) return `${path}.${key}`; else continue; }
      const invalid = validateSchema(properties[key]!, record[key], `${path}.${key}`); if (invalid) return invalid;
    }
  }
  return null;
}
