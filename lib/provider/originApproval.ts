import { browser } from 'wxt/browser';

// Tracks which page origins the user has explicitly allowed to talk to the
// Zebgen provider, so repeat `connect()` calls don't need a popup each time.
const STORAGE_KEY = 'zebgen:approvedOrigins';

export async function isOriginApproved(origin: string): Promise<boolean> {
  if (!origin) {
    return false;
  }
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const approved = (stored[STORAGE_KEY] as string[] | undefined) ?? [];
  return approved.includes(origin);
}

export async function approveOrigin(origin: string): Promise<void> {
  if (!origin) {
    return;
  }
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const approved = new Set((stored[STORAGE_KEY] as string[] | undefined) ?? []);
  approved.add(origin);
  await browser.storage.local.set({ [STORAGE_KEY]: Array.from(approved) });
}
