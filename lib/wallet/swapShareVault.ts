import { browser } from 'wxt/browser';
import algosdk from 'algosdk';
import { deriveActiveSeedAlgoAddressAtIndex } from './algoWallet';
import { getNetworkSettings } from '../network/networkStore';
import { verifyAlgorandGenesis } from '../network/chainIdentity';
import { bytesToBase64 } from '../provider/base64';
import { decryptSeed, encryptSeed } from './seedVault';
import { getMoneroKeyMaterialFromPrivateSpendKey, type MoneroKeyMaterial } from './moneroWallet';

export interface SwapShareBinding {
  digest: string;
  genesisHash: string;
  algoAddress: string;
  network: string;
}

interface SwapShareRecord extends SwapShareBinding {
  version: 1;
  walletId: number;
  privateSpendKey: string;
  createdAt: string;
}

const PREFIX = 'leakswapShare:';

async function readShare(walletId: number, secret: string): Promise<SwapShareRecord> {
  const key = `${PREFIX}${walletId}`;
  const envelope = (await browser.storage.local.get(key))[key] as
    | { version: number; ciphertext: number[]; salt: number[]; iv: number[] }
    | undefined;
  const bytes = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (
    !Number.isSafeInteger(walletId) ||
    walletId >= 0 ||
    !envelope ||
    envelope.version !== 1 ||
    !bytes(envelope.ciphertext) ||
    envelope.ciphertext.length < 16 ||
    !bytes(envelope.salt) ||
    envelope.salt.length !== 16 ||
    !bytes(envelope.iv) ||
    envelope.iv.length !== 12
  )
    throw new Error('Swap share is unavailable.');
  const plaintext = await decryptSeed(
    new Uint8Array(envelope.ciphertext).buffer,
    secret,
    new Uint8Array(envelope.salt),
    new Uint8Array(envelope.iv),
  );
  try {
    const record = JSON.parse(new TextDecoder().decode(plaintext)) as SwapShareRecord;
    if (
      record.version !== 1 ||
      record.walletId !== walletId ||
      !/^[0-9a-f]{64}$/.test(record.digest) ||
      !/^[0-9a-f]{64}$/.test(record.privateSpendKey) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(record.genesisHash) ||
      !algosdk.isValidAddress(record.algoAddress) ||
      !['mainnet', 'testnet', 'stagenet', 'regtest'].includes(record.network) ||
      typeof record.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(record.createdAt))
    )
      throw new Error('Invalid swap share.');
    return record;
  } finally {
    plaintext.fill(0);
  }
}

export async function findSwapShare(
  binding: SwapShareBinding,
  secret: string,
): Promise<number | null> {
  for (const key of Object.keys(await browser.storage.local.get(null)).filter((key) =>
    key.startsWith(PREFIX),
  )) {
    const record = await readShare(Number(key.slice(PREFIX.length)), secret);
    if (
      record.digest === binding.digest &&
      record.genesisHash === binding.genesisHash &&
      record.algoAddress === binding.algoAddress &&
      record.network === binding.network
    )
      return record.walletId;
  }
  return null;
}

export async function storeSwapShare(
  binding: SwapShareBinding,
  material: MoneroKeyMaterial,
  secret: string,
): Promise<number> {
  return navigator.locks.request('leakswap-share-vault', async () => {
    const previous = await findSwapShare(binding, secret);
    if (previous !== null) return previous;
    const entries = await browser.storage.local.get(null);
    let walletId: number;
    do {
      walletId = -1 - Number(crypto.getRandomValues(new Uint32Array(1))[0]);
    } while (entries[`${PREFIX}${walletId}`] !== undefined);
    const record: SwapShareRecord = {
      ...binding,
      version: 1,
      walletId,
      privateSpendKey: material.privateSpendKey,
      createdAt: new Date().toISOString(),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(record));
    try {
      const encrypted = await encryptSeed(plaintext, secret);
      await browser.storage.local.set({
        [`${PREFIX}${walletId}`]: {
          version: 1,
          ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
          salt: Array.from(encrypted.salt),
          iv: Array.from(encrypted.iv),
        },
      });
    } finally {
      plaintext.fill(0);
    }
    return walletId;
  });
}

export async function unlockSwapShare(
  walletId: number,
  secret: string,
  expectedNetwork?: string,
): Promise<MoneroKeyMaterial> {
  const record = await readShare(walletId, secret);
  if (expectedNetwork !== undefined && record.network !== expectedNetwork)
    throw new Error('Swap share network does not match the saved context.');
  const settings = await getNetworkSettings();
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  const endpoint = settings.algorand.algod;
  const params = await new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port)
    .getTransactionParams()
    .do();
  verifyAlgorandGenesis(settings.algorand.network, params.genesisID ?? '', endpoint.server);
  if (
    !params.genesisHash ||
    record.genesisHash !== bytesToBase64(params.genesisHash) ||
    record.network !== settings.monero.network ||
    record.algoAddress !== algoAddress
  )
    throw new Error('Swap share does not match the active Algorand identity and networks.');
  return getMoneroKeyMaterialFromPrivateSpendKey(
    record.privateSpendKey,
    settings.monero.networkType,
  );
}

export async function listSwapShares(secret: string) {
  const shares = [];
  for (const key of Object.keys(await browser.storage.local.get(null)).filter((key) =>
    key.startsWith(PREFIX),
  )) {
    const record = await readShare(Number(key.slice(PREFIX.length)), secret);
    shares.push({
      version: record.version,
      walletId: record.walletId,
      digest: record.digest,
      genesisHash: record.genesisHash,
      algoAddress: record.algoAddress,
      network: record.network,
      createdAt: record.createdAt,
    });
  }
  return shares;
}

export async function listCurrentSwapShares(secret: string) {
  const shares = await listSwapShares(secret);
  if (!shares.length) return [];
  const settings = await getNetworkSettings();
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  const endpoint = settings.algorand.algod;
  const params = await new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port)
    .getTransactionParams()
    .do();
  verifyAlgorandGenesis(settings.algorand.network, params.genesisID ?? '', endpoint.server);
  const genesisHash = params.genesisHash ? bytesToBase64(params.genesisHash) : '';
  return shares.filter(
    (share) =>
      share.algoAddress === algoAddress &&
      share.network === settings.monero.network &&
      share.genesisHash === genesisHash,
  );
}
