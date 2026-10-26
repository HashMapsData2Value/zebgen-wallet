import { FormEvent, useEffect, useRef, useState } from 'react';

import {
  discardTransactionsViaBackground,
  prepareTransactionViaBackground,
  submitTransactionViaBackground,
  scanMoneroBalanceViaBackground,
  transactionStatusViaBackground,
} from '../../lib/network/messages';
import ScanActivity from './ScanActivity';
import { sanitizeBlockHeight } from '../../lib/monero/scanHeight';
import MoneroChainHeight from './MoneroChainHeight';
import MoneroConfirmation from './MoneroConfirmation';
import type { TransactionStatus } from '../../lib/wallet/transactionStatus';
import { getAlgoBalance } from '../../lib/algorand/algodClient';
import { RefreshCw } from 'lucide-react';
import { ensureHostPermissions } from '../../lib/network/hostPermissions';
import type {
  AlgodEndpoint,
  AlgorandNetworkId,
  MoneroNetworkConfig,
} from '../../lib/network/networks';
import { networkLabel } from '../../lib/network/networks';
import type { TransactionReview } from '../../lib/wallet/transactionService';
import { formatAtomic } from '../../lib/wallet/formatAtomic';
import CopyValue from './CopyValue';
import { addressValidationError } from '../../lib/wallet/addressValidation';
import { balanceCheckpointKey, loadBalanceCheckpoint } from '../../lib/wallet/moneroBalanceCache';

function parseUnits(value: string, decimals: number, allowZero = false): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error('Enter a valid positive amount.');
  }
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount supports at most ${decimals} decimal places.`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (units === 0n && !allowZero) {
    throw new Error('Amount must be greater than zero.');
  }
  return units;
}

interface AlgorandTransactionBuilderProps {
  chain: 'algorand';
  sender: string;
  addressIndex: number;
  lockSecret: string;
  endpoint: AlgodEndpoint;
  network: AlgorandNetworkId;
}

interface MoneroTransactionBuilderProps {
  chain: 'monero';
  sender: string;
  config: MoneroNetworkConfig;
  walletId: number;
  lockSecret: string;
  defaultRestoreHeight?: number;
}

type TransactionBuilderProps = AlgorandTransactionBuilderProps | MoneroTransactionBuilderProps;

function TransactionBuilder(props: TransactionBuilderProps) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [restoreHeight, setRestoreHeight] = useState(
    String((props.chain === 'monero' && props.defaultRestoreHeight) || 0),
  );
  const [sendAll, setSendAll] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [transactionId, setTransactionId] = useState('');
  const [prepared, setPrepared] = useState<TransactionReview | null>(null);
  const [balance, setBalance] = useState<{ key: string; atomic: string } | null>(null);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [approvalSecret, setApprovalSecret] = useState('');
  const [receiptStatus, setReceiptStatus] = useState<TransactionStatus | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptRefresh, setReceiptRefresh] = useState(0);
  const [sentAmount, setSentAmount] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<{
    scannedHeight: number;
    targetHeight: number;
  }>();
  const balanceGeneration = useRef(0);
  const balanceController = useRef<AbortController | null>(null);
  const balanceKey = JSON.stringify(
    props.chain === 'algorand'
      ? [props.chain, props.sender, props.network, props.endpoint]
      : [props.chain, props.sender, props.walletId, props.config, restoreHeight],
  );

  useEffect(() => {
    balanceController.current?.abort('detach');
    let active = true;
    balanceGeneration.current += 1;
    setBalance(null);
    setBalanceError(null);
    setBalanceBusy(false);
    if (props.chain === 'monero') {
      void loadBalanceCheckpoint(
        balanceCheckpointKey(
          props.config.network,
          props.config.daemon.uri,
          props.sender,
          Number(restoreHeight),
        ),
        props.lockSecret,
      )
        .then((checkpoint) => {
          if (active && checkpoint)
            setBalance({ key: balanceKey, atomic: checkpoint.balanceAtomic });
        })
        .catch((failure) => {
          console.error('Unable to restore send balance', failure);
          if (active)
            setBalanceError(
              'Saved balance unavailable. Transaction review will check spendable funds.',
            );
        });
      return () => {
        active = false;
        balanceGeneration.current += 1;
        balanceController.current?.abort('detach');
      };
    }
    async function refresh() {
      if (props.chain !== 'algorand') return;
      const result = await getAlgoBalance(props.endpoint, props.sender, props.network);
      if (!active) return;
      if (result.ok && result.spendableAtomic !== undefined) {
        setBalance({ key: balanceKey, atomic: result.spendableAtomic });
        setBalanceError(null);
      } else {
        setBalance(null);
        setBalanceError(result.error ?? 'Balance unavailable.');
        console.error('Send balance lookup failed', result.error);
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      balanceGeneration.current += 1;
      window.clearInterval(timer);
    };
  }, [balanceKey]);

  useEffect(
    () => () => {
      discardTransactionsViaBackground().catch((failure) =>
        console.error('Unable to discard prepared transaction', failure),
      );
    },
    [],
  );

  useEffect(() => {
    if (!transactionId) return;
    let active = true;
    let busy = false;
    async function check() {
      if (busy) return;
      busy = true;
      try {
        const response = await transactionStatusViaBackground(
          props.chain === 'algorand'
            ? { chain: 'algorand', endpoint: props.endpoint, hash: transactionId }
            : { chain: 'monero', config: props.config, hash: transactionId },
        );
        if (!response.ok) throw new Error(response.error);
        if (active) {
          setReceiptStatus(response.status);
          setReceiptError(null);
        }
      } catch (failure) {
        console.error('Receipt status lookup failed', failure);
        if (active) setReceiptError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        busy = false;
      }
    }
    void check();
    const timer = window.setInterval(check, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [transactionId, receiptRefresh]);

  const decimals = props.chain === 'algorand' ? 6 : 12;
  const symbol = props.chain === 'algorand' ? 'ALGO' : 'XMR';
  const sender = props.sender;
  const network = props.chain === 'algorand' ? props.network : props.config.network;
  const isSweep = props.chain === 'monero' && sendAll;
  const recipientError = addressValidationError(props.chain, recipient, network);
  const recipientStatus = recipient.trim() ? (recipientError ? 'invalid' : 'valid') : undefined;
  const available = balance?.key === balanceKey ? balance.atomic : null;
  let amountError: string | null = null;
  if (amount.trim() && !isSweep) {
    try {
      const units = parseUnits(amount, decimals, props.chain === 'algorand');
      if (available !== null && props.chain === 'algorand' && units + 1000n > BigInt(available)) {
        amountError = `Insufficient funds. ${formatAtomic(available, decimals)} ${symbol} available before transaction fees${props.chain === 'algorand' ? ' (account minimum reserved)' : ' (unlocked)'}.`;
      }
    } catch (failure) {
      amountError = failure instanceof Error ? failure.message : 'Invalid amount.';
    }
  }

  async function checkMoneroBalance() {
    if (props.chain !== 'monero') return;
    balanceController.current?.abort('detach');
    const controller = new AbortController();
    balanceController.current = controller;
    const generation = ++balanceGeneration.current;
    setBalanceBusy(true);
    setScanProgress(undefined);
    setBalanceError(null);
    setBalance(null);
    try {
      const height = Number(restoreHeight);
      if (!/^\d+$/.test(restoreHeight) || !Number.isSafeInteger(height))
        throw new Error('Enter a non-negative restore height.');
      await ensureHostPermissions([props.config.daemon.uri]);
      controller.signal.throwIfAborted();
      const response = await scanMoneroBalanceViaBackground(
        {
          config: props.config,
          primaryAddress: sender,
          walletId: props.walletId,
          lockSecret: props.lockSecret,
          restoreHeight: height,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (generation === balanceGeneration.current) setScanProgress(progress);
          },
        },
      );
      controller.signal.throwIfAborted();
      if (!response.ok || response.balanceAtomic === undefined)
        throw new Error(response.error ?? 'Unable to scan balance.');
      if (generation === balanceGeneration.current)
        setBalance({ key: balanceKey, atomic: response.balanceAtomic });
    } catch (failure) {
      if (controller.signal.aborted) return;
      console.error('Send balance scan failed', failure);
      if (generation === balanceGeneration.current)
        setBalanceError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (generation === balanceGeneration.current) setBalanceBusy(false);
    }
  }

  function stopBalanceScan() {
    balanceGeneration.current += 1;
    balanceController.current?.abort();
    setBalanceBusy(false);
    setBalanceError('Scan stopped.');
  }

  function resetReview() {
    setApprovalSecret('');
    discardTransactionsViaBackground().catch((failure) =>
      console.error('Unable to discard prepared transaction', failure),
    );
    setPrepared(null);
    setIsReviewing(false);
    setResult(null);
    setTransactionId('');
    setReceiptStatus(null);
    setReceiptError(null);
  }

  async function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      if (recipientError) throw new Error(recipientError);
      if (amountError) throw new Error(amountError);
      await ensureHostPermissions([
        props.chain === 'algorand' ? props.endpoint.server : props.config.daemon.uri,
      ]);
      if (!isSweep) {
        parseUnits(amount, decimals, props.chain === 'algorand');
      }
      if (!recipient.trim()) {
        throw new Error('Recipient address is required.');
      }
      if (props.chain === 'monero') {
        const height = Number(restoreHeight);
        if (!/^\d+$/.test(restoreHeight) || !Number.isSafeInteger(height) || height < 0) {
          throw new Error('Restore height must be a non-negative integer.');
        }
      }
      const common = {
        primaryAddress: sender,
        recipient: recipient.trim(),
        amountAtomic: isSweep
          ? '0'
          : parseUnits(amount, decimals, props.chain === 'algorand').toString(),
        lockSecret: props.lockSecret,
      };
      const response = await prepareTransactionViaBackground(
        props.chain === 'algorand'
          ? {
              ...common,
              chain: 'algorand',
              addressIndex: props.addressIndex,
              endpoint: props.endpoint,
              network: props.network,
              note,
            }
          : {
              ...common,
              chain: 'monero',
              walletId: props.walletId,
              config: props.config,
              restoreHeight: Number(restoreHeight),
              sweep: sendAll,
            },
      );
      if (!response.ok) throw new Error(response.error);
      setPrepared(response.review);
      setIsReviewing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to review transaction.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onConfirm() {
    setError(null);
    setResult(null);
    setTransactionId('');
    setIsSubmitting(true);
    try {
      await ensureHostPermissions([
        props.chain === 'algorand' ? props.endpoint.server : props.config.daemon.uri,
      ]);
      if (!prepared) throw new Error('Prepare the transaction again.');
      const secret = approvalSecret;
      setApprovalSecret('');
      const sent = await submitTransactionViaBackground(prepared.id, secret);
      if (sent.review) setSentAmount(sent.review.amountAtomic);
      if (!sent.ok && sent.uncertain && sent.review) {
        setTransactionId(sent.review.hash);
        setPrepared(null);
        setIsReviewing(false);
        setResult(
          `Relay outcome unknown for ${sent.review.hash}. Check outgoing activity before creating another payment.`,
        );
        setError(sent.error);
        setBalance(null);
        return;
      }
      if (!sent.ok) throw new Error(sent.error);
      setBalance(null);
      setResult(
        `${props.chain === 'algorand' ? 'Submitted' : 'Relayed'} ${sent.review.hash} · amount ${formatAtomic(sent.review.amountAtomic, decimals)} ${symbol} · fee ${formatAtomic(sent.review.feeAtomic, decimals)} ${symbol}`,
      );
      setTransactionId(sent.review.hash);
      setPrepared(null);
      setIsReviewing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to submit transaction.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="transaction-builder">
      <div className="transaction-context">
        <span>{networkLabel(network)}</span>
        <code title={sender}>
          {sender.slice(0, 10)}...{sender.slice(-8)}
        </code>
      </div>

      {result ? null : !isReviewing ? (
        <form className="import-form" onSubmit={onReview}>
          <fieldset className="transaction-fields" disabled={isSubmitting}>
            <label htmlFor={`${props.chain}-tx-recipient`}>Recipient</label>
            <input
              id={`${props.chain}-tx-recipient`}
              data-address-status={recipientStatus}
              aria-invalid={recipientStatus === 'invalid'}
              aria-describedby={recipientStatus ? `${props.chain}-recipient-feedback` : undefined}
              value={recipient}
              onChange={(event) => {
                setRecipient(event.target.value);
                resetReview();
              }}
              placeholder={`${symbol} address`}
              autoComplete="off"
              required
            />
            {recipientStatus ? (
              <p
                id={`${props.chain}-recipient-feedback`}
                className={recipientError ? 'error' : 'probe-ok'}
                role={recipientError ? 'alert' : 'status'}
              >
                {recipientError ??
                  (props.chain === 'monero'
                    ? 'Valid address for the selected Monero network.'
                    : 'Valid Algorand address checksum. Confirm the recipient uses the selected network.')}
              </p>
            ) : null}
            <label htmlFor={`${props.chain}-tx-amount`}>Amount ({symbol})</label>
            <input
              id={`${props.chain}-tx-amount`}
              data-address-status={amountError ? 'invalid' : undefined}
              aria-invalid={!!amountError}
              aria-describedby={`${props.chain}-amount-feedback`}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                resetReview();
              }}
              placeholder="0.0"
              inputMode="decimal"
              required={!isSweep}
              disabled={isSweep}
            />
            <div id={`${props.chain}-amount-feedback`}>
              {amountError ? (
                <p className="error" role="alert">
                  {amountError}
                </p>
              ) : null}
              {available !== null ? (
                <p className="hint" role="status">
                  {props.chain === 'monero'
                    ? 'Last verified unlocked balance'
                    : 'Available before fees'}
                  : {formatAtomic(available, decimals)} {symbol}
                  {props.chain === 'algorand'
                    ? ' (account minimum reserved)'
                    : '. Transaction review rechecks spendable funds and fees.'}
                </p>
              ) : !balanceBusy ? (
                <p className="hint" role="status">
                  {props.chain === 'monero'
                    ? 'Transaction review will check spendable funds and fees. No separate balance scan is required.'
                    : 'Available balance not checked.'}
                </p>
              ) : null}
              {props.chain === 'monero' && (balanceBusy || isSubmitting) ? (
                <ScanActivity
                  restoreHeight={Number(restoreHeight)}
                  scannedHeight={scanProgress?.scannedHeight}
                  targetHeight={scanProgress?.targetHeight}
                  onStop={balanceBusy ? stopBalanceScan : undefined}
                />
              ) : null}
              {props.chain === 'monero' ? (
                <button
                  type="button"
                  className="secondary"
                  title="Scan unlocked balance"
                  aria-label="Scan unlocked balance"
                  disabled={balanceBusy || isSubmitting}
                  onClick={checkMoneroBalance}
                >
                  <RefreshCw
                    size={16}
                    style={{ flexShrink: 0 }}
                    className={balanceBusy ? 'is-spinning' : ''}
                  />{' '}
                  {balanceBusy ? 'Scanning...' : 'Update balance'}
                </button>
              ) : null}
              {balanceError ? (
                <p className="error" role="alert">
                  {balanceError}
                </p>
              ) : null}
            </div>
            {props.chain === 'algorand' ? (
              <>
                <label htmlFor="algorand-tx-note">Note (optional)</label>
                <input
                  id="algorand-tx-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={1024}
                />
              </>
            ) : (
              <>
                <label className="checkbox-label" htmlFor="monero-tx-send-all">
                  <input
                    id="monero-tx-send-all"
                    type="checkbox"
                    checked={sendAll}
                    onChange={(event) => {
                      setSendAll(event.target.checked);
                      resetReview();
                    }}
                  />
                  Send entire balance (minus fee)
                </label>
                <details className="transaction-scan-settings">
                  <summary>Scan settings</summary>
                  <label htmlFor="monero-restore-height">Wallet restore height</label>
                  <input
                    id="monero-restore-height"
                    value={restoreHeight}
                    onChange={(event) => setRestoreHeight(sanitizeBlockHeight(event.target.value))}
                    inputMode="numeric"
                    required
                  />
                  <MoneroChainHeight config={props.config} />
                  <p className="hint">
                    Scanning starts at this block. It's filled in from when this wallet (or swap)
                    was created; for an imported wallet, use a height at or before it first received
                    funds.
                  </p>
                </details>
                {Number(restoreHeight) === 0 ? (
                  <p className="privacy-notice">
                    Preparing from block 0 scans the full chain history and may use substantial
                    data.
                  </p>
                ) : null}
              </>
            )}
            <button type="submit" disabled={!!recipientError || !!amountError || balanceBusy}>
              {isSubmitting
                ? props.chain === 'monero'
                  ? 'Scanning and Preparing...'
                  : 'Preparing...'
                : 'Review Transaction'}
            </button>
          </fieldset>
        </form>
      ) : (
        <div className="transaction-review">
          <p>
            <span>From</span>
            <code>{sender}</code>
          </p>
          <p>
            <span>To</span>
            <code>{recipient.trim()}</code>
          </p>
          <p>
            <span>Amount{isSweep ? ' (entire unlocked balance minus fee)' : ''}</span>
            <strong>
              {prepared ? formatAtomic(prepared.amountAtomic, decimals) : amount} {symbol}
            </strong>
          </p>
          {prepared ? (
            <>
              <p>
                <span>Fee</span>
                <strong>
                  {formatAtomic(prepared.feeAtomic, decimals)} {symbol}
                </strong>
              </p>
              <p>
                <span>Total debit</span>
                <strong>
                  {formatAtomic(
                    (BigInt(prepared.amountAtomic) + BigInt(prepared.feeAtomic)).toString(),
                    decimals,
                  )}{' '}
                  {symbol}
                </strong>
              </p>
            </>
          ) : null}
          <p>
            <span>Network</span>
            <strong>{networkLabel(network)}</strong>
          </p>
          {props.chain === 'algorand' && note ? (
            <p>
              <span>Note</span>
              <code>{note}</code>
            </p>
          ) : null}
          {props.chain === 'monero' ? (
            <p>
              <span>Restore height</span>
              <strong>{restoreHeight}</strong>
            </p>
          ) : null}
          <form
            className="import-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            <label htmlFor="transaction-approval-secret">Password or PIN</label>
            <input
              id="transaction-approval-secret"
              type="password"
              autoComplete="off"
              value={approvalSecret}
              onChange={(event) => setApprovalSecret(event.target.value)}
              disabled={isSubmitting}
              required
            />
            <div className="transaction-actions">
              <button
                type="button"
                className="secondary"
                onClick={resetReview}
                disabled={isSubmitting}
              >
                Edit
              </button>
              <button type="submit" disabled={isSubmitting || !approvalSecret}>
                {isSubmitting ? 'Broadcasting...' : 'Confirm and Send'}
              </button>
            </div>
          </form>
        </div>
      )}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="transaction-result" role="status">
          <h3>
            {receiptStatus?.state === 'confirmed'
              ? 'Transaction confirmed'
              : receiptStatus?.state === 'rejected'
                ? 'Transaction rejected'
                : receiptStatus?.state === 'pool'
                  ? 'In transaction pool (0 confirmations)'
                  : receiptStatus?.state === 'unknown'
                    ? 'Transaction status unknown'
                    : 'Awaiting confirmation'}
          </h3>
          {sentAmount !== null ? (
            <p>
              <strong>
                {formatAtomic(sentAmount, decimals)} {symbol}
              </strong>
            </p>
          ) : null}
          <p>
            To: <code className="receipt-destination">{recipient}</code>
          </p>
          {props.chain === 'monero' ? (
            <MoneroConfirmation network={props.config.network} status={receiptStatus} />
          ) : null}
          {receiptStatus?.confirmations !== undefined ? (
            <p>Confirmations: {receiptStatus.confirmations}</p>
          ) : null}
          {receiptStatus?.detail ? <p className="error">{receiptStatus.detail}</p> : null}
          {receiptError ? (
            <p className="error">Confirmation check unavailable: {receiptError}</p>
          ) : null}
          <details>
            <summary>Transaction details</summary>
            <p className="result-value">{result}</p>
            {receiptStatus?.block ? (
              <p>
                {props.chain === 'algorand' ? 'Confirmed round' : 'Block height'}:{' '}
                <strong>{receiptStatus.block}</strong>
              </p>
            ) : null}
            {transactionId ? <CopyValue value={transactionId} label="transaction ID" /> : null}
          </details>
          <button
            type="button"
            className="icon-btn"
            title="Refresh confirmation"
            aria-label="Refresh confirmation"
            onClick={() => setReceiptRefresh((value) => value + 1)}
          >
            <RefreshCw size={18} />
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              resetReview();
              setAmount('');
              setRecipient('');
              setNote('');
            }}
          >
            New transaction
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default TransactionBuilder;
