import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from './configuration.ts';
import { initialiseContext, openContext } from './context.ts';
import type { ContextOptions, ContextSelector } from './context.ts';
import type { OperationDefinition } from './catalog.ts';
import { Database, StorageError } from './storage/database.ts';
import type { JsonObject } from './storage/database.ts';
import type { Task, TaskActor, TaskDefinition } from './storage/tasks.ts';
import type { CommandInput } from './storage/requests.ts';
import { createRuntime } from './runtime.ts';
import type { Runtime } from './runtime.ts';
import { dispatch } from './dispatch.ts';
import { acceptCandidate, selectCandidate, returnAttempt, planCandidateAcceptance, planAttemptReturn } from './completion.ts';
import { CommandFailure } from './response.ts';
import { known } from './operation-utils.ts';
import { step } from './plans.ts';

export interface OperationOptions extends ContextOptions {
  runtime?: typeof createRuntime;
  /** Trusted host input only. Never read from operation args. */
  caller?: TaskActor;
}
type Page = { after: string | null; limit: number };
function paginate<T>(items: T[], page: Page, key: (value: T) => string) {
  const index = page.after === null ? 0 : items.findIndex(item => key(item) === page.after) + 1;
  if (page.after !== null && index === 0) throw new CommandFailure('invalid_input');
  const selected = items.slice(index, index + page.limit);
  return { items: selected, next: index + selected.length < items.length ? key(selected.at(-1)!) : null, total: items.length };
}
function taskView(db: Database, task: Task) {
  return { ...task, blockedBy: task.blockerIds, ready: db.readyTasks().some(t => t.id === task.id) };
}
function attemptView(db: Database, id: string) {
  const attempt = db.attempt(id), preparation = db.requests().find(r => r.attemptId === id && r.operation === 'worker.prepare');
  return { ...attempt, identity: { databaseId: attempt.specification.databaseId, contextId: attempt.specification.contextId,
    taskId: attempt.taskId, attemptId: id, leaseId: attempt.allocation?.leaseId ?? null, sessionId: preparation?.input.sessionId ?? null },
    workerRef: preparation?.result?.reference ?? null, result: db.validatedWorkerResult(id),
    terminalEvidence: db.events().filter(e => e.attemptId === id && e.kind === 'worker.observed' && e.payload.kind === 'terminal'),
    taskTransitionApplied: db.events().some(e => e.attemptId === id && e.kind === 'acceptance.finished'),
    acceptance: attempt.candidate ? db.acceptance(id, String(attempt.candidate.id)) : null,
    effects: db.requests().filter(r => r.attemptId === id && r.category === 'effect') };
}
function mapStorage(error: unknown, db: Database, requestKey: string): never {
  if (!(error instanceof StorageError)) throw error;
  const request = db.requests().find(r => r.requestKey === requestKey);
  const data = request ? { requestId: requestKey, attemptId: request.attemptId } : {};
  const blockers = db.admissionBlockers();
  const message = error.message;
  if (error.code === 'request_input_mismatch') throw new CommandFailure('request_input_mismatch', data);
  if (message.includes('request') && (message.includes('fingerprint') || message.includes('different') || message.includes('match'))) throw new CommandFailure('request_input_mismatch', data);
  if (message.includes('Admission blocked')) throw new CommandFailure(blockers.some(b => 'claimId' in b) ? 'claim_unresolved' : 'effect_uncertain', { ...data, blockers });
  if (error.code === 'busy') throw new CommandFailure('storage_busy', data);
  if (error.code.startsWith('result_')) throw new CommandFailure(error.code as 'result_invalid', data);
  if (/capacity/iu.test(message)) throw new CommandFailure('capacity', data);
  if (/revision changed/iu.test(message)) throw new CommandFailure('task_changed', data);
  if (/eligible|ready/iu.test(message)) throw new CommandFailure('not_ready', data);
  if (/uncommitted|untracked|clean/iu.test(message)) throw new CommandFailure('workspace_dirty', data);
  if (/passing checks/iu.test(message)) throw new CommandFailure('check_failed', data);
  if (/unresolved|Interrupted effect/iu.test(message)) throw new CommandFailure('effect_uncertain', data);
  if (/retained|output changed/iu.test(message)) throw new CommandFailure('not_retained', data);
  if (/candidate/iu.test(message)) throw new CommandFailure('candidate_missing', data);
  throw new CommandFailure('policy_refused', data);
}

export async function executeCoreOperation(operation: OperationDefinition, args: Record<string, unknown>, progress: (message: string) => void,
  selector: ContextSelector, requestKey: string = randomUUID(), options: OperationOptions = {}): Promise<Record<string, unknown>> {
  if (operation.name === 'context.init') return initialiseContext(selector, options);
  const caller = options.caller ?? { kind: 'person', id: String(userInfo().uid) };
  if (!operation.roles.includes(caller.kind)) throw new CommandFailure('person_required');
  const context = await openContext(selector, { ...options, readOnly: !operation.mutates || args.dryRun === true });
  const db = context.database;
  const input = JSON.parse(JSON.stringify(args)) as JsonObject;
  const command: CommandInput = { requestKey, caller, operation: operation.name, input, fingerprint: canonicalJson(input) };
  let runtime: Runtime | undefined;
  const services = async () => runtime ??= await (options.runtime ?? createRuntime)(db, context.configuration.resolved, options.home);
  try {
    const id = String(args.taskId);
    switch (operation.name) {
      case 'status.show': {
        const attempts = db.events().filter(e => e.kind === 'attempt.reserved').map(e => db.attempt(e.attemptId!));
        const tasks = db.tasks().map(t => taskView(db, t)).filter(t => !args.attentionOnly || t.holdReason !== null || t.ready);
        return { contextId: context.configuration.resolved.contextId, databaseId: context.databaseId,
          configurationRevision: context.configuration.revision, migrationState: 'current',
          capacity: { used: attempts.filter(a => a.executionOpen).length, limit: (context.configuration.resolved.limits as JsonObject).maxAttempts },
          tasks: paginate(tasks, args.page as Page, t => t.id),
          attempts: paginate(attempts.filter(a => !args.attentionOnly || a.executionOpen || a.leaseState !== 'returned'), args.page as Page, a => a.id),
          claims: db.claims().filter(c => !c.releasedAt), effects: db.requests().filter(r => r.category === 'effect' && ['claimed', 'uncertain'].includes(r.state)),
          blockers: db.admissionBlockers(), objectives: [], openPersonQuestions: [] };
      }
      case 'task.show': return { task: taskView(db, db.task(id)) };
      case 'task.list': return paginate(db.tasks().map(t => taskView(db, t)).filter(t => (args.state === null || t.state === args.state) && (!args.readyOnly || t.ready)), args.page as Page, t => t.id);
      case 'task.add': return { task: await db.addTask({ ...(args.definition as Omit<TaskDefinition, 'objectiveId'>),
        ...(args.id === null ? {} : { id: String(args.id) }), objectiveId: args.objectiveId as string | null }, caller, command) };
      case 'task.update': return { task: await db.updateTaskDefinition(id, args.definition as Partial<TaskDefinition>, caller, command, Number(args.expectedRevision)) };
      case 'task.hold': return { task: await db.holdTask(id, String(args.reason), caller, command) };
      case 'task.release': return { task: await db.releaseTask(id, caller, command) };
      case 'task.block': return { task: await db.addBlocker(id, String(args.blockerId), caller, command) };
      case 'task.unblock': return { task: await db.removeBlocker(id, String(args.blockerId), caller, command) };
      case 'task.reorder': return { tasks: await db.reorderTasks(args.orderedTaskIds as string[], caller, command) };
      case 'task.done': return { task: await db.markTaskDone(id, caller, command) };
      case 'task.reopen': return { task: await db.reopenTask(id, caller, command) };
      case 'attempt.show': return attemptView(db, String(args.attemptId));
      case 'attempt.dispatch': return await dispatch(db, args as unknown as Parameters<typeof dispatch>[1], caller, requestKey, await services(), progress);
      case 'attempt.accept': {
        const runtime = await services(), attemptId = String(args.attemptId);
        let attempt = db.attempt(attemptId);
        if (args.candidateCommit !== null && attempt.candidate?.commit !== args.candidateCommit) {
          if (args.dryRun) throw new CommandFailure('candidate_moved', { attemptId });
          attempt = await selectCandidate(db, { attemptId, commit: String(args.candidateCommit), caller }, runtime.completion);
        }
        if (!attempt.candidate) throw new CommandFailure('candidate_missing', { attemptId });
        const accept = { requestKey, attemptId, candidateId: String(attempt.candidate.id), commit: String(attempt.candidate.commit), caller,
          ...(args.overrideReason === null ? {} : { overrideReason: String(args.overrideReason) }) };
        const plan = await planCandidateAcceptance(db, accept, runtime.completion);
        if (args.dryRun) return plan;
        for (const entry of plan.steps) progress(entry.operation);
        return { attempt: await acceptCandidate(db, accept, runtime.completion), ...plan };
      }
      case 'attempt.return': case 'attempt.discard': {
        const attemptId = String(args.attemptId), allocation = db.attempt(attemptId).allocation;
        if (!args.noProcesses) throw new CommandFailure('process_confirmation_required', { attemptId, leaseId: allocation?.leaseId });
        if (operation.name === 'attempt.discard' && !args.confirmDiscard) throw new CommandFailure('discard_confirmation_required', { attemptId, leaseId: allocation?.leaseId });
        if (!allocation) throw new CommandFailure('policy_refused', { attemptId });
        const returns = { requestKey, attemptId, caller, noProcesses: { leaseId: allocation.leaseId },
          ...(operation.name === 'attempt.discard' ? { discard: { leaseId: allocation.leaseId, confirmed: true as const, reason: String(args.reason) } } : {}) };
        const completion = (await services()).completion;
        const plan = await planAttemptReturn(db, returns, completion);
        if (args.dryRun) return plan;
        return { attempt: await returnAttempt(db, returns, completion), ...plan };
      }
      case 'claim.resolve': {
        if (!args.confirmStopped) throw new CommandFailure('process_confirmation_required');
        const claim = db.claim(String(args.claimId));
        const plan = { steps: claim.releasedAt ? [] : [step('claim.resolve', claim.id, ['person', 'stopped_owner', 'scoped_evidence'])], scope: { claimId: claim.id, generation: claim.generation, ownerRef: claim.ownerRef } };
        if (args.dryRun) return plan;
        return { claim: await db.resolveClaimByPerson(claim.id, String(args.evidence), caller, command), ...plan };
      }
      case 'effect.resolve': {
        if (!args.confirmStopped) throw new CommandFailure('process_confirmation_required');
        const request = db.request(String(args.effectId));
        // Reconciliation reads the specialised owner when that owner can still answer.
        // No negative inference is made from a heartbeat or a missing local worker owner.
        const runtime = await services();
        let ownerHappened: boolean | null = null;
        if (request.operation === 'completion.integrate') {
          const ref = known(await runtime.repository.inspectRef(String(request.input.target)));
          if (ref.state === 'present') ownerHappened = known(await runtime.repository.compare(String(request.input.commit), ref.commit)) ? true : null;
        } else if (request.operation === 'completion.cleanup') {
          const ref = known(await runtime.repository.inspectRef(String(request.input.ref)));
          if (ref.state === 'absent') ownerHappened = true;
        } else if (request.operation === 'completion.return' && request.attemptId) {
          const allocation = db.attempt(request.attemptId).allocation!;
          const inspected = known(await runtime.completion.workspace.inspect(allocation));
          if (inspected.state === 'absent') ownerHappened = true;
          if (inspected.state === 'mismatch') throw new CommandFailure('owner_unresolved');
        } else if (request.target?.kind === 'workspace') {
          known(await runtime.workspace.list());
        }
        if (ownerHappened !== null && ownerHappened !== (args.outcome === 'happened')) throw new CommandFailure('owner_unresolved');
        if (request.category !== 'effect' || !['claimed', 'uncertain'].includes(request.state)) {
          const replay = db.requests().find(r => r.requestKey === requestKey);
          if (!replay || replay.fingerprint !== command.fingerprint || canonicalJson(replay.caller) !== canonicalJson(caller)) throw new CommandFailure('effect_uncertain');
        }
        const plan = { steps: [step('effect.resolve', request.id, ['person', 'stopped_owner', 'scoped_evidence', 'owner_read_agrees'])], target: request.target };
        if (args.dryRun) return plan;
        return { effect: await db.resolveEffectByPerson(request.id, args.outcome === 'happened', String(args.evidence), caller, command), ...plan };
      }
      default: throw new CommandFailure('unknown_operation');
    }
  } catch (error) { mapStorage(error, db, requestKey); }
  finally { db.close(); }
}
