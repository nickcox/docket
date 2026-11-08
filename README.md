# Docket

Docket is a command-line tool that keeps the record of agent work in a project: its tasks, the attempts agents make at them, the evidence for each result, and the approvals needed before work is accepted or a workspace is returned. A host such as [bb](https://getbb.app) runs the agents and shows the work; Docket decides what is allowed and records what happened.

**Status:** the version-1 CLI envelope, `catalog.show`, SQLite schema, database opener and in-process task operations are implemented. Other operations are not yet available. The [specification](docs/specification/README.md) is a draft for review and defines what Docket must do. The bb launcher has not passed qualification.

Docket succeeds [Switchboard](https://github.com/nickcox/switchboard). It is built from its specification, not from Switchboard's code.

## Run the catalogue

Use the Node.js version in `.node-version`:

```sh
npm ci
npm exec -- docket catalog show --json
```

The catalogue needs no configuration. Its input schema is a strict empty object: it has no fields, and unknown fields refuse. Omit input, use `--input <json-file>` containing `{}`, or pass multiline JSON through stdin:

```sh
printf '{\n}\n' | node bin/docket.ts catalog show --stdin --json
```

Do not combine `--input` and `--stdin`. `--request-id <key>` optionally correlates the read; otherwise `requestId` is null. The response's `data` contains `catalogueVersion: 1` and the operation definitions, including descriptions, schemas, roles and tool presentation.

Every invocation prints one version-1 JSON envelope on stdout, even without `--json` or when arguments are invalid. An unrecognised operation is reported with `operation: null`, rather than echoing untrusted arguments. Progress and diagnostic text use stderr. Exit codes are 0 for success or accepted work, 1 for domain refusal, 2 for invalid arguments/input or an unknown operation, and 3 for unexpected failure. The response limit is 256 KiB; JSON input is also limited to 256 KiB.

Run `npm run check` and `npm test` for the type check and full test suite.

## Documents

- [Specification](docs/specification/README.md): required behaviour, interfaces and acceptance scenarios.
- [Working on Docket](AGENTS.md): instructions for people and agents changing this repository.
- [Reference implementations](docs/reference-implementations.md): Switchboard files a task may consult on purpose.
- [bb admission probe](investigations/bb-qualification/2026-11-08-bb-admission.md): records what happens when a waiting message loses its plugin hook after deliberate disablement; this case is outside the bb launcher guarantee.
- [bb enabled-plugin probe](investigations/bb-qualification/2026-11-08-bb-enabled-admission.md): records ordinary admission and the explicit Send now bypass with the plugin enabled.

## Licence

[MIT](LICENSE).
