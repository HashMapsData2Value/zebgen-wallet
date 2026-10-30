import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { probeMoneroDaemonViaBackground } from '../../lib/network/messages';
import { ensureHostPermissions } from '../../lib/network/hostPermissions';
import type { MoneroNetworkConfig } from '../../lib/network/networks';

export default function MoneroChainHeight({ config }: { config: MoneroNetworkConfig }) {
  const [height, setHeight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    let checking = false;
    setHeight(null);
    setError(null);
    async function checkHeight() {
      if (checking) return;
      checking = true;
      try {
        const result = await probeMoneroDaemonViaBackground(config);
        if (!result.ok || result.height === undefined)
          throw new Error(result.error ?? 'No chain height returned.');
        if (active) {
          setHeight(result.height);
          setError(null);
        }
      } catch (failure) {
        console.error('Monero chain height lookup failed', failure);
        if (active) {
          setHeight(null);
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      } finally {
        checking = false;
      }
    }
    void checkHeight();
    const timer = window.setInterval(() => void checkHeight(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [config, refresh]);

  async function refreshHeight() {
    try {
      await ensureHostPermissions([config.daemon.uri]);
      setRefresh((value) => value + 1);
    } catch (failure) {
      console.error('Monero chain height permission failed', failure);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <div>
      <div className="balance-row">
        <span className="hint" role="status">
          Current chain height:{' '}
          {error ? 'Unavailable' : height === null ? 'Loading...' : height.toLocaleString()}
        </span>
        <button
          type="button"
          className="secondary"
          title="Refresh chain height"
          aria-label="Refresh chain height"
          onClick={() => void refreshHeight()}
        >
          <RefreshCw size={16} />
          Check height
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
