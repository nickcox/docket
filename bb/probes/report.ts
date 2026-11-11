// Offline-testable reporting. No installed host imports and no process starts.
export type Scenario = { name: string; status: 'passed' | 'failed' | 'not-run'; evidence?: unknown };
export class ProbeReport {
  scenarios: Scenario[];
  active: string | null = null;
  failure: string | null = null;
  details: Record<string, unknown> = {};
  private save: (report: object) => void;
  constructor(names: readonly string[], save: (report: object) => void) {
    this.scenarios = names.map(name => ({ name, status: 'not-run' }));
    this.save = save;
    this.flush();
  }
  flush() { this.save({ active: this.active, failure: this.failure, scenarios: this.scenarios, ...this.details }); }
  interrupt(message: string) {
    const row = this.scenarios.find(row => row.name === this.active);
    if (row) row.status = 'failed';
    this.failure = message;
    this.flush();
  }
  async stage(name: string, run: () => Promise<unknown>) {
    const row = this.scenarios.find(row => row.name === name);
    if (!row || row.status !== 'not-run') throw new Error('Unknown or repeated probe stage');
    this.active = name;
    this.flush();
    console.error(`Synthetic probe: ${name}`);
    try {
      row.evidence = await run();
      if (this.scenarios.find(item => item.name === name)?.status === 'failed') throw new Error(this.failure ?? 'Interrupted');
      row.status = 'passed';
    }
    catch (error) { row.status = 'failed'; this.failure = error instanceof Error ? error.message : 'Probe failed'; throw error; }
    finally { this.active = null; this.flush(); }
  }
}

export function validateInputs(inputs: any[], observations: any[]) {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.threadId)) throw new Error('More than one provider input for a thread');
    seen.add(input.threadId);
    const admissions = observations.filter(event => event.kind === 'dispatch' && event.action === 'proceed' && event.threadId === input.threadId);
    if (admissions.length !== 1) throw new Error('Provider input lacks unique durable consumption');
    const consumed = admissions[0];
    const preceding = observations.filter(event => event.threadId === input.threadId && event.sequence < consumed.sequence);
    const bind = preceding.find(event => event.kind === 'control' && event.action === 'bind' && event.accepted && event.state.bound === 1);
    const permit = preceding.find(event => event.kind === 'control' && event.action === 'permit' && event.accepted && event.state.bound === 1);
    if (!bind || !permit || bind.sequence >= permit.sequence || permit.sequence >= consumed.sequence || consumed.at > input.at ||
      consumed.state.bound !== 1 || consumed.state.decision !== 'permit' || consumed.state.consumed !== 1) throw new Error('Input precedes durable bind/permit/consumption');
    const text = input.input?.map((block: any) => block.text ?? '').join('\n');
    if (input.method !== 'turn/start' || text !== consumed.input.text) throw new Error('Unexpected provider input or content');
  }
}
