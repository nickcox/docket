import { dirname, join } from 'node:path';
import { canonicalJson } from './configuration.ts';
import { DiagnosticsDirectory } from './adapters/diagnostics.ts';
import type { DiagnosticManifest } from './adapters/diagnostics.ts';
import { confirmed } from './adapters/command.ts';
import { effect } from './completion.ts';
import { CommandFailure } from './response.ts';
import { step } from './plans.ts';
import type { Database, JsonObject } from './storage/database.ts';
import type { TaskActor } from './storage/tasks.ts';

function deletionResult(result: JsonObject | null) {
  const value = (result?.value ?? result) as JsonObject;
  return { ...(value.manifest as JsonObject), removedAt: value.removedAt };
}

export interface CleanInput { attemptId: string; noProcesses: boolean; dryRun: boolean }
export async function cleanDiagnostics(db: Database, input: CleanInput, caller: TaskActor, requestKey: string,
  directory = new DiagnosticsDirectory()) {
  if (caller.kind !== 'person') throw new CommandFailure('person_required');
  if (!input.noProcesses) throw new CommandFailure('process_confirmation_required');
  const attempt = db.attempt(input.attemptId);
  const root = join(dirname(String(attempt.specification.resultPath)), 'diagnostics');
  db.checkDiagnosticsEligible(attempt.id, root);
  const previous = db.events().find(event => event.sourceKey === `diagnostics.authorised:${attempt.id}`);
  const finished = db.requests().find(request => request.requestKey === `diagnostics:${attempt.id}` && request.state === 'succeeded');
  const plan = { steps: finished ? [] : [step('diagnostics.delete', root, ['terminal', 'returned_lease', 'no_processes', 'unreferenced', 'exact_manifest'])] };
  if (input.dryRun) {
    if (!previous) await directory.inspect(root);
    return plan;
  }
  const command = await db.recordCommand({ requestKey, operation: 'diagnostics.clean', caller,
    input: { ...input }, fingerprint: canonicalJson(input) });
  if (finished) return { ...plan, manifest: deletionResult(finished.result) };
  const manifest = previous?.payload ?? JSON.parse(JSON.stringify(await directory.inspect(root))) as JsonObject;
  const authorisation = await db.authoriseDiagnostics(attempt.id, root, manifest, caller, command.id);
  const remove = async () => {
    db.checkDiagnosticsEligible(attempt.id, root);
    await directory.remove(authorisation.payload as unknown as DiagnosticManifest);
    return { manifest: authorisation.payload, removedAt: new Date().toISOString() };
  };
  // This specialised owner resumes only the immutable set difference. It cannot
  // remove a new entry or repeat a launch, send or any other non-idempotent effect.
  const result = await effect(db, authorisation, 'diagnostics', authorisation.payload,
    async () => ({ confirmed: true, ...await remove() }),
    async () => confirmed(await remove()),
    async () => db.checkDiagnosticsEligible(attempt.id, root));
  return { ...plan, manifest: deletionResult(result.result) };
}
