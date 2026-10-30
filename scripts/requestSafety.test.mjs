import assert from 'node:assert/strict';
import test from 'node:test';
import algosdk from 'algosdk';
import {
  assertSafeSigningRequest,
  MAX_SIGNED_FEE_MICROALGOS,
} from '../lib/wallet/swapAgreementTransactions.ts';
import {
  assertAgreementBound,
  assertProviderSender,
  isValidRequestId,
} from '../lib/provider/requestSafety.ts';

const genesisHash = new Uint8Array(32).fill(1);
const account = algosdk.generateAccount();
const other = algosdk.generateAccount();
const suggestedParams = { fee: 1000n, flatFee: true, firstValid: 1n, lastValid: 100n, genesisHash };

test('provider identity comes from browser sender metadata, not the claimed origin', () => {
  const origin = 'https://app.leakswap.com';
  const sender = { id: 'wallet', url: `${origin}/swap/42`, origin, tab: { id: 7 } };
  assert.doesNotThrow(() => assertProviderSender(origin, sender, 'wallet'));
  assert.doesNotThrow(() =>
    assertProviderSender(origin, { ...sender, origin: undefined }, 'wallet'),
  );
  for (const change of [
    { id: 'other-extension' },
    { tab: undefined },
    { url: undefined },
    { url: 'https://attacker.example/' },
    { origin: 'null' },
    { origin: 'https://attacker.example' },
    { url: 'chrome-extension://wallet/popup.html' },
    { url: 'data:text/html,test' },
  ]) {
    assert.throws(() => assertProviderSender(origin, { ...sender, ...change }, 'wallet'));
  }
  assert.throws(() => assertProviderSender(`${origin}/`, sender, 'wallet'));
});

const payment = (extra = {}) =>
  algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0n,
    suggestedParams,
    ...extra,
  });
const appCall = (extra = {}) =>
  algosdk.makeApplicationNoOpTxnFromObject({
    sender: account.addr,
    appIndex: 42n,
    suggestedParams,
    ...extra,
  });
const appCallWith = (onComplete, extra = {}) =>
  algosdk.makeApplicationCallTxnFromObject({
    sender: account.addr,
    appIndex: 42n,
    onComplete,
    suggestedParams,
    ...extra,
  });

test('a payment that closes the account to someone else is never signed', () => {
  assert.throws(
    () => assertSafeSigningRequest([payment({ closeRemainderTo: other.addr })], [0]),
    /closes the account/,
  );
});

test('rekeying is refused for payments and application calls', () => {
  assert.throws(() => assertSafeSigningRequest([payment({ rekeyTo: other.addr })], [0]), /rekeys/);
  assert.throws(() => assertSafeSigningRequest([appCall({ rekeyTo: other.addr })], [0]), /rekeys/);
});

test('fees large enough to drain an account are refused, normal swap fees are not', () => {
  const fee = (microAlgos) => ({ suggestedParams: { ...suggestedParams, fee: microAlgos } });
  assert.throws(
    () => assertSafeSigningRequest([payment(fee(MAX_SIGNED_FEE_MICROALGOS + 1n))], [0]),
    /high fee/,
  );
  assert.doesNotThrow(() =>
    assertSafeSigningRequest([payment(fee(1000n)), appCall(fee(7000n))], [0, 1]),
  );
});

test('only payments and application calls with supported actions can be signed', () => {
  const asset = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: other.addr,
    amount: 1n,
    assetIndex: 7n,
    suggestedParams,
  });
  assert.throws(() => assertSafeSigningRequest([asset], [0]), /Only payment and application-call/);
  assert.throws(
    () =>
      assertSafeSigningRequest(
        [
          appCallWith(algosdk.OnApplicationComplete.UpdateApplicationOC, {
            approvalProgram: new Uint8Array([6, 129, 1]),
            clearProgram: new Uint8Array([6, 129, 1]),
          }),
        ],
        [0],
      ),
    /Unsupported application call action/,
  );
  assert.throws(
    () => assertSafeSigningRequest([appCallWith(algosdk.OnApplicationComplete.CloseOutOC)], [0]),
    /Unsupported application call action/,
  );
  assert.throws(
    () => assertSafeSigningRequest([appCallWith(algosdk.OnApplicationComplete.ClearStateOC)], [0]),
    /Unsupported application call action/,
  );
  assert.doesNotThrow(() =>
    assertSafeSigningRequest([appCallWith(algosdk.OnApplicationComplete.DeleteApplicationOC)], [0]),
  );
});

test('only transactions the wallet is asked to sign are checked, and indexes must be valid', () => {
  const sponsor = payment({ closeRemainderTo: other.addr });
  assert.doesNotThrow(() => assertSafeSigningRequest([sponsor, appCall()], [1]));
  for (const indexes of [[2], [-1], [0, 0], [1.5]]) {
    assert.throws(() => assertSafeSigningRequest([sponsor, appCall()], indexes), /Invalid list/);
  }
});

test('requests that would expose normal Monero keys require a dedicated agreement in every build', () => {
  const digest = 'ab'.repeat(32);
  for (const type of [
    'computeMoneroLeakySignature',
    'getMoneroShareInfo',
    'computeCombinedMoneroAddress',
    'scanCombinedMoneroFunding',
  ]) {
    assert.throws(
      () => assertAgreementBound(type, { messageHex: '00' }),
      /saved swap agreement/,
      type,
    );
    assert.throws(
      () => assertAgreementBound(type, { agreementDigest: 'not-a-digest' }),
      /saved swap agreement|settleLeakSwap/,
      type,
    );
    assert.throws(() => assertAgreementBound(type, null), /saved swap agreement/, type);
    if (type === 'computeMoneroLeakySignature') {
      assert.throws(
        () => assertAgreementBound(type, { agreementDigest: digest }),
        /signatures are not exported/,
      );
    } else assert.doesNotThrow(() => assertAgreementBound(type, { agreementDigest: digest }), type);
  }
  for (const type of ['signAlgorandTransactions', 'connect', 'listLeakSwaps']) {
    assert.doesNotThrow(() => assertAgreementBound(type, {}), type);
  }
});

test('request ids must be UUIDs so they cannot inject into the approval URL', () => {
  assert.equal(isValidRequestId(crypto.randomUUID()), true);
  for (const id of [
    '',
    'abc',
    'x&zebgenRequestId=1',
    `${crypto.randomUUID()}#frag`,
    42,
    undefined,
    null,
  ]) {
    assert.equal(isValidRequestId(id), false);
  }
});
