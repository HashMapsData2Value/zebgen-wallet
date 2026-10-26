import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encryptSeed } from '../lib/wallet/seedVault.ts';
import { saveSwapRecord, listSwapRecords, saveSignedTransactions, listSignedTransactions, loadSettlementEvidence, saveSettlementEvidence } from '../lib/wallet/swapRecords.ts';

function storage() {
  let data = {};
  return {
    get: async (key) => structuredClone(key === null ? data : { [key]: data[key] }),
    set: async (items) => { data = JSON.parse(JSON.stringify({ ...data, ...items })); },
  };
}
const record = {
  version: 1, genesisHash: 'A'.repeat(43) + '=', appId: '123', appAddress: 'A'.repeat(58),
  role: 'ali', algoAddress: 'B'.repeat(58), aliAddress: 'B'.repeat(58), xinAddress: 'C'.repeat(58), t0: 100, t1: 200,
  deadlineUnit: 'round', createdRound: 50,
  context: {
    version: 1, walletId: 1, network: 'regtest', combinedAddress: '4'.repeat(95),
    counterpartyPublicSpendKey: 'ab'.repeat(32), counterpartyPrivateViewKey: 'cd'.repeat(32), restoreHeight: 50
  },
};

test('round metadata survives persistence and legacy records cannot silently change units', async () => {
  const store = storage();
  const round = { ...record, deadlineUnit: 'round', createdRound: 50 };
  await saveSwapRecord(store, round, 'secret');
  assert.deepEqual(await listSwapRecords(store, 'secret'), [round]);
  for (const invalid of [{ ...record, createdRound: undefined }, { ...record, deadlineUnit: undefined }, { ...round, createdRound: 100 }]) await assert.rejects(saveSwapRecord(storage(), invalid, 'secret'), /Invalid saved swap|Legacy timestamp/);
  const legacy = storage();
  const oldRecord = { ...record };
  delete oldRecord.deadlineUnit;
  delete oldRecord.createdRound;
  const encrypted = await encryptSeed(new TextEncoder().encode(JSON.stringify(oldRecord)), 'secret');
  await legacy.set({ ['leakswapRecord:' + JSON.stringify([record.genesisHash, record.algoAddress, record.context.walletId, record.appId])]: {
    version: 1, ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)), salt: Array.from(encrypted.salt), iv: Array.from(encrypted.iv),
  } });
  const before = await legacy.get(null);
  await assert.rejects(listSwapRecords(legacy, 'secret'), /Legacy timestamp/);
  await assert.rejects(saveSwapRecord(legacy, round, 'secret'), /Legacy timestamp/);
  assert.deepEqual(await legacy.get(null), before);
});

test('encrypted swap survives JSON storage, preserves earliest height, rejects identity replacement', async () => {
  const store = storage();
  await saveSwapRecord(store, record, 'secret');
  assert.equal(JSON.stringify(await store.get(null)).includes(record.context.counterpartyPrivateViewKey), false);
  await saveSwapRecord(store, { ...record, context: { ...record.context, restoreHeight: 70 } }, 'secret');
  assert.deepEqual(await listSwapRecords(store, 'secret'), [record]);
  await assert.rejects(listSwapRecords(store, 'wrong'));
  await assert.rejects(saveSwapRecord(store, { ...record, t1: 201 }, 'secret'), /identity/);
  const raw = await store.get(null);
  const key = Object.keys(raw)[0];
  raw[key].ciphertext[0] ^= 1;
  await store.set(raw);
  await assert.rejects(listSwapRecords(store, 'secret'));
});

test('networks remain distinct and swapped encrypted records fail closed', async () => {
  const store = storage();
  await saveSwapRecord(store, record, 'secret');
  await saveSwapRecord(store, { ...record, genesisHash: 'B'.repeat(43) + '=' }, 'secret');
  assert.equal((await listSwapRecords(store, 'secret')).length, 2);
  const raw = await store.get(null);
  const keys = Object.keys(raw);
  await store.set({ [keys[0]]: raw[keys[1]] });
  await assert.rejects(listSwapRecords(store, 'secret'), /index/);
});

test('confirmed settlement survives reopening and cannot be replaced or cleared by a stale save', async () => {
  const store = storage();
  const settlement = { kind: 'claim', txId: 'A'.repeat(52), confirmedRound: '1135' };
  await saveSwapRecord(store, record, 'secret');
  await saveSwapRecord(store, { ...record, settlement }, 'secret');
  await saveSwapRecord(store, record, 'secret');
  assert.deepEqual((await listSwapRecords(store, 'secret'))[0].settlement, settlement);
  await assert.rejects(saveSwapRecord(store, { ...record, settlement: { ...settlement, kind: 'refund' } }, 'secret'), /cannot be replaced/);
  await assert.rejects(saveSwapRecord(store, { ...record, settlement: { ...settlement, confirmedRound: '0' } }, 'secret'), /settlement/);
});

test('signed transaction journal survives lost page state without claiming confirmation', async () => {
  const store = storage();
  const entry = {
    version: 1, genesisHash: record.genesisHash, txId: 'A'.repeat(52), sender: record.algoAddress,
    origin: 'https://app.leakswap.com', firstValid: '1', lastValid: '1000', unsignedTransaction: 'AQID', signedAt: new Date().toISOString()
  };
  await saveSignedTransactions(store, [entry], 'secret');
  assert.deepEqual(await listSignedTransactions(store, 'secret'), [entry]);
  assert.equal('confirmedRound' in (await listSignedTransactions(store, 'secret'))[0], false);
  await assert.rejects(saveSignedTransactions(store, [{ ...entry, lastValid: '0' }], 'secret'));
});

test('settlement evidence is encrypted, survives reopening, is immutable and bound to its swap', async () => {
  const store = storage();
  const evidence = { txId: 'A'.repeat(52), confirmedRound: '12', transaction: 'AQIDBA==' };
  await saveSettlementEvidence(store, record, evidence, 'secret');
  assert.deepEqual(await loadSettlementEvidence(store, record, 'secret'), evidence);
  assert.ok(!JSON.stringify(await store.get(null)).includes(evidence.transaction));
  assert.equal(await loadSettlementEvidence(store, { ...record, appId: '456' }, 'secret'), null);
  await assert.rejects(loadSettlementEvidence(store, record, 'wrong'));
  await assert.rejects(saveSettlementEvidence(store, record, { ...evidence, txId: 'B'.repeat(52) }, 'secret'), /cannot be replaced/);
});