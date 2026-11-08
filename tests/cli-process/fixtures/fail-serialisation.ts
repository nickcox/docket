// Inject an unexpected runtime failure at the real entry point without adding
// a production flag or environment-controlled failure path.
const stringify = JSON.stringify;
JSON.stringify = ((value: unknown, ...args: unknown[]) => {
  if (value && typeof value === "object" && "operation" in value && value.operation === "catalog.show") {
    JSON.stringify = stringify;
    throw new Error(process.env.DOCKET_TEST_SECRET);
  }
  return Reflect.apply(stringify, JSON, [value, ...args]);
}) as typeof JSON.stringify;
