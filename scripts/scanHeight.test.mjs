import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeBlockHeight, walletRestoreHeight } from '../lib/monero/scanHeight.ts';

test('manual restore preferences remain separate across networks', () => {
  const wallet = {
    restoreHeight: 3_000_000,
    restoreNetwork: 'mainnet',
    scanRestoreHeights: { mainnet: 3_100_000, stagenet: 2_200_000 },
  };
  assert.equal(walletRestoreHeight(wallet, 'mainnet'), 3_100_000);
  assert.equal(walletRestoreHeight(wallet, 'stagenet'), 2_200_000);
  assert.equal(walletRestoreHeight(wallet, 'regtest'), 0);
  assert.equal(walletRestoreHeight({ scanRestoreHeights: { stagenet: -1 } }, 'stagenet'), 0);
});

test('block inputs retain only ASCII digits from pasted values', () => {
  assert.equal(sanitizeBlockHeight('2,223,140'), '2223140');
  assert.equal(sanitizeBlockHeight(' 2.223 140\n'), '2223140');
  assert.equal(sanitizeBlockHeight('abc-١23'), '23');
  assert.equal(sanitizeBlockHeight(''), '');
});

test('restore heights cannot cross networks, including ambiguous old records', () => {
  const wallet = { restoreNetwork: 'mainnet', restoreHeight: 3300000 };
  assert.equal(walletRestoreHeight(wallet, 'mainnet'), 3300000);
  assert.equal(walletRestoreHeight(wallet, 'stagenet'), 0);
  assert.equal(walletRestoreHeight(wallet, 'regtest'), 0);
  assert.equal(walletRestoreHeight({ restoreHeight: 3300000 }, 'mainnet'), 0);
  assert.equal(walletRestoreHeight(undefined, 'stagenet'), 0);
});
