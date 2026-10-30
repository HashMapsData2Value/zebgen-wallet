import { QRCodeSVG } from 'qrcode.react';
import { paymentUri } from '../../lib/wallet/paymentUri';
import CopyValue from './CopyValue';
import { networkLabel } from '../../lib/network/networks';
import { addressValidationError } from '../../lib/wallet/addressValidation';

export default function Receive({
  address,
  network,
  chain,
}: {
  address: string;
  network: string;
  chain: 'algorand' | 'monero';
}) {
  const error = addressValidationError(chain, address, network);
  return (
    <section className="receive-view">
      <h2>Receive {chain === 'algorand' ? 'ALGO' : 'XMR'}</h2>
      <p className="receive-network">{networkLabel(network)}</p>
      {!error ? (
        <div className="receive-qr">
          <QRCodeSVG
            value={paymentUri(chain, address, network)}
            size={180}
            marginSize={4}
            title="Receiving address"
          />
        </div>
      ) : null}
      <div
        className="receive-address"
        data-address-status={error ? 'invalid' : 'valid'}
        aria-invalid={!!error}
      >
        <code>{address}</code>
        {!error ? <CopyValue value={address} label="address" /> : null}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error} Do not send funds to this address.
        </p>
      ) : null}
    </section>
  );
}
