import type { JsonObject } from './database.ts';
import type { TaskActor } from './tasks.ts';

export type QuestionCaller = TaskActor | (JsonObject & { kind: 'worker'; attemptId: string });
export interface QuestionInput extends JsonObject { text: string; choices: string[] | null; waiting: boolean }
export interface Question extends JsonObject {
  id: string;
  source: string;
  text: string;
  choices: string[] | null;
  waiting: boolean;
  asker: QuestionCaller;
  recipient: JsonObject;
  scope: { taskId: string | null; attemptId: string | null; objectiveId: string | null };
  answer: JsonObject | null;
}
export function questionInput(value: unknown): asserts value is QuestionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a question');
  const q = value as Record<string, unknown>;
  if (Object.keys(q).some(k => !['text', 'choices', 'waiting'].includes(k))
    || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 65536
    || typeof q.waiting !== 'boolean' || !(q.choices === null || Array.isArray(q.choices)
      && q.choices.every(c => typeof c === 'string'))) throw new TypeError('Invalid question');
}
