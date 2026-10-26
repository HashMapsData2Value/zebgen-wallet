import { ed25519 } from '@noble/curves/ed25519.js';

// A counterparty key must be a real curve point of prime order; identity and small-order points make the swap's key math meaningless.
export function assertUsablePublicSpendKey(hex: string, owner: string): void {
  let valid = false;
  try {
    const point = ed25519.Point.fromHex(hex);
    valid = !point.is0() && point.isTorsionFree();
  } catch { /* not a curve point */ }
  if (!valid) throw new Error(`${owner} Monero public key is not valid. Do not continue with this swap.`);
}
