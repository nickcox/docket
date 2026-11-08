# Working on Docket

Docket is built from its [specification](docs/specification/README.md). Read the specification's README first, for its terms and requirement index, then only the documents and requirements your task names. Do not read the whole specification for every task.

## Switchboard

Docket succeeds Switchboard, but is not a port of it. Do not read Switchboard's code, tests, documents or history, unless your task names an entry in [reference implementations](docs/reference-implementations.md). In that case, read only the files the entry lists, and check everything you take from them against the specification. Where the two differ, the specification applies.

## Code

- TypeScript on Node.js, at the version in `.node-version`, using `node:sqlite` as the specification assumes.
- Keep each external program (Git, Treehouse, Pi, bb) behind its adapter, as the specification's [adapters](docs/specification/adapters.md) describe.
- Match the surrounding code: its naming, comment density and idioms.
- Do not change files your task does not need.

## Tests

- Follow the test layers in the specification's [testing section](docs/specification/delivery.md#testing). Prefer the cheapest layer that shows the behaviour: pure rules first, then operations with real temporary SQLite and fake external owners. Use real Git, Treehouse or processes only to test an adapter or a specific process boundary.
- Every test shows a stated behaviour or risk. Name the requirement or scenario it covers (for example `R04` or `A06`).
- Before finishing, run the checks listed in `.docket/checks.json` once it exists. Until then, run whatever checks your task names.

## Writing

Write prose (comments, documents, messages) in plain Australian English, with en dashes (–), never em dashes. Say the literal thing, and do not coin new terms; use the terms defined in the specification.
