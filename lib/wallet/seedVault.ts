// Older wallets used 100,000 and will no longer unlock; acceptable while the wallet is testnet-only.
const PBKDF2_ITERATIONS = 600_000;

function asArrayBufferView(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export async function deriveAesKeyFromPassword(password: string, salt: Uint8Array) {
  const safeSalt = asArrayBufferView(salt);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: safeSalt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSeed(seedBytes: Uint8Array, password: string) {
  const salt = asArrayBufferView(crypto.getRandomValues(new Uint8Array(16)));
  const iv = asArrayBufferView(crypto.getRandomValues(new Uint8Array(12)));
  const safeSeedBytes = asArrayBufferView(seedBytes);
  const key = await deriveAesKeyFromPassword(password, salt);

  const encryptedSeed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    safeSeedBytes as BufferSource,
  );

  return { encryptedSeed, salt, iv };
}

export async function decryptSeed(
  encryptedSeed: ArrayBuffer,
  password: string,
  salt: Uint8Array,
  iv: Uint8Array,
) {
  const safeIv = asArrayBufferView(iv);
  const key = await deriveAesKeyFromPassword(password, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: safeIv as BufferSource },
    key,
    encryptedSeed,
  );

  return new Uint8Array(decrypted);
}

export async function deriveLockVerifier(secret: string, salt: Uint8Array) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: asArrayBufferView(salt) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );

  return new Uint8Array(bits);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}
