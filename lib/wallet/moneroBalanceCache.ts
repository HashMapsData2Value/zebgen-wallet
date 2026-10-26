import { browser } from 'wxt/browser';
import { decryptSeed, encryptSeed } from './seedVault';

export interface MoneroBalanceCheckpoint {
  balanceAtomic: string;
  lockedAtomic?: string;
  unlocks?: MoneroUnlock[];
  spans?: ScanSpan[];
  scannedHeight: number;
  scannedAt: number;
  resumable?: true;
}

export interface ScanSpan {
  start: number;
  end: number;
}

export interface MoneroUnlock {
  height: number | null;
  amountAtomic: string;
}

export function moneroUnlocks(value: unknown): MoneroUnlock[] {
  if (!Array.isArray(value)) throw new Error('Invalid Monero unlock schedule.');
  return value.map((unlock) => {
    if (
      !unlock ||
      (unlock.height !== null && (!Number.isSafeInteger(unlock.height) || unlock.height < 0)) ||
      typeof unlock.amountAtomic !== 'string' ||
      !/^\d+$/.test(unlock.amountAtomic)
    )
      throw new Error('Invalid Monero unlock schedule.');
    return { height: unlock.height, amountAtomic: unlock.amountAtomic };
  });
}

export function scanSpans(value: unknown): ScanSpan[] {
  if (!Array.isArray(value)) throw new Error('Invalid Monero scan spans.');
  let previousEnd = -1;
  return value.map((span) => {
    if (
      !span ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.start >= span.end ||
      span.start <= previousEnd
    )
      throw new Error('Invalid Monero scan spans.');
    previousEnd = span.end;
    return { start: span.start, end: span.end };
  });
}

export function coverageCheckpointKey(network: string, daemon: string, address: string): string {
  return `${balanceCheckpointKey(network, daemon, address, 0)}:coverage-v2`;
}

export function unscannedSpans(spans: ScanSpan[], end: number): ScanSpan[] {
  const gaps: ScanSpan[] = [];
  let start = 0;
  for (const span of spans) {
    if (span.start > start) gaps.push({ start, end: Math.min(span.start, end) });
    start = Math.max(start, span.end);
    if (start >= end) break;
  }
  if (start < end) gaps.push({ start, end });
  return gaps.filter((span) => span.start < span.end);
}

export function balanceCheckpointKey(
  network: string,
  daemon: string,
  address: string,
  restoreHeight: number,
): string {
  const endpoint = new URL(daemon);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.hash = '';
  endpoint.search = '';
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  return `moneroBalance:${JSON.stringify([network, endpoint.href, address, restoreHeight])}`;
}

async function storageKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return (
    'moneroBalance:' +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

function metadata(value: unknown): MoneroBalanceCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid saved Monero balance checkpoint.');
  }
  const checkpoint = value as Partial<MoneroBalanceCheckpoint>;
  if (
    typeof checkpoint.balanceAtomic !== 'string' ||
    !/^\d+$/.test(checkpoint.balanceAtomic) ||
    typeof checkpoint.scannedHeight !== 'number' ||
    !Number.isSafeInteger(checkpoint.scannedHeight) ||
    checkpoint.scannedHeight < 0 ||
    typeof checkpoint.scannedAt !== 'number' ||
    !Number.isSafeInteger(checkpoint.scannedAt) ||
    checkpoint.scannedAt < 0
  ) {
    throw new Error('Invalid saved Monero balance checkpoint.');
  }
  return {
    balanceAtomic: checkpoint.balanceAtomic,
    ...(checkpoint.lockedAtomic !== undefined
      ? {
          lockedAtomic: (() => {
            if (
              typeof checkpoint.lockedAtomic !== 'string' ||
              !/^\d+$/.test(checkpoint.lockedAtomic)
            )
              throw new Error('Invalid saved Monero locked balance.');
            return checkpoint.lockedAtomic;
          })(),
        }
      : {}),
    ...(checkpoint.spans !== undefined ? { spans: scanSpans(checkpoint.spans) } : {}),
    ...(checkpoint.unlocks !== undefined ? { unlocks: moneroUnlocks(checkpoint.unlocks) } : {}),
    scannedHeight: checkpoint.scannedHeight,
    scannedAt: checkpoint.scannedAt,
    ...(checkpoint.resumable === true ? { resumable: true as const } : {}),
  };
}

function bytes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    Array.from(value).every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

export async function saveBalanceCheckpoint(
  key: string,
  checkpoint: MoneroBalanceCheckpoint,
  secret: string,
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify(metadata(checkpoint)));
  try {
    const encrypted = await encryptSeed(plaintext, secret);
    await browser.storage.local.set({
      [await storageKey(key)]: {
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

export async function loadBalanceCheckpoint(
  key: string,
  secret: string,
): Promise<MoneroBalanceCheckpoint | null> {
  const persistedKey = await storageKey(key);
  const stored = (await browser.storage.local.get(persistedKey))[persistedKey] as
    | { version: number; ciphertext: number[]; salt: number[]; iv: number[] }
    | undefined;
  if (stored === undefined) return null;
  if (
    !stored ||
    stored.version !== 1 ||
    !bytes(stored.ciphertext) ||
    stored.ciphertext.length < 16 ||
    !bytes(stored.salt) ||
    stored.salt.length !== 16 ||
    !bytes(stored.iv) ||
    stored.iv.length !== 12
  ) {
    throw new Error('Invalid saved Monero balance envelope.');
  }
  const plaintext = await decryptSeed(
    new Uint8Array(stored.ciphertext).buffer,
    secret,
    new Uint8Array(stored.salt),
    new Uint8Array(stored.iv),
  );
  try {
    return metadata(JSON.parse(new TextDecoder().decode(plaintext)));
  } finally {
    plaintext.fill(0);
  }
}
