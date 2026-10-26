import { decryptSeed, encryptSeed } from './seedVault';
import type { ActivityStorage } from './moneroActivity';

export interface DepositBinding {
  agreementDigest: string;
  appId: string;
  genesisHash: string;
  moneroNetwork: string;
}

export interface DepositAttempt {
  binding: DepositBinding;
  hash: string;
  amountAtomic: string;
  feeAtomic: string;
  state: 'relaying' | 'submitted' | 'unknown';
}

async function attemptKey(binding: DepositBinding): Promise<string> {
  const identity = JSON.stringify([
    binding.agreementDigest.toLowerCase(),
    binding.appId,
    binding.genesisHash,
    binding.moneroNetwork,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return (
    'leakSwapDepositAttempt:' +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

export async function loadDepositAttempt(
  storage: ActivityStorage,
  binding: DepositBinding,
  secret: string,
): Promise<DepositAttempt | null> {
  const key = await attemptKey(binding);
  const record = (await storage.get(key))[key] as
    | { version: number; ciphertext: number[]; salt: number[]; iv: number[] }
    | undefined;
  if (record === undefined) return null;
  if (
    record.version !== 1 ||
    !Array.isArray(record.ciphertext) ||
    !Array.isArray(record.salt) ||
    !Array.isArray(record.iv)
  ) {
    throw new Error('Invalid deposit attempt journal. Do not deposit again.');
  }
  const plaintext = await decryptSeed(
    new Uint8Array(record.ciphertext).buffer,
    secret,
    new Uint8Array(record.salt),
    new Uint8Array(record.iv),
  );
  try {
    const attempt = JSON.parse(new TextDecoder().decode(plaintext)) as DepositAttempt;
    if (
      (await attemptKey(attempt.binding)) !== key ||
      !/^[a-f0-9]{64}$/i.test(attempt.hash) ||
      !/^\d+$/.test(attempt.amountAtomic) ||
      !/^\d+$/.test(attempt.feeAtomic) ||
      !['relaying', 'submitted', 'unknown'].includes(attempt.state)
    )
      throw new Error('Invalid deposit attempt journal. Do not deposit again.');
    return attempt;
  } finally {
    plaintext.fill(0);
  }
}

async function save(
  storage: ActivityStorage,
  attempt: DepositAttempt,
  secret: string,
): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify(attempt));
  try {
    const encrypted = await encryptSeed(plaintext, secret);
    await storage.set({
      [await attemptKey(attempt.binding)]: {
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

export async function reserveDepositAttempt(
  storage: ActivityStorage,
  attempt: DepositAttempt,
  secret: string,
): Promise<DepositAttempt | null> {
  const key = await attemptKey(attempt.binding);
  return navigator.locks.request(key, async () => {
    const existing = await loadDepositAttempt(storage, attempt.binding, secret);
    if (existing) return existing;
    await save(storage, attempt, secret);
    return null;
  });
}

export async function updateDepositAttempt(
  storage: ActivityStorage,
  attempt: DepositAttempt,
  secret: string,
): Promise<void> {
  const key = await attemptKey(attempt.binding);
  await navigator.locks.request(key, async () => {
    const existing = await loadDepositAttempt(storage, attempt.binding, secret);
    if (!existing || existing.hash !== attempt.hash)
      throw new Error('Deposit reservation mismatch. Do not deposit again.');
    await save(storage, attempt, secret);
  });
}
