import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


const args = process.argv.slice(2);
const arg = (name: string) => args[args.indexOf(name) + 1];
const record = process.env.PEER_RECORD!;
const mode = process.env.PEER_MODE;
const log = (value: unknown) => appendFileSync(record, `${JSON.stringify(value)}\n`);
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let active = false;
log({ kind: 'spawn', cwd: process.cwd(), args, environment: process.env });
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  let end: number;
  while ((end = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    receive(line);
  }
});
process.stdin.on('end', () => process.exit(0));
function receive(line: string) {
  const request = JSON.parse(line);
  log(request);
  const respond = (data?: unknown) => emit({ type: 'response', command: request.type, id: request.id, success: true, data });
  if (request.type === 'get_state') respond({ model: { provider: mode === 'wrong-provider' ? 'wrong' : arg('--provider'), id: arg('--model') },
    sessionId: arg('--session-id'), sessionFile: join(arg('--session-dir')!, 'session.jsonl'),
    thinkingLevel: arg('--thinking') ?? 'off', isStreaming: active, isCompacting: false, pendingMessageCount: 0 });
  else if (request.type === 'set_auto_retry') respond();
  else if (request.type === 'get_session_stats') {
    if (mode === 'unsupported-usage') emit({ type: 'response', command: request.type, id: request.id, success: false, error: 'Unknown command: get_session_stats' });
    else respond(mode === 'missing-usage' ? {} : { tokens: { total: 123 }, cost: 0.004 });
  } else if (request.type === 'prompt') {
    if (mode === 'crash') process.exit(17);
    if (mode === 'malformed') { process.stdout.write('{bad json}\n'); return; }
    if (mode === 'oversized') { process.stdout.write('x'.repeat(8192)); return; }
    if (mode === 'wrong-ack') { respond({ disposition: 'queued' }); return; }
    active = true;
    emit({ type: 'agent_start' });
    if (mode !== 'lost-ack') respond({ disposition: 'started' });
    if (mode !== 'running') {
      active = false;
      emit({ type: 'agent_end' });
      emit({ type: 'agent_settled', aborted: false });
    }
    if (mode === 'result') {
      const protocol = JSON.parse(request.message.split('\n\n')[2]);
      writeFileSync(protocol.resultPath, JSON.stringify({ version: 1, identity: protocol.identity, outcome: 'completed', summary: 'Synthetic result' }));
    }
  }
}
