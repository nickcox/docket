import type { JsonSchema, OperationDefinition, Role } from './catalog.ts';

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
const attempt = { attemptId: uuid };
const planAttempt = { ...attempt, dryRun: bool };
const view = { type: 'object' };
const steps = { type: 'array', items: object({ operation: string, target: string, requires: { type: 'array', items: string }, conditional: bool }) };
const paginated = (items: JsonSchema) => object({ items: { type: 'array', items }, next: nullable(string), total: { type: 'integer', minimum: 0 } });
const attention = { reason: nullable(string), nextAction: nullable(object({ operation: string, args: view, description: string })) };
const statusTask = object({ id, title: string, state: { enum: ['queued', 'in_flight', 'done'] }, ready: bool,
  holdReason: nullable(string), blockedBy: { type: 'array', items: id }, ...attention });
const statusAttempt = object({ id: uuid, taskId: id, number: { type: 'integer', minimum: 1 }, phase: string,
  outcome: nullable({ enum: ['completed', 'held', 'failed'] }), leaseState: string,
  candidateCommit: nullable({ type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }), checksState: string, ...attention });
function outputSchema(name: string): JsonSchema {
  if (name === 'task.list') return paginated(view);
  if (name === 'task.reorder') return object({ tasks: { type: 'array', items: view } });
  if (name.startsWith('task.')) return object({ task: view });
  if (name === 'attempt.show') return { type: 'object', required: ['identity', 'phase', 'executionOpen', 'specification', 'allocation', 'candidate', 'terminalEvidence', 'outcome', 'leaseState', 'revision'],
    properties: Object.fromEntries(['id', 'taskId', 'number', 'revision', 'executionOpen', 'phase', 'launchState', 'specification', 'allocation', 'leaseState', 'outcome', 'candidate', 'identity', 'workerRef', 'result', 'terminalEvidence', 'taskTransitionApplied', 'acceptance', 'effects'].map(key => [key, {}])), additionalProperties: false };
  if (name === 'status.show') return object({ contextId: string, databaseId: string, configurationRevision: { type: 'integer' }, migrationState: string,
    capacity: view, tasks: paginated(statusTask), attempts: paginated(statusAttempt), page: object({ next: nullable(string), total: { type: 'integer', minimum: 0 } }), claims: { type: 'array', items: view }, effects: { type: 'array', items: view },
    blockers: { type: 'array', items: view }, objectives: { type: 'array', items: view }, openPersonQuestions: { type: 'array', items: view } });
  const variants: JsonSchema[] = [object({ steps })];
  if (name === 'attempt.dispatch') {
    const skippedTasks = { type: 'array', items: object({ taskId: id, reason: string }) };
    variants.push(object({ taskId: id, skippedTasks, steps }), object({ attempt: view, skippedTasks, steps }), object({ attempt: view, replayed: bool, skippedTasks, steps }));
  }
  else if (name.startsWith('attempt.')) variants.push(object({ attempt: view, steps }));
  else if (name === 'claim.resolve') variants.push(object({ steps, scope: view }), object({ claim: view, steps, scope: view }));
  else if (name === 'effect.resolve') variants.push(object({ steps, target: nullable(view) }), object({ effect: view, steps, target: nullable(view) }));
  return { type: 'object', anyOf: variants };
}
function operation(name: string, description: string, properties: Record<string, JsonSchema>, mutates = true,
  roles: readonly Role[] = ['person', 'supervisor']): OperationDefinition {
  return { name, description, inputSchema: object(properties), roles, bindingDerivedFields: name === 'task.add' ? ['objectiveId'] : [], mutates,
    plans: Object.hasOwn(properties, 'dryRun'), outputSchema: outputSchema(name),
    tool: { name: `dk_${name.replaceAll('.', '_')}`, description } };
}
export const coreOperations: OperationDefinition[] = [
  operation('status.show', 'Read context status, capacity and unresolved owners.', { attentionOnly: bool, page }, false),
  operation('task.add', 'Add a task at the end of the queue.', { id: nullable(id), definition: definition(false), objectiveId: nullable(id) }),
  operation('task.show', 'Read a task and its readiness.', { taskId: id }, false),
  operation('task.list', 'Read a page of tasks in queue order.', { state: { enum: ['queued', 'in_flight', 'done', null] }, readyOnly: bool, page }, false),
  operation('task.update', 'Replace task definition at the expected revision.', { taskId: id, expectedRevision: { type: 'integer', minimum: 0 }, definition: definition(true) }),
  operation('task.hold', 'Hold a task with a single-line reason.', { taskId: id, reason: { ...string, maxLength: 200, pattern: '^[^\\r\\n\\u2028\\u2029]+$' } }),
  operation('task.release', 'Release a task hold.', { taskId: id }),
  ...['block', 'unblock'].map(action => operation(`task.${action}`, `${action === 'block' ? 'Add' : 'Remove'} a task dependency.`, { taskId: id, blockerId: id })),
  operation('task.reorder', 'Reorder the tasks in this scope.', { orderedTaskIds: { type: 'array', items: id, uniqueItems: true } }),
  ...['done', 'reopen'].map(action => operation(`task.${action}`, `Record a ${action} judgement without inventing acceptance evidence.`, { taskId: id, note: nullable(string) })),
  operation('attempt.dispatch', 'Dispatch a ready task and wait in the foreground through completion and checks.', { taskId: nullable(id), profile: nullable(string), dryRun: bool }),
  operation('attempt.show', 'Read full attempt identity and evidence.', attempt, false),
  operation('attempt.accept', 'Accept an exact retained candidate and apply finalisation policy.', { ...planAttempt, candidateCommit: nullable({ type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }), overrideReason: nullable(string) }),
  operation('attempt.return', 'Return the exact lease after confirming no processes remain.', { ...planAttempt, noProcesses: bool }, true, ['person']),
  operation('attempt.discard', 'Discard output and return the exact lease after scoped confirmations.', { ...planAttempt, confirmDiscard: bool, noProcesses: bool, reason: string }, true, ['person']),
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
