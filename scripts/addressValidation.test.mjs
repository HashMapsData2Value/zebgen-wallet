import assert from 'node:assert/strict';
import test from 'node:test';
import algosdk from 'algosdk';
import { base58xmr } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { addressValidationError } from '../lib/wallet/addressValidation.ts';

const monero = prefix => {
  const payload = new Uint8Array([prefix, ...new Uint8Array([19, 25, 54].includes(prefix) ? 72 : 64).fill(7)]);
  return base58xmr.encode(new Uint8Array([...payload, ...keccak_256(payload).slice(0, 4)]));
};

test('Algorand checks checksum, trims whitespace and does not invent a network prefix', () => {
  const address = algosdk.generateAccount().addr.toString();
  for (const network of ['mainnet', 'testnet', 'localnet']) assert.equal(addressValidationError('algorand', ` ${address} `, network), null);
  assert.match(addressValidationError('algorand', address.slice(0, -1) + (address.endsWith('A') ? 'B' : 'A'), 'mainnet'), /checksum/);
  for (const address of ['', 'abc', 'A'.repeat(58)]) assert.ok(addressValidationError('algorand', address, 'mainnet'));
});

test('Monero primary, integrated and subaddresses validate checksum and network', () => {
  for (const [network, prefixes] of [['mainnet', [18, 19, 42]], ['regtest', [18, 19, 42]], ['stagenet', [24, 25, 36]], ['testnet', [53, 54, 63]]]) {
    for (const prefix of prefixes) {
      const address = monero(prefix);
      assert.equal(addressValidationError('monero', address, network), null);
      assert.match(addressValidationError('monero', address, network === 'stagenet' ? 'mainnet' : 'stagenet'), /network/);
      const bytes = base58xmr.decode(address);
      bytes[10] ^= 1;
      assert.match(addressValidationError('monero', base58xmr.encode(bytes), network), /checksum/);
    }
  }
});

test('Monero rejects bad alphabet, malformed lengths and wrong integrated format', () => {
  for (const address of ['', '0'.repeat(95), monero(24).slice(1), 'z'.repeat(106)]) assert.ok(addressValidationError('monero', address, 'stagenet'));
  const payload = new Uint8Array([25, ...new Uint8Array(64)]);
  assert.match(addressValidationError('monero', base58xmr.encode(new Uint8Array([...payload, ...keccak_256(payload).slice(0, 4)])), 'stagenet'), /format/);
});