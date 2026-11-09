import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFixture, person, head, start, policyContent } from '../helpers/check-attempt.ts';
import { findOperation } from '../../src/catalog.ts';
import { validateSchema } from '../../src/operation-schemas.ts';

const objective = { id: 'goal', request: 'Finish', criteria: ['Works'], scope: '', constraints: '', permissions: null, budget: null, deadline: null };

test('R19/A38: retained report artefacts support completion without Git acceptance or lease return', async t => {
  const f = await checkFixture(t), db = f.db;
  const report = await f.attempt('report', ['Criterion'], undefined, head, start, policyContent, 'completed', 'report');
  await db.addObjective(objective, person);
  await db.moveTask('report', db.task('report').definitionRevision, 'goal', person);
  const event = db.events().find(e => e.attemptId === report.id && e.kind === 'attempt.completed')!;
  const candidate = event.payload.candidate as { id: string; commit: null };
  assert.equal(candidate.commit, null);
  const reference = { kind: 'accepted_output' as const, attemptId: report.id, candidateId: candidate.id, candidateCommit: null,
    artefactDigests: db.validatedWorkerResult(report.id)!.artefacts.map(item => String(item.digest)), evidenceEventId: event.id, reviewAttemptId: null };
  const statements = [{ position: 1, statement: 'Report explains the result', references: [reference] }];
  for (const patch of [{ artefactDigests: [] }, { artefactDigests: ['invented'] }, { candidateCommit: head }, { candidateId: report.id }]) {
    const before = { events: db.events(), objective: db.objective('goal', person), requests: db.requests() };
    await assert.rejects(db.completeObjective('goal', [{ ...statements[0]!, references: [{ ...reference, ...patch }] }], person));
    assert.deepEqual({ events: db.events(), objective: db.objective('goal', person), requests: db.requests() }, before);
  }
  const active = await f.attempt('active', ['Criterion'], undefined, head, start, policyContent, 'prepared');
  await db.moveTask('active', db.task('active').definitionRevision, 'goal', person);
  assert.equal(db.attempt(active.id).executionOpen, true);
  const before = { attempt: db.attempt(report.id), active: db.attempt(active.id), tasks: db.tasks(), claims: db.claims() };
  assert.equal((await db.completeObjective('goal', statements, person)).state, 'completed');
  assert.deepEqual({ attempt: db.attempt(report.id), active: db.attempt(active.id), tasks: db.tasks(), claims: db.claims() }, before);
  assert.equal(db.events().some(e => e.kind === 'candidate.accepted'), false);
  await db.closeOrReopenObjective('goal', 'reopen', 'Revise', person);
  assert.deepEqual(db.objective('goal', person).completion, []);
  assert.deepEqual((db.events().find(e => e.kind === 'objective.reopen')!.payload.before as any).completion, statements);
});

test('R28/R30: completion has the exact strict non-planable contract', () => {
  const operation = findOperation('objective.complete')!;
  assert.equal(operation.plans, false);
  assert.deepEqual(operation.roles, ['person', 'supervisor']);
  assert.deepEqual(operation.bindingDerivedFields, ['objectiveId']);
  const uuid = '12345678-1234-4123-8123-123456789012';
  const reference = { kind: 'review', attemptId: uuid, candidateId: uuid, candidateCommit: head, artefactDigests: [], evidenceEventId: uuid, reviewAttemptId: uuid };
  const input = { objectiveId: 'goal', statements: [{ position: 1, statement: 'Explained', references: [reference] }] };
  assert.equal(validateSchema(operation.inputSchema, input), null);
  for (const invalid of [{ ...input, dryRun: true }, { ...input, caller: person },
    { ...input, statements: [{ ...input.statements[0], extra: true }] },
    { ...input, statements: [{ ...input.statements[0], references: [{ ...reference, databaseId: uuid }] }] },
    { ...input, statements: [{ ...input.statements[0], references: [{ ...reference, candidateId: 'invented' }] }] }]) {
    assert.notEqual(validateSchema(operation.inputSchema, invalid), null);
  }
});
