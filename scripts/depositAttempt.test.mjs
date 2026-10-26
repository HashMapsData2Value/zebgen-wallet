import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

function fixture({ lockUnavailable = false, writeFails = false } = {}) {
  const records = {};
  const queues = new Map();
  const storage = {
    get: async (key) => ({ [key]: records[key] }),
    set: async (items) => {
      if (writeFails) throw new Error('Storage unavailable');
      Object.assign(records, items);
    },
  };
  const locks = {
    request: (key, callback) => {
      const pending = (queues.get(key) ?? Promise.resolve()).then(callback);
      queues.set(
        key,
        pending.catch(() => {}),
      );
      return pending;
    },
  };
  const source = ts.transpileModule(
    readFileSync(new URL('../lib/wallet/depositAttempt.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const seedVault = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../lib/wallet/seedVault.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    { exports: seedVault, crypto: webcrypto, TextEncoder, Uint8Array, ArrayBuffer },
  );
  const open = () => {
    const api = {};
    runInNewContext(source, {
      exports: api,
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      navigator: lockUnavailable ? {} : { locks },
      require: () => seedVault,
    });
    return api;
  };
  const attempt = {
    binding: {
      agreementDigest: 'ab'.repeat(32),
      appId: '42',
      genesisHash: 'genesis',
      moneroNetwork: 'regtest',
    },
    hash: 'a'.repeat(64),
    amountAtomic: '10',
    feeAtomic: '1',
    state: 'relaying',
  };
  return { open, storage, attempt, records };
}

test('sequential, concurrent and reopened contexts cannot reserve the same deposit twice', async () => {
  const { open, storage, attempt } = fixture();
  const results = await Promise.all(
    [open(), open()].map((api) => api.reserveDepositAttempt(storage, attempt, 'pin')),
  );
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.equal((await open().reserveDepositAttempt(storage, attempt, 'pin')).hash, attempt.hash);
  for (const state of ['submitted', 'unknown']) {
    await open().updateDepositAttempt(storage, { ...attempt, state }, 'pin');
    assert.equal((await open().reserveDepositAttempt(storage, attempt, 'pin')).state, state);
  }
});

test('actual genesis identity separates reservations, not endpoint or funding account', async () => {
  const { open, storage, attempt } = fixture();
  const api = open();
  await api.reserveDepositAttempt(storage, attempt, 'pin');
  assert.equal(
    await api.reserveDepositAttempt(
      storage,
      { ...attempt, binding: { ...attempt.binding, genesisHash: 'other-chain' } },
      'pin',
    ),
    null,
  );
  assert.equal(
    (await api.reserveDepositAttempt(storage, { ...attempt, hash: 'b'.repeat(64) }, 'pin')).hash,
    attempt.hash,
  );
});

test('attempts are encrypted and wrong passwords or corrupt storage fail closed', async () => {
  const { open, storage, attempt, records } = fixture();
  const api = open();
  await api.reserveDepositAttempt(storage, attempt, 'pin');
  assert.equal(JSON.stringify(records).includes(attempt.hash), false);
  await assert.rejects(api.reserveDepositAttempt(storage, attempt, 'wrong'));
  const record = Object.values(records)[0];
  record.ciphertext[0] ^= 1;
  await assert.rejects(api.reserveDepositAttempt(storage, attempt, 'pin'));
});

test('interruption after durable reservation but before relay leaves a blocking relaying record', async () => {
  const { open, storage, attempt } = fixture();
  assert.equal(await open().reserveDepositAttempt(storage, attempt, 'pin'), null);
  const reopened = open();
  const existing = await reopened.reserveDepositAttempt(
    storage,
    { ...attempt, hash: 'b'.repeat(64) },
    'pin',
  );
  assert.equal(existing.state, 'relaying');
  assert.equal(existing.hash, attempt.hash);
});

test('missing cross-context locks or failed durable writes never return a reservation', async () => {
  for (const options of [{ lockUnavailable: true }, { writeFails: true }]) {
    const { open, storage, attempt, records } = fixture(options);
    await assert.rejects(open().reserveDepositAttempt(storage, attempt, 'pin'));
    assert.equal(Object.keys(records).length, 0);
  }
});
