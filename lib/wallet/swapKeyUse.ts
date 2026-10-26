export interface SwapKeyUseStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

export async function reserveSwapKey(storage: SwapKeyUseStorage, publicSpendKey: string, digest: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(publicSpendKey) || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid swap key reservation.');
  const keyHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicSpendKey))),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `leakswapSingleUseKey:${keyHash}`;
  const previous = (await storage.get(key))[key];
  if (previous !== undefined && previous !== digest) throw new Error('These Monero keys are already reserved for another swap. Select a fresh dedicated Monero wallet in Zebgen.');
  if (previous === undefined) await storage.set({ [key]: digest });
}