import { defer } from './cleanup.ts';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database, applicationId } from '../../src/storage/database.ts';
import type { JsonObject } from '../../src/storage/database.ts';
import type { Allocation } from '../../src/storage/reservations.ts';
import type { WorkerHost, WorkerReference } from '../../src/storage/launch.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import type { ContextChecks, ExecutionProfile } from '../../src/check-policy.ts';
import { confirmed } from '../../src/adapters/command.ts';
import { prepareWorker, observeWorker } from '../../src/workers.ts';
import { FakeLauncher } from './fake-launcher.ts';

export const person = { kind: 'person' as const, id: 'operator' };
export const host: WorkerHost = { kind: 'host', id: 'backend', generation: 'generation-1' };
export const start = 'a'.repeat(40), head = 'b'.repeat(40);
export const profile: ExecutionProfile = { id: 'node-v1', tools: { node: '26.7.0' }, dependencies: { lock: 'digest' }, ignoredGeneratedPaths: ['generated'] };
export const contextChecks: ContextChecks = { executionProfile: profile.id, fast: [], full: [] };
export const policyContent = JSON.stringify({ version: 1,
  fast: [{ name: 'fast', command: ['fast'], timeoutMs: 1000 }],
  full: [{ name: 'full', command: ['full'], timeoutMs: 1000 }] });
export const retention = { compare: async () => confirmed(true), verifyRetention: async () => confirmed({ retained: true as const }) };

type TestContext = { after: (fn: () => Promise<void> | void) => void };
export async function checkFixture(t: TestContext, maximum = 1, piDiagnostics = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-checks-'));
  defer(t, () => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [join(root, 'pool')] }, retryMs: 1000, readOnly: false };
  const workerProfile = { launcher: piDiagnostics ? 'pi' : 'bb', provider: 'example', model: 'model', reasoning: null,
    runMs: 1000, maxCost: 0, maxTokens: null, executionProfile: profile.id };
  const db = await Database.initialise(path, { contextId: 'checks', repository: { identity: 'example' },
    stateDirectory: root, createdBy: person, configuration: { revision: 1, digest: 'test', provenance: {}, resolved: {
      version: 1, baseBranch: 'main', workspace: { adapter: 'treehouse', poolRoot: join(root, 'pool') },
      limits: { maxAttempts: 10, maxAttemptsPerTask: 3, maxConcurrentFullChecks: maximum }, profiles: { worker: workerProfile },
      defaultProfile: 'worker', profileByKind: { code: 'worker', report: 'worker', review: 'worker' },
      finalisation: { kind: 'manual', targetBranch: 'main', globalFile: null, forbid: [] }, checks: contextChecks,
    } } }, options);
  defer(t, () => db.close());
  const [claim] = await db.registerClaims([{ resourceKey: 'dispatch', role: 'maintenance', generation: 'dispatch-1', ownerRef: person,
    schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], person);
  const executor = { claimId: claim!.id, generation: claim!.generation };
  async function attempt(name: string, criteria = ['Criterion'], workspacePath?: string, candidate = head, initial = start, recordedPolicy = policyContent, stage: 'prepared' | 'validated' | 'completed' = 'completed', kind: 'code' | 'report' = 'code') {
    await db.addTask({ id: name, title: name, kind, criteria }, person);
    const reservation = await db.reserveAttempt({ requestKey: `dispatch:${name}`, taskId: name, caller: person, startingCommit: initial,
      checks: parseCheckPolicy(initial, recordedPolicy, contextChecks),
      delivery: { kind, acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } });
    const id = reservation.attempt.id;
    const acquisition = await db.beginWorkspaceAcquisition(id, reservation.requestId, executor, person);
    const input = acquisition.effect.input, workspace = input.workspace as JsonObject;
    const allocation: Allocation = { leaseId: `lease:${name}`, holder: workspace.holder as JsonObject,
      path: workspacePath ?? join(String(workspace.pool), name), pool: String(workspace.pool), repository: input.repository as JsonObject,
      outputRef: String(input.outputRef), startingCommit: initial };
    await db.recordAllocation(id, acquisition.effect.id, executor, allocation);
    await db.startAttempt(id, person);
    const launcher = new FakeLauncher();
    if (piDiagnostics) launcher.afterPrepare = async reference => confirmed({ ...reference,
      directory: join(root, 'workers', `owner-${id}`),
      sessionFile: join(root, 'workers', `owner-${id}`, 'sessions', 'session.jsonl') });
    const preparation = await prepareWorker(db, id, host, launcher);
    const reference = preparation.result!.reference as WorkerReference;
    await db.decideWorkerLaunch(id, preparation.claimId!, 'permit', host);
    const binding = db.workerResultBinding(id);
    const result = { version: 1, identity: binding.identity, startingCommit: initial, outputRef: binding.outputRef,
      outcome: 'completed', summary: 'Implemented', reason: null,
      criteriaReport: criteria.map((criterion, index) => ({ position: index + 1, criterion, status: 'met', evidence: 'Tested' })),
      evidence: [], workReferences: kind === 'code' ? [{ kind: 'git', name: 'code', branch: binding.outputRef, commit: candidate }]
        : [{ kind: 'artefact', name: 'report', path: join('artefacts', 'report.txt'), description: 'Retained report' }] };
    await mkdir(dirname(binding.resultPath), { recursive: true });
    if (kind === 'report') {
      await mkdir(join(dirname(binding.resultPath), 'artefacts'), { recursive: true });
      await writeFile(join(dirname(binding.resultPath), 'artefacts', 'report.txt'), 'Report evidence');
    }
    await writeFile(binding.resultPath, JSON.stringify(result));
    const observation = (kind: 'terminal' | 'result_available', sequence: number) => ({ sourceId: name, sourceSequence: sequence,
      attemptId: id, workerRef: reference, observedAt: new Date().toISOString(), kind, payloadVersion: 1 as const,
      payload: kind === 'terminal' ? (piDiagnostics ? { directChildExited: true } : { terminal: true, laterTurnsRefused: true }) : {} });
    if (stage !== 'prepared') await observeWorker(db, observation('result_available', 1), host, retention);
    if (stage === 'completed') await observeWorker(db, observation('terminal', 2), host, retention);
    return { id, allocation, binding, observation };
  }
  return { db, root, path, options, attempt };
}
