import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { MAX_INPUT_BYTES, runCli } from '../../src/cli.ts';
import { executeOperation } from '../../src/catalog.ts';
import { executeCoreOperation } from '../../src/operations.ts';
import { createRuntime } from '../../src/runtime.ts';

// Only this test entry point substitutes the Windows ACL operations.
async function readInput(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Input exceeds the limit.');
    chunks.push(bytes);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

const outputController = new AbortController();
process.stdout.on('error', error => {
  outputController.abort(error);
  process.exitCode = 3;
  if (process.argv[2] !== 'status' || process.argv[3] !== 'watch') {
    process.stderr.write('Unable to write the response; do not infer absence of effects.\n');
  }
});

process.exitCode = await runCli(process.argv.slice(2), {
  outputSignal: outputController.signal,
  readFile: path => readInput(createReadStream(path)),
  readStdin: () => readInput(process.stdin),
  stdout: text => { process.stdout.write(text); },
  stderr: text => { process.stderr.write(text); },
}, (operation, args, progress, selector, requestId, watch) => {
  if (operation.name === 'catalog.show' || !selector) return executeOperation(operation, args, progress, selector, requestId);
  return executeCoreOperation(operation, args, progress, selector, requestId, {
    watch,
    runtime: (db, config, home) => createRuntime(db, config, home, {
      windowsSettingsWritableOnlyByOwner: async () => true,
      windowsSecurePrivateDirectory: async () => {},
    }),
  });
});
