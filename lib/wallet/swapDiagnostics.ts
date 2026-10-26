import algosdk from 'algosdk';
import { base64ToBytes } from '../provider/base64.ts';
import type { SignedTransactionRecord, SwapRecord } from './swapRecords';

export function swapDiagnostics(record: SwapRecord, journal: SignedTransactionRecord[]) {
  const transactions = journal
    .filter((entry) => entry.genesisHash === record.genesisHash)
    .flatMap((entry) => {
      try {
        const transaction = algosdk.decodeUnsignedTransaction(
          base64ToBytes(entry.unsignedTransaction),
        );
        if (transaction.txID() !== entry.txId) throw new Error('Journal transaction ID mismatch.');
        const call = transaction.applicationCall;
        const payment = transaction.payment;
        if (
          call?.appIndex !== BigInt(record.appId) &&
          payment?.receiver.toString() !== record.appAddress
        )
          return [];
        return [
          {
            txId: entry.txId,
            sender: entry.sender,
            origin: entry.origin,
            signedAt: entry.signedAt,
            firstValid: entry.firstValid,
            lastValid: entry.lastValid,
            type: transaction.type,
            applicationId: call?.appIndex.toString(),
            receiver: payment?.receiver.toString(),
            confirmation:
              record.settlement?.txId === entry.txId
                ? 'verified settlement'
                : 'signed only; confirmation unknown',
          },
        ];
      } catch (failure) {
        console.error('Unable to read signed swap transaction reference', failure);
        return [];
      }
    });
  return {
    version: 1,
    appId: record.appId,
    appAddress: record.appAddress,
    genesisHash: record.genesisHash,
    role: record.role,
    algoAddress: record.algoAddress,
    aliAddress: record.aliAddress,
    xinAddress: record.xinAddress,
    moneroNetwork: record.context.network,
    combinedAddress: record.context.combinedAddress,
    originalWalletId: record.context.walletId,
    restoreHeight: record.context.restoreHeight,
    counterpartyPublicSpendKey: record.context.counterpartyPublicSpendKey,
    agreementDigest: record.agreementDigest,
    t0: record.t0,
    t1: record.t1,
    settlement: record.settlement ? { ...record.settlement } : undefined,
    transactions,
  };
}
