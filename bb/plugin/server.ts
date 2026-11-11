import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { z } from 'zod';
import { AdmissionPolicy, admissionSchema, inputText } from './admission.ts';
import { syntheticModel } from './model.ts';

export default function plugin(bb: BbPluginApi) {
  const generation = randomUUID();
  const settings = bb.settings.define({ auditPath: { type: 'string', label: 'Append-only probe audit file', default: '' } });
  const db = bb.storage.database();
  bb.storage.migrate(db, admissionSchema);
  const policy = new AdmissionPolicy(db);
  const audit = async () => {
    const { auditPath } = await settings.get();
    if (!auditPath) throw new Error('Configure auditPath before probing');
    const fd = openSync(auditPath, 'a', 0o600);
    try { writeSync(fd, `${JSON.stringify({ at: Date.now(), generation, observations: policy.events() })}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
  // Durable observations are committed with the consume decision. The append-only
  // file is flushed before proceed; failure loses availability, never retries input.
  bb.experimental_hooks.on('message.dispatch', async ctx => {
    if (ctx.thread.providerId !== 'docket-synthetic') return { action: 'reject', message: 'Synthetic probe only' };
    const action = policy.dispatch(ctx.thread.id, { text: inputText(ctx.input.blocks) ?? '', attempt: ctx.attempt,
      origin: ctx.origin, messages: ctx.queuedMessages.map(row => ({ content: inputText(row.content) ?? '', origin: row.origin })) },
    { generation, origin: ctx.origin, initiator: ctx.initiator, senderThreadId: ctx.senderThreadId,
      queuedIds: ctx.queuedMessages.map(row => row.id) });
    await audit();
    if (action === 'reject') return { action, message: 'Synthetic probe fenced, consumed or non-initial input' };
    if (action === 'wait') return { action, reason: 'Synthetic first input held' };
    return { action };
  });
  // Events are observations, never admission authority. Register before serving
  // controls; missed failures can also be read from the retained thread timeline.
  bb.events.on('turn.failed', event => { policy.observe({ kind: 'turn.failed', generation, ...event }); });
  const command = z.discriminatedUnion('action', [
    z.object({ action: z.enum(['bind', 'permit', 'refuse']), threadId: z.string().min(1) }).strict(),
    z.object({ action: z.literal('recheck') }).strict(),
    z.object({ action: z.literal('retry'), threadId: z.string().min(1), requestId: z.string().min(1) }).strict(),
  ]);
  bb.http.route('POST', '/control', async c => {
    const input = command.parse(await c.req.json());
    if (input.action === 'recheck') {
      await bb.experimental_hooks.recheck('message.dispatch');
      return c.json({ ok: true });
    }
    if (input.action === 'retry') {
      policy.observe({ kind: 'retry.requested', threadId: input.threadId, requestId: input.requestId });
      try {
        const result = await bb.sdk.threads.retry({ threadId: input.threadId, turnRequestId: input.requestId });
        policy.observe({ kind: 'retry.returned', threadId: input.threadId, result });
        return c.json({ ok: true, result });
      } catch {
        policy.observe({ kind: 'retry.refused', threadId: input.threadId, requestId: input.requestId });
        return c.json({ ok: false, error: 'retry refused' }, 409);
      }
    }
    const result = policy.control(input.action, input.threadId);
    await audit();
    return c.json({ ok: result.accepted, ...result }, result.accepted ? 200 : 409);
  }, { auth: 'token' });
  bb.http.route('GET', '/state', c => c.json({ ready: true, generation, rows: policy.rows(), observations: policy.events() }), { auth: 'token' });

  bb.providers.register({
    id: 'docket-synthetic', displayName: 'Docket synthetic admission', family: 'docket-probe',
    strings: { signInHint: 'No sign-in', expiredHint: 'No credentials', installUrl: 'https://example.invalid' },
    experimental_visibility: 'always', maintenance: { health: false, usage: false, installation: false },
    capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: 'none', supportsManualCompaction: false,
      supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ['full'], reasoningLevels: ['medium'] },
    reasoningLevels: [{ id: 'medium', label: 'Medium' }], composerActions: [],
    models: { fallback: [syntheticModel], scope: 'workspace' }, env: { passthrough: [] },
  });
}
