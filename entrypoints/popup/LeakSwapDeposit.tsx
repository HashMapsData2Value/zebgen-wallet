import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ZebgenDepositLeakSwapMoneroParams,
  ZebgenDepositLeakSwapMoneroResult,
} from '../../lib/provider/types';
import {
  assertConnectionAccounts,
  type ConnectionAccounts,
} from '../../lib/provider/connectionApproval';
import {
  resolveLeakSwapDeposit,
  assertSameDepositTarget,
  type LeakSwapDepositTarget,
} from '../../lib/wallet/leakSwapDeposit';
import {
  discardTransactionsViaBackground,
  prepareTransactionViaBackground,
  submitTransactionViaBackground,
} from '../../lib/network/messages';
import { ensureHostPermissions } from '../../lib/network/hostPermissions';
import { formatAtomic } from '../../lib/wallet/formatAtomic';
import type { TransactionReview } from '../../lib/wallet/transactionService';
import CopyValue from './CopyValue';
import { LoaderCircle } from 'lucide-react';
import './LeakSwapDeposit.css';

interface Props {
  params: ZebgenDepositLeakSwapMoneroParams;
  target: LeakSwapDepositTarget;
  origin: string;
  accounts: ConnectionAccounts;
  secret: string;
  onComplete: (result: ZebgenDepositLeakSwapMoneroResult) => Promise<void>;
  onCancel: () => Promise<void>;
}

export default function LeakSwapDeposit(props: Props) {
  const [review, setReview] = useState<TransactionReview | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [receipt, setReceipt] = useState<ZebgenDepositLeakSwapMoneroResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    active.current = true;
    const discard = () => {
      active.current = false;
      void discardTransactionsViaBackground().catch((failure) =>
        console.error('Unable to discard deposit', failure),
      );
    };
    window.addEventListener('pagehide', discard);
    return () => {
      window.removeEventListener('pagehide', discard);
      discard();
    };
  }, []);

  async function revalidate() {
    await assertConnectionAccounts(props.origin, props.params, props.accounts);
    const target = await resolveLeakSwapDeposit(props.params, props.secret);
    assertSameDepositTarget(props.target, target);
    await assertConnectionAccounts(props.origin, props.params, props.accounts);
    if (!active.current) throw new Error('Deposit cancelled.');
  }

  async function prepare() {
    if (running.current || terminal) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await ensureHostPermissions([props.target.config.daemon.uri]);
      await revalidate();
      const response = await prepareTransactionViaBackground({
        chain: 'monero',
        primaryAddress: props.target.sender,
        recipient: props.target.recipient,
        amountAtomic: props.target.amountAtomic,
        walletId: props.target.walletId,
        config: props.target.config,
        restoreHeight: props.target.restoreHeight,
        sweep: false,
        lockSecret: props.secret,
        deposit: props.target,
      });
      if (!response.ok) {
        if (response.code === 'deposit-exists') {
          setTerminal(true);
          setReview(null);
        }
        throw new Error(response.error);
      }
      if (!active.current || response.review.amountAtomic !== props.target.amountAtomic) {
        await discardTransactionsViaBackground();
        throw new Error(
          'Prepared deposit amount does not match the agreement or request was cancelled.',
        );
      }
      setReview(response.review);
    } catch (failure) {
      console.error('Deposit preparation failed', failure);
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (running.current || terminal || !review || !password) return;
    running.current = true;
    setBusy(true);
    setError(null);
    const freshSecret = password;
    setPassword('');
    try {
      await revalidate();
      const response = await submitTransactionViaBackground(review.id, freshSecret);
      if (!response.ok) {
        if (response.uncertain) {
          setTerminal(true);
          setReview(null);
        }
        if (response.code === 'review-expired') setReview(null);
        throw new Error(response.error);
      }
      const result = {
        transactionHash: response.review.hash,
        amountAtomic: response.review.amountAtomic,
        feeAtomic: response.review.feeAtomic,
      };
      setTerminal(true);
      setReview(null);
      setReceipt(result);
      await props.onComplete(result);
    } catch (failure) {
      console.error('Deposit send failed', failure);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function cancel() {
    if (running.current) return;
    active.current = false;
    setTerminal(true);
    setPassword('');
    try {
      await discardTransactionsViaBackground();
      await props.onCancel();
    } catch (failure) {
      console.error('Deposit cancellation failed', failure);
      setError(String(failure));
    }
  }

  return (
    <div className="transaction-builder">
      {busy ? (
        <section className="deposit-progress" role="status" aria-live="polite" aria-atomic="true">
          <LoaderCircle className="deposit-progress-spinner" size={32} aria-hidden="true" />
          <div>
            <h3>{review ? 'Sending Monero deposit' : 'Preparing Monero deposit'}</h3>
            <p>
              {review
                ? 'Checking the swap and submitting your signed transaction. Keep this window open.'
                : 'Checking the swap, scanning your funding wallet, and calculating the transaction fee. This can take a minute or longer.'}
            </p>
            <span className="deposit-progress-time" aria-live="off">
              Elapsed: {elapsed}s
            </span>
          </div>
        </section>
      ) : null}
      <dl>
        <dt>Application</dt>
        <dd>{props.params.appId}</dd>
        <dt>Network</dt>
        <dd>{props.target.config.network}</dd>
        <dt>Funding wallet</dt>
        <dd style={{ overflowWrap: 'anywhere' }}>
          <code>{props.target.sender}</code>
          <CopyValue label="Funding wallet" value={props.target.sender} />
        </dd>
        <dt>Swap deposit address</dt>
        <dd style={{ overflowWrap: 'anywhere' }}>
          <code>{props.target.recipient}</code>
          <CopyValue label="Swap deposit address" value={props.target.recipient} />
        </dd>
        <dt>Amount</dt>
        <dd>{formatAtomic(props.target.amountAtomic, 12)} XMR</dd>
        {review ? (
          <>
            <dt>Transaction fee</dt>
            <dd>{formatAtomic(review.feeAtomic, 12)} XMR</dd>
            <dt>Total</dt>
            <dd>{formatAtomic(BigInt(review.amountAtomic) + BigInt(review.feeAtomic), 12)} XMR</dd>
          </>
        ) : null}
      </dl>
      {receipt ? (
        <p role="status" style={{ overflowWrap: 'anywhere' }}>
          Relayed <code>{receipt.transactionHash}</code>
          <CopyValue label="Transaction hash" value={receipt.transactionHash} />
        </p>
      ) : null}
      {review && !terminal ? (
        <form className="import-form" onSubmit={send}>
          <label htmlFor="deposit-send-secret">Password or PIN</label>
          <input
            id="deposit-send-secret"
            type="password"
            autoComplete="off"
            required
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" disabled={busy || !password}>
            {busy ? 'Sending...' : 'Send deposit'}
          </button>
        </form>
      ) : !terminal ? (
        <button type="button" disabled={busy} onClick={prepare}>
          {busy ? 'Preparing...' : 'Review deposit and fee'}
        </button>
      ) : null}
      <button type="button" className="secondary" disabled={busy} onClick={cancel}>
        {receipt ? 'Close' : 'Cancel'}
      </button>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
