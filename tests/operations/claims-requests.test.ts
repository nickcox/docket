import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applicationId, Database, StorageError } from '../../src/storage/database.ts';
import type { EventInput, StoredEvent } from '../../src/storage/database.ts';
import type { Claim, ClaimInput } from '../../src/storage/claims.ts';
import type { CommandInput, EffectInput, EffectState } from '../../src/storage/requests.ts';

const actor = { kind: 'person', id: 'operator' };
const conflict = (error: unknown) => error instanceof StorageError && error.code === 'conflict';
const mismatch = (error: unknown) => error instanceof StorageError && error.code === 'request_input_mismatch';
const identity = (claim: Claim) => ({ claimId: claim.id, generation: claim.generation });
const command = (requestKey = 'command'): CommandInput => ({ requestKey, operation: 'checks.run', caller: actor, fingerprint: 'fingerprint', input: { profile: 'full' } });
const claimInput = (resourceKey = 'checks:1'): ClaimInput => ({ resourceKey, role: 'check_executor', generation: 'generation',
  ownerRef: { session: 'executor' }, schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() });

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-claims-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [] }, retryMs: 1000 };
  const db = await Database.initialise(path, { contextId: 'claims', repository: { identity: 'example' },
    stateDirectory: root, createdBy: actor, configuration: { revision: 1, resolved: {}, digest: 'test', provenance: {} } }, options);
  t.after(async () => db.close());
  return { db, path, options };
}

async function effectFixture(db: Database, key = 'effect') {
  const [claim] = await db.registerClaims([claimInput(key)], actor);
  const parent = await db.recordCommand(command(`command:${key}`));
  const input: EffectInput = { ...command(key), parentId: parent.id, executor: identity(claim!),
    target: { kind: 'checks', reference: { slot: key } } };
  const effect = await db.recordEffect(input);
  return { claim: claim!, parent, input, effect };
}

function snapshot(db: Database) {
  return { claims: db.claims(), requests: db.requests(), events: db.events() };
}

test('R25: multi-resource claims insert in sorted order, preserve complete identity, and refuse atomically', async t => {
  const { db, path, options } = await fixture(t);
  const inputs = ['z', 'a', 'm'].map(key => claimInput(key));
  const claims = await db.registerClaims(inputs, actor);
  assert.deepEqual(claims.map(claim => claim.resourceKey), ['a', 'm', 'z']);
  for (const claim of claims) {
    assert.deepEqual(claim, { ...inputs.find(input => input.resourceKey === claim.resourceKey),
      id: claim.id, revision: 1, releasedAt: null, releaseEvidence: null });
  }
  assert.deepEqual(db.events().slice(2).map(event => (event.payload.claim as { resourceKey: string }).resourceKey), ['a', 'm', 'z']);
  using sql = new DatabaseSync(path);
  assert.deepEqual(sql.prepare('SELECT resource_key FROM claims ORDER BY rowid').all().map(row => row.resource_key), ['a', 'm', 'z']);
  const before = snapshot(db);
  await assert.rejects(db.registerClaims([claimInput('b'), claimInput('z')], actor), conflict);
  await assert.rejects(db.registerClaims([claimInput('a')], actor), conflict);
  await assert.rejects(db.registerClaims([claimInput('b'), claimInput('b')], actor), /Duplicate/);
  assert.deepEqual(snapshot(db), before);
  using reopened = await Database.open(path, options);
  assert.deepEqual(snapshot(reopened), before);
});

test('A16/A49/R08: admission names stale, future and unreadable claims; time never transfers or releases them', async t => {
  const { db, path } = await fixture(t);
  const now = Date.now();
  const claims = await db.registerClaims(['fresh0', 'fresh29999', 'stale', 'future', 'unreadable'].map(claimInput), actor);
  using seed = new DatabaseSync(path);
  const times = { fresh0: new Date(now).toISOString(), fresh29999: new Date(now - 29_999).toISOString(),
    stale: new Date(now - 30_000).toISOString(), future: new Date(now + 1).toISOString(), unreadable: 'not a time' };
  for (const claim of claims) seed.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run(times[claim.resourceKey as keyof typeof times], claim.id);
  const before = snapshot(db);
  assert.deepEqual(db.admissionBlockers(now), ['future', 'stale', 'unreadable'].map(key => ({ kind: 'claim',
    claimId: claims.find(claim => claim.resourceKey === key)!.id, resourceKey: key,
    reason: key === 'future' ? 'future_dated' : key })));
  assert.equal(db.admissionBlockers(now + 1_000_000).length, 5);
  assert.deepEqual(snapshot(db), before);
  await assert.rejects(db.registerClaims([claimInput('stale')], actor), conflict);
  assert.equal(db.claim(claims.find(claim => claim.resourceKey === 'unreadable')!.id).heartbeatAt, 'not a time');
});

test('R08/R25: heartbeat and release require exact ID/generation; release retains history and evidence', async t => {
  const { db } = await fixture(t);
  const [claim] = await db.registerClaims([{ ...claimInput(), heartbeatAt: '2000-01-01T00:00:00Z' }], actor);
  const expected = identity(claim!);
  const before = snapshot(db);
  for (const wrong of [{ ...expected, claimId: 'missing' }, { ...expected, generation: 'other' }]) {
    await assert.rejects(db.refreshClaim(wrong, new Date().toISOString(), actor), conflict);
    await assert.rejects(db.releaseClaim(wrong, { stopped: true }, actor), conflict);
  }
  await assert.rejects(db.releaseClaim(expected, {}, actor), /evidence/);
  assert.deepEqual(snapshot(db), before);
  const refreshed = await db.refreshClaim(expected, new Date().toISOString(), actor);
  assert.equal(refreshed.revision, 2);
  assert.deepEqual(db.admissionBlockers(), []);
  const evidence = { owner: 'executor', terminal: true, scope: { claimId: claim!.id } };
  const released = await db.releaseClaim(expected, evidence, actor);
  assert.deepEqual(released.releaseEvidence, evidence);
  assert.ok(released.releasedAt);
  assert.equal(released.revision, 3);
  await assert.rejects(db.refreshClaim(expected, new Date().toISOString(), actor), conflict);
  await assert.rejects(db.releaseClaim(expected, evidence, actor), conflict);
  const [next] = await db.registerClaims([{ ...claimInput(), generation: 'new-generation' }], actor);
  assert.notEqual(next!.id, claim!.id);
  await assert.rejects(db.refreshClaim(expected, new Date().toISOString(), actor), conflict);
  assert.deepEqual(db.claim(claim!.id), released);
  assert.equal(db.claims().length, 2);
});

test('A08/R09: command replay compares operation, logical caller and fingerprint and never changes the original', async t => {
  const { db, path, options } = await fixture(t);
  const input = command();
  const original = await db.recordCommand(input);
  const before = snapshot(db);
  assert.deepEqual(await db.recordCommand({ ...input, caller: { id: 'operator', kind: 'person' }, input: { ignored: 'fingerprint defines replay' } }), original);
  for (const patch of [{ operation: 'other' }, { caller: { kind: 'person', id: 'other' } }, { fingerprint: 'other' }]) {
    await assert.rejects(db.recordCommand({ ...input, ...patch }), mismatch);
    assert.deepEqual(snapshot(db), before);
  }
  using reopened = await Database.open(path, { ...options, readOnly: false });
  assert.deepEqual(await reopened.recordCommand(input), original);
});

test('R09: effect input, typed target, command linkage and recorded executor are immutable', async t => {
  const { db } = await fixture(t);
  const { effect, input } = await effectFixture(db);
  assert.deepEqual(await db.recordEffect(input), effect);
  const otherCommand = await db.recordCommand(command('other-command'));
  const [other] = await db.registerClaims([claimInput('other')], actor);
  const before = snapshot(db);
  for (const patch of [{ input: { different: true } }, { target: { kind: 'worker' as const, reference: {} } },
    { parentId: otherCommand.id }, { executor: identity(other!) }, { executor: { ...input.executor, generation: 'different' } },
    { operation: 'other' }, { caller: { id: 'different' } }, { fingerprint: 'other' }]) {
    await assert.rejects(db.recordEffect({ ...input, ...patch }), mismatch);
  }
  await assert.rejects(db.recordEffect({ ...input, requestKey: 'bad-parent', parentId: effect.id }), conflict);
  await assert.rejects(db.recordEffect({ ...input, requestKey: 'bad-caller', caller: { id: 'other' } }), conflict);
  await assert.rejects(db.recordCommand({ ...command(input.requestKey) }), mismatch);
  assert.deepEqual(snapshot(db), before);
});

test('R09/A49: only the recorded claim/generation can claim or finish; claimed and uncertain effects block admission', async t => {
  const { db } = await fixture(t);
  const { effect, claim } = await effectFixture(db);
  const [other] = await db.registerClaims([claimInput('other')], actor);
  const wrong = [identity(other!), { ...identity(claim), generation: 'wrong' }];
  const before = snapshot(db);
  for (const executor of wrong) await assert.rejects(db.claimEffect(effect.id, executor), conflict);
  await assert.rejects(db.recordEffectOutcome(effect.id, identity(claim), 'succeeded', { ok: true }), conflict);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(db.admissionBlockers(), []);
  const claimed = await db.claimEffect(effect.id, identity(claim));
  assert.equal(claimed.state, 'claimed');
  assert.equal(claimed.claimId, claim.id);
  assert.ok(claimed.claimedAt);
  assert.deepEqual(db.admissionBlockers(), [{ kind: 'effect', requestId: effect.id, reason: 'claimed' }]);
  const claimedSnapshot = snapshot(db);
  await assert.rejects(db.claimEffect(effect.id, identity(claim)), conflict);
  for (const executor of wrong) await assert.rejects(db.recordEffectOutcome(effect.id, executor, 'succeeded', { ok: true }), conflict);
  for (const state of ['withdrawn', 'rejected'] as const) await assert.rejects(db.closePendingEffect(effect.id, state, { reason: 'no' }, actor), conflict);
  assert.deepEqual(snapshot(db), claimedSnapshot);
  const uncertain = await db.recordEffectOutcome(effect.id, identity(claim), 'uncertain', { reason: 'interrupted' });
  assert.equal(uncertain.state, 'uncertain');
  assert.deepEqual(db.admissionBlockers(), [{ kind: 'effect', requestId: effect.id, reason: 'uncertain' }]);
  const settled = snapshot(db);
  for (const state of ['succeeded', 'rejected', 'uncertain'] as const) {
    await assert.rejects(db.recordEffectOutcome(effect.id, identity(claim), state, { changed: true }), conflict);
  }
  await assert.rejects(db.claimEffect(effect.id, identity(claim)), conflict);
  assert.deepEqual(snapshot(db), settled);
});

test('R09: pending -> claimed/withdrawn/rejected; claimed -> succeeded/rejected/uncertain, with one immutable outcome', async t => {
  const { db } = await fixture(t);
  for (const final of ['withdrawn', 'rejected', 'succeeded', 'uncertain', 'claimed-rejected'] as const) {
    const { claim, effect } = await effectFixture(db, final);
    const result = { evidence: final };
    let state: EffectState = final === 'claimed-rejected' ? 'rejected' : final;
    if (final === 'withdrawn' || final === 'rejected') {
      await assert.rejects(db.closePendingEffect(effect.id, final, result, { id: 'not-caller' }), conflict);
      await db.closePendingEffect(effect.id, final, result, actor);
    } else {
      await db.claimEffect(effect.id, identity(claim));
      await db.recordEffectOutcome(effect.id, identity(claim), state as 'succeeded' | 'rejected' | 'uncertain', result);
    }
    const stored = db.request(effect.id);
    assert.equal(stored.state, state);
    assert.deepEqual(stored.result, result);
    const before = snapshot(db);
    await assert.rejects(db.claimEffect(effect.id, identity(claim)), conflict);
    for (const next of ['withdrawn', 'rejected'] as const) await assert.rejects(db.closePendingEffect(effect.id, next, result, actor), conflict);
    for (const next of ['succeeded', 'rejected', 'uncertain'] as const) await assert.rejects(db.recordEffectOutcome(effect.id, identity(claim), next, result), conflict);
    assert.deepEqual(snapshot(db), before);
  }
});

test('R25/R26: stale config/schema, released/stale executor and mismatched scope refuse under the write lock', async t => {
  const { db, path } = await fixture(t);
  for (const patch of [{ configRevision: 2 }, { schemaFamily: 123 }, { schemaVersion: 2 }]) {
    await assert.rejects(db.registerClaims([{ ...claimInput(), ...patch }], actor), StorageError);
  }
  const { effect, claim } = await effectFixture(db);
  await db.refreshClaim(identity(claim), '2000-01-01T00:00:00Z', actor);
  await assert.rejects(db.claimEffect(effect.id, identity(claim)), conflict);
  await db.releaseClaim(identity(claim), { terminal: true }, actor);
  await assert.rejects(db.claimEffect(effect.id, identity(claim)), conflict);
  const other = await effectFixture(db, 'config');
  using seed = new DatabaseSync(path);
  seed.prepare("UPDATE events SET payload = json_set(payload, '$.revision', 2) WHERE kind = 'context.configured'").run();
  await assert.rejects(db.refreshClaim(identity(other.claim), new Date().toISOString(), actor), conflict);
  await assert.rejects(db.claimEffect(other.effect.id, identity(other.claim)), conflict);
});

test('A09/A10/R25: every new transaction rolls back state and event on injected failure before and after insertion', async t => {
  const changes: [string, (db: Database, claim: Claim, input: EffectInput) => Promise<unknown>, boolean?][] = [
    ['registerClaims', db => db.registerClaims([claimInput('z'), claimInput('a')], actor)],
    ['refreshClaim', (db, claim) => db.refreshClaim(identity(claim), new Date().toISOString(), actor)],
    ['releaseClaim', (db, claim) => db.releaseClaim(identity(claim), { terminal: true }, actor)],
    ['recordCommand', db => db.recordCommand(command('new-command'))],
    ['recordEffect', (db, _claim, input) => db.recordEffect({ ...input, requestKey: 'new-effect' })],
    ['claimEffect', (db, claim, input) => db.claimEffect(db.requests().find(request => request.requestKey === input.requestKey)!.id, identity(claim))],
    ...(['withdrawn', 'rejected'] as const).map(state => [state, (db: Database, _claim: Claim, input: EffectInput) =>
      db.closePendingEffect(db.requests().find(request => request.requestKey === input.requestKey)!.id, state, { reason: 'proof' }, actor)] as [string, (db: Database, claim: Claim, input: EffectInput) => Promise<unknown>]),
    ...(['succeeded', 'rejected', 'uncertain'] as const).map(state => [`outcome:${state}`, (db: Database, claim: Claim, input: EffectInput) =>
      db.recordEffectOutcome(db.requests().find(request => request.requestKey === input.requestKey)!.id, identity(claim), state, { evidence: true }), true] as [string, (db: Database, claim: Claim, input: EffectInput) => Promise<unknown>, boolean]),
  ];
  for (const [name, change, claimed] of changes) for (const afterEvent of [false, true]) {
    await t.test(`${name}: failure ${afterEvent ? 'after' : 'before'} event`, async t => {
      const { db, path, options } = await fixture(t);
      const { claim, input, effect } = await effectFixture(db);
      if (claimed) await db.claimEffect(effect.id, identity(claim));
      const before = snapshot(db);
      const internals = db as unknown as { insertEvent: (input: EventInput) => StoredEvent };
      const original = internals.insertEvent;
      internals.insertEvent = function (input) {
        if (afterEvent) original.call(db, input);
        throw new Error('injected transaction failure');
      };
      try { await assert.rejects(change(db, claim, input), /injected transaction failure/); }
      finally { internals.insertEvent = original; }
      using reopened = await Database.open(path, options);
      assert.deepEqual(snapshot(reopened), before);
      await change(db, claim, input);
      assert.ok(db.events().length > before.events.length);
    });
  }
});

test('R25: read-only claims/requests/admission never mutate; public inputs reject unknown fields and detach before lock retry', async t => {
  const { db, path, options } = await fixture(t);
  const { claim, effect, input } = await effectFixture(db);
  using readonly = await Database.open(path, options);
  const before = snapshot(db);
  for (const operation of [() => readonly.registerClaims([claimInput('new')], actor),
    () => readonly.refreshClaim(identity(claim), new Date().toISOString(), actor),
    () => readonly.releaseClaim(identity(claim), { stopped: true }, actor),
    () => readonly.recordCommand(command('new')), () => readonly.recordEffect({ ...input, requestKey: 'new-effect' }),
    () => readonly.claimEffect(effect.id, identity(claim)),
    () => readonly.closePendingEffect(effect.id, 'withdrawn', { reason: 'stop' }, actor),
    () => readonly.recordEffectOutcome(effect.id, identity(claim), 'uncertain', { reason: 'stop' })]) {
    await assert.rejects(operation(), error => error instanceof StorageError && error.code === 'read_only');
  }
  assert.deepEqual(readonly.admissionBlockers(), []);
  assert.deepEqual(snapshot(db), before);
  await assert.rejects(db.registerClaims([{ ...claimInput('new'), unexpected: true } as ClaimInput], actor), /Unknown/);
  await assert.rejects(db.recordCommand({ ...command(), unexpected: true } as CommandInput), /Unknown/);
  await assert.rejects(db.recordEffect({ ...input, target: { ...input.target, unexpected: true } } as EffectInput), /Unknown/);
  using locker = new DatabaseSync(path);
  locker.exec('BEGIN IMMEDIATE');
  const value = claimInput('detached');
  const owner = { id: 'original' };
  const pending = db.registerClaims([value], owner);
  value.resourceKey = 'mutated'; value.ownerRef.session = 'mutated'; owner.id = 'mutated';
  locker.exec('COMMIT');
  const [stored] = await pending;
  assert.equal(stored!.resourceKey, 'detached');
  assert.equal(stored!.ownerRef.session, 'executor');
  assert.equal(db.events().at(-1)!.actor.id, 'original');
});
