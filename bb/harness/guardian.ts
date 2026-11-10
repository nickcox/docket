import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Separate from the probe: IPC closes even when its worker is killed with SIGKILL.
// Remember descendants before a server restart reparents them, including children
// which create their own process groups. Never signal the guardian's own group.
const root = process.argv[2]!;
const groups = new Set<number>();
const descendants = new Set<number>();
let stopping = false;
let timedOut = false;
const timeoutMs = Number(process.argv[3] ?? 0);
const ownerPid = Number(process.argv[4]);
const deadline = timeoutMs > 0 ? setTimeout(() => { timedOut = true; void stop(); }, timeoutMs) : undefined;
function snapshot() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent, group] of rows) {
      if (pid && pid !== process.pid && (parent === ownerPid || groups.has(group!) || descendants.has(parent!)) && !descendants.has(pid)) {
        descendants.add(pid); changed = true;
      }
    }
  }
}
const timer = setInterval(snapshot, 100);
process.on('message', (message: { pid: number }) => { groups.add(message.pid); snapshot(); });
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearTimeout(deadline);
  snapshot();
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of groups) { try { process.kill(-pid, signal); } catch {} }
    for (const pid of descendants) { try { process.kill(pid, signal); } catch {} }
    await sleep(signal === 'SIGTERM' ? 1500 : 200);
    snapshot();
  }
  writeFileSync(join(root, 'guardian-stopped.json'), JSON.stringify({ groups: [...groups], descendants: [...descendants], timedOut }));
  // The independent deadline also covers a parent blocked in a synchronous CLI.
  if (timedOut) process.kill(ownerPid, 'SIGKILL');
  process.exit(0);
}
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
