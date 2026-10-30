import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { walletRestoreHeight } from '../lib/monero/scanHeight.ts';

function fixture(failed = false) {
  const calls = [];
  const api = {};
  const source = ts.transpileModule(
    readFileSync(new URL('../lib/monero/restoreHeight.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(source, {
    exports: api,
    console: { error() {} },
    require: (name) => {
      if (name === 'wxt/browser') return { browser: {} };
      if (name === '../network/networks')
        return {
          MONERO_NETWORK_IDS: ['mainnet', 'stagenet', 'regtest'],
          cloneMoneroPreset: (network) => ({ network }),
        };
      if (name === '../network/messages')
        return {
          probeMoneroDaemonViaBackground: async (config) => {
            calls.push(config.network);
            return failed
              ? { ok: false, error: 'offline' }
              : { ok: true, height: config.network === 'mainnet' ? 3300020 : 2200020 };
          },
        };
      throw new Error(name);
    },
  });
  return { api, calls };
}

for (const network of ['mainnet', 'stagenet'])
  test(`generation on ${network} records independent heights before switching networks`, async () => {
    const { api, calls } = fixture();
    const height = network === 'mainnet' ? 3300000 : 2200000;
    const heights = await api.generatedWalletRestoreHeights({ network }, height);
    assert.equal(walletRestoreHeight({ scanRestoreHeights: heights }, 'mainnet'), 3300000);
    assert.equal(walletRestoreHeight({ scanRestoreHeights: heights }, 'stagenet'), 2200000);
    assert.deepEqual(calls, [network === 'mainnet' ? 'stagenet' : 'mainnet']);
  });

test('unavailable secondary network keeps safe full-history fallback and never probes local regtest', async () => {
  const { api, calls } = fixture(true);
  const heights = await api.generatedWalletRestoreHeights({ network: 'mainnet' }, 3300000);
  assert.equal(heights.mainnet, 3300000);
  assert.equal(walletRestoreHeight({ scanRestoreHeights: heights }, 'stagenet'), 0);
  assert.deepEqual(calls, ['stagenet']);
});
