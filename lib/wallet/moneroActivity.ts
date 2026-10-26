import type { MoneroNetworkConfig } from '../network/networks';
import { decryptSeed, encryptSeed } from './seedVault';

export interface ActivityScope {
  address: string;
  network: MoneroNetworkConfig['network'];
  daemon: string;
}

export interface MoneroActivity extends ActivityScope {
  hash: string;
  amountAtomic: string;
  feeAtomic: string;
  createdAt: number;
  state: 'relaying' | 'submitted' | 'unknown';
}

export interface ActivityStorage {
  get(key: null | string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<unknown>;
}

export const MONERO_ACTIVITY_PREFIX = 'moneroOutgoingActivity:';

export function activityScope(address: string, config: MoneroNetworkConfig): ActivityScope {
  const daemon = new URL(config.daemon.uri);
  daemon.username = '';
  daemon.password = '';
  daemon.hash = '';
  daemon.search = '';
  daemon.pathname = daemon.pathname.replace(/\/+$/, '');
  return { address, network: config.network, daemon: daemon.href };
}

async function digestKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function scopePrefix(scope: ActivityScope): Promise<string> {
  return (
    MONERO_ACTIVITY_PREFIX +
    (await digestKey(JSON.stringify([scope.address, scope.network, scope.daemon]))) +
    ':'
  );
}

function metadata(value: MoneroActivity): MoneroActivity {
  if (
    !/^[0-9a-f]{64}$/i.test(value.hash) ||
    !/^\d+$/.test(value.amountAtomic) ||
    !/^\d+$/.test(value.feeAtomic) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !['relaying', 'submitted', 'unknown'].includes(value.state) ||
    typeof value.address !== 'string' ||
    !value.address ||
    !['mainnet', 'testnet', 'stagenet', 'regtest'].includes(value.network) ||
    typeof value.daemon !== 'string'
  )
    throw new Error('Invalid outgoing Monero activity.');
  return {
    address: value.address,
    network: value.network,
    daemon: value.daemon,
    hash: value.hash.toLowerCase(),
    amountAtomic: value.amountAtomic,
    feeAtomic: value.feeAtomic,
    createdAt: value.createdAt,
    state: value.state,
  };
}

export async function saveMoneroActivity(
  storage: ActivityStorage,
  activity: MoneroActivity,
  secret: string,
): Promise<void> {
  const saved = metadata(activity);
  const key = (await scopePrefix(saved)) + (await digestKey(saved.hash));
  const plaintext = new TextEncoder().encode(JSON.stringify(saved));
  try {
    const encrypted = await encryptSeed(plaintext, secret);
    await storage.set({
      [key]: {
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

export async function loadMoneroActivity(
  storage: ActivityStorage,
  scope: ActivityScope,
  secret: string,
): Promise<MoneroActivity[]> {
  const prefix = await scopePrefix(scope);
  const records = await storage.get(null);
  const activities = await Promise.all(
    Object.entries(records)
      .filter(([key]) => key.startsWith(prefix))
      .map(async ([key, record]) => {
        const envelope = record as {
          version: number;
          ciphertext: number[];
          salt: number[];
          iv: number[];
        };
        const bytes = (value: unknown): value is number[] =>
          Array.isArray(value) &&
          value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
        if (
          !envelope ||
          envelope.version !== 1 ||
          !bytes(envelope.ciphertext) ||
          !bytes(envelope.salt) ||
          envelope.salt.length !== 16 ||
          !bytes(envelope.iv) ||
          envelope.iv.length !== 12
        ) {
          throw new Error('Invalid encrypted outgoing Monero activity.');
        }
        const plaintext = await decryptSeed(
          new Uint8Array(envelope.ciphertext).buffer,
          secret,
          new Uint8Array(envelope.salt),
          new Uint8Array(envelope.iv),
        );
        try {
          const activity = metadata(JSON.parse(new TextDecoder().decode(plaintext)));
          if (
            activity.address !== scope.address ||
            activity.network !== scope.network ||
            activity.daemon !== scope.daemon ||
            key !== prefix + (await digestKey(activity.hash))
          )
            throw new Error('Outgoing Monero activity scope mismatch.');
          return activity;
        } finally {
          plaintext.fill(0);
        }
      }),
  );
  return activities.sort((first, second) => second.createdAt - first.createdAt);
}
