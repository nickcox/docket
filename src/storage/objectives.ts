import type { JsonObject } from './database.ts';

export const permissionNames = ['manageTasks', 'dispatch', 'continueAttempts', 'steerWorkers', 'stopWorkers',
  'answerQuestions', 'acceptOutput', 'integrate', 'rebase', 'completeTasks', 'completeObjective'] as const;
export type Permissions = Record<typeof permissionNames[number], boolean>;
export interface Budget { maxCost: number | null; currency: string | null; maxTokens: number | null; maxWorkerTimeMs: number | null }
export interface ObjectiveDefinition {
  criteria: string[]; scope: string; constraints: string; permissions: Partial<Permissions>; budget: Budget; deadline: string | null;
}
export interface Objective extends ObjectiveDefinition {
  id: string; revision: number; request: string; creator: string; permissions: Permissions; state: 'open' | 'completed' | 'abandoned';
  completion: JsonObject[]; createdAt: string; closedAt: string | null;
}
export interface CompletionReference {
  kind: 'accepted_output' | 'review'; attemptId: string; candidateId: string; candidateCommit: string | null;
  artefactDigests: string[]; evidenceEventId: string; reviewAttemptId: string | null;
}
export interface CompletionStatement { position: number; statement: string; references: CompletionReference[] }
export const unlimitedBudget: Budget = { maxCost: null, currency: null, maxTokens: null, maxWorkerTimeMs: null };

export function permissions(value: unknown): Permissions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, item]) => !permissionNames.includes(key as typeof permissionNames[number]) || typeof item !== 'boolean')) {
    throw new TypeError('Invalid objective permissions');
  }
  return Object.fromEntries(permissionNames.map(key => [key, (value as Partial<Permissions>)[key] ?? true])) as Permissions;
}

function validCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

export function objectiveDefinition(value: ObjectiveDefinition): ObjectiveDefinition {
  const { criteria, scope, constraints, budget, deadline } = value;
  if (!Array.isArray(criteria) || criteria.length > 100 || criteria.some(item => typeof item !== 'string' || !item.trim()
    || [...item].length > 2048 || /[\r\n\u2028\u2029]/u.test(item))) throw new TypeError('Invalid objective criteria');
  if (typeof scope !== 'string' || typeof constraints !== 'string') throw new TypeError('Invalid objective scope or constraints');
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)
    || Object.keys(budget).length !== 4 || Object.keys(budget).some(key => !Object.hasOwn(unlimitedBudget, key))) throw new TypeError('Invalid objective budget');
  for (const key of ['maxCost', 'maxTokens', 'maxWorkerTimeMs'] as const) {
    const n = budget[key];
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (key !== 'maxCost' && !Number.isSafeInteger(n)))) throw new TypeError('Invalid objective budget limit');
  }
  if (budget.currency !== null && (typeof budget.currency !== 'string' || !budget.currency.trim())) throw new TypeError('Invalid objective currency');
  if (budget.maxCost !== null && budget.currency === null) throw new TypeError('Cost requires currency');
  if (deadline !== null && (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(deadline)
    || !Number.isFinite(Date.parse(deadline)) || !validCalendarDate(deadline))) throw new TypeError('Deadline requires an ISO time with an offset');
  return { criteria: [...criteria], scope, constraints, permissions: permissions(value.permissions), budget: { ...budget }, deadline };
}
