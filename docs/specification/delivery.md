# Scope and release requirements

Status: draft, part of the [Docket specification](README.md).

## Supported capabilities

The first release supports the following capabilities before it is ready for everyday use.

| Area | Required behaviour |
| --- | --- |
| Tasks and attempts | Local CLI; dependencies, holds, ordering and revisions; immutable specifications; foreground dispatch and bounded concurrent attempts |
| Storage | Seven-table SQLite schema, zero triggers, transaction durability, request deduplication, scoped confirmations and safe future migrations |
| Context identity | One context and repository per database, with canonical configuration and permanent database/attempt identities |
| Output | Separate acceptance, integration and lease return; explicit discard/reconciliation; retained code and report artefacts; safe output-ref cleanup |
| Integration | Manual acceptance and local fast-forward integration, subject to operator/repository restrictions |
| Person acceptance | Candidate-scoped override of missing/failed independent evidence only with an explicit recorded reason; other safety prerequisites remain mandatory |
| Rebase | Exact candidate rebased onto a moved target, with new checks and exact-commit review |
| Continuation and review | New attempt from retained output, bounded handover, independent code review and repair |
| Checks | Trusted fast/full policy, full checks run by Docket once the worker stops, bounded concurrency and reusable evidence identified by commit, definitions and profile |
| Profiles | Named launcher and model settings within canonical context policy |
| Objectives | Scoped permissions, token/cost/time budgets, deadlines and explicit evidence-backed completion |
| Continuity | Worker/person questions, notes, ordered notification delivery/admission/handled state, compact briefings and classified person actions |
| CLI and tools | Versioned results/configuration, one described tool catalogue, separate dispatch/continue operations and dry-run/execution agreement |
| bb | Workers, retained environments, messages, questions and minimal status UI; ordinary supervisor sessions recorded as unrestricted unless separately qualified |
| Pi | Standalone worker/CLI, restricted supervisor for unattended supervision, essential question/status presentation and bounded briefing context |
| Diagnostics | Eligible diagnostic cleanup with permanent identity/evidence retention; visible provider failures and explicit continuation |
| Platforms | macOS workflow qualification; Linux/Windows CI and explicit qualification status |

## Exclusions

| Capability | First-release boundary |
| --- | --- |
| Other database families and CLI/configuration versions | No compatibility aliases, partial-record fallbacks or format-specific importers |
| Shared task stores across contexts/repositories and context relocation | Each database has one context/repository identity |
| Automatic review carry-over after rebase | A new commit requires new exact-commit evidence |
| Linked review of artefact-only candidates without a Git target | Reports support digest-backed acceptance; linked review requires a Git candidate |
| Additional Pi UI variants and custom provider-retry delays | Essential questions/status are supported; terminal failure requires explicit continuation |
| Claude Code supervisor host and Claude ACP launcher | Outside the first release |
| Pull-request publication and forge merge tracking | Integration supports manual and local fast-forward policies |
| Independent background dispatcher, mailbox, scheduler and external-event service | Hosts provide transport and scheduling; core requests execute explicitly authorised work |
| Proof that every process a worker started has stopped | Automatic lease return depends on committed, retained work, not on process state |
| Event-history compaction, request-key expiry and permanent-identity deletion | Domain identities and evidence remain available |
| Worker-requested full checks | Workers run fast checks; Docket runs the full checks once the worker stops |
| Check layers other than fast and full, and check policies configured per repository | Every repository has fast and full checks only |
| Named objective presets | Permissions and budget are given for each objective. Presets in the context configuration, copied into an objective when it is created, can follow |
| Showing the session kind in bb's own interface, such as a badge on the supervisor's thread | Status, the briefing and objective show give each supervisor session's kind |
| Multi-machine/distributed operation, concurrent autonomous objectives and workers spawning agents | One-machine ownership and bounded attempt concurrency |

## Verification milestones

Each milestone has observable exit evidence.

| Milestone | Required evidence |
| --- | --- |
| M1: contracts and host feasibility | Schema/envelope/tool examples validate; Q1/Q2 establish a conforming bb admission, resource and terminal-state mechanism using pinned SDK/provider versions |
| M2: storage and domain operations | Tasks/graph, requests/claims, immutable specifications/events, known/unknown observations and pure decisions satisfy applicable A01–A16 and A48–A54 cases |
| M3: standalone execution | One real Pi task demonstrates exact allocation/prompt/result, candidate retention, held outcome and person-confirmed return through the common operations |
| M4: evidence and supervision | Checks/slots, reviews, continuations, rebase, acceptance/integration/return, objectives/budgets/questions/events, catalogue and restricted supervisor satisfy applicable A17–A47 cases |
| M5: bb workflow | Qualified launcher and environment mechanism, trusted caller binding, startup reconciliation and minimal UI satisfy A55–A57 |
| M6: release qualification | A60 real objective, cross-platform checks, A59 context activation, complete requirement/evidence mapping and operator documentation |

## Testing

**R37.** Default local layers, after dependencies are installed:

| Layer | Tools/owners | Target |
| --- | --- | --- |
| Pure rules/schema validation | Values and controllable time | <=5 seconds |
| Application/storage operations | Real temporary SQLite; fake launcher, workspace, repository and check owners | <=15 seconds |
| Adapter contracts | Real relevant Git/Treehouse/OS operations and synthetic protocol/provider peers | <=30 seconds |
| CLI and essential processes | One smoke per family plus distinct lock/admission/death cases | <=10 seconds |

Full local target is under 60 seconds; routine worker fast checks under 10 seconds on the development machine. These are measured engineering budgets, not correctness assertions tied to a particular processor. CI qualifies storage/operation/adapter behaviour across macOS/Linux/Windows with separately measured budgets.

Operation fixtures use real temporary SQLite and fake external owners. Real repositories/processes are reserved for tests of their contracts and distinct end-to-end boundaries. Shared contract suites check real adapters and their fakes against the same failure semantics. Races use barriers/condition waits rather than arbitrary sleeps. The default suite includes bounded contention regressions; repeated OS stress rounds run in an explicit job.

Each test proves a stated behaviour or risk. There is no test-count, line-count or coverage-percentage target. A test may cover several requirements. Transaction, uncertain-effect and real-process evidence remains at the appropriate boundaries.

Full-check evidence is produced once per matching candidate/check identity. Docket runs it once the worker stops; reviewers inspect the record and run focused checks where needed; acceptance/completion reuse it. A60 records actual command counts. Paid model tests are explicit qualification experiments, outside the default suite.

## Release evidence

**R38.** The everyday-use release requires:

- All R01–R40 requirements mapped to passing acceptance evidence at the released commit, with no missing required scenario.
- Pinned bb SDK/host/provider and Treehouse/Pi versions, qualification source/type evidence and Q1–Q2 outcomes.
- Real bb A60 workflow with two independent tasks and a dependant, question/answer, failed review/repair, moved target/rebase, check reuse, explicit acceptance and objective completion.
- Supervisor restart while a worker runs, with no duplicate activation. Person interventions reported separately from setup/cleanup/lease returns.
- Real standalone Pi dispatch, restricted-supervisor tool restriction evidence, and observed limits of process/host guarantees.
- macOS acceptance plus Linux/Windows CI for storage/operation/adapter contracts. Platforms/providers without a real host workflow are labelled not yet fully qualified. Required safety capabilities cannot be silently skipped.
- Local fast/full timing and check invocation counts, example configuration/catalogue/operator recovery documentation, and successful context activation.
- This specification, edited into plain prose, describes the released behaviour, with a short README giving the purpose, installation, limits, examples and links.

### Current platform qualification (R38)

CI runs the same type check and default test suite on macOS, Linux and Windows. It installs Treehouse 3.1.4 for the runner's OS and Node architecture, verifying the archive against that release's `checksums.txt` before extraction. A green contract suite is not real-host workflow qualification. Linux and Windows remain not yet fully qualified for R38 until real host workflows and platform timing evidence are recorded. These changes were checked locally on macOS only; Windows and Linux execution still needs CI confirmation.

The strict R31 environment allowlist is not qualified on Windows. Node 26.7.0's libuv 1.52.1 restores Windows system/account variables even with an explicit child environment. Its `src/win/process.c` `required_vars` list includes `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE` and `WINDIR`. The Pi adapter replaces home/temp paths with private paths. The environment test asserts the remaining OS-added variables and their host values. This limit does not permit inheriting other variables or credentials. See [libuv 1.52.1 process creation](https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c).

Pi's private process directory uses owner-only POSIX permissions on macOS/Linux and an owner-only inheritable Windows ACL on Windows (R31/R35). The adapter test checks the relevant access-control mechanism, not Windows' synthetic POSIX mode bits. Execution profile files similarly use POSIX write permissions or a Windows ACL check: only the current user, SYSTEM and Administrators may own the file or have write access (R29/R31). Membership in Administrators does not make the current user's SID equal to the Administrators SID; both are allowed explicitly. The ACL probe uses SIDs rather than localised account names and PowerShell's UTF-16LE `-EncodedCommand` transport. Passing a script containing double-quoted strings through Node's Windows argument quoting to `-Command` can change those strings before PowerShell parses them, causing a fail-closed refusal even for a trusted ACL. The Pi directory ACL assertion uses the same encoded transport. Profile refusals report fixed condition names, never parser input, file contents or credential values. These checks do not qualify a real Pi workflow or isolation from an administrator. The optional paid/credential-backed Pi probe remains outside the default suite on every OS; R35/R38 real dispatch evidence is still required.

Real Git fixtures use LF without automatic conversion and portable space/Unicode filenames. A synthetic Git response separately tests newline-containing paths on every platform because Windows cannot create those filenames (R32). No platform drops the NUL-delimited parsing assertion. Directory-link fixtures use Windows junctions where needed; regular-file link tests still run and require symlink privileges on the runner.

## Context initialisation and activation

**R39.** Docket initialises a database only at an explicitly selected empty path. It records a database UUID and uses that identity in state-directory paths and output refs. An incompatible or nonempty database is refused without replacement.

Before enabling execution for a repository:

1. Inventory relevant worker/supervisor/check processes, uncertain effects, retained leases, artefact roots and output refs. Resolve activity that could conflict with the context; an empty attempt list alone is insufficient.
2. Validate the task/objective set, including definitions, criteria, order, holds, dependencies, permissions and budgets. Transferred definitions are recreated through the supported operations, with counts/fields/readiness compared against the transfer manifest. A transfer must not relabel another context's attempts as this context's work.
3. Preserve output and explicit ownership/recovery records for every retained allocation. Lease return requires the normal scoped person confirmation.
4. Back up any state being transferred consistently, using SQLite's backup API or a quiesced checkpoint/close. Archive its evidence, configuration, code version, refs and path/ownership manifest. Copying only the database file while WAL is active is insufficient.
5. Validate that database and state-directory paths and output-ref namespaces do not collide with another context. A mismatch or transfer discrepancy prevents activation.
6. Configure CLI/host bindings for the context and run read-only status followed by the qualification smoke workflow.
7. Keep the transfer/activation manifest and a recovery procedure. Before execution, configuration can be restored directly. After execution begins, stop/settle and reconcile its workers/effects/leases before restoring another configuration or database.

No initialisation or configuration change implicitly deletes branches, returns leases, starts workers, installs a plugin or publishes work.
