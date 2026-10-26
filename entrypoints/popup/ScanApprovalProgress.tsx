import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import './LeakSwapDeposit.css';

interface Props {
  progress: { scannedHeight: number; targetHeight: number; startHeight?: number } | null;
  purpose?: 'funding' | 'acceptance';
}

export default function ScanApprovalProgress({ progress, purpose = 'funding' }: Props) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);

  const start = progress?.startHeight;
  const total = progress && start !== undefined ? Math.max(0, progress.targetHeight - start) : null;
  const checked =
    progress && start !== undefined
      ? Math.max(0, Math.min(progress.scannedHeight - start, total ?? 0))
      : 0;
  const remaining = total === null ? null : Math.max(0, total - checked);
  const estimatedSeconds =
    elapsed >= 3 && checked > 0 && remaining !== null
      ? Math.ceil((remaining * elapsed) / checked)
      : null;

  return (
    <section className="deposit-progress" role="status" aria-live="polite" aria-atomic="true">
      <LoaderCircle className="deposit-progress-spinner" size={32} aria-hidden="true" />
      <div>
        <h3>{purpose === 'acceptance' ? 'Verifying spendable XMR' : 'Checking Monero funding'}</h3>
        <p>
          {progress
            ? `Scanned block ${progress.scannedHeight.toLocaleString()} of ${progress.targetHeight.toLocaleString()}.`
            : 'Unlocking the wallet and connecting to the Monero node.'}
        </p>
        {progress && start !== undefined ? (
          <>
            <p>
              {purpose === 'acceptance'
                ? `Wallet scan range: block ${start.toLocaleString()} to ${progress.targetHeight.toLocaleString()}. Saved coverage is reused.`
                : start > 0
                  ? `Starting at this swap's restore height: ${start.toLocaleString()}. Earlier blocks are outside this check.`
                  : 'No later starting height is recorded for this swap. Checking from block 0 so an earlier deposit is not silently missed.'}
            </p>
            <progress
              aria-label="Monero blocks checked"
              max={total || 1}
              value={total === 0 ? 1 : checked}
              style={{ width: '100%' }}
            />
            <p>
              {checked.toLocaleString()} of {(total ?? 0).toLocaleString()} blocks checked;{' '}
              {Math.max(0, (total ?? 0) - checked).toLocaleString()} remaining.
            </p>
            {purpose === 'funding' ? (
              <p>
                This check starts again at the restore height; it does not resume a previous funding
                scan.
              </p>
            ) : null}
            <p>
              {remaining === 0
                ? purpose === 'acceptance'
                  ? 'Block scan complete. Finalizing the spendable balance and preliminary fee allowance check; nothing is sent.'
                  : 'Block scan complete. Finalizing funding checks.'
                : estimatedSeconds === null
                  ? 'Estimating remaining scan time...'
                  : `Estimated scan time remaining: ${estimatedSeconds < 60 ? `${estimatedSeconds}s` : `${Math.ceil(estimatedSeconds / 60)} min`}. Node speed can vary.`}
            </p>
          </>
        ) : (
          <progress aria-label="Waiting for Monero scan range" style={{ width: '100%' }} />
        )}
        <p>Scanning can take a minute or longer. Keep this window open, or cancel the scan.</p>
        <span className="deposit-progress-time" aria-live="off">
          Elapsed: {elapsed}s
        </span>
      </div>
    </section>
  );
}
