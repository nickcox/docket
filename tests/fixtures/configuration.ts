import { configurationPaths } from '../../src/configuration.ts';

export function configuration(home: string, contextId = 'example') {
  return {
    version: 1,
    contextId,
    ...configurationPaths(contextId, home),
    repository: home,
    baseBranch: 'main',
    limits: { maxAttempts: 1, maxAttemptsPerTask: 3, maxConcurrentFullChecks: 1 },
    profiles: {
      worker: {
        launcher: 'bb', provider: 'test-provider', model: 'test-model', reasoning: null,
        runMs: 1800000, maxCost: null, maxTokens: 1000000, executionProfile: 'bb-worker-v1',
      },
    },
    defaultProfile: 'worker',
    profileByKind: { code: 'worker', report: 'worker', review: 'worker' },
    finalisation: { kind: 'manual', targetBranch: 'main', globalFile: null, forbid: [] },
    checks: { executionProfile: 'node-project-v1', fast: [], full: [] },
    supervisor: { defaultHost: 'bb', piExecutionProfile: 'pi-supervisor-v1' },
    keepAwake: true,
  };
}
