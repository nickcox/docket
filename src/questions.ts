import type { Database } from './storage/database.ts';
import { questionInput } from './storage/questions.ts';
import { questionFiles, deliverQuestionFile } from './adapters/question-files.ts';
import type { Launcher } from './adapters/launcher.ts';
import type { WorkerHost, WorkerReference } from './storage/launch.ts';
import { canonicalJson } from './configuration.ts';
import { CommandFailure } from './response.ts';

export async function consumeQuestionFiles(db: Database, attemptId: string): Promise<void> {
  const preparation = db.requests().find(r => r.attemptId === attemptId && r.operation === 'worker.prepare');
  if (!preparation || typeof preparation.input.resultPath !== 'string') return;
  const reference = preparation.result?.reference as WorkerReference | undefined;
  if (reference?.launcher !== 'pi') return;
  const prefix = `question.file:${attemptId}:`;
  const consumed = new Set(db.events().filter(e => e.sourceKey.startsWith(prefix)).map(e => e.sourceKey.slice(prefix.length)));
  for (const file of await questionFiles(preparation.input.resultPath, consumed)) {
    const sourceKey = `${prefix}${file.name}`;
    if (db.events().some(e => e.sourceKey === sourceKey)) continue;
    try { if (file.invalid) throw new TypeError('Invalid file'); questionInput(file.value); }
    catch { await db.questionDiagnostic(attemptId, sourceKey); continue; }
    await db.askQuestion(file.value, { kind: 'worker', attemptId }, sourceKey);
  }
}

export async function deliverAnswers(db: Database, attemptId: string, reference: WorkerReference, host: WorkerHost, launcher: Launcher,
  fileDelivery: typeof deliverQuestionFile = deliverQuestionFile): Promise<void> {
  const owner = db.claims().find(c => c.attemptId === attemptId && c.role === 'worker_owner' && !c.releasedAt);
  if (!owner || canonicalJson(owner.ownerRef) !== canonicalJson(host)) throw new CommandFailure('owner_unresolved');
  const executor = { claimId: owner.id, generation: host.generation };
  for (const effect of db.requests().filter(r => r.attemptId === attemptId && r.operation.startsWith('question.deliver.'))) {
    if (effect.state !== 'pending') continue;
    const observation = await launcher.inspect(reference);
    if (observation.status !== 'known') continue;
    if (observation.terminal || !db.attempt(attemptId).executionOpen) {
      await db.closePendingEffect(effect.id, 'withdrawn', { reason: 'Worker terminal; answer retained for continuation.' }, effect.caller);
      continue;
    }
    await db.claimEffect(effect.id, executor);
    try {
      db.checkAuthority(effect.caller as import('./storage/tasks.ts').TaskActor, 'question.answer', { attemptId });
      const result = effect.operation === 'question.deliver.file'
        ? await fileDelivery(String(effect.input.resultPath), effect.input)
        : await launcher.deliver(reference, `Answer to question ${String(effect.input.questionId)}: ${String(effect.input.text)}`, 'active_steering', effect.id);
      await db.recordEffectOutcome(effect.id, executor, result.status === 'confirmed' ? 'succeeded' : result.status === 'rejected' ? 'rejected' : 'uncertain',
        JSON.parse(JSON.stringify(result)));
    } catch (error) {
      await db.recordEffectOutcome(effect.id, executor, 'uncertain', { reason: String(error) });
    }
  }
}
