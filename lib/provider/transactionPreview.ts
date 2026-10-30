import algosdk from 'algosdk';
import { base64ToBytes } from './base64.ts';

export function requestsSwapReady(params: { txns: string[]; indexesToSign: number[] }): boolean {
  if (params.indexesToSign.length !== 1) return false;
  try {
    const transaction = algosdk.decodeUnsignedTransaction(
      base64ToBytes(params.txns[params.indexesToSign[0]]),
    );
    const call = transaction.applicationCall;
    const selector = algosdk.ABIMethod.fromSignature('setReady(pay)void').getSelector();
    return (
      transaction.type === algosdk.TransactionType.appl &&
      call !== undefined &&
      call.appIndex > 0n &&
      call.onComplete === algosdk.OnApplicationComplete.NoOpOC &&
      call.appArgs.length === 1 &&
      call.appArgs[0].length === selector.length &&
      selector.every((byte, index) => byte === call.appArgs[0][index])
    );
  } catch {
    return false;
  }
}
