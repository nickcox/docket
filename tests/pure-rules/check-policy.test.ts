import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEvidenceKey, mandatoryChecks, parseCheckPolicy } from '../../src/check-policy.ts';
import { contextChecks, head, policyContent, profile, start } from '../helpers/check-attempt.ts';

const repository = { path: '/repository' };
test('R15: absent policy is explicit, malformed policy and duplicate repository/context names refuse', () => {
  const absent = parseCheckPolicy(start, null, contextChecks);
  assert.equal(absent.present, false); assert.equal(absent.sourceDigest, null);
  assert.deepEqual(absent.fast, []); assert.deepEqual(absent.full, []);
  for (const source of ['{', '{}', '{"version":1,"version":1,"fast":[],"full":[]}', '{"version":2,"fast":[],"full":[]}',
    '{"version":1,"fast":[],"full":[],"unknown":true}']) assert.throws(() => parseCheckPolicy(start, source, contextChecks));
  const check = { name: 'same', command: ['test'], timeoutMs: 1 };
  assert.throws(() => parseCheckPolicy(start, JSON.stringify({ version: 1, fast: [check], full: [] }), { ...contextChecks, fast: [], full: [check] }), /Duplicate/);
  for (const timeoutMs of [0, -1, 1.5, 2147483648]) {
    assert.throws(() => parseCheckPolicy(start, JSON.stringify({ version: 1, fast: [{ ...check, timeoutMs }], full: [] }), contextChecks));
  }
});

test('R15: exact evidence identity excludes policy source commit, credentials and object ordering', () => {
  const policy = parseCheckPolicy(start, policyContent, contextChecks);
  const key = checkEvidenceKey(repository, head, ['criterion'], policy, profile);
  assert.equal(checkEvidenceKey(repository, head, ['criterion'], { ...policy, sourceCommit: head }, profile), key);
  assert.equal(checkEvidenceKey(repository, head, ['criterion'], policy, { ignoredGeneratedPaths: profile.ignoredGeneratedPaths!, dependencies: profile.dependencies, tools: profile.tools, id: profile.id }), key);
  assert.throws(() => checkEvidenceKey(repository, head, ['criterion'], policy, { ...profile, environment: { TOKEN: 'credential' } }), /Malformed/);
  const changes = [
    checkEvidenceKey({ path: '/other' }, head, ['criterion'], policy, profile),
    checkEvidenceKey(repository, start, ['criterion'], policy, profile),
    checkEvidenceKey(repository, head, ['changed criterion'], policy, profile),
    checkEvidenceKey(repository, head, ['criterion'], { ...policy, digest: 'changed' }, profile),
    checkEvidenceKey(repository, head, ['criterion'], { ...policy, fast: [{ ...policy.fast[0]!, timeoutMs: 2 }] }, profile),
    checkEvidenceKey(repository, head, ['criterion'], policy, { ...profile, tools: { node: 'next' } }),
    checkEvidenceKey(repository, head, ['criterion'], policy, { ...profile, dependencies: { lock: 'next' } }),
  ];
  for (const changed of changes) assert.notEqual(changed, key);
});

test('R15: weakening current policy keeps recorded definitions, differing definitions with the same name both remain mandatory', () => {
  const recorded = parseCheckPolicy(start, policyContent, contextChecks);
  const removed = parseCheckPolicy(head, null, contextChecks);
  assert.deepEqual(mandatoryChecks(recorded, removed).full, recorded.full);
  assert.equal(mandatoryChecks(recorded, recorded).full.length, 1);
  const current = parseCheckPolicy(head, JSON.stringify({ version: 1, fast: recorded.fast,
    full: [{ ...recorded.full[0]!, command: ['new-full'] }] }), contextChecks);
  assert.equal(mandatoryChecks(recorded, current).full.length, 2);
  assert.notEqual(mandatoryChecks(recorded, current).digest, mandatoryChecks(recorded, recorded).digest);
});
