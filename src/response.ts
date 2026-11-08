export type Outcome = "succeeded" | "accepted" | "refused" | "failed";
export type ExitCode = 0 | 1 | 2 | 3;

export interface Diagnostic {
  code: string;
  message: string;
  owner: string | null;
  retryable: boolean;
}

export interface Envelope {
  version: 1;
  operation: string | null;
  requestId: string | null;
  outcome: Outcome;
  code: string;
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
  nextAction: {
    operation: string;
    args: Record<string, unknown>;
    description: string;
  } | null;
}

// Messages are fixed, rather than copied from parser, filesystem or runtime errors.
// Those errors can contain credentials, input contents or environment values.
const failures = {
  invalid_configuration: { exit: 2, message: "Invalid context configuration.", retryable: false },
  context_registered: { exit: 1, message: "The context name is already registered.", retryable: false },
  database_not_empty: { exit: 1, message: "Initialisation requires an empty database path.", retryable: false },
  context_mismatch: { exit: 1, message: "Context identity or storage does not match.", retryable: false },
  config_changed: { exit: 1, message: "Configuration differs from the recorded digest or revision. Restore the file or explicitly configure the context.", retryable: false },
  storage_busy: { exit: 1, message: "Context storage is busy.", retryable: true },
  not_initialised: { exit: 1, message: "The context is not initialised.", retryable: false },
  invalid_input: { exit: 2, message: "Invalid arguments or input at $. Use catalog show --json to inspect the supported operations.", retryable: false },
  unknown_operation: { exit: 2, message: "Unknown operation. Use catalog show --json to inspect the supported operations.", retryable: false },
  unsupported_version: { exit: 2, message: "The requested contract version is not supported.", retryable: false },
  policy_refused: { exit: 1, message: "The operation was refused by policy.", retryable: false },
  owner_unknown: { exit: 1, message: "The owner's current state is unknown.", retryable: true },
  internal_failure: { exit: 3, message: "Unexpected internal failure; do not infer absence of effects.", retryable: false },
  response_too_large: { exit: 3, message: "The response exceeds the 256 KiB limit.", retryable: false },
} as const;

export type FailureCode = keyof typeof failures;

export class CommandFailure extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(failures[code].message);
    this.code = code;
  }
}

export function failureEnvelope(
  code: FailureCode,
  operation: string | null,
  requestId: string | null,
): { envelope: Envelope; exitCode: ExitCode } {
  const failure = failures[code];
  return {
    exitCode: failure.exit,
    envelope: {
      version: 1,
      operation,
      requestId,
      outcome: failure.exit === 3 ? "failed" : "refused",
      code,
      data: {},
      diagnostics: [{ code, message: failure.message, owner: null, retryable: failure.retryable }],
      nextAction: null,
    },
  };
}

export function successEnvelope(operation: string, requestId: string | null, data: Record<string, unknown>): Envelope {
  return {
    version: 1,
    operation,
    requestId,
    outcome: "succeeded",
    code: operation === "context.init" ? "context_initialised" : "catalog_shown",
    data,
    diagnostics: [],
    nextAction: null,
  };
}

export function exitCodeFor(outcome: Outcome): ExitCode {
  switch (outcome) {
    case "succeeded":
    case "accepted":
      return 0;
    case "refused":
      return 1;
    case "failed":
      return 3;
  }
}
