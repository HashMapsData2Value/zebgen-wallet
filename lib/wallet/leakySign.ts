// Vendored from leakswap-utils/src/common.ts (kept in sync by hand - the
// two packages live in separate repos/workspaces so this isn't imported
// directly). Produces the LeakSwap protocol's "leaky" Ed25519 Schnorr
// signature: R is forced to the basepoint (r=1) so that, once this
// signature is posted on-chain, anyone can algebraically recover the
// signing scalar (the Monero private spend key) from it. This is the
// mechanism the whole swap's trustlessness relies on - it must only ever be
// computed here, right before the user knowingly submits a `leakyClaim` /
// `leakyRefund` call, never persisted or logged.
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';

function getPublicKeyFromScalar(scalar: Uint8Array): Uint8Array {
  return ed25519.Point.BASE.multiply(bytesToNumberLE(scalar) % ed25519.Point.Fn.ORDER).toBytes();
}

export function leakySign(message: Uint8Array, scalar: Uint8Array): Uint8Array {
  const order = ed25519.Point.Fn.ORDER;
  const r = numberToBytesLE(1n, 32); // r = 1, forced - this is what leaks the scalar.

  const R = ed25519.Point.BASE.multiply(bytesToNumberLE(r) % order).toBytes();
  const publicKey = getPublicKeyFromScalar(scalar);

  const challengeInput = new Uint8Array([...R, ...publicKey, ...message]);
  const challengeHash = sha512(challengeInput);
  const challengeBigInt = bytesToNumberLE(challengeHash) % order;
  const secretKeyBigInt = bytesToNumberLE(scalar) % order;
  const rBigInt = bytesToNumberLE(r);

  const sBigInt = (rBigInt + ((challengeBigInt * secretKeyBigInt) % order)) % order;
  const s = numberToBytesLE(sBigInt, 32);

  const signature = new Uint8Array([...R, ...s]);

  if (!ed25519.verify(signature, message, publicKey)) {
    throw new Error('Failed to produce a valid leaky signature.');
  }

  return signature;
}
