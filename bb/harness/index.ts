import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, sep } from 'node:path';
import { createServer, connect } from 'node:net';
import { pluginsFrom, registrationReady, startIsolated, verifySelection, type StartupIO } from './startup.ts';
import { controlRequest } from './http.ts';
import { setTimeout as sleep } from 'node:timers/promises';

export const app = '/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app';
const executable = realpathSync(process.execPath);
if (process.versions.electron || !/[/\\]node(?:\.exe)?$/i.test(executable)) throw new Error('Requires plain Node, never Electron');
const cliEntry = join(app, 'dist', 'bb.js');

export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try { const value = await read(); if (accept(value)) return value; last = value; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out: ${String(last)}`);
}

export function assertSafe(dataDir: string, ports: number[], root: string): void {
  const normal = resolve(homedir(), '.bb');
  const data = realpathSync(dataDir);
  const owner = realpathSync(root);
  const inside = (parent: string, child: string) => child === parent || (!relative(parent, child).startsWith(`..${sep}`) && relative(parent, child) !== '..' && !relative(parent, child).startsWith(sep));
  if (inside(normal, data) || inside(data, normal) || !inside(owner, data) || owner === data || !owner.startsWith(join(realpathSync(tmpdir()), 'docket-bb-'))) {
    throw new Error('Refusing non-private bb data directory');
  }
  if (new Set(ports).size !== ports.length || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535 || port === 38886 || port === 38887)) {
    throw new Error('Refusing normal bb or invalid ports');
  }
}

async function reserve(port = 0) {
  if (port === 38886 || port === 38887) throw new Error('Refusing normal bb port');
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return { port: address.port, close: () => new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) };
}

export async function withHarness<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const h = new Harness(240_000);
  const interrupt = () => { void h.stop().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try { await h.start(); h.prepareProject(); return await run(h); }
  finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await h.stop();
  }
}

export class Harness {
  readonly root = mkdtempSync(join(realpathSync(tmpdir()), 'docket-bb-'));
  readonly dataDir = join(this.root, 'data');
  readonly repo = join(this.root, 'repo');
  private children: ChildProcess[] = [];
  private guardian: ChildProcess;
  private server?: ChildProcess;
  private daemon: ChildProcess | undefined;
  private stopping?: Promise<void>;
  private ports: number[] = [];
  private env: NodeJS.ProcessEnv = {};
  url = '';
  hostId = '';
  projectId = '';

  constructor(timeoutMs = 240_000) {
    mkdirSync(this.dataDir); mkdirSync(this.repo);
    this.guardian = spawn(executable, [fileURLToPath(new URL('./guardian.ts', import.meta.url)), this.root, String(timeoutMs), String(process.pid)], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  }

  cli(...args: string[]): string {
    assertSafe(this.dataDir, this.ports, this.root);
    return execFileSync(executable, [cliEntry, ...args], { env: this.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  }

  private launch(entry: string, name: string, extra: NodeJS.ProcessEnv = {}) {
    assertSafe(this.dataDir, this.ports, this.root);
    const fd = openSync(join(this.root, `${name}.log`), 'a');
    try {
      if (this.stopping) throw new Error('Harness is stopping');
      const child = spawn(executable, ['--use-system-ca', entry], { env: { ...this.env, ...extra }, detached: true, stdio: ['ignore', fd, fd] });
      child.once('spawn', () => this.guardian.send({ pid: child.pid }));
      child.on('error', error => { console.error(`${name}: ${error.message}`); });
      this.children.push(child);
      return child;
    } finally { closeSync(fd); }
  }

  async start() {
    if (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version !== '0.49.0') throw new Error('Requires bb 0.49.0');
    const a = await reserve(Number(process.env.DOCKET_BB_SERVER_PORT ?? 0));
    let b;
    try { b = await reserve(Number(process.env.DOCKET_BB_DAEMON_PORT ?? 0)); }
    catch (error) { await a.close(); throw error; }
    try {
      this.ports = [a.port, b.port];
      assertSafe(this.dataDir, this.ports, this.root);
      this.url = `http://127.0.0.1:${a.port}`;
      // Do not inherit another bb session's routing, tokens or context.
      const bin = join(this.root, 'bin');
      const home = join(this.root, 'home');
      mkdirSync(bin); mkdirSync(home);
      // bb may invoke its CLI from plugins; never resolve the person's Electron launcher.
      writeFileSync(join(bin, 'bb'), `#!/bin/sh\nexec '${executable}' '${cliEntry}' "$@"\n`, { mode: 0o700 });
      this.env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: this.root, LANG: process.env.LANG,
        BB_DATA_DIR: this.dataDir, BB_SERVER_PORT: String(a.port), BB_HOST_DAEMON_PORT: String(b.port), BB_SERVER_URL: this.url,
        BB_CLI_DIR: bin, BB_HOST_DAEMON_AUTO_UPDATE: 'false', BB_HOST_DAEMON_SUPERVISED: 'true' };
    } finally { await a.close(); await b.close(); }
    console.error(`Isolated bb: ${this.root} (${this.ports.join(', ')})`);
    await startIsolated(this.startupIO());
  }

  // Deferred admission experiments alone need a project. Startup-only never does.
  prepareProject() {
    execFileSync('git', ['init', this.repo]);
    execFileSync('git', ['-C', this.repo, '-c', 'user.name=Docket probe', '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-m', 'Q1a fixture']);
    const project = JSON.parse(this.cli('project', 'create', '--name', 'Q1a', '--root', this.repo, '--machine', this.hostId, '--json'));
    this.projectId = project.id;
  }

  private startupIO(): StartupIO {
    return {
      startServer: () => this.startServer(),
      waitRegistration: async () => {
        await until(async () => {
          // Public catalogue GET waits for registrations, but can time out on
          // the host: do not mistake that response alone for complete startup.
          const providers: unknown = await this.request('/api/v1/system/providers/catalog');
          return registrationReady(await this.request('/api/v1/plugins'), providers);
        }, ready => ready);
      },
      installProbe: async () => { this.cli('plugin', 'install', process.env.DOCKET_BB_PROBE_PLUGIN ?? fileURLToPath(new URL('../plugin', import.meta.url)), '--yes'); },
      listPlugins: () => this.request('/api/v1/plugins'),
      listProviders: () => this.request('/api/v1/system/providers/catalog'),
      disable: async id => {
        const result = await this.request(`/api/v1/plugins/${encodeURIComponent(id)}/disable`, {});
        const [plugin] = pluginsFrom({ plugins: [result.plugin] });
        if (result.ok !== true || plugin?.id !== id || plugin.enabled || plugin.status !== 'disabled') throw new Error(`Disable failed: ${id}`);
      },
      connectDaemon: () => this.connectDaemon(),
      stopDaemon: () => this.stopDaemon(),
    };
  }

  async selectedProviders() {
    const selected = await verifySelection(this.startupIO());
    writeFileSync(join(this.root, 'selected-providers.json'), JSON.stringify(selected, null, 2));
    return selected;
  }

  private async connectDaemon() {
    // Retain the verified inventory even if enrollment or prewarming fails.
    await this.selectedProviders();
    // bb 0.49.0 loopback bootstrap route. Harness plumbing, not a plugin API.
    const enrollment = await this.request('/internal/hosts/enroll-key', this.hostId ? { hostId: this.hostId } : {});
    this.hostId = enrollment.hostId;
    this.daemon = this.launch(join(app, 'host-daemon', 'dist', 'daemon-bundle.mjs'), 'daemon', { BB_HOST_ENROLL_KEY: enrollment.enrollKey, BB_HOST_ID: this.hostId });
    await until(async () => JSON.parse(this.cli('machine', 'list', '--json')), value => value.some((host: { id: string; status: string }) => host.id === this.hostId && host.status === 'connected'));
  }

  private async stopDaemon() {
    const child = this.daemon;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(yes => child.once('exit', () => yes()));
    // Host plugin workers may create their own groups. Capture their ancestry
    // before killing the daemon reparents them; the guardian also retains them.
    const descendants = new Set([child.pid]);
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows) {
        if (pid && descendants.has(parent!) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
      }
    }
    process.kill(-child.pid, 'SIGKILL');
    for (const pid of descendants) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await exited;
    this.daemon = undefined;
  }

  private async startServer() {
    this.server = this.launch(join(app, 'server', 'dist', 'index.js'), 'server');
    await until(async () => {
      if (this.server?.exitCode !== null) throw new Error('Server exited');
      const response = await controlRequest(this.url, '/api/v1/system/version', undefined, 1000);
      return response.ok;
    }, value => value);
  }

  async crashServer() {
    await startIsolated({ ...this.startupIO(), startServer: async () => {
      if (!this.server?.pid) throw new Error('No server');
      const exited = new Promise<void>(yes => this.server!.once('exit', () => yes()));
      process.kill(-this.server.pid, 'SIGKILL');
      await exited;
      await this.startServer();
    } }, true);
  }

  async request(path: string, body?: unknown, token?: string): Promise<any> {
    const response = await controlRequest(this.url, path, body, 60_000, token);
    if (!response.ok) throw new Error(`${response.status} ${path}`);
    return JSON.parse(response.text);
  }

  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      const guardianExited = new Promise<void>((yes, no) => {
        this.guardian.once('error', no);
        this.guardian.once('exit', code => code === 0 ? yes() : no(new Error(`Cleanup guardian exited ${code}`)));
      });
      this.guardian.disconnect();
      await guardianExited;
      for (const child of this.children) {
        if (child.pid && child.exitCode === null && child.signalCode === null) await new Promise<void>(yes => child.once('exit', () => yes()));
      }
      // Keep logs on failure and for manual inspection; never remove a normal bb path.
      const ports = await Promise.all(this.ports.map(port => new Promise<{ port: number; closed: boolean }>(yes => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); yes({ port, closed: false }); });
        socket.once('error', error => { socket.destroy(); yes({ port, closed: (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' }); });
        socket.once('timeout', () => { socket.destroy(); yes({ port, closed: false }); });
      })));
      const childExits = this.children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
      writeFileSync(join(this.root, 'stopped.json'), JSON.stringify({ pids: this.children.map(child => child.pid), childExits, ports }));
      if (ports.some(port => !port.closed)) throw new Error('Owned port not confirmed closed');
    })();
  }
}
