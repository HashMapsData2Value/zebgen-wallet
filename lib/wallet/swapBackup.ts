import { decryptSeed, encryptSeed } from './seedVault.ts';
import type { ContextStorage } from './combinedAddressContext.ts';

const FORMAT = 'zebgen-swap-backup';
export const MAX_SWAP_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 500;
const PREFIXES = [
  'leakswapShare:', 'leakswapHandshake:', 'moneroCombinedContext:', 'leakswapRecord:',
  'leakswapSettlementEvidence:', 'signedAlgoTransaction:', 'leakswapAgreementUse:',
  'leakSwapDepositAttempt:', 'moneroOutgoingActivity:', 'leakswapSingleUseKey:',
];

function allowedKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 2048 && PREFIXES.some(prefix => key.startsWith(prefix) && key.length > prefix.length);
}

interface Envelope { version: 1; ciphertext: number[]; salt: number[]; iv: number[] }

function validateEnvelope(value: unknown): asserts value is Envelope {
  const envelope = value as Envelope | null;
  const bytes = (input: unknown): input is number[] => Array.isArray(input)
    && input.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (!envelope || envelope.version !== 1 || !bytes(envelope.ciphertext) || envelope.ciphertext.length < 16
    || envelope.ciphertext.length > MAX_SWAP_BACKUP_BYTES || !bytes(envelope.salt) || envelope.salt.length !== 16
    || !bytes(envelope.iv) || envelope.iv.length !== 12) throw new Error('Invalid encrypted swap backup record.');
}

async function seal(value: unknown, secret: string): Promise<Envelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    const encrypted = await encryptSeed(plaintext, secret);
    return { version: 1, ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)), salt: Array.from(encrypted.salt), iv: Array.from(encrypted.iv) };
  } finally { plaintext.fill(0); }
}

async function open(value: unknown, secret: string): Promise<unknown> {
  validateEnvelope(value);
  const plaintext = await decryptSeed(new Uint8Array(value.ciphertext).buffer, secret, new Uint8Array(value.salt), new Uint8Array(value.iv));
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); }
  finally { plaintext.fill(0); }
}

function validateEntry(key: unknown, value: unknown): asserts key is string {
  if (!allowedKey(key)) throw new Error('Unsupported record in swap backup.');
  if (key.startsWith('leakswapSingleUseKey:')) {
    if (!/^leakswapSingleUseKey:[0-9a-f]{64}$/.test(key) || typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error('Invalid swap key reservation.');
    }
  } else {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid swap backup record.');
    const record = value as Record<string, unknown>;
    if (key.startsWith('moneroOutgoingActivity:') || key.startsWith('leakSwapDepositAttempt:')) {
      if (typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(record.hash)
        || typeof record.amountAtomic !== 'string' || !/^\d+$/.test(record.amountAtomic)
        || typeof record.feeAtomic !== 'string' || !/^\d+$/.test(record.feeAtomic)
        || !['relaying', 'submitted', 'unknown'].includes(record.state as string)) throw new Error('Invalid backed-up payment journal.');
    } else if (key.startsWith('leakswapSettlementEvidence:')) {
      if (typeof record.txId !== 'string' || !/^[A-Z2-7]{52}$/.test(record.txId)
        || typeof record.confirmedRound !== 'string' || !/^[1-9][0-9]*$/.test(record.confirmedRound)
        || typeof record.transaction !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.transaction)) throw new Error('Invalid backed-up settlement evidence.');
    } else if (record.version !== 1) throw new Error('Invalid swap backup record version.');
  }
}

export async function exportSwapBackup(storage: ContextStorage, walletSecret: string, backupPassword: string): Promise<string> {
  if (backupPassword.trim().length < 12) throw new Error('Use at least 12 characters for the backup password.');
  const stored = await storage.get(null);
  const keys = Object.keys(stored).filter(allowedKey).sort();
  if (!keys.some(key => key.startsWith('leakswapShare:'))) throw new Error('No dedicated swap shares are available to back up.');
  if (keys.length > MAX_RECORDS) throw new Error('Too many swap records for this backup format.');
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const value = key.startsWith('leakswapSingleUseKey:') ? stored[key] : await open(stored[key], walletSecret);
    validateEntry(key, value);
    entries.push([key, value]);
  }
  const payload = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), entries };
  if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_SWAP_BACKUP_BYTES / 4) throw new Error('Swap backup is too large.');
  return JSON.stringify({ format: FORMAT, version: 1, kdf: 'PBKDF2-SHA256-600000', envelope: await seal(payload, backupPassword) });
}

export async function restoreSwapBackup(storage: ContextStorage, text: string, backupPassword: string, walletSecret: string): Promise<number> {
  if (new TextEncoder().encode(text).length > MAX_SWAP_BACKUP_BYTES) throw new Error('Swap backup is too large.');
  const file = JSON.parse(text);
  if (!file || file.format !== FORMAT || file.version !== 1 || file.kdf !== 'PBKDF2-SHA256-600000') throw new Error('Unsupported swap backup format.');
  const payload = await open(file.envelope, backupPassword) as { format?: unknown; version?: unknown; entries?: unknown } | null;
  if (!payload || payload.format !== FORMAT || payload.version !== 1 || !Array.isArray(payload.entries)
    || !payload.entries.length || payload.entries.length > MAX_RECORDS) throw new Error('Invalid swap backup contents.');
  const restored: Record<string, unknown> = {};
  for (const entry of payload.entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid swap backup entry.');
    const [key, value] = entry;
    validateEntry(key, value);
    if (Object.hasOwn(restored, key)) throw new Error('Duplicate swap backup entry.');
    restored[key] = key.startsWith('leakswapSingleUseKey:') ? value : await seal(value, walletSecret);
  }
  if (!Object.keys(restored).some(key => key.startsWith('leakswapShare:'))) throw new Error('Backup contains no dedicated swap shares.');
  return navigator.locks.request('leakswap-backup-restore', async () => {
    if (Object.keys(await storage.get(null)).some(allowedKey)) throw new Error('Restore requires an empty swap store. Existing swap records will not be overwritten.');
    await storage.set(restored);
    return Object.keys(restored).length;
  });
}