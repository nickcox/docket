import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '../storage/database.ts';
import type { WorkerReference } from '../storage/launch.ts';
import { confirmed, rejected, uncertain, type Result } from './command.ts';
import { windowsSecurePrivateDirectory } from './host-files.ts';
import type { Launcher, LauncherCapabilities, MessageMode, Usage, WorkerBinding, WorkerObservation } from './launcher.ts';
import { redactDiagnostics } from './checks.ts';
import type { TurnFailure } from './launcher.ts';
import { PiRpc, PiRpcRejection, type RpcRecord } from './pi-rpc.ts';

/** Person-controlled host configuration, not task/model input. Values are credential references only. */
export interface PiExecutionProfile {
  executable: string;
  entrypoint?: string;
  credentialVariable?: string;
  passEnvironment: string[];
  /** Absolute installed Pi SDK module. With this option executable must be a Node executable. */
  sdkModule?: string;
  /** Only these person-approved files are shared, using their canonical host paths. */
  agentFiles?: { auth?: string; models?: string };
}
export interface PiLauncherOptions {
  stateDirectory: string;
  profiles: Record<string, PiExecutionProfile>;
  environment?: NodeJS.ProcessEnv;
  requestMs?: number;
  stopMs?: number;
  maxRecordBytes?: number;
  windowsSecurePrivateDirectory?: (path: string) => Promise<void>;
  /** Trusted host must freshly verify the committed matching reference, effect and owning claim. */
  admit: (reference: WorkerReference, storedInput: JsonObject, effectId: string, claimGeneration: string) => Promise<boolean>;
}
type Worker = {
  reference: WorkerReference; binding: WorkerBinding; rpc: PiRpc; directory: string; resultPath: string;
  sequence: number; turn: 'idle' | 'running' | 'ended'; attempted: boolean; prepared: boolean;
  fenced: boolean; usage?: Usage; turnFailure?: TurnFailure;
};
const capabilities: LauncherCapabilities = {
  preparation: 'non_acting', admission: true, activeSteering: false, afterTurnMessage: false,
  stopTurn: false, terminalFence: true, usageMetrics: ['tokens', 'cost'],
  resourceIsolation: ['private_home', 'no_project_settings', 'no_extensions', 'no_mcp', 'no_skills', 'no_context_files', 'environment_allowlist'],
  observationSources: ['direct_child', 'pi_rpc'],
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const outside = (parent: string, path: string) => { const rel = relative(parent, path); return rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel); };

/** One non-acting Pi child per preparation. Losing this owner makes observations unknown, never absent. */
export class PiLauncher implements Launcher {
  private workers = new Map<string, Worker>();
  private preparations = new Map<string, Worker>();
  private attemptedPreparations = new Set<string>();
  private attemptedSessions = new Set<string>();
  private options: PiLauncherOptions;
  constructor(options: PiLauncherOptions) {
    if (!isAbsolute(options.stateDirectory)) throw new TypeError('Pi state directory must be absolute');
    for (const profile of Object.values(options.profiles)) {
      if (Object.keys(profile).some(key => !['executable', 'entrypoint', 'credentialVariable', 'passEnvironment', 'sdkModule', 'agentFiles'].includes(key))
        || !isAbsolute(profile.executable) || (profile.entrypoint !== undefined && !isAbsolute(profile.entrypoint))
        || !Array.isArray(profile.passEnvironment)) throw new TypeError('Invalid Pi execution profile');
      if ((profile.sdkModule !== undefined && (!isAbsolute(profile.sdkModule) || profile.entrypoint !== undefined))
        || (profile.agentFiles !== undefined && (!profile.sdkModule || !object(profile.agentFiles)
          || Object.entries(profile.agentFiles).some(([key, path]) => !['auth', 'models'].includes(key) || typeof path !== 'string' || !isAbsolute(path))))) {
        throw new TypeError('Invalid Pi agent file references');
      }
      for (const name of [...(profile.credentialVariable === undefined ? [] : [profile.credentialVariable]), ...profile.passEnvironment]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('DOCKET_')) throw new TypeError('Invalid Pi environment reference');
      }
    }
    for (const value of [options.requestMs ?? 5000, options.stopMs ?? 5000, options.maxRecordBytes ?? 4 * 1024 * 1024]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid Pi transport limit');
    }
    this.options = { ...options, profiles: structuredClone(options.profiles), environment: { ...(options.environment ?? process.env) } };
  }
  capabilities(profile: JsonObject): LauncherCapabilities {
    const supported = profile.launcher === 'pi' && typeof profile.executionProfile === 'string'
      && Object.hasOwn(this.options.profiles, profile.executionProfile);
    return { ...structuredClone(capabilities), ...(supported ? {} : { preparation: 'unsupported', admission: false }) };
  }
  async prepare(input: WorkerBinding, effectId: string): Promise<Result<WorkerReference>> {
    const binding = structuredClone(input);
    const previous = this.preparations.get(effectId);
    if (previous || this.attemptedPreparations.has(effectId) || this.attemptedSessions.has(binding.sessionId)) {
      return uncertain('Pi preparation already attempted', previous ? structuredClone(previous.reference) : { sessionId: binding.sessionId, effectId });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.sessionId)) return rejected('Invalid Pi session UUID');
    const profile = binding.specification.profile;
    if (!object(profile) || profile.launcher !== 'pi' || typeof profile.executionProfile !== 'string'
      || typeof profile.provider !== 'string' || !profile.provider || profile.provider.startsWith('-')
      || typeof profile.model !== 'string' || !profile.model || profile.model.startsWith('-')
      || (profile.reasoning !== null && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(profile.reasoning)))) {
      return rejected('Invalid Pi worker profile');
    }
    const execution = Object.hasOwn(this.options.profiles, profile.executionProfile) ? this.options.profiles[profile.executionProfile] : undefined;
    if (!execution) return rejected('Unknown Pi execution profile');
    this.attemptedPreparations.add(effectId);
    this.attemptedSessions.add(binding.sessionId);
    let worker: Worker | undefined;
    try {
      const cwd = await realpath(binding.allocation.path);
      if (cwd !== binding.allocation.path) return rejected('Pi cwd is not canonical');
      await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
      const root = await realpath(this.options.stateDirectory);
      if (!outside(cwd, root)) return rejected('Pi state must be outside the leased workspace');
      const directory = join(root, randomUUID());
      await mkdir(directory, { mode: 0o700 });
      if (process.platform === 'win32') await (this.options.windowsSecurePrivateDirectory ?? windowsSecurePrivateDirectory)(directory);
      const home = join(directory, 'home'), sessions = join(directory, 'sessions');
      await mkdir(join(home, '.pi', 'agent'), { recursive: true, mode: 0o700 });
      await mkdir(sessions, { mode: 0o700 });
      if (!isAbsolute(binding.resultPath) || binding.specification.resultPath !== binding.resultPath
        || !outside(cwd, binding.resultPath)) return rejected('Invalid Pi retained result path');
      const resultDirectory = dirname(binding.resultPath);
      await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
      await mkdir(join(resultDirectory, 'questions'), { recursive: true, mode: 0o700 });
      await mkdir(join(resultDirectory, 'artefacts'), { recursive: true, mode: 0o700 });
      await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }), { flag: 'wx', mode: 0o600 });
      const environment: NodeJS.ProcessEnv = {};
      const host = this.options.environment!;
      for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
        ...(execution.credentialVariable === undefined ? [] : [execution.credentialVariable]), ...execution.passEnvironment]) {
        if (!name.startsWith('DOCKET_') && host[name] !== undefined) environment[name] = host[name];
      }
      environment.HOME = home; // Only explicitly approved agent files are shared by the SDK path.
      if (process.platform === 'win32') {
        // libuv otherwise restores the host's Windows home and temp variables.
        const temp = join(directory, 'temp');
        await mkdir(temp);
        environment.USERPROFILE = home;
        environment.HOMEDRIVE = parse(home).root.replace(/\\$/, '');
        environment.HOMEPATH = home.slice(environment.HOMEDRIVE.length);
        environment.TEMP = temp;
        environment.TMPDIR = temp;
      }
      let args = [...(execution.entrypoint ? [execution.entrypoint] : []), '--mode', 'rpc',
        '--session-id', binding.sessionId, '--session-dir', sessions, '--provider', profile.provider, '--model', profile.model,
        ...(profile.reasoning === null ? [] : ['--thinking', String(profile.reasoning)]),
        '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
        '--no-approve', '--offline', '--tools', 'read,edit,write,bash'];
      if (execution.sdkModule) {
        const agentFiles: Record<string, string> = {};
        for (const [key, path] of Object.entries(execution.agentFiles ?? {})) {
          const canonical = await realpath(path);
          if (!(await lstat(canonical)).isFile()) return rejected('Pi agent reference is not a regular file');
          agentFiles[key] = canonical;
        }
        const configPath = join(directory, 'sdk.json');
        await writeFile(configPath, JSON.stringify({ sdkModule: execution.sdkModule, agentFiles, cwd, home, sessions,
          sessionId: binding.sessionId, provider: profile.provider, model: profile.model, reasoning: profile.reasoning }), { flag: 'wx', mode: 0o600 });
        args = [fileURLToPath(new URL('./pi-worker.ts', import.meta.url)), configPath];
      }
      const reference: WorkerReference = { launcher: 'pi', ownerId: randomUUID(), sessionId: binding.sessionId,
        attemptId: binding.attemptId, preparationEffectId: effectId };
      const rpc = new PiRpc({ executable: execution.executable, args, cwd, env: environment,
        maxRecordBytes: this.options.maxRecordBytes ?? 4 * 1024 * 1024 }, record => this.observe(worker!, record));
      worker = { reference, binding, rpc, directory, resultPath: binding.resultPath,
        sequence: 0, turn: 'idle', attempted: false, prepared: false, fenced: false };
      if (rpc.child.pid !== undefined) reference.processId = String(rpc.child.pid);
      this.workers.set(String(reference.ownerId), worker); this.preparations.set(effectId, worker);
      rpc.child.once('exit', () => { worker!.sequence++; });
      await rpc.started;
      const state = await rpc.request('get_state', {}, this.requestMs);
      this.validateState(worker, state);
      await rpc.request('set_auto_retry', { enabled: false }, this.requestMs);
      worker.prepared = true;
      return confirmed(structuredClone(reference));
    } catch {
      return uncertain('Pi preparation could not be confirmed', worker ? structuredClone(worker.reference) : { sessionId: binding.sessionId, effectId });
    }
  }
  async activate(reference: WorkerReference, storedInput: JsonObject, effectId: string, generation: string): Promise<Result<JsonObject>> {
    const worker = this.lookup(reference);
    if (!worker) return uncertain('Pi owner is unknown', reference);
    if (!worker.prepared || worker.fenced || worker.rpc.exit || worker.rpc.failure) return rejected('Pi worker is not available');
    if (!isDeepStrictEqual(storedInput, worker.binding.specification) || generation !== worker.binding.owner.generation) return rejected('Pi activation binding mismatch');
    if (worker.attempted) return uncertain('Pi initial prompt already attempted', reference);
    try {
      if (!await this.options.admit(structuredClone(reference), structuredClone(storedInput), effectId, generation)) return rejected('Pi launch permission not committed');
      // Recheck after the asynchronous admission read. Consume admission before any write.
      if (worker.attempted || worker.fenced || worker.rpc.failure || worker.rpc.exit) return uncertain('Pi activation no longer available', reference);
      worker.attempted = true;
      const data = await worker.rpc.request('prompt', { message: piWorkerPrompt(worker.binding) }, this.requestMs);
      if (!object(data) || data.disposition !== 'started') return uncertain('Pi prompt admission not confirmed', reference);
      return confirmed({ admitted: true });
    } catch { return uncertain('Pi prompt acknowledgement lost or invalid; never retry', reference); }
  }
  async inspect(reference: WorkerReference): Promise<WorkerObservation> {
    const worker = this.lookup(reference);
    if (!worker) return { status: 'unknown', reason: 'Pi direct child owner is unavailable' };
    if (!worker.rpc.exit && (!worker.prepared || worker.rpc.failure || worker.rpc.outputClosed)) {
      return { status: 'unknown', reason: 'Pi preparation or transport is unconfirmed; child exit not observed' };
    }
    return { status: 'known', sourceId: String(reference.ownerId), sequence: worker.sequence,
      worker: worker.rpc.exit ? 'stopped' : worker.attempted ? 'active' : 'prepared', turn: worker.turn,
      terminal: worker.rpc.exit !== undefined, capabilities: this.capabilities(worker.binding.specification.profile as JsonObject),
      ...(worker.rpc.exit ? { exit: structuredClone(worker.rpc.exit) } : {}),
      ...(worker.turnFailure ? { turnFailure: structuredClone(worker.turnFailure) } : {}),
      ...(this.failed(worker) ? { failure: 'Pi protocol, model turn or child failed' } : {}) };
  }
  async deliver(_reference: WorkerReference, _message: string, _mode: MessageMode, _effectId: string): Promise<Result<JsonObject>> {
    return rejected('Pi message delivery is unsupported by this single-prompt profile');
  }
  async stop(reference: WorkerReference, _effectId: string): Promise<Result<JsonObject>> {
    const worker = this.lookup(reference);
    if (!worker) return uncertain('Pi direct child owner is unavailable', reference);
    worker.fenced = true;
    const exited = await worker.rpc.terminate(this.options.stopMs ?? 5000);
    worker.sequence++;
    return exited ? confirmed({ terminal: true, exit: structuredClone(worker.rpc.exit!) }) : uncertain('Pi child exit not observed', reference);
  }
  async fence(reference: WorkerReference, effectId: string): Promise<Result<JsonObject>> { return this.stop(reference, effectId); }
  async usage(reference: WorkerReference): Promise<Usage> {
    const worker = this.lookup(reference);
    if (!worker) return { status: 'unknown', reason: 'Pi direct child owner is unavailable' };
    if (worker.rpc.exit) return worker.usage ? structuredClone(worker.usage) : { status: 'unknown', reason: 'Pi exited without a session usage report' };
    try {
      const stats = await worker.rpc.request('get_session_stats', {}, this.requestMs);
      if (!object(stats) || !object(stats.tokens) || !nonnegative(stats.tokens.total) || !Number.isSafeInteger(stats.tokens.total) || !nonnegative(stats.cost)) {
        return { status: 'unknown', reason: 'Pi session usage metrics are missing or invalid' };
      }
      const metrics = { tokens: stats.tokens.total, cost: stats.cost };
      if (worker.usage?.status === 'reported' && (metrics.tokens < worker.usage.metrics.tokens! || metrics.cost < worker.usage.metrics.cost!)) {
        return { status: 'unknown', reason: 'Pi cumulative usage moved backwards' };
      }
      worker.usage = { status: 'reported', sourceId: String(reference.ownerId), sequence: ++worker.sequence, metrics };
      return structuredClone(worker.usage);
    } catch (error) {
      return error instanceof PiRpcRejection && error.unsupported
        ? { status: 'unsupported', reason: 'Pi does not support session usage' }
        : { status: 'unknown', reason: 'Pi usage read failed' };
    }
  }
  /** Read Pi's credential-backed model availability without sending a prompt or model request. */
  async providerReady(reference: WorkerReference): Promise<Result<JsonObject>> {
    const worker = this.lookup(reference);
    if (!worker || worker.rpc.exit || worker.rpc.failure) return uncertain('Pi owner is unavailable', reference);
    try {
      const available = await worker.rpc.request('get_available_models', {}, this.requestMs);
      const profile = worker.binding.specification.profile as JsonObject;
      if (!object(available) || !Array.isArray(available.models)) return uncertain('Pi readiness response is invalid', reference);
      return available.models.some(model => object(model) && model.provider === profile.provider && model.id === profile.model)
        ? confirmed({ provider: profile.provider!, model: profile.model!, ready: true }) : rejected('Pi provider/model is not ready');
    } catch { return uncertain('Pi provider readiness is unknown', reference); }
  }
  async result(reference: WorkerReference): Promise<Result<{ transport: string; reference: JsonObject }>> {
    const worker = this.lookup(reference);
    if (!worker) return uncertain('Pi result owner is unavailable', reference);
    if (this.failed(worker)) return rejected('Pi failure prevents a successful result transport');
    try {
      const stat = await lstat(worker.resultPath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) return rejected('Invalid Pi result file');
      return confirmed({ transport: 'regular_file', reference: { path: worker.resultPath } });
    } catch { return uncertain('Pi result file is unavailable', reference); }
  }
  private failed(worker: Worker): boolean {
    return worker.turnFailure !== undefined || worker.rpc.failure !== undefined || (worker.rpc.exit !== undefined
      && worker.rpc.exit.code !== 0 && !(worker.fenced && worker.rpc.exit.signal !== null));
  }
  private get requestMs(): number { return this.options.requestMs ?? 5000; }
  private lookup(reference: WorkerReference): Worker | undefined {
    const worker = this.workers.get(String(reference.ownerId ?? ''));
    return worker && isDeepStrictEqual(worker.reference, reference) ? worker : undefined;
  }
  private validateState(worker: Worker, state: unknown): void {
    const profile = worker.binding.specification.profile as JsonObject;
    if (!object(state) || !object(state.model) || state.model.provider !== profile.provider || state.model.id !== profile.model
      || state.sessionId !== worker.binding.sessionId || typeof state.sessionFile !== 'string'
      || !isAbsolute(state.sessionFile) || outside(join(worker.directory, 'sessions'), state.sessionFile)
      || state.sessionFile === join(worker.directory, 'sessions')
      || (profile.reasoning !== null && state.thinkingLevel !== profile.reasoning)
      || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0) throw new Error('Pi state does not match the non-acting binding');
  }
  private observe(worker: Worker, record: RpcRecord): void {
    worker.sequence++;
    if (record.type === 'agent_start') {
      if (!worker.attempted || worker.fenced) { worker.rpc.fail(new Error('Pi acted without admission')); return; }
      worker.turn = 'running';
    }
    if (record.type === 'agent_settled' && typeof record.aborted !== 'boolean') {
      worker.rpc.fail(new Error('Invalid Pi settled event')); return;
    }
    if (record.type === 'message_end' && object(record.message) && record.message.role === 'assistant'
      && ['error', 'aborted'].includes(String(record.message.stopReason))) {
      if (!worker.attempted || typeof record.message.errorMessage !== 'string') {
        worker.rpc.fail(new Error('Invalid Pi failed turn')); return;
      }
      const message = record.message.errorMessage;
      const profile = worker.binding.specification.profile as JsonObject;
      const execution = this.options.profiles[String(profile.executionProfile)]!;
      const secrets = [execution.credentialVariable, ...execution.passEnvironment]
        .flatMap(name => name && this.options.environment![name] ? [this.options.environment![name]!] : []);
      worker.turnFailure = { kind: /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage limit (?:has been )?reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|usage[- ]limit|quota|balance/i.test(message)
        ? 'provider_limit' : 'model_error', message: redactDiagnostics(message, secrets).slice(0, 4096) };
      worker.turn = 'ended'; return;
    }
    if (record.type === 'agent_end' || record.type === 'agent_settled') {
      if (!worker.attempted) { worker.rpc.fail(new Error('Pi ended an unadmitted turn')); return; }
      worker.turn = 'ended';
    }
  }
}

/** Worker protocol 1 is data inside one prompt, never shell interpolation or a second turn. */
export function piWorkerPrompt(binding: WorkerBinding): string {
  const resultPath = binding.resultPath;
  const questionsDirectory = join(dirname(resultPath), 'questions');
  const artefactsDirectory = join(dirname(resultPath), 'artefacts');
  const specification = binding.specification;
  const task = specification.task as JsonObject;
  const protocol = { version: 1, identity: { databaseId: binding.databaseId, contextId: binding.contextId,
    taskId: binding.taskId, attemptId: binding.attemptId, leaseId: binding.allocation.leaseId, sessionId: binding.sessionId },
    workspace: binding.allocation.path, startingCommit: binding.allocation.startingCommit, outputRef: binding.allocation.outputRef,
    instructions: task.instructions, criteria: specification.criteria, delivery: specification.delivery,
    reviewTarget: specification.reviewTarget ?? null, handover: specification.handover ?? null, resultPath, questionsDirectory, artefactsDirectory };
  return ['Complete this one assigned task in the exact leased workspace. Do not launch other agents, mutate task records or leases, merge, push or publish. Check any inherited work in the handover against the task and its criteria rather than trusting it. This is a new attempt, not acceptance of the source work.',
    'Use this immutable worker protocol version 1 input:', JSON.stringify(protocol),
    'Write one JSON result to resultPath using the write tool, with exactly these fields: version:1, identity (the exact supplied object), startingCommit, outputRef, outcome (completed|held|failed), summary, reason (null for completed, otherwise a nonblank string), criteriaReport, evidence, workReferences. Copy startingCommit and outputRef exactly from the input.',
    specification.reviewTarget
      ? 'This is an independent review. Do not commit changes. Inspect reviewTarget.checkResults and run focused tests rather than the full suite again. evidence is an array of {name,summary}. workReferences must contain exactly one {kind:"reviewed-output",name,target} with target equal to reviewTarget. Retained artefacts may also use {kind:"artefact",name,path,description}, with path relative to the result directory; artefact references must name files inside artefactsDirectory, not directories.'
      : 'evidence is an array of {name,summary}. workReferences contains {kind:"git",name,branch,commit} (branch equals outputRef, commit is the exact retained candidate) or {kind:"artefact",name,path,description} (path is relative to the result file directory). Include every required evidence and deliverable name. Artefact references must name files inside artefactsDirectory, not directories. Store retained artefacts in artefactsDirectory.',
    `Report each criterion exactly once with fields position (1-based), criterion (exact text), status (met|not_met) and evidence. ${specification.reviewTarget ? 'Do not commit changes.' : 'Commit code to the output ref.'} A turn ending is not acceptance.`].join('\n\n');
}
