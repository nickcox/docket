// Private SDK entrypoint: explicit shared credentials, no host resource discovery.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const pi = await import(pathToFileURL(config.sdkModule).href);
const agentDir = join(config.home, '.pi', 'agent');
// Use the actual host path, not a copy or link. Pi locks `${authPath}.lock` with
// realpath:false, so even an in-place-writing symlink would use a different lock.
const modelRuntime = await pi.ModelRuntime.create({
  authPath: config.agentFiles.auth ?? join(agentDir, 'auth.json'),
  modelsPath: config.agentFiles.models ?? null,
  allowModelNetwork: false,
});
const model = modelRuntime.getModel(config.provider, config.model);
if (!model) throw new Error('Configured Pi model is unavailable');
const settingsManager = pi.SettingsManager.inMemory({ retry: { enabled: false } });
const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => undefined,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
const sessionManager = pi.SessionManager.create(config.cwd, config.sessions, { id: config.sessionId });
const runtime = await pi.createAgentSessionRuntime(async (input: { cwd: string; sessionManager: unknown; sessionStartEvent: unknown }) => {
  const services = await pi.createAgentSessionServices({
    cwd: input.cwd, agentDir, modelRuntime, settingsManager, resourceLoader,
  });
  return {
    ...(await pi.createAgentSessionFromServices({ services, sessionManager: input.sessionManager, sessionStartEvent: input.sessionStartEvent,
      model, ...(config.reasoning === null ? {} : { thinkingLevel: config.reasoning }), tools: ['read', 'edit', 'write', 'bash'] })),
    services, diagnostics: services.diagnostics,
  };
}, { cwd: config.cwd, agentDir, sessionManager });
await pi.runRpcMode(runtime);
