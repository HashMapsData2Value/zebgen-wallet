import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(
  readFileSync(new URL('../lib/provider/connectionSelection.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;

function fixture() {
  const state = {
    meta: {
      activeSeedId: 1,
      algoAddress: 'ALGO_ONE',
      activeMoneroKeyId: 1,
      moneroAddress: 'XMR_ONE',
      lockSalt: 'keep-salt',
      lockVerifier: 'keep-verifier',
    },
    writes: 0,
  };
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    navigator: { locks: { request: async (_name, callback) => callback() } },
    require: (name) => {
      if (name.endsWith('/db'))
        return {
          getAllSeedRecords: async () => [
            { id: 1, algoAddress: 'ALGO_ONE' },
            { id: 2, algoAddress: 'ALGO_TWO' },
          ],
          getWalletMeta: async () => state.meta,
          setWalletMeta: async (meta) => {
            state.meta = meta;
            state.writes++;
          },
        };
      if (name.endsWith('/moneroVault'))
        return {
          getMoneroWalletState: async () => ({
            wallets: [
              { id: 1, address: 'XMR_ONE' },
              { id: 2, address: 'XMR_TWO' },
            ],
          }),
        };
      if (name.endsWith('/connectionApproval'))
        return {
          activeConnectionAccounts: async () => {
            throw new Error('Unexpected fallback');
          },
        };
      throw new Error(name);
    },
  });
  return { state, api };
}

test('only the active Algorand mnemonic is offered, while the Monero wallet can still be chosen', async () => {
  const { api, state } = fixture();
  assert.deepEqual(JSON.parse(JSON.stringify((await api.connectionChoices()).algo)), [
    { id: 1, address: 'ALGO_ONE' },
  ]);
  await api.activateConnectionSelection({
    algoAddress: 'ALGO_ONE',
    moneroAddress: 'XMR_TWO',
    moneroWalletId: 2,
  });
  assert.equal(state.meta.activeSeedId, 1);
  assert.equal(state.meta.activeMoneroKeyId, 2);
  assert.equal(state.meta.algoAddress, 'ALGO_ONE');
  assert.equal(state.meta.moneroAddress, 'XMR_TWO');
  assert.equal(state.meta.lockSalt, 'keep-salt');
  assert.equal(state.meta.lockVerifier, 'keep-verifier');
  assert.equal(state.writes, 1);
});

test('a connection cannot switch to an inactive Algorand mnemonic', async () => {
  const { api, state } = fixture();
  await assert.rejects(
    api.activateConnectionSelection({
      algoAddress: 'ALGO_TWO',
      moneroAddress: 'XMR_ONE',
      moneroWalletId: 1,
    }),
    /no longer available/,
  );
  assert.equal(state.writes, 0);
  assert.equal(state.meta.activeSeedId, 1);
});

test('fabricated addresses, mismatched wallet IDs and missing selections fail without changing active wallets', async () => {
  for (const accounts of [
    { algoAddress: 'FAKE', moneroAddress: 'XMR_TWO', moneroWalletId: 2 },
    { algoAddress: 'ALGO_TWO', moneroAddress: 'XMR_ONE', moneroWalletId: 2 },
    { algoAddress: 'ALGO_TWO', moneroAddress: 'XMR_TWO', moneroWalletId: -1 },
    { algoAddress: null, moneroAddress: null, moneroWalletId: null },
  ]) {
    const { api, state } = fixture();
    await assert.rejects(api.activateConnectionSelection(accounts), /no longer available/);
    assert.equal(state.writes, 0);
    assert.equal(state.meta.activeSeedId, 1);
    assert.equal(state.meta.activeMoneroKeyId, 1);
  }
});
