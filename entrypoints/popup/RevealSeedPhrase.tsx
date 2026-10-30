import { FormEvent, useEffect, useRef, useState } from 'react';

import { revealActiveSeedMnemonic } from '../../lib/wallet/algoWallet';

type Stage = 'idle' | 'confirm' | 'authenticate' | 'revealed';

function RevealSeedPhrase() {
  const [stage, setStage] = useState<Stage>('idle');
  const [secret, setSecret] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  function reset() {
    setStage('idle');
    setSecret('');
    setMnemonic('');
    setError(null);
    setCopied(false);
  }

  async function onReveal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsRevealing(true);
    try {
      const phrase = await revealActiveSeedMnemonic(secret);
      setMnemonic(phrase);
      setSecret('');
      setStage('revealed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reveal recovery phrase.');
    } finally {
      setIsRevealing(false);
    }
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Unable to copy the recovery phrase. Select the words to copy them manually.');
    }
  }

  if (stage === 'idle') {
    return (
      <div className="seed-reveal">
        <button type="button" className="secondary" onClick={() => setStage('confirm')}>
          Reveal recovery phrase
        </button>
      </div>
    );
  }

  if (stage === 'confirm') {
    return (
      <div className="seed-reveal">
        <div className="seed-warning">
          <strong>Are you sure?</strong>
          <p>
            Your recovery phrase gives full control of this wallet. Anyone who sees it can steal
            your funds. Make sure no one is watching your screen and never share it with anyone.
          </p>
        </div>
        <div className="seed-reveal-actions">
          <button type="button" className="secondary" onClick={reset}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => setStage('authenticate')}>
            I understand, continue
          </button>
        </div>
      </div>
    );
  }

  if (stage === 'authenticate') {
    return (
      <form className="seed-reveal import-form" onSubmit={onReveal}>
        <p className="hint">Confirm your password or PIN to reveal the recovery phrase.</p>
        <label htmlFor="reveal-secret">Password or PIN</label>
        <input
          id="reveal-secret"
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder="Enter your password or PIN"
          autoFocus
          required
        />
        <div className="seed-reveal-actions">
          <button type="button" className="secondary" onClick={reset} disabled={isRevealing}>
            Cancel
          </button>
          <button type="submit" className="danger" disabled={isRevealing || !secret}>
            {isRevealing ? 'Revealing...' : 'Reveal'}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </form>
    );
  }

  return (
    <div className="seed-reveal">
      <div className="seed-warning">
        <strong>Keep this private.</strong>
        <p>Write these words down and store them somewhere safe and offline.</p>
      </div>
      <div className="seed-reveal-words">
        {mnemonic.split(' ').map((word, index) => (
          <span key={`${word}-${index}`} className="seed-word">
            <span className="seed-word-index">{index + 1}</span>
            {word}
          </span>
        ))}
      </div>
      <div className="seed-reveal-actions">
        <button type="button" className="secondary" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={reset}>
          Hide
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

export default RevealSeedPhrase;
