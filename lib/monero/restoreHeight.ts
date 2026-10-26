import { browser } from 'wxt/browser';

import { probeMoneroDaemonViaBackground } from '../network/messages';
import { cloneMoneroPreset, MONERO_NETWORK_IDS, type MoneroNetworkConfig } from '../network/networks';

// Blocks subtracted from the chain tip when recording a restore height, to cover small
// reorgs and a node that is slightly behind. Scanning a few extra blocks costs little;
// starting one block too late would miss funds.
const SAFETY_MARGIN_BLOCKS = 20;

const SWAP_HEIGHTS_KEY = 'moneroSwapAddressRestoreHeights';

/** Current chain height minus a safety margin, or undefined if the node is unreachable. */
export async function currentRestoreHeight(config: MoneroNetworkConfig): Promise<number | undefined> {
  try {
    const probe = await probeMoneroDaemonViaBackground(config);
    if (!probe.ok || probe.height === undefined) {
      throw new Error(probe.error ?? 'no height returned');
    }
    return Math.max(0, probe.height - SAFETY_MARGIN_BLOCKS);
  } catch (err) {
    console.error('Could not read the Monero chain height; no restore height recorded.', err);
    return undefined;
  }
}

export async function generatedWalletRestoreHeights(config: MoneroNetworkConfig, height: number): Promise<Record<string, number>> {
  const heights: Record<string, number> = { [config.network]: height };
  await Promise.all(MONERO_NETWORK_IDS.filter(network => network !== config.network && network !== 'regtest').map(async network => {
    const restoreHeight = await currentRestoreHeight(cloneMoneroPreset(network));
    if (restoreHeight !== undefined) heights[network] = restoreHeight;
  }));
  return heights;
}

async function readSwapHeights(): Promise<Record<string, number>> {
  const stored = await browser.storage.local.get(SWAP_HEIGHTS_KEY);
  return (stored[SWAP_HEIGHTS_KEY] as Record<string, number> | undefined) ?? {};
}

/** Records when a swap's combined address was created; keeps the earliest height seen. */
export async function rememberSwapAddressHeight(address: string, height: number): Promise<void> {
  const heights = await readSwapHeights();
  if (heights[address] !== undefined && heights[address] <= height) {
    return;
  }
  await browser.storage.local.set({ [SWAP_HEIGHTS_KEY]: { ...heights, [address]: height } });
}

export async function swapAddressHeight(address: string): Promise<number | undefined> {
  return (await readSwapHeights())[address];
}
