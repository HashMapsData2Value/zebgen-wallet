import {
  MONERO_NETWORK_IDS,
  networkColor,
  type MoneroNetworkId,
  type NetworkSettings,
} from '../../lib/network/networks';
import type { MoneroKeyMaterial } from '../../lib/wallet/moneroWallet';
import CopyValue from './CopyValue';
import { ArrowLeft, ArrowRight, Settings } from 'lucide-react';
import NetworkBadge from './NetworkBadge';
import MoneroBalance from './MoneroBalance';

interface MoneroAddressCardProps {
  material: MoneroKeyMaterial;
  settings: NetworkSettings;
  onChangeNetwork: (network: MoneroNetworkId) => void;
  onOpenSettings: () => void;
  addressPosition: number;
  addressCount: number;
  onPrev: () => void;
  onNext: () => void;
  walletId: number;
  lockSecret: string;
  restoreHeight?: number;
}

function MoneroAddressCard({
  material,
  settings,
  onChangeNetwork,
  onOpenSettings,
  addressPosition,
  addressCount,
  onPrev,
  onNext,
  walletId,
  lockSecret,
  restoreHeight,
}: MoneroAddressCardProps) {
  const network = settings.monero.network;
  const color = networkColor(network);

  return (
    <>
      <div
        className="address-frame"
        style={{ borderColor: color, boxShadow: `0 0 0 1px ${color}, 0 0 18px ${color}44` }}
      >
        <div className="address-frame-header">
          <div className="address-nav" aria-label="Monero address navigation">
            <button
              type="button"
              className="icon-btn"
              onClick={onPrev}
              disabled={addressPosition <= 0}
              title="Previous address"
              aria-label="Previous address"
            >
              <ArrowLeft size={16} />
            </button>
            <span className="index-label">
              {addressPosition + 1} of {addressCount}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={onNext}
              disabled={addressPosition < 0 || addressPosition >= addressCount - 1}
              title="Next address"
              aria-label="Next address"
            >
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="address-frame-actions">
            <NetworkBadge
              network={network}
              options={MONERO_NETWORK_IDS}
              onSelect={(id) => onChangeNetwork(id as MoneroNetworkId)}
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
          <p className="address" title={material.address}>
            {material.address.slice(0, 10)}...{material.address.slice(-8)}
          </p>
          <CopyValue value={material.address} label="address" />
        </div>
        <MoneroBalance
          key={`${material.address}-${settings.monero.daemon.uri}-${restoreHeight}`}
          address={material.address}
          config={settings.monero}
          walletId={walletId}
          lockSecret={lockSecret}
          restoreHeight={restoreHeight}
        />
      </div>
    </>
  );
}

export default MoneroAddressCard;
