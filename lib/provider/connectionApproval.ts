import { browser } from 'wxt/browser';
import { getSignedInState } from '../wallet/algoWallet';
import { getMoneroWalletState } from '../wallet/moneroVault';

export interface ConnectionAccounts {
  algoAddress: string | null;
  moneroAddress: string | null;
  moneroWalletId: number | null;
}

const STORAGE_KEY = 'zebgen:accountConnections:v1';

export async function activeConnectionAccounts(): Promise<ConnectionAccounts> {
  const [algo, monero] = await Promise.all([getSignedInState(), getMoneroWalletState()]);
  const wallet = monero.wallets.find((candidate) => candidate.id === monero.activeWalletId);
  return {
    algoAddress: algo.algoAddress ?? null,
    moneroAddress: wallet?.address ?? null,
    moneroWalletId: wallet?.id ?? null,
  };
}

export function sameConnectionAccounts(
  left: ConnectionAccounts,
  right: ConnectionAccounts,
): boolean {
  return (
    left.algoAddress === right.algoAddress &&
    left.moneroAddress === right.moneroAddress &&
    left.moneroWalletId === right.moneroWalletId
  );
}

export function publicConnectionAccounts(accounts: ConnectionAccounts) {
  return { algoAddress: accounts.algoAddress, moneroAddress: accounts.moneroAddress };
}

export async function connectedAccounts(origin: string): Promise<ConnectionAccounts | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as Record<string, ConnectionAccounts> | undefined)?.[origin] ?? null;
}

export async function approveConnection(
  origin: string,
  accounts: ConnectionAccounts,
): Promise<void> {
  if (!origin || !sameConnectionAccounts(accounts, await activeConnectionAccounts())) {
    throw new Error('Active accounts changed. Connect again and review the addresses.');
  }
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const connections = (stored[STORAGE_KEY] as Record<string, ConnectionAccounts> | undefined) ?? {};
  await browser.storage.local.set({ [STORAGE_KEY]: { ...connections, [origin]: accounts } });
}

export async function assertConnectionAccounts(
  origin: string,
  params: unknown,
  expected?: ConnectionAccounts,
): Promise<void> {
  const approved = await connectedAccounts(origin);
  if (!approved) {
    throw new Error(
      'No account connection is approved for this site. Close this request, connect on the swap page, and approve the address-sharing prompt.',
    );
  }
  if (expected && !sameConnectionAccounts(approved, expected)) {
    throw new Error(
      'The connected accounts changed after this request opened. Close this request and start it again from the swap page.',
    );
  }
  const active = await activeConnectionAccounts();
  if (!sameConnectionAccounts(approved, active)) {
    const changed = [
      approved.algoAddress !== active.algoAddress ? 'Algorand account' : null,
      approved.moneroAddress !== active.moneroAddress ||
      approved.moneroWalletId !== active.moneroWalletId
        ? 'Monero wallet'
        : null,
    ]
      .filter(Boolean)
      .join(' and ');
    throw new Error(
      `The active ${changed} differs from the connection approved for this site. Connect again and approve the active accounts before starting a new request.`,
    );
  }
  const requested = params as { addressIndex?: number; moneroWalletId?: number } | null;
  if (
    (requested?.addressIndex !== undefined && requested.addressIndex !== 0) ||
    (requested?.moneroWalletId !== undefined &&
      requested.moneroWalletId !== approved.moneroWalletId)
  ) {
    throw new Error(
      'This request uses an account other than the connected active accounts. Select accounts in Zebgen and connect again.',
    );
  }
}
