import assert from "node:assert/strict";
import test from "node:test";
import { catalogue, executeOperation, findOperation } from "../../src/catalog.ts";
import type { JsonSchema } from "../../src/catalog.ts";

function checkInputSchema(schema: JsonSchema): void {
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, "unknown fields must refuse");
    const properties = schema.properties as Record<string, JsonSchema>;
    assert.ok(properties && typeof properties === "object");
    assert.deepEqual([...(schema.required as string[])].sort(), Object.keys(properties).sort(), "every input property is required");
    for (const property of Object.values(properties)) {
      assert.equal(typeof property.description, "string");
      assert.ok((property.description as string).trim());
      checkInputSchema(property);
    }
  }
  if (schema.items) checkInputSchema(schema.items as JsonSchema);
  for (const union of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(union)) for (const member of union) checkInputSchema(member as JsonSchema);
  }
}

test("R28/A52: one version-1 catalogue exposes context.init and catalog.show with complete definitions", () => {
  assert.equal(catalogue.catalogueVersion, 1);
  assert.deepEqual(catalogue.operations.map((operation) => operation.name), ["context.init", "catalog.show"]);
  for (const operation of catalogue.operations) {
    assert.ok(operation.description.trim());
    assert.deepEqual(operation.roles, operation.name === 'context.init' ? ['person'] : ["person", "supervisor", "worker", "host"]);
    assert.deepEqual(operation.bindingDerivedFields, []);
    assert.equal(operation.mutates, operation.name === 'context.init');
    assert.equal(operation.plans, false);
    assert.equal(operation.tool.name, `dk_${operation.name.replaceAll(".", "_")}`);
    assert.equal(operation.tool.description, operation.description);
    checkInputSchema(operation.inputSchema);
    assert.equal(operation.outputSchema.type, "object");
    assert.equal(operation.outputSchema.additionalProperties, false);
    assert.equal(findOperation(operation.name), operation);
    if (operation.name === 'catalog.show') {
      assert.deepEqual(operation.outputSchema.required, ["catalogueVersion", "operations"]);
      assert.equal(executeOperation(operation), catalogue, "execution emits the core definitions, not a copy");
    } else {
      assert.throws(() => executeOperation(operation), /Invalid arguments/u, 'initialisation requires a trusted CLI selector');
    }
  }
  assert.equal(findOperation("task.add"), undefined);
});

test("R28/A52: the no-argument input schema is a described strict empty object", () => {
  assert.deepEqual(findOperation('catalog.show')!.inputSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    description: "Empty arguments. No context or caller fields are accepted.",
    properties: {},
    required: [],
    additionalProperties: false,
  });
});
