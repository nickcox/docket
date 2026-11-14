import { isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
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
}
export interface BbEvent { threadId: string; seq: number; type: string; data: JsonObject }
export interface BbOptions {
  profiles: Record<string, BbExecutionProfile>;
  environment?: NodeJS.ProcessEnv;
  run?: Runner;
  admission: (effectId: string) => boolean;
  observe?: (reference: WorkerReference, events: BbEvent[]) => Promise<void>;
  admissionMs?: number;
}
const capabilities: LauncherCapabilities = {
  preparation: 'protected', admission: true, activeSteering: true, afterTurnMessage: true,
  stopTurn: true, terminalFence: true, fenceEnforcement: 'best_effort', usageMetrics: ['tokens'],
  observationSources: ['bb_events'],
};
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
      if (!profile || Object.keys(profile).some(k => !['executable', 'passEnvironment', 'credentialVariable'].includes(k))
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
    if (!result.complete || result.code !== 0) throw new Error('bb response unavailable');
    const value: unknown = JSON.parse(result.stdout);
    if (object(value) && value.ok === false) throw new Error('bb refused command');
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
    try {
      const ready = await this.call(executionProfile, ['docket', 'ready']);
      if (!object(ready) || ready.version !== 1 || ready.ready !== true) throw new Error();
    } catch { return rejected('Docket bb plugin is not ready', { neverStarted: true }); }
    try {
      await mkdir(dirname(binding.resultPath), { recursive: true, mode: 0o700 });
      await mkdir(join(dirname(binding.resultPath), 'artefacts'), { recursive: true, mode: 0o700 });
      await mkdir(join(dirname(binding.resultPath), 'questions'), { recursive: true, mode: 0o700 });
    } catch { return rejected('Cannot prepare retained result directories', { neverStarted: true }); }
    try {
      // Inline argv preserves trailing newlines; --prompt-file strips them in bb 0.49.0.
      const args = ['thread', 'spawn', '--json', '--provider', String(profile.provider), '--model', String(profile.model),
        '--environment', binding.allocation.path, '--prompt', binding.initialInput];
      if (typeof profile.reasoning === 'string') args.push('--reasoning-level', profile.reasoning);
      const value = await this.call(executionProfile, args);
      if (!object(value) || typeof value.id !== 'string' || !/^thr_[\w-]+$/.test(value.id)) throw new Error();
      return confirmed({ launcher: 'bb', threadId: value.id, executionProfile, provider: String(profile.provider),
        model: String(profile.model), path: binding.allocation.path, sessionId: binding.sessionId, resultPath: binding.resultPath });
    } catch { return uncertain('bb create response lost or unreadable', { effectId, sessionId: binding.sessionId }); }
  }
  async activate(reference: WorkerReference, _input: JsonObject, effectId: string, _generation: string): Promise<Result<JsonObject>> {
    if (!this.once(effectId)) return uncertain('bb activation already attempted', reference);
    try {
      const view = await this.view(reference);
      if (view.thread.providerId !== reference.provider || view.environment.path !== reference.path) return rejected('bb execution identity changed');
      const queue = await this.call(String(reference.executionProfile), ['thread', 'queue', 'list', String(reference.threadId), '--json']);
      if (!Array.isArray(queue) || queue.length !== 1 || !object(queue[0]) || queue[0].model !== reference.model) {
        return rejected('bb held prompt model could not be verified');
      }
      const reply = await this.call(String(reference.executionProfile), ['docket', 'recheck', String(reference.threadId)]);
      if (!object(reply) || reply.requested !== true || reply.threadId !== reference.threadId) throw new Error();
      const deadline = Date.now() + (this.options.admissionMs ?? 5000);
      do {
        if (this.options.admission(effectId)) return confirmed({ admitted: true });
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      return uncertain('bb admission not recorded', reference);
    } catch { return uncertain('bb activation response lost or unreadable', reference); }
  }
  private async view(reference: WorkerReference): Promise<{ thread: JsonObject; environment: JsonObject }> {
    const value = await this.call(String(reference.executionProfile), ['thread', 'show', String(reference.threadId), '--json']);
    if (!object(value) || !object(value.thread) || value.thread.id !== reference.threadId || !object(value.environment)
      || !['active', 'error', 'idle', 'pending', 'starting', 'stopping'].includes(String(value.thread.status))) throw new Error('Unreadable bb thread');
    return { thread: value.thread, environment: value.environment };
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
      const { thread, environment } = await this.view(reference), events = await this.events(reference);
      if (thread.providerId !== reference.provider || environment.path !== reference.path) throw new Error();
      await this.options.observe?.(reference, events);
      const start = events.findLast(e => e.type === 'turn/started');
      const end = events.findLast(e => e.type === 'turn/completed' || e.type === 'system/thread/interrupted');
      const ended = !!end && (!start || end.seq > start.seq);
      const startSequence = start?.seq ?? -1;
      this.lastStart.set(String(reference.threadId), startSequence);
      const stopped = this.stopped.get(String(reference.threadId)) === startSequence && ['idle', 'error'].includes(String(thread.status));
      const failure = object(end?.data.error) && typeof end.data.error.message === 'string' ? end.data.error.message : 'bb provider turn failed';
      const execution = this.options.profiles[String(reference.executionProfile)];
      const host = this.options.environment ?? process.env;
      const secret = execution?.credentialVariable ? host[execution.credentialVariable] : undefined;
      return { status: 'known', sourceId: `bb:${reference.threadId}`, sequence: events.at(-1)?.seq ?? 0,
        worker: stopped ? 'stopped' : thread.status === 'pending' ? 'prepared' : 'active',
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
    } catch { return uncertain('bb send response lost or unreadable', reference); }
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
