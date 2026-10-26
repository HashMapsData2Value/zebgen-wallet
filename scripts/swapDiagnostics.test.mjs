import assert from 'node:assert/strict';
import test from 'node:test';
import algosdk from 'algosdk';
import { swapDiagnostics } from '../lib/wallet/swapDiagnostics.ts';

test('support report retains public identities and matching transaction references without private context or raw transactions', () => {
  const sender = algosdk.generateAccount().addr.toString();
  const genesisHash = new Uint8Array(32).fill(3);
  const transaction = algosdk.makeApplicationDeleteTxnFromObject({
    sender,
    appIndex: 42n,
    suggestedParams: { fee: 1000n, minFee: 1000n, firstValid: 1n, lastValid: 10n, genesisHash },
  });
  const record = {
    version: 1,
    genesisHash: Buffer.from(genesisHash).toString('base64'),
    appId: '42',
    appAddress: algosdk.getApplicationAddress(42n).toString(),
    algoAddress: sender,
    aliAddress: sender,
    xinAddress: sender,
    role: 'ali',
    t0: 100,
    t1: 200,
    context: {
      walletId: -1,
      network: 'regtest',
      combinedAddress: 'combined-public',
      restoreHeight: 12,
      counterpartyPublicSpendKey: 'public-key',
      counterpartyPrivateViewKey: 'PRIVATE_VIEW_SECRET',
      privateSpendKey: 'SPEND_SECRET',
    },
  };
  const entry = {
    genesisHash: record.genesisHash,
    sender,
    txId: transaction.txID(),
    origin: 'https://app.leakswap.com',
    firstValid: '1',
    lastValid: '10',
    signedAt: '2026-10-17T00:00:00Z',
    unsignedTransaction: Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString(
      'base64',
    ),
  };
  const report = swapDiagnostics(record, [entry, { ...entry, genesisHash: 'other-chain' }]);
  assert.equal(report.transactions.length, 1);
  assert.equal(report.transactions[0].txId, transaction.txID());
  assert.equal(report.transactions[0].confirmation, 'signed only; confirmation unknown');
  assert.equal(report.restoreHeight, 12);
  assert.equal(report.combinedAddress, 'combined-public');
  const json = JSON.stringify(report);
  for (const secret of [
    'PRIVATE_VIEW_SECRET',
    'SPEND_SECRET',
    'unsignedTransaction',
    'counterpartyPrivateViewKey',
  ])
    assert.ok(!json.includes(secret));
});
