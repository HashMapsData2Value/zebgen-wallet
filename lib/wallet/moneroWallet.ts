import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// Monero network types, numbered as in monero-ts and zebgen-monero-wasm.
export enum MoneroNetworkType {
  MAINNET = 0,
  TESTNET = 1,
  STAGENET = 2,
}

const MONERO_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MONERO_FULL_ENCODE_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

export const MONERO_L = 2n ** 252n + 27742317777372353535851937790883648493n;

export interface MoneroSharePayload {
  privateViewKey: string;
  publicSpendKey: string;
}

export interface MoneroKeyMaterial {
  privateSpendKey: string;
  privateViewKey: string;
  publicSpendKey: string;
  publicViewKey: string;
  address: string;
}

export interface CombinedMoneroAddressResult {
  combinedPublicSpendKey: string;
  combinedPublicViewKey: string;
  combinedAddress: string;
}

export function genPrivateSpendKey(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const scalar = modL(leBytesToBigInt(random));
  return bytesToHex(bigIntToLe32(scalar));
}

export function genPrivateViewKey(privateSpendKeyHex: string): string {
  const spendBytes = hexToBytes(privateSpendKeyHex);
  const hash = keccak_256(spendBytes);
  const scalar = modL(leBytesToBigInt(hash));
  return bytesToHex(bigIntToLe32(scalar));
}

export function getPublicKeyFromPrivateScalar(privateScalarHex: string): string {
  const scalar = privateScalarHexToBigInt(privateScalarHex);
  const point = ed25519.Point.BASE.multiply(scalar);
  return bytesToHex(point.toBytes());
}

export function getCompleteAddressFromPrivate(
  privateSpendKey: string,
  privateViewKey: string,
  networkType: MoneroNetworkType = MoneroNetworkType.MAINNET
): string {
  const publicSpendKey = hexToBytes(getPublicKeyFromPrivateScalar(privateSpendKey));
  const publicViewKey = hexToBytes(getPublicKeyFromPrivateScalar(privateViewKey));
  return getCompleteAddressFromPublic(publicSpendKey, publicViewKey, networkType);
}

export function generateMoneroKeyMaterial(
  networkType: MoneroNetworkType = MoneroNetworkType.MAINNET
): MoneroKeyMaterial {
  const privateSpendKey = genPrivateSpendKey();
  return getMoneroKeyMaterialFromPrivateSpendKey(privateSpendKey, networkType);
}

export function getMoneroKeyMaterialFromPrivateSpendKey(
  privateSpendKeyHex: string,
  networkType: MoneroNetworkType = MoneroNetworkType.MAINNET
): MoneroKeyMaterial {
  const privateSpendKey = bytesToHex(bigIntToLe32(privateScalarHexToBigInt(privateSpendKeyHex)));
  const privateViewKey = genPrivateViewKey(privateSpendKey);
  const publicSpendKey = getPublicKeyFromPrivateScalar(privateSpendKey);
  const publicViewKey = getPublicKeyFromPrivateScalar(privateViewKey);
  const address = getCompleteAddressFromPrivate(privateSpendKey, privateViewKey, networkType);

  return {
    privateSpendKey,
    privateViewKey,
    publicSpendKey,
    publicViewKey,
    address,
  };
}

export function createSwapSharePayload(privateSpendKey: string): MoneroSharePayload {
  return {
    privateViewKey: genPrivateViewKey(privateSpendKey),
    publicSpendKey: getPublicKeyFromPrivateScalar(privateSpendKey),
  };
}

export function combinePrivateSpendKeys(
  privateSpendKeyA: string,
  privateSpendKeyB: string
): string {
  const a = privateScalarHexToBigInt(privateSpendKeyA);
  const b = privateScalarHexToBigInt(privateSpendKeyB);
  return bytesToHex(bigIntToLe32(modL(a + b)));
}

export function combineMoneroKeyMaterialFromPrivateSpendKeys(
  privateSpendKeyA: string,
  privateSpendKeyB: string,
  networkType: MoneroNetworkType = MoneroNetworkType.MAINNET
): MoneroKeyMaterial {
  const privateSpendKey = combinePrivateSpendKeys(privateSpendKeyA, privateSpendKeyB);
  const privateViewKey = combinePrivateSpendKeys(
    genPrivateViewKey(privateSpendKeyA),
    genPrivateViewKey(privateSpendKeyB)
  );
  const publicSpendKey = getPublicKeyFromPrivateScalar(privateSpendKey);
  const publicViewKey = getPublicKeyFromPrivateScalar(privateViewKey);

  return {
    privateSpendKey,
    privateViewKey,
    publicSpendKey,
    publicViewKey,
    address: getCompleteAddressFromPrivate(privateSpendKey, privateViewKey, networkType),
  };
}

export function computeCombinedAddressWithPrivateAndPublic(
  myPrivateSpendKey: string,
  myPrivateViewKey: string,
  theirPrivateViewKey: string,
  theirPublicSpendKey: string,
  networkType: MoneroNetworkType = MoneroNetworkType.MAINNET
): CombinedMoneroAddressResult {
  const myPublicSpendKey = hexToBytes(getPublicKeyFromPrivateScalar(myPrivateSpendKey));
  const myPublicViewKey = hexToBytes(getPublicKeyFromPrivateScalar(myPrivateViewKey));
  const theirPublicViewKey = hexToBytes(getPublicKeyFromPrivateScalar(theirPrivateViewKey));
  const theirPublicSpendKeyBytes = hexToBytes(theirPublicSpendKey);

  const combinedPublicSpendKeyPoint = ed25519.Point.fromHex(bytesToHex(myPublicSpendKey)).add(
    ed25519.Point.fromHex(bytesToHex(theirPublicSpendKeyBytes))
  );
  const combinedPublicViewKeyPoint = ed25519.Point.fromHex(bytesToHex(myPublicViewKey)).add(
    ed25519.Point.fromHex(bytesToHex(theirPublicViewKey))
  );

  const combinedPublicSpendKey = bytesToHex(combinedPublicSpendKeyPoint.toBytes());
  const combinedPublicViewKey = bytesToHex(combinedPublicViewKeyPoint.toBytes());

  return {
    combinedPublicSpendKey,
    combinedPublicViewKey,
    combinedAddress: getCompleteAddressFromPublic(
      hexToBytes(combinedPublicSpendKey),
      hexToBytes(combinedPublicViewKey),
      networkType
    ),
  };
}

export function computeCombinedAddressFromPublicKeys(
  publicSpendKeyA: string,
  publicViewKeyA: string,
  publicSpendKeyB: string,
  publicViewKeyB: string,
  networkType: MoneroNetworkType = MoneroNetworkType.MAINNET
): CombinedMoneroAddressResult {
  const combinedPublicSpendKeyPoint = ed25519.Point.fromHex(publicSpendKeyA).add(
    ed25519.Point.fromHex(publicSpendKeyB)
  );
  const combinedPublicViewKeyPoint = ed25519.Point.fromHex(publicViewKeyA).add(
    ed25519.Point.fromHex(publicViewKeyB)
  );

  const combinedPublicSpendKey = bytesToHex(combinedPublicSpendKeyPoint.toBytes());
  const combinedPublicViewKey = bytesToHex(combinedPublicViewKeyPoint.toBytes());

  return {
    combinedPublicSpendKey,
    combinedPublicViewKey,
    combinedAddress: getCompleteAddressFromPublic(
      hexToBytes(combinedPublicSpendKey),
      hexToBytes(combinedPublicViewKey),
      networkType
    ),
  };
}

function getCompleteAddressFromPublic(
  publicSpendKey: Uint8Array,
  publicViewKey: Uint8Array,
  networkType: MoneroNetworkType
): string {
  const prefix = getNetworkPrefix(networkType);
  const addressBytes = new Uint8Array(prefix.length + publicSpendKey.length + publicViewKey.length);
  addressBytes.set(prefix);
  addressBytes.set(publicSpendKey, prefix.length);
  addressBytes.set(publicViewKey, prefix.length + publicSpendKey.length);

  const checksum = keccak_256(addressBytes).slice(0, 4);

  const completeAddress = new Uint8Array(addressBytes.length + checksum.length);
  completeAddress.set(addressBytes);
  completeAddress.set(checksum, addressBytes.length);

  return moneroBase58Encode(completeAddress);
}

function getNetworkPrefix(networkType: MoneroNetworkType): Uint8Array {
  switch (networkType) {
    case MoneroNetworkType.MAINNET:
      return new Uint8Array([0x12]);
    case MoneroNetworkType.STAGENET:
      return new Uint8Array([0x18]);
    case MoneroNetworkType.TESTNET:
      return new Uint8Array([0x35]);
    default:
      throw new Error('Unsupported Monero network type.');
  }
}

function moneroBase58Encode(bytes: Uint8Array): string {
  let encoded = '';

  for (let i = 0; i < bytes.length; i += 8) {
    const block = bytes.slice(i, i + 8);
    const blockHex = bytesToHex(block);
    const blockNum = blockHex.length > 0 ? BigInt(`0x${blockHex}`) : 0n;
    const fullEncodedSize = MONERO_FULL_ENCODE_BLOCK_SIZES[block.length];

    encoded += encodeBlock(blockNum, fullEncodedSize);
  }

  return encoded;
}

function encodeBlock(num: bigint, size: number): string {
  if (size === 0) {
    return '';
  }

  let value = num;
  let out = '';

  while (value > 0n) {
    const mod = Number(value % 58n);
    out = MONERO_BASE58_ALPHABET[mod] + out;
    value /= 58n;
  }

  return out.padStart(size, MONERO_BASE58_ALPHABET[0]);
}

function modL(n: bigint): bigint {
  const v = n % MONERO_L;
  return v >= 0n ? v : v + MONERO_L;
}

function privateScalarHexToBigInt(privateScalarHex: string): bigint {
  const bytes = hexToBytes(privateScalarHex);
  if (bytes.length !== 32) {
    throw new Error('Monero scalar must be 32 bytes hex.');
  }
  return modL(leBytesToBigInt(bytes));
}

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    value += BigInt(bytes[i]) << (8n * BigInt(i));
  }
  return value;
}

function bigIntToLe32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = modL(value);

  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }

  return out;
}
