import { hexToBytes } from '@noble/hashes/utils.js';
import { browser } from 'wxt/browser';

import {
  addMoneroKeyRecord,
  getAllMoneroKeyRecords,
  getMoneroKeyRecord,
  getWalletMeta,
  setWalletMeta,
} from './db';
import { unlockWallet } from './algoWallet';
import { unlockSwapShare, listCurrentSwapShares } from './swapShareVault';
import {
  getMoneroKeyMaterialFromPrivateSpendKey,
  getCompleteAddressFromPrivate,
  getPublicKeyFromPrivateScalar,
  computeCombinedAddressWithPrivateAndPublic,
  MoneroNetworkType,
  type MoneroKeyMaterial,
} from './moneroWallet';
import { decryptSeed, encryptSeed } from './seedVault';
import {
  combinedContextStorageKey,
  listCombinedContextBindings,
  loadCombinedContext,
  saveCombinedContext,
  type CombinedAddressBinding,
  type CombinedAddressContext,
} from './combinedAddressContext';

async function verifyCombinedContextOwner(
  context: CombinedAddressContext,
  secret: string,
): Promise<void> {
  const networkType =
    context.network === 'testnet'
      ? MoneroNetworkType.TESTNET
      : context.network === 'stagenet'
        ? MoneroNetworkType.STAGENET
        : MoneroNetworkType.MAINNET;
  const material =
    context.walletId < 0
      ? await unlockSwapShare(context.walletId, secret, context.network)
      : await unlockMoneroWallet(secret, networkType, context.walletId);
  if (!material) throw new Error('The original Monero wallet is required for this saved context.');
  const combined = computeCombinedAddressWithPrivateAndPublic(
    material.privateSpendKey,
    material.privateViewKey,
    context.counterpartyPrivateViewKey,
    context.counterpartyPublicSpendKey,
    networkType,
  );
  if (combined.combinedAddress !== context.combinedAddress) {
    throw new Error(
      'Saved combined address does not match its owner wallet and counterparty keys.',
    );
  }
}

export async function saveMoneroCombinedContext(
  context: CombinedAddressContext,
  secret: string,
): Promise<void> {
  await verifyCombinedContextOwner(context, secret);
  await navigator.locks.request(combinedContextStorageKey(context), () =>
    saveCombinedContext(browser.storage.local, context, secret),
  );
}

export async function loadMoneroCombinedContext(
  binding: CombinedAddressBinding,
  secret: string,
): Promise<CombinedAddressContext | null> {
  const context = await loadCombinedContext(browser.storage.local, binding, secret);
  if (context) await verifyCombinedContextOwner(context, secret);
  return context;
}

export async function listMoneroCombinedContexts(
  walletId: number | null,
  network: CombinedAddressBinding['network'],
  secret: string,
): Promise<CombinedAddressContext[]> {
  await unlockWallet(secret);
  const shares = await listCurrentSwapShares(secret);
  const bindings = (await listCombinedContextBindings(browser.storage.local)).filter(
    (binding) =>
      (binding.walletId === walletId ||
        shares.some((share) => share.walletId === binding.walletId)) &&
      binding.network === network,
  );
  const contexts: CombinedAddressContext[] = [];
  for (const binding of bindings) {
    const context = await loadMoneroCombinedContext(binding, secret);
    if (context) contexts.push(context);
  }
  return contexts;
}

export interface MoneroWalletSummary {
  id: number;
  address: string;
  createdAt: string;
  restoreHeight?: number;
  restoreNetwork?: string;
  scanRestoreHeights?: Record<string, number>;
}

export interface MoneroWalletState {
  wallets: MoneroWalletSummary[];
  activeWalletId: number | null;
}

export async function getMoneroWalletState(): Promise<MoneroWalletState> {
  const meta = await getWalletMeta();
  const records = await getAllMoneroKeyRecords();
  const wallets = records.flatMap((record) =>
    record.id === undefined
      ? []
      : [
          {
            id: record.id,
            address: record.address,
            createdAt: record.createdAt,
            restoreHeight: record.restoreHeight,
            restoreNetwork: record.restoreNetwork,
            scanRestoreHeights: record.scanRestoreHeights,
          },
        ],
  );
  const activeWalletId = wallets.some((wallet) => wallet.id === meta?.activeMoneroKeyId)
    ? (meta?.activeMoneroKeyId ?? null)
    : (wallets[0]?.id ?? null);

  return {
    wallets,
    activeWalletId,
  };
}

export async function saveMoneroWallet(
  material: MoneroKeyMaterial,
  lockSecret: string,
  restoreHeight?: number,
  activate = true,
  restoreNetwork?: string,
  scanRestoreHeights?: Record<string, number>,
): Promise<number> {
  await unlockWallet(lockSecret);
  const privateSpendKeyBytes = hexToBytes(material.privateSpendKey);
  const privateViewKeyBytes = hexToBytes(material.privateViewKey);

  try {
    const vault = await encryptSeed(privateSpendKeyBytes, lockSecret);
    const viewVault = await encryptSeed(privateViewKeyBytes, lockSecret);
    const activeMoneroKeyId = await addMoneroKeyRecord({
      encryptedPrivateSpendKey: vault.encryptedSeed,
      salt: vault.salt,
      iv: vault.iv,
      encryptedPrivateViewKey: viewVault.encryptedSeed,
      viewKeySalt: viewVault.salt,
      viewKeyIv: viewVault.iv,
      address: material.address,
      createdAt: new Date().toISOString(),
      restoreHeight,
      restoreNetwork,
      scanRestoreHeights,
    });
    const meta = await getWalletMeta();
    if (!meta) {
      throw new Error('Wallet metadata is unavailable.');
    }
    if (activate)
      await setWalletMeta({
        ...meta,
        activeMoneroKeyId,
        moneroAddress: material.address,
      });
    return activeMoneroKeyId;
  } finally {
    privateSpendKeyBytes.fill(0);
    privateViewKeyBytes.fill(0);
  }
}

export async function unlockMoneroWallet(
  lockSecret: string,
  networkType: MoneroNetworkType,
  walletId?: number,
): Promise<MoneroKeyMaterial | null> {
  await unlockWallet(lockSecret);
  if (walletId !== undefined && walletId < 0) return unlockSwapShare(walletId, lockSecret);
  const meta = await getWalletMeta();
  const activeMoneroKeyId = walletId ?? meta?.activeMoneroKeyId;
  if (!activeMoneroKeyId) {
    return null;
  }

  const record = await getMoneroKeyRecord(activeMoneroKeyId);
  if (!record) {
    throw new Error('Active Monero key record not found.');
  }

  const decrypted = await decryptSeed(
    record.encryptedPrivateSpendKey,
    lockSecret,
    record.salt,
    record.iv,
  );
  try {
    const material = getMoneroKeyMaterialFromPrivateSpendKey(
      Array.from(decrypted, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      networkType,
    );
    if (record.encryptedPrivateViewKey !== undefined) {
      if (!record.viewKeySalt || !record.viewKeyIv)
        throw new Error('Incomplete encrypted Monero view key.');
      const viewKey = await decryptSeed(
        record.encryptedPrivateViewKey,
        lockSecret,
        record.viewKeySalt,
        record.viewKeyIv,
      );
      try {
        material.privateViewKey = Array.from(viewKey, (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        material.publicViewKey = getPublicKeyFromPrivateScalar(material.privateViewKey);
        material.address = getCompleteAddressFromPrivate(
          material.privateSpendKey,
          material.privateViewKey,
          networkType,
        );
      } finally {
        viewKey.fill(0);
      }
    }
    if (meta && meta.activeMoneroKeyId !== activeMoneroKeyId) {
      await setWalletMeta({
        ...meta,
        activeMoneroKeyId,
        moneroAddress: material.address,
      });
    }
    return material;
  } finally {
    decrypted.fill(0);
  }
}
