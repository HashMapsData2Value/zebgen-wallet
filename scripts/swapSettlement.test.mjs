import test from 'node:test';
import assert from 'node:assert/strict';
import algosdk from 'algosdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { leakySign } from '../lib/wallet/leakySign.ts';
import { verifiedSwapSettlement } from '../lib/wallet/swapSettlement.ts';

test('settlement state requires confirmed bound transaction and distinguishes claim, refund and punish', () => {
  const ali = algosdk.generateAccount().addr.toString(),
    xin = algosdk.generateAccount().addr.toString();
  const genesisHash = new Uint8Array(32).fill(1);
  const scalar = new Uint8Array(32);
  scalar[0] = 7;
  const publicKey = bytesToHex(ed25519.Point.BASE.multiply(7n).toBytes());
  for (const [kind, method, sender] of [
    ['claim', 'leakyClaim', xin],
    ['refund', 'leakyRefund', ali],
    ['punish', 'punishRefund', ali],
  ]) {
    const args = [
      algosdk.ABIMethod.fromSignature(
        method === 'punishRefund' ? 'punishRefund(pay)void' : `${method}(byte[],pay)void`,
      ).getSelector(),
    ];
    if (kind !== 'punish')
      args.push(
        new Uint8Array([0, 64, ...leakySign(algosdk.getApplicationAddress(42n).publicKey, scalar)]),
      );
    const transaction = algosdk.makeApplicationDeleteTxnFromObject({
      sender,
      appIndex: 42n,
      appArgs: args,
      suggestedParams: { fee: 1000n, minFee: 1000n, firstValid: 1n, lastValid: 10n, genesisHash },
    });
    const record = {
      appId: '42',
      genesisHash: Buffer.from(genesisHash).toString('base64'),
      role: 'xin',
      aliAddress: ali,
      xinAddress: xin,
      context: { counterpartyPublicSpendKey: publicKey },
    };
    assert.deepEqual(
      verifiedSwapSettlement(transaction, 5n, transaction.txID(), record, publicKey),
      { kind, txId: transaction.txID(), confirmedRound: '5' },
    );
    assert.throws(() =>
      verifiedSwapSettlement(transaction, 0n, transaction.txID(), record, publicKey),
    );
    assert.throws(() => verifiedSwapSettlement(transaction, 5n, 'A'.repeat(52), record, publicKey));
    assert.throws(() =>
      verifiedSwapSettlement(
        transaction,
        5n,
        transaction.txID(),
        { ...record, appId: '43' },
        publicKey,
      ),
    );
  }
});
