import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64ToBytes } from '../provider/base64.ts';
import { recoverSettlementScalar } from './settlementRecovery.ts';
import type { SwapRecord } from './swapRecords.ts';

export function verifiedSwapSettlement(
  transaction: algosdk.Transaction,
  round: bigint,
  txId: string,
  record: SwapRecord,
  ownerPublicSpendKey: string,
): NonNullable<SwapRecord['settlement']> {
  const call = transaction.applicationCall;
  if (
    round <= 0n ||
    transaction.txID() !== txId ||
    transaction.type !== 'appl' ||
    !call ||
    call.appIndex !== BigInt(record.appId) ||
    call.onComplete !== algosdk.OnApplicationComplete.DeleteApplicationOC ||
    transaction.rekeyTo ||
    bytesToHex(transaction.genesisHash ?? new Uint8Array()) !==
      bytesToHex(base64ToBytes(record.genesisHash))
  ) {
    throw new Error('Not a confirmed settlement for this saved swap.');
  }
  const matches = (method: string) =>
    bytesToHex(call.appArgs[0] ?? new Uint8Array()) ===
    bytesToHex(algosdk.ABIMethod.fromSignature(method).getSelector());
  let kind: 'claim' | 'refund' | 'punish';
  if (matches('leakyClaim(byte[],pay)void')) kind = 'claim';
  else if (matches('leakyRefund(byte[],pay)void')) kind = 'refund';
  else if (matches('punishRefund(pay)void') && call.appArgs.length === 1) kind = 'punish';
  else throw new Error('Unknown settlement method.');
  const sender = kind === 'claim' ? record.xinAddress : record.aliAddress;
  if (transaction.sender.toString() !== sender)
    throw new Error('Settlement sender does not match the saved swap.');
  if (kind !== 'punish') {
    const signedByOwner = (kind === 'claim' ? 'xin' : 'ali') === record.role;
    recoverSettlementScalar(transaction, round, {
      appId: record.appId,
      genesisHash: base64ToBytes(record.genesisHash),
      sender,
      publicSpendKey: signedByOwner
        ? ownerPublicSpendKey
        : record.context.counterpartyPublicSpendKey,
      method: kind === 'claim' ? 'leakyClaim' : 'leakyRefund',
    });
  }
  return { kind, txId, confirmedRound: round.toString() };
}
