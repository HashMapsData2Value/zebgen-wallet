import { useEffect, useState } from 'react';
import { Square } from 'lucide-react';

interface ScanActivityProps {
  restoreHeight: number;
  targetHeight?: number;
  scannedHeight?: number;
  onStop?: () => void;
}

export default function ScanActivity({
  restoreHeight,
  targetHeight,
  scannedHeight,
  onStop,
}: ScanActivityProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');
  const total = targetHeight === undefined ? undefined : Math.max(0, targetHeight - restoreHeight);
  const completed =
    scannedHeight === undefined || total === undefined
      ? undefined
      : Math.min(total, Math.max(0, scannedHeight - restoreHeight));
  return (
    <div className="scan-activity">
      <div className="scan-activity-heading">
        <span role="status">Scanning blocks</span>
        <span className="scan-elapsed" aria-label="Scan elapsed time">
          {minutes}:{seconds} elapsed
        </span>
        {onStop ? (
          <button
            type="button"
            className="refresh-btn"
            title="Stop scan"
            aria-label="Stop scan"
            onClick={onStop}
          >
            <Square size={16} />
          </button>
        ) : null}
      </div>
      <progress
        aria-label="Monero balance scan in progress"
        max={Math.max(1, total ?? 1)}
        value={completed}
      />
      {scannedHeight !== undefined ? (
        <p className="hint" role="status">
          Scanned through block {Math.max(0, scannedHeight - 1).toLocaleString()}
        </p>
      ) : null}
      {completed !== undefined && total !== undefined ? (
        <p className="hint" role="status">
          {completed.toLocaleString()} / {total.toLocaleString()} blocks scanned
          {completed === total ? ' · checking spent outputs' : ''}
        </p>
      ) : null}
      <p className="hint">
        {targetHeight === undefined
          ? `From block ${restoreHeight.toLocaleString()}`
          : `Block range ${restoreHeight.toLocaleString()} to ${Math.max(restoreHeight, targetHeight - 1).toLocaleString()}`}
      </p>
    </div>
  );
}
