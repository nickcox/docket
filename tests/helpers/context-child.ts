import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Database } from '../../src/storage/database.ts';
import { initialiseContext } from '../../src/context.ts';

const [home, file, pause] = process.argv.slice(2);
async function barrier() {
  process.send!({ phase: 'paused' });
  await once(process, 'message');
}
const initialise = Database.initialise;
Database.initialise = async function (...args) {
  if (pause === 'before-database') await barrier();
  const database = await initialise.apply(this, args);
  if (pause === 'before-replace') await barrier();
  return database;
};
const rename = fs.rename;
fs.rename = async function (...args) {
  await rename(...args);
  if (pause === 'after-replace') await barrier();
};
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
let attempted = false;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'BEGIN IMMEDIATE' && !attempted) {
    attempted = true;
    process.send!({ phase: 'attempting' });
  }
  return exec.call(this, sql);
};
process.send!({ phase: 'ready' });
await once(process, 'message');
try {
  const result = await initialiseContext({ config: file! }, { home: home!, caller: { kind: 'person', id: 'test' } });
  process.send!({ phase: 'result', result });
} catch (error) {
  process.send!({ phase: 'result', code: (error as { code?: string }).code, message: String(error) });
}
process.disconnect!();
