import { catalogue } from './catalog.ts';
import type { JsonSchema, OperationDefinition, Role } from './catalog.ts';
import type { ContextSelector } from './context.ts';
import { executeCoreOperation } from './operations.ts';
import type { OperationOptions } from './operations.ts';
import { validateSchema } from './operation-schemas.ts';
import { CommandFailure } from './response.ts';
import { taskActor } from './storage/tasks.ts';
import type { TaskActor } from './storage/tasks.ts';

export type Caller = TaskActor | { kind: 'worker'; attemptId: string } | { kind: 'host'; id: string };

/** Created by trusted transport code, never from operation JSON or host metadata. */
export function createBinding(caller: Caller, selector: ContextSelector, options: Omit<OperationOptions, 'caller'> = {}) {
  const bound = structuredClone(caller), context = structuredClone(selector);
  if (bound.kind === 'person' || bound.kind === 'supervisor') taskActor(bound);
  else if (bound.kind === 'worker' ? !bound.attemptId : bound.kind !== 'host' || !bound.id) throw new TypeError('Invalid trusted caller');
  const definitions = catalogueForRole(bound.kind, bound.kind === 'supervisor');
  return {
    catalogue: { catalogueVersion: 1 as const, operations: structuredClone(definitions) },
    async execute(name: string, args: Record<string, unknown>, requestId?: string, progress: (message: string) => void = () => {}): Promise<Record<string, unknown>> {
      const operation = definitions.find(item => item.name === name);
      if (!operation) throw new CommandFailure('person_required');
      if (validateSchema(operation.inputSchema, args)) throw new CommandFailure('invalid_input');
      if (name === 'catalog.show') return structuredClone({ catalogueVersion: 1, operations: definitions });
      const input = structuredClone(args);
      if (bound.kind === 'supervisor') for (const field of operation.bindingDerivedFields) input[field] = bound.objectiveId;
      if (bound.kind === 'host' && operation.mutates && !requestId) throw new CommandFailure('invalid_input');
      const core = catalogue.operations.find(item => item.name === name)!;
      return executeCoreOperation(core, input, progress, context, requestId, { ...options, caller: bound });
    },
  };
}

export function catalogueForRole(role: Role, boundObjective = role === 'supervisor'): OperationDefinition[] {
  return catalogue.operations.filter(operation => operation.roles.includes(role) && !(['supervisor', 'worker'].includes(role) && operation.name === 'status.watch')).map(operation => {
    const copy = structuredClone(operation);
    if (role !== 'supervisor') return copy;
    const schema = copy.inputSchema as Record<string, unknown>, properties = schema.properties as Record<string, JsonSchema>;
    if (boundObjective) for (const field of copy.bindingDerivedFields) {
      delete properties[field];
      schema.required = (schema.required as string[]).filter(key => key !== field);
    }
    // These fields remain explicit null defaults, never approval channels.
    for (const field of ['sourceCommit', 'overrideReason']) if (properties[field]) properties[field] = { type: 'null', description: `${field} is person-only; supervisors supply null.` };
    return copy;
  });
}
