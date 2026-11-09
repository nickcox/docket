import type { JsonObject } from './database.ts';

export type TaskKind = 'code' | 'report' | 'review';
export type TaskState = 'queued' | 'in_flight' | 'done';

export interface TaskDefinition {
  title: string;
  instructions: string;
  criteria: string[];
  kind: TaskKind;
  profile: string | null;
  objectiveId: string | null;
}

export interface Task extends TaskDefinition {
  id: string;
  position: number;
  state: TaskState;
  holdReason: string | null;
  definitionRevision: number;
  decisionRevision: number;
  blockerIds: string[];
  reviewTarget: JsonObject | null;
}

export interface AddTaskInput {
  id?: string;
  title: string;
  instructions?: string;
  criteria?: string[];
  kind?: TaskKind;
  profile?: string | null;
  objectiveId?: string | null;
  blockerIds?: string[];
}

/** Supplied by trusted host code, not by task text. */
export interface TaskActor extends JsonObject {
  kind: 'person';
  id: string;
}

const definitionKeys = ['title', 'instructions', 'criteria', 'kind', 'profile', 'objectiveId'];

export function taskText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected nonblank text');
}

export function taskIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError('Expected task IDs');
  for (const id of value) taskText(id);
  if (new Set(value).size !== value.length) throw new TypeError('Duplicate task ID');
}

export function taskDefinition(value: Partial<TaskDefinition>): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !definitionKeys.includes(key))) throw new TypeError('Unknown task definition field');
  for (const key of Object.keys(value)) {
    const field = value[key as keyof TaskDefinition];
    switch (key) {
      case 'title': taskText(field); break;
      case 'instructions':
        if (typeof field !== 'string') throw new TypeError('Expected instructions text');
        break;
      case 'criteria':
        if (!Array.isArray(field) || field.some(item => typeof item !== 'string')) throw new TypeError('Expected ordered text criteria');
        break;
      case 'kind':
        if (!['code', 'report', 'review'].includes(field as string)) throw new TypeError('Invalid task kind');
        break;
      case 'profile': case 'objectiveId':
        if (field !== null) taskText(field);
        break;
    }
  }
}

export function addTaskInput(value: AddTaskInput): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => ![...definitionKeys, 'id', 'blockerIds'].includes(key))) throw new TypeError('Unknown task field');
  taskText(value.title);
  const { id, blockerIds, ...definition } = value;
  if ('id' in value) taskText(id);
  if ('blockerIds' in value) taskIds(blockerIds);
  taskDefinition(definition);
  if (value.kind === 'review') throw new TypeError('Only attempt.review creates review tasks');
}

export function taskActor(value: TaskActor): void {
  if (value === null || typeof value !== 'object' || value.kind !== 'person' ||
    Object.keys(value).some(key => !['kind', 'id'].includes(key))) throw new TypeError('Task changes require a person actor');
  taskText(value.id);
}

export function taskSlug(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
}
