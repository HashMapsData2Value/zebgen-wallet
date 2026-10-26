import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getNetworkSettings } from '../network/networkStore';
import { verifyAlgorandGenesis } from '../network/chainIdentity';
import { bytesToBase64 } from '../provider/base64';
import { validateProviderRequest } from '../provider/fundingValidation';
import type { ZebgenDepositLeakSwapMoneroParams } from '../provider/types';
import { deriveActiveSeedAlgoAddressAtIndex } from './algoWallet';
import { getMoneroWalletState, unlockMoneroWallet } from './moneroVault';
import { resolveSwapWalletId } from './swapHandshakeVault';
import { verifyAgreementApplication } from './swapRecordVault';
import { assertAgreementPrograms, agreementSponsorAddress } from './swapAgreementArtifact';
import { SPONSOR_FUNDING_MICROALGOS } from './swapAgreementTransactions';
import { computeCombinedAddressWithPrivateAndPublic } from './moneroWallet';
import { assertAgreementState } from 'leakswap-utils/dist/swapAgreement.js';
import { assertSwapFundingTime } from './swapTimingPolicy';
import { walletRestoreHeight } from '../monero/scanHeight';

export async function resolveLeakSwapDeposit(
  params: ZebgenDepositLeakSwapMoneroParams,
  secret: string,
) {
  validateProviderRequest('depositLeakSwapMonero', params);
  const agreement = await verifyAgreementApplication(
    params.agreementDigest,
    BigInt(params.appId),
    secret,
  );
  const offer = agreement.offer.payload;
  const xin = agreement.acceptance.payload;
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  if (algoAddress !== xin.xinAlgoAddress)
    throw new Error('Only Xin may fund this accepted agreement.');
  const settings = await getNetworkSettings();
  const endpoint = settings.algorand.algod;
  const algod = new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port);
  const network = await algod.getTransactionParams().do();
  verifyAlgorandGenesis(settings.algorand.network, network.genesisID ?? '', endpoint.server);
  if (!network.genesisHash) throw new Error('Algod did not return its genesis hash.');
  const app = await algod.getApplicationByID(BigInt(params.appId)).do();
  if (!app.params) throw new Error('Swap application is unavailable.');
  assertAgreementPrograms(app.params.approvalProgram, app.params.clearStateProgram);
  const value = (name: string) => {
    const entry = (app.params?.globalState ?? []).find(
      (entry) => new TextDecoder().decode(entry.key) === name,
    );
    if (!entry) throw new Error(`Swap is missing ${name}.`);
    return entry.value;
  };
  assertAgreementState(agreement, {
    deadlineUnit: 'round',
    genesisHash: bytesToBase64(network.genesisHash),
    moneroNetwork: settings.monero.network,
    aliAddress: algosdk.encodeAddress(value('aliAlgoAddr').bytes),
    xinAddress: algosdk.encodeAddress(value('xinAlgoAddr').bytes),
    aliPublicSpendKey: bytesToHex(value('aliXternalPK').bytes),
    xinPublicSpendKey: bytesToHex(value('xinXternalPK').bytes),
    t0: Number(value('t0').uint),
    t1: Number(value('t1').uint),
  });
  if (value('aliReady').uint !== 0n)
    throw new Error('This swap is already ready; do not deposit again.');
  const status = await algod.status().do();
  if (Number(status.lastRound) >= offer.t0) {
    throw new Error('The deposit deadline has passed.');
  }
  const escrow = await algod
    .accountInformation(algosdk.getApplicationAddress(BigInt(params.appId)))
    .do();
  // Anyone can add ALGO to the escrow, so extra dust must not block the deposit; only a shortfall does.
  if (escrow.amount < BigInt(agreement.offer.payload.algoAmount))
    throw new Error('ALGO funding is below the authenticated amount.');
  // Without sponsor funds a zero-ALGO Xin cannot pay the claim's fees, so check before any XMR is locked.
  const sponsor = await algod
    .accountInformation(agreementSponsorAddress(BigInt(params.appId), agreement))
    .do();
  if (sponsor.amount < SPONSOR_FUNDING_MICROALGOS)
    throw new Error(
      'The fee sponsor account is not fully funded. Do not deposit; ask Ali to fund the swap.',
    );
  assertSwapFundingTime(offer, Number((await algod.status().do()).lastRound));
  const shareId = await resolveSwapWalletId(params.agreementDigest, secret);
  if (shareId === null) throw new Error('Saved swap share is unavailable.');
  const share = await unlockMoneroWallet(secret, settings.monero.networkType, shareId);
  if (
    !share ||
    share.publicSpendKey !== xin.xinPublicSpendKey ||
    share.privateViewKey !== xin.xinPrivateViewKey
  ) {
    throw new Error('Saved Xin share does not match the agreement.');
  }
  const combined = computeCombinedAddressWithPrivateAndPublic(
    share.privateSpendKey,
    share.privateViewKey,
    offer.aliPrivateViewKey,
    offer.aliPublicSpendKey,
    settings.monero.networkType,
  );
  const state = await getMoneroWalletState();
  const wallet = state.wallets.find((candidate) => candidate.id === state.activeWalletId);
  if (!wallet || !Number.isSafeInteger(wallet.id) || wallet.id < 0)
    throw new Error('Select a normal Monero funding wallet first.');
  const funding = await unlockMoneroWallet(secret, settings.monero.networkType, wallet.id);
  if (
    !funding ||
    funding.publicSpendKey === share.publicSpendKey ||
    funding.publicSpendKey === offer.aliPublicSpendKey
  ) {
    throw new Error('Swap shares cannot be used as funding wallets.');
  }
  return {
    binding: {
      agreementDigest: params.agreementDigest,
      appId: params.appId,
      genesisHash: bytesToBase64(network.genesisHash),
      moneroNetwork: settings.monero.network,
    },
    recipient: combined.combinedAddress,
    amountAtomic: offer.xmrAmount,
    sender: funding.address,
    walletId: wallet.id,
    config: settings.monero,
    restoreHeight: walletRestoreHeight(wallet, settings.monero.network),
  };
}

export type LeakSwapDepositTarget = Awaited<ReturnType<typeof resolveLeakSwapDeposit>>;

export function assertSameDepositTarget(
  expected: LeakSwapDepositTarget,
  current: LeakSwapDepositTarget,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(current))
    throw new Error('Funding wallet or network changed. Cancel and review a new deposit request.');
}
