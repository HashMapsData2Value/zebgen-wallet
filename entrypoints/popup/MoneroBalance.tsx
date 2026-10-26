import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  probeMoneroDaemonViaBackground,
  scanMoneroBalanceViaBackground,
  isMoneroScanActive,
} from '../../lib/network/messages';
import { ensureHostPermissions } from '../../lib/network/hostPermissions';
import type { MoneroNetworkConfig } from '../../lib/network/networks';
import { formatAtomic } from '../../lib/wallet/formatAtomic';
import ScanActivity from './ScanActivity';
import MoneroChainHeight from './MoneroChainHeight';
import { sanitizeBlockHeight } from '../../lib/monero/scanHeight';
import {
  balanceCheckpointKey,
  coverageCheckpointKey,
  loadBalanceCheckpoint,
  scanSpans,
  unscannedSpans,
  type ScanSpan,
  type MoneroUnlock,
} from '../../lib/wallet/moneroBalanceCache';
import { loadScanCheckpoint } from '../../lib/wallet/moneroScanCheckpoint';

interface MoneroBalanceProps {
  config: MoneroNetworkConfig;
  address: string;
  walletId: number;
  lockSecret: string;
  restoreHeight?: number;
}

export default function MoneroBalance(props: MoneroBalanceProps) {
  const [balance, setBalance] = useState<string | null>(null);
  const [height, setHeight] = useState(String(props.restoreHeight ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [targetHeight, setTargetHeight] = useState<number | undefined>();
  const [scannedHeight, setScannedHeight] = useState<number | undefined>();
  const [stopped, setStopped] = useState(false);
  const [refreshNeeded, setRefreshNeeded] = useState<string | null>(null);
  const [scanSettingsOpen, setScanSettingsOpen] = useState(false);
  const [appliedHeight, setAppliedHeight] = useState(String(props.restoreHeight ?? 0));
  const [locked, setLocked] = useState<string | null>(null);
  const [spans, setSpans] = useState<ScanSpan[]>([]);
  const [unlocks, setUnlocks] = useState<MoneroUnlock[] | undefined>();
  const [balanceHeight, setBalanceHeight] = useState<number | undefined>();
  const scanController = useRef<AbortController | null>(null);
  const pollingPaused = useRef(false);
  const mounted = useRef(true);
  const scanning = useRef(false);
  const lastHeight = useRef<number | undefined>(undefined);
  const pollGeneration = useRef(0);
  const manualScanRequested = useRef(false);
  const checkpointKey = coverageCheckpointKey(
    props.config.network,
    props.config.daemon.uri,
    props.address,
  );
  const jobKey = balanceCheckpointKey(
    props.config.network,
    props.config.daemon.uri,
    props.address,
    Number(appliedHeight),
  );
  const missing = unscannedSpans(spans, targetHeight ?? spans.at(-1)?.end ?? 0);
  function missingBlockCount(coverage: ScanSpan[], tip: number) {
    return unscannedSpans(coverage, tip).reduce(
      (count, span) => count + Math.max(0, span.end - Math.max(span.start, Number(appliedHeight))),
      0,
    );
  }
  useEffect(() => {
    let active = true;
    setBalance(null);
    setLocked(null);
    setUnlocks(undefined);
    setBalanceHeight(undefined);
    setSpans([]);
    setScannedAt(null);
    setRefreshNeeded(null);
    lastHeight.current = undefined;
    void loadBalanceCheckpoint(checkpointKey, props.lockSecret)
      .then(async (checkpoint) => {
        const savedScan = (await loadScanCheckpoint(checkpointKey, props.lockSecret)) as
          | { spans?: unknown }
          | undefined;
        if (!active) return;
        const coverage = scanSpans(savedScan?.spans ?? checkpoint?.spans ?? []);
        setSpans(coverage);
        if (manualScanRequested.current) {
          manualScanRequested.current = false;
          await scan();
          return;
        }
        if (checkpoint) {
          setBalance(checkpoint.balanceAtomic);
          setLocked(checkpoint.lockedAtomic ?? null);
          setUnlocks(checkpoint.unlocks);
          setBalanceHeight(checkpoint.scannedHeight - 1);
          setScannedAt(new Date(checkpoint.scannedAt).toLocaleString());
          lastHeight.current = checkpoint.scannedHeight;
        }
        if (await isMoneroScanActive(jobKey)) {
          if (active) await scan(false);
          return;
        }
        const tip = await probeMoneroDaemonViaBackground(props.config);
        if (!active) return;
        if (!tip.ok || tip.height === undefined)
          throw new Error(tip.error ?? 'Unable to check daemon height. Showing saved balance.');
        setTargetHeight(tip.height);
        const missingBlocks = missingBlockCount(coverage, tip.height);
        if (!checkpoint || tip.height !== checkpoint.scannedHeight || missingBlocks > 0) {
          if (missingBlocks > 5000)
            setRefreshNeeded('Scan required. Refresh to allow the history download.');
          else await scan(false);
        }
      })
      .catch((failure) => {
        console.error('Unable to restore Monero balance', failure);
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      active = false;
      scanController.current?.abort('detach');
    };
  }, [checkpointKey, props.lockSecret, appliedHeight]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scanController.current?.abort('detach');
    };
  }, []);

  useEffect(() => {
    if (balance === null) return;
    const generation = ++pollGeneration.current;
    let checking = false;
    async function poll() {
      if (checking || scanning.current || pollingPaused.current || height !== appliedHeight) return;
      checking = true;
      try {
        const result = await probeMoneroDaemonViaBackground(props.config);
        if (!result.ok || result.height === undefined)
          throw new Error(result.error ?? 'Unable to check daemon height.');
        if (generation !== pollGeneration.current) return;
        if (lastHeight.current !== result.height) {
          const checkpoint = await loadBalanceCheckpoint(checkpointKey, props.lockSecret);
          if (generation !== pollGeneration.current) return;
          if (missingBlockCount(checkpoint?.spans ?? spans, result.height) > 5000) {
            setRefreshNeeded(
              'New blocks available. Refresh to download the missing history; the saved balance may be stale.',
            );
          } else if (await scan(false)) lastHeight.current = result.height;
        }
      } catch (failure) {
        console.error('Monero balance polling failed', failure);
        if (mounted.current && generation === pollGeneration.current)
          setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        checking = false;
      }
    }
    const timer = window.setInterval(poll, 5000);
    return () => {
      pollGeneration.current += 1;
      window.clearInterval(timer);
    };
  }, [balance, height, appliedHeight]);

  useEffect(() => {
    if (height === appliedHeight || !/^\d+$/.test(height) || !Number.isSafeInteger(Number(height)))
      return;
    const timer = window.setTimeout(() => setAppliedHeight(height), 3000);
    return () => window.clearTimeout(timer);
  }, [height, appliedHeight]);

  function scanFromInput() {
    if (!/^\d+$/.test(height) || !Number.isSafeInteger(Number(height))) return;
    if (height !== appliedHeight) {
      manualScanRequested.current = true;
      setAppliedHeight(height);
    } else void scan();
  }

  async function scan(requestPermissions = true, requestedHeight = appliedHeight) {
    if (scanning.current) return;
    const controller = new AbortController();
    scanController.current = controller;
    scanning.current = true;
    pollingPaused.current = false;
    setStopped(false);
    setRefreshNeeded(null);
    setError(null);
    setBusy(true);
    setTargetHeight(undefined);
    setScannedHeight(undefined);
    try {
      if (requestPermissions) await ensureHostPermissions([props.config.daemon.uri]);
      controller.signal.throwIfAborted();
      const restoreHeight = Number(requestedHeight);
      if (!/^\d+$/.test(requestedHeight) || !Number.isSafeInteger(restoreHeight))
        throw new Error('Enter a non-negative restore height.');
      const tip = await probeMoneroDaemonViaBackground(props.config);
      controller.signal.throwIfAborted();
      if (!tip.ok || tip.height === undefined)
        throw new Error(tip.error ?? 'Unable to check daemon height.');
      if (mounted.current) setTargetHeight(tip.height);
      const result = await scanMoneroBalanceViaBackground(
        {
          config: props.config,
          primaryAddress: props.address,
          walletId: props.walletId,
          lockSecret: props.lockSecret,
          restoreHeight,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (
              mounted.current &&
              scanController.current === controller &&
              !controller.signal.aborted
            ) {
              setScannedHeight(progress.scannedHeight);
              setTargetHeight(progress.targetHeight);
              if (progress.spans) setSpans(scanSpans(progress.spans));
            }
          },
        },
      );
      controller.signal.throwIfAborted();
      if (!result.ok || result.balanceAtomic === undefined)
        throw new Error(result.error ?? 'Unable to scan balance.');
      const scannedAt = Date.now();
      const checkpoint = await loadBalanceCheckpoint(
        coverageCheckpointKey(props.config.network, props.config.daemon.uri, props.address),
        props.lockSecret,
      );
      controller.signal.throwIfAborted();
      if (mounted.current) {
        setBalance(result.balanceAtomic);
        setLocked(result.lockedAtomic ?? null);
        setUnlocks(result.unlocks);
        setBalanceHeight((checkpoint?.scannedHeight ?? tip.height) - 1);
        if (result.spans) setSpans(scanSpans(result.spans));
        setScannedAt(new Date(scannedAt).toLocaleString());
      }
      lastHeight.current = checkpoint?.scannedHeight ?? tip.height;
      return true;
    } catch (failure) {
      if (controller.signal.aborted) return false;
      console.error('Monero balance scan failed', failure);
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (scanController.current === controller) {
        scanController.current = null;
        scanning.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  function stopScan() {
    pollingPaused.current = true;
    scanController.current?.abort();
    scanController.current = null;
    scanning.current = false;
    setBusy(false);
    setStopped(true);
  }

  return (
    <div className="monero-balance" aria-busy={busy}>
      <div className="balance-row">
        <span className="balance-amount">
          {balance === null
            ? busy
              ? 'Checking balance...'
              : 'Balance not checked'
            : `Spendable ${formatAtomic(balance, 12)} XMR`}
        </span>
        {!scanSettingsOpen ? (
          <button
            type="button"
            className="refresh-btn"
            title="Scan unlocked balance"
            aria-label="Scan unlocked balance"
            onClick={scanFromInput}
            disabled={busy || !/^\d+$/.test(height)}
          >
            <RefreshCw size={16} className={busy ? 'is-spinning' : ''} />
          </button>
        ) : null}
      </div>
      <p className="hint" aria-label="Locked Monero balance">
        Locked: {locked === null ? 'Not checked' : `${formatAtomic(locked, 12)} XMR`}
      </p>
      {locked !== null && BigInt(locked) > 0n ? (
        unlocks?.length ? (
          <ul className="hint" aria-label="Monero unlock schedule">
            {unlocks.map((unlock, index) => {
              const remaining =
                unlock.height !== null && balanceHeight !== undefined
                  ? Math.max(0, unlock.height - balanceHeight)
                  : undefined;
              return (
                <li key={`${unlock.height}-${index}`}>
                  {formatAtomic(unlock.amountAtomic, 12)} XMR:{' '}
                  {unlock.height === null
                    ? 'Time-locked; no fixed unlock block'
                    : `unlocks at block ${unlock.height.toLocaleString()}${remaining === undefined ? '' : ` (${remaining.toLocaleString()} ${remaining === 1 ? 'block' : 'blocks'} remaining)`}`}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="hint">Unlock block details unavailable. Rescan with the updated scanner.</p>
        )
      ) : null}
      {(busy || stopped) && balance !== null ? (
        <p className="hint">Showing last verified balances</p>
      ) : null}
      {busy ? (
        <ScanActivity
          restoreHeight={Number(appliedHeight)}
          targetHeight={targetHeight}
          scannedHeight={scannedHeight}
          onStop={stopScan}
        />
      ) : (
        <p className="hint" role="status">
          {stopped
            ? 'Scan stopped'
            : balance === null
              ? 'Unlocked balance not checked'
              : `Last verified balance · block ${lastHeight.current === undefined ? 'unknown' : Math.max(0, lastHeight.current - 1)} · ${scannedAt}`}
        </p>
      )}
      <p className="hint">
        Locked funds unlock as blocks are mined, not after a fixed time. Incoming mempool payments
        are not shown.
      </p>
      <div className="scan-coverage" aria-label="Monero scan coverage">
        <h4>Scanned block spans</h4>
        {spans.length ? (
          <ul>
            {spans.map((span) => (
              <li key={span.start}>
                {span.start.toLocaleString()} - {(span.end - 1).toLocaleString()}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No saved scanned blocks</p>
        )}
        {missing.length ? (
          <>
            <h4>Unscanned blocks</h4>
            <ul>
              {missing.map((span) => (
                <li key={span.start}>
                  {span.start.toLocaleString()} - {(span.end - 1).toLocaleString()}
                </li>
              ))}
            </ul>
            <p className="hint">
              Balances cover scanned blocks only. Payments in unscanned blocks may be missing.
            </p>
          </>
        ) : null}
      </div>
      <details
        className="address-details"
        onToggle={(event) => setScanSettingsOpen(event.currentTarget.open)}
      >
        <summary>Scan settings</summary>
        <div className="import-form">
          <label htmlFor="balance-restore-height">Restore height</label>
          <input
            id="balance-restore-height"
            inputMode="numeric"
            value={height}
            disabled={busy}
            onChange={(event) => {
              setHeight(sanitizeBlockHeight(event.target.value));
            }}
          />
          <MoneroChainHeight config={props.config} />
          <button type="button" disabled={busy || !/^\d+$/.test(height)} onClick={scanFromInput}>
            {busy ? 'Scanning...' : 'Scan from this height'}
          </button>
        </div>
      </details>
      {height !== '' && Number(height) === 0 ? (
        <p className="privacy-notice">
          A scan from block 0 downloads the full chain history and may use substantial data.
        </p>
      ) : null}
      {refreshNeeded ? (
        <p className="hint" role="status">
          {refreshNeeded}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
