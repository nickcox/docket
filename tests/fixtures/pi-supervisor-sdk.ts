// Synthetic SDK exercises the actual private supervisor entrypoint, without a provider.
import { appendFileSync } from 'node:fs';
// Model a cold SDK import before the private entrypoint can read its first request.
if (process.env.PEER_MODE === 'slow-sdk') await new Promise(resolve => setTimeout(resolve, 500));
const log = (value: unknown) => appendFileSync(process.env.PEER_RECORD!, `${JSON.stringify(value)}\n`);
export const ModelRuntime = { create: async () => ({ getModel: (provider: string, id: string) => ({ provider, id }) }) };
export const SettingsManager = { inMemory: (settings: unknown) => { log({ kind: 'settings', settings }); return settings; } };
export const SessionManager = { create: (_cwd: string, _directory: string, options: any) => options };
export const createExtensionRuntime = () => ({});
export async function createAgentSession(options: any) {
  log({ kind: 'resources', tools: options.tools, extensions: options.resourceLoader.getExtensions(),
    skills: options.resourceLoader.getSkills(), agents: options.resourceLoader.getAgentsFiles(), customTools: options.customTools.map((t: any) => t.name) });
  const session = { sessionId: options.sessionManager.id, model: options.model, agent: { transformContext: async (messages: any[]) => messages },
    getActiveToolNames: () => options.customTools.map((t: any) => t.name), subscribe: () => {}, dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 5, output: 3, total: 8 }, cost: 0.01 }),
    async prompt(message: string) {
      const messages: any[] = [{ role: 'user', content: message }];
      const briefing = options.customTools.find((t: any) => t.name === 'dk_supervisor_briefing');
      for (const id of ['first', 'latest']) {
        messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: briefing.name }] });
        const result = await briefing.execute(id, {});
        messages.push({ role: 'toolResult', toolName: briefing.name, toolCallId: id, ...result });
      }
      log({ kind: 'modelContext', messages: await session.agent.transformContext(messages) });
      const question = options.customTools.find((t: any) => t.name === 'dk_question_ask');
      await question.execute('question', { text: 'Which next action?', choices: ['Inspect', 'Wait'], waiting: true });
      const note = options.customTools.find((t: any) => t.name === 'dk_supervisor_note');
      await note.execute('note', { text: 'Synthetic supervisor inspected the briefing.' });
      await note.execute('note', { text: 'Synthetic supervisor inspected the briefing.' });
      setTimeout(() => process.exit(0), 50);
    },
  };
  return { session };
}
