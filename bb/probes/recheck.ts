// Repeating public hook re-evaluation is safe; never repeat create/send/permit.
import { setTimeout as sleep } from 'node:timers/promises';

export interface Observation { sequence: number; generation?: string; kind: string; action?: string }
export async function recheckUntil<T extends Observation>(options: {
  stage: string; threadId: string; after: number; generation: string;
  read: () => Promise<T[]>; recheck: () => Promise<unknown>;
  accept: (fresh: T[]) => boolean;
  timeoutMs?: number; intervalMs?: number;
  now?: () => number; pause?: (ms: number) => Promise<unknown>;
}): Promise<T[]> {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? sleep;
  const deadline = now() + (options.timeoutMs ?? 60_000);
  let requests = 0;
  let rows: T[] = [];
  while (now() < deadline) {
    rows = await options.read();
    const fresh = rows.filter(row => row.sequence > options.after && row.generation === options.generation);
    if (options.accept(fresh)) return rows;
    // bb 0.49.0 may coalesce this request or skip it during its 1s requeue
    // pacing window, without scheduling a trailing recheck. Only observation
    // satisfies the barrier; elapsed time or a successful HTTP reply does not.
    await options.recheck();
    requests++;
    await pause(options.intervalMs ?? 100);
  }
  throw new Error(`Recheck timed out: stage=${options.stage} thread=${options.threadId} after=${options.after} generation=${options.generation} lastSequence=${rows.at(-1)?.sequence ?? 0} requests=${requests}`);
}
