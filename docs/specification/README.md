# Docket specification

Status: draft for review, 8 November 2026. This specification defines Docket's required behaviour, interfaces and acceptance criteria. Docket succeeds [Switchboard](https://github.com/nickcox/switchboard), and is built from this specification rather than from Switchboard's code.

## Purpose

Docket is a CLI that owns project tasks, attempts, evidence and the decisions needed to preserve their work. A host runs the agents, delivers messages and questions, and presents the work. bb is the required first host for everyday use. A minimal standalone Pi path exercises the same operations without bb.

The supervisor chooses work and judges results. Docket enforces identity, current authority, evidence, execution limits and retention. Host conversations and task text cannot grant authority.

## Terms

| Term | Meaning |
| --- | --- |
| Context | One project's Docket set-up: its configuration, database, state directory and backing repository. People refer to it by its name, the context ID. |
| State directory | The folder holding a context's database, worker files and workspace pool. By default it is `~/.docket/<context ID>/`. |
| Host | A program that Docket runs within, which provides infrastructure such as events, messages, questions and an interface. bb is the first host. |
| Supervisor host | Where the supervisor's conversation runs: Pi or bb. It can differ from the launcher that runs the workers. |
| Launcher | What starts a worker, sends it messages, observes it and stops it. Version 1 has two: `pi` runs Pi as a separate process, and `bb` runs the worker as a bb thread. |
| Provider | The agent a worker or supervisor runs, such as Claude Code, Codex or Pi, with its model. |
| Profile | A named set of worker settings: the launcher, provider, model and limits. |
| Worker reference | The identifier a launcher returns for a worker, such as a bb thread ID or a Pi process and session. |

## Reading order

| Document | Defines |
| --- | --- |
| [Domain and operations](domain.md) | Identity, task/attempt lifecycle, effects, authority, review, checks, budgets and questions |
| [Storage](storage.md) and [starting schema](schema.sql) | Seven tables, zero triggers, transaction rules, events and future migrations |
| [CLI and configuration](contracts.md) | Version 1 command contract, catalogue, schemas, profiles and error semantics |
| [Adapters and hosts](adapters.md) | Launcher, workspace, repository and check boundaries, Pi and bb qualification |
| [Acceptance scenarios](acceptance.md) | Observable success, refusal, race and crash cases mapped to requirements |
| [Scope and release requirements](delivery.md) | Supported capabilities, exclusions, verification and context activation |

These documents form one specification. Requirement IDs R01–R40 are normative. Scenario IDs A01–A60 identify their acceptance evidence. Tables and examples that define fields or transitions are normative; SDK implementation candidates are identified separately.

## Design constraints

- bb support is required for everyday use. Standalone Pi uses the same domain operations.
- The CLI and configuration have explicit versioned contracts. Compatibility aliases and support for other database families are outside scope.
- The database starts at schema version 1 and supports future migrations.
- The schema has zero triggers. Constraints enforce relational integrity; explicit transactional operations enforce domain rules.
- Tests cover domain decisions, storage transactions, adapter contracts and essential process/crash boundaries.
- Every operation preserves attempt identity, scoped authority, exact evidence, retained work and uncertainty about external effects.

## System design

- One context and backing repository per database. Many independent context databases can exist on one machine. Cross-context task stores and relocation are deferred.
- Seven application tables: objectives, tasks, dependencies, attempts, events, requests and claims. Events record domain, session and question evidence; current task and attempt state is stored directly.
- Docket runs the full checks itself, once, in the attempt's own workspace after the worker has stopped. Workers run fast checks while they work.
- Automatic reuse of a review after rebase is deferred. A new commit requires new exact-commit evidence.
- Rebase, acceptance and workspace return are separate operations. An operator can inspect the new candidate before authorising acceptance.
- A restricted Pi supervisor supports unattended supervision. An ordinary bb supervisor is explicitly unrestricted until tool restrictions are demonstrated.
- The first everyday-use release supports manual and local fast-forward integration. Pull-request publication and ACP follow later.

## Requirement index

| ID | Requirement | Defined in |
| --- | --- | --- |
| R01 | One authoritative context/repository/database identity | [Domain](domain.md#identity-and-scope) |
| R02 | Task lifecycle, readiness, ordering and dependencies | [Domain](domain.md#tasks) |
| R03 | Definition and person-decision revisions | [Domain](domain.md#tasks) |
| R04 | Atomic reservation, capacity and request replay | [Domain](domain.md#reservation-and-allocation) |
| R05 | Immutable specification and verified allocation | [Domain](domain.md#reservation-and-allocation) |
| R06 | One launch-or-fence decision and binding before activation | [Domain](domain.md#worker-lifecycle) |
| R07 | Separate turn, result, terminal worker and process termination facts | [Domain](domain.md#worker-lifecycle) |
| R08 | Unknown owner state and stale claims never permit work | [Domain](domain.md#worker-lifecycle) |
| R09 | Durable external-effect intent and reconciliation | [Domain](domain.md#requests-and-effects) |
| R10 | Outcome, acceptance, integration and return are separate | [Domain](domain.md#completion-acceptance-and-return) |
| R11 | Exact retained output and result-file integrity | [Domain](domain.md#completion-acceptance-and-return) |
| R12 | Safe continuation from retained output | [Domain](domain.md#continuation-and-review) |
| R13 | Independent exact-commit review and verdict | [Domain](domain.md#continuation-and-review) |
| R14 | Rebase creates a new candidate with fresh evidence | [Domain](domain.md#completion-acceptance-and-return) |
| R15 | Trusted check policy and evidence identity | [Domain](domain.md#checks) |
| R16 | Full checks run by Docket after the worker stops, with bounded concurrency and reusable results | [Domain](domain.md#checks) |
| R17 | Caller authority is supplied by trusted host code | [Domain](domain.md#authority-and-objectives) |
| R18 | Scope, permissions and person-only actions | [Domain](domain.md#authority-and-objectives) |
| R19 | Explicit objective completion with evidence | [Domain](domain.md#authority-and-objectives) |
| R20 | Session usage, budgets, unknown values and deadlines | [Domain](domain.md#usage-and-budgets) |
| R21 | Durable questions, answers and channel-specific delivery | [Domain](domain.md#questions-and-supervisor-continuity) |
| R22 | Ordered notifications, delivery and handled acknowledgements | [Domain](domain.md#questions-and-supervisor-continuity) |
| R23 | Compact briefing, notes and classified person actions | [Domain](domain.md#questions-and-supervisor-continuity) |
| R24 | Seven tables and zero triggers | [Storage](storage.md) |
| R25 | Explicit transactional storage and write-once evidence | [Storage](storage.md#write-contract) |
| R26 | Schema-family identification and future migration admission | [Storage](storage.md#schema-family-and-future-upgrades) |
| R27 | Versioned CLI envelope and stable refusals | [Contracts](contracts.md#response-contract) |
| R28 | One operation/tool catalogue and trusted binding | [Contracts](contracts.md#operation-and-tool-catalogue) |
| R29 | Canonical configuration and named execution profiles | [Contracts](contracts.md#configuration) |
| R30 | Dry-run/execution agreement | [Contracts](contracts.md#plans-and-errors) |
| R31 | Reference-based launcher and capability contract | [Adapters](adapters.md#launchers) |
| R32 | Workspace ownership and safe return contract | [Adapters](adapters.md#workspaces-and-repository) |
| R33 | bb first-message admission, later-turn guard and detection, and uncertain sends | [Adapters](adapters.md#bb-launcher) |
| R34 | bb plugin environment provider and deferred bb features | [Adapters](adapters.md#bb-host) |
| R35 | Minimal standalone Pi and restricted supervisor | [Adapters](adapters.md#standalone-pi) |
| R36 | No speculative launch, replay or duplicated infrastructure | [Adapters](adapters.md#ownership-boundaries) |
| R37 | Boundary tests and measured time budgets | [Delivery](delivery.md#testing) |
| R38 | Host/platform qualification and everyday-use evidence | [Delivery](delivery.md#release-evidence) |
| R39 | Safe context initialisation and activation | [Delivery](delivery.md#context-initialisation-and-activation) |
| R40 | Permanent identities and bounded diagnostic retention | [Storage](storage.md#retention) |

## Required qualification

Host support requires evidence for two technical gates:

- Q1: Verify that the bb launcher admits the first prompt only after launch permission, that the Docket plugin's hook refuses later turns for a finished attempt through ordinary dispatch, and that Docket detects a later turn that bypasses the hook before it checks, accepts, integrates or returns the attempt's output.
- Q2: Identify the pinned bb/provider combinations that give trustworthy terminal-state observation and keep a worker's workspace until the core returns it, and record which resources a worker actually loads.

[Adapters](adapters.md#qualification-gates) defines the experiments and required outcomes. An adapter cannot be qualified without satisfying the applicable requirements.
