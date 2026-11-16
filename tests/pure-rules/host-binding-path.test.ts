import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import test from 'node:test';
import { assertUnlinkedHostPath } from '../../src/host-binding.ts';

test('R17 A37: host binding link checks accept Windows short names and letter case without comparing realpath spelling', async () => {
  const short = win32.join('C:\\', 'Users', 'RUNNER~1', 'AppData', 'Local', 'Temp', 'host', 'binding.json');
  const long = win32.join('C:\\', 'Users', 'runneradmin', 'AppData', 'Local', 'Temp', 'host', 'binding.json');
  assert.notEqual(short, long);
  for (const path of [short, long, long.toUpperCase()]) {
    const inspected: string[] = [];
    await assertUnlinkedHostPath(path, async component => {
      inspected.push(component);
      return { isSymbolicLink: () => false };
    }, win32);
    assert.equal(inspected[0], path);
    assert.equal(inspected.at(-1), win32.parse(path).root);
    assert.ok(inspected.includes(win32.dirname(path)));
    // A link in the file, dedicated directory or any ancestor still refuses.
    for (const linked of inspected) {
      await assert.rejects(assertUnlinkedHostPath(path, async component => ({
        isSymbolicLink: () => component === linked,
      }), win32), /Linked path/);
    }
  }
});
