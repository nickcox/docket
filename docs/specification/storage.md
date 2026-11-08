# Storage and transaction contract

Status: draft, part of the [Docket specification](README.md). Requirement IDs refer to its index.

## Starting schema

**R24.** [schema.sql](schema.sql) is the normative v1 physical starting schema: seven application tables and zero triggers. SQLite-maintained internal indexes are not additional application tables. Code must not create triggers during initialisation or future migrations. A schema test queries sqlite_schema for both table and trigger counts.

The opener verifies a canonical regular file on retained local storage outside recyclable roots; reject links, unsupported exclusive-file creation and a nonempty unknown schema. Use WAL, foreign_keys ON, synchronous FULL, fullfsync/checkpoint_fullfsync where supported, zero SQLite busy timeout and asynchronous bounded retry. Document weaker durability when an OS/filesystem cannot provide a requested guarantee. One module owns node:sqlite connection/locking mechanics.

All writes use BEGIN IMMEDIATE and synchronous callbacks. Never await a provider, model, process or filesystem operation while holding the database transaction. Connection-close paths run after errors as well as success. Short-lived reads use snapshots where a consistent multi-query view is required.

Only the storage implementation can use raw mutation SQL. Application operations call typed transactional methods, not arbitrary update/save maps. A schema column is not an invitation to expose it as a public input.

## Write contract

**R25.** Constraint enforcement and application enforcement are intentionally distinct:

| Invariant | Enforcement |
| --- | --- |
| Existing IDs, references, enum/range/JSON shape, unique attempt number/ref/lease/request/source key | SQL primary/foreign/unique/CHECK constraints |
| One execution-open attempt per task, one unreleased claim per resource | Partial unique indexes plus admission transaction |
| Graph acyclicity, readiness, capacity, permission and budget | Explicit reads/checks/writes under one write lock |
| Revision increments and stale-input refusal | Conditional UPDATE matching expected revision; require exactly one affected row |
| Immutable specification/allocation/reference/identity | Narrow methods only set them once; compare a duplicate against the recorded value |
| Append-only domain evidence | INSERT-only event method; duplicate source key must have identical logical content |
| Permitted state transitions and forward-only handled position | Typed methods with conditional old-state/revision predicates |

There are no UPDATE/DELETE/REPLACE event methods and no cascaded deletion of domain identities. INSERT OR REPLACE is prohibited for all seven tables. An existing source key with different content is a conflict, not a successful deduplication. Arbitrary direct SQL can bypass write-once/application rules; this design provides an application boundary, not a database security boundary.

Current fields and their explanatory event commit together. Examples:

- Reserve request + numbered attempt + immutable specification + action event.
- Start task + capture decision revision + attempt progress + event.
- Choose launch permission/fence + owner claim/bound reference + event.
- Record terminal/result/check facts + attempt outcome + any applicable task hold + notification.
- Record review task outcome + source verdict.
- Record answer + immutable question-answer event + delivery requests.
- Change objective permissions/membership + decision classification + notification.

Method failures roll the entire write back. Constraint failures become stable domain conflicts. A uniqueness race cannot fall back to an unchecked update.

Claims on multiple resources are inserted in sorted resource-key order in one transaction or all refused. A worker owner uses worker:<attemptId>; a supervisor holds both context-supervisor and objective-supervisor:<objectiveId>; a check run uses checks:<slot> and its request identity. Permanent claim history is retained after release. Explicit stopping does not release a slot until terminal/confirmation evidence is recorded.

## Evidence shapes

All payloads are strictly validated when read. Unknown fields refuse at public/adapter boundaries, except explicitly opaque provider diagnostic objects that never grant permission. Unknown payload versions needed for safety refuse the operation; inspection still exposes a bounded unsupported-version diagnostic.

| Event family | Required logical content |
| --- | --- |
| database.initialised | databaseId UUID, contextId, repository identity, state directory, createdBy, schema family |
| context.configured | revision, complete resolved non-secret config, digest and provenance |
| context.recovery_started / context.recovery_completed | Restore/recovery reason, inventory evidence and person confirmation; execution stays blocked between these facts |
| action.recorded | action ID, operation, person/supervisor, membership before/after, setup/intervention/cleanup classification or null |
| attempt.* | attempt identity, event-specific immutable specification/allocation/outcome reference |
| result.validated | matching worker identity, complete content, source digest/path, validation version/time |
| output.selected / output.accepted / output.integrated / output.rebased | Exact candidate and originating attempt; approvals/policy/old and new refs relevant to that operation |
| confirmation.recorded | fact, actor, time, note and exact scope: lease/return request, effect/result or worker/session |
| review.recorded | source and review attempt IDs, candidate/criteria identity, verdict, complete criterion findings |
| checks.completed | evidence key, the attempt and its allocation, commands/profile/policy identity, exact commit, statuses, durations and bounded diagnostic references |
| session.registered | session ID, worker/supervisor kind, objective fixed at registration, worker reference, restriction/capabilities |
| usage.observed | session, source sequence, high-water values and availability/currency per metric |
| question.created / question.invalid / question.answered | Stable question ID, scope/recipient or answer, immutable content and source identity |
| supervisor.* | Session state, error/reason, related notification IDs; explicit resumed/retrying/stopped facts where supported |
| notification.* | Domain source reference, kind and objective; notified events set notification=1 |
| note.recorded | Nonblank text, objective and actor |
| request.reconciled | Effect ID, outcome proof/confirmation and any newly authorised successor request |

The initialiser inserts the genesis/configuration events in the creation transaction. No metadata table is needed. Current canonical configuration is the latest context.configured event; initialisation is protected by source_key database.initialised. Context reconfiguration is person-only and requires quiescence as for schema admission; operations compare their resolved config digest/revision with the recorded value. Changing a file alone does not reconfigure a running context.

Attempt allocation and worker reference are immutable bindings. Candidate is a revisioned projection of immutable selection/rebase events, not a mutable worker report. Acceptance is its own immutable event referring to a candidate identity; replacing the candidate does not move old acceptance to the new one. An operation validates task/attempt/objective consistency when storing references, in addition to the SQL foreign keys.

Object identity uses generated UUIDs; integer event seq determines database recording order. Host occurrence time is diagnostic and cannot reorder permissions or handled positions. A recorded notification cursor is a global seq interpreted only for that objective's notification events.

## Schema family and future upgrades

**R26.** The database family is PRAGMA application_id 0x444B5431 (DKT1), with SQL user_version 1 initially. The CLI and configuration are also at version 1; the versions are independent. A database with another or missing family marker is refused without alteration, even when its user_version is 1.

Ordinary status/plans open read-only without migration or new probe files. A missing database gives not_initialised; context init creates it deliberately. Mutations may migrate an older recognised family automatically only when admission succeeds. status can report a pending migration through version-independent metadata/claims reads without interpreting incompatible domain payloads. Newer/unknown schemas refuse writes and expose both versions.

Migration protocol:

1. The initial opener validates identity and acquires BEGIN IMMEDIATE.
2. Re-read family/version under the lock. If already upgraded by another opener, use that version; do not run again.
3. Require no execution-open attempts, pending/claimed/uncertain external effects, and no unreleased relevant claims. A pending pure query/notification delivery does not imply a worker can act, but must be version-compatible before resumed delivery.
4. An unresolved stale/future claim blocks exactly as a fresh one. Explain the claim, attempt/session/effect and required resolution. Never use OS process scanning to infer migration permission.
5. Run numbered forward-only changes and update user_version in the same transaction; failure rolls back. Before upgrade make a consistent backup at a recorded path.
6. Every mutation rechecks family/version/config/claim generation under the write lock. Long-running processes register their claims before doing work and recheck before effects; they cannot keep using an older prepared connection after upgrade.

A process paused between final authority check and a remote call cannot be remotely fenced merely by an SQLite value. Therefore never forcibly release/migrate over a possibly live executor. Migration recovery requires a person's explicit stopped-process confirmation scoped to each unresolved claim. Migration requires ownership resolution followed by normal admission; no force option can bypass it.

Future migrations preserve the zero-trigger constraint. Use declarative constraints plus explicit conversion and domain methods. Test each supported migration from its preceding version, including rollback and concurrent admission.

Restoring a backup is not ordinary restart: external workers/effects can outlive records rolled back by the restore. The supported offline procedure keeps all executors stopped, restores the file, and runs context.recovery-begin before starting any host. A context.recovery_started event blocks every activation/reservation/migration until a corresponding person-authorised context.recovery_completed event. Owner inspection, recorded observations and scoped person resolution remain available. Inventory external leases/threads/claims for the database UUID, including ones absent from the restored rows; keep unaccounted output/leases and diagnostics until positively resolved. context.recovery-end validates this inventory and requires explicit person confirmation before enabling execution. An ordinary copied file cannot be detected reliably from the restored database alone and is not a supported resume procedure. Release documentation must include the quiesced restore/recovery procedure; never imply that opening a backup authorises replay.

## Retention

**R40.** Never delete tasks, attempts, command request keys, claims, approvals, results, check/review evidence, question records or their source keys in v1. Event history remains small authoritative data; diagnostics/transcripts are separate bounded artefacts.

Diagnostic retention can remove an eligible terminal attempt's diagnostic directory through a deletion effect only when no live/uncertain worker, retained lease, unresolved effect or referenced deliverable depends on it. Keep required artefacts outside that directory or refuse deletion. Its immutable manifest records what was removed and when; subsequent request replay still resolves the original attempt.

Deletion interrupted after intent remains uncertain while the directory exists. Proven absence can settle it without another deletion; uncertain existing contents need inspection. Bounded Pi activity/transcripts and bb timeline references are diagnostic only and may be unavailable without altering task state.

Event compaction, request-key expiry and permanent-identity deletion are outside the first release. Attempt identity and retained evidence stay in the same tables after diagnostic cleanup.
