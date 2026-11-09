import { lstat, open, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Result } from './command.ts';
import type { JsonObject } from '../storage/database.ts';

/** Workers publish by renaming a complete JSON file into questionsDirectory. */
export async function questionFiles(resultPath: string, consumed: ReadonlySet<string> = new Set()): Promise<{ name: string; value: unknown; invalid: boolean }[]> {
  const directory = join(dirname(resultPath), 'questions');
  let names: string[];
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Question directory is not a regular directory');
    names = await readdir(directory);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const name of names.sort().filter(n => n.endsWith('.json') && !consumed.has(n))) {
    try {
      const path = join(directory, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1048576) throw new Error('Invalid question file');
      const handle = await open(path, 'r');
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > 1048576) throw new Error('Question file changed');
        const buffer = Buffer.alloc(1048577);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > 1048576) throw new Error('Question file exceeds size limit');
        results.push({ name, value: JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown, invalid: false });
      } finally { await handle.close(); }
    } catch { results.push({ name, value: null, invalid: true }); }
  }
  return results;
}

/** An answer is a separate retained file, never an activation or a resumed turn. */
export async function deliverQuestionFile(resultPath: string, answer: JsonObject): Promise<Result<JsonObject>> {
  try {
    const directory = join(dirname(resultPath), 'answers');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${String(answer.questionId)}.json`);
    await writeFile(path, JSON.stringify(answer), { flag: 'wx', mode: 0o600 });
    return { status: 'confirmed', value: { path } };
  } catch (error) { return { status: 'uncertain', reason: String(error), referenceHints: null }; }
}
