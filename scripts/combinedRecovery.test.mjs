import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverCombinedWallet } from '../lib/wallet/combinedRecovery.ts';
import {
  computeCombinedAddressWithPrivateAndPublic,
  getMoneroKeyMaterialFromPrivateSpendKey,
  getPublicKeyFromPrivateScalar,
  combinePrivateSpendKeys,
  MoneroNetworkType,
} from '../lib/wallet/moneroWallet.ts';

const scalar = (value) => value.toString(16).padStart(2, '0') + '00'.repeat(31);
const owner = getMoneroKeyMaterialFromPrivateSpendKey(scalar(3));
owner.privateViewKey = scalar(7);
const counterpartySpend = scalar(5);
const counterpartyView = scalar(11);
const context = {
  version: 1,
  walletId: 1,
  network: 'regtest',
  restoreHeight: 123,
  counterpartyPublicSpendKey: getPublicKeyFromPrivateScalar(counterpartySpend),
  counterpartyPrivateViewKey: counterpartyView,
  combinedAddress: computeCombinedAddressWithPrivateAndPublic(
    owner.privateSpendKey,
    owner.privateViewKey,
    counterpartyView,
    getPublicKeyFromPrivateScalar(counterpartySpend),
  ).combinedAddress,
};

test('recovers the selected address with actual independent view keys', () => {
  const recovered = recoverCombinedWallet(
    owner,
    counterpartySpend,
    context,
    MoneroNetworkType.MAINNET,
  );
  assert.equal(recovered.address, context.combinedAddress);
  assert.equal(recovered.privateViewKey, combinePrivateSpendKeys(scalar(7), scalar(11)));
});

test('rejects wrong counterparty, malformed scalar, address and network', () => {
  assert.throws(
    () => recoverCombinedWallet(owner, scalar(13), context, MoneroNetworkType.MAINNET),
    /selected swap/,
  );
  assert.throws(() => recoverCombinedWallet(owner, 'invalid', context, MoneroNetworkType.MAINNET));
  assert.throws(
    () =>
      recoverCombinedWallet(
        owner,
        counterpartySpend,
        { ...context, combinedAddress: owner.address },
        MoneroNetworkType.MAINNET,
      ),
    /Recovered address/,
  );
  assert.throws(
    () => recoverCombinedWallet(owner, counterpartySpend, context, MoneroNetworkType.TESTNET),
    /Recovered address/,
  );
});

test('rejects a different owner or view key even with the right counterparty spend key', () => {
  assert.throws(
    () =>
      recoverCombinedWallet(
        getMoneroKeyMaterialFromPrivateSpendKey(scalar(17)),
        counterpartySpend,
        context,
        MoneroNetworkType.MAINNET,
      ),
    /Recovered address/,
  );
  assert.throws(
    () =>
      recoverCombinedWallet(
        owner,
        counterpartySpend,
        { ...context, counterpartyPrivateViewKey: scalar(19) },
        MoneroNetworkType.MAINNET,
      ),
    /Recovered address/,
  );
});
