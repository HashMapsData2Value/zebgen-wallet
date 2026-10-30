import { getAllSeedRecords, getWalletMeta, setWalletMeta } from '../wallet/db';
import { getMoneroWalletState } from '../wallet/moneroVault';
import { activeConnectionAccounts, type ConnectionAccounts } from './connectionApproval';

export interface ConnectionChoices {
  algo: { id: number; address: string }[];
  monero: { id: number; address: string }[];
}

export async function connectionChoices(): Promise<ConnectionChoices> {
  const [seeds, monero, meta] = await Promise.all([
    getAllSeedRecords(),
    getMoneroWalletState(),
    getWalletMeta(),
  ]);
  return {
    algo: seeds.flatMap((seed) =>
      seed.id === undefined || seed.id !== meta?.activeSeedId
        ? []
        : [{ id: seed.id, address: seed.algoAddress }],
    ),
    monero: monero.wallets.map((wallet) => ({ id: wallet.id, address: wallet.address })),
  };
}

export async function activateConnectionSelection(accounts: ConnectionAccounts): Promise<void> {
  await navigator.locks.request('zebgen:connectionSelection', async () => {
    const choices = await connectionChoices();
    const algo = choices.algo.find((wallet) => wallet.address === accounts.algoAddress);
    const monero = choices.monero.find(
      (wallet) =>
        wallet.id === accounts.moneroWalletId && wallet.address === accounts.moneroAddress,
    );
    if (
      (!algo && (accounts.algoAddress !== null || choices.algo.length > 0)) ||
      (!monero &&
        (accounts.moneroAddress !== null ||
          accounts.moneroWalletId !== null ||
          choices.monero.length > 0))
    ) {
      throw new Error(
        'Selected wallets are no longer available. Connect again and choose your wallets.',
      );
    }
    const meta = await getWalletMeta();
    if (!meta) {
      const active = await activeConnectionAccounts();
      if (active.algoAddress || active.moneroAddress)
        throw new Error('Wallet metadata is unavailable.');
      return;
    }
    if (algo && meta.activeSeedId !== algo.id) {
      throw new Error('Active Algorand mnemonic changed. Connect again from the active wallet.');
    }
    await setWalletMeta({
      ...meta,
      activeSeedId: algo?.id ?? null,
      algoAddress: algo?.address ?? null,
      activeMoneroKeyId: monero?.id ?? null,
      moneroAddress: monero?.address ?? null,
    });
  });
}
