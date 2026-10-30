import { ArrowLeftRight, ExternalLink, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import algosdk from 'algosdk';
import algorandLogo from '../../assets/algorand_logo.png';
import moneroLogo from '../../assets/monero_logo.png';
import { listSwapRecords } from '../../lib/wallet/swapRecords';
import { getNetworkSettings } from '../../lib/network/networkStore';
import { formatAtomic } from '../../lib/wallet/formatAtomic';
import { readSwapChainStatus, type SavedSwapStatus } from '../../lib/wallet/swapChainStatus';
import { swapStatus } from '../../lib/wallet/swapStatus';
import { listSwapShares } from '../../lib/wallet/swapShareVault';
import SwapRecoveryTools from './SwapRecoveryTools';
import SwapBackupTools from './SwapBackupTools';
import { formatRoundDeadline } from 'leakswap-utils/dist/swapTiming.js';
import { BETA_SWAP_ORIGIN, swapOrigin } from '../../lib/provider/swapOrigin';

interface LeakSwapPanelProps {
  lockSecret?: string | null;
  onRecover?: () => void;
}

export default function LeakSwapPanel({ lockSecret, onRecover }: LeakSwapPanelProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [swaps, setSwaps] = useState<SavedSwapStatus[]>([]);
  const [shares, setShares] = useState<Awaited<ReturnType<typeof listSwapShares>>>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setSwaps([]);
    setShares([]);
    setError(null);
  }, [lockSecret]);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10000);
    const reload = window.setInterval(() => setRefresh((value) => value + 1), 60000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(reload);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!lockSecret) {
      setLoading(false);
      return;
    }
    const secret = lockSecret;
    setLoading(true);
    setError(null);
    async function load() {
      const inventory = await listSwapShares(secret);
      if (cancelled) return;
      setShares(inventory);
      const records = await listSwapRecords(browser.storage.local, secret);
      if (cancelled) return;
      if (!records.length) {
        setSwaps([]);
        return;
      }
      let client: algosdk.Algodv2 | null = null;
      let genesis = '';
      let chainRound: number | undefined;
      try {
        const settings = await getNetworkSettings();
        const endpoint = settings.algorand.algod;
        const node = new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port);
        const params = await node.getTransactionParams().do();
        genesis = params.genesisHash ? btoa(String.fromCharCode(...params.genesisHash)) : '';
        client = node;
        const status = await node.status().do();
        const round = Number(status.lastRound);
        if (!Number.isSafeInteger(round) || round <= 0) throw new Error('Invalid node round.');
        chainRound = round;
      } catch (failure) {
        console.error('Could not check swap network status.', failure);
      }
      const loaded = await Promise.all(
        records.map((record) =>
          readSwapChainStatus(record, client, genesis, Math.floor(Date.now() / 1000), chainRound),
        ),
      );
      if (!cancelled) setSwaps(loaded);
    }
    load()
      .catch((failure: unknown) => {
        console.error('Could not load saved swaps.', failure);
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'Unable to load saved swaps.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lockSecret, refresh]);
  const rows = swaps
    .map((swap) => ({ ...swap, status: swapStatus(swap, now) }))
    .sort(
      (first, second) => second.status.priority - first.status.priority || first.t1 - second.t1,
    );
  const history = rows.filter((swap) => swap.state === 'unavailable');
  const active = rows.filter((swap) => !history.includes(swap));

  function swapRow(swap: (typeof rows)[number]) {
    return (
      <article className="swap-list-item" key={`${swap.genesisHash}:${swap.appId}:${swap.role}`}>
        <div className="swap-row-heading">
          <h4>Swap {swap.appId}</h4>
          {swap.origin === BETA_SWAP_ORIGIN ? <span>Beta</span> : null}
          <span>{swap.role === 'ali' ? 'Ali · You send ALGO' : 'Xin · You send XMR'}</span>
        </div>
        <p
          className={swap.status.priority >= 2 ? 'swap-status urgent' : 'swap-status'}
          role={swap.status.priority >= 2 ? 'alert' : 'status'}
        >
          {swap.status.title}
        </p>
        <p>{swap.status.detail}</p>
        <dl className="swap-facts">
          {swap.escrowAtomic !== undefined ? (
            <>
              <dt>ALGO escrow</dt>
              <dd>{formatAtomic(swap.escrowAtomic, 6)} ALGO</dd>
            </>
          ) : null}
          <dt>Monero network</dt>
          <dd>{swap.moneroNetwork}</dd>
          <dt>Readiness deadline (t0)</dt>
          <dd>{formatRoundDeadline(swap.t0, swap.chainRound)}</dd>
          <dt>Final expiry (t1)</dt>
          <dd>{formatRoundDeadline(swap.t1, swap.chainRound)}</dd>
          {swap.chainRound !== undefined ? (
            <>
              <dt>Node round checked</dt>
              <dd>{swap.chainRound}</dd>
            </>
          ) : null}
        </dl>
        <a
          className="app-link"
          href={`${swapOrigin(swap.origin)}/swap/${swap.appId}`}
          target="_blank"
          rel="noreferrer"
        >
          Open swap <ExternalLink size={16} />
        </a>
      </article>
    );
  }

  return (
    <section className="leakswap-view" aria-busy={loading}>
      <h2>LeakSwap</h2>
      <div className="swap-pair" aria-label="Algorand to Monero">
        <img src={algorandLogo} alt="" />
        <strong>Algorand</strong>
        <ArrowLeftRight size={18} />
        <strong>Monero</strong>
        <img src={moneroLogo} alt="" />
      </div>
      <a
        className="app-link new-swap"
        href={`${BETA_SWAP_ORIGIN}/swap`}
        target="_blank"
        rel="noreferrer"
      >
        <Plus size={18} /> New Swap <ExternalLink size={16} />
      </a>
      {onRecover ? (
        <button type="button" className="secondary" onClick={onRecover}>
          <KeyRound size={18} /> Recover combined wallet
        </button>
      ) : null}
      <div className="swap-list-heading">
        <h3>Active swaps ({active.length})</h3>
        <button
          type="button"
          className="icon-btn"
          title="Refresh swap status"
          aria-label="Refresh swap status"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={18} className={loading ? 'is-spinning' : ''} />
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !rows.length ? <p role="status">Loading swaps...</p> : null}
      {!loading && !error && !rows.length ? <p className="hint">No saved swaps yet.</p> : null}
      {!loading && rows.length > 0 && !active.length ? (
        <p className="hint">No active swaps found.</p>
      ) : null}
      {active.map(swapRow)}
      {history.length ? (
        <details className="swap-archive" aria-label="Archived swaps">
          <summary>Archived swaps ({history.length})</summary>
          {history.map(swapRow)}
        </details>
      ) : null}
      <SwapRecoveryTools lockSecret={lockSecret} />
      {lockSecret ? <SwapBackupTools onRestore={() => setRefresh((value) => value + 1)} /> : null}
      <details className="swap-archive" aria-label="LeakSwap key shares">
        <summary>LeakSwap key shares ({shares.length})</summary>
        {shares.map((share) => (
          <article className="swap-list-item" key={share.walletId}>
            <h4>Swap key share</h4>
            <dl className="swap-facts">
              <dt>Offer digest</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>{share.digest}</dd>
              <dt>Monero network</dt>
              <dd>{share.network}</dd>
              <dt>Algorand identity</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>{share.algoAddress}</dd>
              <dt>Algorand genesis</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>{share.genesisHash}</dd>
              <dt>Created</dt>
              <dd>{new Date(share.createdAt).toLocaleString()}</dd>
            </dl>
          </article>
        ))}
      </details>
    </section>
  );
}
