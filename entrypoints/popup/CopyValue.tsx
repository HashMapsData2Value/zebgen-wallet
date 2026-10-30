import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CopyValueProps {
  value: string;
  label: string;
}

export default function CopyValue({ value, label }: CopyValueProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    setStatus('idle');
  }, [value]);

  useEffect(() => {
    if (status === 'idle') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
    } catch (error) {
      console.error(`Unable to copy ${label}`, error);
      setStatus('error');
    }
  }

  return (
    <span className="copy-control">
      <button
        type="button"
        className="icon-btn"
        onClick={copy}
        title={`Copy ${label}`}
        aria-label={`Copy ${label}`}
        disabled={!value}
      >
        {status === 'copied' ? <Check size={16} /> : <Copy size={16} />}
      </button>
      <span className="copy-feedback" role="status">
        {status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
