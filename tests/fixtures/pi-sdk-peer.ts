import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

// Minimal synthetic SDK surface. The existing JSONL peer supplies the wire protocol.
type Options = Record<string, any>;
const log = (value: unknown) => appendFileSync(process.env.PEER_RECORD!, `${JSON.stringify(value)}\n`);
export const ModelRuntime = {
  async create(options: Options) {
    log({ kind: 'credentials', ...options, auth: JSON.parse(readFileSync(options.authPath, 'utf8')),
      models: JSON.parse(readFileSync(options.modelsPath, 'utf8')) });
    // Stand in for OAuth refresh: this must change the actual host file.
    writeFileSync(options.authPath, JSON.stringify({ refreshed: true }));
    return { getModel: (provider: string, id: string) => ({ provider, id }) };
  },
};
export const SettingsManager = { inMemory: (settings: Options) => { log({ kind: 'settings', settings }); return settings; } };
export const SessionManager = { create: (cwd: string, directory: string, options: Options) => ({ cwd, directory, ...options }) };
export const createExtensionRuntime = () => ({});
export async function createAgentSessionServices(options: Options) {
  const loader = options.resourceLoader;
  log({ kind: 'resources', extensions: loader.getExtensions(), skills: loader.getSkills(), prompts: loader.getPrompts(),
    themes: loader.getThemes(), agents: loader.getAgentsFiles(), systemPrompt: loader.getSystemPrompt() ?? null,
    appendSystemPrompt: loader.getAppendSystemPrompt() });
  return options;
}
export async function createAgentSessionFromServices(options: Options) { return options; }
export async function createAgentSessionRuntime(factory: (input: Options) => Promise<Options>, options: Options) {
  return factory({ cwd: options.cwd, sessionManager: options.sessionManager, sessionStartEvent: undefined });
}
export async function runRpcMode(runtime: Options) {
  const manager = runtime.sessionManager;
  log({ kind: 'sdk_session', model: runtime.model, tools: runtime.tools, thinkingLevel: runtime.thinkingLevel });
  process.argv = [process.execPath, 'pi-peer', '--provider', runtime.model.provider, '--model', runtime.model.id,
    '--session-id', manager.id, '--session-dir', manager.directory, '--thinking', runtime.thinkingLevel ?? 'off'];
  await import('./pi-peer.ts');
}
