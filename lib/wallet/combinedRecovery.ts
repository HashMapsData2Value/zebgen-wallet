import {
  combinePrivateSpendKeys,
  getCompleteAddressFromPrivate,
  getPublicKeyFromPrivateScalar,
  MoneroNetworkType,
  type MoneroKeyMaterial,
} from './moneroWallet.ts';
import type { CombinedAddressContext } from './combinedAddressContext.ts';

export function recoverCombinedWallet(
  owner: MoneroKeyMaterial,
  counterpartyPrivateSpendKey: string,
  context: CombinedAddressContext,
  networkType: MoneroNetworkType,
): MoneroKeyMaterial {
  if (
    getPublicKeyFromPrivateScalar(counterpartyPrivateSpendKey) !==
    context.counterpartyPublicSpendKey.toLowerCase()
  ) {
    throw new Error('Counterparty private spend key does not match the selected swap.');
  }
  const privateSpendKey = combinePrivateSpendKeys(
    owner.privateSpendKey,
    counterpartyPrivateSpendKey,
  );
  const privateViewKey = combinePrivateSpendKeys(
    owner.privateViewKey,
    context.counterpartyPrivateViewKey,
  );
  const address = getCompleteAddressFromPrivate(privateSpendKey, privateViewKey, networkType);
  if (address !== context.combinedAddress) {
    throw new Error('Recovered address does not match the selected swap.');
  }
  return {
    privateSpendKey,
    privateViewKey,
    publicSpendKey: getPublicKeyFromPrivateScalar(privateSpendKey),
    publicViewKey: getPublicKeyFromPrivateScalar(privateViewKey),
    address,
  };
}
