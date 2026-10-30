import { formatAtomic } from '../../lib/wallet/formatAtomic';

export default function SwapFeeDisclosure({ grossMicroAlgos }: { grossMicroAlgos: bigint }) {
  const fee = grossMicroAlgos / 200n;
  return (
    <div className="swap-fee-disclosure">
      <dl>
        <dt>Gross Deposit</dt>
        <dd>{formatAtomic(grossMicroAlgos, 6)} ALGO</dd>
        <dt>LeakSwap's Fee (0.5%)</dt>
        <dd>{formatAtomic(fee, 6)} ALGO</dd>
        <dt>Counterparty Receives (Excl. Chain Fees)</dt>
        <dd>{formatAtomic(grossMicroAlgos - fee, 6)} ALGO</dd>
      </dl>
      <p className="hint">
        LeakSwap's platform fee is only collected on successful swaps. Failed or aborted swaps do
        not incur the platform fee.
      </p>
    </div>
  );
}
