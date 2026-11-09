import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/storage/database.ts';
import { canonicalJson } from '../../src/configuration.ts';
import { consumeQuestionFiles, deliverAnswers } from '../../src/questions.ts';
import { continuationHandover } from '../../src/continuation.ts';
import { permissions, unlimitedBudget } from '../../src/storage/objectives.ts';
import type { TaskActor } from '../../src/storage/tasks.ts';
import type { QuestionCaller, QuestionInput } from '../../src/storage/questions.ts';
import type { WorkerReference } from '../../src/storage/launch.ts';
import { FakeLauncher } from '../helpers/fake-launcher.ts';
import { checkFixture, person, host, head, start } from '../helpers/check-attempt.ts';
import { defer } from '../helpers/cleanup.ts';
import { deliverQuestionFile } from '../../src/adapters/question-files.ts';
import { uncertain } from '../../src/adapters/command.ts';

const input: QuestionInput = { text: 'Which approach?', choices: ['A', 'B'], waiting: true };
const supervisor: TaskActor = { kind: 'supervisor', id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
function command(caller: QuestionCaller, operation: string, input: Record<string, any>, requestKey = randomUUID()) {
  return { caller, operation, input, requestKey, fingerprint: canonicalJson(input) };
}
async function goal(db: Database, id = 'goal') {
  return db.addObjective({ id, request: 'Build', criteria: ['Works'], scope: '', constraints: '', permissions: permissions({}), budget: unlimitedBudget, deadline: null }, person);
}
async function prepared(t: test.TestContext) {
  const f = await checkFixture(t);
  const source = await f.attempt('task', undefined, undefined, head, start, undefined, 'prepared');
  const reference: WorkerReference = { launcher: 'pi', processId: '123', sessionId: String(source.binding.identity.sessionId) };
  // The fake owner was prepared without a process. Give its result transport a Pi reference.
  using sql = new DatabaseSync(f.path);
  sql.prepare("UPDATE requests SET result = ? WHERE attempt_id = ? AND operation = 'worker.prepare'").run(JSON.stringify({ reference }), source.id);
  return { ...f, source, reference };
}

test('R21/A43: Pi files are consumed once per attempt, immutable, scoped and durable after restart and worker exit; malformed files give one diagnostic', async t => {
  const f = await prepared(t);
  await goal(f.db);
  await f.db.moveTask('task', f.db.task('task').definitionRevision, 'goal', person);
  const directory = join(dirname(f.source.binding.resultPath), 'questions');
  await mkdir(directory);
  await writeFile(join(directory, 'one.json'), JSON.stringify(input));
  await writeFile(join(directory, 'bad.json'), '{');
  await consumeQuestionFiles(f.db, f.source.id);
  const [question] = f.db.questions();
  assert.deepEqual(question!.recipient, { kind: 'supervisor', objectiveId: 'goal' });
  assert.deepEqual(question!.asker, { kind: 'worker', attemptId: f.source.id });
  assert.deepEqual(question!.scope, { taskId: 'task', attemptId: f.source.id, objectiveId: 'goal' });
  assert.equal(question!.waiting, true);
  assert.deepEqual(question!.choices, ['A', 'B']);
  await writeFile(join(directory, 'one.json'), JSON.stringify({ ...input, text: 'Changed' }));
  await writeFile(join(directory, 'bad.json'), JSON.stringify(input));
  f.db.close();
  const reopened = await Database.open(f.path, f.options);
  defer(t, () => reopened.close());
  await consumeQuestionFiles(reopened, f.source.id);
  await consumeQuestionFiles(reopened, f.source.id);
  assert.deepEqual(reopened.questions(), [question]);
  assert.equal(reopened.events().filter(e => e.kind === 'question.invalid').length, 1);
  using sql = new DatabaseSync(f.path);
  sql.prepare('UPDATE attempts SET execution_open = 0 WHERE id = ?').run(f.source.id);
  assert.deepEqual(reopened.questions(), [question], 'Exit does not erase a question');
});

test('R21/A43/A44: worker without objective addresses a person; supervisor asks a person; wrong caller or recipient refuses', async t => {
  const f = await prepared(t);
  await goal(f.db);
  const worker = { kind: 'worker' as const, attemptId: f.source.id };
  const q = await f.db.askQuestion(input, worker, 'worker');
  assert.deepEqual(q.recipient, { kind: 'person' });
  await assert.rejects(f.db.answerQuestion(q.id, 'A', supervisor, command(supervisor, 'question.answer', { questionId: q.id, text: 'A' })), { code: 'recipient_mismatch' });
  await assert.rejects(f.db.askQuestion(input, person, 'person'), { code: 'person_required' });
  const sq = await f.db.askQuestion(input, supervisor, 'supervisor', command(supervisor, 'question.ask', input));
  assert.deepEqual(sq.recipient, { kind: 'person' });
  await f.db.answerQuestion(sq.id, 'B', person, command(person, 'question.answer', { questionId: sq.id, text: 'B' }));
  assert.equal(f.db.requests().filter(r => r.operation === 'question.deliver.message').length, 1);
  await f.db.moveTask('task', f.db.task('task').definitionRevision, 'goal', person);
  const scoped = await f.db.askQuestion(input, worker, 'scoped');
  await goal(f.db, 'other');
  const wrong = { ...supervisor, objectiveId: 'other' } as TaskActor;
  await assert.rejects(f.db.answerQuestion(scoped.id, 'A', wrong, command(wrong, 'question.answer', { questionId: scoped.id, text: 'A' })), { code: 'outside_objective' });
  await f.db.updateObjective('goal', 1, { criteria: ['Works'], scope: '', constraints: '', permissions: permissions({ answerQuestions: false }), budget: unlimitedBudget, deadline: null }, person);
  await assert.rejects(f.db.answerQuestion(scoped.id, 'A', supervisor, command(supervisor, 'question.answer', { questionId: scoped.id, text: 'A' })), { code: 'permission_denied' });
});

test('R21/A44: racing connections record one answer and both delivery intents atomically; same answer is idempotent and different answer refuses', async t => {
  const f = await prepared(t);
  const q = await f.db.askQuestion(input, { kind: 'worker', attemptId: f.source.id }, 'question');
  const other = await Database.open(f.path, f.options);
  defer(t, () => other.close());
  const results = await Promise.allSettled([f.db, other].map((db, i) => db.answerQuestion(q.id, String(i), person,
    command(person, 'question.answer', { questionId: q.id, text: String(i) }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'question_answered').length, 1);
  const answered = f.db.questions()[0]!;
  assert.equal(f.db.events().filter(e => e.kind === 'question.answered').length, 1);
  const intents = f.db.requests().filter(r => r.operation.startsWith('question.deliver.'));
  assert.deepEqual(intents.map(r => r.operation).sort(), ['question.deliver.file', 'question.deliver.message']);
  assert.equal(intents[0]!.parentId, intents[1]!.parentId);
  await f.db.answerQuestion(q.id, String(answered.answer!.text), person, command(person, 'question.answer', { questionId: q.id, text: answered.answer!.text }));
  assert.equal(f.db.requests().filter(r => r.operation.startsWith('question.deliver.')).length, 2);
  const open = await f.db.askQuestion({ ...input, text: 'Still open?' }, { kind: 'worker', attemptId: f.source.id }, 'open');
  const handover = continuationHandover(f.db, f.source.id, head, false, null);
  assert.deepEqual(handover.openQuestions, [open]);
  assert.deepEqual(handover.answeredQuestions, [answered]);
});

test('R21/A44: file delivery is independent of a lost message response; uncertainty is retained and never retried or activated', async t => {
  const f = await prepared(t);
  const q = await f.db.askQuestion(input, { kind: 'worker', attemptId: f.source.id }, 'question');
  await f.db.answerQuestion(q.id, 'A', person, command(person, 'question.answer', { questionId: q.id, text: 'A' }));
  const launcher = new FakeLauncher();
  let sends = 0;
  launcher.inspect = async () => ({ status: 'known', sourceId: 'fake', sequence: 1, worker: 'active', turn: 'running', terminal: false, capabilities: launcher.capabilities({}) });
  launcher.deliver = async () => { sends++; return uncertain('Lost response'); };
  await deliverAnswers(f.db, f.source.id, f.reference, host, launcher);
  const file = JSON.parse(await readFile(join(dirname(f.source.binding.resultPath), 'answers', `${q.id}.json`), 'utf8'));
  assert.equal(file.text, 'A');
  assert.equal(file.questionId, q.id);
  assert.equal(f.db.requests().find(r => r.operation === 'question.deliver.file')!.state, 'succeeded');
  assert.equal(f.db.requests().find(r => r.operation === 'question.deliver.message')!.state, 'uncertain');
  await deliverAnswers(f.db, f.source.id, f.reference, host, launcher);
  assert.equal(sends, 1);
  assert.equal(launcher.prompts.length, 0);
});

test('R21/A44: a lost file delivery response remains uncertain despite an existing answer file; no implicit retry', async t => {
  const f = await prepared(t);
  const q = await f.db.askQuestion(input, { kind: 'worker', attemptId: f.source.id }, 'question');
  await f.db.answerQuestion(q.id, 'A', person, command(person, 'question.answer', { questionId: q.id, text: 'A' }));
  const launcher = new FakeLauncher();
  launcher.inspect = async () => ({ status: 'known', sourceId: 'fake', sequence: 1, worker: 'active', turn: 'running', terminal: false, capabilities: launcher.capabilities({}) });
  let writes = 0;
  const lost: typeof deliverQuestionFile = async (path, answer) => {
    writes++;
    await deliverQuestionFile(path, answer);
    return uncertain('File write response lost');
  };
  await deliverAnswers(f.db, f.source.id, f.reference, host, launcher, lost);
  assert.equal(f.db.requests().find(r => r.operation === 'question.deliver.file')!.state, 'uncertain');
  assert.equal(JSON.parse(await readFile(join(dirname(f.source.binding.resultPath), 'answers', `${q.id}.json`), 'utf8')).text, 'A');
  await deliverAnswers(f.db, f.source.id, f.reference, host, launcher, lost);
  assert.equal(writes, 1);
});

test('R21/A44: worker becoming terminal between answer recording and delivery withdraws both channels without a send', async t => {
  const f = await prepared(t);
  const q = await f.db.askQuestion(input, { kind: 'worker', attemptId: f.source.id }, 'question');
  await f.db.answerQuestion(q.id, 'A', person, command(person, 'question.answer', { questionId: q.id, text: 'A' }));
  const launcher = new FakeLauncher();
  launcher.inspect = async () => ({ status: 'known', sourceId: 'fake', sequence: 1, worker: 'stopped', turn: 'ended', terminal: true, capabilities: launcher.capabilities({}) });
  launcher.deliver = async () => { assert.fail('Terminal worker cannot receive a message'); };
  await deliverAnswers(f.db, f.source.id, f.reference, host, launcher, async () => { assert.fail('Terminal worker cannot receive file delivery'); });
  assert.deepEqual(f.db.requests().filter(r => r.operation.startsWith('question.deliver.')).map(r => r.state), ['withdrawn', 'withdrawn']);
  assert.deepEqual(launcher.calls, []);
});

test('R21/A44: terminal observation withdraws late pending deliveries but preserves uncertain sends', async t => {
  const f = await prepared(t);
  const q = await f.db.askQuestion(input, { kind: 'worker', attemptId: f.source.id }, 'question');
  await f.db.answerQuestion(q.id, 'A', person, command(person, 'question.answer', { questionId: q.id, text: 'A' }));
  const message = f.db.requests().find(r => r.operation === 'question.deliver.message')!;
  const owner = f.db.claims().find(c => c.id === message.claimId)!;
  const executor = { claimId: owner.id, generation: owner.generation };
  await f.db.claimEffect(message.id, executor);
  await f.db.recordEffectOutcome(message.id, executor, 'uncertain', { reason: 'Lost send response' });
  const terminal = f.source.observation('terminal', 1);
  await f.db.recordWorkerObservation(terminal, host);
  assert.equal(f.db.request(message.id).state, 'uncertain');
  assert.equal(f.db.requests().find(r => r.operation === 'question.deliver.file')!.state, 'withdrawn');
  assert.equal(f.db.questions()[0]!.answer!.text, 'A');
  const events = f.db.events().filter(e => e.kind === 'request.withdrawn');
  assert.equal(events.length, 1);
  await f.db.recordWorkerObservation(terminal, host);
  assert.deepEqual(f.db.events().filter(e => e.kind === 'request.withdrawn'), events);
  const late = await f.db.askQuestion(input, { kind: 'worker', attemptId: f.source.id }, 'late');
  await f.db.answerQuestion(late.id, 'B', person, command(person, 'question.answer', { questionId: late.id, text: 'B' }));
  assert.ok(f.db.requests().filter(r => r.operation.startsWith('question.deliver.') && r.input.questionId === late.id)
    .every(r => r.state === 'withdrawn'));
});

test('R12/R21/A44: answer after terminal is retained for continuation, with withdrawn intents and no restart', async t => {
  const f = await prepared(t);
  const q = await f.db.askQuestion(input, { kind: 'worker', attemptId: f.source.id }, 'question');
  using sql = new DatabaseSync(f.path);
  sql.prepare('UPDATE attempts SET execution_open = 0 WHERE id = ?').run(f.source.id);
  const answered = await f.db.answerQuestion(q.id, 'B', person, command(person, 'question.answer', { questionId: q.id, text: 'B' }));
  assert.deepEqual(f.db.requests().filter(r => r.operation.startsWith('question.deliver.')).map(r => r.state), ['withdrawn', 'withdrawn']);
  assert.deepEqual(continuationHandover(f.db, f.source.id, head, false, null).answeredQuestions, [answered]);
  const launcher = new FakeLauncher();
  await deliverAnswers(f.db, f.source.id, f.reference, host, launcher);
  assert.deepEqual(launcher.calls, []);
});
