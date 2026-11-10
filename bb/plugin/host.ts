import { experimental_defineProviderBridge, PROVIDER_BRIDGE_PROTOCOL_VERSION, threadDeltaNotificationParamsSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

let cwd = '';
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
      case 'model/list': reply({ models: [] }); break;
      case 'thread/start':
      case 'thread/resume': {
        cwd = p.cwd;
        const providerThreadId = p.providerThreadId ?? randomUUID();
        send({ jsonrpc: '2.0', method: 'thread/identity', params: { threadId: p.threadId, providerThreadId } });
        delta(p.threadId, [{ kind: 'session.reset' }]);
        reply({ providerThreadId });
        break;
      }
      case 'turn/start':
      case 'turn/steer': {
        appendFileSync(join(cwd, 'provider-inputs.jsonl'), `${JSON.stringify({ at: Date.now(), method: request.method, threadId: p.threadId, clientRequestId: p.clientRequestId, input: p.input })}\n`, { mode: 0o600 });
        const providerTurnId = randomUUID();
        reply({});
        delta(p.threadId, [{ kind: 'input.accepted', clientRequestId: p.clientRequestId, providerTurnId },
          { kind: 'turn.open', providerTurnId }, { kind: 'turn.boundary', providerTurnId, status: 'failed', error: { message: 'Q1a intentional failure for ordinary retry' } }]);
        break;
      }
      case 'thread/stop': reply({}); break;
      default: send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unsupported ${request.method}` } });
    }
  },
});
