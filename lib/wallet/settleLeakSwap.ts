import algosdk from 'algosdk';
import { hexToBytes } from '@noble/hashes/utils.js';
import { getNetworkSettings } from '../network/networkStore';
import { verifyAlgorandGenesis } from '../network/chainIdentity';
import { bytesToBase64 } from '../provider/base64';
import { validateProviderRequest } from '../provider/fundingValidation';
import { assertConnectionAccounts } from '../provider/connectionApproval';
import { deriveActiveSeedAlgoAddressAtIndex, signRawTransactions } from './algoWallet';
import { resolveSwapWalletId } from './swapHandshakeVault';
import { unlockMoneroWallet } from './moneroVault';
import { verifyAgreementApplication, journalSignedAlgorandTransactions } from './swapRecordVault';
import { agreementSponsorLogicSig } from './swapAgreementArtifact';
import { assertSafeSigningRequest, checkAgreementTransaction } from './swapAgreementTransactions';
import { leakySign } from './leakySign';
import { assertRoundDeadlines } from 'leakswap-utils/dist/swapTiming.js';

export interface SettleLeakSwapParams {
  agreementDigest: string;
  appId: string;
  action: 'claim' | 'refund';
}

export interface SettleLeakSwapResult {
  txId: string;
  confirmedRound: string;
}

const TREASURY = 'KMRBWAK47LNYSDWH2FW3Q7BLZFXKHXURZG3SVUONHBHG5MPBNB2PIZKZBA';

function nodeRejectionDetail(error: unknown): string {
  const message = typeof error === 'string' ? error :
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
  if (!message) return 'Node did not provide a rejection reason.';
  return message
    .split('[]transactions.SignedTxnWithAD')[0]
    .replace(/(?:0x)?[a-fA-F0-9]{64,}|[A-Za-z0-9+/_=-]{80,}/g, '[redacted data]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 1200);
}

export async function settleLeakSwap(params: SettleLeakSwapParams, secret: string, origin: string, signal?: AbortSignal): Promise<SettleLeakSwapResult> {
  validateProviderRequest('settleLeakSwap', params);
  return navigator.locks.request(`leakswap-settle:${params.agreementDigest}`, async () => {
    const settings = await getNetworkSettings();
    const endpoint = settings.algorand.algod;
    const algod = new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port);
    const appId = BigInt(params.appId);
    const agreement = await verifyAgreementApplication(params.agreementDigest, appId, secret);
    const offer = agreement.offer.payload;
    assertRoundDeadlines(offer);
    const currentDeadlineValue = async () => {
      const round = Number((await algod.status().do()).lastRound);
      if (!Number.isSafeInteger(round) || round < offer.createdRound) throw new Error('Current node round is unavailable.');
      return round;
    };
    const acceptance = agreement.acceptance.payload;
    const claim = params.action === 'claim';
    const sender = claim ? acceptance.xinAlgoAddress : offer.aliAlgoAddress;
    const publicSpendKey = claim ? acceptance.xinPublicSpendKey : offer.aliPublicSpendKey;
    const assertActive = async () => {
      if (signal?.aborted) throw new Error('Settlement cancelled. If simulation started, treat the swap key share as disclosed to the node.');
      await assertConnectionAccounts(origin, params);
      if ((await deriveActiveSeedAlgoAddressAtIndex(secret, 0)).algoAddress !== sender) throw new Error('Only the agreed settlement party may continue.');
      if (JSON.stringify(await getNetworkSettings()) !== JSON.stringify(settings)) throw new Error('Network settings changed during settlement.');
      const current = await currentDeadlineValue();
      if (claim ? current >= offer.t1 : current > offer.t0) {
        throw new Error('Settlement deadline passed during approval. If simulation started, treat the swap key share as disclosed to the node.');
      }
    };
    await assertActive();
    const suggestedParams = await algod.getTransactionParams().do();
    verifyAlgorandGenesis(settings.algorand.network, suggestedParams.genesisID ?? '', endpoint.server);
    if (!suggestedParams.genesisHash || bytesToBase64(suggestedParams.genesisHash) !== offer.algoGenesisHash) throw new Error('Settlement network does not match the agreement.');
    const app = await algod.getApplicationByID(appId).do();
    const ready = app.params?.globalState?.find(entry => new TextDecoder().decode(entry.key) === 'aliReady')?.value.uint;
    if (ready === undefined) throw new Error('Swap readiness is unavailable.');
    const current = await currentDeadlineValue();
    if (claim ? current >= offer.t1 || (ready === 0n && current <= offer.t0) : ready !== 0n || current > offer.t0) {
      throw new Error('The requested settlement is not available at the current readiness or deadline.');
    }
    const escrow = await algod.accountInformation(algosdk.getApplicationAddress(appId)).do();
    if (escrow.amount < BigInt(offer.algoAmount)) throw new Error('Escrow balance is below the authenticated ALGO amount.');
    const sponsor = agreementSponsorLogicSig(appId, agreement);
    const sponsorBalance = await algod.accountInformation(sponsor.address()).do();
    const minFee = suggestedParams.minFee;
    if (typeof minFee !== 'bigint' || minFee <= 0n) throw new Error('Network minimum transaction fee is unavailable.');
    const fee = claim ? 8n * minFee : 5000n;
    if (sponsorBalance.amount < 100000n + fee) {
      const shortfall = 100000n + fee - sponsorBalance.amount;
      throw new Error(`Settlement fee sponsor is underfunded by ${shortfall} microALGO. Top up sponsor ${sponsor.address().toString()} before retrying. No swap key was disclosed by this attempt.`);
    }
    if (!claim && minFee > 1000n) throw new Error('Network minimum fee exceeds the supported settlement fee.');
    const walletId = await resolveSwapWalletId(params.agreementDigest, secret);
    if (walletId === null) throw new Error('Swap key share is unavailable.');
    const material = await unlockMoneroWallet(secret, settings.monero.networkType, walletId);
    if (!material || material.publicSpendKey !== publicSpendKey) throw new Error('Swap spend key does not match the agreement.');
    const buildGroup = (signature: Uint8Array) => {
      const composer = new algosdk.AtomicTransactionComposer();
      const sponsorPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: sponsor.address(), receiver: sender, amount: 0n, closeRemainderTo: sender,
        suggestedParams: { ...suggestedParams, flatFee: true, fee: 0n },
      });
      composer.addMethodCall({
        appID: appId, sender, onComplete: algosdk.OnApplicationComplete.DeleteApplicationOC,
        method: algosdk.ABIMethod.fromSignature(claim ? 'leakyClaim(byte[],pay)void' : 'leakyRefund(byte[],pay)void'),
        methodArgs: [signature, { txn: sponsorPayment, signer: async () => [] }],
        appAccounts: claim ? [TREASURY] : undefined,
        suggestedParams: { ...suggestedParams, flatFee: true, fee }, signer: async () => [],
      });
      return composer.buildGroup().map(entry => entry.txn);
    };
    const preview = buildGroup(new Uint8Array(64));
    assertSafeSigningRequest(preview, [1]);
    checkAgreementTransaction(preview[1], agreement, settings.monero.network);
    await assertActive();
    const scalar = hexToBytes(material.privateSpendKey);
    let signature: Uint8Array;
    try { signature = leakySign(algosdk.getApplicationAddress(appId).publicKey, scalar); }
    finally { scalar.fill(0); }
    try {
      const group = buildGroup(signature);
      const txId = group[1].txID();
      const unsigned = algosdk.encodeUnsignedTransaction(group[1]);
      await journalSignedAlgorandTransactions([unsigned], origin, secret);
      await assertActive();
      const sponsorBlob = algosdk.signLogicSigTransactionObject(group[0], sponsor).blob;
      const simulation = new algosdk.modelsv2.SimulateRequest({
        txnGroups: [new algosdk.modelsv2.SimulateRequestTransactionGroup({ txns: [
          algosdk.decodeSignedTransaction(sponsorBlob), new algosdk.SignedTransaction({ txn: group[1] }),
        ] })], allowEmptySignatures: true,
      });
      let simulated;
      try { simulated = (await algod.simulateTransactions(simulation).do()).txnGroups[0]; }
      catch (error) {
        console.error('Settlement simulation request failed', { txId, appId: params.appId, action: params.action }, error);
        throw new Error(`Settlement simulation unavailable. Node: ${nodeRejectionDetail(error)} No Algorand transaction was signed. The node may have received the revealing signature. Reference: ${txId}`);
      }
      if (!simulated || simulated.failureMessage) {
        console.error('Settlement simulation rejected', {
          txId, appId: params.appId, action: params.action,
          failureMessage: simulated?.failureMessage, failedAt: simulated?.failedAt,
        });
        const location = simulated?.failedAt?.length ? ` Failure path (zero-based): ${simulated.failedAt.join(' > ')}.` : '';
        throw new Error(`Settlement simulation rejected the group. Node: ${nodeRejectionDetail(simulated?.failureMessage)}${location} No Algorand transaction was signed. The node received the revealing signature. Reference: ${txId}`);
      }
      await assertActive();
      const signed = await signRawTransactions(secret, 0, [unsigned]);
      await assertActive();
      try {
        await algod.sendRawTransaction([sponsorBlob, signed[0]]).do();
        const confirmed = await algosdk.waitForConfirmation(algod, txId, 4);
        if (!confirmed.confirmedRound) throw new Error('Unconfirmed');
        return { txId, confirmedRound: confirmed.confirmedRound.toString() };
      } catch (error) {
        console.error('Settlement submission or confirmation failed', { txId, appId: params.appId, action: params.action }, error);
        throw new Error(`Settlement submission or confirmation is uncertain. Node: ${nodeRejectionDetail(error)} Check this transaction before retrying: ${txId}. The swap key share has been disclosed to the node.`);
      }
    } finally { signature.fill(0); }
  });
}
