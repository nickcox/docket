import { canonicalJson } from './configuration.ts';
import { effect, known, retainedOutput } from './completion.ts';
import type { CompletionServices } from './completion.ts';
import { confirmed, rejected, uncertain } from './adapters/command.ts';
import { Database, StorageError } from './storage/database.ts';
import type { JsonObject, StoredEvent } from './storage/database.ts';
import { originalCandidateRef } from './storage/rebase.ts';
import { taskActor } from './storage/tasks.ts';
import type { TaskActor } from './storage/tasks.ts';
import { CommandFailure } from './response.ts';
import { step } from './plans.ts';

type RebaseInput = { requestKey: string; attemptId: string; caller: TaskActor };
const refuse = (message: string): never => { throw new StorageError('conflict', message); };
function progress(db: Database, input: RebaseInput): StoredEvent | undefined {
  const command = db.requests().find(r => r.requestKey === input.requestKey);
  if (command && (command.operation !== 'attempt.rebase' || command.fingerprint !== canonicalJson(input)
    || canonicalJson(command.caller) !== canonicalJson(input.caller))) throw new StorageError('request_input_mismatch', 'Request input differs');
  return command && db.events().find(e => e.sourceKey === `rebase.authorised:${command.id}`);
}
function replayUpstream(db: Database, attemptId: string, commit?: string): string {
  const attempt = db.attempt(attemptId);
  const previousRebase = db.events().findLast(e => e.attemptId === attemptId && e.kind === 'output.rebased'
    && (commit === undefined || e.payload.rebased === commit));
  if (previousRebase) return String(previousRebase.payload.target);
  const startingCommit = String(attempt.specification.startingCommit);
  const sourceAttemptId = attempt.specification.sourceAttemptId;
  return typeof sourceAttemptId === 'string' ? replayUpstream(db, sourceAttemptId) : startingCommit;
}
async function prerequisites(db: Database, input: RebaseInput, services: CompletionServices, plan?: JsonObject, detached = false, moved = false) {
  taskActor(input.caller);
  const attempt = db.attempt(input.attemptId), candidate = attempt.candidate, allocation = attempt.allocation;
  if (attempt.executionOpen || !attempt.outcome || !candidate || !allocation || attempt.leaseState !== 'held'
    || !db.events().some(e => e.attemptId === attempt.id && e.kind === 'worker.observed' && e.payload.kind === 'terminal')) refuse('Rebase requires a terminal candidate and held lease');
  if (db.events().some(e => e.attemptId === attempt.id && e.kind === 'candidate.accepted')) refuse('An accepted candidate cannot be rebased');
  if (plan && (candidate!.id !== plan.candidateId || candidate!.commit !== plan.original)) refuse('Exact candidate changed');
  const command = db.requests().find(r => r.requestKey === input.requestKey);
  const unresolved = db.requests().find(r => r.attemptId === attempt.id && (r.category === 'effect' || r.operation === 'checks.run')
    && (['claimed', 'uncertain'].includes(r.state) || (r.state === 'pending' && (!plan || r.parentId !== command?.id))));
  if (unresolved) refuse('Attempt has an unresolved effect');
  if (known(await services.workspace.inspect(allocation!, detached ? String(plan!.rebased) : undefined)).state !== 'matching') refuse('Allocation does not match');
  await retainedOutput(db, attempt.id, services, moved ? String(plan!.rebased) : undefined);
  const config = db.finalisationConfiguration();
  const targetRef = String(config.policy.targetBranch).startsWith('refs/') ? String(config.policy.targetBranch) : `refs/heads/${String(config.policy.targetBranch)}`;
  const target = known(await services.repository.inspectRef(targetRef));
  if (target.state !== 'present') throw new StorageError('conflict', 'Target is absent');
  if (plan && (plan.targetRef !== targetRef || plan.target !== target.commit)) refuse('Target moved after planning');
  if (command && db.requests().some(r => r.parentId === command.id && r.operation === 'completion.pin' && r.state === 'succeeded')) {
    const pin = known(await services.repository.inspectRef(String(plan!.pinnedRef)));
    if (pin.state !== 'present' || pin.commit !== plan!.pinnedCommit) refuse('Original candidate is not retained by the pinned ref');
  }
  const outputRef = String(candidate!.outputRef), original = String(candidate!.commit);
  const upstream = replayUpstream(db, attempt.id, original);
  const output = known(await services.repository.inspectRef(outputRef));
  const workspace = known(await services.repository.inspectWorkspace(allocation!.path));
  if (!workspace.clean) refuse('Workspace has uncommitted or untracked work');
  if (output.state !== 'present' || output.commit !== (moved ? plan!.rebased : original)
    || workspace.head !== (detached ? plan!.rebased : original) || workspace.branch !== (detached ? null : outputRef)) refuse('Workspace or output branch is not at the exact candidate');
  if (!known(await services.repository.compare(upstream, original))) refuse('Candidate must descend from the rebase upstream');
  const common = await services.repository.command(['merge-base', original, target.commit]);
  if (!common.complete || common.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(common.stdout.trim())) refuse('Candidate and target need a known common ancestor');
  const merges = await services.repository.command(['rev-list', '--merges', `${upstream}..${original}`]);
  if (!merges.complete || merges.code !== 0 || merges.stdout !== '') refuse('Attempt changes contain merge commits or cannot be read');
  const reference = (db.validatedWorkerResult(attempt.id)!.content.workReferences as JsonObject[]).find(r => r.kind === 'git');
  return { candidateId: candidate!.id!, original, upstream, target: target.commit, targetRef, outputRef,
    workspace: allocation!.path, pinnedRef: originalCandidateRef(attempt.specification), pinnedCommit: String(reference?.commit ?? original) };
}
const stages = ['pin', 'rebase', 'move', 'attach'] as const;
export async function planAttemptRebase(db: Database, input: RebaseInput, services: CompletionServices) {
  taskActor(input.caller);
  db.checkAuthority(input.caller, 'attempt.rebase', { attemptId: input.attemptId });
  const authorised = progress(db, input);
  if (authorised && db.events().some(e => e.sourceKey === `output.rebased:${authorised.id}`)) return { steps: [] };
  const rebasing = authorised && db.requests().find(r => r.requestKey === `rebase:${input.attemptId}:${authorised.id}`);
  const moving = authorised && db.requests().find(r => r.requestKey === `move:${input.attemptId}:${authorised.id}`);
  const attaching = authorised && db.requests().find(r => r.requestKey === `attach:${input.attemptId}:${authorised.id}`);
  const commit = (rebasing?.result?.value as JsonObject | undefined)?.commit;
  const interrupted = authorised && db.requests().find(r => r.parentId === authorised.requestId && ['claimed', 'uncertain'].includes(r.state));
  if (interrupted) {
    let confirmedProgress = false;
    if (interrupted.operation === 'completion.pin' || interrupted.operation === 'completion.move') {
      const ref = known(await services.repository.inspectRef(String(interrupted.input.ref)));
      confirmedProgress = ref.state === 'present' && ref.commit === interrupted.input.commit;
    } else if (interrupted.operation === 'completion.attach') {
      const workspace = known(await services.repository.inspectWorkspace(String(interrupted.input.workspace)));
      confirmedProgress = workspace.clean && workspace.branch === interrupted.input.ref && workspace.head === interrupted.input.commit;
    }
    if (!confirmedProgress) refuse('Interrupted effect remains unresolved; it will not be repeated');
  } else if (!attaching || attaching.state !== 'succeeded') {
    await prerequisites(db, input, services, authorised ? { ...authorised.payload, rebased: commit ?? null } : undefined,
      rebasing?.state === 'succeeded', moving?.state === 'succeeded');
  }
  const remaining = stages.filter(stage => !authorised || !db.requests().some(r => r.requestKey === `${stage}:${input.attemptId}:${authorised.id}` && r.state === 'succeeded'));
  return { steps: [...remaining.map(stage => step(`rebase.${stage}`, input.attemptId, ['terminal', 'unaccepted_candidate', 'held_lease', 'clean_workspace', 'exact_candidate', 'known_ancestor', 'no_merges', 'no_unresolved_effect'])),
    step('candidate.record', input.attemptId, ['fresh_checks_and_review'])] };
}
export async function rebaseAttempt(db: Database, input: RebaseInput, services: CompletionServices) {
  input = structuredClone(input);
  taskActor(input.caller);
  let authorisation = progress(db, input);
  if (authorisation && db.events().some(e => e.sourceKey === `output.rebased:${authorisation!.id}`)) return db.attempt(input.attemptId);
  if (!authorisation) {
    const plan = await prerequisites(db, input, services);
    const command = await db.recordCommand({ requestKey: input.requestKey, operation: 'attempt.rebase', caller: input.caller, input, fingerprint: canonicalJson(input) });
    authorisation = await db.authoriseRebase(input.attemptId, command.id, input.caller, plan);
  }
  const p = authorisation.payload;
  const pinned = async () => { const ref = known(await services.repository.inspectRef(String(p.pinnedRef))); return ref.state === 'present' && ref.commit === p.pinnedCommit ? { ref: p.pinnedRef!, commit: p.pinnedCommit! } : null; };
  await effect(db, authorisation, 'pin', { ref: p.pinnedRef!, commit: p.pinnedCommit! }, pinned, async () => {
    const existing = known(await services.repository.inspectRef(String(p.pinnedRef)));
    if (existing.state === 'present') return existing.commit === p.pinnedCommit ? confirmed(existing) : rejected('Pinned ref moved; it is preserved');
    return services.repository.createPinnedRef(String(p.pinnedRef), String(p.pinnedCommit));
  }, async () => { await prerequisites(db, input, services, p); });
  let rebased;
  try {
    rebased = await effect(db, authorisation, 'rebase', { original: p.original!, upstream: p.upstream!, target: p.target!, workspace: p.workspace! }, async () => null,
      () => services.repository.prepareRebase(String(p.workspace), String(p.original), String(p.upstream), String(p.target)),
      async () => { await prerequisites(db, input, services, p); });
  } catch (error) {
    const request = db.requests().find(r => r.requestKey === `rebase:${input.attemptId}:${authorisation!.id}`);
    if (request?.state === 'rejected' && request.result?.reason === 'rebase_conflict') throw new CommandFailure('rebase_conflict');
    throw error;
  }
  const commit = String((rebased.result?.value as JsonObject | undefined)?.commit);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) refuse('Rebase effect needs exact commit evidence');
  const prepared = { ...p, rebased: commit };
  await effect(db, authorisation, 'move', { ref: p.outputRef!, original: p.original!, commit }, async () => {
    const state = known(await services.repository.inspectRef(String(p.outputRef)));
    return state.state === 'present' && state.commit === commit ? { ref: p.outputRef!, commit } : null;
  }, () => services.repository.conditionalMoveRef(String(p.outputRef), String(p.original), commit),
  async () => { await prerequisites(db, input, services, prepared, true); });
  const attached = async () => {
    const state = known(await services.repository.inspectWorkspace(String(p.workspace)));
    return state.clean && state.branch === p.outputRef && state.head === commit ? { commit } : null;
  };
  await effect(db, authorisation, 'attach', { ref: p.outputRef!, commit, workspace: p.workspace! }, attached, async () => {
    const result = await services.repository.command(['switch', '--quiet', String(p.outputRef).replace(/^refs\/heads\//, '')], String(p.workspace));
    return result.complete && result.code === 0 && await attached() ? confirmed({ commit }) : uncertain('Output branch restoration could not be confirmed');
  }, async () => { await prerequisites(db, input, services, prepared, true, true); });
  return db.finishRebase(authorisation, commit);
}
