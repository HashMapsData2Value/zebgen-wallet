import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combinedContextStorageKey,
  listCombinedContextBindings,
  loadCombinedContext,
  saveCombinedContext,
  validateCombinedContext,
} from '../lib/wallet/combinedAddressContext.ts';

const context = {
  version: 1,
  walletId: 1,
  network: 'regtest',
  combinedAddress: '4'.repeat(95),
  counterpartyPublicSpendKey: 'ab'.repeat(32),
  counterpartyPrivateViewKey: 'cd'.repeat(32),
  restoreHeight: 100,
};
function storageFixture() {
  const data = {};
  return {
    data,
    async get(key) {
      return structuredClone(key === null ? data : { [key]: data[key] });
    },
    async set(items) {
      Object.assign(data, JSON.parse(JSON.stringify(items)));
    },
  };
}

test('encrypted context survives JSON storage and preserves the earliest restore height', async () => {
  const storage = storageFixture();
  await saveCombinedContext(storage, context, 'password');
  await saveCombinedContext(storage, { ...context, restoreHeight: 900 }, 'password');
  assert.deepEqual(await loadCombinedContext(storage, context, 'password'), context);
  await saveCombinedContext(storage, { ...context, restoreHeight: 0 }, 'password');
  assert.equal((await loadCombinedContext(storage, context, 'password')).restoreHeight, 0);
  assert.equal(JSON.stringify(storage.data).includes(context.counterpartyPrivateViewKey), false);
  assert.equal(JSON.stringify(storage.data).includes(context.counterpartyPublicSpendKey), false);
  assert.deepEqual(await listCombinedContextBindings(storage), [
    { walletId: 1, network: 'regtest', combinedAddress: context.combinedAddress },
  ]);
});

test('wrong passwords, ciphertext tampering, and substituted owner/network/address fail closed', async () => {
  const storage = storageFixture();
  await saveCombinedContext(storage, context, 'password');
  const key = combinedContextStorageKey(context);
  await assert.rejects(loadCombinedContext(storage, context, 'wrong password'));
  await assert.rejects(
    saveCombinedContext(storage, { ...context, restoreHeight: 900 }, 'wrong password'),
  );
  for (const binding of [
    { ...context, walletId: 2 },
    { ...context, network: 'mainnet' },
    { ...context, combinedAddress: '5'.repeat(95) },
  ]) {
    assert.equal(await loadCombinedContext(storage, binding, 'password'), null);
    storage.data[combinedContextStorageKey(binding)] = storage.data[key];
    await assert.rejects(loadCombinedContext(storage, binding, 'password'), /mismatched/);
  }
  storage.data[key].ciphertext[0] ^= 1;
  await assert.rejects(loadCombinedContext(storage, context, 'password'));
});

test('metadata, key and height validation reject malformed context before storage', async () => {
  for (const change of [
    { version: 2 },
    { walletId: 0 },
    { network: 'unknown' },
    { combinedAddress: '' },
    { counterpartyPrivateViewKey: 'xx'.repeat(32) },
    { counterpartyPublicSpendKey: '' },
    ...[-1, 1.5, 0x100000000, NaN, undefined].map((restoreHeight) => ({ restoreHeight })),
  ]) {
    assert.throws(() => validateCombinedContext({ ...context, ...change }, context));
  }
  const storage = storageFixture();
  await saveCombinedContext(storage, context, 'password');
  await assert.rejects(
    saveCombinedContext(
      storage,
      { ...context, counterpartyPrivateViewKey: 'ef'.repeat(32) },
      'password',
    ),
    /Counterparty/,
  );
  assert.deepEqual(await loadCombinedContext(storage, context, 'password'), context);
});

test('same-address mainnet and regtest contexts retain independent heights and owners', async () => {
  const storage = storageFixture();
  await saveCombinedContext(storage, context, 'password');
  const mainnet = { ...context, network: 'mainnet', restoreHeight: 3000000 };
  const otherOwner = { ...context, walletId: 2, restoreHeight: 400 };
  await saveCombinedContext(storage, mainnet, 'password');
  await saveCombinedContext(storage, otherOwner, 'password');
  await saveCombinedContext(storage, { ...context, restoreHeight: 999 }, 'password');
  assert.deepEqual(await loadCombinedContext(storage, context, 'password'), context);
  assert.deepEqual(await loadCombinedContext(storage, mainnet, 'password'), mainnet);
  assert.deepEqual(await loadCombinedContext(storage, otherOwner, 'password'), otherOwner);
  assert.equal((await listCombinedContextBindings(storage)).length, 3);
});

test('invalid encryption envelopes fail closed without replacing saved ciphertext', async () => {
  const storage = storageFixture();
  await saveCombinedContext(storage, context, 'password');
  const key = combinedContextStorageKey(context);
  const original = structuredClone(storage.data[key]);
  for (const change of [
    { version: 2 },
    { salt: [] },
    { iv: [] },
    { ciphertext: [-1] },
    { ciphertext: [1.5] },
    { ciphertext: 'plaintext' },
  ]) {
    storage.data[key] = { ...original, ...change };
    await assert.rejects(loadCombinedContext(storage, context, 'password'), /Invalid encrypted/);
    await assert.rejects(saveCombinedContext(storage, context, 'password'), /Invalid encrypted/);
    assert.deepEqual(storage.data[key], { ...original, ...change });
  }
});
