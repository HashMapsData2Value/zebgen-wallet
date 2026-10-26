export interface ConnectAccounts {
  algoAddress: string | null;
  moneroAddress: string | null;
}

export default function ConnectDisclosure({ accounts, choices, disabled = false, onChange }: {
  accounts: (ConnectAccounts & { moneroWalletId?: number | null }) | null;
  choices?: { algo: { id: number; address: string }[]; monero: { id: number; address: string }[] } | null;
  disabled?: boolean;
  onChange?: (accounts: { algoAddress: string | null; moneroAddress: string | null; moneroWalletId: number | null }) => void;
}) {
  return <div>
    <p>This site will see only the public ALGO and Monero addresses shown below when you connect. Connecting does not share your mnemonic, private spend keys, or Monero private view key, and does not authorize transactions.</p>
    <p>A Monero private view key is shared only later through a separately approved swap-sharing request.</p>
    <p>Choose the wallets to share with this site. Approving makes these your active wallets in Zebgen. Other sites connected to different wallets will require reconnection.</p>
    {accounts && choices && onChange ? <div className="connect-wallet-pickers">
      <label>Algorand wallet<select aria-label="Algorand wallet" disabled={disabled || choices.algo.length === 0} value={accounts.algoAddress ?? ''} onChange={event => onChange({ ...accounts, moneroWalletId: accounts.moneroWalletId ?? null, algoAddress: event.target.value || null })}>
        {!choices.algo.length ? <option value="">No Algorand wallet</option> : null}
        {choices.algo.map(wallet => <option key={wallet.id} value={wallet.address}>Wallet {wallet.id}: {wallet.address}</option>)}
      </select></label>
      <label>Monero wallet<select aria-label="Monero wallet" disabled={disabled || choices.monero.length === 0} value={accounts.moneroWalletId ?? ''} onChange={event => {
        const wallet = choices.monero.find(candidate => candidate.id === Number(event.target.value));
        onChange({ ...accounts, moneroWalletId: wallet?.id ?? null, moneroAddress: wallet?.address ?? null });
      }}>
        {!choices.monero.length ? <option value="">No Monero wallet</option> : null}
        {choices.monero.map(wallet => <option key={wallet.id} value={wallet.id}>Wallet {wallet.id}: {wallet.address}</option>)}
      </select></label>
    </div> : null}
    {accounts ? <dl>
      <dt>Public ALGO address</dt>
      <dd style={{ overflowWrap: 'anywhere', marginInlineStart: 0 }}>{accounts.algoAddress ?? 'No ALGO account. Create or import one in Zebgen before swapping.'}</dd>
      <dt>Public Monero address</dt>
      <dd style={{ overflowWrap: 'anywhere', marginInlineStart: 0 }}>{accounts.moneroAddress ?? 'No Monero wallet. Signed LeakSwap agreements create a dedicated swap share; an ALGO sender does not need an existing Monero wallet. To deposit XMR from Zebgen, create or import a funded Monero wallet.'}</dd>
    </dl> : <p role="status">Loading active accounts...</p>}
  </div>;
}