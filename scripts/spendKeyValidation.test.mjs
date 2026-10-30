import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { assertUsablePublicSpendKey } from '../lib/wallet/spendKeyValidation.ts';

test('a normal prime-order public key is accepted', () => {
  assert.doesNotThrow(() =>
    assertUsablePublicSpendKey(ed25519.Point.BASE.multiply(7n).toHex(), 'Test'),
  );
});

test('identity, small-order and non-curve keys are refused', () => {
  const identity = '01' + '00'.repeat(31);
  const smallOrder = 'ec' + 'ff'.repeat(30) + '7f';
  for (const key of [identity, smallOrder, 'ff'.repeat(32), 'zz', '']) {
    assert.throws(
      () => assertUsablePublicSpendKey(key, 'The counterparty\u2019s'),
      /not valid. Do not continue/,
    );
  }
});

test('a mixed-order key (valid point plus a torsion component) is refused', () => {
  const torsion = ed25519.Point.fromHex('ec' + 'ff'.repeat(30) + '7f');
  const mixed = ed25519.Point.BASE.multiply(7n).add(torsion).toHex();
  assert.throws(() => assertUsablePublicSpendKey(mixed, 'Test'), /not valid/);
});
