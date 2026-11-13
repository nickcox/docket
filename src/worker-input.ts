import { dirname, join } from 'node:path';
import type { WorkerBinding } from './adapters/launcher.ts';
import type { JsonObject } from './storage/database.ts';

/** Worker protocol 1 is data inside one prompt, never shell interpolation or a second turn. */
export function workerPrompt(binding: WorkerBinding): string {
  const resultPath = binding.resultPath;
  const questionsDirectory = join(dirname(resultPath), 'questions');
  const artefactsDirectory = join(dirname(resultPath), 'artefacts');
  const specification = binding.specification;
  const task = specification.task as JsonObject;
  const protocol = { version: 1, identity: { databaseId: binding.databaseId, contextId: binding.contextId,
    taskId: binding.taskId, attemptId: binding.attemptId, leaseId: binding.allocation.leaseId, sessionId: binding.sessionId },
    workspace: binding.allocation.path, startingCommit: binding.allocation.startingCommit, outputRef: binding.allocation.outputRef,
    instructions: task.instructions, criteria: specification.criteria, delivery: specification.delivery,
    reviewTarget: specification.reviewTarget ?? null, handover: specification.handover ?? null, resultPath, questionsDirectory, artefactsDirectory };
  return ['Complete this one assigned task in the exact leased workspace. Do not launch other agents, mutate task records or leases, merge, push or publish. Check any inherited work in the handover against the task and its criteria rather than trusting it. This is a new attempt, not acceptance of the source work.',
    'Use this immutable worker protocol version 1 input:', JSON.stringify(protocol),
    'To ask a question, publish a complete JSON file with a unique .json filename in questionsDirectory, using an atomic rename. Its exact fields are text (nonblank string), choices (string array or null) and waiting (boolean). Never edit or reuse a published filename. Answers are retained as <questionId>.json in the answers directory beside questionsDirectory, containing questionId and text. Read that file channel while waiting; an answer never restarts a stopped worker or grants authority.',
    'Write one JSON result to resultPath using the write tool, with exactly these fields: version:1, identity (the exact supplied object), startingCommit, outputRef, outcome (completed|held|failed), summary, reason (null for completed, otherwise a nonblank string), criteriaReport, evidence, workReferences. Copy startingCommit and outputRef exactly from the input.',
    specification.reviewTarget
      ? 'This is an independent review. Do not commit changes. Inspect reviewTarget.checkResults and run focused tests rather than the full suite again. evidence is an array of {name,summary}. workReferences must contain exactly one {kind:"reviewed-output",name,target} with target equal to reviewTarget. Retained artefacts may also use {kind:"artefact",name,path,description}, with path relative to the result directory; artefact references must name files inside artefactsDirectory, not directories.'
      : 'evidence is an array of {name,summary}. workReferences contains {kind:"git",name,branch,commit} (branch equals outputRef, commit is the exact retained candidate) or {kind:"artefact",name,path,description} (path is relative to the result file directory). Include every required evidence and deliverable name. Artefact references must name files inside artefactsDirectory, not directories. Store retained artefacts in artefactsDirectory.',
    `Report each criterion exactly once with fields position (1-based), criterion (exact text), status (met|not_met) and evidence. ${specification.reviewTarget ? 'Do not commit changes.' : 'Commit code to the output ref.'} A turn ending is not acceptance.`].join('\n\n');
}
