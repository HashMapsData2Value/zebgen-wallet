import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

function load(name, dependencies, globals = {}) {
  const api = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL(`../lib/wallet/${name}.ts`, import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  runInNewContext(compiled, {
    exports: api,
    crypto: webcrypto,
    console: { error() {} },
    Date,
    AbortSignal,
    URL,
    btoa,
    require: (dependency) => dependencies[dependency] ?? {},
    ...globals,
  });
  return api;
}

test('both broadcast paths require a freshly supplied correct PIN and enforce owner/expiry', async () => {
  let broadcasts = 0;
  const api = load('transactionService', {
    'wxt/browser': { browser: { storage: { local: {} } } },
    './moneroActivity': { activityScope: () => ({}), saveMoneroActivity: async () => {} },
    './algoWallet': {
      unlockWallet: async (secret) => {
        if (secret !== 'correct-pin') throw new Error('Invalid wallet password or PIN.');
      },
      prepareAlgoPayment: async () => ({
        sender: 'sender',
        signed: new Uint8Array(),
        txId: 'algo-hash',
        feeMicroAlgos: 1000n,
      }),
      submitAlgoPayment: async () => {
        broadcasts++;
        return 'algo-hash';
      },
    },
    './moneroVault': { unlockMoneroWallet: async () => ({ address: 'sender' }) },
    '../monero/moneroDaemon': {
      createMoneroTransaction: async () => ({
        ok: true,
        txHex: 'hex',
        hash: 'xmr-hash',
        amountAtomic: '10',
        feeAtomic: '1',
      }),
      initializeMoneroWasm: async () => {},
      verifyMoneroNetwork: async () => {},
    },
    'zebgen-monero-wasm': {
      relayTransaction: async () => {
        broadcasts++;
        return 'xmr-hash';
      },
    },
  });
  for (const chain of ['algorand', 'monero']) {
    const prepared = await api.prepareTransaction('owner', {
      chain,
      primaryAddress: 'sender',
      amountAtomic: '10',
      config: { daemon: { uri: 'http://localhost' } },
    });
    assert.equal(prepared.ok, true);
    const before = broadcasts;
    for (const pin of [undefined, '', 'wrong-pin']) {
      const response = await api.submitPreparedTransaction('owner', prepared.review.id, pin);
      assert.equal(response.ok, false);
      assert.match(response.error, /Invalid wallet/);
      assert.equal(broadcasts, before);
    }
    assert.equal(
      (await api.submitPreparedTransaction('other-owner', prepared.review.id, 'correct-pin')).ok,
      false,
    );
    assert.equal(
      (await api.submitPreparedTransaction('owner', prepared.review.id, 'correct-pin')).ok,
      true,
    );
    assert.equal(broadcasts, before + 1);
    assert.equal(
      (await api.submitPreparedTransaction('owner', prepared.review.id, 'correct-pin')).ok,
      false,
    );
  }
});

test('ALGO receipts distinguish pool rejection, pending and confirmed rounds', async () => {
  let result = {};
  const api = load('transactionStatus', {
    '../algorand/algodClient': {
      createAlgodClient: () => ({
        pendingTransactionInformation: () => ({ do: async () => result }),
      }),
    },
  });
  const request = { chain: 'algorand', hash: 'hash', endpoint: {} };
  assert.equal((await api.readTransactionStatus(request)).state, 'pending');
  result = { poolError: 'rejected by node' };
  assert.equal((await api.readTransactionStatus(request)).state, 'rejected');
  result = { confirmedRound: 42n };
  assert.equal((await api.readTransactionStatus(request)).block, '42');
});

test('generic Monero payments cannot unlock or spend a LeakSwap share', async () => {
  let unlocks = 0;
  const api = load('transactionService', {
    './moneroVault': {
      unlockMoneroWallet: async () => {
        unlocks++;
        throw new Error('must not unlock');
      },
    },
  });
  const result = await api.prepareTransaction('owner', { chain: 'monero', walletId: -41 });
  assert.equal(result.ok, false);
  assert.match(result.error, /key shares cannot be used as payment wallets/);
  assert.equal(unlocks, 0);
});

test('XMR receipts require actual block inclusion and surface RPC errors', async () => {
  const hash = 'a'.repeat(64);
  let result = { status: 'OK', txs: [{ tx_hash: hash, in_pool: true }] };
  let ok = true;
  const api = load(
    'transactionStatus',
    {},
    { fetch: async () => ({ ok, status: 503, json: async () => result }) },
  );
  const request = { chain: 'monero', hash, config: { daemon: { uri: 'http://localhost:18081' } } };
  assert.equal((await api.readTransactionStatus(request)).state, 'pool');
  result = {
    status: 'OK',
    txs: [{ tx_hash: hash, in_pool: false, block_height: 123, confirmations: 2 }],
  };
  const receipt = await api.readTransactionStatus(request);
  assert.equal(receipt.state, 'confirmed');
  assert.equal(receipt.block, '123');
  assert.equal(receipt.confirmations, 2);
  result = { status: 'OK', txs: [] };
  assert.equal((await api.readTransactionStatus(request)).state, 'unknown');
  ok = false;
  await assert.rejects(api.readTransactionStatus(request), /HTTP 503/);
});

test('Monero journals before relay, survives navigation, and consumes uncertain attempts', async () => {
  for (const scenario of [
    'success',
    'storage-before',
    'response-loss',
    'hash-mismatch',
    'storage-after',
  ]) {
    const events = [];
    const logged = [];
    const api = load(
      'transactionService',
      {
        'wxt/browser': { browser: { storage: { local: {} } } },
        './moneroActivity': {
          activityScope: (address) => ({
            address,
            network: 'regtest',
            daemon: 'http://localhost/',
          }),
          saveMoneroActivity: async (_storage, activity) => {
            events.push(activity.state);
            assert.equal(activity.hash, 'a'.repeat(64));
            assert.equal(activity.txHex, undefined);
            if (scenario === 'storage-before' && activity.state === 'relaying')
              throw new Error('quota before relay');
            if (scenario === 'storage-after' && activity.state !== 'relaying')
              throw new Error('quota after relay');
          },
        },
        './algoWallet': { unlockWallet: async () => {} },
        './moneroVault': { unlockMoneroWallet: async () => ({ address: 'sender' }) },
        '../monero/moneroDaemon': {
          createMoneroTransaction: async () => ({
            ok: true,
            txHex: 'private-raw',
            hash: 'a'.repeat(64),
            amountAtomic: '10',
            feeAtomic: '1',
          }),
          initializeMoneroWasm: async () => {},
          verifyMoneroNetwork: async () => {},
        },
        'zebgen-monero-wasm': {
          relayTransaction: async () => {
            events.push('relay');
            api.discardPreparedTransactions('owner');
            if (scenario === 'response-loss')
              throw new Error('connection lost after daemon accepted');
            return (scenario === 'hash-mismatch' ? 'b' : 'a').repeat(64);
          },
        },
      },
      { console: { error: (...args) => logged.push(args) } },
    );
    const prepared = await api.prepareTransaction('owner', {
      chain: 'monero',
      primaryAddress: 'sender',
      walletId: 1,
      config: { network: 'regtest', daemon: { uri: 'http://localhost/' } },
    });
    assert.equal(prepared.ok, true);
    assert.equal(events.length, 0, 'preparation must not journal or relay');
    const result = await api.submitPreparedTransaction('owner', prepared.review.id, 'pin');
    if (scenario === 'storage-before') {
      assert.deepEqual(events, ['relaying']);
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, undefined);
    } else {
      assert.deepEqual(events.slice(0, 2), ['relaying', 'relay']);
      assert.equal(result.ok, scenario === 'success');
      if (scenario !== 'success') {
        assert.equal(result.uncertain, true);
        assert.equal(result.review.hash, 'a'.repeat(64));
        assert.equal(events.at(-1), 'unknown');
        assert.equal(typeof logged[0][1].stack, 'string');
      } else assert.equal(events.at(-1), 'submitted');
      const count = events.length;
      assert.equal(
        (await api.submitPreparedTransaction('owner', prepared.review.id, 'pin')).ok,
        false,
      );
      assert.equal(
        events.length,
        count,
        'uncertain and submitted preparations must not relay again',
      );
    }
  }
});

test('trusted deposit submit reserves once across concurrent approvals and worker reopen, including unknown relay', async () => {
  for (const scenario of ['submitted', 'unknown', 'storage-after']) {
    const records = {};
    const queues = new Map();
    let clock = Date.now();
    const storage = {
      get: async (key) => ({ [key]: records[key] }),
      set: async (items) => {
        if (scenario === 'storage-after' && relays > 0)
          throw new Error('journal unavailable after relay');
        Object.assign(records, items);
      },
    };
    const globals = {
      Date: class extends Date {
        static now() {
          return clock;
        }
      },
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      navigator: {
        locks: {
          request: (key, callback) => {
            const pending = (queues.get(key) ?? Promise.resolve()).then(callback);
            queues.set(
              key,
              pending.catch(() => {}),
            );
            return pending;
          },
        },
      },
    };
    const seedVault = load('seedVault', {}, globals);
    let relays = 0;
    let precheckFails = false;
    const target = {
      binding: {
        agreementDigest: 'ab'.repeat(32),
        appId: '42',
        genesisHash: 'actual-genesis',
        moneroNetwork: 'regtest',
      },
      sender: 'sender',
      recipient: 'combined',
      amountAtomic: '10',
      walletId: 1,
      restoreHeight: 0,
      config: { network: 'regtest', daemon: { uri: 'http://localhost' } },
    };
    const open = () =>
      load(
        'transactionService',
        {
          'wxt/browser': { browser: { storage: { local: storage } } },
          './depositAttempt': load('depositAttempt', { './seedVault': seedVault }, globals),
          './leakSwapDeposit': {
            resolveLeakSwapDeposit: async (params) => {
              assert.deepEqual(Object.keys(params).sort(), ['agreementDigest', 'appId']);
              if (precheckFails) throw new Error('Deposit precheck failed');
              return target;
            },
            assertSameDepositTarget: (expected, current) => assert.deepEqual(expected, current),
          },
          './moneroActivity': { activityScope: () => ({}), saveMoneroActivity: async () => {} },
          './algoWallet': {
            unlockWallet: async (secret) => {
              if (secret !== 'pin') throw new Error('Bad PIN');
            },
          },
          './moneroVault': { unlockMoneroWallet: async () => ({ address: 'sender' }) },
          '../monero/moneroDaemon': {
            createMoneroTransaction: async () => ({
              ok: true,
              txHex: 'private-raw',
              hash: 'a'.repeat(64),
              amountAtomic: '10',
              feeAtomic: '1',
            }),
            initializeMoneroWasm: async () => {},
            verifyMoneroNetwork: async () => {},
          },
          'zebgen-monero-wasm': {
            relayTransaction: async () => {
              relays++;
              if (scenario === 'unknown') throw new Error('Response lost');
              return 'a'.repeat(64);
            },
          },
        },
        globals,
      );
    const api = open();
    const request = {
      chain: 'monero',
      primaryAddress: target.sender,
      recipient: target.recipient,
      amountAtomic: '10',
      walletId: 1,
      restoreHeight: 0,
      config: target.config,
      sweep: false,
      lockSecret: 'pin',
      deposit: target,
    };
    assert.equal(
      (await api.prepareTransaction('tampered', { ...request, recipient: 'attacker' })).ok,
      false,
    );
    const cancelled = await api.prepareTransaction('cancelled', request);
    assert.equal(cancelled.ok, true);
    api.discardPreparedTransactions('cancelled');
    assert.equal(Object.keys(records).length, 0, 'review cancellation must not reserve');
    const expired = await api.prepareTransaction('expired', request);
    clock = expired.review.expiresAt;
    assert.equal(
      (await api.submitPreparedTransaction('expired', expired.review.id, 'pin')).code,
      'review-expired',
    );
    assert.equal(Object.keys(records).length, 0, 'expired review must not reserve');
    assert.equal(relays, 0);
    const first = await api.prepareTransaction('first', request);
    const otherContext = open();
    const second = await otherContext.prepareTransaction('second', request);
    assert.equal((await api.submitPreparedTransaction('first', first.review.id, 'bad')).ok, false);
    assert.equal(Object.keys(records).length, 0, 'wrong PIN must not reserve');
    precheckFails = true;
    assert.equal((await api.submitPreparedTransaction('first', first.review.id, 'pin')).ok, false);
    assert.equal(Object.keys(records).length, 0, 'failed prechecks must not reserve');
    precheckFails = false;
    const results = await Promise.all([
      api.submitPreparedTransaction('first', first.review.id, 'pin'),
      otherContext.submitPreparedTransaction('second', second.review.id, 'pin'),
    ]);
    assert.equal(relays, 1);
    assert.equal(results.filter((result) => result.code === 'deposit-exists').length, 1);
    if (scenario === 'submitted') {
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(
        api.isSubmittedDepositResult(target.binding, {
          transactionHash: 'a'.repeat(64),
          amountAtomic: '10',
          feeAtomic: '1',
        }),
        true,
      );
      assert.equal(
        api.isSubmittedDepositResult(
          { ...target.binding, appId: '43' },
          { transactionHash: 'a'.repeat(64), amountAtomic: '10', feeAtomic: '1' },
        ),
        false,
      );
    } else
      assert.equal(
        results.some((result) => result.uncertain),
        true,
      );
    const reopened = await open().prepareTransaction('reopened', request);
    assert.equal(reopened.code, 'deposit-exists');
    assert.equal(reopened.attempt.hash, 'a'.repeat(64));
    assert.equal(reopened.attempt.state, scenario === 'storage-after' ? 'relaying' : scenario);
    assert.equal(relays, 1);
  }
});
