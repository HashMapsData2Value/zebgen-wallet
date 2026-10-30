import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import artifact from '../contracts/LeakSwap.arc56.json';
import sponsorTemplate from '../contracts/FeeSponsorLSig.teal?raw';
import type { SwapAgreement } from 'leakswap-utils/dist/swapAgreement.js';
import { bytesToBase64 } from '../provider/base64';
import { assembleTeal } from './tealAssembler';

export function assertAgreementPrograms(approval: Uint8Array, clear: Uint8Array): void {
  if (
    bytesToBase64(approval) !== artifact.byteCode.approval ||
    bytesToBase64(clear) !== artifact.byteCode.clear
  )
    throw new Error('Application bytecode does not match the supported LeakSwap protocol.');
}

// Assembled locally from the bundled template: no node compiler is trusted for the sponsor address.
export function agreementSponsorLogicSig(
  appId: bigint,
  agreement: SwapAgreement,
): algosdk.LogicSigAccount {
  const values: Record<string, string> = {
    TMPL_APP_ID: appId.toString(),
    TMPL_ALI_ADDR: `0x${bytesToHex(algosdk.decodeAddress(agreement.offer.payload.aliAlgoAddress).publicKey)}`,
    TMPL_XIN_ADDR: `0x${bytesToHex(algosdk.decodeAddress(agreement.acceptance.payload.xinAlgoAddress).publicKey)}`,
  };
  const source = sponsorTemplate.replace(
    /\bTMPL_(?:APP_ID|ALI_ADDR|XIN_ADDR)\b/g,
    (token) => values[token],
  );
  if (/TMPL_/.test(source)) throw new Error('Sponsor template has an unfilled variable.');
  return new algosdk.LogicSigAccount(assembleTeal(source));
}

export function agreementSponsorAddress(appId: bigint, agreement: SwapAgreement): string {
  return agreementSponsorLogicSig(appId, agreement).address().toString();
}
