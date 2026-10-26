import algosdk from 'algosdk';
import { base58xmr } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';

export function addressValidationError(chain: 'algorand' | 'monero', value: string, network: string): string | null {
  const address = value.trim();
  if (!address) return 'Enter a recipient address.';
  if (chain === 'algorand') {
    return algosdk.isValidAddress(address) && algosdk.encodeAddress(algosdk.decodeAddress(address).publicKey) === address
      ? null : 'Invalid Algorand address or checksum.';
  }
  try {
    if (address.length !== 95 && address.length !== 106) return 'Invalid Monero address length.';
    const bytes = base58xmr.decode(address);
    if (base58xmr.encode(bytes) !== address) return 'Invalid Monero address encoding.';
    const prefixes: Record<string, number[]> = {
      mainnet: [18, 19, 42], regtest: [18, 19, 42], stagenet: [24, 25, 36], testnet: [53, 54, 63],
    };
    const allowed = prefixes[network];
    if (!allowed) return 'Unknown Monero network.';
    const integrated = [19, 25, 54].includes(bytes[0]);
    if (bytes.length !== (integrated ? 77 : 69)) return 'Invalid Monero address format.';
    const payload = bytes.subarray(0, -4);
    const checksum = keccak_256(payload).subarray(0, 4);
    if (!checksum.every((byte, index) => byte === bytes[payload.length + index])) return 'Invalid Monero address checksum.';
    if (!allowed.includes(bytes[0])) return `Address does not match the selected Monero ${network} network.`;
    return null;
  } catch {
    return 'Invalid Monero address encoding or checksum.';
  }
}