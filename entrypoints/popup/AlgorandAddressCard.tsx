import { useCallback, useEffect, useRef, useState } from 'react';

import { getAlgoBalance } from '../../lib/algorand/algodClient';
import {
  ALGORAND_NETWORK_IDS,
  networkColor,
  type AlgorandNetworkId,
  type NetworkSettings,
} from '../../lib/network/networks';
import NetworkBadge from './NetworkBadge';
import CopyValue from './CopyValue';
import { RefreshCw, Settings } from 'lucide-react';

const POLL_INTERVAL_MS = 5000;

type DisplayBalance = { algos: number } | { error: string } | null;

interface AlgorandAddressCardProps {
  address: string | null;
  addressPreview: string;
  addressIndex: number;
  derivationPath: string;
  settings: NetworkSettings;
  onChangeNetwork: (network: AlgorandNetworkId) => void;
  onOpenSettings: () => void;
}

function formatAlgos(algos: number): string {
  return algos.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function AlgorandAddressCard({
  address,
  addressPreview,
  addressIndex,
  derivationPath,
  settings,
  onChangeNetwork,
  onOpenSettings,
}: AlgorandAddressCardProps) {
  const network = settings.algorand.network;
  const color = networkColor(network);
  const algod = settings.algorand.algod;

  // Balances are cached per `network:address` so revisiting an address (prev/next
  // or switching networks and back) shows the last known amount instantly, and
  // the value only refreshes in the background instead of flickering.
  const cacheRef = useRef<Map<string, number>>(new Map());
  const currentKeyRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const [displayed, setDisplayed] = useState<DisplayBalance>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const cacheKey = address ? `${network}:${address}` : null;

  const fetchBalance = useCallback(async () => {
    if (!address) {
      return;
    }
    const key = `${network}:${address}`;
    const requestId = ++requestIdRef.current;
    setIsRefreshing(true);
    const result = await getAlgoBalance(algod, address, network);
    if (currentKeyRef.current !== key || requestIdRef.current !== requestId) {
      return;
    }
    if (result.ok && result.algos !== undefined) {
      cacheRef.current.set(key, result.algos);
      setDisplayed({ algos: result.algos });
    } else {
      setDisplayed({ error: result.error ?? 'Unavailable' });
    }
    setIsRefreshing(false);
  }, [address, network, algod]);

  useEffect(() => {
    currentKeyRef.current = cacheKey;
    if (!cacheKey) {
      setDisplayed(null);
      return;
    }
    // Show a cached amount immediately (no flicker); only truly new addresses
    // fall back to the loading skeleton. Then refresh in the background and
    // poll so incoming funds appear without user action.
    const cached = cacheRef.current.get(cacheKey);
    setDisplayed(cached !== undefined ? { algos: cached } : null);
    fetchBalance();
    const timer = window.setInterval(fetchBalance, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      requestIdRef.current += 1;
    };
  }, [cacheKey, fetchBalance]);

  return (
    <>
      <div
        className="address-frame"
        style={{ borderColor: color, boxShadow: `0 0 0 1px ${color}, 0 0 18px ${color}44` }}
      >
        <div className="address-frame-header">
          <div className="address-nav" aria-label="Algorand address navigation">
            <span className="index-label">Address {addressIndex + 1}</span>
          </div>
          <div className="address-frame-actions">
            <NetworkBadge
              network={network}
              options={ALGORAND_NETWORK_IDS}
              onSelect={(id) => onChangeNetwork(id as AlgorandNetworkId)}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={onOpenSettings}
              title="Network settings"
              aria-label="Network settings"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>

        <div className="address-row">
          <p className="address" title={address ?? ''}>
            {addressPreview}
          </p>
          <CopyValue value={address ?? ''} label="address" />
        </div>

        <div className="balance-row">
          {displayed === null ? (
            <span className="balance-amount balance-skeleton" aria-hidden="true">
              &nbsp;
            </span>
          ) : 'error' in displayed ? (
            <span className="balance-amount balance-unavailable">Unavailable</span>
          ) : (
            <span className="balance-amount" data-refreshing={isRefreshing}>
              {formatAlgos(displayed.algos)} ALGO
            </span>
          )}
          <button
            type="button"
            className="refresh-btn"
            onClick={fetchBalance}
            disabled={isRefreshing || !address}
            title="Refresh balance"
            aria-label="Refresh balance"
          >
            <RefreshCw size={16} className={isRefreshing ? 'is-spinning' : ''} />
          </button>
        </div>
        {displayed && 'error' in displayed ? (
          <p className="probe-error">{displayed.error}</p>
        ) : null}

        <details className="address-details">
          <summary>Address details</summary>
          <p className="hint">Derivation path: {derivationPath}</p>
        </details>
      </div>
    </>
  );
}

export default AlgorandAddressCard;
