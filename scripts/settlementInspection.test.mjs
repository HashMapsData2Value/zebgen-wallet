import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import algosdk from 'algosdk';
import { verifiedSwapSettlement } from '../lib/wallet/swapSettlement.ts';
import { validateProviderRequest } from '../lib/provider/fundingValidation.ts';

test('provider accepts boolean inspection mode and rejects invalid flags or unknown fields', () => {
  for (const inspectOnly of [true, false]) {
    assert.doesNotThrow(() =>
      validateProviderRequest('recoverLeakSwapMonero', { appId: '42', inspectOnly }),
    );
    assert.doesNotThrow(() =>
      validateProviderRequest('recoverLeakSwapMonero', {
        appId: '42',
        inspectOnly,
        settlementTxId: 'A'.repeat(52),
      }),
    );
  }
  for (const inspectOnly of [null, 1, 'true', {}]) {
    assert.throws(() =>
      validateProviderRequest('recoverLeakSwapMonero', { appId: '42', inspectOnly }),
    );
  }
  assert.throws(() =>
    validateProviderRequest('recoverLeakSwapMonero', {
      appId: '42',
      inspectOnly: true,
      extra: true,
    }),
  );
});

const compiled = ts.transpileModule(
  readFileSync(new URL('../lib/wallet/recoverLeakSwap.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  },
).outputText;

function fixture({ offline = false, missing = false, mismatch = false, cached = false } = {}) {
  const genesisHash = new Uint8Array(32).fill(3);
  const holder = algosdk.generateAccount().addr.toString();
  const counterparty = algosdk.generateAccount().addr.toString();
  const transaction = algosdk.makeApplicationDeleteTxnFromObject({
    sender: holder,
    appIndex: mismatch ? 43n : 42n,
    appArgs: [algosdk.ABIMethod.fromSignature('punishRefund(pay)void').getSelector()],
    suggestedParams: { fee: 1000n, minFee: 1000n, firstValid: 1n, lastValid: 10n, genesisHash },
  });
  const receipt = { kind: 'punish', txId: transaction.txID(), confirmedRound: '5' };
  const record = {
    appId: '42',
    genesisHash: Buffer.from(genesisHash).toString('base64'),
    algoAddress: counterparty,
    aliAddress: holder,
    xinAddress: counterparty,
    role: 'xin',
    context: { network: 'stagenet', walletId: 7 },
    ...(cached ? { settlement: receipt } : {}),
  };
  const saved = [];
  const calls = { recover: 0, pending: 0, history: 0 };
  const failRecovery = () => {
    calls.recover++;
    throw new Error('Inspection must not recover');
  };
  class Algodv2 {
    getTransactionParams() {
      return { do: async () => ({ genesisHash, genesisID: 'testnet-v1.0' }) };
    }
    pendingTransactionInformation() {
      calls.pending++;
      return {
        do: async () => {
          if (offline) throw new Error('Node unavailable');
          return { txn: { txn: transaction }, confirmedRound: 5n };
        },
      };
    }
  }
  class Indexer {
    searchForTransactions() {
      calls.history++;
      const query = {
        applicationID: () => query,
        txType: () => query,
        limit: () => query,
        do: async () => {
          if (offline) throw new Error('History unavailable');
          return { transactions: missing ? [] : [{ id: transaction.txID() }] };
        },
      };
      return query;
    }
  }
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    console,
    Error,
    Buffer,
    Uint8Array,
    navigator: { locks: { request: async (_key, action) => action() } },
    require: (name) => {
      if (name === 'algosdk') return { ...algosdk, Algodv2, Indexer };
      if (name === 'wxt/browser') return { browser: { storage: { local: {} } } };
      if (name.endsWith('/networkStore'))
        return {
          getNetworkSettings: async () => ({
            algorand: { network: 'testnet', algod: {}, indexer: {} },
            monero: { network: 'stagenet' },
          }),
        };
      if (name.endsWith('/chainIdentity')) return { verifyAlgorandGenesis: () => {} };
      if (name.endsWith('/base64'))
        return {
          base64ToBytes: (value) => new Uint8Array(Buffer.from(value, 'base64')),
          bytesToBase64: (value) => Buffer.from(value).toString('base64'),
        };
      if (name.endsWith('/algoWallet'))
        return { deriveActiveSeedAlgoAddressAtIndex: async () => ({ algoAddress: counterparty }) };
      if (name.endsWith('/swapRecords'))
        return {
          listSwapRecords: async () => [record],
          loadSettlementEvidence: async () => null,
          saveSwapRecord: async (_storage, value) => saved.push(value),
          swapRecordKey: () => 'saved-swap',
          saveSettlementEvidence: failRecovery,
        };
      if (name.endsWith('/moneroVault'))
        return {
          loadMoneroCombinedContext: async () => record.context,
          unlockMoneroWallet: async () => ({ publicSpendKey: '11'.repeat(32) }),
          saveMoneroWallet: failRecovery,
        };
      if (name.endsWith('/combinedRecovery')) return { recoverCombinedWallet: failRecovery };
      if (name.endsWith('/settlementRecovery')) return { recoverSettlementScalar: failRecovery };
      if (name.endsWith('/swapSettlement')) return { verifiedSwapSettlement };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return {
    inspect: () => api.recoverLeakSwap({ appId: '42', inspectOnly: true }, 'test-secret'),
    calls,
    saved,
    receipt,
  };
}

test('inspection discovers and saves verified counterparty punish without recovering or sharing wallet keys', async () => {
  const current = fixture();
  const result = await current.inspect();
  assert.deepEqual(result.settlement, current.receipt);
  assert.equal(result.settlementTxId, current.receipt.txId);
  assert.equal(result.walletId, undefined);
  assert.equal(result.combinedAddress, undefined);
  assert.equal(current.saved.length, 1);
  assert.deepEqual(current.saved[0].settlement, current.receipt);
  assert.equal(current.calls.recover, 0);
});

test('inspection rejects unknown deletion, offline history and mismatched application evidence', async () => {
  for (const options of [{ missing: true }, { offline: true }, { mismatch: true }]) {
    const current = fixture(options);
    await assert.rejects(current.inspect(), /No confirmed settlement|History lookup unavailable/);
    assert.equal(current.saved.length, 0);
    assert.equal(current.calls.recover, 0);
  }
});

test('inspection returns saved verified punish receipt without requiring available history', async () => {
  const current = fixture({ cached: true, offline: true });
  const result = await current.inspect();
  assert.deepEqual(result.settlement, current.receipt);
  assert.deepEqual(current.calls, { recover: 0, pending: 0, history: 0 });
});
