import type { JsonObject } from './storage/database.ts';

export function unknownProfile(config: JsonObject, profile: string | null | undefined) {
  if (profile == null) return null;
  const profiles = (config.profiles ?? {}) as JsonObject;
  if (Object.hasOwn(profiles, profile)) return null;
  const configuredNames = Object.keys(profiles).sort();
  return { field: 'profile', profile, configuredNames,
    reason: `Profile "${profile}" is not configured. Configured names: ${configuredNames.join(', ') || '(none)'}.` };
}

export class UnknownProfileError extends Error {
  readonly details: NonNullable<ReturnType<typeof unknownProfile>>;
  constructor(details: NonNullable<ReturnType<typeof unknownProfile>>) {
    super(details.reason);
    this.details = details;
  }
}

export function requireProfile(config: JsonObject, profile: string | null | undefined): void {
  const problem = unknownProfile(config, profile);
  if (problem) throw new UnknownProfileError(problem);
}
