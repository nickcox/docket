import { initialiseContext } from './context.ts';
import type { ContextSelector } from './context.ts';
import { CommandFailure } from './response.ts';

export type Role = "person" | "supervisor" | "worker" | "host";
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface OperationDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly roles: readonly Role[];
  readonly bindingDerivedFields: readonly string[];
  readonly mutates: boolean;
  readonly plans: boolean;
  readonly outputSchema: JsonSchema;
  readonly tool: {
    readonly name: string;
    readonly description: string;
  };
}

const description = "Read the operation catalogue without loading a context configuration.";
const schemaObject = { type: "object", description: "A JSON Schema describing an operation's data." };
const operationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "inputSchema", "roles", "bindingDerivedFields", "mutates", "plans", "outputSchema", "tool"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    inputSchema: schemaObject,
    roles: { type: "array", items: { enum: ["person", "supervisor", "worker", "host"] }, uniqueItems: true },
    bindingDerivedFields: { type: "array", items: { type: "string" }, uniqueItems: true },
    mutates: { type: "boolean" },
    plans: { type: "boolean" },
    outputSchema: schemaObject,
    tool: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description"],
      properties: { name: { type: "string" }, description: { type: "string" } },
    },
  },
};

export const catalogue: { readonly catalogueVersion: 1; readonly operations: readonly OperationDefinition[] } = {
  catalogueVersion: 1,
  operations: [
    {
      name: "context.init",
      description: "Initialise an empty context and register its configuration file.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object", properties: {}, required: [], additionalProperties: false,
      },
      roles: ["person"], bindingDerivedFields: [], mutates: true, plans: false,
      outputSchema: {
        type: "object", additionalProperties: false,
        required: ["contextId", "databaseId", "configurationFile", "stateDirectory", "databasePath", "poolRoot", "digest", "revision"],
        properties: {
          contextId: { type: "string" }, databaseId: { type: "string", format: "uuid" },
          configurationFile: { type: "string" }, stateDirectory: { type: "string" },
          databasePath: { type: "string" }, poolRoot: { type: "string" },
          digest: { type: "string" }, revision: { type: "integer", const: 1 },
        },
      },
      tool: { name: "dk_context_init", description: "Initialise an empty context and register its configuration file." },
    },
    {
      name: "catalog.show",
      description,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description: "Empty arguments. No context or caller fields are accepted.",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      roles: ["person", "supervisor", "worker", "host"],
      bindingDerivedFields: [],
      mutates: false,
      plans: false,
      outputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description: "The versioned catalogue of available operations.",
        additionalProperties: false,
        required: ["catalogueVersion", "operations"],
        properties: {
          catalogueVersion: { type: "integer", const: 1 },
          operations: { type: "array", items: operationSchema },
        },
      },
      tool: { name: "dk_catalog_show", description },
    },
  ],
};

export function findOperation(name: string): OperationDefinition | undefined {
  return catalogue.operations.find((operation) => operation.name === name);
}

export function executeOperation(operation: OperationDefinition, _args?: Record<string, unknown>, _progress?: (message: string) => void,
  selector?: ContextSelector): Record<string, unknown> | Promise<Record<string, unknown>> {
  switch (operation.name) {
    case "context.init":
      if (!selector) throw new CommandFailure("invalid_input");
      return initialiseContext(selector);
    case "catalog.show":
      return catalogue;
    default:
      throw new Error("Operation has no implementation.");
  }
}
