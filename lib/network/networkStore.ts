import { browser } from 'wxt/browser';

import { DEFAULT_NETWORK_SETTINGS, type NetworkSettings } from './networks';

const STORAGE_KEY = 'zebgen:networkSettings';

export async function getNetworkSettings(): Promise<NetworkSettings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as NetworkSettings | undefined;
  if (!value) {
    return structuredClone(DEFAULT_NETWORK_SETTINGS);
  }
  return value;
}

export async function saveNetworkSettings(settings: NetworkSettings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: settings });
}
