import { join, dirname } from 'node:path';
import { canonicalJson } from './configuration.ts';
import { runCandidateChecks } from './checks.ts';
import { checkEvidenceKey, mandatoryChecks } from './check-policy.ts';
import type { TrustedChecks } from './storage/reservations.ts';
import { uncertain, rejected } from './adapters/command.ts';
import type { CheckServices } from './checks.ts';
import { Database, StorageError } from './storage/database.ts';
import type { JsonObject, StoredEvent } from './storage/database.ts';
import type { AcceptInput, ReturnInput, FinalisationPlan } from './storage/completion.ts';
import type { Allocation } from './storage/reservations.ts';
import type { StoredRequest } from './storage/requests.ts';
import { readWorkerResult } from './storage/results.ts';
import { taskActor } from './storage/tasks.ts';
import type { GitRepository, RetentionRequest } from './adapters/repository.ts';
import type { Result } from './adapters/command.ts';
import { readFinalisationPolicy } from './adapters/finalisation.ts';

export interface ReturnWorkspace {
  inspect(allocation: Allocation): Promise<Result<{ state: 'matching' | 'absent' | 'mismatch' }>>;
  returnLease(allocation: Allocation, request: { authorised: true; requestId: string; retention: RetentionRequest }): Promise<Result<{ returned: true }>>;
}
export interface CompletionServices extends CheckServices {
  repository: CheckServices['repository'] & Pick<GitRepository, 'inspectRef' | 'compare' | 'verifyRetention' | 'conditionalFastForward' | 'conditionalDeleteRef' | 'command'>;
  workspace: ReturnWorkspace;
  readPolicy?: typeof readFinalisationPolicy;
}
const refuse = (message: string): never => { throw new StorageError('conflict', message); };
function known<T>(result: Result<T>): T {
  if (result.status !== 'confirmed') refuse(result.reason);
  return (result as { status: 'confirmed'; value: T }).value;
}
function exactCandidate(db: Database, input: AcceptInput): JsonObject {
  const candidate = db.attempt(input.attemptId).candidate;
  if (!candidate || candidate.id !== input.candidateId || candidate.commit !== input.commit) refuse('Exact candidate changed');
  return candidate!;
}
async function retainedOutput(db: Database, attemptId: string, services: CompletionServices): Promise<RetentionRequest> {
  const attempt = db.attempt(attemptId), binding = db.workerResultBinding(attemptId);
  const recorded = db.validatedWorkerResult(attemptId);
  if (!recorded) refuse('Validated retained output is required');
  const current = await readWorkerResult(binding);
  if (recorded!.digest !== current.digest || canonicalJson(recorded!.artefacts) !== canonicalJson(current.artefacts)) refuse('Validated output changed');
  const references = (current.content.workReferences as JsonObject[]).filter(item => item.kind === 'git')
    .map(item => ({ ref: String(item.branch), commit: String(item.commit) }));
  if (attempt.candidate && !references.some(item => item.commit === attempt.candidate!.commit)) {
    references.push({ ref: String(attempt.candidate.outputRef), commit: String(attempt.candidate.commit) });
  }
  const retention: RetentionRequest = { references,
    artefacts: [binding.resultPath, ...current.artefacts.map(item => join(dirname(binding.resultPath), String(item.relativePath)))],
    recyclableRoots: binding.recyclableRoots };
  known(await services.repository.verifyRetention(retention));
  return retention;
}
async function planAcceptance(db: Database, input: AcceptInput, services: CompletionServices): Promise<FinalisationPlan> {
  const attempt = db.attempt(input.attemptId), config = db.finalisationConfiguration();
  const recorded = attempt.specification.finalisation as JsonObject;
  const target = String(config.policy.targetBranch).startsWith('refs/') ? String(config.policy.targetBranch) : `refs/heads/${String(config.policy.targetBranch)}`;
  if (!['manual', 'local-merge'].includes(String(config.policy.kind))) refuse('Unknown finalisation policy');
  const targetState = known(await services.repository.inspectRef(target));
  if (targetState.state !== 'present') refuse('Finalisation target is absent');
  const expected = (targetState as { state: 'present'; commit: string }).commit;
  const policy = known(await (services.readPolicy ?? readFinalisationPolicy)(services.repository, expected, target, config.policy, recorded));
  if (config.policy.kind === 'local-merge' && (policy.protected || policy.forbidden)) refuse('Protected target or finalisation policy refuses local-merge');
  return { kind: config.policy.kind as FinalisationPlan['kind'], target, expected, policyDigest: policy.digest };
}

export async function selectCandidate(db: Database, input: { attemptId: string; commit: string; caller: AcceptInput['caller'] }, services: CompletionServices) {
  input = structuredClone(input);
  const attempt = db.attempt(input.attemptId), ref = String(attempt.specification.outputRef);
  const state = known(await services.repository.inspectRef(ref));
  if (state.state !== 'present' || state.commit !== input.commit) refuse('Selected branch is not at the exact candidate');
  await retainedOutput(db, input.attemptId, services);
  known(await services.repository.verifyRetention({ references: [{ ref, commit: input.commit }], artefacts: [],
    recyclableRoots: db.workerResultBinding(input.attemptId).recyclableRoots }));
  return db.selectRetainedCandidate(input.attemptId, input.commit, ref, input.caller);
}

/** Every mutation has durable intent. A lost response is reconciled by owner reads, never another call. */
async function effect(db: Database, authorisation: StoredEvent, operation: 'integrate' | 'return' | 'cleanup', input: JsonObject,
  reconcile: () => Promise<JsonObject | null>, call: () => Promise<Result<unknown>>, preflight: () => Promise<void> = async () => {}): Promise<StoredRequest> {
  const admission = await db.beginCompletionEffect(authorisation, operation, input);
  let request = admission.request;
  if (request.state === 'succeeded') return request;
  if (request.state === 'claimed' || request.state === 'uncertain') {
    const proof = await reconcile();
    if (proof) return db.settleCompletionEffect(request.id, { confirmed: true, ...proof });
    refuse('Interrupted effect remains unresolved; it will not be repeated');
  }
  if (request.state !== 'pending') refuse('Completion effect was refused; a new decision is required');
  try { await preflight(); }
  catch (error) {
    await db.closePendingEffect(request.id, 'rejected', { reason: String(error), called: false }, request.caller);
    throw error;
  }
  await db.refreshClaim(admission.executor, new Date().toISOString(), request.caller);
  request = await db.claimEffect(request.id, admission.executor);
  let result: Result<unknown>;
  try { result = await call(); }
  catch { result = uncertain('Completion owner call was interrupted'); }
  request = await db.recordEffectOutcome(request.id, admission.executor,
    result.status === 'confirmed' ? 'succeeded' : result.status === 'rejected' ? 'rejected' : 'uncertain',
    JSON.parse(JSON.stringify(result)) as JsonObject);
  if (request.state !== 'succeeded') refuse('Completion effect did not succeed; output is retained');
  return request;
}

export async function acceptCandidate(db: Database, input: AcceptInput, services: CompletionServices) {
  input = structuredClone(input);
  taskActor(input.caller);
  exactCandidate(db, input);
  if (input.overrideReason !== undefined && !input.overrideReason.trim()) throw new TypeError('Expected nonblank override reason');
  const command = await db.recordCommand({ requestKey: input.requestKey, operation: 'attempt.accept', caller: input.caller,
    fingerprint: canonicalJson(input), input: JSON.parse(JSON.stringify(input)) as JsonObject });
  let accepted = db.acceptance(input.attemptId, input.candidateId);
  if (!accepted) {
    await retainedOutput(db, input.attemptId, services);
    const config = db.finalisationConfiguration();
    let checks = input.overrideReason === undefined ? await runCandidateChecks(db, input.attemptId, input.caller, services) : null;
    if (checks && checks.state === 'rejected') {
      checks = db.requests().findLast(request => request.operation === 'checks.run' && request.attemptId === input.attemptId
        && request.input.evidenceKey === checks!.input.evidenceKey && request.state === 'succeeded') ?? checks;
    }
    const plan = await planAcceptance(db, input, services);
    if (checks) {
      const checkConfig = db.checkConfiguration(), attempt = db.attempt(input.attemptId);
      const current = await services.repository.readCheckPolicy(plan.target, checkConfig.checks);
      const key = checkEvidenceKey(attempt.specification.repository as JsonObject, input.commit,
        attempt.specification.criteria as string[], mandatoryChecks(attempt.specification.checks as TrustedChecks, current), services.profile);
      if (checks.input.evidenceKey !== key) refuse('Mandatory check policy changed before acceptance');
    }
    accepted = await db.recordAcceptance(input, command.id, plan, checks, config);
  }
  const plan = accepted.payload.plan as FinalisationPlan;
  if (plan.kind === 'local-merge') {
    const proof = async (): Promise<JsonObject | null> => {
      const target = known(await services.repository.inspectRef(plan.target));
      return target.state === 'present' && known(await services.repository.compare(input.commit, target.commit))
        ? { target: plan.target, commit: input.commit, observedTarget: target.commit } : null;
    };
    await effect(db, accepted, 'integrate', { ...plan, commit: input.commit }, proof, async () => {
      const target = known(await services.repository.inspectRef(plan.target));
      if (target.state !== 'present') return rejected('Target is absent');
      if (target.commit !== plan.expected) return rejected('Target moved after planning');
      if (known(await services.repository.compare(input.commit, target.commit))) return { status: 'confirmed', value: { alreadyContains: true, target: plan.target, commit: input.commit } };
      return services.repository.conditionalFastForward(plan.target, plan.expected, input.commit);
    }, async () => {
      await retainedOutput(db, input.attemptId, services);
      const current = await planAcceptance(db, input, services);
      if (current.target !== plan.target || current.kind !== plan.kind || current.policyDigest !== plan.policyDigest) refuse('Finalisation policy changed after acceptance');
      if (current.expected !== plan.expected) refuse('Target moved after planning');
    });
  }
  return db.finishAcceptance(accepted);
}

/** Return and discard share the same conditional lease effect; neither acceptance nor discard returns it implicitly. */
export async function returnAttempt(db: Database, input: ReturnInput, services: CompletionServices) {
  input = structuredClone(input);
  taskActor(input.caller);
  const command = await db.recordCommand({ requestKey: input.requestKey, operation: input.discard ? 'attempt.discard' : 'attempt.return',
    caller: input.caller, fingerprint: canonicalJson(input), input: JSON.parse(JSON.stringify(input)) as JsonObject });
  const authorisation = await db.authoriseReturn(input, command.id);
  const allocation = authorisation.payload.allocation as Allocation;
  // Once returned, the workspace is recyclable and must not be read again.
  if (db.attempt(input.attemptId).leaseState !== 'returned') {
    const previous = db.requests().find(request => request.requestKey === `return:${input.attemptId}`);
    let retention: RetentionRequest | undefined;
    if (!previous || previous.state === 'pending') {
      retention = await retainedOutput(db, input.attemptId, services);
      if (known(await services.workspace.inspect(allocation)).state !== 'matching') refuse('Allocation does not match');
      const workspace = known(await services.repository.inspectWorkspace(allocation.path));
      if (!workspace.clean) refuse('Workspace has uncommitted or untracked work');
    }
    await effect(db, authorisation, 'return', { allocation }, async () =>
      known(await services.workspace.inspect(allocation)).state === 'absent' ? { leaseId: allocation.leaseId, returned: true } : null,
    () => services.workspace.returnLease(allocation, { authorised: true, requestId: `return:${input.attemptId}`, retention: retention! }));
    await db.finishReturn(authorisation);
  }
  await cleanupOutput(db, authorisation, services);
  return db.attempt(input.attemptId);
}

async function cleanupOutput(db: Database, authorisation: StoredEvent, services: CompletionServices): Promise<void> {
  const attemptId = authorisation.attemptId!, attempt = db.attempt(attemptId);
  const reference = (db.validatedWorkerResult(attemptId)?.content.workReferences as JsonObject[] | undefined)?.find(item => item.kind === 'git');
  const candidate = attempt.candidate ?? (reference ? { commit: reference.commit!, outputRef: reference.branch! } : null);
  if (!candidate) return;
  const accepted = attempt.candidate ? db.acceptance(attemptId, String(candidate.id)) : null;
  const plan = accepted?.payload.plan as FinalisationPlan | undefined;
  const integrated = plan?.kind === 'local-merge' && db.requests().some(request => request.requestKey === `integrate:${attemptId}:${String(candidate.id)}` && request.state === 'succeeded');
  if (!authorisation.payload.discard && !integrated) return;
  const ref = String(candidate.outputRef), commit = String(candidate.commit);
  try {
    await effect(db, authorisation, 'cleanup', { ref, commit }, async () =>
      known(await services.repository.inspectRef(ref)).state === 'absent' ? { ref, deleted: true } : null,
    async () => {
      const state = known(await services.repository.inspectRef(ref));
      if (state.state === 'absent') return { status: 'confirmed', value: { alreadyAbsent: true } };
      if (state.commit !== commit) return rejected('Output ref moved; it is preserved');
      if (integrated && !authorisation.payload.discard) {
        const target = known(await services.repository.inspectRef(plan!.target));
        if (target.state !== 'present' || !known(await services.repository.compare(commit, target.commit))) return rejected('Recorded target no longer retains output');
      }
      return services.repository.conditionalDeleteRef(ref, commit);
    });
  } catch {
    // A cleanup refusal or uncertainty is visible in its request, never a reversal of the confirmed return.
  }
}
