import { executeOperation, findOperation } from "./catalog.ts";
import type { OperationDefinition } from "./catalog.ts";
import { CommandFailure, exitCodeFor, failureEnvelope, successEnvelope } from "./response.ts";
import type { ExitCode } from "./response.ts";

import { ConfigurationError } from './configuration.ts';
import { ContextError } from './context.ts';
import type { ContextSelector } from './context.ts';
import { StorageError } from './storage/database.ts';
import { validateSchema } from './operation-schemas.ts';
import { randomUUID } from 'node:crypto';

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_INPUT_BYTES = 256 * 1024;

export interface CliIO {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export type OperationRunner = (
  operation: OperationDefinition,
  args: Record<string, unknown>,
  progress: (message: string) => void,
  selector?: ContextSelector,
  requestId?: string,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

interface Options {
  input: string | null;
  stdin: boolean;
  requestId: string | null;
  selector?: ContextSelector;
}

function parseOptions(args: readonly string[]): Options {
  const options: Options = { input: null, stdin: false, requestId: null };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === undefined || seen.has(flag)) throw new CommandFailure("invalid_input");
    seen.add(flag);
    switch (flag) {
      case "--json":
        break;
      case "--stdin":
        options.stdin = true;
        break;
      case "--input":
      case "--request-id":
      case "--config":
      case "--context": {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new CommandFailure("invalid_input");
        if (flag === "--input") options.input = value;
        else if (flag === "--config" || flag === "--context") {
          if (options.selector) throw new CommandFailure("invalid_input");
          options.selector = flag === "--config" ? { config: value } : { context: value };
        } else {
          if (value.length > 200 || /[\r\n\0]/u.test(value)) throw new CommandFailure("invalid_input");
          options.requestId = value;
        }
        break;
      }
      default:
        throw new CommandFailure("invalid_input");
    }
  }
  if (options.input !== null && options.stdin) throw new CommandFailure("invalid_input");
  return options;
}

async function readArgs(options: Options, io: CliIO): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = options.input !== null ? await io.readFile(options.input) : options.stdin ? await io.readStdin() : "{}";
  } catch {
    throw new CommandFailure("invalid_input");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) throw new CommandFailure("invalid_input");
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    throw new CommandFailure("invalid_input");
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new CommandFailure("invalid_input");
  return args as Record<string, unknown>;
}

function validateArgs(operation: OperationDefinition, args: Record<string, unknown>): void {
  const invalid = validateSchema(operation.inputSchema, args);
  if (invalid) throw new CommandFailure('invalid_input', { field: invalid.slice(0, 200) });
}

/** One invocation writes one envelope, including when parsing or execution throws. */
export async function runCli(
  argv: readonly string[],
  io: CliIO,
  runOperation: OperationRunner = executeOperation,
): Promise<ExitCode> {
  let operation: string | null = null;
  let requestId: string | null = null;
  let output: string;
  let exitCode: ExitCode;
  try {
    if (argv.length < 2 || argv[0]?.startsWith("-") || argv[1]?.startsWith("-")) {
      throw new CommandFailure("invalid_input");
    }
    const definition = findOperation(`${argv[0]}.${argv[1]}`);
    if (!definition) throw new CommandFailure("unknown_operation");
    operation = definition.name;
    const options = parseOptions(argv.slice(2));
    requestId = options.requestId;
    if ((definition.name === 'catalog.show' && options.selector) || (definition.name !== 'catalog.show' && !options.selector)) throw new CommandFailure('invalid_input');
    const args = await readArgs(options, io);
    validateArgs(definition, args);
    if (definition.mutates && args.dryRun !== true) requestId ??= randomUUID();
    const data = await runOperation(definition, args, (message) => io.stderr(`${message}\n`), options.selector, requestId ?? undefined);
    const envelope = successEnvelope(operation, requestId, data);
    exitCode = exitCodeFor(envelope.outcome);
    // Serialise once, inside the failure boundary (for example circular data).
    output = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES) throw new CommandFailure("response_too_large");
  } catch (error) {
    const code = error instanceof CommandFailure ? error.code
      : error instanceof ConfigurationError ? 'invalid_configuration'
      : error instanceof ContextError ? error.code
      : error instanceof StorageError ? (error.code === 'busy' ? 'storage_busy' : error.code === 'not_empty' ? 'database_not_empty' : error.code === 'not_initialised' ? 'not_initialised' : 'context_mismatch')
      : 'internal_failure';
    const failure = failureEnvelope(code, operation, requestId);
    if (error instanceof ConfigurationError) {
      const field = error.field.replace(/[^A-Za-z0-9_.$\[\]-]/gu, '?').slice(0, 200);
      failure.envelope.diagnostics[0]!.message = `Invalid configuration at ${field}.`;
    }
    if (error instanceof ContextError || error instanceof CommandFailure) failure.envelope.data = error.data;
    exitCode = failure.exitCode;
    output = `${JSON.stringify(failure.envelope)}\n`;
    io.stderr(`${failure.envelope.diagnostics[0]?.message}\n`);
  }
  io.stdout(output);
  return exitCode;
}
