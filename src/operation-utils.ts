import { CommandFailure } from './response.ts';
import type { Result } from './adapters/command.ts';
export function known<T>(result: Result<T>): T {
  if (result.status !== 'confirmed') throw new CommandFailure(result.status === 'uncertain' ? 'owner_unknown' : 'policy_refused');
  return result.value;
}
