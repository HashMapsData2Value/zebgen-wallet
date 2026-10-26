import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { walletRestoreHeight } from '../lib/monero/scanHeight.ts';

function fixture(overrides = {}) {
  const state = { balance: '2000000000000', ok: true, walletId: 7, changed: false, ...overrides };
  const calls = [];
  const api = {};
  const dependencies = {
    './moneroVault': {
      getMoneroWalletState: async () => ({
        activeWalletId: state.changed && calls.includes('scan') ? 8 : state.walletId,
        wallets: [{ id: state.walletId, restoreHeight: 123, restoreNetwork: 'stagenet' }],
      }),
      unlockMoneroWallet: async () => ({
        address: 'funding',
        privateSpendKey: 'spend',
        privateViewKey: 'view',
      }),
    },
    '../monero/moneroDaemon': {
      scanMoneroBalance: async (request) => {
        calls.push('scan');
        assert.equal(request.restoreHeight, 123);
        state.onScan?.();
        return { ok: state.ok, balanceAtomic: state.balance, error: 'node unavailable' };
      },
      createMoneroTransaction: async () => {
        assert.fail('Acceptance must not construct or sign a trial transaction');
      },
    },
    './formatAtomic': { formatAtomic: (value) => (Number(value) / 1e12).toString() },
    '../monero/scanHeight': { walletRestoreHeight },
  };
  const code = ts.transpileModule(
    readFileSync(new URL('../lib/wallet/swapAffordability.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(code, {
    exports: api,
    require: (name) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
  });
  return {
    calls,
    check: (control) =>
      api.assertSwapAffordability({ network: 'stagenet' }, '1000000000000', 'pin', control),
  };
}

test('0.49 unlocked XMR cannot promise 1 XMR; no transaction is prepared', async () => {
  const scenario = fixture({ balance: '490000000000' });
  await assert.rejects(
    scenario.check(),
    /0.49 unlocked XMR.*1 XMR plus a preliminary 0.001 XMR network fee allowance/,
  );
  assert.deepEqual(scenario.calls, ['scan']);
});

test('exact amount without a fee is insufficient', async () => {
  const scenario = fixture({ balance: '1000000000000' });
  await assert.rejects(scenario.check(), /network fee allowance/);
  assert.deepEqual(scenario.calls, ['scan']);
});

test('scan failure blocks acceptance rather than trusting a balance', async () => {
  const scenario = fixture({ ok: false });
  await assert.rejects(scenario.check(), /Cannot verify XMR funding/);
  assert.deepEqual(scenario.calls, ['scan']);
});

test('amount plus less than the fee allowance blocks acceptance', async () => {
  await assert.rejects(fixture({ balance: '1000999999999' }).check(), /network fee allowance/);
});

test('exact amount plus fee allowance passes without preparing a transaction', async () => {
  const scenario = fixture({ balance: '1001000000000' });
  await scenario.check();
  assert.deepEqual(scenario.calls, ['scan']);
});

test('balance above the allowance passes without preparing a transaction', async () => {
  const scenario = fixture();
  await scenario.check();
  assert.deepEqual(scenario.calls, ['scan']);
});

test('cancellation after the balance refresh blocks acceptance', async () => {
  const controller = new AbortController();
  const scenario = fixture({ onScan: () => controller.abort() });
  await assert.rejects(scenario.check({ signal: controller.signal }), /abort/i);
  assert.deepEqual(scenario.calls, ['scan']);
});

test('swap shares cannot be selected as normal funding wallets', async () => {
  const scenario = fixture({ walletId: -1 });
  await assert.rejects(scenario.check(), /normal Monero funding wallet/);
  assert.deepEqual(scenario.calls, []);
});

test('wallet switch and cancellation block acceptance', async () => {
  await assert.rejects(fixture({ changed: true }).check(), /Funding wallet changed/);
  const controller = new AbortController();
  controller.abort();
  const scenario = fixture();
  await assert.rejects(scenario.check({ signal: controller.signal }), /abort/i);
  assert.deepEqual(scenario.calls, []);
});

test('acceptance creation and saved acceptance return are both behind the affordability guard', () => {
  const source = readFileSync(
    new URL('../lib/wallet/swapHandshakeVault.ts', import.meta.url),
    'utf8',
  );
  const acceptance = source.slice(
    source.indexOf('export async function acceptSwapInvite'),
    source.indexOf('export async function confirmSwapAcceptance'),
  );
  assert.ok(
    acceptance.indexOf('await assertSwapAffordability(') < acceptance.indexOf('if (saved)'),
  );
  assert.ok(
    acceptance.indexOf('await assertSwapAffordability(') <
      acceptance.indexOf('await signSwapHandshake('),
  );
});
