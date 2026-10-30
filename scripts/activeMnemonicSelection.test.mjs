import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function fixture() {
  let meta = { activeSeedId: 1, algoAddress: 'FIRST' };
  const seeds = [
    { id: 1, algoAddress: 'FIRST' },
    { id: 2, algoAddress: 'SECOND' },
  ];
  const api = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL('../lib/provider/connectionSelection.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  runInNewContext(compiled, {
    exports: api,
    navigator: { locks: { request: async (_name, action) => action() } },
    require: (name) => {
      if (name.endsWith('/db'))
        return {
          getAllSeedRecords: async () => seeds,
          getWalletMeta: async () => meta,
          setWalletMeta: async (value) => {
            meta = value;
          },
        };
      if (name.endsWith('/moneroVault'))
        return { getMoneroWalletState: async () => ({ wallets: [] }) };
      return {};
    },
  });
  return {
    api,
    switchMnemonic: () => {
      meta = { activeSeedId: 2, algoAddress: 'SECOND' };
    },
    meta: () => meta,
  };
}

test('connections expose only the active Algorand mnemonic', async () => {
  const { api, switchMnemonic } = fixture();
  assert.deepEqual(JSON.parse(JSON.stringify((await api.connectionChoices()).algo)), [
    { id: 1, address: 'FIRST' },
  ]);
  switchMnemonic();
  assert.deepEqual(JSON.parse(JSON.stringify((await api.connectionChoices()).algo)), [
    { id: 2, address: 'SECOND' },
  ]);
});

test('a stale connection cannot reactivate an inactive mnemonic', async () => {
  const { api, switchMnemonic, meta } = fixture();
  switchMnemonic();
  await assert.rejects(
    api.activateConnectionSelection({
      algoAddress: 'FIRST',
      moneroAddress: null,
      moneroWalletId: null,
    }),
    /no longer available/,
  );
  assert.equal(meta().activeSeedId, 2);
  await api.activateConnectionSelection({
    algoAddress: 'SECOND',
    moneroAddress: null,
    moneroWalletId: null,
  });
  assert.equal(meta().activeSeedId, 2);
});
