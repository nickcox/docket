// Explicit supervisor-only live check. Never import or run Q1a here.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Harness } from '../harness/index.ts';

const h = new Harness(180_000);
const interrupt = () => { void h.stop().finally(() => process.exit(130)); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
console.error(`Startup-only retained logs: ${h.root}`);
try {
  await h.start();
  console.log('Enabled provider plugins:', JSON.stringify(await h.selectedProviders()));
  // Installation-status prewarming runs on host connect. No threads or model
  // requests are needed to observe it. Leave a fixed monitoring window.
  await sleep(30_000);
  console.log('Reverified provider plugins:', JSON.stringify(await h.selectedProviders()));
  writeFileSync(join(h.root, 'startup-only.json'), JSON.stringify({ ok: true, settleMs: 30_000, threadsCreated: 0, modelRequests: 0 }));
} catch (error) {
  writeFileSync(join(h.root, 'startup-only.json'), JSON.stringify({ ok: false, error: String(error) }));
  console.error(error);
  process.exitCode = 1;
} finally {
  await h.stop();
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
