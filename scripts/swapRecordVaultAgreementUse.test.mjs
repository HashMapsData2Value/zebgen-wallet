import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as seedVault from '../lib/wallet/seedVault.ts';
import * as agreementUse from '../lib/wallet/swapAgreementUse.ts';
import * as transactions from '../lib/wallet/swapAgreementTransactions.ts';
import { assertAgreementState } from 'leakswap-utils/dist/swapAgreement.js';
import { verifiedSwapSettlement } from '../lib/wallet/swapSettlement.ts';
import { leakySign } from '../lib/wallet/leakySign.ts';
import { ed25519 } from '@noble/curves/ed25519.js';
import * as timingPolicy from '../lib/wallet/swapTimingPolicy.ts';
import * as roundTiming from 'leakswap-utils/dist/swapTiming.js';
import { artifactApi, canonical, programs } from './helpers/swapAgreementArtifact.mjs';

const source = readFileSync(new URL('../lib/wallet/swapRecordVault.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const genesisHash = new Uint8Array(32).fill(1);
const digest = 'ab'.repeat(32);
const ali = algosdk.generateAccount();
const xin = algosdk.generateAccount();
const deadline = 2500;
const agreement = {
  offer: {
    payload: {
      deadlineUnit: 'round', createdRound: 1,
      algoGenesisHash: Buffer.from(genesisHash).toString('base64'),
      moneroNetwork: 'regtest',
      aliAlgoAddress: ali.addr.toString(),
      aliPublicSpendKey: '02'.repeat(32),
      aliPrivateViewKey: '04'.repeat(32),
      t0: deadline,
      t1: deadline + 7200,
      algoAmount: '10000000',
    },
  },
  acceptance: {
    payload: {
      xinAlgoAddress: xin.addr.toString(),
      xinPublicSpendKey: '03'.repeat(32),
      xinPrivateViewKey: '05'.repeat(32),
    },
  },
};

function deployment(fee = 1000n) {
  const composer = new algosdk.AtomicTransactionComposer();
  composer.addMethodCall({
    appID: 0n,
    sender: ali.addr,
    suggestedParams: {
      fee,
      minFee: 1000n,
      flatFee: true,
      firstValid: 1n,
      lastValid: 100n,
      genesisHash,
    },
    method: algosdk.ABIMethod.fromSignature(
      'createApplication(byte[],account,byte[],uint64,uint64)void',
    ),
    methodArgs: [
      new Uint8Array(32).fill(2),
      xin.addr,
      new Uint8Array(32).fill(3),
      BigInt(deadline),
      BigInt(deadline + 7200),
    ],
    approvalProgram: new Uint8Array([10]),
    clearProgram: new Uint8Array([10]),
    numGlobalInts: 3,
    numGlobalByteSlices: 4,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    signer: async () => [],
  });
  return composer.buildGroup()[0].txn;
}

function harness(locksAvailable = true, fixtureAgreement = agreement, onChainPrograms = null) {
  const data = new Map();
  const scanHeights = [];
  const saved = [];
  let journal = [];
  let queue = Promise.resolve();
  const storage = {
    get: async (key) => ({ [key]: structuredClone(data.get(key)) }),
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
  const globals = [
    ['aliAlgoAddr', { bytes: ali.addr.publicKey }],
    ['xinAlgoAddr', { bytes: xin.addr.publicKey }],
    ['aliXternalPK', { bytes: new Uint8Array(32).fill(2) }],
    ['xinXternalPK', { bytes: new Uint8Array(32).fill(3) }],
    ['t0', { uint: BigInt(deadline) }],
    ['t1', { uint: BigInt(deadline + 7200) }],
  ].map(([key, value]) => ({ key: new TextEncoder().encode(key), value }));
  const algod = {
    status: () => ({ do: async () => ({ lastRound: 1n }) }),
    block: () => ({
      do: async () => ({ block: { header: { timestamp: Math.floor(Date.now() / 1000) } } }),
    }),
    getTransactionParams: () => ({ do: async () => ({ genesisHash, genesisID: 'mock' }) }),
    getApplicationByID: () => ({ do: async () => ({ params: { ...onChainPrograms, globalState: globals } }) }),
    accountInformation: () => ({ do: async () => ({ amount: 0n }) }),
  };
  const modules = {
    algosdk: {
      ...algosdk,
      Algodv2: function () {
        return algod;
      },
    },
    'wxt/browser': { browser: { storage: { local: storage } } },
    '@noble/hashes/utils.js': { bytesToHex },
    '../network/networkStore': {
      getNetworkSettings: async () => ({ algorand: { algod: {} }, monero: { network: 'regtest' } }),
    },
    '../network/chainIdentity': { verifyAlgorandGenesis: () => {} },
    '../provider/base64': {
      bytesToBase64: (bytes) => Buffer.from(bytes).toString('base64'),
      base64ToBytes: (text) => new Uint8Array(Buffer.from(text, 'base64')),
    },
    './algoWallet': {
      deriveActiveSeedAlgoAddressAtIndex: async () => ({ algoAddress: ali.addr.toString() }),
    },
    './moneroVault': {
      getMoneroWalletState: async () => ({ activeWalletId: 1 }),
      saveMoneroCombinedContext: async () => {},
      loadMoneroCombinedContext: async () => ({
        walletId: 1,
        network: 'regtest',
        counterpartyPublicSpendKey: '03'.repeat(32),
        counterpartyPrivateViewKey: '05'.repeat(32),
      }),
      unlockMoneroWallet: async () => ({ publicSpendKey: '02'.repeat(32) }),
    },
    './moneroWallet': {
      computeCombinedAddressWithPrivateAndPublic: () => ({ combinedAddress: 'mock-combined' }),
      combinePrivateSpendKeys: () => 'mock-view-key',
    },
    '../monero/moneroDaemon': {
      scanMoneroFunding: async (_network, _spend, _view, height) => {
        scanHeights.push(height);
        return { matureAtomic: '0' };
      },
    },
    './swapHandshakeVault': {
      loadAcceptedSwap: async () => fixtureAgreement,
      resolveSwapWalletId: async () => 1,
    },
    'leakswap-utils/dist/swapAgreement.js': { assertAgreementState },
    'leakswap-utils/dist/swapTiming.js': roundTiming,
    './swapAgreementTransactions': transactions,
    './swapAgreementArtifact': {
      assertAgreementPrograms: (...args) => { if (onChainPrograms) artifactApi.assertAgreementPrograms(...args); },
      agreementSponsorAddress: () => xin.addr.toString(),
      agreementSponsorLogicSig: () => new algosdk.LogicSigAccount(new Uint8Array([6, 129, 1])),
    },
    './swapRecords': {
      listSwapRecords: async () => saved,
      listSignedTransactions: async () => journal,
      swapRecordKey: () => 'saved-swap',
      saveSwapRecord: async (_storage, record) => {
        const index = saved.findIndex(
          (previous) =>
            previous.appId === record.appId &&
            previous.genesisHash === record.genesisHash &&
            previous.algoAddress === record.algoAddress &&
            previous.context.walletId === record.context.walletId,
        );
        if (index < 0) saved.push(record);
        else saved[index] = record;
      },
    },
    './seedVault': seedVault,
    './swapAgreementUse': agreementUse,
    './swapTimingPolicy': timingPolicy,
    './swapSettlement': { verifiedSwapSettlement },
  };
  const locks = {
    request: (_name, action) => {
      const result = queue.then(action);
      queue = result.catch(() => {});
      return result;
    },
  };
  const load = () => {
    const api = {};
    runInNewContext(compiled, {
      exports: api,
      require: (name) => {
        if (!(name in modules)) throw new Error('Unexpected import: ' + name);
        return modules[name];
      },
      Uint8Array,
      TextEncoder,
      TextDecoder,
      console,
      navigator: { locks: locksAvailable ? locks : undefined },
    });
    return api;
  };
  const api = load();
  const sign = (txn, extra = {}) =>
    api.validateAgreementSigning(
      {
        agreementDigest: digest,
        txns: [Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')],
        indexesToSign: [0],
        ...extra,
      },
      'secret',
    );
  return {
    api,
    sign,
    storage,
    data,
    saved,
    load,
    algod,
    scanHeights,
    setScanner: (scanner) => {
      modules['../monero/moneroDaemon'].scanMoneroFunding = scanner;
    },
    setWallet: (material) => {
      modules['./moneroVault'].unlockMoneroWallet = async () => material;
    },
    setJournal: (entries) => {
      journal = entries;
    },
    useShare: () => {
      modules['./swapHandshakeVault'].resolveSwapWalletId = async () => -41;
      modules['./moneroVault'].unlockMoneroWallet = async (_secret, _network, walletId) => {
        assert.equal(walletId, -41, 'must unlock the share, never the normal active wallet');
        return { publicSpendKey: '02'.repeat(32) };
      };
      modules['./moneroVault'].loadMoneroCombinedContext = async (binding) => {
        assert.equal(binding.walletId, -41);
        return {
          ...binding,
          counterpartyPublicSpendKey: '03'.repeat(32),
          counterpartyPrivateViewKey: '05'.repeat(32),
        };
      };
    },
  };
}

test('confirmed journal settlement is restored and saved without consulting the deleted app', async () => {
  const vault = harness();
  const scalar = new Uint8Array(32);
  scalar[0] = 7;
  const publicKey = bytesToHex(ed25519.Point.BASE.multiply(7n).toBytes());
  const transaction = algosdk.makeApplicationDeleteTxnFromObject({
    sender: ali.addr,
    appIndex: 42n,
    appArgs: [
      algosdk.ABIMethod.fromSignature('leakyRefund(byte[],pay)void').getSelector(),
      new Uint8Array([0, 64, ...leakySign(algosdk.getApplicationAddress(42n).publicKey, scalar)]),
    ],
    suggestedParams: { fee: 1000n, minFee: 1000n, firstValid: 1n, lastValid: 10n, genesisHash },
  });
  const record = {
    version: 1,
    agreementDigest: digest,
    appId: '42',
    genesisHash: Buffer.from(genesisHash).toString('base64'),
    role: 'ali',
    algoAddress: ali.addr.toString(),
    aliAddress: ali.addr.toString(),
    xinAddress: xin.addr.toString(),
    context: {
      walletId: 1,
      network: 'regtest',
      combinedAddress: 'mock-combined',
      counterpartyPublicSpendKey: publicKey,
    },
  };
  vault.saved.push(record);
  vault.setWallet({ publicSpendKey: publicKey });
  vault.setJournal([
    {
      genesisHash: record.genesisHash,
      sender: record.algoAddress,
      txId: transaction.txID(),
      unsignedTransaction: Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
        'base64',
      ),
    },
  ]);
  vault.algod.getApplicationByID = () => {
    throw new Error('Deleted app must not be queried');
  };
  let confirmedRound = 0n;
  vault.algod.pendingTransactionInformation = () => ({
    do: async () => ({ txn: { txn: transaction }, confirmedRound }),
  });
  assert.equal((await vault.api.listVerifiedLeakSwaps('secret')).swaps[0].settlement, undefined);
  confirmedRound = 5n;
  assert.equal(
    (await vault.api.listVerifiedLeakSwaps('secret')).swaps[0].settlement.kind,
    'refund',
  );
  assert.equal(vault.saved[0].settlement.confirmedRound, '5');
  await vault.api.saveVerifiedLeakSwap(
    { appId: '42', agreementDigest: digest, combinedAddress: 'mock-combined', settlementTxId: transaction.txID() },
    'secret',
  );
  assert.equal(vault.saved.at(-1).settlement.txId, transaction.txID());
});

test('Set Ready scans from the signed height, with a genesis fallback for legacy offers', async () => {
  for (const height of [15227, undefined]) {
    const vault = harness();
    if (height === undefined) delete agreement.offer.payload.moneroRestoreHeight;
    else agreement.offer.payload.moneroRestoreHeight = height;
    agreement.offer.payload.xmrAmount = '1000000000000';
    vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
    const suggestedParams = {
      fee: 1000n,
      flatFee: true,
      firstValid: 1n,
      lastValid: 100n,
      genesisHash,
    };
    const transactions = [
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: xin.addr,
        receiver: ali.addr,
        amount: 0n,
        suggestedParams,
      }),
      algosdk.makeApplicationNoOpTxnFromObject({
        sender: ali.addr,
        appIndex: 42n,
        appArgs: [algosdk.ABIMethod.fromSignature('setReady(pay)void').getSelector()],
        suggestedParams,
      }),
    ];
    algosdk.assignGroupID(transactions);
    await assert.rejects(
      vault.api.validateAgreementSigning(
        {
          agreementDigest: digest,
          agreementAppId: '42',
          txns: transactions.map((transaction) =>
            Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString('base64'),
          ),
          indexesToSign: [1],
        },
        'secret',
      ),
      /Mature Monero funding is below/,
    );
    assert.deepEqual(vault.scanHeights, [height ?? 0]);
  }
});

function readyRequest() {
  const suggestedParams = {
    fee: 1000n,
    flatFee: true,
    firstValid: 1n,
    lastValid: 100n,
    genesisHash,
  };
  const group = algosdk.assignGroupID([
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: xin.addr,
      receiver: ali.addr,
      amount: 0n,
      suggestedParams,
    }),
    algosdk.makeApplicationNoOpTxnFromObject({
      sender: ali.addr,
      appIndex: 42n,
      appArgs: [algosdk.ABIMethod.fromSignature('setReady(pay)void').getSelector()],
      suggestedParams,
    }),
  ]);
  return {
    agreementDigest: digest,
    agreementAppId: '42',
    indexesToSign: [1],
    txns: group.map((transaction) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString('base64'),
    ),
  };
}

test('Set Ready rescans after success and rejects funding lost to a later chain view', async () => {
  const vault = harness();
  agreement.offer.payload.xmrAmount = '1000000000000';
  let matureAtomic = agreement.offer.payload.xmrAmount;
  let scans = 0;
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
  vault.setScanner(async () => {
    scans += 1;
    return { matureAtomic };
  });
  await vault.api.validateAgreementSigning(readyRequest(), 'secret');
  matureAtomic = '0';
  await assert.rejects(
    vault.api.validateAgreementSigning(readyRequest(), 'secret'),
    /Mature Monero funding is below/,
  );
  assert.equal(scans, 2);
});

test('Set Ready fails closed on scan RPC errors after a successful scan', async () => {
  const vault = harness();
  agreement.offer.payload.xmrAmount = '1000000000000';
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
  vault.setScanner(async () => ({ matureAtomic: agreement.offer.payload.xmrAmount }));
  await vault.api.validateAgreementSigning(readyRequest(), 'secret');
  vault.setScanner(async () => {
    throw new Error('daemon disconnected during scan');
  });
  await assert.rejects(
    vault.api.validateAgreementSigning(readyRequest(), 'secret'),
    /daemon disconnected/,
  );
});

test('Set Ready rejects a changed Monero wallet before scanning', async () => {
  const vault = harness();
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
  vault.setWallet({ publicSpendKey: 'ff'.repeat(32) });
  await assert.rejects(vault.api.validateAgreementSigning(readyRequest(), 'secret'), /Only Ali/);
  assert.deepEqual(vault.scanHeights, []);
});

test('Set Ready rejects a changed escrow before scanning', async () => {
  const vault = harness();
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 9999999n }) });
  await assert.rejects(
    vault.api.validateAgreementSigning(readyRequest(), 'secret'),
    /Escrow balance/,
  );
  assert.deepEqual(vault.scanHeights, []);
});

test('vault persists encrypted exact txID before validation returns, including response-loss retry', async () => {
  const vault = harness();
  const txn = deployment();
  await vault.sign(txn);
  const key = agreementUse.agreementUseKey({
    genesisHash: agreement.offer.payload.algoGenesisHash,
    digest,
  });
  const envelope = vault.data.get(key);
  assert.ok(envelope);
  assert.equal(JSON.stringify(envelope).includes(txn.txID()), false);
  const plaintext = await seedVault.decryptSeed(
    new Uint8Array(envelope.ciphertext).buffer,
    'secret',
    new Uint8Array(envelope.salt),
    new Uint8Array(envelope.iv),
  );
  assert.equal(JSON.parse(new TextDecoder().decode(plaintext)).deploymentTxId, txn.txID());
  plaintext.fill(0);
  await vault.sign(txn);
  assert.notEqual(txn.txID(), deployment(2000n).txID());
  await assert.rejects(vault.sign(deployment(2000n)), /permanently/);
});

test('vault fails closed on persistence failure, corrupted encryption and missing locks', async () => {
  const vault = harness();
  vault.storage.set = async () => {
    throw new Error('quota exceeded');
  };
  await assert.rejects(vault.sign(deployment()), /quota exceeded/);
  const corrupted = harness();
  await corrupted.sign(deployment());
  const envelope = [...corrupted.data.values()][0];
  envelope.ciphertext[0] ^= 1;
  await assert.rejects(corrupted.sign(deployment()));
  const unlocked = harness(false);
  await assert.rejects(unlocked.sign(deployment()));
  assert.equal(unlocked.data.size, 0);
});

test('actual vault contexts reject competing deployments and verified application IDs', async () => {
  const vault = harness();
  const results = await Promise.allSettled([
    vault.sign(deployment()),
    vault.sign(deployment(2000n)),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'rejected'],
  );
  const otherContext = vault.load();
  const applications = await Promise.allSettled([
    vault.api.verifyAgreementApplication(digest, 123n, 'secret'),
    otherContext.verifyAgreementApplication(digest, 124n, 'secret'),
  ]);
  assert.deepEqual(
    applications.map((result) => result.status),
    ['fulfilled', 'rejected'],
  );
  await vault.api.verifyAgreementApplication(digest, 123n, 'secret');
});

test('actual funding path binds the first app before return and rejects funding another', async () => {
  const vault = harness();
  const fund = (appId) => {
    const suggestedParams = {
      fee: 1000n,
      minFee: 1000n,
      flatFee: true,
      firstValid: 1n,
      lastValid: 100n,
      genesisHash,
    };
    const txns = algosdk.assignGroupID([
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: ali.addr,
        receiver: algosdk.getApplicationAddress(BigInt(appId)),
        amount: 10000000n,
        suggestedParams,
      }),
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: ali.addr,
        receiver: xin.addr,
        amount: 210000n,
        suggestedParams,
      }),
    ]);
    return vault.api.validateAgreementSigning(
      {
        agreementDigest: digest,
        agreementAppId: appId,
        txns: txns.map((txn) =>
          Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64'),
        ),
        indexesToSign: [0, 1],
      },
      'secret',
    );
  };
  await fund('123');
  assert.equal(vault.data.size, 1);
  await fund('123');
  await assert.rejects(fund('124'), /another application/);
});

function fundingRequest() {
  const suggestedParams = {
    fee: 1000n,
    minFee: 1000n,
    flatFee: true,
    firstValid: 1n,
    lastValid: 100n,
    genesisHash,
  };
  const group = algosdk.assignGroupID([
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: ali.addr,
      receiver: algosdk.getApplicationAddress(123n),
      amount: 10000000n,
      suggestedParams,
    }),
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: ali.addr,
      receiver: xin.addr,
      amount: 210000n,
      suggestedParams,
    }),
  ]);
  return {
    agreementDigest: digest,
    agreementAppId: '123',
    indexesToSign: [0, 1],
    txns: group.map((transaction) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString('base64'),
    ),
  };
}

test('funding response-loss retry is rejected once the fresh escrow query shows confirmation', async () => {
  const vault = harness();
  const request = fundingRequest();
  await vault.api.validateAgreementSigning(request, 'secret');
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
  await assert.rejects(vault.api.validateAgreementSigning(request, 'secret'), /already funded/);
});

test('funding rejects missing sponsor and wrong sponsor amount, but tolerates dust already in the escrow', async () => {
  const vault = harness();
  const request = fundingRequest();
  await assert.rejects(
    vault.api.validateAgreementSigning(
      { ...request, txns: request.txns.slice(0, 1), indexesToSign: [0] },
      'secret',
    ),
    /atomic escrow and sponsor/,
  );
  const payment = algosdk.decodeUnsignedTransaction(Buffer.from(request.txns[1], 'base64'));
  for (const amount of [204000n, 208999n, 209001n]) {
    payment.payment.amount = amount;
    await assert.rejects(
      vault.api.validateAgreementSigning(
        {
          ...request,
          txns: [
            request.txns[0],
            Buffer.from(algosdk.encodeUnsignedTransaction(payment)).toString('base64'),
          ],
        },
        'secret',
      ),
      /sponsor funding/,
    );
  }
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 1n }) });
  await vault.api.validateAgreementSigning(request, 'secret');
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
  await assert.rejects(vault.api.validateAgreementSigning(request, 'secret'), /already funded/);
});

test('funding does not treat unavailable escrow state as an empty account', async () => {
  const vault = harness();
  vault.algod.accountInformation = () => ({
    do: async () => {
      throw new Error('algod disconnected');
    },
  });
  await assert.rejects(
    vault.api.validateAgreementSigning(fundingRequest(), 'secret'),
    /algod disconnected/,
  );
});

test('atomic ALGO funding enforces the node round boundary and fails closed on malformed rounds', async () => {
  const vault = harness();
  const request = fundingRequest();
  let round = deadline - 1200;
  vault.algod.status = () => ({ do: async () => ({ lastRound: round }) });
  vault.algod.block = () => { throw new Error('Round-based funding must not fetch timestamps.'); };
  await vault.api.validateAgreementSigning(request, 'secret');
  round++;
  await assert.rejects(
    vault.api.validateAgreementSigning(request, 'secret'),
    /60 minutes.*deposit deadline/,
  );
  round = NaN;
  await assert.rejects(vault.api.validateAgreementSigning(request, 'secret'), /node round/);
});

test('completed and legacy saved swaps still list without application queries or reservation checks', async () => {
  const vault = harness();
  await vault.api.saveVerifiedLeakSwap(
    { appId: '123', agreementDigest: digest, combinedAddress: 'mock-combined' },
    'secret',
  );
  vault.saved.push({ ...vault.saved[0], appId: '124', agreementDigest: undefined });
  vault.algod.getApplicationByID = () => {
    throw new Error('Application was deleted');
  };
  for (const key of vault.data.keys()) vault.data.set(key, { version: 999 });
  const listed = await vault.api.listVerifiedLeakSwaps('secret');
  assert.equal(listed.swaps.length, 2);
  assert.equal(listed.swaps[0].appId, '123');
  assert.equal(listed.swaps[1].appId, '124');
});

test('saveVerifiedLeakSwap cannot save two matching applications under one agreement', async () => {
  const vault = harness();
  const params = { appId: '123', agreementDigest: digest, combinedAddress: 'mock-combined' };
  await vault.api.saveVerifiedLeakSwap(params, 'secret');
  assert.equal(vault.saved.length, 1);
  await assert.rejects(
    vault.api.saveVerifiedLeakSwap({ ...params, appId: '124' }, 'secret'),
    /another application/,
  );
  assert.equal(vault.saved.length, 1);
  await assert.rejects(vault.sign(deployment()), /permanently/);
});

test('saved legacy agreement identity prevents redeployment and a second app binding', async () => {
  const vault = harness();
  vault.saved.push({
    genesisHash: agreement.offer.payload.algoGenesisHash,
    agreementDigest: digest,
    appId: '123',
  });
  await assert.rejects(vault.sign(deployment()), /permanently/);
  await assert.rejects(
    vault.api.verifyAgreementApplication(digest, 124n, 'secret'),
    /another application/,
  );
  await vault.api.verifyAgreementApplication(digest, 123n, 'secret');
});

test('invalid deployment selection cannot reserve and generic digest-less signing remains outside this protection', async () => {
  const vault = harness();
  await assert.rejects(vault.sign(deployment(), { indexesToSign: [] }), /Invalid agreement deployment/);
  assert.equal(vault.data.size, 0);
  await vault.sign(deployment());
  await vault.sign(deployment(2000n), { agreementDigest: undefined });
  assert.equal(vault.data.size, 1);
});

test('share-bound save, list and Set Ready use the share even while the normal wallet stays active', async () => {
  const vault = harness();
  vault.useShare();
  await vault.api.saveVerifiedLeakSwap(
    { appId: '123', agreementDigest: digest, combinedAddress: 'mock-combined' },
    'secret',
  );
  assert.equal(vault.saved[0].context.walletId, -41);
  const listed = await vault.api.listVerifiedLeakSwaps('secret');
  assert.equal(listed.swaps.length, 1);
  assert.equal(listed.swaps[0].appId, '123');
  agreement.offer.payload.xmrAmount = '1000000000000';
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
  const suggestedParams = {
    fee: 1000n,
    flatFee: true,
    firstValid: 1n,
    lastValid: 100n,
    genesisHash,
  };
  const group = [
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: xin.addr,
      receiver: ali.addr,
      amount: 0n,
      suggestedParams,
    }),
    algosdk.makeApplicationNoOpTxnFromObject({
      sender: ali.addr,
      appIndex: 123n,
      appArgs: [algosdk.ABIMethod.fromSignature('setReady(pay)void').getSelector()],
      suggestedParams,
    }),
  ];
  algosdk.assignGroupID(group);
  await assert.rejects(
    vault.api.validateAgreementSigning(
      {
        agreementDigest: digest,
        agreementAppId: '123',
        txns: group.map((txn) =>
          Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64'),
        ),
        indexesToSign: [1],
      },
      'secret',
    ),
    /Mature Monero funding is below/,
  );
  assert.equal(vault.scanHeights.length, 1);
});
function sponsoredGroup(method) {
  const suggestedParams = {
    fee: 1000n,
    flatFee: true,
    firstValid: 1n,
    lastValid: 100n,
    genesisHash,
  };
  const group = [
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: xin.addr,
      receiver: ali.addr,
      amount: 0n,
      suggestedParams,
    }),
    algosdk.makeApplicationNoOpTxnFromObject({
      sender: ali.addr,
      appIndex: 42n,
      appArgs: [algosdk.ABIMethod.fromSignature(method).getSelector()],
      suggestedParams,
    }),
  ];
  algosdk.assignGroupID(group);
  return group;
}

function simulatedVault(simulate) {
  const vault = harness();
  vault.algod.accountInformation = () => ({ do: async () => ({ amount: 10000000n }) });
  const requests = [];
  vault.algod.simulateTransactions = (request) => {
    requests.push(request);
    return { do: async () => simulate() };
  };
  const run = (group) =>
    vault.api.validateAgreementSigning(
      {
        agreementDigest: digest,
        agreementAppId: '42',
        indexesToSign: [1],
        txns: group.map((txn) =>
          Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64'),
        ),
      },
      'secret',
    );
  return { run, requests, vault };
}

test('generic agreement signing cannot bypass wallet-owned claim or refund settlement', async () => {
  for (const method of ['leakyClaim(byte[],pay)void', 'leakyRefund(byte[],pay)void']) {
    const { run, requests, vault } = simulatedVault(async () => ({
      txnGroups: [{ failureMessage: 'logic eval error: assert failed' }],
    }));
    vault.setScanner(async () => ({ matureAtomic: '0' }));
    await assert.rejects(run(sponsoredGroup(method)), /must use settleLeakSwap/);
    assert.equal(requests.length, 0);
  }
});

test('a passing node simulation cannot authorize the old generic claim-signing path', async () => {
  const { run, requests } = simulatedVault(async () => ({ txnGroups: [{}] }));
  await assert.rejects(
    run(sponsoredGroup('leakyClaim(byte[],pay)void')),
    /must use settleLeakSwap/,
  );
  assert.equal(requests.length, 0);
});

test('a node that cannot simulate blocks leaky signing instead of letting it through', async () => {
  const { run } = simulatedVault(async () => {
    throw new Error('simulate disabled');
  });
  await assert.rejects(
    run(sponsoredGroup('leakyClaim(byte[],pay)void')),
    /must use settleLeakSwap/,
  );
});

test('punish refund does not publish a key share and is not simulated', async () => {
  const { run, requests } = simulatedVault(async () => ({
    txnGroups: [{ failureMessage: 'would fail' }],
  }));
  await run(sponsoredGroup('punishRefund(pay)void'));
  assert.equal(requests.length, 0);
});

function agreementWithUnit(unit) {
  const copy = structuredClone(agreement);
  if (unit === 'timestamp') {
    delete copy.offer.payload.deadlineUnit;
    delete copy.offer.payload.createdRound;
  }
  return copy;
}

for (const unit of ['round']) test(`${unit} saved agreement verifies exact known programs and restores its deadline metadata`, async () => {
  const authenticated = agreementWithUnit(unit);
  const vault = harness(true, authenticated, programs(canonical));
  await vault.api.verifyAgreementApplication(digest, 123n, 'secret');
  await vault.api.saveVerifiedLeakSwap({ appId: '123', agreementDigest: digest, combinedAddress: 'mock-combined' }, 'secret');
  assert.equal(vault.saved.length, 1);
  assert.equal(vault.saved[0].deadlineUnit, unit === 'round' ? 'round' : undefined);
  assert.equal(vault.saved[0].createdRound, unit === 'round' ? authenticated.offer.payload.createdRound : undefined);
  const [restored] = (await vault.load().listVerifiedLeakSwaps('secret')).swaps;
  assert.equal(restored.agreement.offer.payload.deadlineUnit, authenticated.offer.payload.deadlineUnit);
  assert.equal(restored.t0, authenticated.offer.payload.t0);
  assert.equal(restored.t1, authenticated.offer.payload.t1);
});

for (const [name, unit, artifact, alter] of [
  ['timestamp offer with round programs', 'timestamp', canonical, () => {}],
  ['round offer with modified programs', 'round', canonical, value => { value.approvalProgram[0] ^= 1; }],
  ['modified timestamp approval', 'timestamp', canonical, value => { value.approvalProgram[0] ^= 1; }],
  ['modified timestamp clear', 'timestamp', canonical, value => { value.clearStateProgram[0] ^= 1; }],
]) test(`save and recovery reject ${name} before reserving an application`, async () => {
  const deployed = programs(artifact);
  alter(deployed);
  const vault = harness(true, agreementWithUnit(unit), deployed);
  await assert.rejects(vault.api.verifyAgreementApplication(digest, 123n, 'secret'), /supported LeakSwap protocol|Legacy timestamp/);
  await assert.rejects(vault.api.saveVerifiedLeakSwap({ appId: '123', agreementDigest: digest, combinedAddress: 'mock-combined' }, 'secret'), /supported LeakSwap protocol|Legacy timestamp/);
  assert.equal(vault.saved.length, 0);
  assert.equal(vault.data.size, 0);
});

test('legacy terms are rejected before reserving an application', async () => {
  const authenticated = agreementWithUnit('timestamp');
  authenticated.offer.payload.t0++;
  const vault = harness(true, authenticated, programs(canonical));
  await assert.rejects(vault.api.verifyAgreementApplication(digest, 123n, 'secret'), /Legacy timestamp/);
  assert.equal(vault.data.size, 0);
});

test('unsupported programs cannot deploy even with round-based signed terms', async () => {
  const vault = harness(true, agreementWithUnit('round'), programs(canonical));
  const transaction = deployment();
  await assert.rejects(vault.sign(transaction), /supported LeakSwap protocol/);
  assert.equal(vault.data.size, 0);
});

test('legacy signed terms cannot authorize any new deployment', async () => {
  const vault = harness(true, agreementWithUnit('timestamp'), programs(canonical));
  await assert.rejects(vault.sign(deployment()), /Legacy timestamp invitations/);
  assert.equal(vault.data.size, 0);
});
