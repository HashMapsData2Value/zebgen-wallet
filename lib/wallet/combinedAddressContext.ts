import type { MoneroNetworkId } from '../network/networks';
import { decryptSeed, encryptSeed } from './seedVault.ts';

export interface CombinedAddressBinding {
  walletId: number;
  network: MoneroNetworkId;
  combinedAddress: string;
}

export interface CombinedAddressContext extends CombinedAddressBinding {
  version: 1;
  counterpartyPublicSpendKey: string;
  counterpartyPrivateViewKey: string;
  restoreHeight: number;
}

export interface ContextStorage {
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<unknown>;
}

const PREFIX = 'moneroCombinedContext:';
const KEY_PATTERN = /^[0-9a-f]{64}$/i;

export function combinedContextStorageKey(binding: CombinedAddressBinding): string {
  if (!Number.isSafeInteger(binding.walletId) || binding.walletId === 0
    || !['mainnet', 'testnet', 'stagenet', 'regtest'].includes(binding.network)
    || !/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(binding.combinedAddress)) {
    throw new Error('Invalid combined-address context metadata.');
  }
  return PREFIX + JSON.stringify([binding.walletId, binding.network, binding.combinedAddress]);
}

export function validateCombinedContext(value: unknown, binding: CombinedAddressBinding): asserts value is CombinedAddressContext {
  combinedContextStorageKey(binding);
  const context = value as CombinedAddressContext | null;
  if (!context || context.version !== 1 || context.walletId !== binding.walletId
    || context.network !== binding.network || context.combinedAddress !== binding.combinedAddress
    || typeof context.counterpartyPublicSpendKey !== 'string' || !KEY_PATTERN.test(context.counterpartyPublicSpendKey)
    || typeof context.counterpartyPrivateViewKey !== 'string' || !KEY_PATTERN.test(context.counterpartyPrivateViewKey)
    || !Number.isInteger(context.restoreHeight) || context.restoreHeight < 0 || context.restoreHeight > 0xffffffff) {
    throw new Error('Invalid or mismatched combined-address context.');
  }
}

export async function loadCombinedContext(storage: ContextStorage, binding: CombinedAddressBinding, secret: string): Promise<CombinedAddressContext | null> {
  const key = combinedContextStorageKey(binding);
  const record = (await storage.get(key))[key];
  if (record === undefined) return null;
  const encrypted = record as { version: number; ciphertext: number[]; salt: number[]; iv: number[] };
  const validBytes = (value: unknown): value is number[] => Array.isArray(value)
    && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (!encrypted || encrypted.version !== 1 || !validBytes(encrypted.ciphertext)
    || !validBytes(encrypted.salt) || encrypted.salt.length !== 16
    || !validBytes(encrypted.iv) || encrypted.iv.length !== 12) {
    throw new Error('Invalid encrypted combined-address context.');
  }
  const decrypted = await decryptSeed(new Uint8Array(encrypted.ciphertext).buffer, secret,
    new Uint8Array(encrypted.salt), new Uint8Array(encrypted.iv));
  try {
    const context: unknown = JSON.parse(new TextDecoder().decode(decrypted));
    validateCombinedContext(context, binding);
    return context;
  } finally {
    decrypted.fill(0);
  }
}

export async function saveCombinedContext(storage: ContextStorage, context: CombinedAddressContext, secret: string): Promise<void> {
  validateCombinedContext(context, context);
  const previous = await loadCombinedContext(storage, context, secret);
  if (previous && (previous.counterpartyPrivateViewKey.toLowerCase() !== context.counterpartyPrivateViewKey.toLowerCase()
    || previous.counterpartyPublicSpendKey.toLowerCase() !== context.counterpartyPublicSpendKey.toLowerCase())) {
    throw new Error('Counterparty keys do not match the saved combined-address context.');
  }
  const saved: CombinedAddressContext = {
    version: 1,
    walletId: context.walletId,
    network: context.network,
    combinedAddress: context.combinedAddress,
    counterpartyPublicSpendKey: context.counterpartyPublicSpendKey.toLowerCase(),
    counterpartyPrivateViewKey: context.counterpartyPrivateViewKey.toLowerCase(),
    restoreHeight: Math.min(previous?.restoreHeight ?? context.restoreHeight, context.restoreHeight),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(saved));
  try {
    const encrypted = await encryptSeed(plaintext, secret);
    await storage.set({
      [combinedContextStorageKey(context)]: {
        version: 1,
        ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
        salt: Array.from(encrypted.salt),
        iv: Array.from(encrypted.iv),
      }
    });
  } finally {
    plaintext.fill(0);
  }
}

export async function listCombinedContextBindings(storage: ContextStorage): Promise<CombinedAddressBinding[]> {
  return Object.keys(await storage.get(null)).filter((key) => key.startsWith(PREFIX)).map((key) => {
    const [walletId, network, combinedAddress] = JSON.parse(key.slice(PREFIX.length));
    const binding = { walletId, network, combinedAddress };
    if (combinedContextStorageKey(binding) !== key) throw new Error('Invalid combined-address context index.');
    return binding;
  });
}