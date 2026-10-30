import assert from 'node:assert/strict';
import test from 'node:test';
import algosdk from 'algosdk';
import {
  checkAgreementTransaction,
  checkAgreementEscrowPayment,
  checkAgreementSponsorPayment,
} from '../lib/wallet/swapAgreementTransactions.ts';
import { assertAgreementState, assertAgreementFunding } from 'leakswap-utils/dist/swapAgreement.js';

const agreement = {
  offer: {
    payload: {
      deadlineUnit: 'round',
      createdRound: 100,
      algoGenesisHash: 'genesis',
      moneroNetwork: 'regtest',
      aliAlgoAddress: 'ali',
      aliPublicSpendKey: 'ali-key',
      t0: 200,
      t1: 300,
      algoAmount: '10000000',
    },
  },
  acceptance: { payload: { xinAlgoAddress: 'xin', xinPublicSpendKey: 'xin-key' } },
};
const state = {
  deadlineUnit: 'round',
  genesisHash: 'genesis',
  moneroNetwork: 'regtest',
  aliAddress: 'ali',
  xinAddress: 'xin',
  aliPublicSpendKey: 'ali-key',
  xinPublicSpendKey: 'xin-key',
  t0: 200,
  t1: 300,
};

test('agreement binds networks, parties, keys and exact round deadlines', () => {
  assert.doesNotThrow(() => assertAgreementState(agreement, state));
  for (const [field, value] of Object.entries(state)) {
    assert.throws(
      () =>
        assertAgreementState(agreement, {
          ...state,
          [field]: typeof value === 'number' ? value + 1 : value + '-changed',
        }),
      /authenticated agreement/,
    );
  }
});

test('agreement state must explicitly match the signed deadline unit', () => {
  const round = {
    ...agreement,
    offer: { payload: { ...agreement.offer.payload, deadlineUnit: 'round', createdRound: 100 } },
  };
  assert.throws(
    () => assertAgreementState(round, { ...state, deadlineUnit: undefined }),
    /authenticated agreement/,
  );
  assert.doesNotThrow(() => assertAgreementState(round, { ...state, deadlineUnit: 'round' }));
  assert.throws(
    () =>
      assertAgreementState(
        {
          ...agreement,
          offer: { payload: { ...agreement.offer.payload, deadlineUnit: undefined } },
        },
        state,
      ),
    /authenticated agreement/,
  );
});

test('agreement requires exact ALGO amount, not a maximum or minimum', () => {
  assert.doesNotThrow(() => assertAgreementFunding(agreement, 10000000n));
  for (const amount of [0n, 9999999n, 10000001n])
    assert.throws(() => assertAgreementFunding(agreement, amount), /authenticated amount/);
});

test('sponsor funding covers ready and the 8000 pooled claim fee for a zero-balance Xin', () => {
  const ali = algosdk.generateAccount();
  const sponsor = algosdk.generateAccount();
  const bound = {
    ...agreement,
    offer: { payload: { ...agreement.offer.payload, aliAlgoAddress: ali.addr.toString() } },
  };
  const suggestedParams = { fee: 1000n, flatFee: true, firstValid: 1n, lastValid: 100n };
  const payment = (amount, changes = {}) =>
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: ali.addr,
      receiver: sponsor.addr,
      amount,
      suggestedParams,
      ...changes,
    });
  assert.doesNotThrow(() =>
    checkAgreementSponsorPayment(payment(210000n), bound, sponsor.addr.toString()),
  );
  assert.equal(210000n - 102000n - 8000n, 100000n);
  assert.ok(209000n - 102000n - 8000n < 100000n);
  for (const amount of [204000n, 209000n, 209999n, 210001n]) {
    assert.throws(
      () => checkAgreementSponsorPayment(payment(amount), bound, sponsor.addr.toString()),
      /sponsor funding/,
    );
  }
  for (const changes of [{ sender: sponsor.addr }, { receiver: ali.addr }]) {
    assert.throws(
      () => checkAgreementSponsorPayment(payment(210000n, changes), bound, sponsor.addr.toString()),
      /sponsor funding/,
    );
  }
});

test('actual deployment bytes must preserve agreed keys, accounts, network and deadlines', () => {
  const ali = algosdk.generateAccount();
  const xin = algosdk.generateAccount();
  const genesisHash = new Uint8Array(32).fill(1);
  const bound = {
    offer: {
      payload: {
        ...agreement.offer.payload,
        deadlineUnit: 'round',
        createdRound: 100,
        algoGenesisHash: Buffer.from(genesisHash).toString('base64'),
        aliAlgoAddress: ali.addr.toString(),
        aliPublicSpendKey: '02'.repeat(32),
      },
    },
    acceptance: {
      payload: { xinAlgoAddress: xin.addr.toString(), xinPublicSpendKey: '03'.repeat(32) },
    },
  };
  const suggestedParams = {
    fee: 1000n,
    minFee: 1000n,
    flatFee: true,
    firstValid: 1n,
    lastValid: 100n,
    genesisHash,
  };
  const build = (changes = {}) => {
    const composer = new algosdk.AtomicTransactionComposer();
    composer.addMethodCall({
      appID: 0n,
      sender: ali.addr,
      suggestedParams,
      method: algosdk.ABIMethod.fromSignature(
        'createApplication(byte[],account,byte[],uint64,uint64)void',
      ),
      methodArgs: [new Uint8Array(32).fill(2), xin.addr, new Uint8Array(32).fill(3), 200n, 300n],
      approvalProgram: new Uint8Array([10]),
      clearProgram: new Uint8Array([10]),
      numGlobalInts: 3,
      numGlobalByteSlices: 4,
      numLocalInts: 0,
      numLocalByteSlices: 0,
      signer: async () => [],
      ...changes,
    });
    return composer.buildGroup()[0].txn;
  };
  assert.doesNotThrow(() => checkAgreementTransaction(build(), bound, 'regtest'));
  assert.doesNotThrow(() =>
    checkAgreementTransaction(
      algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(build())),
      bound,
      'regtest',
    ),
  );
  for (const methodArgs of [
    [new Uint8Array(32).fill(9), xin.addr, new Uint8Array(32).fill(3), 200n, 300n],
    [
      new Uint8Array(32).fill(2),
      algosdk.generateAccount().addr,
      new Uint8Array(32).fill(3),
      200n,
      300n,
    ],
    [new Uint8Array(32).fill(2), xin.addr, new Uint8Array(32).fill(3), 201n, 300n],
  ])
    assert.throws(
      () => checkAgreementTransaction(build({ methodArgs }), bound, 'regtest'),
      /authenticated agreement/,
    );
  assert.throws(
    () => checkAgreementTransaction(build(), bound, 'mainnet'),
    /authenticated agreement/,
  );
  const escrow = algosdk.getApplicationAddress(123n);
  const payment = (amount, extra = {}) =>
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: ali.addr,
      receiver: escrow,
      amount,
      suggestedParams,
      ...extra,
    });
  assert.doesNotThrow(() => checkAgreementEscrowPayment(payment(10000000n), bound, 123n));
  assert.throws(
    () => checkAgreementEscrowPayment(payment(9999999n), bound, 123n),
    /authenticated amount/,
  );
  assert.throws(
    () => checkAgreementEscrowPayment(payment(10000000n, { receiver: xin.addr }), bound, 123n),
    /identity mismatch/,
  );
  assert.throws(
    () => checkAgreementTransaction(payment(10000000n, { rekeyTo: xin.addr }), bound, 'regtest'),
    /rekey/,
  );
});
