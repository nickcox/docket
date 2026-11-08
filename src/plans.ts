import type { JsonObject } from './storage/database.ts';
export interface PlanStep extends JsonObject {
  operation: string;
  target: string;
  requires: string[];
  conditional: boolean;
}
export const step = (operation: string, target: string, requires: string[] = [], conditional = false): PlanStep => ({ operation, target, requires, conditional });
