import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import algosdk from 'algosdk';
import { recoverSettlementScalar } from '../lib/wallet/settlementRecovery.ts';
import { recoverCombinedWallet } from '../lib/wallet/combinedRecovery.ts';
import { verifiedSwapSettlement } from '../lib/wallet/swapSettlement.ts';
import { leakySign } from '../lib/wallet/leakySign.ts';
import {
  computeCombinedAddressWithPrivateAndPublic,
  getMoneroKeyMaterialFromPrivateSpendKey,
} from '../lib/wallet/moneroWallet.ts';

function fixture(role = 'ali', ownRefund = false) {
  const scalar = (value) => value.toString(16).padStart(2, '0') + '00'.repeat(31);
  const owner = getMoneroKeyMaterialFromPrivateSpendKey(scalar(3));
  const counterparty = getMoneroKeyMaterialFromPrivateSpendKey(scalar(5));
  const algoAddress = algosdk.generateAccount().addr.toString();
  const otherAddress = algosdk.generateAccount().addr.toString();
  const genesisHash = new Uint8Array(32).fill(3);
  const combined = computeCombinedAddressWithPrivateAndPublic(
    owner.privateSpendKey,
    owner.privateViewKey,
    counterparty.privateViewKey,
    counterparty.publicSpendKey,
    0,
  );
  const context = {
    version: 1,
    walletId: -7,
    network: 'regtest',
    restoreHeight: 123,
    counterpartyPrivateViewKey: counterparty.privateViewKey,
    counterpartyPublicSpendKey: counterparty.publicSpendKey,
    combinedAddress: combined.combinedAddress,
  };
  const signature = leakySign(
    algosdk.getApplicationAddress(42n).publicKey,
    new Uint8Array(
      Buffer.from(ownRefund ? owner.privateSpendKey : counterparty.privateSpendKey, 'hex'),
    ),
  );
  const method = ownRefund ? 'leakyRefund' : role === 'ali' ? 'leakyClaim' : 'leakyRefund';
  const transaction = algosdk.makeApplicationDeleteTxnFromObject({
    sender: ownRefund ? algoAddress : otherAddress,
    appIndex: 42n,
    appArgs: [
      algosdk.ABIMethod.fromSignature(`${method}(byte[],pay)void`).getSelector(),
      new Uint8Array([0, 64, ...signature]),
    ],
    suggestedParams: { fee: 1000n, minFee: 1000n, firstValid: 1n, lastValid: 10n, genesisHash },
  });
  const record = {
    appId: '42',
    genesisHash: Buffer.from(genesisHash).toString('base64'),
    role,
    algoAddress,
    aliAddress: role === 'ali' ? algoAddress : otherAddress,
    xinAddress: role === 'ali' ? otherAddress : algoAddress,
    context,
  };
  const state = {
    records: [record],
    wallets: [],
    saves: 0,
    indexerFails: false,
    round: 5n,
    queries: 0,
    network: 'localnet',
    blockReads: 0,
    evidence: null,
    pendingMissing: false,
    pendingError: null,
    historyRound: 4n,
    blockGenesisHash: genesisHash,
    missingBlockTransaction: false,
  };
  const modules = {
    algosdk: {
      ...algosdk,
      Algodv2: class {
        getTransactionParams() {
          return { do: async () => ({ genesisHash, genesisID: 'dockernet-v1' }) };
        }
        pendingTransactionInformation(id) {
          assert.equal(id, transaction.txID());
          return {
            do: async () => {
              if (state.pendingError) throw state.pendingError;
              if (state.pendingMissing)
                throw Object.assign(new Error('Not in the last 1000 rounds'), { status: 404 });
              return { confirmedRound: state.round, txn: { txn: transaction } };
            },
          };
        }
        getApplicationByID() {
          throw new Error('Deleted application must never be queried');
        }
        status() {
          return { do: async () => ({ lastRound: 5n }) };
        }
        block(round) {
          state.blockReads++;
          return {
            do: async () => ({
              block: {
                header: { genesisHash: state.blockGenesisHash },
                payset:
                  round === 4n && !state.missingBlockTransaction
                    ? [{ signedTxn: { signedTxn: { txn: transaction } } }]
                    : [],
              },
            }),
          };
        }
      },
      Indexer: class {
        lookupTransactionByID(id) {
          assert.equal(id, transaction.txID());
          return { do: async () => ({ transaction: { id, confirmedRound: state.historyRound } }) };
        }
        searchForTransactions() {
          state.queries++;
          return this;
        }
        applicationID(id) {
          assert.equal(id, 42n);
          return this;
        }
        txType() {
          return this;
        }
        limit() {
          return this;
        }
        async do() {
          if (state.indexerFails) throw new Error('indexer offline');
          return { transactions: [{ id: transaction.txID() }] };
        }
      },
    },
    'wxt/browser': { browser: { storage: { local: {} } } },
    '../network/networkStore': {
      getNetworkSettings: async () => ({
        algorand: { algod: {}, indexer: {}, network: state.network },
        monero: { network: 'regtest', networkType: 0 },
      }),
    },
    '../network/chainIdentity': { verifyAlgorandGenesis: () => {} },
    '../provider/base64': {
      bytesToBase64: (bytes) => Buffer.from(bytes).toString('base64'),
      base64ToBytes: (value) => new Uint8Array(Buffer.from(value, 'base64')),
    },
    './algoWallet': { deriveActiveSeedAlgoAddressAtIndex: async () => ({ algoAddress }) },
    './swapRecords': {
      listSwapRecords: async () => state.records,
      swapRecordKey: () => 'saved-swap',
      loadSettlementEvidence: async () => state.evidence,
      saveSettlementEvidence: async (_storage, _record, evidence) => {
        state.evidence = evidence;
      },
    },
    './moneroVault': {
      loadMoneroCombinedContext: async () => context,
      unlockMoneroWallet: async (_secret, _network, id) => {
        assert.equal(id, -7);
        return owner;
      },
      getMoneroWalletState: async () => ({ wallets: state.wallets }),
      saveMoneroWallet: async (material, _secret, height, activate) => {
        assert.equal(height, 123);
        assert.equal(activate, false);
        state.saves++;
        state.wallets.push({ address: material.address, id: 9 });
        return 9;
      },
    },
    './combinedRecovery': { recoverCombinedWallet },
    './settlementRecovery': { recoverSettlementScalar },
    './swapSettlement': { verifiedSwapSettlement },
  };
  const api = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../lib/wallet/recoverLeakSwap.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    ).outputText,
    {
      exports: api,
      require: (name) => {
        if (!(name in modules)) throw new Error(name);
        return modules[name];
      },
      console,
      Map,
      navigator: { locks: { request: async (_name, action) => action() } },
    },
  );
  return {
    state,
    txId: transaction.txID(),
    address: context.combinedAddress,
    recover: (params) => api.recoverLeakSwap(params, 'synthetic-secret'),
  };
}

test('Ali claim and Xin refund recover from history after deletion and reuse the saved wallet', async () => {
  for (const role of ['ali', 'xin']) {
    const vault = fixture(role);
    const result = await vault.recover({ appId: '42' });
    assert.equal(result.combinedAddress, vault.address);
    assert.equal(result.settlementTxId, vault.txId);
    assert.deepEqual(Object.keys(result).sort(), ['combinedAddress', 'settlementTxId', 'walletId']);
    await vault.recover({ appId: '42', settlementTxId: vault.txId });
    assert.equal(vault.state.saves, 1);
  }
});

test('recovery uses the confirmed block when algod has pruned the settlement lookup', async () => {
  for (const explicit of [false, true]) {
    const vault = fixture();
    vault.state.pendingMissing = true;
    vault.state.network = 'testnet';
    const result = await vault.recover({
      appId: '42',
      ...(explicit ? { settlementTxId: vault.txId } : {}),
    });
    assert.equal(result.combinedAddress, vault.address);
    assert.equal(result.settlementTxId, vault.txId);
    assert.equal(vault.state.blockReads, 1);
    assert.equal(vault.state.evidence.confirmedRound, '4');
  }
});

test('historical recovery rejects missing confirmation, wrong block network and missing transaction', async () => {
  for (const change of [
    { historyRound: 0n },
    { blockGenesisHash: new Uint8Array(32) },
    { missingBlockTransaction: true },
  ]) {
    const vault = fixture();
    Object.assign(vault.state, { pendingMissing: true }, change);
    await assert.rejects(
      vault.recover({ appId: '42', settlementTxId: vault.txId }),
      /confirmed settlement|network mismatch|not found/,
    );
    assert.equal(vault.state.saves, 0);
    assert.equal(vault.state.evidence, null);
  }
});

test('recovery does not treat other algod errors as pruned history', async () => {
  const vault = fixture();
  vault.state.pendingError = Object.assign(new Error('Node unavailable'), { status: 503 });
  await assert.rejects(vault.recover({ appId: '42' }), /Node unavailable/);
  assert.equal(vault.state.blockReads, 0);
  assert.equal(vault.state.saves, 0);
});

test('unavailable history offers a verified transaction fallback; unconfirmed or unsaved recovery cannot save', async () => {
  const vault = fixture();
  vault.state.indexerFails = true;
  vault.state.network = 'mainnet';
  await assert.rejects(vault.recover({ appId: '42' }), /History lookup unavailable/);
  assert.equal(vault.state.saves, 0);
  await vault.recover({ appId: '42', settlementTxId: vault.txId });
  vault.state.evidence = null;
  vault.state.round = 0n;
  await assert.rejects(
    vault.recover({ appId: '42', settlementTxId: vault.txId }),
    /confirmed swap settlement/,
  );
  vault.state.records = [];
  await assert.rejects(vault.recover({ appId: '42' }), /saved swap/);
  assert.equal(vault.state.saves, 1);
});

test('local history falls back to recent confirmed blocks without an indexer', async () => {
  const vault = fixture();
  vault.state.indexerFails = true;
  const result = await vault.recover({ appId: '42' });
  assert.equal(result.combinedAddress, vault.address);
  assert.equal(vault.state.blockReads, 2);
  assert.equal(vault.state.saves, 1);
});

test('Ali own leaky refund explains accepted PIN and Xin-only recovery without saving a wallet', async () => {
  for (const localFallback of [false, true]) {
    const vault = fixture('ali', true);
    vault.state.indexerFails = localFallback;
    await assert.rejects(
      vault.recover({ appId: '42' }),
      /Confirmed Leaky Refund.*Only Xin.*PIN was accepted/,
    );
    await assert.rejects(
      vault.recover({ appId: '42', settlementTxId: vault.txId }),
      /Confirmed Leaky Refund.*Only Xin/,
    );
    assert.equal(vault.state.saves, 0);
    assert.equal(vault.state.evidence, null);
  }
});

test('verified settlement evidence survives a new recovery attempt with unavailable history and still validates its transaction', async () => {
  const vault = fixture();
  await vault.recover({ appId: '42' });
  assert.equal(vault.state.evidence.txId, vault.txId);
  const queries = vault.state.queries;
  vault.state.indexerFails = true;
  vault.state.network = 'mainnet';
  await vault.recover({ appId: '42' });
  assert.equal(vault.state.queries, queries);
  assert.equal(vault.state.saves, 1);
  vault.state.evidence = { ...vault.state.evidence, txId: 'A'.repeat(52) };
  await assert.rejects(vault.recover({ appId: '42' }), /transaction ID mismatch/);
});
