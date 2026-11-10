import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { z } from 'zod';

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ auditPath: { type: 'string', label: 'Append-only probe audit file', default: '' } });
  const db = bb.storage.database();
  bb.storage.migrate(db, ['CREATE TABLE admission (thread TEXT PRIMARY KEY, bound INTEGER NOT NULL DEFAULT 0, decision TEXT NOT NULL DEFAULT \'hold\', consumed INTEGER NOT NULL DEFAULT 0)']);
  const ensure = db.prepare('INSERT OR IGNORE INTO admission(thread) VALUES (?)');
  const get = db.prepare('SELECT * FROM admission WHERE thread = ?');
  const audit = async (entry: unknown) => {
    const { auditPath } = await settings.get();
    if (!auditPath) throw new Error('Configure auditPath before probing');
    const fd = openSync(auditPath, 'a', 0o600);
    try { writeSync(fd, `${JSON.stringify({ at: Date.now(), ...entry as object })}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
  bb.experimental_hooks.on('message.dispatch', async ctx => {
    ensure.run(ctx.thread.id);
    // Inline hooks expose no stable message ID. Keep a unique observation ID and
    // content digest; queued rechecks additionally expose bb's stable row IDs.
    await audit({ kind: 'asked', observationId: randomUUID(), threadId: ctx.thread.id, attempt: ctx.attempt,
      digest: createHash('sha256').update(JSON.stringify(ctx.input)).digest('hex'),
      origin: ctx.origin, originPluginId: ctx.originPluginId, initiator: ctx.initiator, senderThreadId: ctx.senderThreadId,
      messages: ctx.queuedMessages.map(row => ({ id: row.id, origin: row.origin, originPluginId: row.originPluginId, initiator: row.initiator, senderThreadId: row.senderThreadId, content: row.content })) });
    // No awaits between read and consume: the plugin's SQLite row is the test's
    // committed permission, not thread metadata and not Docket core authority.
    const state = get.get(ctx.thread.id) as { bound: number; decision: string; consumed: number };
    if (state.decision === 'refuse' || state.consumed) return { action: 'reject', message: 'Q1a fenced or already admitted' };
    if (!state.bound || state.decision !== 'permit') return { action: 'wait', reason: 'Q1a first message held' };
    const claimed = db.prepare("UPDATE admission SET consumed = 1 WHERE thread = ? AND bound = 1 AND decision = 'permit' AND consumed = 0").run(ctx.thread.id);
    if (claimed.changes !== 1) return { action: 'reject', message: 'Q1a permission lost' };
    await audit({ kind: 'admitted', threadId: ctx.thread.id });
    return { action: 'proceed' };
  });

  const command = z.discriminatedUnion('action', [
    z.object({ action: z.literal('bind'), threadId: z.string().min(1) }).strict(),
    z.object({ action: z.enum(['permit', 'refuse', 'hold']), threadId: z.string().min(1) }).strict(),
    z.object({ action: z.literal('recheck') }).strict(),
    z.object({ action: z.literal('retry'), threadId: z.string(), requestId: z.string() }).strict(),
  ]);
  bb.http.route('POST', '/control', async c => {
    const input = command.parse(await c.req.json());
    if (input.action === 'recheck') await bb.experimental_hooks.recheck('message.dispatch');
    else if (input.action === 'retry') await bb.sdk.threads.retry({ threadId: input.threadId, turnRequestId: input.requestId });
    else {
      ensure.run(input.threadId);
      if (input.action === 'bind') db.prepare('UPDATE admission SET bound = 1 WHERE thread = ?').run(input.threadId);
      else if (input.action === 'refuse') db.prepare("UPDATE admission SET decision = 'refuse' WHERE thread = ?").run(input.threadId);
      else db.prepare("UPDATE admission SET decision = ? WHERE thread = ? AND decision != 'refuse'").run(input.action, input.threadId);
      await audit({ kind: input.action, threadId: input.threadId });
    }
    return c.json({ ok: true });
  }, { auth: 'token' });
  bb.http.route('GET', '/state', c => c.json({ ready: true, rows: db.prepare('SELECT * FROM admission').all() }));

  bb.providers.register({
    id: 'docket-synthetic', displayName: 'Docket synthetic Q1a', family: 'docket-probe',
    strings: { signInHint: 'No sign-in', expiredHint: 'No credentials', installUrl: 'https://example.invalid' },
    experimental_visibility: 'always', maintenance: { health: false, usage: false, installation: false },
    capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: 'none', supportsManualCompaction: false,
      supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ['full'], reasoningLevels: ['medium'] },
    reasoningLevels: [{ id: 'medium', label: 'Medium' }], composerActions: [],
    models: { fallback: [], scope: 'workspace' }, env: { passthrough: [] },
  });
}
