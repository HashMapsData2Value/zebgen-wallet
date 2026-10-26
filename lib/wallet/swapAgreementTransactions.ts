import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertAgreementState, assertAgreementFunding, type SwapAgreement } from 'leakswap-utils/dist/swapAgreement.js';
import { bytesToBase64 } from '../provider/base64.ts';
import { assertRoundDeadlines } from 'leakswap-utils/dist/swapTiming.js';

// LeakSwap's own calls cost at most 8000 microAlgos; anything near an account balance is a fee-drain attempt.
export const MAX_SIGNED_FEE_MICROALGOS = 20_000n;

// Covers setReady (102000) plus leakyClaim (108000) paired sponsor legs.
export const SPONSOR_FUNDING_MICROALGOS = 210_000n;

// Applies to every transaction this wallet signs for a page, bound to an agreement or not.
export function assertSafeSigningRequest(txns: algosdk.Transaction[], indexesToSign: number[]): void {
  if (!Array.isArray(indexesToSign) || new Set(indexesToSign).size !== indexesToSign.length
    || indexesToSign.some((index) => !Number.isInteger(index) || index < 0 || index >= txns.length)) {
    throw new Error('Invalid list of transactions to sign.');
  }
  for (const index of indexesToSign) {
    const txn = txns[index];
    if (txn.type !== algosdk.TransactionType.pay && txn.type !== algosdk.TransactionType.appl) {
      throw new Error('Only payment and application-call transactions can be signed here.');
    }
    if (txn.rekeyTo) throw new Error('Refusing to sign a transaction that rekeys the account.');
    if (txn.payment?.closeRemainderTo) throw new Error('Refusing to sign a payment that closes the account.');
    if (txn.fee > MAX_SIGNED_FEE_MICROALGOS) throw new Error('Refusing to sign a transaction with an unusually high fee.');
    const onComplete = txn.applicationCall?.onComplete;
    if (onComplete !== undefined && onComplete !== algosdk.OnApplicationComplete.NoOpOC
      && onComplete !== algosdk.OnApplicationComplete.DeleteApplicationOC) {
      throw new Error('Unsupported application call action.');
    }
  }
}

export function checkAgreementTransaction(txn: algosdk.Transaction, agreement: SwapAgreement, moneroNetwork: string): void {
  if (txn.rekeyTo || txn.payment?.closeRemainderTo) throw new Error('Agreement transactions cannot rekey or close accounts.');
  if (bytesToBase64(txn.genesisHash ?? new Uint8Array()) !== agreement.offer.payload.algoGenesisHash) throw new Error('Agreement transaction network mismatch.');
  const app = txn.applicationCall;
  if (!app || app.appIndex !== 0n) return;
  assertRoundDeadlines(agreement.offer.payload);
  const args = app.appArgs.map((bytes) => new Uint8Array(bytes));
  const selector = algosdk.ABIMethod.fromSignature('createApplication(byte[],account,byte[],uint64,uint64)void').getSelector();
  if (app.appArgs.length !== 6 || bytesToHex(app.appArgs[0]) !== bytesToHex(selector)) throw new Error('Unexpected agreement deployment method.');
  const accountIndex = Number(algosdk.ABIType.from('uint8').decode(args[2]));
  const xinAddress = accountIndex === 0 ? txn.sender.toString() : app.accounts[accountIndex - 1]?.toString();
  assertAgreementState(agreement, {
    deadlineUnit: 'round',
    genesisHash: bytesToBase64(txn.genesisHash!), moneroNetwork,
    aliAddress: txn.sender.toString(), xinAddress: xinAddress ?? '',
    aliPublicSpendKey: bytesToHex(Uint8Array.from(algosdk.ABIType.from('byte[]').decode(args[1]) as number[])),
    xinPublicSpendKey: bytesToHex(Uint8Array.from(algosdk.ABIType.from('byte[]').decode(args[3]) as number[])),
    t0: Number(algosdk.ABIType.from('uint64').decode(args[4])), t1: Number(algosdk.ABIType.from('uint64').decode(args[5]))
  });
}

export function checkAgreementEscrowPayment(txn: algosdk.Transaction, agreement: SwapAgreement, appId: bigint): void {
  if (txn.sender.toString() !== agreement.offer.payload.aliAlgoAddress
    || txn.payment?.receiver.toString() !== algosdk.getApplicationAddress(appId).toString()) throw new Error('Agreement escrow payment identity mismatch.');
  assertAgreementFunding(agreement, txn.payment.amount);
}

export function checkAgreementSponsorPayment(txn: algosdk.Transaction, agreement: SwapAgreement, sponsor: string): void {
  if (txn.sender.toString() !== agreement.offer.payload.aliAlgoAddress || txn.payment?.amount !== SPONSOR_FUNDING_MICROALGOS
    || txn.payment.receiver.toString() !== sponsor) throw new Error('Unexpected agreement sponsor funding.');
}
