import { FormEvent, useState } from 'react';
import { unlockWallet } from '../../lib/wallet/algoWallet';
import { privateKeyToMoneroMnemonic } from '../../lib/wallet/moneroMnemonic';
import { genPrivateViewKey, type MoneroKeyMaterial } from '../../lib/wallet/moneroWallet';
import CopyValue from './CopyValue';
import MoneroKeyList from './MoneroKeyList';

export default function MoneroRecovery({ material }: { material: MoneroKeyMaterial }) {
  const [secret, setSecret] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlockWallet(secret);
      setSecret('');
      setRevealed(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to unlock recovery details.');
    } finally {
      setBusy(false);
    }
  }

  const deterministic = genPrivateViewKey(material.privateSpendKey) === material.privateViewKey;
  const mnemonic =
    revealed && deterministic ? privateKeyToMoneroMnemonic(material.privateSpendKey) : '';
  return (
    <section className="recovery-view">
      <h2>Recovery & private keys</h2>
      <div className="seed-warning">
        {deterministic
          ? 'Your recovery phrase and private spend key grant full control of this wallet. Never share them with a swap counterparty.'
          : 'This combined wallet requires both private keys for recovery. A spend-key mnemonic alone cannot restore this address. Keep both keys private.'}
      </div>
      {!revealed ? (
        <form className="import-form" onSubmit={reveal}>
          <label htmlFor="monero-recovery-secret">Confirm password or PIN</label>
          <input
            id="monero-recovery-secret"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="off"
            required
          />
          <button className="danger" disabled={busy}>
            {busy
              ? 'Unlocking...'
              : deterministic
                ? 'Reveal Recovery Mnemonic'
                : 'Reveal Recovery Keys'}
          </button>
        </form>
      ) : (
        <>
          {deterministic ? (
            <>
              <div className="seed-reveal-words">
                {mnemonic.split(' ').map((word, index) => (
                  <span className="seed-word" key={`${word}-${index}`}>
                    <span className="seed-word-index">{index + 1}</span>
                    {word}
                  </span>
                ))}
              </div>
              <CopyValue value={mnemonic} label="recovery phrase" />
            </>
          ) : null}
          <MoneroKeyList material={material} includeSecrets />
          <button className="secondary" type="button" onClick={() => setRevealed(false)}>
            Hide recovery details
          </button>
        </>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
