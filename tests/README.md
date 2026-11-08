# Tests

Run `npm run check` for strict type checking and `npm test` for Node's test runner.
TypeScript runs directly on the Node.js version in `.node-version`, without a build step.
The test command discovers `*.test.ts` files recursively in all four folders.

Follow [R37's testing layers](../docs/specification/delivery.md#testing), using the cheapest layer that proves the behaviour:

- `pure-rules/` – pure rules and schema validation using values and controllable time (target: 5 seconds).
- `operations/` – application and storage operations using real temporary SQLite and fake launcher, workspace, repository and check owners (target: 15 seconds).
- `adapters/` – adapter contracts using relevant real Git, Treehouse or OS operations and synthetic protocol/provider peers (target: 30 seconds).
- `cli-process/` – CLI smoke tests and essential process boundaries, including distinct lock, admission and death cases (target: 10 seconds).

Name each test's requirement or scenario. Keep real repositories and processes at their relevant boundaries, and coordinate races with barriers or condition waits rather than sleeps. Paid model experiments and repeated OS stress rounds are outside the default suite.

Pure-rule tests cover the repository check policy (R29), catalogue definitions (R28) and CLI framing/error decisions (R27) without external owners. CLI-process tests exercise the real entry point, JSON input and unexpected runtime failures. The operation and adapter folders are reserved for later implementation tests.
