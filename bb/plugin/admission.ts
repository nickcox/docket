// Independent synthetic probe state, not Docket authority or provenance.
export const admissionSchema = [
  "CREATE TABLE admission (thread TEXT PRIMARY KEY, bound INTEGER NOT NULL DEFAULT 0, decision TEXT NOT NULL DEFAULT 'hold', consumed INTEGER NOT NULL DEFAULT 0)",
  'CREATE TABLE observations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)',
];
interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: any[]): { changes: number | bigint };
    get(...args: any[]): unknown;
    all(...args: any[]): unknown[];
  };
}
export interface Admission { thread: string; bound: number; decision: string; consumed: number }
export const firstInput = 'Docket synthetic first input';
export function inputText(blocks: readonly unknown[]): string | null {
  if (blocks.length !== 1) return null;
  const block = blocks[0] as { type?: unknown; text?: unknown } | null;
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : null;
}
export class AdmissionPolicy {
  private db: Database;
  constructor(db: Database) { this.db = db; }
  rows() { return this.db.prepare('SELECT * FROM admission').all() as Admission[]; }
  events() { return this.db.prepare('SELECT sequence, entry FROM observations ORDER BY sequence').all().map((row: any) => ({ sequence: row.sequence, ...JSON.parse(row.entry) })); }
  private row(thread: string) {
    this.db.prepare('INSERT OR IGNORE INTO admission(thread) VALUES (?)').run(thread);
    return this.db.prepare('SELECT * FROM admission WHERE thread = ?').get(thread) as Admission;
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observe(entry: object) {
    this.db.prepare('INSERT INTO observations(entry) VALUES (?)').run(JSON.stringify({ at: Date.now(), ...entry }));
  }
  control(action: 'bind' | 'permit' | 'refuse', thread: string) {
    return this.transaction(() => {
      const before = this.row(thread);
      let accepted = false;
      if (action === 'refuse') {
        this.db.prepare("UPDATE admission SET decision = 'refuse' WHERE thread = ?").run(thread);
        accepted = true;
      } else if (!before.consumed && before.decision === 'hold') {
        if (action === 'bind') {
          this.db.prepare('UPDATE admission SET bound = 1 WHERE thread = ?').run(thread);
          accepted = true;
        } else if (before.bound) {
          this.db.prepare("UPDATE admission SET decision = 'permit' WHERE thread = ?").run(thread);
          accepted = true;
        }
      }
      this.observe({ kind: 'control', action, threadId: thread, accepted, state: this.row(thread) });
      return { accepted, state: this.row(thread) };
    });
  }
  dispatch(thread: string, input: { text: string; attempt: string; origin: string | null; messages: { content: string; origin: string | null }[] }, evidence: object = {}) {
    return this.transaction(() => {
      const state = this.row(thread);
      // Inspect every queued member. A grouped follow-up must never be admitted
      // with the permitted first prompt. Inline and queued text must be exact.
      const exact = input.attempt === 'start-turn' && input.origin === 'cli' && input.text === firstInput && input.messages.length <= 1 && input.messages.every(row => row.content === firstInput && row.origin === 'cli');
      let action: 'reject' | 'wait' | 'proceed' = 'reject';
      if (!state.consumed && state.decision !== 'refuse' && exact) {
        if (state.bound && state.decision === 'permit') {
          this.db.prepare('UPDATE admission SET consumed = 1 WHERE thread = ?').run(thread);
          action = 'proceed';
        } else action = 'wait';
      }
      this.observe({ ...evidence, kind: 'dispatch', threadId: thread, action, input, state: this.row(thread) });
      return action;
    });
  }
}
