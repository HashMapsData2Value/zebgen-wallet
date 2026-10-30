import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fundingRestoreHeight,
  validateFundingParams,
  validateProviderRequest,
} from '../lib/provider/fundingValidation.ts';

const params = {
  counterpartyPrivateViewKey: '01'.repeat(32),
  counterpartyPublicSpendKey: '02'.repeat(32),
};

test('recovery accepts only saved app identity and an optional transaction reference', () => {
  assert.doesNotThrow(() => validateProviderRequest('recoverLeakSwapMonero', { appId: '42' }));
  assert.doesNotThrow(() =>
    validateProviderRequest('recoverLeakSwapMonero', {
      appId: '42',
      settlementTxId: 'A'.repeat(52),
    }),
  );
  for (const value of [
    null,
    [],
    {},
    { appId: '0' },
    { appId: '42', settlementTxId: 'bad' },
    { appId: '42', privateSpendKey: 'aa' },
  ]) {
    assert.throws(() => validateProviderRequest('recoverLeakSwapMonero', value));
  }
});

test('saving terminal state accepts a transaction reference but rejects malformed references', () => {
  const input = { appId: '42', combinedAddress: '4'.repeat(95) };
  assert.doesNotThrow(() =>
    validateProviderRequest('saveLeakSwap', { ...input, settlementTxId: 'A'.repeat(52) }),
  );
  for (const settlementTxId of ['', null, 42, 'bad'])
    assert.throws(() => validateProviderRequest('saveLeakSwap', { ...input, settlementTxId }));
});

test('funding requests accept optional wallet and u32 restore heights', () => {
  for (const restoreHeight of [undefined, 0, 1, 0xffffffff]) {
    assert.doesNotThrow(() =>
      validateProviderRequest('scanCombinedMoneroFunding', {
        ...params,
        moneroWalletId: 0,
        restoreHeight,
      }),
    );
  }
});

test('funding requests reject invalid heights before approval or WASM conversion', () => {
  for (const restoreHeight of [-1, 0x100000000, 1.5, NaN, Infinity, '0', null]) {
    assert.throws(() => validateFundingParams({ ...params, restoreHeight }), /u32/);
  }
});

test('funding requests require both 32-byte keys and a valid optional wallet ID', () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { ...params, counterpartyPrivateViewKey: 'aa' },
    { ...params, counterpartyPublicSpendKey: 'zz'.repeat(32) },
  ]) {
    assert.throws(() => validateFundingParams(value));
  }
  for (const moneroWalletId of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateFundingParams({ ...params, moneroWalletId }), /wallet ID/);
  }
});

test('restore height uses explicit input, remembered history, then zero, never a new chain tip', () => {
  assert.equal(fundingRestoreHeight(0, 900), 0);
  assert.equal(fundingRestoreHeight(100, 900), 100);
  assert.equal(fundingRestoreHeight(undefined, 900), 900);
  assert.equal(fundingRestoreHeight(undefined, undefined), 0);
  assert.throws(() => fundingRestoreHeight(undefined, 0x100000000), /u32/);
});

test('provider gate recognizes existing operations and rejects unknown requests', () => {
  for (const type of [
    'connect',
    'getAlgorandAddress',
    'getMoneroShareInfo',
    'computeCombinedMoneroAddress',
    'signAlgorandTransactions',
    'computeMoneroLeakySignature',
  ]) {
    assert.doesNotThrow(() => validateProviderRequest(type, {}));
  }
  assert.throws(() => validateProviderRequest('scanFunding', params), /Unsupported/);
});

test('swap persistence provider rejects malformed identities before approval', () => {
  assert.doesNotThrow(() => validateProviderRequest('listLeakSwaps', {}));
  assert.doesNotThrow(() =>
    validateProviderRequest('saveLeakSwap', { appId: '123', combinedAddress: '4'.repeat(95) }),
  );
  for (const appId of [undefined, 123, '', '0', '-1', '1.5', '18446744073709551616']) {
    assert.throws(
      () => validateProviderRequest('saveLeakSwap', { appId, combinedAddress: '4'.repeat(95) }),
      /identity/,
    );
  }
  assert.throws(
    () => validateProviderRequest('saveLeakSwap', { appId: '123', combinedAddress: 'invalid' }),
    /identity/,
  );
});

test('handshake provider accepts only structured terms and link-only responses', () => {
  const terms = {
    deadlineUnit: 'round',
    algoAmount: '10000000',
    xmrAmount: '1000000000000',
    t0: 200,
    t1: 300,
  };
  assert.doesNotThrow(() => validateProviderRequest('createSwapInvite', terms));
  const { deadlineUnit, ...legacy } = terms;
  assert.throws(() => validateProviderRequest('createSwapInvite', legacy), /Legacy timestamp/);
  assert.throws(() => validateProviderRequest('createSwapInvite', { ...terms, createdRound: 100 }));
  for (const input of [
    null,
    'TX',
    [],
    { ...terms, bytes: 'TX' },
    { ...terms, domain: 'MX' },
    { ...terms, t0: -1 },
    { ...terms, t1: Number.MAX_SAFE_INTEGER },
    { ...terms, algoAmount: '1e7' },
  ]) {
    assert.throws(() => validateProviderRequest('createSwapInvite', input));
  }
  for (const type of ['acceptSwapInvite', 'confirmSwapAcceptance']) {
    assert.doesNotThrow(() =>
      validateProviderRequest(type, { link: 'https://app.leakswap.com/swap#invite=example' }),
    );
    for (const input of [null, {}, { link: 'url', bytes: 'TX' }, { link: 'x'.repeat(12513) }]) {
      assert.throws(() => validateProviderRequest(type, input));
    }
  }
});

test('every share operation rejects malformed agreement digests before approval', () => {
  for (const type of [
    'getMoneroShareInfo',
    'computeCombinedMoneroAddress',
    'scanCombinedMoneroFunding',
    'computeMoneroLeakySignature',
  ]) {
    assert.doesNotThrow(() =>
      validateProviderRequest(type, { ...params, agreementDigest: 'ab'.repeat(32) }),
    );
    for (const agreementDigest of ['', 'AB'.repeat(32), 'aa', null, 1]) {
      assert.throws(
        () => validateProviderRequest(type, { ...params, agreementDigest }),
        /agreement digest/,
      );
    }
  }
});
