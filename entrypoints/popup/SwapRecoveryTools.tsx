import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  listSignedTransactions,
  listSwapRecords,
  loadSettlementEvidence,
  swapRecordKey,
  type SwapRecord,
} from '../../lib/wallet/swapRecords';
import { swapDiagnostics } from '../../lib/wallet/swapDiagnostics';
import { recoverLeakSwap } from '../../lib/wallet/recoverLeakSwap';

export default function SwapRecoveryTools({ lockSecret }: { lockSecret?: string | null }) {
  const [records, setRecords] = useState<SwapRecord[]>([]);
  const [journal, setJournal] = useState<Awaited<ReturnType<typeof listSignedTransactions>>>([]);
  const [selected, setSelected] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<
    Record<string, { txId: string; confirmedRound: string }>
  >({});
  useEffect(() => {
    setRecords([]);
    setJournal([]);
    setSelected('');
    setTransactionId('');
    setEvidence({});
    setError(null);
    setStatus(null);
  }, [lockSecret]);
  const record = records.find((candidate) => swapRecordKey(candidate) === selected);
  const report = record
    ? { ...swapDiagnostics(record, journal), retainedSettlementEvidence: evidence[selected] }
    : null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (failure) {
      console.error('Advanced swap recovery failed', failure);
      setError(failure instanceof Error ? failure.message : 'Unable to recover swap.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="swap-archive" aria-label="Advanced swap recovery">
      <summary>Advanced recovery and support records</summary>
      <p>
        Records remain saved after contract deletion. Support reports contain public addresses and
        transaction references, but no private spend keys, private view keys or mnemonic. Sharing a
        report links your swap identities. A report is not a wallet backup.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={busy || !lockSecret}
        onClick={() =>
          run(async () => {
            const [swaps, transactions] = await Promise.all([
              listSwapRecords(browser.storage.local, lockSecret!),
              listSignedTransactions(browser.storage.local, lockSecret!),
            ]);
            const retained: Record<string, { txId: string; confirmedRound: string }> = {};
            for (const swap of swaps) {
              const saved = await loadSettlementEvidence(browser.storage.local, swap, lockSecret!);
              if (saved)
                retained[swapRecordKey(swap)] = {
                  txId: saved.txId,
                  confirmedRound: saved.confirmedRound,
                };
            }
            setEvidence(retained);
            setRecords(swaps);
            setJournal(transactions);
            setSelected('');
            setTransactionId('');
            setStatus(`${swaps.length} saved swap records loaded.`);
          })
        }
      >
        <RefreshCw size={16} /> Load recovery records
      </button>
      <label>
        Saved recovery record
        <select
          aria-label="Saved recovery record"
          disabled={busy}
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setTransactionId('');
            setStatus(null);
            setError(null);
          }}
        >
          <option value="">Select a saved swap</option>
          {records.map((swap) => (
            <option key={swapRecordKey(swap)} value={swapRecordKey(swap)}>
              App {swap.appId} / {swap.context.network} / {swap.algoAddress}
            </option>
          ))}
        </select>
      </label>
      {report ? (
        <>
          <pre className="swap-support-report">{JSON.stringify(report, null, 2)}</pre>
          <button
            type="button"
            className="secondary"
            title="Download public swap support report"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `leakswap-${report.appId}-support.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download size={16} /> Export support report
          </button>
          <p>
            Use the original Algorand account and the matching networks. Recovery verifies the
            transaction; this override cannot bypass signature, sender, application or network
            checks. No XMR is sent and the recovered wallet does not replace your active wallet.
          </p>
          <label>
            Confirmed settlement transaction ID (optional)
            <input
              aria-label="Confirmed settlement transaction ID"
              value={transactionId}
              disabled={busy}
              onChange={(event) => setTransactionId(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !lockSecret}
            onClick={() =>
              run(async () => {
                const reference =
                  transactionId.trim() || evidence[selected]?.txId || record?.settlement?.txId;
                if (reference && !/^[A-Z2-7]{52}$/.test(reference))
                  throw new Error('Enter a complete 52-character Algorand transaction ID.');
                const result = await recoverLeakSwap(
                  { appId: report.appId, ...(reference ? { settlementTxId: reference } : {}) },
                  lockSecret!,
                );
                if (result.combinedAddress !== report.combinedAddress)
                  throw new Error('Recovered address does not match the selected record.');
                setStatus(
                  `Recovered wallet saved in Zebgen: ${result.combinedAddress}. Settlement: ${result.settlementTxId}`,
                );
              })
            }
          >
            {busy ? 'Verifying recovery...' : 'Verify history and save recovered wallet'}
          </button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" style={{ overflowWrap: 'anywhere' }}>
          {status}
        </p>
      ) : null}
    </details>
  );
}
