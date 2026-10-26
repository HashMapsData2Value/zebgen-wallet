import { Download, Upload } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';
import { unlockWallet } from '../../lib/wallet/algoWallet';
import { exportSwapBackup, restoreSwapBackup, MAX_SWAP_BACKUP_BYTES } from '../../lib/wallet/swapBackup';

export default function SwapBackupTools({ onRestore }: { onRestore: () => void }) {
  const [mode, setMode] = useState<'export' | 'restore'>('export');
  const [walletPassword, setWalletPassword] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await unlockWallet(walletPassword);
      if (mode === 'export') {
        if (backupPassword !== confirmation) throw new Error('Backup passwords do not match.');
        const text = await exportSwapBackup(browser.storage.local, walletPassword, backupPassword);
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `zebgen-swaps-${new Date().toISOString().replaceAll(':', '-')}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage('Encrypted backup download requested. Keep the file and its password separately.');
      } else {
        if (!file || file.size > MAX_SWAP_BACKUP_BYTES) throw new Error('Select a swap backup file smaller than 16 MiB.');
        const count = await restoreSwapBackup(browser.storage.local, await file.text(), backupPassword, walletPassword);
        setMessage(`Restored ${count} encrypted records. Restore the original Algorand identity and select matching networks before using the swaps.`);
        onRestore();
      }
    } catch (failure) {
      console.error('Swap backup operation failed', failure);
      setError(failure instanceof Error ? failure.message : 'Swap backup operation failed.');
    } finally {
      setWalletPassword(''); setBackupPassword(''); setConfirmation(''); setBusy(false);
    }
  }

  return <details className="swap-archive" aria-label="Encrypted swap backup">
    <summary>Encrypted swap backup</summary>
    <p>Contains secret swap shares and recovery records. Not a backup of your normal wallet mnemonics. Keep an external copy and update it after swap activity.</p>
    <form onSubmit={submit}>
      <fieldset disabled={busy} style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        <legend>Backup operation</legend>
        <label><input type="radio" name="swap-backup-mode" checked={mode === 'export'} onChange={() => { setMode('export'); setMessage(''); setError(''); }} /> Export</label>
        <label><input type="radio" name="swap-backup-mode" checked={mode === 'restore'} onChange={() => { setMode('restore'); setMessage(''); setError(''); }} /> Restore</label>
        {mode === 'restore' ? <>
          <p>Restore only into an empty swap store, with no pending swap approvals. Existing records will not be replaced.</p>
          <label htmlFor="swap-backup-file">Encrypted backup file</label>
          <input id="swap-backup-file" type="file" style={{ maxWidth: '100%', minWidth: 0 }} accept="application/json,.json" required onChange={event => setFile(event.target.files?.[0] ?? null)} />
        </> : null}
        <label htmlFor="swap-backup-wallet-password">Current wallet password</label>
        <input id="swap-backup-wallet-password" type="password" autoComplete="off" required value={walletPassword} onChange={event => setWalletPassword(event.target.value)} />
        <label htmlFor="swap-backup-password">Backup password</label>
        <input id="swap-backup-password" type="password" autoComplete="off" required minLength={mode === 'export' ? 12 : undefined} value={backupPassword} onChange={event => setBackupPassword(event.target.value)} />
        {mode === 'export' ? <>
          <label htmlFor="swap-backup-confirm">Confirm backup password</label>
          <input id="swap-backup-confirm" type="password" autoComplete="off" required minLength={12} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
        </> : null}
        <button type="submit" disabled={busy}>{mode === 'export' ? <Download size={18} /> : <Upload size={18} />} {busy ? 'Processing...' : mode === 'export' ? 'Export encrypted backup' : 'Restore encrypted backup'}</button>
      </fieldset>
    </form>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </details>;
}