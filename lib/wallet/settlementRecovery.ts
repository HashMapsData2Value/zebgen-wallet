import algosdk from 'algosdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export function recoverSettlementScalar(transaction: algosdk.Transaction, confirmedRound: bigint,
  binding: { appId: string; genesisHash: Uint8Array; sender: string; publicSpendKey: string; method: 'leakyClaim' | 'leakyRefund' }): string {
  const call = transaction.applicationCall;
  const equal = (left: Uint8Array, right: Uint8Array) => bytesToHex(left) === bytesToHex(right);
  if (confirmedRound <= 0n || transaction.type !== 'appl' || !call
    || call.appIndex !== BigInt(binding.appId) || call.onComplete !== algosdk.OnApplicationComplete.DeleteApplicationOC
    || transaction.sender.toString() !== binding.sender || transaction.rekeyTo
    || !equal(transaction.genesisHash ?? new Uint8Array(), binding.genesisHash)
    || !equal(call.appArgs[0] ?? new Uint8Array(), algosdk.ABIMethod.fromSignature(`${binding.method}(byte[],pay)void`).getSelector())
    || call.appArgs.length !== 2 || call.appArgs[1].length !== 66 || call.appArgs[1][0] !== 0 || call.appArgs[1][1] !== 64) {
    throw new Error('Transaction is not the expected confirmed swap settlement.');
  }
  const signature = call.appArgs[1].subarray(2);
  const publicKey = hexToBytes(binding.publicSpendKey);
  const message = algosdk.getApplicationAddress(BigInt(binding.appId)).publicKey;
  if (!equal(signature.subarray(0, 32), ed25519.Point.BASE.toBytes()) || !ed25519.verify(signature, message, publicKey)) {
    throw new Error('Settlement does not contain a valid leaky signature.');
  }
  const field = ed25519.Point.Fn;
  const challenge = bytesToNumberLE(sha512(new Uint8Array([...signature.subarray(0, 32), ...publicKey, ...message]))) % field.ORDER;
  if (challenge === 0n) throw new Error('Invalid settlement challenge.');
  const scalar = field.mul(field.sub(bytesToNumberLE(signature.subarray(32)), 1n), field.inv(challenge));
  if (scalar === 0n || !equal(ed25519.Point.BASE.multiply(scalar).toBytes(), publicKey)) throw new Error('Recovered key does not match the saved swap.');
  return bytesToHex(numberToBytesLE(scalar, 32));
}