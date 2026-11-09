import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';


const args = process.argv.slice(2);
const arg = (name: string) => args[args.indexOf(name) + 1];
const record = process.env.PEER_RECORD!;
const mode = process.env.PEER_MODE;
const log = (value: unknown) => appendFileSync(record, `${JSON.stringify(value)}\n`);
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let active = false;
let statsReads = 0;
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
    else {
      statsReads++;
      const zero = mode === 'zero-usage' || (mode === 'regressing-usage' && statsReads > 1);
      respond(mode === 'missing-usage' ? {} : { tokens: { total: zero ? 0 : 123 }, cost: zero ? 0 : 0.004 });
    }
  } else if (request.type === 'prompt') {
    if (mode === 'malformed-with-result') {
      const protocol = JSON.parse(request.message.split('\n\n')[2]);
      writeFileSync(protocol.resultPath, JSON.stringify({ version: 1, identity: protocol.identity, outcome: 'completed', summary: 'Must not complete' }));
      process.stdout.write('{bad json}\n'); return;
    }
    if (mode === 'crash') process.exit(17);
    if (mode === 'malformed') { process.stdout.write('{bad json}\n'); return; }
    if (mode === 'oversized') { process.stdout.write('x'.repeat(8192)); return; }
    if (mode === 'wrong-ack') { respond({ disposition: 'queued' }); return; }
    active = true;
    emit({ type: 'agent_start' });
    if (mode !== 'lost-ack') respond({ disposition: 'started' });
    if (mode === 'lost-connection') {
      setTimeout(() => process.stdout.write('{bad json}\n'), 50);
      return;
    }
    if (mode === 'model-error' || mode === 'usage-limit') {
      // Failed model turns leave the child alive until Docket fences it.
      emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', usage: { totalTokens: 0 },
        errorMessage: mode === 'usage-limit' ? 'Codex error: The usage limit has been reached' : 'Model unavailable: api_key=synthetic-secret' } });
      return;
    }
    if (mode === 'invalid-result') {
      const protocol = JSON.parse(request.message.split('\n\n')[2]);
      writeFileSync(protocol.resultPath, 'invalid JSON');
    }
    if (['result', 'code-result', 'held-result', 'failed-result', 'review-dirty-untracked', 'review-dirty-tracked'].includes(mode ?? '')) {
      const protocol = JSON.parse(request.message.split('\n\n')[2]);
      let commit = 'b'.repeat(40);
      if (mode !== 'result' && !protocol.reviewTarget) {
        writeFileSync(join(process.cwd(), 'implementation.txt'), 'Synthetic implementation\n');
        const git = (...args: string[]) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
        git('add', 'implementation.txt');
        git('-c', 'user.name=Synthetic peer', '-c', 'user.email=peer@example.invalid', 'commit', '-qm', 'Implement task');
        commit = git('rev-parse', 'HEAD');
      }
      if (protocol.reviewTarget && mode === 'review-dirty-untracked') writeFileSync(join(process.cwd(), 'unfinished.txt'), 'Untracked review work\n');
      if (protocol.reviewTarget && mode === 'review-dirty-tracked') writeFileSync(join(process.cwd(), 'implementation.txt'), 'Uncommitted review work\n');
      writeFileSync(protocol.resultPath, JSON.stringify({ version: 1, identity: protocol.identity,
        startingCommit: protocol.startingCommit, outputRef: protocol.outputRef,
        outcome: mode === 'held-result' ? 'held' : mode === 'failed-result' ? 'failed' : 'completed',
        summary: 'Synthetic result', reason: mode === 'held-result' || mode === 'failed-result' ? 'Cannot finish' : null,
        criteriaReport: protocol.criteria.map((criterion: string, index: number) => ({ position: index + 1, criterion, status: 'met', evidence: 'Synthetic check' })),
        evidence: [{ name: 'tests', summary: 'Synthetic tests pass' }],
        workReferences: protocol.reviewTarget ? [{ kind: 'reviewed-output', name: 'review', target: protocol.reviewTarget }]
          : [{ kind: 'git', name: 'code', branch: protocol.outputRef, commit }] }));
    }
    if (mode !== 'running') {
      active = false;
      emit({ type: 'agent_end' });
      emit({ type: 'agent_settled', aborted: false });
    }
  }
}
