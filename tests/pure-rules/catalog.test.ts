import assert from "node:assert/strict";
import test from "node:test";
import { catalogue, executeOperation, findOperation } from "../../src/catalog.ts";
import type { JsonSchema } from "../../src/catalog.ts";
import { validateSchema } from '../../src/operation-schemas.ts';
import { nextActionOperations } from '../../src/next-action.ts';

function checkInputSchema(schema: JsonSchema): void {
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, "unknown fields must refuse");
    const properties = schema.properties as Record<string, JsonSchema>;
    assert.ok(properties && typeof properties === "object");
    if (Object.hasOwn(properties, 'manageTasks')) assert.deepEqual(schema.required, [], 'R18 permissions have versioned defaults');
    else assert.deepEqual([...(schema.required as string[])].sort(), Object.keys(properties).sort(), "every input property is required");
    for (const property of Object.values(properties)) {
      assert.equal(typeof property.description, "string");
      assert.ok((property.description as string).trim());
      checkInputSchema(property);
    }
  }
  if (schema.items) checkInputSchema(schema.items as JsonSchema);
  for (const union of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(union)) for (const member of union) checkInputSchema(member as JsonSchema);
  }
}

test("R28/A52: one version-1 catalogue exposes context.init and catalog.show with complete definitions", () => {
  assert.equal(catalogue.catalogueVersion, 1);
  assert.deepEqual(catalogue.operations.map(operation => operation.name).sort(), ['question.ask', 'question.answer', 'catalog.show', 'context.init', 'context.configure', 'status.show',
    'objective.add', 'objective.show', 'objective.update', 'objective.abandon', 'objective.reopen',
    'task.add', 'task.show', 'task.list', 'task.update', 'task.move', 'task.hold', 'task.release', 'task.block', 'task.unblock', 'task.reorder', 'task.done', 'task.reopen',
    'attempt.dispatch', 'attempt.continue', 'attempt.review', 'attempt.show', 'attempt.stop', 'attempt.steer', 'attempt.accept', 'attempt.rebase', 'attempt.return', 'attempt.discard', 'claim.resolve', 'effect.resolve', 'profile.clear', 'checks.run', 'request.show', 'diagnostics.clean'].sort());
  for (const operation of catalogue.operations) {
    assert.ok(operation.description.trim());
    if (operation.name === 'question.ask') assert.deepEqual(operation.roles, ['worker', 'supervisor']);
    else assert.ok(operation.roles.includes('person'));
    if (['context.init', 'context.configure', 'attempt.return', 'attempt.discard', 'claim.resolve', 'effect.resolve', 'profile.clear', 'diagnostics.clean'].includes(operation.name)) assert.deepEqual(operation.roles, ['person']);
    assert.deepEqual(operation.bindingDerivedFields, ['task.add', 'objective.show', 'objective.update', 'objective.abandon', 'objective.reopen'].includes(operation.name) ? ['objectiveId'] : []);
    assert.equal(operation.mutates, !['catalog.show', 'task.show', 'task.list', 'attempt.show', 'status.show', 'request.show', 'objective.show'].includes(operation.name));
    assert.equal(operation.plans, ['context.configure', 'attempt.dispatch', 'attempt.continue', 'attempt.review', 'attempt.stop', 'attempt.steer', 'attempt.accept', 'attempt.rebase', 'attempt.return', 'attempt.discard', 'claim.resolve', 'effect.resolve', 'profile.clear', 'checks.run', 'diagnostics.clean'].includes(operation.name));
    assert.equal(operation.tool.name, `dk_${operation.name.replaceAll(".", "_")}`);
    assert.equal(operation.tool.description, operation.description);
    checkInputSchema(operation.inputSchema);
    assert.equal(operation.outputSchema.type, "object");
    if (['context.init', 'catalog.show'].includes(operation.name)) assert.equal(operation.outputSchema.additionalProperties, false);
    assert.equal(findOperation(operation.name), operation);
    if (operation.name === 'catalog.show') {
      assert.deepEqual(operation.outputSchema.required, ["catalogueVersion", "operations"]);
      assert.equal(executeOperation(operation), catalogue, "execution emits the core definitions, not a copy");
    } else {
      assert.throws(() => executeOperation(operation), /Invalid arguments/u, 'initialisation requires a trusted CLI selector');
    }
  }
  assert.equal(findOperation('not.an-operation'), undefined);
});

test('R28/R30: dependency schemas require exactly two task IDs and do not offer dry-run planning', () => {
  for (const name of ['task.block', 'task.unblock']) {
    const operation = findOperation(name)!;
    assert.deepEqual(operation.roles, ['person', 'supervisor']);
    assert.equal(operation.mutates, true);
    assert.equal(operation.plans, false);
    assert.deepEqual(operation.inputSchema.required, ['taskId', 'blockerId']);
    const input = { taskId: 'feature', blockerId: 'prerequisite' };
    assert.equal(validateSchema(operation.inputSchema, input), null);
    for (const invalid of [{ taskId: 'feature' }, { ...input, blockerId: '' }, { ...input, taskId: 'not a slug' },
      { ...input, dryRun: true }, { ...input, caller: 'person' }]) {
      assert.notEqual(validateSchema(operation.inputSchema, invalid), null);
    }
  }
});

test('R28/R30/R31: stop and steer expose the exact planable control inputs and trusted roles', () => {
  const attemptId = '11111111-1111-4111-8111-111111111111';
  for (const name of ['attempt.stop', 'attempt.steer']) {
    const operation = findOperation(name)!;
    assert.deepEqual(operation.roles, ['person', 'supervisor']);
    assert.equal(operation.plans, true);
    const args = { attemptId, dryRun: true, ...(name === 'attempt.steer' ? { message: 'Change direction', mode: 'active' } : {}) };
    assert.equal(validateSchema(operation.inputSchema, args), null);
    assert.notEqual(validateSchema(operation.inputSchema, { ...args, extra: true }), null);
    const { dryRun: _, ...missing } = args;
    assert.notEqual(validateSchema(operation.inputSchema, missing), null);
    if (name === 'attempt.steer') {
      assert.equal(validateSchema(operation.inputSchema, { ...args, mode: 'after_turn' }), null);
      assert.notEqual(validateSchema(operation.inputSchema, { ...args, mode: 'restart' }), null);
      assert.notEqual(validateSchema(operation.inputSchema, { ...args, message: ' ' }), null);
    }
  }
});

test('R28: every operation named by a next action exists in the catalogue', () => {
  for (const name of nextActionOperations) assert.ok(findOperation(name), `Missing next-action operation: ${name}`);
});

test("R28/A52: the no-argument input schema is a described strict empty object", () => {
  assert.deepEqual(findOperation('catalog.show')!.inputSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    description: "Empty arguments. No context or caller fields are accepted.",
    properties: {},
    required: [],
    additionalProperties: false,
  });
});
