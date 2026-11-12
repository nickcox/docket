import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../../src/storage/database.ts';
import type { WorkerReference } from '../../src/storage/launch.ts';
import { confirmed, rejected } from '../../src/adapters/command.ts';
import type { Result } from '../../src/adapters/command.ts';
import type { Launcher, LauncherCapabilities, MessageMode, Usage, WorkerBinding, WorkerObservation } from '../../src/adapters/launcher.ts';

/** Test owner: preparation cannot prompt; an effect is never invisibly retried. */
export class FakeLauncher implements Launcher {
  readonly calls: { operation: string; effectId: string }[] = [];
  readonly prompts: { reference: WorkerReference; input: JsonObject; generation: string }[] = [];
  readonly workers = new Map<string, { binding: WorkerBinding; active: boolean; terminal: boolean; sequence: number }>();
  beforePrepare?: () => Promise<Result<WorkerReference> | void>;
  afterPrepare?: (reference: WorkerReference) => Promise<Result<WorkerReference>>;
  beforeActivate?: () => Promise<Result<JsonObject> | void>;
  afterActivate?: () => Promise<Result<JsonObject>>;
  capabilities(_profile: JsonObject): LauncherCapabilities {
    return { preparation: 'non_acting', admission: true, activeSteering: false, afterTurnMessage: false,
      stopTurn: true, terminalFence: true, usageMetrics: [], fenceEnforcement: 'enforced', observationSources: ['fake'] };
  }
  async prepare(binding: WorkerBinding, effectId: string): Promise<Result<WorkerReference>> {
    this.calls.push({ operation: 'prepare', effectId });
    const early = await this.beforePrepare?.();
    if (early) return early;
    const launcher = String((binding.specification.profile as JsonObject).launcher);
    const reference: WorkerReference = launcher === 'pi'
      ? { launcher, processId: '123', sessionId: binding.sessionId }
      : { launcher, threadId: randomUUID() };
    this.workers.set(JSON.stringify(reference), { binding, active: false, terminal: false, sequence: 0 });
    return this.afterPrepare ? this.afterPrepare(reference) : confirmed(reference);
  }
  async activate(reference: WorkerReference, storedInput: JsonObject, effectId: string, claimGeneration: string): Promise<Result<JsonObject>> {
    this.calls.push({ operation: 'activate', effectId });
    const early = await this.beforeActivate?.();
    if (early) return early;
    const worker = this.workers.get(JSON.stringify(reference));
    if (!worker || worker.active || worker.terminal || worker.binding.owner.generation !== claimGeneration) return rejected('Worker cannot activate');
    worker.active = true;
    worker.sequence++;
    this.prompts.push({ reference, input: storedInput, generation: claimGeneration });
    return this.afterActivate ? this.afterActivate() : confirmed({ admitted: true });
  }
  async inspect(reference: WorkerReference): Promise<WorkerObservation> {
    const worker = this.workers.get(JSON.stringify(reference));
    return worker ? { status: 'known', sourceId: String(reference.threadId ?? reference.sessionId), sequence: worker.sequence,
      worker: worker.active ? 'active' : 'prepared', turn: worker.active ? 'running' : 'idle', terminal: worker.terminal,
      capabilities: this.capabilities(worker.binding.specification.profile as JsonObject) } : { status: 'absent' };
  }
  async deliver(_reference: WorkerReference, _message: string, _mode: MessageMode, _effectId: string): Promise<Result<JsonObject>> {
    return rejected('Unsupported', { unsupported: true });
  }
  async stop(reference: WorkerReference, effectId: string): Promise<Result<JsonObject>> {
    this.calls.push({ operation: 'stop', effectId });
    return confirmed({ requested: true, reference });
  }
  async fence(reference: WorkerReference, effectId: string): Promise<Result<JsonObject>> {
    this.calls.push({ operation: 'fence', effectId });
    const worker = this.workers.get(JSON.stringify(reference));
    if (!worker) return rejected('Absent worker');
    worker.terminal = true;
    worker.sequence++;
    return confirmed({ fenced: true });
  }
  async usage(_reference: WorkerReference): Promise<Usage> { return { status: 'unsupported', reason: 'Fake worker' }; }
  async result(_reference: WorkerReference): Promise<Result<{ transport: string; reference: JsonObject }>> { return rejected('No result'); }
}
