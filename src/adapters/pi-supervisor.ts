import { lstat, mkdir, mkdtemp, writeFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationDefinition } from '../catalog.ts';
import type { JsonObject } from '../storage/database.ts';
import type { UsageReport } from '../usage.ts';
import { CommandFailure } from '../response.ts';
import type { PiExecutionProfile } from './pi.ts';
import { windowsSecurePrivateDirectory } from './host-files.ts';
import { PiRpc } from './pi-rpc.ts';

export type SupervisorTool = (id: string, name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface SupervisorPeer {
  readonly exited: boolean;
  prepare(sessionId: string, operations: OperationDefinition[], execute: SupervisorTool): Promise<void>;
  prompt(message: string): Promise<void>;
  settled(): Promise<void>;
  usage(sessionId: string, sequence: number): Promise<UsageReport>;
  stop(): Promise<boolean>;
}

/** Private direct child, no discovery, retries, session resume or PID adoption. */
export class PiSupervisor implements SupervisorPeer {
  private rpc?: PiRpc;
  private idle = true;
  private attempted = false;
  private stopping?: Promise<boolean>;
  private directory?: string;
  private options: { stateDirectory: string; execution: PiExecutionProfile; profile: JsonObject;
    environment?: NodeJS.ProcessEnv; startupMs?: number; requestMs?: number };
  constructor(options: PiSupervisor['options']) {
    this.options = structuredClone(options);
    const execution = options.execution;
    if (Object.keys(execution).some(key => !['executable', 'entrypoint', 'sdkModule', 'agentFiles', 'credentialVariable', 'passEnvironment'].includes(key))
      || !isAbsolute(options.stateDirectory) || !isAbsolute(execution.executable) || (!execution.sdkModule && !execution.entrypoint)
      || (execution.sdkModule !== undefined && execution.entrypoint !== undefined)
      || Object.entries(execution.agentFiles ?? {}).some(([key, path]) => !['auth', 'models'].includes(key) || !isAbsolute(path))
      || (execution.sdkModule && !isAbsolute(execution.sdkModule))
      || (execution.entrypoint && !isAbsolute(execution.entrypoint))
      || !Array.isArray(execution.passEnvironment)
      || [...execution.passEnvironment, ...(execution.credentialVariable ? [execution.credentialVariable] : [])]
        .some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name.startsWith('DOCKET_'))) throw new TypeError('Invalid supervisor execution profile');
  }
  get exited() { return this.rpc?.exit !== undefined; }
  async prepare(sessionId: string, operations: OperationDefinition[], execute: SupervisorTool) {
    if (this.attempted) throw new Error('Supervisor preparation already attempted');
    this.attempted = true;
    const { execution, profile } = this.options;
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(join(await realpath(this.options.stateDirectory), 'supervisor-'));
    if (process.platform === 'win32') await windowsSecurePrivateDirectory(this.directory);
    const home = join(this.directory, 'home'), sessions = join(this.directory, 'sessions');
    await mkdir(join(home, '.pi', 'agent'), { recursive: true, mode: 0o700 });
    await mkdir(sessions, { mode: 0o700 });
    const agentFiles: Record<string, string> = {};
    for (const [key, path] of Object.entries(execution.agentFiles ?? {})) {
      const canonical = await realpath(path);
      if (!(await lstat(canonical)).isFile()) throw new Error('Invalid Pi agent file');
      agentFiles[key] = canonical;
    }
    const configPath = join(this.directory, 'input.json');
    await writeFile(configPath, JSON.stringify({ sdkModule: execution.sdkModule, agentFiles,
      home, sessions, cwd: this.directory, sessionId, provider: profile.provider, model: profile.model,
      reasoning: profile.reasoning, operations }), { flag: 'wx', mode: 0o600 });
    const env: NodeJS.ProcessEnv = {}, host = this.options.environment ?? process.env;
    for (const name of ['PATH', 'TMPDIR', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
      ...execution.passEnvironment, ...(execution.credentialVariable ? [execution.credentialVariable] : [])]) if (host[name] !== undefined) env[name] = host[name];
    env.HOME = home;
    if (process.platform === 'win32') {
      env.USERPROFILE = home;
      env.HOMEDRIVE = parse(home).root.replace(/\\$/u, '');
      env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
      env.TEMP = home; env.TMP = home; env.TMPDIR = home;
    }
    this.rpc = new PiRpc({ executable: execution.executable,
      args: [execution.entrypoint ?? fileURLToPath(new URL('./pi-supervisor-session.ts', import.meta.url)), configPath],
      cwd: this.directory, env, maxRecordBytes: 4 * 1024 * 1024 }, record => {
      if (record.type === 'agent_settled') this.idle = true;
      if (record.type === 'model_error') this.rpc!.fail(new Error('Supervisor model failed; explicit new session required'));
      if (record.type === 'tool_call') {
        if (typeof record.toolCallId !== 'string' || typeof record.name !== 'string' || !record.args || typeof record.args !== 'object' || Array.isArray(record.args)) {
          this.rpc!.fail(new Error('Invalid supervisor tool request')); return;
        }
        void execute(record.toolCallId, record.name, record.args as Record<string, unknown>).then(
          value => this.rpc!.request('tool_result', { toolCallId: record.toolCallId, value }, this.requestMs),
          error => this.rpc!.request('tool_result', { toolCallId: record.toolCallId,
            error: error instanceof CommandFailure ? { code: error.code, data: error.data, nextAction: error.nextAction } : { code: 'internal_failure' } }, this.requestMs),
        ).catch(() => this.rpc!.fail(new Error('Supervisor tool transport failed')));
      }
    });
    await this.rpc.started;
    // Spawn only confirms the process exists. The first response also waits for SDK
    // import, model runtime and session creation before the child reads stdin.
    // Allow 60 seconds for that cold start, separately from ordinary 5-second RPCs.
    // This is one request, not a retry; prompt acknowledgements keep their own limit.
    const state = await this.rpc.request('get_state', {}, this.options.startupMs ?? 60_000) as Record<string, unknown>;
    const tools = operations.map(o => o.tool.name).sort();
    if (state.sessionId !== sessionId || state.provider !== profile.provider || state.model !== profile.model
      || state.isStreaming !== false || JSON.stringify(state.tools) !== JSON.stringify(tools)) throw new Error('Supervisor restriction/binding mismatch');
    await unlink(configPath);
  }
  async prompt(message: string) {
    if (!this.idle || !this.rpc || this.rpc.failure || this.rpc.exit) throw new Error('Supervisor unavailable');
    this.idle = false; // Consumed before write. Never resend after a lost acknowledgement.
    const result = await this.rpc.request('prompt', { message }, this.requestMs) as Record<string, unknown>;
    if (result.disposition !== 'started') throw new Error('Supervisor prompt acknowledgement lost');
  }
  private checkHealth() {
    if (!this.stopping && (this.rpc?.failure || this.rpc?.exit && this.rpc.exit.code !== 0)) throw new Error('Supervisor failed');
  }
  async settled() {
    this.checkHealth();
    while (!this.idle && !this.exited) {
      if (this.stopping) {
        if (!await this.stopping) throw new Error('Supervisor exit unconfirmed');
        return;
      }
      if (this.rpc?.failure || this.rpc?.outputClosed) throw new Error('Supervisor transport failed');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.checkHealth();
  }
  async usage(sessionId: string, sequence: number): Promise<UsageReport> {
    const unknown = { availability: 'unknown' as const, value: null };
    const report: UsageReport = { sessionId, sourceSequence: sequence, observedAt: new Date().toISOString(),
      cost: { ...unknown, currency: null }, tokens: { availability: 'unknown', input: null, output: null, total: null },
      workerTimeMs: { availability: 'unsupported', value: null } };
    try {
      const stats = await this.rpc!.request('get_session_stats', {}, this.requestMs) as any;
      if ([stats.tokens.input, stats.tokens.output, stats.tokens.total].every(n => Number.isSafeInteger(n) && n >= 0)
        && Number.isFinite(stats.cost) && stats.cost >= 0) {
        report.tokens = { availability: 'reported', input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total };
        report.cost = { availability: 'reported', value: stats.cost, currency: 'USD' };
      }
    } catch { /* Unknown is evidence, not zero. */ }
    return report;
  }
  async stop() { return await (this.stopping ??= this.rpc ? this.rpc.terminate(this.requestMs) : Promise.resolve(true)); }
  private get requestMs() { return this.options.requestMs ?? 5000; }
}
