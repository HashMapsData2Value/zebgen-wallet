import {
  journalSignedAlgorandTransactions,
  saveVerifiedLeakSwap,
  listVerifiedLeakSwaps,
  validateAgreementSigning,
  verifyAgreementApplication,
} from '../../lib/wallet/swapRecordVault';
import algosdk from 'algosdk';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';

import {
  currentRestoreHeight,
  rememberSwapAddressHeight,
  swapAddressHeight,
} from '../../lib/monero/restoreHeight';
import { scanMoneroFunding, type MoneroFundingControl } from '../../lib/monero/moneroDaemon';
import { fundingRestoreHeight, validateFundingParams } from '../../lib/provider/fundingValidation';
import { getNetworkSettings } from '../../lib/network/networkStore';
import { base64ToBytes, bytesToBase64 } from '../../lib/provider/base64';
import { requestsSwapReady } from '../../lib/provider/transactionPreview';
import type { GetPendingRequestResponse, PendingZebgenRequest } from '../../lib/provider/types';
import {
  deriveActiveSeedAlgoAddressAtIndex,
  getSignedInState,
  signRawTransactions,
  unlockWallet,
} from '../../lib/wallet/algoWallet';
import { leakySign } from '../../lib/wallet/leakySign';
import {
  getMoneroWalletState,
  loadMoneroCombinedContext,
  saveMoneroCombinedContext,
  unlockMoneroWallet,
} from '../../lib/wallet/moneroVault';
import {
  combinePrivateSpendKeys,
  computeCombinedAddressWithPrivateAndPublic,
} from '../../lib/wallet/moneroWallet';
import type { ZebgenSaveLeakSwapParams } from '../../lib/provider/types';
import {
  createSwapInvite,
  acceptSwapInvite,
  confirmSwapAcceptance,
  loadAcceptedSwap,
  resolveSwapWalletId,
  type SwapInviteTerms,
} from '../../lib/wallet/swapHandshakeVault';
import {
  parseHandshakeLink,
  verifyHandshake,
  type SignedOffer,
} from 'leakswap-utils/dist/swapHandshake.js';
import SwapFeeDisclosure from './SwapFeeDisclosure';
import ConnectDisclosure from './ConnectDisclosure';
import {
  activeConnectionAccounts,
  assertConnectionAccounts,
  connectedAccounts,
  type ConnectionAccounts,
} from '../../lib/provider/connectionApproval';
import { connectionChoices, type ConnectionChoices } from '../../lib/provider/connectionSelection';
import {
  resolveLeakSwapDeposit,
  type LeakSwapDepositTarget,
} from '../../lib/wallet/leakSwapDeposit';
import type { ZebgenDepositLeakSwapMoneroParams } from '../../lib/provider/types';
import LeakSwapDeposit from './LeakSwapDeposit';
import ScanApprovalProgress from './ScanApprovalProgress';
import { recoverLeakSwap, type RecoverLeakSwapParams } from '../../lib/wallet/recoverLeakSwap';
import { assertAgreementBound } from '../../lib/provider/requestSafety';
import { settleLeakSwap, type SettleLeakSwapParams } from '../../lib/wallet/settleLeakSwap';

interface ExternalRequestAppProps {
  requestId: string;
}

type Stage = 'loading' | 'consent' | 'unlock' | 'deposit' | 'error';
type ApprovalPhase = 'unlocking' | 'validating' | 'monero' | 'signing';

const APPROVAL_PHASE_LABELS: Record<ApprovalPhase, string> = {
  unlocking: 'Unlocking wallet...',
  validating: 'Validating and simulating Algorand transaction...',
  monero: 'Checking Monero deposit...',
  signing: 'Signing Algorand transaction...',
};

function ExternalRequestApp({ requestId }: ExternalRequestAppProps) {
  const [pending, setPending] = useState<PendingZebgenRequest | null>(null);
  const [connectAccounts, setConnectAccounts] = useState<ConnectionAccounts | null>(null);
  const [choices, setChoices] = useState<ConnectionChoices | null>(null);
  const [deposit, setDeposit] = useState<{
    target: LeakSwapDepositTarget;
    accounts: ConnectionAccounts;
  } | null>(null);
  const [originApproved, setOriginApproved] = useState(false);
  const [stage, setStage] = useState<Stage>('loading');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [approvalPhase, setApprovalPhase] = useState<ApprovalPhase>('unlocking');
  const scanController = useRef<AbortController | null>(null);
  const [scanProgress, setScanProgress] = useState<{
    scannedHeight: number;
    targetHeight: number;
    startHeight?: number;
  } | null>(null);
  const [reviewOffer, setReviewOffer] = useState<SignedOffer | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (pending?.type !== 'acceptSwapInvite') return;
    const link = (pending.params as { link: string }).link;
    parseHandshakeLink(link)
      .then(async (message) => {
        if (message.kind !== 'invite') throw new Error('Expected an invite.');
        await verifyHandshake(
          message,
          algosdk.decodeAddress(message.payload.aliAlgoAddress).publicKey,
        );
        if (!cancelled) setReviewOffer(message);
      })
      .catch((failure) => {
        if (!cancelled)
          setReviewError(failure instanceof Error ? failure.message : 'Invalid invite.');
      });
    return () => {
      cancelled = true;
    };
  }, [pending]);

  useEffect(() => {
    const cancel = () => scanController.current?.abort();
    window.addEventListener('pagehide', cancel);
    return () => {
      cancel();
      window.removeEventListener('pagehide', cancel);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      const response = (await browser.runtime.sendMessage({
        channel: 'zebgen-pending',
        action: 'get',
        id: requestId,
      })) as GetPendingRequestResponse;
      if (!isMounted) {
        return;
      }
      if (!response.ok || !response.request) {
        setError(response.error ?? 'This request is no longer available.');
        setStage('error');
        return;
      }
      setPending(response.request);
      setOriginApproved(Boolean(response.originApproved));
      if (response.request.type === 'connect') {
        try {
          const [accounts, available] = await Promise.all([
            activeConnectionAccounts(),
            connectionChoices(),
          ]);
          if (!isMounted) return;
          setConnectAccounts(accounts);
          setChoices(available);
        } catch (failure) {
          if (!isMounted) return;
          setError(failure instanceof Error ? failure.message : 'Unable to load active accounts.');
        }
      }
      setStage(response.request.type === 'connect' ? 'consent' : 'unlock');
    })();
    return () => {
      isMounted = false;
    };
  }, [requestId]);

  async function respond(ok: boolean, result?: unknown, errMessage?: string) {
    const response = await browser.runtime.sendMessage({
      channel: 'zebgen-pending',
      action: 'resolve',
      id: requestId,
      ok,
      result,
      error: errMessage,
    });
    if (!response?.ok) throw new Error(response?.error ?? 'Unable to complete request.');
    window.close();
  }

  async function onApproveConnect() {
    setIsBusy(true);
    setError(null);
    try {
      if (!connectAccounts || !choices) throw new Error('Wait for your wallets to load.');
      await respond(true, connectAccounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect.');
      setIsBusy(false);
    }
  }

  async function onUnlockAndApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) {
      return;
    }
    setIsBusy(true);
    setError(null);
    setApprovalPhase('unlocking');
    setScanProgress(null);
    try {
      const accounts = await connectedAccounts(pending.origin);
      await assertConnectionAccounts(pending.origin, pending.params);
      if (pending.type === 'acceptSwapInvite' && !accounts?.moneroAddress)
        throw new Error(
          'No Monero funding wallet is connected. Create or import a Monero wallet in Zebgen, select it, then reconnect before accepting this invitation.',
        );
      await unlockWallet(secret);
      if (pending.type === 'depositLeakSwapMonero') {
        if (!accounts) throw new Error('Connect the active accounts before depositing.');
        const target = await resolveLeakSwapDeposit(
          pending.params as ZebgenDepositLeakSwapMoneroParams,
          secret,
        );
        await assertConnectionAccounts(pending.origin, pending.params, accounts);
        setDeposit({ target, accounts });
        setStage('deposit');
        setIsBusy(false);
        return;
      }
      const controller = new AbortController();
      scanController.current = controller;
      setScanProgress(null);
      const result = await computeResult(
        pending,
        secret,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            setApprovalPhase('monero');
            setScanProgress(progress);
          },
        },
        setApprovalPhase,
      );
      if (pending.type !== 'settleLeakSwap')
        await assertConnectionAccounts(pending.origin, pending.params, accounts ?? undefined);
      await respond(true, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete request.');
      setIsBusy(false);
    }
  }

  async function onReject() {
    scanController.current?.abort();
    await respond(false, undefined, 'User rejected the request.');
  }

  if (stage === 'loading') {
    return (
      <main className="popup-root">
        <p>Loading request...</p>
      </main>
    );
  }

  if (stage === 'error' || !pending) {
    return (
      <main className="popup-root">
        <section className="card">
          <h2>Zebgen Wallet</h2>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="popup-root">
      <div className="app-header">
        <h1>Zebgen Wallet</h1>
      </div>
      <section className="card">
        <h2>{describeRequest(pending)}</h2>
        <p className="hint">
          Requested by <strong>{pending.origin}</strong>
          {originApproved ? ' (previously approved)' : ''}
        </p>

        {pending.type === 'signAlgorandTransactions' ? (
          <ul className="hint">
            {summarizeTransactions(pending.params).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {pending.type === 'signAlgorandTransactions' &&
        requestsSwapReady(
          pending.params as import('../../lib/provider/types').ZebgenSignAlgorandTransactionsParams,
        ) ? (
          <p className="hint">
            Marks the swap ready for the XMR holder to claim ALGO. For a saved agreement, Zebgen
            verifies the Monero deposit and its confirmations before signing this Algorand
            transaction.
          </p>
        ) : null}

        {pending.type === 'computeMoneroLeakySignature' ? (
          <p className="error">
            Warning: approval gives this site a signature that reveals the selected Monero spend key
            immediately, even if no Algorand transaction confirms. Simulation also exposes it to the
            node and cannot guarantee settlement. Only approve if you intend to disclose this swap
            key share now.
          </p>
        ) : null}

        {pending.type === 'settleLeakSwap' ? (
          <div>
            <p>
              Application {(pending.params as SettleLeakSwapParams).appId}:{' '}
              {(pending.params as SettleLeakSwapParams).action === 'claim'
                ? 'claim ALGO to the agreed XMR holder address'
                : 'refund ALGO to the agreed ALGO holder address'}
              .
            </p>
            <p>
              Algorand fee:{' '}
              {(pending.params as SettleLeakSwapParams).action === 'claim'
                ? '8 times the network minimum transaction fee, reimbursed from the sponsor. Claim also applies the agreed protocol fee.'
                : '7 times the network minimum transaction fee, reimbursed from the sponsor.'}
            </p>
            <p className="error">
              Approval discloses this swap spend key to your Algorand node during simulation, even
              if settlement fails. Zebgen submits the transaction directly; confirmation is not
              guaranteed.
            </p>
          </div>
        ) : null}

        {pending.type === 'saveLeakSwap' ? (
          <p>Application {(pending.params as ZebgenSaveLeakSwapParams).appId}</p>
        ) : null}
        {pending.type === 'depositLeakSwapMonero' && stage !== 'deposit' ? (
          <p>Application {(pending.params as ZebgenDepositLeakSwapMoneroParams).appId}</p>
        ) : null}
        {pending.type === 'getMoneroShareInfo' ? (
          <p className="privacy-notice">
            This separate swap-sharing approval shares your Monero private view key, public spend
            key, and public address with this site. The private view key can expose incoming
            transactions. Your mnemonic and private spend key are not shared.
          </p>
        ) : null}
        {pending.type === 'createSwapInvite' || pending.type === 'acceptSwapInvite' ? (
          <div>
            <p>Sign the swap agreement. No funds are transferred.</p>
            <p className="privacy-notice">
              The site and recipient can see incoming swap transfers. Your normal wallet's private
              keys stay private.
            </p>
            <details>
              <summary>What this signature shares</summary>
              <p>
                Approval creates and stores an encrypted, dedicated LeakSwap key share before
                signing the link. Accepting the same invite again reuses its saved share. Your
                normal Monero funding wallet is unchanged.
              </p>
              <p>
                The link shares the swap share's private view key and public spend key. The view key
                exposes incoming swap transactions. Your normal wallet's private view key and all
                private spend keys stay private. Swap shares are not receive or send wallets.
              </p>
            </details>
            {(() => {
              const terms =
                pending.type === 'createSwapInvite'
                  ? (pending.params as SwapInviteTerms)
                  : reviewOffer?.payload;
              if (!terms) return <p>{reviewError ?? 'Verifying invite...'}</p>;
              return (
                <>
                  <SwapFeeDisclosure grossMicroAlgos={BigInt(terms.algoAmount)} />
                  <dl>
                    <dt>XMR</dt>
                    <dd>
                      {(BigInt(terms.xmrAmount) / 1000000000000n).toString()}.
                      {(BigInt(terms.xmrAmount) % 1000000000000n).toString().padStart(12, '0')}
                    </dd>
                    <dt>Deposit deadline</dt>
                    <dd>{`Round ${terms.t0}`}</dd>
                    <dt>Final expiry</dt>
                    <dd>{`Round ${terms.t1}`}</dd>
                    <dt>Estimated claim window</dt>
                    <dd>
                      {Math.ceil(((terms.t1 - terms.t0) * 2.7) / 60)}-
                      {Math.ceil(((terms.t1 - terms.t0) * 3) / 60)} minutes
                    </dd>
                    {reviewOffer ? (
                      <>
                        <dt>ALGO holder</dt>
                        <dd title={reviewOffer.payload.aliAlgoAddress}>
                          {reviewOffer.payload.aliAlgoAddress.slice(0, 8)}...
                          {reviewOffer.payload.aliAlgoAddress.slice(-8)}
                        </dd>
                        <dt>Monero network</dt>
                        <dd>{reviewOffer.payload.moneroNetwork}</dd>
                      </>
                    ) : null}
                  </dl>
                  {reviewOffer ? (
                    <details>
                      <summary>Counterparty and chain details</summary>
                      <dl>
                        <dt>ALGO holder address</dt>
                        <dd style={{ overflowWrap: 'anywhere' }}>
                          {reviewOffer.payload.aliAlgoAddress}
                        </dd>
                        <dt>Algorand genesis</dt>
                        <dd style={{ overflowWrap: 'anywhere' }}>
                          {reviewOffer.payload.algoGenesisHash}
                        </dd>
                      </dl>
                    </details>
                  ) : null}
                </>
              );
            })()}
          </div>
        ) : null}
        {pending.type === 'listLeakSwaps' ? (
          <p className="privacy-notice">
            Shares saved swap identities and private view keys with this page. Private spend keys
            are not shared.
          </p>
        ) : null}
        {pending.type === 'saveLeakSwap' &&
        (pending.params as ZebgenSaveLeakSwapParams).settlementTxId ? (
          <p>
            Save the confirmed claim or refund outcome for this swap. Zebgen checks the transaction
            on-chain; no funds will be sent.
          </p>
        ) : null}
        {pending.type === 'recoverLeakSwapMonero' ? (
          <p>
            {(pending.params as RecoverLeakSwapParams).inspectOnly
              ? `Verify confirmed settlement history for saved application ${(pending.params as RecoverLeakSwapParams).appId}. Saves a verified receipt only; no wallet recovery or funds transfer.`
              : `Recover Monero for saved application ${(pending.params as RecoverLeakSwapParams).appId} from a confirmed leaky claim or refund. Saves the combined wallet without switching accounts or sending funds.`}{' '}
            Private spend keys stay in Zebgen.
          </p>
        ) : null}

        {pending.type === 'scanCombinedMoneroFunding' ? (
          <p className="hint">
            View-only scan of combined-address received outputs. Spent status is unknown; these
            totals cannot prove funds remain available. Private spend keys and the combined private
            view key are not returned by this request.
          </p>
        ) : null}

        {isBusy && pending.type === 'scanCombinedMoneroFunding' ? (
          <ScanApprovalProgress progress={scanProgress} />
        ) : null}
        {isBusy && pending.type === 'acceptSwapInvite' ? (
          <section aria-label="Invitation funding verification">
            <div>
              <p>
                Checking the selected wallet's spendable XMR against the agreed amount plus a
                preliminary 0.001 XMR fee allowance. The exact fee is checked when you prepare the
                actual deposit. No XMR is sent or reserved.
              </p>
              <ScanApprovalProgress progress={scanProgress} purpose="acceptance" />
            </div>
          </section>
        ) : null}

        {stage === 'consent' ? (
          <ConnectDisclosure
            accounts={connectAccounts}
            choices={choices}
            disabled={isBusy}
            onChange={setConnectAccounts}
          />
        ) : null}
        {stage === 'deposit' && deposit ? (
          <LeakSwapDeposit
            params={pending.params as ZebgenDepositLeakSwapMoneroParams}
            target={deposit.target}
            accounts={deposit.accounts}
            origin={pending.origin}
            secret={secret}
            onComplete={(result) => respond(true, result)}
            onCancel={onReject}
          />
        ) : stage === 'consent' ? (
          <div className="seed-reveal-actions">
            <button type="button" className="secondary" onClick={onReject} disabled={isBusy}>
              Deny
            </button>
            <button type="button" onClick={onApproveConnect} disabled={isBusy || !connectAccounts}>
              {isBusy ? 'Connecting...' : 'Allow'}
            </button>
          </div>
        ) : (
          <form className="import-form" onSubmit={onUnlockAndApprove}>
            <label htmlFor="external-secret">Password or PIN</label>
            <input
              id="external-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Enter your password or PIN"
              autoFocus
              required
            />
            <div className="seed-reveal-actions">
              <button
                type="button"
                className="secondary"
                onClick={onReject}
                disabled={
                  isBusy &&
                  pending.type !== 'scanCombinedMoneroFunding' &&
                  approvalPhase !== 'monero'
                }
              >
                {isBusy &&
                (pending.type === 'scanCombinedMoneroFunding' || approvalPhase === 'monero')
                  ? 'Cancel scan'
                  : 'Deny'}
              </button>
              <button
                type="submit"
                disabled={
                  isBusy || !secret || (pending.type === 'acceptSwapInvite' && !reviewOffer)
                }
              >
                {isBusy
                  ? pending.type === 'signAlgorandTransactions'
                    ? APPROVAL_PHASE_LABELS[approvalPhase]
                    : 'Approving...'
                  : pending.type === 'depositLeakSwapMonero'
                    ? 'Unlock and review deposit'
                    : 'Unlock and Approve'}
              </button>
            </div>
          </form>
        )}

        {error ? <p className="error">{error}</p> : null}
        {isBusy && pending.type === 'signAlgorandTransactions' ? (
          <p role="status">
            {approvalPhase === 'monero' && scanProgress
              ? `Checking Monero deposit: block ${scanProgress.scannedHeight.toLocaleString()} of ${scanProgress.targetHeight.toLocaleString()}`
              : APPROVAL_PHASE_LABELS[approvalPhase]}
          </p>
        ) : isBusy &&
          scanProgress &&
          pending.type !== 'scanCombinedMoneroFunding' &&
          pending.type !== 'acceptSwapInvite' ? (
          <p role="status">
            Scanning Monero: block {scanProgress.scannedHeight.toLocaleString()} of{' '}
            {scanProgress.targetHeight.toLocaleString()}
          </p>
        ) : null}
      </section>
    </main>
  );
}

async function computeResult(
  pending: PendingZebgenRequest,
  secret: string,
  control?: MoneroFundingControl,
  onPhase?: (phase: ApprovalPhase) => void,
): Promise<unknown> {
  assertAgreementBound(pending.type, pending.params);
  await assertConnectionAccounts(pending.origin, pending.params);
  const networkSettings = await getNetworkSettings();
  if (pending.type === 'settleLeakSwap')
    return settleLeakSwap(
      pending.params as SettleLeakSwapParams,
      secret,
      pending.origin,
      control?.signal,
    );
  if (pending.type === 'recoverLeakSwapMonero')
    return recoverLeakSwap(pending.params as RecoverLeakSwapParams, secret);
  if (pending.type === 'createSwapInvite')
    return createSwapInvite(pending.params as SwapInviteTerms, secret, pending.origin);
  if (pending.type === 'acceptSwapInvite') {
    onPhase?.('monero');
    return acceptSwapInvite(
      (pending.params as { link: string }).link,
      secret,
      control,
      pending.origin,
    );
  }
  if (pending.type === 'confirmSwapAcceptance')
    return confirmSwapAcceptance((pending.params as { link: string }).link, secret);

  if (pending.type === 'getAlgorandAddress') {
    const params = pending.params as { addressIndex?: number };
    const derived = await deriveActiveSeedAlgoAddressAtIndex(secret, params.addressIndex ?? 0);
    return { algoAddress: derived.algoAddress, addressIndex: derived.addressIndex };
  }

  if (pending.type === 'getMoneroShareInfo') {
    const params = pending.params as { moneroWalletId?: number; agreementDigest?: string };
    const walletId = await resolveSwapWalletId(
      params.agreementDigest,
      secret,
      params.moneroWalletId,
    );
    const material = await unlockMoneroWallet(secret, networkSettings.monero.networkType, walletId);
    if (!material) {
      throw new Error('No Monero wallet found. Create one in the wallet first.');
    }
    return {
      address: material.address,
      publicSpendKey: material.publicSpendKey,
      privateViewKey: material.privateViewKey,
    };
  }

  if (pending.type === 'computeCombinedMoneroAddress') {
    const params = pending.params as {
      agreementDigest?: string;
      moneroWalletId?: number;
      counterpartyPrivateViewKey: string;
      counterpartyPublicSpendKey: string;
    };
    await assertCounterparty(params, secret);
    const walletId = await resolveSwapWalletId(
      params.agreementDigest,
      secret,
      params.moneroWalletId,
    );
    if (walletId === null)
      throw new Error('No Monero wallet found. Create one in the wallet first.');
    const material = await unlockMoneroWallet(secret, networkSettings.monero.networkType, walletId);
    if (!material) {
      throw new Error('No Monero wallet found. Create one in the wallet first.');
    }
    const combined = computeCombinedAddressWithPrivateAndPublic(
      material.privateSpendKey,
      material.privateViewKey,
      params.counterpartyPrivateViewKey,
      params.counterpartyPublicSpendKey,
      networkSettings.monero.networkType,
    );
    const saved = await loadMoneroCombinedContext(
      {
        walletId,
        network: networkSettings.monero.network,
        combinedAddress: combined.combinedAddress,
      },
      secret,
    );
    const height = saved?.restoreHeight ?? (await currentRestoreHeight(networkSettings.monero));
    const legacyHeight = await swapAddressHeight(combined.combinedAddress);
    const restoreHeight = Math.min(
      height ?? 0,
      fundingRestoreHeight(undefined, legacyHeight ?? height),
    );
    await saveMoneroCombinedContext(
      {
        version: 1,
        walletId,
        network: networkSettings.monero.network,
        combinedAddress: combined.combinedAddress,
        counterpartyPublicSpendKey: params.counterpartyPublicSpendKey,
        counterpartyPrivateViewKey: params.counterpartyPrivateViewKey,
        restoreHeight,
      },
      secret,
    );
    await rememberSwapAddressHeight(combined.combinedAddress, restoreHeight);
    return combined;
  }

  if (pending.type === 'scanCombinedMoneroFunding') {
    const params = pending.params;
    validateFundingParams(params);
    await assertCounterparty(params, secret);
    const walletId = await resolveSwapWalletId(
      params.agreementDigest,
      secret,
      params.moneroWalletId,
    );
    if (walletId === null)
      throw new Error('No Monero wallet found. Create one in the wallet first.');
    const material = await unlockMoneroWallet(secret, networkSettings.monero.networkType, walletId);
    if (!material) throw new Error('No Monero wallet found. Create one in the wallet first.');
    const combined = computeCombinedAddressWithPrivateAndPublic(
      material.privateSpendKey,
      material.privateViewKey,
      params.counterpartyPrivateViewKey,
      params.counterpartyPublicSpendKey,
      networkSettings.monero.networkType,
    );
    const saved = await loadMoneroCombinedContext(
      {
        walletId,
        network: networkSettings.monero.network,
        combinedAddress: combined.combinedAddress,
      },
      secret,
    );
    const restoreHeight = fundingRestoreHeight(
      params.restoreHeight,
      saved?.restoreHeight ?? (await swapAddressHeight(combined.combinedAddress)),
    );
    const funding = await scanMoneroFunding(
      networkSettings.monero,
      combined.combinedPublicSpendKey,
      combinePrivateSpendKeys(material.privateViewKey, params.counterpartyPrivateViewKey),
      restoreHeight,
      control,
    );
    return { ...funding, combinedAddress: combined.combinedAddress };
  }

  if (pending.type === 'signAlgorandTransactions') {
    const params =
      pending.params as import('../../lib/provider/types').ZebgenSignAlgorandTransactionsParams;
    onPhase?.('validating');
    await validateAgreementSigning(params, secret, control);
    control?.signal?.throwIfAborted();
    onPhase?.('signing');
    const unsignedTxns = params.indexesToSign.map((index) => base64ToBytes(params.txns[index]));
    const signed = await signRawTransactions(secret, params.addressIndex ?? 0, unsignedTxns);
    await journalSignedAlgorandTransactions(unsignedTxns, pending.origin, secret);
    return { signedTxns: signed.map((bytes) => bytesToBase64(bytes)) };
  }

  if (pending.type === 'saveLeakSwap')
    return saveVerifiedLeakSwap(pending.params as ZebgenSaveLeakSwapParams, secret, pending.origin);
  if (pending.type === 'listLeakSwaps') return listVerifiedLeakSwaps(secret, pending.origin);

  if (pending.type === 'computeMoneroLeakySignature') {
    const params = pending.params as {
      moneroWalletId?: number;
      messageHex: string;
      agreementDigest?: string;
      agreementAppId?: string;
    };
    const walletId = await resolveSwapWalletId(
      params.agreementDigest,
      secret,
      params.moneroWalletId,
    );
    if (params.agreementDigest) {
      if (!params.agreementAppId) throw new Error('Agreement application ID is required.');
      await verifyAgreementApplication(
        params.agreementDigest,
        BigInt(params.agreementAppId),
        secret,
      );
      if (
        params.messageHex.toLowerCase() !==
        bytesToHex(
          algosdk.decodeAddress(
            algosdk.getApplicationAddress(BigInt(params.agreementAppId)).toString(),
          ).publicKey,
        )
      )
        throw new Error('Leaky signature message does not match the agreement application.');
    }
    const material = await unlockMoneroWallet(secret, networkSettings.monero.networkType, walletId);
    if (!material) {
      throw new Error('No Monero wallet found. Create one in the wallet first.');
    }
    const signature = leakySign(
      hexToBytes(params.messageHex),
      hexToBytes(material.privateSpendKey),
    );
    return { signatureHex: bytesToHex(signature) };
  }

  throw new Error(`Unsupported request type: ${pending.type}`);
}

async function assertCounterparty(
  params: {
    agreementDigest?: string;
    counterpartyPublicSpendKey: string;
    counterpartyPrivateViewKey: string;
  },
  secret: string,
) {
  if (!params.agreementDigest) return;
  const agreement = await loadAcceptedSwap(params.agreementDigest, secret);
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  const ali = agreement.offer.payload.aliAlgoAddress === algoAddress;
  const publicKey = ali
    ? agreement.acceptance.payload.xinPublicSpendKey
    : agreement.offer.payload.aliPublicSpendKey;
  const viewKey = ali
    ? agreement.acceptance.payload.xinPrivateViewKey
    : agreement.offer.payload.aliPrivateViewKey;
  if (
    params.counterpartyPublicSpendKey !== publicKey ||
    params.counterpartyPrivateViewKey !== viewKey
  )
    throw new Error('Counterparty keys do not match the agreement.');
}

function summarizeTransactions(params: unknown): string[] {
  const { txns, indexesToSign } = params as { txns: string[]; indexesToSign: number[] };
  return indexesToSign.map((index) => {
    try {
      const txn = algosdk.decodeUnsignedTransaction(base64ToBytes(txns[index]));
      return `#${index + 1}: ${describeDecodedTransaction(txn)}`;
    } catch {
      return `#${index + 1}: Unable to decode transaction for preview.`;
    }
  });
}

function describeDecodedTransaction(txn: algosdk.Transaction): string {
  const type = txn.type;
  if (type === algosdk.TransactionType.pay && txn.payment) {
    return `Payment of ${txn.payment.amount} microAlgos to ${txn.payment.receiver.toString()}`;
  }
  if (type === algosdk.TransactionType.appl && txn.applicationCall) {
    const appId = txn.applicationCall.appIndex;
    const args = txn.applicationCall.appArgs ?? [];
    const methodSelector = args[0] ? Buffer.from(args[0]).toString('hex') : undefined;
    return appId === 0n
      ? `Create application (method selector 0x${methodSelector ?? ''})`
      : `App call to application ${appId} (method selector 0x${methodSelector ?? ''})`;
  }
  return `${type} transaction`;
}

function describeRequest(pending: PendingZebgenRequest): string {
  switch (pending.type) {
    case 'connect':
      return 'Connect to Zebgen Wallet';
    case 'getAlgorandAddress':
      return 'Share Algorand Address';
    case 'getMoneroShareInfo':
      return 'Share Monero Key Material';
    case 'computeCombinedMoneroAddress':
      return 'Compute Combined Monero Address';
    case 'scanCombinedMoneroFunding':
      return 'Check Combined Monero Funding (View Only)';
    case 'saveLeakSwap':
      return (pending.params as ZebgenSaveLeakSwapParams).settlementTxId
        ? 'Save Confirmed Swap Settlement'
        : 'Save LeakSwap Recovery Record';
    case 'depositLeakSwapMonero':
      return 'Deposit Monero for Accepted LeakSwap';
    case 'settleLeakSwap':
      return (pending.params as SettleLeakSwapParams).action === 'claim'
        ? 'Claim LeakSwap ALGO'
        : 'Refund LeakSwap ALGO';
    case 'listLeakSwaps':
      return 'Share Saved LeakSwaps';
    case 'recoverLeakSwapMonero':
      return 'Claim XMR: Recover Saved Swap Wallet';
    case 'createSwapInvite':
      return 'Authenticate LeakSwap Offer';
    case 'acceptSwapInvite':
      return 'Authenticate LeakSwap Acceptance';
    case 'confirmSwapAcceptance':
      return 'Verify Acceptance Against Saved Offer';
    case 'signAlgorandTransactions':
      return requestsSwapReady(
        pending.params as import('../../lib/provider/types').ZebgenSignAlgorandTransactionsParams,
      )
        ? 'Confirm Swap Ready'
        : 'Sign Algorand Transaction';
    case 'computeMoneroLeakySignature':
      return 'Sign LeakSwap Claim/Refund (reveals Monero key)';
    default:
      return 'Zebgen Wallet Request';
  }
}

export default ExternalRequestApp;
