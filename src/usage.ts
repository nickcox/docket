import type { StoredEvent } from './storage/database.ts';
import type { Objective } from './storage/objectives.ts';
import { CommandFailure } from './response.ts';

export const metrics = ['cost', 'tokens', 'workerTimeMs'] as const;
export type Metric = typeof metrics[number];
type Availability = 'reported' | 'unknown' | 'unsupported';
export interface UsageGap { sessionId: string; metrics: Metric[] }
export interface UsageReport {
  sessionId: string; sourceSequence: number; observedAt: string;
  cost: { availability: Availability; value: number | null; currency: string | null };
  tokens: { availability: Availability; input: number | null; output: number | null; total: number | null };
  workerTimeMs: { availability: Availability; value: number | null };
}
export interface Session {
  sessionId: string; kind: 'worker' | 'supervisor'; objectiveId: string | null; attemptId: string | null;
  registeredAt: string; capabilities: string[];
}
function exact(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Invalid usage fields');
}
export function validateReport(report: UsageReport): void {
  exact(report, ['sessionId', 'sourceSequence', 'observedAt', 'cost', 'tokens', 'workerTimeMs']);
  exact(report.cost, ['availability', 'value', 'currency']);
  exact(report.tokens, ['availability', 'input', 'output', 'total']);
  exact(report.workerTimeMs, ['availability', 'value']);
  if (!report || typeof report.sessionId !== 'string' || !report.sessionId.trim() || !Number.isSafeInteger(report.sourceSequence)
    || report.sourceSequence < 0 || typeof report.observedAt !== 'string' || !Number.isFinite(Date.parse(report.observedAt))) throw new TypeError('Invalid usage report');
  for (const metric of metrics) {
    const item = report[metric];
    if (!item || !['reported', 'unknown', 'unsupported'].includes(item.availability)) throw new TypeError('Invalid usage availability');
    const values = metric === 'tokens' ? ['input', 'output', 'total'] : ['value'];
    for (const key of values) {
      const value = (item as unknown as Record<string, unknown>)[key];
      if (item.availability !== 'reported' ? value !== null : typeof value !== 'number' || !Number.isFinite(value) || value < 0
        || metric !== 'cost' && !Number.isSafeInteger(value)) throw new TypeError('Invalid usage value');
    }
  }
  if (report.cost.availability === 'reported' ? typeof report.cost.currency !== 'string' || !report.cost.currency.trim()
    : report.cost.currency !== null) throw new TypeError('Invalid usage currency');
}

/** Fold immutable session reports; ordering and repetition cannot reduce an observed value. */
export function usageSummary(objective: Objective, events: readonly StoredEvent[], now = Date.now()) {
  for (const event of events) {
    if (!['session.registered', 'session.finished', 'usage.observed', 'objective.usage-confirmed'].includes(event.kind)) continue;
    if (event.payloadVersion !== 1) throw new CommandFailure('unsupported_version');
    if (event.kind === 'usage.observed') validateReport(event.payload as unknown as UsageReport);
  }
  const sessions = events.filter(e => e.kind === 'session.registered' && e.payload.objectiveId === objective.id)
    .map(e => e.payload as unknown as Session);
  const observations: { sessionId: string; cost: UsageReport['cost']; tokens: UsageReport['tokens']; workerTimeMs: UsageReport['workerTimeMs'] }[] = [];
  const totals = { cost: null as number | null, tokens: null as number | null, workerTimeMs: null as number | null };
  const gaps: (UsageGap & { finished: boolean; confirmed: Metric[] })[] = [];
  const limits = { cost: objective.budget.maxCost, tokens: objective.budget.maxTokens, workerTimeMs: objective.budget.maxWorkerTimeMs };
  const sessionIds = new Set(sessions.map(s => s.sessionId));
  const firstCost = events.find(e => e.kind === 'usage.observed' && sessionIds.has(String(e.payload.sessionId))
    && (e.payload as unknown as UsageReport).cost.availability === 'reported');
  let currency = objective.budget.currency ?? (firstCost?.payload as unknown as UsageReport | undefined)?.cost.currency ?? null;
  for (const session of sessions) {
    const reports = events.filter(e => e.kind === 'usage.observed' && e.payload.sessionId === session.sessionId)
      .map(e => e.payload as unknown as UsageReport);
    const finished = events.some(e => ['session.finished', 'supervisor.stopped'].includes(e.kind) && e.payload.sessionId === session.sessionId
      || session.attemptId !== null && e.attemptId === session.attemptId && e.kind === 'worker.observed' && e.payload.kind === 'terminal');
    const missing: Metric[] = [], confirmed: Metric[] = [];
    const latest = reports.toSorted((a, b) => b.sourceSequence - a.sourceSequence)[0];
    const availability = (metric: Metric): Availability => latest?.[metric].availability ?? (session.capabilities.includes(metric) ? 'unknown' : 'unsupported');
    const maximum = (values: (number | null)[]) => values.length ? Math.max(...values.map(v => v!)) : null;
    const tokenReports = reports.filter(r => r.tokens.availability === 'reported');
    currency ??= reports.find(r => r.cost.availability === 'reported')?.cost.currency ?? null;
    const costReports = reports.filter(r => r.cost.availability === 'reported' && r.cost.currency === currency);
    const timeReports = reports.filter(r => r.workerTimeMs.availability === 'reported');
    observations.push({ sessionId: session.sessionId,
      cost: { availability: costReports.length ? 'reported' : availability('cost'), value: maximum(costReports.map(r => r.cost.value)), currency: costReports[0]?.cost.currency ?? null },
      tokens: { availability: tokenReports.length ? 'reported' : availability('tokens'), input: maximum(tokenReports.map(r => r.tokens.input)),
        output: maximum(tokenReports.map(r => r.tokens.output)), total: maximum(tokenReports.map(r => r.tokens.total)) },
      workerTimeMs: { availability: timeReports.length ? 'reported' : availability('workerTimeMs'), value: maximum(timeReports.map(r => r.workerTimeMs.value)) } });
    for (const metric of metrics) {
      if (session.kind === 'supervisor' && metric === 'workerTimeMs') continue;
      const reported = reports.filter(r => r[metric].availability === 'reported');
      let values = reported.map(r => metric === 'tokens' ? r.tokens.total! : r[metric].value!);
      if (metric === 'cost') {
        currency ??= reported[0]?.cost.currency ?? null;
        values = reported.filter(r => r.cost.currency === currency).map(r => r.cost.value!);
        if (reported.some(r => r.cost.currency !== currency)) missing.push(metric);
      }
      if (metric === 'workerTimeMs' && !finished) values.push(Math.max(0, now - Date.parse(session.registeredAt)));
      if (values.length) totals[metric] = (totals[metric] ?? 0) + Math.max(...values);
      if (!values.length || latest && latest[metric].availability !== 'reported') {
        if (!missing.includes(metric)) missing.push(metric);
      }
      if (events.some(e => e.kind === 'objective.usage-confirmed' && e.objectiveId === objective.id
        && (e.payload.sessionGaps as unknown as UsageGap[]).some(g => g.sessionId === session.sessionId && g.metrics.includes(metric)))) confirmed.push(metric);
    }
    if (missing.length) gaps.push({ sessionId: session.sessionId, metrics: missing, finished, confirmed });
  }
  if (!sessions.length) for (const metric of metrics) totals[metric] = 0;
  if (sessions.every(s => s.kind === 'supervisor')) totals.workerTimeMs = 0;
  const remaining = Object.fromEntries(metrics.map(metric => [metric, limits[metric] === null || totals[metric] === null ? null : Math.max(0, limits[metric]! - totals[metric]!)]));
  return { totals, currency, remaining, gaps, sessions, observations };
}

export function budgetReason(objective: Objective, events: readonly StoredEvent[], capabilities?: readonly string[], now = Date.now(), running = false): string | null {
  if (objective.deadline !== null && now > Date.parse(objective.deadline)) return 'deadline';
  const usage = usageSummary(objective, events, now);
  const limits = { cost: objective.budget.maxCost, tokens: objective.budget.maxTokens, workerTimeMs: objective.budget.maxWorkerTimeMs };
  for (const metric of metrics) {
    const limit = limits[metric];
    if (limit === null) continue;
    if (capabilities && !capabilities.includes(metric)) return `unsupported:${metric}`;
    if (!running && usage.gaps.some(g => g.finished && g.metrics.includes(metric) && !g.confirmed.includes(metric))) return `unknown:${metric}`;
    const value = usage.totals[metric];
    if (value !== null && (running ? value > limit : value >= limit)) return `limit:${metric}`;
  }
  return null;
}
export function enforceBudget(objective: Objective, events: readonly StoredEvent[], capabilities?: readonly string[]): void {
  const reason = budgetReason(objective, events, capabilities);
  if (reason) throw new CommandFailure('policy_refused', { objectiveId: objective.id, budgetReason: reason });
}
