import { browser } from 'wxt/browser';
import { decryptSeed, encryptSeed } from './seedVault';

export async function scanCheckpointStorageKey(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `moneroScan:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function loadScanCheckpoint(
  identity: string,
  secret: string,
): Promise<unknown | undefined> {
  const key = await scanCheckpointStorageKey(identity);
  const envelope = (await browser.storage.local.get(key))[key] as
    | { version: number; ciphertext: number[]; salt: number[]; iv: number[] }
    | undefined;
  if (envelope === undefined) return undefined;
  const bytes = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (
    !envelope ||
    envelope.version !== 1 ||
    !bytes(envelope.ciphertext) ||
    envelope.ciphertext.length < 16 ||
    !bytes(envelope.salt) ||
    envelope.salt.length !== 16 ||
    !bytes(envelope.iv) ||
    envelope.iv.length !== 12
  )
    throw new Error('Invalid Monero scan checkpoint.');
  const plaintext = await decryptSeed(
    new Uint8Array(envelope.ciphertext).buffer,
    secret,
    new Uint8Array(envelope.salt),
    new Uint8Array(envelope.iv),
  );
  try {
    const record = JSON.parse(new TextDecoder().decode(plaintext));
    if (record.identity !== identity || record.version !== 1)
      throw new Error('Monero scan checkpoint identity mismatch.');
    return record.checkpoint;
  } finally {
    plaintext.fill(0);
  }
}

export async function saveScanCheckpoint(
  identity: string,
  checkpoint: unknown,
  secret: string,
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, identity, checkpoint }));
  try {
    const encrypted = await encryptSeed(plaintext, secret);
    await browser.storage.local.set({
      [await scanCheckpointStorageKey(identity)]: {
        version: 1,
        ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
        salt: Array.from(encrypted.salt),
        iv: Array.from(encrypted.iv),
      },
    });
  } finally {
    plaintext.fill(0);
  }
}
