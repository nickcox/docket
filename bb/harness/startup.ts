// Experimental harness policy, not a qualified Docket launcher.
export interface Plugin {
  id: string;
  enabled: boolean;
  status: string;
  providerIds: string[];
}
export interface Provider { id: string; pluginId: string; pluginEnabled: boolean; enabled: boolean }
export const unrelated = ['provider-claude-code', 'provider-codex', 'provider-acp'];

export function pluginsFrom(value: unknown): Plugin[] {
  if (!value || typeof value !== 'object' || !('plugins' in value) || !Array.isArray(value.plugins)) throw new Error('Invalid plugin inventory');
  const ids = new Set<string>();
  return value.plugins.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid plugin row');
    const p = row as Plugin;
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.enabled !== 'boolean' || typeof p.status !== 'string' || !Array.isArray(p.providerIds) || p.providerIds.some(id => typeof id !== 'string')) throw new Error('Invalid plugin row');
    ids.add(p.id);
    return p;
  });
}
export function providersFrom(value: unknown): Provider[] {
  if (!Array.isArray(value)) throw new Error('Invalid provider catalogue');
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid provider row');
    const p = row as Provider;
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.pluginId !== 'string' || typeof p.enabled !== 'boolean' || typeof p.pluginEnabled !== 'boolean') throw new Error('Invalid provider row');
    ids.add(p.id);
    return p;
  });
}

export function registrationReady(pluginValue: unknown, providerValue: unknown): boolean {
  const plugins = pluginsFrom(pluginValue);
  const providers = providersFrom(providerValue);
  return plugins.length > 0 && !plugins.some(p => p.status === 'starting') && ['provider-pi', ...unrelated].every(id => {
    const p = plugins.find(p => p.id === id);
    return p !== undefined && (!p.enabled || (p.status === 'running' && providers.some(provider => provider.pluginId === id)));
  });
}

export interface StartupIO {
  startServer(): Promise<void>;
  // Catalogue GET waits for bb registration (with a host-side timeout), so also
  // require the pinned builtin rows and no starting plugins before proceeding.
  waitRegistration(): Promise<void>;
  installProbe(): Promise<void>;
  listPlugins(): Promise<unknown>;
  listProviders(): Promise<unknown>;
  disable(id: string): Promise<void>;
  connectDaemon(): Promise<void>;
  stopDaemon(): Promise<void>;
}

export async function verifySelection(io: Pick<StartupIO, 'listPlugins' | 'listProviders'>): Promise<Plugin[]> {
  const providers = providersFrom(await io.listProviders());
  const plugins = pluginsFrom(await io.listPlugins());
  if (plugins.some(p => p.status === 'starting')) throw new Error('Plugin registration incomplete');
  for (const id of unrelated) {
    const p = plugins.find(p => p.id === id);
    if (!p || p.enabled || p.status !== 'disabled' || p.providerIds.length) throw new Error(`Provider plugin not disabled: ${id}`);
  }
  const allowed = new Map([['provider-pi', 'pi'], ['docket-probe', 'docket-synthetic']]);
  for (const [id, provider] of allowed) {
    const p = plugins.find(p => p.id === id);
    if (!p?.enabled || p.status !== 'running' || p.providerIds.length !== 1 || p.providerIds[0] !== provider) throw new Error(`Required provider plugin unavailable: ${id}`);
    if (!providers.some(p => p.id === provider && p.pluginId === id && p.pluginEnabled && p.enabled)) throw new Error(`Required provider absent: ${provider}`);
  }
  for (const p of plugins) {
    if (p.enabled && ((p.id.startsWith('provider-') && p.id !== 'provider-retry') || p.providerIds.length > 0) && !allowed.has(p.id)) throw new Error(`Unexpected enabled provider plugin: ${p.id}`);
  }
  for (const p of providers) {
    if (p.pluginEnabled && allowed.get(p.pluginId) !== p.id) throw new Error(`Unexpected enabled provider: ${p.id}`);
  }
  return plugins.filter(p => allowed.has(p.id));
}

export async function startIsolated(io: StartupIO, restart = false): Promise<Plugin[]> {
  // Stop the daemon before a restart, not after its reconnect/prewarm can race us.
  if (restart) await io.stopDaemon();
  await io.startServer();
  await io.waitRegistration();
  if (!restart) {
    await io.installProbe();
    for (const id of unrelated) await io.disable(id);
  }
  // On restart do not silently repair lost persisted selection.
  const selected = await verifySelection(io);
  await io.connectDaemon();
  return selected;
}
