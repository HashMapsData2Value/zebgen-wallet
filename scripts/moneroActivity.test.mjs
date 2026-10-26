import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

function load(name, dependencies = {}) {
  const exports = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL(`../lib/wallet/${name}.ts`, import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  runInNewContext(compiled, {
    exports,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    Uint8Array,
    ArrayBuffer,
    require: (dependency) => dependencies[dependency] ?? {},
  });
  return exports;
}

const seedVault = load('seedVault');
const api = load('moneroActivity', { './seedVault': seedVault });

test('activity is encrypted, allowlisted, scoped and readable after reopening', async () => {
  const records = {};
  const storage = { get: async () => records, set: async (items) => Object.assign(records, items) };
  const scope = api.activityScope('sender', {
    network: 'regtest',
    daemon: { uri: 'http://user:password@localhost:18081/?token=secret' },
  });
  assert.equal(scope.daemon, 'http://localhost:18081/');
  const activity = {
    ...scope,
    hash: 'a'.repeat(64),
    amountAtomic: '10',
    feeAtomic: '1',
    createdAt: 123,
    state: 'relaying',
    txHex: 'raw-secret-transaction',
    privateSpendKey: 'private-secret',
    lockSecret: 'pin',
  };
  await api.saveMoneroActivity(storage, activity, 'pin');
  const serialized = JSON.stringify(records);
  for (const secret of [
    'sender',
    activity.hash,
    'raw-secret-transaction',
    'private-secret',
    'localhost',
    'password',
    'amountAtomic',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  const reopened = load('moneroActivity', { './seedVault': seedVault });
  const [saved] = await reopened.loadMoneroActivity(storage, scope, 'pin');
  assert.equal(saved.state, 'relaying');
  assert.equal(saved.txHex, undefined);
  assert.equal(saved.lockSecret, undefined);
  assert.equal(saved.privateSpendKey, undefined);
  for (const changed of [
    { address: 'other' },
    { network: 'mainnet' },
    { daemon: 'http://other/' },
  ]) {
    assert.equal(
      (await api.loadMoneroActivity(storage, { ...scope, ...changed }, 'pin')).length,
      0,
    );
  }
  await assert.rejects(api.loadMoneroActivity(storage, scope, 'wrong-pin'));
  for (const state of ['submitted', 'unknown']) {
    await api.saveMoneroActivity(storage, { ...activity, state }, 'pin');
    assert.equal((await reopened.loadMoneroActivity(storage, scope, 'pin'))[0].state, state);
  }
});
