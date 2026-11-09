import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalJson, ConfigurationError } from './configuration.ts';
import { configureContext, initialiseContext, openContext } from './context.ts';
import type { ContextOptions, ContextSelector } from './context.ts';
import type { OperationDefinition } from './catalog.ts';
import { Database, StorageError, NoEligibleTaskError } from './storage/database.ts';
import type { JsonObject } from './storage/database.ts';
import type { Task, TaskActor, TaskDefinition } from './storage/tasks.ts';
import type { CommandInput } from './storage/requests.ts';
import { createRuntime } from './runtime.ts';
import type { Runtime } from './runtime.ts';
import { dispatch } from './dispatch.ts';
import { runChecks } from './checks.ts';
import { retainedOutput, acceptCandidate, selectCandidate, returnAttempt, planCandidateAcceptance, planAttemptReturn, automaticReturn, leaseReturnReason, OwnerReadError } from './completion.ts';
import { CommandFailure } from './response.ts';
import { rebaseAttempt, planAttemptRebase } from './rebase.ts';
import { known } from './operation-utils.ts';
import { step } from './plans.ts';
import { unknownProfile, UnknownProfileError } from './profiles.ts';
import { requestView } from './request-view.ts';
import { nextAction as action } from './next-action.ts';

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
function invalidResultAction(attemptId: string) {
  return action('attempt.continue', { sourceAttemptId: attemptId, sourceCommit: null, profile: null, note: null, dryRun: true },
    'Plan continuing from the retained output branch, or discard the attempt with attempt.discard.');
}
function attemptView(db: Database, id: string) {
  const attempt = db.attempt(id), preparation = db.requests().find(r => r.attemptId === id && r.operation === 'worker.prepare');
  return { ...attempt, identity: { databaseId: attempt.specification.databaseId, contextId: attempt.specification.contextId,
    taskId: attempt.taskId, attemptId: id, leaseId: attempt.allocation?.leaseId ?? null, sessionId: preparation?.input.sessionId ?? null },
    workerRef: preparation?.result?.reference ?? null, result: db.validatedWorkerResult(id),
    resultInvalid: db.invalidWorkerResult(id),
    nextAction: db.invalidWorkerResult(id) ? invalidResultAction(id) : null,
    terminalEvidence: db.events().filter(e => e.attemptId === id && e.kind === 'worker.observed' && e.payload.kind === 'terminal'),
    taskTransitionApplied: db.events().some(e => e.attemptId === id && e.kind === 'acceptance.finished'),
    acceptance: attempt.candidate ? db.acceptance(id, String(attempt.candidate.id)) : null,
    review: db.reviewEvidence(id),
    effects: db.requests().filter(r => r.attemptId === id && r.category === 'effect') };
}
function mapStorage(error: unknown, db: Database, requestKey: string): never {
  const request = db.requests().find(r => r.requestKey === requestKey);
  const data = request ? { requestId: requestKey, attemptId: request.attemptId } : {};
  if (error instanceof UnknownProfileError) throw new CommandFailure('invalid_input', { ...data, ...error.details });
  if (error instanceof NoEligibleTaskError) throw new CommandFailure('not_ready', { ...data, skippedTasks: error.skippedTasks });
  if (error instanceof ConfigurationError) throw error;
  if (error instanceof CommandFailure) throw new CommandFailure(error.code, { ...data, ...error.data }, error.nextAction);
  if (error instanceof OwnerReadError) throw new CommandFailure('owner_unknown', data);
  if (!(error instanceof StorageError)) throw new CommandFailure('internal_failure', data);
  const blockers = db.admissionBlockers();
  const message = error.message;
  if (error.code === 'request_input_mismatch') throw new CommandFailure('request_input_mismatch', data);
  if (message.includes('request') && (message.includes('fingerprint') || message.includes('different') || message.includes('match'))) throw new CommandFailure('request_input_mismatch', data);
  if (message.includes('Admission blocked')) throw new CommandFailure(blockers.some(b => 'claimId' in b) ? 'claim_unresolved' : 'effect_uncertain', { ...data, blockers });
  if (error.code === 'busy') throw new CommandFailure('storage_busy', data);
  if (error.code.startsWith('result_')) throw new CommandFailure(error.code as 'result_invalid',
    { ...data, message: error.message.slice(0, 1024) },
    request?.attemptId ? invalidResultAction(request.attemptId) : null);
  if (/capacity/iu.test(message)) throw new CommandFailure('capacity', data);
  if (/revision changed/iu.test(message)) throw new CommandFailure('task_changed', data);
  if (/eligible|ready/iu.test(message)) throw new CommandFailure('not_ready', data);
  if (/uncommitted|untracked|clean/iu.test(message)) throw new CommandFailure('workspace_dirty', data);
  if (/unresolved|Interrupted effect/iu.test(message)) throw new CommandFailure('effect_uncertain', data);
  if (/retained|output changed/iu.test(message)) throw new CommandFailure('not_retained', data);
  if (/candidate/iu.test(message)) throw new CommandFailure('candidate_missing', data);
  throw new CommandFailure('policy_refused', data);
}

export async function executeCoreOperation(operation: OperationDefinition, args: Record<string, unknown>, progress: (message: string) => void,
  selector: ContextSelector, requestKey: string = randomUUID(), options: OperationOptions = {}): Promise<Record<string, unknown>> {
  const caller = options.caller ?? { kind: 'person', id: String(userInfo().uid) };
  if (!operation.roles.includes(caller.kind)) throw new CommandFailure('person_required');
  if (operation.name === 'context.init') return initialiseContext(selector, { ...options, caller });
  if (operation.name === 'context.configure') return configureContext(selector, { ...options, caller, dryRun: args.dryRun === true });
  const context = await openContext(selector, { ...options, readOnly: !operation.mutates || args.dryRun === true });
  const db = context.database;
  const input = JSON.parse(JSON.stringify(args)) as JsonObject;
  const command: CommandInput = { requestKey, caller, operation: operation.name, input, fingerprint: canonicalJson(input) };
  let runtime: Runtime | undefined;
  const services = async () => runtime ??= await (options.runtime ?? createRuntime)(db, context.configuration.resolved, options.home);
  try {
    const id = String(args.taskId);
    switch (operation.name) {
      case 'profile.clear': return await db.clearProfile(String(args.profile), caller, Boolean(args.dryRun));
      case 'status.show': {
        const attempts = db.events().filter(e => e.kind === 'attempt.reserved').map(e => db.attempt(e.attemptId!));
        const tasks = db.tasks().map(t => {
          const ready = db.readyTasks().some(task => task.id === t.id);
          const problem = t.state === 'queued' ? unknownProfile(context.configuration.resolved, t.profile) : null;
          return { id: t.id, title: t.title, state: t.state, ready, holdReason: t.holdReason, blockedBy: t.blockerIds,
            reason: problem?.reason ?? t.holdReason ?? (ready ? 'Task is ready to dispatch.' : null),
            nextAction: problem ? action('task.show', { taskId: t.id }, 'Add the profile to the configuration, or change the task\'s profile.')
              : t.holdReason !== null ? action('task.show', { taskId: t.id }, 'Inspect the task hold before deciding how to proceed.')
              : ready ? action('attempt.dispatch', { taskId: t.id, profile: null, dryRun: true }, 'Plan dispatch of the ready task.') : null };
        }).filter(t => !args.attentionOnly || t.reason !== null);
        const requests = db.requests();
        const attentionAttempts = (await Promise.all(attempts.map(async a => {
          const checks = requests.filter(r => r.attemptId === a.id && r.operation === 'checks.run' && r.input.commit === a.candidate?.commit).at(-1);
          const checksState = String(checks?.result?.status ?? checks?.state ?? 'missing');
          const accepted = a.candidate ? db.acceptance(a.id, String(a.candidate.id)) !== null : false;
          const resolved = a.leaseState === 'returned' || db.task(a.taskId).state === 'done'
            || db.events().some(e => e.attemptId === a.id && e.kind === 'return.authorised' && e.payload.discard);
          const currentReturnReason = a.allocation && a.leaseState !== 'returned'
            ? await leaseReturnReason(db, a.id, caller, (await services()).completion) : null;
          const returnReason = currentReturnReason === 'Lease is ready to return.' && (resolved || a.candidate && !accepted)
            ? null : currentReturnReason;
          const invalidResult = db.invalidWorkerResult(a.id);
          const reason = (!resolved ? invalidResult?.message : null) ?? returnReason ?? (resolved ? null : ['failed', 'uncertain'].includes(checksState) ? `Candidate checks ${checksState}.`
            : a.candidate && !accepted ? 'Candidate is awaiting acceptance.'
            : a.leaseState === 'held' ? 'Lease is held.'
            : ['held', 'failed'].includes(a.outcome ?? '') ? `Attempt outcome is ${a.outcome}.` : null);
          const nextAction = invalidResult && !resolved ? invalidResultAction(a.id) : reason === null ? null
            : returnReason ? action('attempt.return', { attemptId: a.id, dryRun: true }, `Resolve the return condition (${returnReason}), then plan returning the lease.`)
            : checksState === 'failed' || checksState === 'uncertain' ? action('attempt.show', { attemptId: a.id }, 'Inspect check evidence before retrying or resolving uncertainty.')
            : a.candidate && !accepted ? action('attempt.accept', { attemptId: a.id, candidateCommit: a.candidate.commit, overrideReason: null, dryRun: true }, 'Inspect the acceptance plan for this candidate.')
            : action('attempt.show', { attemptId: a.id }, 'Inspect the attempt and lease before continuing or returning it.');
          return { id: a.id, taskId: a.taskId, number: a.number, phase: a.phase, outcome: a.outcome,
            leaseState: a.leaseState, candidateCommit: a.candidate?.commit ?? null, review: db.reviewEvidence(a.id), checksState, resultInvalid: invalidResult, reason, nextAction };
        }))).filter(a => !args.attentionOnly || a.reason !== null);
        const blockers = db.admissionBlockers();
        const claims = db.claims().filter(c => !c.releasedAt).map(c => {
          if (!args.attentionOnly) return c;
          const blocker = blockers.find(b => b.kind === 'claim' && b.claimId === c.id);
          return blocker ? { ...c, reason: `Claim heartbeat is ${blocker.reason}; ownership is unresolved.`,
            nextAction: action('claim.resolve', { claimId: c.id, confirmStopped: false, evidence: 'Owner inspection is required.', dryRun: true }, 'Inspect the exact owner and obtain stopped-owner evidence before resolving the claim.') } : null;
        }).filter(c => c !== null);
        const effects = requests.filter(r => r.category === 'effect' && ['claimed', 'uncertain'].includes(r.state)).map(r => !args.attentionOnly ? r : {
          ...r, reason: `Effect is ${r.state}; its external outcome needs reconciliation.`,
          nextAction: action('request.show', { requestId: r.requestKey }, 'Inspect the effect and its owner before resolving its outcome.') });
        const entries = [...tasks.map(value => ({ key: `task:${value.id}`, kind: 'task', value })),
          ...attentionAttempts.map(value => ({ key: `attempt:${value.id}`, kind: 'attempt', value })),
          ...claims.map(value => ({ key: `claim:${value.id}`, kind: 'claim', value })),
          ...effects.map(value => ({ key: `effect:${value.id}`, kind: 'effect', value }))];
        const page = paginate(entries, args.page as Page, entry => entry.key);
        const section = (kind: string) => page.items.filter(entry => entry.kind === kind).map(entry => entry.value);
        return { contextId: context.configuration.resolved.contextId, databaseId: context.databaseId,
          configurationRevision: context.configuration.revision, migrationState: 'current',
          limitedProfiles: db.limitedProfiles().map(item => ({ ...item, nextAction: action('profile.clear', { profile: item.profile, dryRun: true }, 'After the provider limit resets, ask a person to clear the profile.') })),
          capacity: { used: attempts.filter(a => a.executionOpen).length, limit: (context.configuration.resolved.limits as JsonObject).maxAttempts },
          tasks: { items: section('task'), next: page.next, total: tasks.length },
          attempts: { items: section('attempt'), next: page.next, total: attentionAttempts.length },
          claims: section('claim'), effects: section('effect'), page: { next: page.next, total: page.total },
          blockers: blockers.slice(0, (args.page as Page).limit).map(b => !args.attentionOnly ? b : { ...b,
            nextAction: b.kind === 'claim'
              ? action('claim.resolve', { claimId: b.claimId, confirmStopped: false, evidence: 'Owner inspection is required.', dryRun: true }, 'Inspect the exact owner and obtain stopped-owner evidence before resolving the claim.')
              : action('request.show', { requestId: db.request(b.requestId).requestKey }, 'Inspect the external owner before choosing an effect outcome and supplying evidence.') }),
          objectives: [], openPersonQuestions: [] };
      }
      case 'request.show': return requestView(db, db.requestByKey(String(args.requestId), caller));
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
      case 'checks.run': return await runChecks(db, { attemptId: String(args.attemptId), commit: String(args.commit),
        dryRun: Boolean(args.dryRun) }, caller, requestKey, (await services()).completion);
      case 'attempt.review': {
        const attemptId = String(args.attemptId);
        const previous = db.requests().find(r => r.requestKey === requestKey);
        if (previous && !args.dryRun) {
          // writeTask verifies the command fingerprint before returning its original value.
          return { task: await db.createReview(attemptId, {}, caller, command), steps: [] };
        }
        const source = db.reviewSource(attemptId);
        await retainedOutput(db, attemptId, (await services()).completion);
        const target: JsonObject = { sourceAttemptId: attemptId, candidateId: source.candidate!.id!,
          commit: source.candidate!.commit!, outputRef: source.candidate!.outputRef!, repository: source.specification.repository!,
          criteria: db.task(source.taskId).criteria, checkResults: db.requests().filter(r => r.attemptId === attemptId
            && r.operation === 'checks.run' && r.input.commit === source.candidate!.commit).map(r => ({ requestId: r.id, input: r.input, state: r.state, result: r.result })) };
        const steps = [step('task.review.create', attemptId, ['terminal', 'retained_candidate'])];
        if (args.dryRun) return { steps };
        return { task: await db.createReview(attemptId, target, caller, command), steps };
      }
      case 'attempt.continue': {
        const previous = db.requests().find(r => r.requestKey === requestKey);
        const taskId = previous ? previous.input.taskId as string | null : db.attempt(String(args.sourceAttemptId)).taskId;
        return await dispatch(db, { taskId, profile: args.profile as string | null, dryRun: Boolean(args.dryRun),
          sourceAttemptId: String(args.sourceAttemptId), sourceCommit: args.sourceCommit as string | null, note: args.note as string | null }, caller, requestKey, await services(), progress);
      }
      case 'attempt.dispatch': return await dispatch(db, args as unknown as Parameters<typeof dispatch>[1], caller, requestKey, await services(), progress);
      case 'attempt.stop': case 'attempt.steer': {
        const attemptId = String(args.attemptId), attempt = db.attempt(attemptId);
        const capabilities = (await services()).launcher.capabilities(attempt.specification.profile as JsonObject);
        if (operation.name === 'attempt.stop' && !capabilities.terminalFence) throw new CommandFailure('capability_missing', { attemptId });
        if (operation.name === 'attempt.steer') {
          if (!(args.mode === 'active' ? capabilities.activeSteering : capabilities.afterTurnMessage)) {
            throw new CommandFailure('capability_missing', { attemptId, mode: args.mode });
          }
          if (!attempt.executionOpen || db.workerStopRequested(attemptId)) throw new CommandFailure('launch_fenced', { attemptId });
        }
        await db.requestWorkerControl(command, Boolean(args.dryRun));
        const steps = attempt.executionOpen ? [step(operation.name === 'attempt.stop' ? 'worker.fence' : 'worker.deliver', attemptId,
          ['current_owner', 'launcher_capability'], true)] : [];
        return args.dryRun ? { steps } : { attempt: db.attempt(attemptId), steps };
      }
      case 'attempt.rebase': {
        const completion = (await services()).completion;
        const input = { requestKey, attemptId: String(args.attemptId), caller };
        const plan = await planAttemptRebase(db, input, completion);
        if (args.dryRun) return plan;
        return { attempt: await rebaseAttempt(db, input, completion), ...plan };
      }
      case 'attempt.accept': {
        const runtime = await services(), attemptId = String(args.attemptId);
        const attempt = db.attempt(attemptId);
        const selecting = args.candidateCommit !== null && attempt.candidate?.commit !== args.candidateCommit;
        if (!attempt.candidate && !selecting) throw new CommandFailure('candidate_missing', { attemptId });
        const accept = { requestKey, attemptId, candidateId: selecting ? 'planned-selection' : String(attempt.candidate!.id),
          commit: selecting ? String(args.candidateCommit) : String(attempt.candidate!.commit), caller,
          ...(args.overrideReason === null ? {} : { overrideReason: String(args.overrideReason) }) };
        const plan = await planCandidateAcceptance(db, accept, runtime.completion, selecting);
        if (args.dryRun) return plan;
        if (selecting) {
          const selected = await selectCandidate(db, { attemptId, commit: accept.commit, caller }, runtime.completion);
          accept.candidateId = String(selected.candidate!.id);
        }
        for (const entry of plan.steps) progress(entry.operation);
        await acceptCandidate(db, accept, runtime.completion);
        const leaseReturn = await automaticReturn(db, attemptId, caller, runtime.completion);
        return { attempt: leaseReturn.attempt, leaseReturn: { state: leaseReturn.state, reason: leaseReturn.reason }, ...plan };
      }
      case 'attempt.return': case 'attempt.discard': {
        const attemptId = String(args.attemptId), allocation = db.attempt(attemptId).allocation;
        if (operation.name === 'attempt.discard' && !args.confirmDiscard) throw new CommandFailure('discard_confirmation_required', { attemptId, leaseId: allocation?.leaseId });
        if (!allocation) throw new CommandFailure('policy_refused', { attemptId });
        const returns = { requestKey, attemptId, caller,
          ...(operation.name === 'attempt.discard' ? { discard: { leaseId: allocation.leaseId, confirmed: true as const, reason: String(args.reason) } } : {}) };
        const completion = (await services()).completion;
        if (returns.discard && !args.dryRun) {
          const leaseReturn = await automaticReturn(db, attemptId, caller, completion, returns.discard, requestKey);
          return { attempt: leaseReturn.attempt, leaseReturn: { state: leaseReturn.state, reason: leaseReturn.reason } };
        }
        const plan = await planAttemptReturn(db, returns, completion);
        if (args.dryRun) return plan;
        return { attempt: await returnAttempt(db, returns, completion), leaseReturn: { state: 'returned', reason: null }, ...plan };
      }
      case 'claim.resolve': {
        if (!args.confirmStopped) throw new CommandFailure('process_confirmation_required');
        const claim = db.claim(String(args.claimId));
        if (claim.role === 'worker_owner' && claim.attemptId) {
          const reference = db.requests().find(r => r.attemptId === claim.attemptId && r.operation === 'worker.prepare')?.result?.reference;
          if (reference) {
            const observation = await (await services()).launcher.inspect(reference as import('./storage/launch.ts').WorkerReference);
            if (observation.status === 'known' && !observation.terminal) throw new CommandFailure('owner_unresolved', { claimId: claim.id });
          }
        }
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
        } else if (['completion.pin', 'completion.move'].includes(request.operation)) {
          const ref = known(await runtime.repository.inspectRef(String(request.input.ref)));
          if (ref.state === 'present' && ref.commit === request.input.commit) ownerHappened = true;
        } else if (request.operation === 'completion.rebase' || request.operation === 'completion.attach') {
          const workspace = known(await runtime.repository.inspectWorkspace(String(request.input.workspace)));
          if (request.operation === 'completion.attach' && workspace.clean && workspace.branch === request.input.ref
            && workspace.head === request.input.commit) ownerHappened = true;
          // A detached HEAD alone cannot prove which interrupted rebase produced it.
        } else if (request.operation === 'completion.cleanup' || request.operation === 'completion.cleanup-pin') {
          const ref = known(await runtime.repository.inspectRef(String(request.input.ref)));
          if (ref.state === 'absent') ownerHappened = true;
        } else if (request.operation === 'completion.return' && request.attemptId) {
          const allocation = db.attempt(request.attemptId).allocation!;
          const inspected = known(await runtime.completion.workspace.inspect(allocation));
          if (inspected.state === 'absent') ownerHappened = true;
          if (inspected.state === 'mismatch') throw new CommandFailure('owner_unresolved');
        } else if (request.target?.kind === 'workspace' && request.attemptId) {
          const allocation = db.attempt(request.attemptId).allocation;
          // With no recorded allocation the owner cannot identify an exact lease.
          // Do not initialise Treehouse metadata just to query an empty pool, or
          // infer absence. The person's exact effect-scoped evidence is required.
          if (allocation) {
            const inspected = known(await runtime.completion.workspace.inspect(allocation));
            if (inspected.state === 'matching') ownerHappened = true;
            if (inspected.state === 'mismatch') throw new CommandFailure('owner_unresolved');
          }
        } else if (request.target?.kind === 'worker') {
          const reference = db.requests().find(r => r.attemptId === request.attemptId && r.operation === 'worker.prepare')?.result?.reference ?? request.target.reference;
          const observation = await runtime.launcher.inspect(reference as import('./storage/launch.ts').WorkerReference);
          if (observation.status === 'known' && !observation.terminal) throw new CommandFailure('owner_unresolved', { effectId: request.id });
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
