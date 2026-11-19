import { isAbsolute, resolve } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commandRunner, confirmed, rejected, uncertain, type Runner, type Result } from './command.ts';
import type { Launcher, LauncherCapabilities, MessageMode, Usage, WorkerBinding, WorkerObservation } from './launcher.ts';
import type { JsonObject } from '../storage/database.ts';
import { redactDiagnostics } from './checks.ts';
import type { WorkerReference } from '../storage/launch.ts';

export interface BbExecutionProfile {
  executable: string;
  passEnvironment: string[];
  credentialVariable?: string;
  projectId?: string;
  machineId?: string;
}
export interface BbEvent { threadId: string; seq: number; type: string; data: JsonObject }
export interface BbOptions {
  profiles: Record<string, BbExecutionProfile>;
  repository?: string;
  environment?: NodeJS.ProcessEnv;
  run?: Runner;
  admission: (effectId: string) => boolean;
  observe?: (reference: WorkerReference, events: BbEvent[]) => Promise<void | 'later_turn'>;
  discrepancy?: (reference: WorkerReference) => Promise<void>;
  admissionMs?: number;
}
const capabilities: LauncherCapabilities = {
  preparation: 'protected', admission: true, activeSteering: true, afterTurnMessage: true,
  stopTurn: true, terminalFence: true, fenceEnforcement: 'best_effort', usageMetrics: ['tokens'],
  observationSources: ['bb_events'],
};
class BbIdentityMismatch extends Error {}
class BbRefusal extends Error {
  readonly evidence: JsonObject;
  constructor(evidence: JsonObject) { super('bb validation refusal'); this.evidence = evidence; }
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** CLI-only owner. Effects are attempted once; reads never repair or restart a thread. */
export class BbLauncher implements Launcher {
  private attempted = new Set<string>();
  private fenced = new Set<string>();
  private stopped = new Map<string, number>();
  private lastStart = new Map<string, number>();
  private options: BbOptions;
  constructor(options: BbOptions) {
    this.options = options;
    for (const profile of Object.values(options.profiles)) {
      if (!profile || Object.keys(profile).some(k => !['executable', 'passEnvironment', 'credentialVariable', 'projectId', 'machineId'].includes(k))
        || [profile.projectId, profile.machineId].some(id => id !== undefined && (typeof id !== 'string' || !/^[\w-]+$/.test(id)))
        || !isAbsolute(profile.executable) || !Array.isArray(profile.passEnvironment)
        || [...profile.passEnvironment, ...(profile.credentialVariable === undefined ? [] : [profile.credentialVariable])]
          .some(k => typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /^(DOCKET_|BB_)/.test(k))) {
        throw new TypeError('Invalid bb execution profile');
      }
    }
  }
  capabilities(profile: JsonObject): LauncherCapabilities {
    const supported = profile.launcher === 'bb' && Object.hasOwn(this.options.profiles, String(profile.executionProfile));
    return { ...structuredClone(capabilities), ...(supported ? {} : { preparation: 'unsupported', admission: false }) };
  }
  private async call(profileId: string, args: string[]): Promise<unknown> {
    const profile = this.options.profiles[profileId];
    if (!profile) throw new Error('Unknown bb execution profile');
    const host = this.options.environment ?? process.env, environment: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
      ...profile.passEnvironment, ...(profile.credentialVariable ? [profile.credentialVariable] : [])]) {
      if (!/^(DOCKET_|BB_)/.test(key) && host[key] !== undefined) environment[key] = host[key];
    }
    const result = await (this.options.run ?? commandRunner({ environment }))(profile.executable, args, process.cwd());
    if (!result.complete) throw new Error('bb response unavailable');
    const value: unknown = JSON.parse(result.stdout);
    // bb 0.49.0 thread-MZN2MO7V.js and chunk-U6DC65F7.js raise
    // missing_required before spawn/send. Generic ok:false and invalid_request
    // do not prove non-occurrence (chunk-ZE7UK6GW.js wraps remote failures).
    if (object(value) && value.ok === false && object(value.error)
      && args[0] === 'thread' && ['spawn', 'tell'].includes(args[1]!)
      && result.code === 1 && value.error.code === 'missing_required'
      && typeof value.error.message === 'string' && value.error.message.trim()) throw new BbRefusal(value);
    if (result.code !== 0 || (object(value) && value.ok === false)) throw new Error('bb response unavailable');
    return value;
  }
  private once(id: string): boolean {
    if (this.attempted.has(id)) return false;
    this.attempted.add(id); return true;
  }
  async prepare(binding: WorkerBinding, effectId: string): Promise<Result<WorkerReference>> {
    const profile = binding.specification.profile as JsonObject;
    if (!object(profile) || this.capabilities(profile).preparation === 'unsupported'
      || typeof binding.initialInput !== 'string' || !isAbsolute(binding.allocation.path)
      || !isAbsolute(binding.resultPath) || !['provider', 'model'].every(k => typeof profile[k] === 'string' && String(profile[k]).length > 0 && !String(profile[k]).startsWith('-'))) {
      return rejected('Invalid bb binding or profile', { neverStarted: true });
    }
    if (!this.once(effectId)) return uncertain('bb preparation already attempted');
    const executionProfile = String(profile.executionProfile);
    const execution = this.options.profiles[executionProfile]!;
    let projectId = execution.projectId;
    const nextAction = 'Run bb project create --name <name> --root <repository> --machine <machine>, or set projectId in the bb execution profile';
    if (!projectId) {
      if (!this.options.repository || !execution.machineId) return rejected('Configure the local machineId in the bb execution profile for project lookup', { neverStarted: true, nextAction });
      try {
        const projects = await this.call(executionProfile, ['project', 'list', '--json']);
        if (!Array.isArray(projects) || projects.some(p => !object(p) || typeof p.id !== 'string' || !Array.isArray(p.sources))) throw new Error();
        const repository = await realpath(this.options.repository);
        const matches = [];
        for (const project of projects) {
          if (project.kind === 'personal') continue;
          for (const source of project.sources) {
            if (!object(source) || source.type !== 'local_path' || source.hostId !== execution.machineId
              || typeof source.path !== 'string' || !isAbsolute(source.path)) continue;
            let path: string;
            try { path = await realpath(source.path); } catch { continue; }
            if (resolve(path) === resolve(repository)) { matches.push(project); break; }
          }
        }
        if (matches.length !== 1) return rejected('Expected exactly one bb project linked to the backing repository on this machine',
          { neverStarted: true, matches: matches.map(p => p.id), repository: this.options.repository, nextAction });
        projectId = matches[0].id;
      } catch { return rejected('Cannot read bb projects; no thread created', { neverStarted: true, nextAction }); }
    }
    try {
      const ready = await this.call(executionProfile, ['docket', 'ready', projectId!]);
      if (!object(ready) || ready.version !== 1 || ready.ready !== true) throw new Error();
    } catch {
      return rejected('Docket bb plugin is not ready', { neverStarted: true,
        nextAction: `Add ${projectId} to the Docket plugin's projects setting and check its executable and binding settings` });
    }
    try {
      await mkdir(dirname(binding.resultPath), { recursive: true, mode: 0o700 });
      await mkdir(join(dirname(binding.resultPath), 'artefacts'), { recursive: true, mode: 0o700 });
      await mkdir(join(dirname(binding.resultPath), 'questions'), { recursive: true, mode: 0o700 });
    } catch { return rejected('Cannot prepare retained result directories', { neverStarted: true }); }
    try {
      // Inline argv preserves trailing newlines; --prompt-file strips them in bb 0.49.0.
      const args = ['thread', 'spawn', '--json', '--project', projectId!, '--provider', String(profile.provider), '--model', String(profile.model),
        '--environment', binding.allocation.path, '--prompt', binding.initialInput];
      if (execution.machineId) args.push('--machine', execution.machineId);
      if (typeof profile.reasoning === 'string') args.push('--reasoning-level', profile.reasoning);
      const value = await this.call(executionProfile, args);
      if (!object(value) || typeof value.id !== 'string' || !/^thr_[\w-]+$/.test(value.id)) throw new Error();
      return confirmed({ launcher: 'bb', threadId: value.id, executionProfile, provider: String(profile.provider),
        model: String(profile.model), projectId: projectId!, path: binding.allocation.path, sessionId: binding.sessionId, resultPath: binding.resultPath });
    } catch (error) {
      if (error instanceof BbRefusal) return rejected('bb refused creation before creating a thread', error.evidence);
      return uncertain('bb create response lost or unreadable', { effectId, sessionId: binding.sessionId });
    }
  }
  async activate(reference: WorkerReference, _input: JsonObject, effectId: string, _generation: string): Promise<Result<JsonObject>> {
    if (!this.once(effectId)) return uncertain('bb activation already attempted', reference);
    try {
      if (this.options.admission(effectId)) return confirmed({ admitted: true });
      const view = await this.view(reference);
      if (view.environment?.path === null) return rejected('bb environment is detached');
      if (view.thread.providerId !== reference.provider
        || (view.thread.projectId !== undefined && view.thread.projectId !== reference.projectId)
        || (view.environment !== null && view.environment.path !== reference.path)) return rejected('bb execution identity changed');
      const queue = await this.call(String(reference.executionProfile), ['thread', 'queue', 'list', String(reference.threadId), '--json']);
      if (Array.isArray(queue) && queue.length === 0) {
        return this.options.admission(effectId) ? confirmed({ admitted: true })
          : uncertain('bb held prompt absent without recorded admission', reference);
      }
      if (!Array.isArray(queue) || queue.length !== 1 || !object(queue[0])) {
        return uncertain('bb held prompt could not be verified', reference);
      }
      if (queue[0].model !== reference.model) return rejected('bb held prompt model differs');
      const reply = await this.call(String(reference.executionProfile), ['docket', 'recheck', String(reference.threadId)]);
      if (!object(reply) || reply.requested !== true || reply.threadId !== reference.threadId) throw new Error();
      const deadline = Date.now() + (this.options.admissionMs ?? 5000);
      do {
        if (this.options.admission(effectId)) return confirmed({ admitted: true });
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      return uncertain('bb admission not recorded', reference);
    } catch (error) {
      if (error instanceof BbIdentityMismatch) return rejected('bb execution identity changed');
      return uncertain('bb activation response lost or unreadable', reference);
    }
  }
  private async view(reference: WorkerReference): Promise<{ thread: JsonObject; environment: JsonObject | null }> {
    const value = await this.call(String(reference.executionProfile), ['thread', 'show', String(reference.threadId), '--json']);
    if (object(value) && object(value.thread) && typeof value.thread.id === 'string'
      && value.thread.id !== reference.threadId) throw new BbIdentityMismatch();
    if (!object(value) || !object(value.thread) || value.thread.id !== reference.threadId
      || !(value.environment === null ? value.thread.environmentId === null
        : object(value.environment) && (typeof value.environment.path === 'string'
          || (value.environment.path === null && value.environment.status === 'destroyed'
            && object(value.environment.lifecycle) && value.environment.lifecycle.phase === 'destroyed')))
      || !['active', 'error', 'idle', 'pending', 'starting', 'stopping'].includes(String(value.thread.status))) throw new Error('Unreadable bb thread');
    return { thread: value.thread, environment: value.environment as JsonObject | null };
  }
  private async events(reference: WorkerReference): Promise<BbEvent[]> {
    const value = await this.call(String(reference.executionProfile), ['thread', 'log', String(reference.threadId), '--json', '--all']);
    if (!Array.isArray(value)) throw new Error('Unreadable bb events');
    let previous = -1;
    for (const row of value) {
      if (!object(row) || row.threadId !== reference.threadId || !Number.isSafeInteger(row.seq) || Number(row.seq) <= previous
        || typeof row.type !== 'string' || !object(row.data)) throw new Error('Unreadable bb event');
      previous = Number(row.seq);
    }
    return value as BbEvent[];
  }
  async inspect(reference: WorkerReference): Promise<WorkerObservation> {
    try {
      const { thread, environment } = await this.view(reference);
      if (environment !== null && environment.path !== null && environment.path !== reference.path) {
        // Persist the discrepancy before stopping; repeated reads never retry the stop.
        try { await this.options.discrepancy?.(reference); }
        finally { await this.fence(reference, `environment-mismatch:${reference.threadId}`); }
        return { status: 'unknown', reason: 'bb environment differs from the leased path' };
      }
      if (thread.providerId !== reference.provider) throw new Error();
      const events = await this.events(reference);
      const discrepancy = await this.options.observe?.(reference, events);
      const start = events.findLast(e => e.type === 'turn/started');
      const end = events.findLast(e => e.type === 'turn/completed' || e.type === 'system/thread/interrupted');
      const ended = !!end && (!start || end.seq > start.seq);
      const startSequence = start?.seq ?? -1;
      this.lastStart.set(String(reference.threadId), startSequence);
      const stopped = this.stopped.get(String(reference.threadId)) === startSequence && ['idle', 'error'].includes(String(thread.status));
      // Terminal proof needs this process's own stop and fence. A recovering process
      // can still see that bb holds no running turn: an idle thread, or an archived
      // one whose held input can no longer run.
      const running = !!start && !ended;
      const idle = !running && (['idle', 'error'].includes(String(thread.status)) || thread.archivedAt != null);
      const failure = object(end?.data.error) && typeof end.data.error.message === 'string' ? end.data.error.message : 'bb provider turn failed';
      const execution = this.options.profiles[String(reference.executionProfile)];
      const host = this.options.environment ?? process.env;
      const secret = execution?.credentialVariable ? host[execution.credentialVariable] : undefined;
      return { status: 'known', sourceId: `bb:${reference.threadId}`, sequence: events.at(-1)?.seq ?? 0,
        ...(discrepancy === 'later_turn' ? { laterTurn: true } : {}),
        worker: stopped || idle ? 'stopped' : thread.status === 'pending' ? 'prepared' : 'active',
        turn: ended ? 'ended' : start ? 'running' : 'idle', terminal: ended && stopped && this.fenced.has(String(reference.threadId)),
        capabilities: structuredClone(capabilities),
        ...(end?.data.status === 'failed' ? { turnFailure: {
          kind: /usage[- ]limit|quota|balance|billing/i.test(failure) ? 'provider_limit' as const : 'model_error' as const,
          message: redactDiagnostics(failure, secret ? [secret] : []).slice(0, 4096),
        } } : {}) };
    } catch { return { status: 'unknown', reason: 'bb thread or events unavailable' }; }
  }
  async deliver(reference: WorkerReference, message: string, mode: MessageMode, effectId: string): Promise<Result<JsonObject>> {
    if (this.fenced.has(String(reference.threadId))) return rejected('bb thread fenced');
    if (!this.once(effectId)) return uncertain('bb delivery already attempted', reference);
    try {
      const value = await this.call(String(reference.executionProfile), ['thread', 'tell', String(reference.threadId), '--json', '--mode',
        mode === 'active_steering' ? 'steer' : 'queue', '--', message]);
      if (!object(value) || value.threadId !== reference.threadId || !['queued', 'sent', 'steered'].includes(String(value.delivery))) throw new Error();
      return confirmed(value);
    } catch (error) {
      if (error instanceof BbRefusal) return rejected('bb refused send before delivery', error.evidence);
      return uncertain('bb send response lost or unreadable', reference);
    }
  }
  async stop(reference: WorkerReference, effectId: string): Promise<Result<JsonObject>> {
    if (!this.once(effectId)) return uncertain('bb stop already attempted', reference);
    try {
      const value = await this.call(String(reference.executionProfile), ['thread', 'stop', String(reference.threadId), '--json']);
      if (!object(value) || value.ok !== true || value.threadId !== reference.threadId) throw new Error();
      this.stopped.set(String(reference.threadId), this.lastStart.get(String(reference.threadId)) ?? -1);
      return confirmed(value);
    } catch { return uncertain('bb stop response lost or unreadable', reference); }
  }
  async fence(reference: WorkerReference, effectId: string): Promise<Result<JsonObject>> {
    // Core records the durable fence decision before this external stop effect.
    this.fenced.add(String(reference.threadId));
    return this.stop(reference, effectId);
  }
  async usage(reference: WorkerReference): Promise<Usage> {
    try {
      const row = (await this.events(reference)).findLast(e => e.type === 'thread/tokenUsage/updated');
      const usage = row?.data.tokenUsage as JsonObject | undefined, total = usage?.total;
      if (!row || !object(total)) throw new Error();
      const metrics: Record<string, number> = {};
      for (const [key, metric] of [['inputTokens', 'input'], ['outputTokens', 'output'], ['totalTokens', 'tokens']]) {
        if (typeof total[key!] === 'number' && Number.isFinite(total[key!]) && Number(total[key!]) >= 0) metrics[metric!] = Number(total[key!]);
      }
      if (!Object.keys(metrics).length) throw new Error();
      return { status: 'reported', sourceId: `bb:${reference.threadId}`, sequence: row.seq, metrics };
    } catch { return { status: 'unknown', reason: 'bb cumulative usage unavailable' }; }
  }
  async result(reference: WorkerReference): Promise<Result<{ transport: string; reference: JsonObject }>> {
    return confirmed({ transport: 'file', reference: { path: reference.resultPath! } });
  }
}
