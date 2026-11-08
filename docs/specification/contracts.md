# CLI, tools and configuration

Status: draft, part of the [Docket specification](README.md).

## Invocation

The CLI contract, configuration format, tool catalogue and worker protocol each start at version 1, and the SQL schema also starts at 1. Each is versioned independently, as are event payloads.

Canonical form:

~~~text
docket <group> <operation> --input <json-file> --config <context-file> --json [--request-id <key>]
docket <group> <operation> --stdin --config <context-file> --json [--request-id <key>]
docket catalog show --json
docket host invoke <operation> --binding <private-file> --input <json-file> --json --request-id <key>
~~~

`--context <name>` can replace `--config <context-file>`. It looks the name up in a per-user registry, `~/.config/docket/contexts.json`, which maps each context name to its configuration file. context.init adds the entry, and refuses a name that is already registered.

Input is the operation's args object, not an executable command or caller record. Empty args use {}. Exactly one of input/stdin is allowed; read-only no-argument operations can omit both. Human convenience flags may be generated from the same catalogue later; they are not an initial requirement. Help documents the JSON fields and examples.

The ordinary entry point constructs the OS person caller. host invoke reads a host-created, permission-checked private binding, fixes context/objective/session/role and calls the same operation. A worker binding permits only its own question and result operations. It cannot invoke supervisor/person operations.

Person mutations can generate a request ID, printed in the response. Host mutations require a stable ID derived from session + tool-call ID + operation, reused across replay. Keys are unique within the database; caller binding is included in the fingerprint, so another caller cannot claim the same key. Arbitrary message text is not a source of request identity. Public requestId is this replay key; internal requests.id is a generated UUID used for parent/effect links.

## Response contract

**R27.** Ordinary JSON commands emit exactly one UTF-8 JSON object on stdout on success, refusal, parse/configuration failure and unexpected failure. Progress belongs on stderr; credentials and raw environment never appear. The maximum default response is 256 KiB; detailed logs are separate artefacts with bounded summaries. Large list operations use explicit pagination.

~~~json
{
  "version": 1,
  "operation": "attempt.dispatch",
  "requestId": "tool-session-call-17",
  "outcome": "accepted",
  "code": "dispatch_reserved",
  "data": {
    "attemptId": "10000000-0000-4000-8000-000000000001",
    "taskId": "write-notes",
    "number": 1,
    "phase": "reserved"
  },
  "diagnostics": [],
  "nextAction": {
    "operation": "request.show",
    "args": { "requestId": "tool-session-call-17" },
    "description": "Read the request's current progress."
  }
}
~~~

All top-level fields are required. requestId is null for uncorrelated reads. data is an operation-specific object. diagnostics is an array of {code,message,owner,retryable}, where owner is string|null and retryable is boolean. nextAction is the shown object or null. No duplicate summary/detail fields have conflicting meanings.

outcome is succeeded, accepted, refused or failed. accepted means durable work exists but is not complete. code is a stable machine value; prose is not a programmatic contract. A worker task held for review is a successfully recorded operation with code attempt_held, not an unexpected CLI failure.

| Exit | Meaning |
| --- | --- |
| 0 | succeeded or accepted |
| 1 | Expected domain refusal, including retryable read/uncertainty |
| 2 | Invalid arguments/input/configuration, unknown operation/version |
| 3 | Unexpected internal failure; do not infer absence of effects |

Errors still use the envelope; schema validation diagnostics name bounded field paths. If JSON mode is requested, even parser errors must obey framing. Signals after reservation leave a request ID/progress record for inspection when possible. A broken output pipe cannot roll back a committed request.

status watch emits newline-delimited version-1 envelopes, each with its recorded sequence. No arrays mixed with text. It terminates with a final envelope or a diagnostic on a broken pipe. A read watch never marks notifications handled.

Core data views:

| View | Required content |
| --- | --- |
| task | id, title, instructions, criteria, kind, profile, objectiveId, state, holdReason, position, definitionRevision, decisionRevision, blockedBy, ready |
| attempt | full identity, phase/executionOpen, launchState, immutable specification/allocation/workerRef, candidate, terminal evidence, outcome, taskTransitionApplied, acceptance/integration/lease facts and revision |
| request | ID/key/operation/state, selected attempt, linked effects with outcomes, bounded diagnostics and next action |
| status | context identity/config revision, migration state, capacity, compact tasks/attempts, objectives, open person questions, claims/effects with unknowns, and counts/pagination |
| evidence | candidate identity, required check-set identity and each result, exact review/verdict, scoped acceptance and blockers |

Status task records contain id, title, state, ready, holdReason and blockedBy. Status attempt records contain id, taskId, number, phase, outcome, leaseState, candidateCommit and checksState. They do not contain task instructions or the immutable attempt specification; `attempt.show` supplies full attempt detail. Both compact records also contain reason and nextAction, nullable when no action is needed. With `attentionOnly: true`, only items needing a person or supervisor are listed, each with a reason and next action. Claims, effects and blockers retain their existing fields, with attention explanations added in that mode.

## Operation and tool catalogue

**R28.** One core catalogue defines operation name, description, strict input JSON Schema, allowed caller roles, binding-derived fields, whether it mutates, whether it plans, output schema and tool presentation. catalog show emits catalogueVersion 1 and these definitions. Hosts register tools and encode CLI input from it. They do not copy schemas or argument conversion.

Every input property is required; nullable means the explicitly documented absence/default. Unknown fields refuse. Nested tool-input objects follow the same rule. The table below defines required fields; a notation such as String|null is a union, not an optional field. All mutations except context init use command replay records.

Shared types:

- Id: nonempty slug for task/objective/context, or UUID where identified as generated.
- Revision: nonnegative integer. Expected task revision refers to definitionRevision; state operations also condition on current decisionRevision inside the operation.
- Commit: 40 or 64 lower-case hexadecimal characters.
- Text: nonblank UTF-8 text, at most 64 KiB unless bounded more tightly.
- Criteria: ordered array of nonblank single-line strings, maximum 100, each at most 2 KiB.
- Definition: title, instructions (may be empty), criteria, kind (code|report|review), profile (name|null).
- Page: {after: string|null, limit: integer 1..100}; null starts at the beginning.
- Attempt selector: an exact attemptId UUID. There is no competing lease/task/latest selector in agent tools.

The operation-specific schema for ordinary task.add restricts kind to code/report. task.update cannot alter a linked review's captured criteria/target instructions or convert a task into a linked review. Only attempt.review constructs that target.

| Operation | Required args | Roles and behaviour |
| --- | --- | --- |
| context.init | {} | Person; create a new empty family/config identity |
| context.configure | dryRun:boolean | Person; validate/apply supplied context config under quiescence |
| context.migrate | dryRun:boolean | Person; normal admission only |
| context.recovery-begin | reason:Text | Person; record recovery mode after offline restore, before any host/executor starts |
| context.recovery-end | inspection:Text, confirmOwnersReconciled:boolean, dryRun:boolean | Person; require resolved inventories/effects/claims before enabling execution |
| catalog.show | {} | Read; no config needed |
| status.show | attentionOnly:boolean, page:Page | Person/supervisor; scoped views |
| status.watch | afterSequence:integer, timeoutMs:integer\|null | Person/host; bounded stream |
| task.add | id:Id\|null, definition:Definition, objectiveId:Id\|null | Person/supervisor; bound objective for supervisor; a null id generates a readable ID from the title, with a numeric suffix if it is taken |
| task.show | taskId:Id | Scoped read |
| task.list | state:queued\|in_flight\|done\|null, readyOnly:boolean, page:Page | Scoped read |
| task.update | taskId:Id, expectedRevision:Revision, definition:Definition | Replace definition fields explicitly; scope cannot change here |
| task.move | taskId:Id, expectedRevision:Revision, objectiveId:Id\|null | Person only |
| task.hold | taskId:Id, reason:Text | Scoped mutation; reason max 200 single-line characters |
| task.release | taskId:Id | Scoped mutation |
| task.block / task.unblock | taskId:Id, blockerId:Id | Scoped mutation |
| task.reorder | orderedTaskIds:Id[] | Scoped mutation; unique existing IDs, reorder only this scope |
| task.done / task.reopen | taskId:Id, note:Text\|null | Scoped judgement; does not invent accepted evidence |
| attempt.dispatch | taskId:Id\|null, profile:String\|null, dryRun:boolean | Person/supervisor; null task selects first ready, null profile uses resolved default |
| attempt.continue | sourceAttemptId:UUID, profile:String\|null, note:Text\|null, dryRun:boolean | Person/supervisor; separate from fresh dispatch |
| attempt.show | attemptId:UUID | Scoped full detail |
| attempt.review | attemptId:UUID, dryRun:boolean | Person/supervisor; create exact-target review task |
| attempt.rebase | attemptId:UUID, dryRun:boolean | Person/supervisor with rebase permission; no acceptance |
| attempt.accept | attemptId:UUID, candidateCommit:Commit\|null, overrideReason:Text\|null, dryRun:boolean | Person/supervisor; null selects recorded candidate, explicit commit selects committed output; only person can override missing checks/review with a reason |
| attempt.stop | attemptId:UUID, dryRun:boolean | Person/supervisor; request stop, never claim stopped merely from request |
| attempt.steer | attemptId:UUID, message:Text, mode:active\|after_turn, dryRun:boolean | Person/supervisor; capability checked before delivery |
| attempt.return | attemptId:UUID, dryRun:boolean | Person; applies the same checks as automatic return |
| attempt.discard | attemptId:UUID, confirmDiscard:boolean, reason:Text, dryRun:boolean | Person only |
| effect.resolve | effectId:UUID, outcome:happened\|not_happened, evidence:Text, confirmStopped:boolean, dryRun:boolean | Person; specialised owner read must still agree |
| claim.resolve | claimId:UUID, confirmStopped:boolean, evidence:Text, dryRun:boolean | Person; stale alone insufficient |
| request.show | requestId:String | Scoped read of the exact public replay key |
| checks.run | attemptId:UUID, commit:Commit, dryRun:boolean | Person/supervisor; runs the checks for a recorded candidate of a terminal attempt that has no matching result, for example an explicitly selected commit or a new run after a failure |
| question.ask | text:Text, choices:String[]\|null, waiting:boolean | Worker/supervisor; recipient derived from binding |
| question.answer | questionId:UUID, text:Text | Person/supervisor according to recipient/scope |
| objective.add | id:Id, request:Text, criteria:Criteria, scope:String, constraints:String, permissions:Permissions\|null, budget:Budget\|null, deadline:String\|null | Person; null selects documented defaults |
| objective.show | objectiveId:Id | Scoped read |
| objective.update | objectiveId:Id, expectedRevision:Revision, criteria:Criteria, scope:String, constraints:String, permissions:Permissions, budget:Budget, deadline:String\|null | Creator for protected fields; supervisor cannot use this tool |
| objective.complete | objectiveId:Id, statements:CompletionStatement[] | Person/supervisor; exact criterion/evidence matching |
| objective.abandon / objective.reopen | objectiveId:Id, reason:Text | Abandon creator-only; reopen scoped manageTasks |
| objective.confirm-usage | objectiveId:Id, sessionGaps:UsageGap[], reason:Text | Creator only; exact session/metric gaps, never change values to zero |
| supervisor.start | objectiveId:Id, host:bb\|pi, profile:String\|null, restricted:boolean | Person; trusted host creates session/binding |
| supervisor.briefing | objectiveId:Id | Scoped read |
| supervisor.note | objectiveId:Id, text:Text | Person/supervisor |
| supervisor.pending | objectiveId:Id, afterSequence:integer, timeoutMs:integer | Host only; durable ordered notifications |
| supervisor.admitted | objectiveId:Id, deliveryRequestId:UUID, eventIds:UUID[] | Host only; confirms conversation admission |
| supervisor.handled | objectiveId:Id, eventIds:UUID[] | Supervisor; contiguous processed batch |
| host.observe | observation:Observation | Host service only; strict adapter observation |
| host.usage | report:UsageReport | Host service only; session-bound accounting |
| host.heartbeat / host.release | claimId:UUID, generation:UUID | Host service only; conditional ownership |
| diagnostics.clean | attemptId:UUID, noProcesses:boolean, dryRun:boolean | Person; only eligible diagnostic artefacts |

Permissions has the R18 boolean fields. An unknown field is refused, and a missing field takes the default set by the version that introduced it. Budget has exactly maxCost:number|null, currency:String|null, maxTokens:integer|null and maxWorkerTimeMs:integer|null. Cost requires currency; unlimited cost can retain a reporting currency. UsageGap has sessionId and metrics drawn from cost,tokens,workerTimeMs. CompletionStatement has position, statement and references; each reference has kind accepted_output|review, attemptId, candidateId, candidateCommit:Commit|null, artefactDigests:String[], evidenceEventId and reviewAttemptId:UUID|null. Code references require a commit; report-only references require retained artefact digests. Candidate IDs are generated UUIDs identifying immutable selection events.

Observation has sourceId, sourceSequence, attemptId, workerRef, observedAt, kind, payloadVersion and payload validated by kind. Allowed observation kinds are prepared, activation_observed, turn_ended, terminal, result_available, question and capability_failure. A host cannot submit output_accepted or no_processes as an observation.

UsageReport has sessionId, sourceSequence, observedAt, cost:{availability,value,currency}, tokens:{availability,input,output,total}, workerTimeMs:{availability,value}. availability is reported|unknown|unsupported; value fields are nonnegative or null consistent with availability. Supervisor workerTimeMs is unsupported.

Each agent tool name is derived deterministically from the operation name, for example dk_attempt_dispatch. Each field and operation has a literal description. Bindings remove fixed objective/attempt fields from the agent schema and supply them after validation; the model cannot supply an alternative. Person-only and host-only operations are excluded from a supervisor's catalogue. Agent status.watch is excluded; the host owns background waiting.

Private input files are created outside leased workspaces with exclusive creation and mode 0600 or equivalent OS ACL. Delete temporary files after the CLI has consumed them, retaining only non-secret necessary evidence. Body/criteria/newlines are encoded as JSON, never interpolated into shell commands. Binding creation/validation is implemented once in the core host transport.

## Plans and errors

**R30.** Planable operations accept required dryRun. They run the same typed prerequisites/remaining-step builder as execution, returning ordered {operation,target,requires,conditional} steps. No persistent effects occur. Re-read current authority/owners before each execution effect; a plan is not lasting permission.

A missing check result produces “run checks; accept if they pass” when other prerequisites allow it. Missing mandatory review still refuses supervisor acceptance before accepting/integrating. Rebase planning reports the candidate change and fresh-evidence requirement. Empty plans report already_complete.

Required stable refusal codes include:

~~~text
invalid_input unsupported_version not_initialised context_mismatch config_changed
schema_mismatch migration_waiting storage_busy not_ready task_changed
capacity attempt_limit existing_request request_input_mismatch
outside_objective permission_denied person_required creator_required
capability_missing owner_unknown owner_read_retryable owner_unresolved
effect_uncertain claim_unresolved launch_fenced
result_invalid result_identity_mismatch result_discrepancy
candidate_missing candidate_moved not_retained workspace_dirty
check_missing check_failed check_definition_changed review_missing review_failed
not_fast_forward rebase_conflict policy_refused protected_target
question_answered recipient_mismatch objective_closed completion_invalid
budget_reached usage_unknown metric_unsupported deadline_reached
process_confirmation_required discard_confirmation_required
~~~

expected refusal data names the blocking identity/evidence and next action. Unknown reads before effects can be retried; after intent they produce effect_uncertain, not a generic retry suggestion. Internal failure must expose any known committed request/attempt, never assert that nothing changed.

## Configuration

**R29.** Configuration format 1 is strict, canonical and person-controlled. context init stores identity and the non-secret resolved digest; configure changes it explicitly only while quiescent. Host/model inputs cannot select arbitrary config files. Credentials live in environment/credential facilities and are neither copied to evidence nor compared as policy.

~~~json
{
  "version": 1,
  "contextId": "docket",
  "databasePath": "/Users/me/.docket/docket/docket.db",
  "stateDirectory": "/Users/me/.docket/docket",
  "repository": "/Users/me/code/docket",
  "baseBranch": "main",
  "workspace": { "adapter": "treehouse", "poolRoot": "/Users/me/.docket/docket/pool" },
  "limits": { "maxAttempts": 2, "maxAttemptsPerTask": 3, "maxConcurrentFullChecks": 1 },
  "profiles": {
    "worker": {
      "launcher": "bb", "provider": "chosen-provider", "model": "chosen-model",
      "reasoning": null, "runMs": 3600000, "maxCost": null,
      "maxTokens": 1000000, "executionProfile": "bb-worker-v1"
    },
    "standalone": {
      "launcher": "pi", "provider": "chosen-provider", "model": "chosen-model",
      "reasoning": null, "runMs": 3600000, "maxCost": null,
      "maxTokens": 1000000, "executionProfile": "pi-worker-v1"
    }
  },
  "defaultProfile": "worker",
  "profileByKind": { "code": "worker", "report": "worker", "review": "worker" },
  "finalisation": { "kind": "local-merge", "targetBranch": "main", "globalFile": null, "forbid": [] },
  "checks": { "executionProfile": "node-project-v1", "fast": [], "full": [] },
  "supervisor": { "defaultHost": "bb", "piExecutionProfile": "pi-supervisor-v1" },
  "keepAwake": true
}
~~~

All shown top-level fields are required; null globalFile uses the conventional operator policy path, not no policy. Profiles are a nonempty map; no named profile can replace limits, authority or checks. profileByKind has all three kinds. A task profile wins over kind default; explicit dispatch profile wins if configured/allowed; the resolved settings are frozen at reservation. A profile's executionProfile resolves host-specific non-secret adapter options and credential references from person-controlled host configuration. Adapter options have strict schemas and are preflighted before reservation.

The initialisation wizard places the state directory (stateDirectory) at `~/.docket/<contextId>`, the database at `<stateDirectory>/docket.db` and the workspace pool at `<stateDirectory>/pool`, and writes them into the file as absolute paths. Its other defaults are maxAttempts=1, maxAttemptsPerTask=3, maxConcurrentFullChecks=1, manual finalisation, 30-minute runMs and keepAwake=true. The canonical file writes resolved defaults explicitly. Counts/timeouts are positive bounded integers; budgets permit zero/null. Paths must be absolute/canonical and the state directory, database and artefact storage outside recyclable workspace roots.

Repository checks format:

~~~json
{
  "version": 1,
  "fast": [
    { "name": "types", "command": ["npm", "run", "check"], "timeoutMs": 120000, "goalMs": 10000 }
  ],
  "full": [
    { "name": "tests", "command": ["npm", "test"], "timeoutMs": 300000 }
  ]
}
~~~

Resolve the file from the trusted target branch, recording its exact source commit/digest. Fast/full names are globally unique across repository and context additions. Missing/invalid policy is distinguished: absent allows context-only checks, malformed refuses. No target-branch checkout is mutated to read policy.

Worker protocol version 1 records database/context/task/attempt/lease/internal session identity, exact starting/output refs, instructions, ordered criteria, delivery kind/evidence requirements, optional review target, and a retained result path/question transport. Results contain the same identity, outcome completed|held|failed, summary, reason:String|null, criteriaReport, evidence and retained work references. Each criterion record has position, exact text, status met|not_met and evidence. Maximum result size is 1 MiB; oversized, linked or malformed files refuse validation. Host logs and bb thread IDs are references, not substitute result identity.
