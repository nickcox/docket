import { experimental_defineProviderBridge, PROVIDER_BRIDGE_PROTOCOL_VERSION, threadDeltaNotificationParamsSchema,
  threadStartParamsSchema, threadResumeParamsSchema, turnStartParamsSchema, turnSteerParamsSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { syntheticModel } from './model.ts';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const directories = new Map<string, string>();
function record(cwd: string, entry: object) {
  const fd = openSync(join(cwd, 'provider-inputs.jsonl'), 'a', 0o600);
  try { appendFileSync(fd, `${JSON.stringify({ at: Date.now(), ...entry })}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
}
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const delta = (threadId: string, deltas: unknown[]) => send({ jsonrpc: '2.0', method: 'thread/delta', params: threadDeltaNotificationParamsSchema.parse({ threadId, deltas }) });

// No model, tools or child process. A failed accepted turn gives the probe a
// real retry path without spending tokens or relying on a model's judgement.
export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine(line) {
    const request = JSON.parse(line);
    if (!('id' in request)) return;
    const p = request.params ?? {};
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: request.id, result });
    switch (request.method) {
      case 'initialize':
        reply({ protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: { grammarVersions: [3, 3], sessionRestore: true, fork: 'none', steerMode: 'queue' } });
        break;
      case 'model/list': reply({ models: [{ ...syntheticModel, model: syntheticModel.id }], selectedOnlyModels: [] }); break;
      case 'thread/start':
      case 'thread/resume': {
        const parsed = request.method === 'thread/start' ? threadStartParamsSchema.parse(p) : threadResumeParamsSchema.parse(p);
        directories.set(parsed.threadId, parsed.cwd);
        if ('input' in parsed && Array.isArray(parsed.input) && parsed.input.length) record(parsed.cwd, { method: request.method, threadId: parsed.threadId, input: parsed.input });
        const providerThreadId = p.providerThreadId ?? randomUUID();
        send({ jsonrpc: '2.0', method: 'thread/identity', params: { threadId: p.threadId, providerThreadId } });
        delta(p.threadId, [{ kind: 'session.reset' }]);
        reply({ providerThreadId });
        break;
      }
      case 'turn/start':
      case 'turn/steer': {
        const parsed = request.method === 'turn/start' ? turnStartParamsSchema.parse(p) : turnSteerParamsSchema.parse(p);
        const cwd = directories.get(parsed.threadId);
        if (!cwd) throw new Error('No synthetic thread directory');
        record(cwd, { method: request.method, threadId: parsed.threadId, clientRequestId: parsed.clientRequestId, input: parsed.input });
        const completedPath = join(cwd, 'completed-threads.json');
        const completed = existsSync(completedPath) && JSON.parse(readFileSync(completedPath, 'utf8')).includes(parsed.threadId);
        const providerTurnId = randomUUID();
        reply({});
        // Explicit provider turn IDs bypass the assembler's pending-acceptance
        // buffer. Start must reach storage before acceptance for that same turn.
        delta(parsed.threadId, [{ kind: 'turn.open', providerTurnId },
          { kind: 'input.accepted', clientRequestId: parsed.clientRequestId, providerTurnId }, { kind: 'turn.boundary', providerTurnId,
            ...(completed ? { status: 'completed' } : { status: 'failed', error: { message: 'Intentional synthetic failure for ordinary retry' } }) }]);
        break;
      }
      case 'thread/stop': reply({}); break;
      default: send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unsupported ${request.method}` } });
    }
  },
});
