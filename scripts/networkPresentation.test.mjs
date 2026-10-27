import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/network/networks.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const api = {};
runInNewContext(compiled, {
  exports: api,
  structuredClone,
  require: (name) => {
    assert.equal(name, '../wallet/moneroWallet');
    return { MoneroNetworkType: { MAINNET: 0, TESTNET: 1, STAGENET: 2 } };
  },
});
const { ALGORAND_NETWORK_IDS, MONERO_NETWORK_IDS, networkColor } = api;

test('fresh profiles default to Algorand Testnet and Monero Stagenet without replacing saved networks', async () => {
  let saved;
  const store = {};
  const storeSource = readFileSync(
    new URL('../lib/network/networkStore.ts', import.meta.url),
    'utf8',
  );
  const storeCode = ts.transpileModule(storeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(storeCode, {
    exports: store,
    structuredClone,
    require: (name) => {
      if (name === './networks') return api;
      assert.equal(name, 'wxt/browser');
      return {
        browser: { storage: { local: { get: async () => ({ 'zebgen:networkSettings': saved }) } } },
      };
    },
  });
  const fresh = await store.getNetworkSettings();
  assert.equal(fresh.algorand.network, 'testnet');
  assert.equal(fresh.algorand.algod.server, 'https://testnet-api.algonode.cloud');
  assert.equal(fresh.algorand.indexer.server, 'https://testnet-idx.algonode.cloud');
  assert.equal(fresh.monero.network, 'stagenet');
  assert.equal(fresh.monero.networkType, 2);
  assert.equal(fresh.monero.daemon.uri, 'https://xmr.nodely.dev:38089');
  fresh.algorand.algod.server = 'modified';
  assert.equal(
    (await store.getNetworkSettings()).algorand.algod.server,
    'https://testnet-api.algonode.cloud',
  );
  for (const network of ['localnet', 'mainnet', 'testnet']) {
    for (const monero of ['mainnet', 'stagenet', 'regtest']) {
      saved = {
        algorand: api.cloneAlgorandPreset(network),
        monero: api.cloneMoneroPreset(monero),
      };
      assert.equal(await store.getNetworkSettings(), saved);
    }
  }
});

test('Monero choices exclude Testnet without changing Algorand choices', () => {
  assert.deepEqual(Array.from(MONERO_NETWORK_IDS), ['mainnet', 'stagenet', 'regtest']);
  assert.deepEqual(Array.from(ALGORAND_NETWORK_IDS), ['mainnet', 'testnet', 'localnet']);
});

test('Monero staging and local colors match their Algorand equivalents', () => {
  assert.equal(networkColor('mainnet'), '#a78bfa');
  assert.equal(networkColor('testnet'), '#eab308');
  assert.equal(networkColor('localnet'), '#ffffff');
  assert.equal(networkColor('stagenet'), networkColor('testnet'));
  assert.equal(networkColor('regtest'), networkColor('localnet'));
  assert.notEqual(networkColor('stagenet'), networkColor('mainnet'));
  assert.notEqual(networkColor('regtest'), networkColor('mainnet'));
});
