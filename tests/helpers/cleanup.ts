type Context = { after: (fn: () => Promise<void>) => void };
type Cleanup = () => unknown | Promise<unknown>;
const cleanups = new WeakMap<Context, Cleanup[]>();

// node:test runs after hooks in registration order. Fixtures acquire their
// directory first, so release resources in reverse order before removing it.
export function defer(t: Context, cleanup: Cleanup): void {
  let stack = cleanups.get(t);
  if (!stack) {
    stack = [];
    cleanups.set(t, stack);
    t.after(async () => {
      const errors: unknown[] = [];
      while (stack!.length) {
        try { await stack!.pop()!(); } catch (error) { errors.push(error); }
      }
      cleanups.delete(t);
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
    });
  }
  stack.push(cleanup);
}
