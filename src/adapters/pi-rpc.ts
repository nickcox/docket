import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type RpcRecord = Record<string, unknown> & { type: string };

/** LF framing, fatal UTF-8 decoding and a byte limit even without a terminating LF. */
export class PiFrames {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffered = '';
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  push(bytes: Uint8Array): RpcRecord[] {
    this.buffered += this.decoder.decode(bytes, { stream: true });
    const records: RpcRecord[] = [];
    let end: number;
    while ((end = this.buffered.indexOf('\n')) !== -1) {
      const line = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 1);
      if (Buffer.byteLength(line) > this.limit) throw new Error('Pi record exceeds byte limit');
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof (value as RpcRecord).type !== 'string' || !(value as RpcRecord).type) throw new Error('Invalid Pi record');
      records.push(value as RpcRecord);
    }
    if (Buffer.byteLength(this.buffered) > this.limit) throw new Error('Pi record exceeds byte limit');
    return records;
  }
  finish(): void {
    this.buffered += this.decoder.decode();
    if (this.buffered) throw new Error('Unterminated Pi record');
  }
}

export class PiRpcRejection extends Error {
  readonly unsupported: boolean;
  constructor(command: string, error: unknown) {
    super('Pi rejected RPC command');
    this.unsupported = error === `Unknown command: ${command}` || error === `Unsupported command: ${command}`;
  }
}

type Pending = { type: string; resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Owns only the direct child. No retries, detached children or PID-based adoption. */
export class PiRpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly started: Promise<void>;
  readonly exited: Promise<void>;
  exit: { code: number | null; signal: string | null } | undefined;
  failure: Error | undefined;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  constructor(options: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; maxRecordBytes: number },
    onEvent: (record: RpcRecord) => void) {
    const frames = new PiFrames(options.maxRecordBytes);
    this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, shell: false, stdio: 'pipe' });
    this.started = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => {
      this.exit = { code, signal };
      this.fail(new Error('Pi child exited'));
      // Descendants can retain the pipes. Their state is not inferred from this exit.
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
      resolve();
    }));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', error => this.fail(error));
    this.child.stderr.on('data', () => { /* Drain without retaining credentials or unbounded diagnostics. */ });
    this.child.stdout.on('data', (bytes: Buffer) => {
      if (this.failure) return;
      try {
        for (const record of frames.push(bytes)) {
          if (record.type !== 'response') { onEvent(record); continue; }
          if (typeof record.id !== 'string') throw new Error('Uncorrelated Pi response');
          const pending = this.pending.get(record.id);
          if (!pending) continue; // Late acknowledgement cannot trigger a retry.
          if (record.command !== pending.type || typeof record.success !== 'boolean') throw new Error('Mismatched Pi response');
          if (record.success) pending.resolve(record.data);
          else pending.reject(new PiRpcRejection(pending.type, record.error));
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.child.stdout.on('end', () => {
      try { frames.finish(); } catch (error) { this.fail(error as Error); }
      if (!this.exit) this.fail(new Error('Pi output closed before child exit'));
    });
  }
  fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
  }
  async request(type: string, fields: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = `docket-${++this.sequence}`;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { type, resolve, reject });
        timer = setTimeout(() => reject(new Error('Pi acknowledgement timeout')), timeoutMs);
        this.child.stdin.write(`${JSON.stringify({ ...fields, id, type })}\n`, error => { if (error) reject(error); });
      });
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async terminate(timeoutMs: number): Promise<boolean> {
    if (this.exit) return true;
    this.child.kill('SIGTERM');
    await this.waitExit(Math.floor(timeoutMs / 2));
    if (!this.exit) { this.child.kill('SIGKILL'); await this.waitExit(Math.ceil(timeoutMs / 2)); }
    return this.exit !== undefined;
  }
  private async waitExit(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  }
}
