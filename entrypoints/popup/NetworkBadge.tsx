import { useEffect, useRef, useState } from 'react';

import { networkColor, networkLabel } from '../../lib/network/networks';

interface NetworkBadgeProps {
  network: string;
  options: readonly string[];
  onSelect: (network: string) => void;
}

function NetworkBadge({ network, options, onSelect }: NetworkBadgeProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

  const color = networkColor(network);

  return (
    <div className="net-badge-wrap" ref={containerRef}>
      <button
        type="button"
        className="net-badge"
        style={{ color, borderColor: color, boxShadow: `0 0 10px ${color}55` }}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="net-badge-dot" style={{ background: color }} />
        {networkLabel(network)}
      </button>

      {open ? (
        <div className="net-badge-menu" role="listbox">
          {options.map((id) => (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={id === network}
              className={`net-badge-item${id === network ? ' net-badge-item-active' : ''}`}
              onClick={() => {
                onSelect(id);
                setOpen(false);
              }}
            >
              <span className="net-badge-dot" style={{ background: networkColor(id) }} />
              {networkLabel(id)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default NetworkBadge;
