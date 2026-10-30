import type { MoneroKeyMaterial } from '../../lib/wallet/moneroWallet';
import CopyValue from './CopyValue';

interface KeyRow {
  label: string;
  value: string;
  secret?: boolean;
}

interface MoneroKeyListProps {
  material: MoneroKeyMaterial;
  includeSecrets?: boolean;
}

function truncateMiddle(value: string, lead = 10, tail = 8): string {
  if (value.length <= lead + tail + 1) {
    return value;
  }
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function MoneroKeyList({ material, includeSecrets = false }: MoneroKeyListProps) {
  const rows: KeyRow[] = [
    { label: 'Address', value: material.address },
    { label: 'Private spend key', value: material.privateSpendKey, secret: true },
    { label: 'Private view key', value: material.privateViewKey, secret: true },
    { label: 'Public spend key', value: material.publicSpendKey },
    { label: 'Public view key', value: material.publicViewKey },
  ];

  return (
    <div className="mono-key-list">
      {rows
        .filter((row) => includeSecrets || !row.secret)
        .map((row) => (
          <div key={row.label} className={`mono-key-row${row.secret ? ' mono-key-secret' : ''}`}>
            <span className="mono-key-label">
              {row.label}
              {row.secret ? <span className="mono-key-tag">secret</span> : null}
            </span>
            <code className="mono-key-value" title={row.value}>
              {truncateMiddle(row.value)}
            </code>
            <CopyValue value={row.value} label={row.label.toLowerCase()} />
          </div>
        ))}
    </div>
  );
}

export default MoneroKeyList;
