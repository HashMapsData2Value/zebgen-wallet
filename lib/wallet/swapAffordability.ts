import { getMoneroWalletState, unlockMoneroWallet } from './moneroVault';
import { scanMoneroBalance, type MoneroFundingControl } from '../monero/moneroDaemon';
import type { MoneroNetworkConfig } from '../network/networks';
import { formatAtomic } from './formatAtomic';
import { walletRestoreHeight } from '../monero/scanHeight';

export const SWAP_ACCEPTANCE_FEE_ALLOWANCE_ATOMIC = 1_000_000_000n;

export async function assertSwapAffordability(
  config: MoneroNetworkConfig,
  amountAtomic: string,
  secret: string,
  control?: MoneroFundingControl,
): Promise<void> {
  control?.signal?.throwIfAborted();
  const state = await getMoneroWalletState();
  const wallet = state.wallets.find((candidate) => candidate.id === state.activeWalletId);
  if (!wallet || !Number.isSafeInteger(wallet.id) || wallet.id < 0)
    throw new Error('Select a normal Monero funding wallet before accepting this swap.');
  const material = await unlockMoneroWallet(secret, config.networkType, wallet.id);
  if (!material) throw new Error('Unable to unlock the Monero funding wallet.');
  const request = {
    config,
    walletId: wallet.id,
    lockSecret: secret,
    primaryAddress: material.address,
    restoreHeight: walletRestoreHeight(wallet, config.network),
  };
  const balance = await scanMoneroBalance(request, control);
  control?.signal?.throwIfAborted();
  if (!balance.ok || balance.balanceAtomic === undefined)
    throw new Error(`Cannot verify XMR funding: ${balance.error ?? 'balance unavailable'}`);
  if (BigInt(balance.balanceAtomic) < BigInt(amountAtomic) + SWAP_ACCEPTANCE_FEE_ALLOWANCE_ATOMIC) {
    throw new Error(
      `Cannot accept: this wallet has ${formatAtomic(balance.balanceAtomic, 12)} unlocked XMR, but the swap requires ${formatAtomic(amountAtomic, 12)} XMR plus a preliminary ${formatAtomic(SWAP_ACCEPTANCE_FEE_ALLOWANCE_ATOMIC.toString(), 12)} XMR network fee allowance. Fund the wallet or agree on a smaller amount.`,
    );
  }
  const current = await getMoneroWalletState();
  control?.signal?.throwIfAborted();
  if (current.activeWalletId !== wallet.id)
    throw new Error('Funding wallet changed. Review the invitation again.');
}
