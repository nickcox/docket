import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const log = (value: unknown) => appendFileSync(process.env.PEER_RECORD!, `${JSON.stringify(value)}\n`);
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
log({ type: 'spawn', config, environment: process.env });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  log(request);
  const respond = (data: unknown) => emit({ type: 'response', id: request.id, command: request.type, success: true, data });
  if (request.type === 'get_state') respond({ sessionId: config.sessionId, provider: config.provider, model: config.model,
    isStreaming: false, tools: process.env.PEER_MODE === 'unrestricted' ? ['bash'] : config.operations.map((o: any) => o.tool.name).sort() });
  if (request.type === 'prompt') {
    if (process.env.PEER_MODE === 'lost-ack') return;
    respond({ disposition: 'started' });
    if (process.env.PEER_MODE === 'crash') process.exit(17);
    if (process.env.PEER_MODE === 'model-error') { emit({ type: 'model_error' }); emit({ type: 'agent_settled' }); return; }
    if (process.env.PEER_MODE === 'running') return;
    emit({ type: 'tool_call', toolCallId: 'briefing', name: 'supervisor.briefing', args: {} });
  }
  if (request.type === 'tool_result') {
    respond({ received: true });
    if (request.toolCallId === 'briefing') emit({ type: 'tool_call', toolCallId: 'note', name: 'supervisor.note', args: { text: 'Synthetic supervisor inspected the briefing.' } });
    else {
      emit({ type: 'agent_settled' });
      setTimeout(() => process.exit(0), 20);
    }
  }
  if (request.type === 'get_session_stats') respond({ tokens: { input: 3, output: 2, total: 5 }, cost: 0.01 });
});
