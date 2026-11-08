# Working on Docket

Docket is built from its [specification](docs/specification/README.md). Read the specification's README first, for its terms and requirement index, then only the documents and requirements your task names. Do not read the whole specification for every task.

## Switchboard

Docket succeeds Switchboard, but is not a port of it. Do not read Switchboard's code, tests, documents or history, unless your task names an entry in [reference implementations](docs/reference-implementations.md). In that case, read only the files the entry lists, and check everything you take from them against the specification. Where the two differ, the specification applies.

## Changes to `main`

Never commit directly to `main`. Every change, including documentation, is made on another branch and then integrated by fast-forwarding `main`. Code reaches `main` through a dispatched task: a worker commits to its own output branch, and a person or supervisor integrates it. If you are working in the backing checkout and want to change code, add or update a task instead, unless the person you are working with asks you to make that change directly. Even then, make it on a branch.

Before continuing work that another agent session started, check that the session is stopped and has no queued or scheduled input, such as an automatic retry after a rate limit. Another session resuming the same work will make conflicting changes.

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
