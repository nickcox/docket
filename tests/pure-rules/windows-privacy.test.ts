import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivateFileError, windowsPrivacyReason, windowsPrivateFile, windowsSecurePrivateDirectory } from '../../src/adapters/host-files.ts';
import { hostBindingRefusal } from '../../src/host-binding.ts';
import { runCli } from '../../src/cli.ts';

const user = 'S-1-5-21-1000';
const administrators = 'S-1-5-32-544';
const system = 'S-1-5-18';
const other = 'S-1-5-21-2000';

// Recorded SID inputs, independent of the machine running this test.
test('R17 A37: one Windows privacy decision accepts user or Administrators ownership and excludes other accounts', () => {
  for (const owner of [user, administrators]) {
    assert.equal(windowsPrivacyReason({ user, owner, entries: [user, system, administrators].map(sid => ({ sid, allow: true })) }), null);
  }
  for (const owner of [other, system]) {
    assert.match(windowsPrivacyReason({ user, owner, entries: [] })!, new RegExp(`owner SID ${owner}; owner mismatch`, 'u'));
  }
  for (const sid of ['S-1-5-32-545', 'S-1-1-0', other]) {
    assert.match(windowsPrivacyReason({ user, owner: administrators, entries: [{ sid, allow: true }] })!, new RegExp(`owner SID ${administrators}; access entry for another account: ${sid}`, 'u'));
    assert.equal(windowsPrivacyReason({ user, owner: user, entries: [{ sid, allow: false }] }), null);
  }
});

test('R17 A37: file checks and worker/supervisor directory securing apply the same Windows privacy decision', async () => {
  for (const check of [windowsPrivateFile, windowsSecurePrivateDirectory]) {
    for (const owner of [user, administrators, other]) {
      const result = check('unused', () => async () => ({ complete: true, code: 0, stderr: '',
        stdout: JSON.stringify({ user, owner, secured: true, entries: [{ sid: system, allow: true }] }) }));
      if (owner === other) await assert.rejects(result, /owner mismatch/u);
      else await result;
    }
    await assert.rejects(check('unused', () => async () => ({ complete: false, code: 1, stdout: 'secret', stderr: 'secret' })), /ACL could not be/u);
  }
});

test('R17 A37: every host binding refusal reaches bounded response diagnostics without binding values or secrets', async () => {
  const reasons = ['linked path', 'not a directory', 'not a regular file', 'more than one hard link', 'too large',
    'owner mismatch', 'group or other access', 'file or directory is missing', 'file or directory access denied', 'Windows ACL could not be read', 'Windows directory ACL could not be secured or read',
    'wrong version', 'invalid content', 'file changed while opening', 'existing binding differs', 'Windows directory ACL replacement could not be verified',
    windowsPrivacyReason({ user, owner: other, entries: [{ sid: 'S-1-1-0', allow: true }] })!];
  for (const reason of reasons) {
    let output = '';
    const code = await runCli(['host', 'bind', '--context', 'test', '--stdin', '--json'], {
      readFile: async () => '', readStdin: async () => JSON.stringify({ directory: 'unused', operations: ['catalog.show'] }),
      stdout: text => { output += text; }, stderr: () => {},
    }, async () => { throw hostBindingRefusal(new PrivateFileError(reason), 'unused'); });
    assert.equal(code, 2);
    const envelope = JSON.parse(output);
    assert.equal(envelope.code, 'invalid_input');
    assert.equal(envelope.diagnostics[0].message, `Host binding refused: ${reason}.`);
    assert.ok(envelope.diagnostics[0].message.length <= 1024);
  }
  for (const [code, reason] of [['ENOENT', 'file or directory is missing'], ['ENOTDIR', 'not a directory'], ['ELOOP', 'linked path'], ['EACCES', 'file or directory access denied']]) {
    assert.equal(hostBindingRefusal(Object.assign(new Error('secret'), { code }), '').diagnostic, `Host binding refused: ${reason}.`);
  }
  const failure = hostBindingRefusal(new Error('secret content or path'), 'file metadata or binding could not be read');
  assert.equal(failure.diagnostic, 'Host binding refused: file metadata or binding could not be read.');
  assert.ok(hostBindingRefusal(new PrivateFileError('x'.repeat(2000)), '').diagnostic!.length <= 1024);
});
