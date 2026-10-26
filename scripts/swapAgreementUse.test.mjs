import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agreementUseKey, nextAgreementUse, reserveAgreementUse } from '../lib/wallet/swapAgreementUse.ts';

const identity = { genesisHash: 'A'.repeat(43) + '=', digest: 'ab'.repeat(32) };
const deployment = { deploymentTxId: 'A'.repeat(52) };
const differentDeployment = { deploymentTxId: 'B'.repeat(52) };

function storage() {
  const records = new Map();
  let queue = Promise.resolve();
  return {
    records,
    savedAppIds: async () => [],
    withLock(action) {
      const result = queue.then(action);
      queue = result.catch(() => { });
      return result;
    },
    read: async (key) => structuredClone(records.get(key) ?? null),
    write: async (key, record) => { records.set(key, structuredClone(record)); },
  };
}

test('deployment reservation survives response loss and permits only the exact unsigned txID', async () => {
  const store = storage();
  await reserveAgreementUse(store, identity, deployment);
  await reserveAgreementUse({ ...store }, identity, deployment);
  await assert.rejects(reserveAgreementUse(store, identity, differentDeployment), /permanently/);
  assert.deepEqual(store.records.get(agreementUseKey(identity)), { version: 1, ...identity, ...deployment });
  assert.equal('confirmedRound' in store.records.get(agreementUseKey(identity)), false);
});

test('first verified application is immutable and preserves the deployment reservation', async () => {
  const store = storage();
  await reserveAgreementUse(store, identity, deployment);
  await reserveAgreementUse(store, identity, { appId: '123' });
  await reserveAgreementUse(store, identity, { appId: '123' });
  await reserveAgreementUse(store, identity, deployment);
  await assert.rejects(reserveAgreementUse(store, identity, { appId: '124' }), /another application/);
  await assert.rejects(reserveAgreementUse(store, identity, differentDeployment), /permanently/);
  assert.deepEqual(store.records.get(agreementUseKey(identity)), { version: 1, ...identity, ...deployment, appId: '123' });
});

test('existing-app first use prevents subsequent deployment', async () => {
  const store = storage();
  await reserveAgreementUse(store, identity, { appId: '123' });
  await assert.rejects(reserveAgreementUse(store, identity, deployment), /permanently/);
});

test('saved legacy agreement records constrain first use without modifying recovery records', async () => {
  const saved = ['123'];
  const record = nextAgreementUse(identity, null, { appId: '123' }, saved);
  assert.deepEqual(saved, ['123']);
  assert.equal(record.appId, '123');
  assert.throws(() => nextAgreementUse(identity, null, { appId: '124' }, saved), /another application/);
  assert.throws(() => nextAgreementUse(identity, null, deployment, saved), /permanently/);
  assert.throws(() => nextAgreementUse(identity, null, { appId: '123' }, ['123', '124']), /another application/);
});

test('competing approval contexts serialize deployment reservations', async () => {
  const store = storage();
  const results = await Promise.allSettled([
    reserveAgreementUse({ ...store }, identity, deployment),
    reserveAgreementUse({ ...store }, identity, differentDeployment),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  await reserveAgreementUse(store, identity, deployment);
});

test('competing save and funding contexts cannot bind two app IDs', async () => {
  const store = storage();
  const results = await Promise.allSettled(['123', '124'].map((appId) =>
    reserveAgreementUse({ ...store }, identity, { appId })));
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
});

test('deployment racing existing-app first use fails closed in either lock order', async () => {
  for (const requests of [[{ appId: '123' }, deployment], [deployment, { appId: '123' }]]) {
    const store = storage();
    const results = await Promise.allSettled(requests.map((use) => reserveAgreementUse(store, identity, use)));
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'appId' in requests[0] ? 'rejected' : 'fulfilled');
    await assert.rejects(reserveAgreementUse(store, identity, differentDeployment), /permanently/);
  }
});

test('storage read, legacy lookup and write failures propagate before approval succeeds', async () => {
  for (const operation of ['read', 'savedAppIds', 'write']) {
    const store = storage();
    store[operation] = async () => { throw new Error(operation + ' failed'); };
    await assert.rejects(reserveAgreementUse(store, identity, deployment), new RegExp(operation + ' failed'));
    assert.equal(store.records.size, 0);
  }
});

test('persisted write followed by a lost response still consumes the reservation', async () => {
  const store = storage();
  const write = store.write;
  await assert.rejects(reserveAgreementUse({
    ...store, write: async (...args) => {
      await write(...args);
      throw new Error('response lost');
    }
  }, identity, deployment), /response lost/);
  await assert.rejects(reserveAgreementUse(store, identity, differentDeployment), /permanently/);
  await reserveAgreementUse(store, identity, deployment);
});

test('malformed, future-version and identity-swapped records fail closed', () => {
  const valid = { version: 1, ...identity, ...deployment };
  for (const previous of [undefined, {}, { ...valid, version: 2 }, { ...valid, digest: 'cd'.repeat(32) },
    { ...valid, genesisHash: 'B'.repeat(43) + '=' }, { ...valid, deploymentTxId: '' },
    { ...valid, appId: '01' }, { ...valid, appId: '18446744073709551616' }, { ...valid, confirmed: true }]) {
    assert.throws(() => nextAgreementUse(identity, previous, deployment, []));
  }
  for (const use of [{ appId: '0' }, { appId: '01' }, { deploymentTxId: 'invalid' }]) {
    assert.throws(() => nextAgreementUse(identity, null, use, []));
  }
});

test('digest and genesis scope storage and lock-independent identities', async () => {
  const store = storage();
  await reserveAgreementUse(store, identity, deployment);
  for (const other of [{ ...identity, digest: 'cd'.repeat(32) }, { ...identity, genesisHash: 'B'.repeat(43) + '=' }]) {
    assert.notEqual(agreementUseKey(identity), agreementUseKey(other));
    await reserveAgreementUse(store, other, differentDeployment);
  }
  assert.equal(store.records.size, 3);
});