import type { Database } from './storage/database.ts';
import type { TaskActor } from './storage/tasks.ts';

/** Compact references retain full evidence in attempt.show and the event history. */
export function buildBriefing(db: Database, objectiveId: string, actor: TaskActor) {
  const objective = db.objective(objectiveId, actor), events = db.events(), requests = db.requests();
  const tasks = db.tasks().filter(t => t.objectiveId === objectiveId);
  const taskIds = new Set(tasks.map(t => t.id));
  const attempts = events.filter(e => e.kind === 'attempt.reserved' && e.taskId && taskIds.has(e.taskId)).map(e => db.attempt(e.attemptId!));
  const attemptIds = new Set(attempts.map(a => a.id));
  const scoped = events.filter(e => e.objectiveId === objectiveId || e.taskId && taskIds.has(e.taskId)
    || e.kind === 'person.action' && (e.payload.scopes as { objectiveId: string }[]).some(s => s.objectiveId === objectiveId));
  const sessions = scoped.filter(e => e.kind === 'session.registered' && e.payload.kind === 'supervisor');
  const usage = db.objectiveUsage(objectiveId);
  const claims = db.claims().filter(c => !c.releasedAt && (c.objectiveId === objectiveId || c.attemptId && attemptIds.has(c.attemptId)));
  const handledSequence = Number(events.findLast(e => e.objectiveId === objectiveId && e.kind === 'supervisor.handled')?.payload.sequence ?? 0);
  const pending = events.filter(e => e.objectiveId === objectiveId && e.notification && e.seq > handledSequence);
  const pendingCounts: Record<string, number> = {};
  for (const event of pending) pendingCounts[event.kind] = (pendingCounts[event.kind] ?? 0) + 1;
  return {
    detailOperation: 'attempt.show',
    objective: { id: objective.id, state: objective.state, criteria: objective.criteria, scope: objective.scope,
      constraints: objective.constraints, permissions: objective.permissions, budget: objective.budget, deadline: objective.deadline },
    authority: sessions.map(e => ({ sessionId: e.payload.sessionId, kind: e.payload.restricted === true ? 'restricted' : 'unrestricted' })),
    usage: { totals: usage.totals, currency: usage.currency, remaining: usage.remaining, gaps: usage.gaps },
    tasks: tasks.map(t => ({ id: t.id, title: t.title, state: t.state, criteria: t.criteria, holdReason: t.holdReason, blockedBy: t.blockerIds })),
    attempts: attempts.map(a => {
      const result = db.validatedWorkerResult(a.id), review = db.reviewEvidence(a.id);
      const checks = requests.filter(r => r.attemptId === a.id && r.operation === 'checks.run' && r.input.commit === a.candidate?.commit);
      const latest = checks.at(-1), checkState = latest?.result?.status ?? latest?.state ?? 'missing';
      const accepted = a.candidate ? db.acceptance(a.id, String(a.candidate.id)) : null;
      const waitingFor: string[] = [];
      if (!accepted) {
        if (a.executionOpen) waitingFor.push('worker terminal');
        if (!result) waitingFor.push('valid retained result');
        if (!a.candidate) waitingFor.push('candidate');
        if (checkState !== 'passed') waitingFor.push(`checks: ${String(checkState)}`);
        if (review.current?.payload.verdict !== 'passed') waitingFor.push(`review: ${String(review.current?.payload.verdict ?? 'missing')}`);
        waitingFor.push('acceptance decision');
      }
      return { id: a.id, taskId: a.taskId, number: a.number, phase: a.phase, outcome: a.outcome, leaseState: a.leaseState,
        summary: result?.content.summary ?? null, reason: result?.content.reason ?? db.invalidWorkerResult(a.id)?.message ?? null, candidate: a.candidate,
        checks: checks.map(r => ({ requestId: r.requestKey, state: r.state, status: r.result?.status ?? null,
          results: ((r.result?.commands ?? []) as Record<string, unknown>[]).map(c => ({ name: (c.definition as Record<string, unknown> | undefined)?.name, status: c.status })) })),
        reviews: review.findings.map(e => ({ eventId: e.id, reviewAttemptId: e.payload.reviewAttemptId,
          commit: e.payload.commit, verdict: e.payload.verdict, findings: ((e.payload.findings ?? []) as Record<string, unknown>[])
            .map(f => ({ position: f.position, status: f.status, evidence: f.evidence })) })),
        accepted: accepted !== null, waitingFor };
    }),
    questions: db.questions().filter(q => q.scope.objectiveId === objectiveId && (q.scope.taskId === null || taskIds.has(q.scope.taskId))),
    notes: scoped.filter(e => e.kind === 'supervisor.note').map(e => ({ id: e.id, text: e.payload.text })),
    pendingEvents: { count: pending.length, counts: pendingCounts, handledSequence, detailOperation: 'supervisor.pending',
      recent: pending.slice(-3).map(e => ({ id: e.id, sequence: e.seq, kind: e.kind, attemptId: e.attemptId ?? null })) },
    ownerDiagnostics: {
      sessions: scoped.filter(e => ['session.failed', 'supervisor.stopped'].includes(e.kind)
        || e.kind === 'worker.observed' && e.payload.kind === 'capability_failure')
        .map(e => ({ id: e.id, kind: e.kind, payload: e.payload })),
      claims: claims.map(c => ({ id: c.id, role: c.role, ownerRef: c.ownerRef, heartbeatAt: c.heartbeatAt })),
      blockers: db.admissionBlockers().filter(b => 'attemptId' in b && typeof b.attemptId === 'string' && attemptIds.has(b.attemptId)
        || b.kind === 'claim' && claims.some(c => c.id === b.claimId)),
      effects: requests.filter(r => r.category === 'effect' && (r.objectiveId === objectiveId || r.attemptId && attemptIds.has(r.attemptId))
        && ['pending', 'claimed', 'uncertain'].includes(r.state)).map(r => ({ requestId: r.requestKey, operation: r.operation, state: r.state })),
    },
    personActions: db.personActions(objectiveId),
  };
}
