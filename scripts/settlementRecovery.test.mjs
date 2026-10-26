import test from 'node:test';
import assert from 'node:assert/strict';
import algosdk from 'algosdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { leakySign } from '../lib/wallet/leakySign.ts';
import { recoverSettlementScalar } from '../lib/wallet/settlementRecovery.ts';

test('recover only the bound confirmed leaky settlement, independently of live app state', () => {
  const sender = algosdk.generateAccount().addr.toString();
  const scalar = new Uint8Array(32);
  scalar[0] = 7;
  const signature = leakySign(algosdk.getApplicationAddress(42n).publicKey, scalar);
  const genesisHash = new Uint8Array(32).fill(3);
  const binding = {
    appId: '42',
    genesisHash,
    sender,
    publicSpendKey: bytesToHex(ed25519.Point.BASE.multiply(7n).toBytes()),
    method: 'leakyClaim',
  };
  const transaction = algosdk.makeApplicationDeleteTxnFromObject({
    sender,
    appIndex: 42n,
    appArgs: [
      algosdk.ABIMethod.fromSignature('leakyClaim(byte[],pay)void').getSelector(),
      new Uint8Array([0, 64, ...signature]),
    ],
    suggestedParams: { fee: 1000n, minFee: 1000n, firstValid: 1n, lastValid: 10n, genesisHash },
  });
  assert.equal(recoverSettlementScalar(transaction, 5n, binding), bytesToHex(scalar));
  assert.throws(() => recoverSettlementScalar(transaction, 0n, binding));
  for (const wrong of [
    { appId: '43' },
    { sender: algosdk.generateAccount().addr.toString() },
    { genesisHash: new Uint8Array(32) },
    { method: 'leakyRefund' },
  ]) {
    assert.throws(() => recoverSettlementScalar(transaction, 5n, { ...binding, ...wrong }));
  }
  transaction.applicationCall.appArgs[1][2] ^= 1;
  assert.throws(() => recoverSettlementScalar(transaction, 5n, binding));
});
