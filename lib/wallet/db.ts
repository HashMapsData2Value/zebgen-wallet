import { openDB, type DBSchema } from 'idb';

export interface SeedRecord {
  id?: number;
  encryptedSeed: ArrayBuffer;
  salt: Uint8Array;
  iv: Uint8Array;
  encryptedMnemonic?: ArrayBuffer;
  mnemonicSalt?: Uint8Array;
  mnemonicIv?: Uint8Array;
  algoAddress: string;
  createdAt: string;
  derivedAddresses?: Record<string, string>;
}

export interface MoneroKeyRecord {
  id?: number;
  encryptedPrivateSpendKey: ArrayBuffer;
  salt: Uint8Array;
  iv: Uint8Array;
  encryptedPrivateViewKey?: ArrayBuffer;
  viewKeySalt?: Uint8Array;
  viewKeyIv?: Uint8Array;
  address: string;
  createdAt: string;
  // First block that can hold this wallet's funds; absent for imported wallets.
  restoreHeight?: number;
  restoreNetwork?: string;
  scanRestoreHeights?: Record<string, number>;
}

export interface WalletMeta {
  activeSeedId: number | null;
  algoAddress: string | null;
  activeMoneroKeyId?: number | null;
  moneroAddress?: string | null;
  lockSalt?: Uint8Array;
  lockVerifier?: Uint8Array;
}

interface ZebgenDB extends DBSchema {
  app: {
    key: string;
    value: WalletMeta;
  };
  seeds: {
    key: number;
    value: SeedRecord;
  };
  moneroKeys: {
    key: number;
    value: MoneroKeyRecord;
  };
}

const dbPromise = openDB<ZebgenDB>('zebgen-wallet', 2, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('app')) {
      db.createObjectStore('app');
    }
    if (!db.objectStoreNames.contains('seeds')) {
      db.createObjectStore('seeds', { keyPath: 'id', autoIncrement: true });
    }
    if (!db.objectStoreNames.contains('moneroKeys')) {
      db.createObjectStore('moneroKeys', { keyPath: 'id', autoIncrement: true });
    }
  },
});

export async function addSeedRecord(record: SeedRecord): Promise<number> {
  return (await dbPromise).add('seeds', record);
}

export async function getSeedRecord(seedId: number): Promise<SeedRecord | undefined> {
  return (await dbPromise).get('seeds', seedId);
}

export async function getAllSeedRecords(): Promise<SeedRecord[]> {
  return (await dbPromise).getAll('seeds');
}

export async function saveDerivedAlgoAddress(
  seedId: number,
  index: number,
  address: string,
): Promise<void> {
  const transaction = (await dbPromise).transaction('seeds', 'readwrite');
  const record = await transaction.store.get(seedId);
  if (!record) throw new Error('Algorand wallet not found.');
  record.derivedAddresses = { ...record.derivedAddresses, [index]: address };
  await transaction.store.put(record);
  await transaction.done;
}

export async function addMoneroKeyRecord(record: MoneroKeyRecord): Promise<number> {
  return (await dbPromise).add('moneroKeys', record);
}

export async function getMoneroKeyRecord(keyId: number): Promise<MoneroKeyRecord | undefined> {
  return (await dbPromise).get('moneroKeys', keyId);
}

export async function getAllMoneroKeyRecords(): Promise<MoneroKeyRecord[]> {
  return (await dbPromise).getAll('moneroKeys');
}

export async function setMoneroScanRestoreHeight(
  walletId: number,
  network: string,
  height: number,
): Promise<void> {
  if (
    !['mainnet', 'stagenet', 'testnet', 'regtest'].includes(network) ||
    !Number.isSafeInteger(height) ||
    height < 0 ||
    height > 0xffffffff
  ) {
    throw new Error('Invalid network-specific restore height.');
  }
  const transaction = (await dbPromise).transaction('moneroKeys', 'readwrite');
  const record = await transaction.store.get(walletId);
  if (!record) throw new Error('Monero wallet not found.');
  await transaction.store.put({
    ...record,
    scanRestoreHeights: { ...record.scanRestoreHeights, [network]: height },
  });
  await transaction.done;
}

export async function getWalletMeta(): Promise<WalletMeta | undefined> {
  return (await dbPromise).get('app', 'walletMeta');
}

export async function setWalletMeta(meta: WalletMeta): Promise<void> {
  await (await dbPromise).put('app', meta, 'walletMeta');
}
