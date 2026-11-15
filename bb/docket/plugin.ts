import { invoke, type Run } from './command.ts';

export interface Member {
  id: string;
  initiator: 'user' | 'agent' | 'system';
  senderThreadId: string | null;
  content: readonly { type: string; text?: string }[];
}
export interface Dispatch {
  thread: { id: string };
  queuedMessages: Member[];
  input: { blocks: Member['content'] };
  initiator: Member['initiator'] | 'mixed';
}
export type Decision = { action: 'proceed' } | { action: 'wait'; reason: string } | { action: 'reject'; message: string };
interface Settings { executable: string; binding: string }
export interface Port {
  experimental_hooks: {
    on(name: 'message.dispatch', handler: (context: Dispatch) => Promise<Decision>): unknown;
    recheck(name: 'message.dispatch'): Promise<void>;
  };
  settings: { define(descriptors: {
    executable: { type: 'string'; label: string; default: string };
    binding: { type: 'string'; label: string; default: string; secret: true };
  }): { get(): Promise<Settings> } };
  cli: { register(command: {
    name: string; summary: string; commands: { name: string; summary: string; usage: string }[];
    run(argv: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  }): unknown };
}

const held: Decision = { action: 'wait', reason: 'Docket admission unavailable or not yet permitted' };

/** The first registration must be the hook, including on reload. */
export function register(bb: Port, execute?: Run): void {
  let settings: { get(): Promise<Settings> } | undefined;
  const call = async (operation: string, input: Record<string, unknown>) => {
    if (!settings) throw new Error('Docket is not ready');
    const config = await settings.get();
    return invoke(config.executable, config.binding, operation, input, execute);
  };
  bb.experimental_hooks.on('message.dispatch', async context => {
    try {
      // Inline sends have no queue row. The local label is only for duplicate
      // member detection, never correlation; the core matches recorded content.
      const messages = context.queuedMessages.length ? context.queuedMessages : [
        { id: 'inline', initiator: context.initiator, content: context.input.blocks },
      ];
      const members = messages.map(member => ({
        id: member.id,
        author: member.initiator,
        content: member.content.map(block => {
          if (block.type !== 'text' || typeof block.text !== 'string') throw new Error('Unsupported message block');
          return block.text;
        }).join('\n'),
      }));
      const result = await call('host.bb-admit', { threadId: context.thread.id, members });
      if (result.decision === 'admit') return { action: 'proceed' };
      if (result.decision === 'refuse') return { action: 'reject', message: 'Docket refused this worker turn' };
      if (result.decision === 'pass-through') return { action: 'proceed' };
      return held;
    } catch { return held; }
  });
  settings = bb.settings.define({
    executable: { type: 'string', label: 'Docket executable (no arguments)', default: 'docket' },
    binding: { type: 'string', label: 'Private host-service binding path', secret: true, default: '' },
  });
  bb.cli.register({
    name: 'docket', summary: 'Docket launcher admission controls (not domain operations)',
    commands: [
      { name: 'ready', summary: 'Check plugin registration and binding transport', usage: 'bb docket ready' },
      { name: 'recheck', summary: 'Re-evaluate held dispatches for a thread', usage: 'bb docket recheck <threadId>' },
    ],
    async run(argv) {
      try {
        if (argv.length === 1 && argv[0] === 'ready') {
          const config = await settings!.get();
          if (!config.executable.trim() || !config.binding.trim()) throw new Error('Missing settings');
          const catalog = await call('catalog.show', {});
          const operations = catalog.operations;
          if (!Array.isArray(operations) || !operations.some((operation: { name?: string }) =>
            operation?.name === 'host.bb-admit')) throw new Error('Incomplete binding');
          return { exitCode: 0, stdout: JSON.stringify({ version: 1, ready: true }) };
        }
        if (argv.length === 2 && argv[0] === 'recheck' && /^thr_[a-zA-Z0-9_-]+$/u.test(argv[1]!)) {
          // SDK 0.6.132 rechecks globally, not by thread. Each hook still asks the core.
          await bb.experimental_hooks.recheck('message.dispatch');
          return { exitCode: 0, stdout: JSON.stringify({ version: 1, requested: true, threadId: argv[1], scope: 'all-plugin-held' }) };
        }
        return { exitCode: 2, stderr: 'Usage: bb docket ready | bb docket recheck <threadId>' };
      } catch { return { exitCode: 1, stderr: 'Docket readiness/recheck failed; do not create or activate a worker' }; }
    },
  });
}
