# Saved combined-address context

Successful provider `computeCombinedMoneroAddress` approvals save context before
returning the public combined-address result. A failed encrypted save fails the
request. Context includes the original wallet ID, the exact network ID (regtest
is distinct from mainnet), combined address, counterparty public spend key,
counterparty private view key, and earliest restore height.

Records use the existing password/PIN vault helpers (PBKDF2 and AES-GCM) and live
in extension-local storage. Only the version and wallet/network/address index
are unencrypted. Counterparty keys and restore height are encrypted. The same
binding is inside authenticated ciphertext and is validated on read. Vault
access additionally re-derives the address using the original wallet. Concurrent
saves for the same binding use an extension-origin Web Lock.

Recomputing the same context retains the minimum saved restore height, never a
newer chain tip. The legacy address-height map can lower the initial height;
if the daemon is unavailable the initial height is zero. Funding scans prefer
an explicit height, then the encrypted context height, then the legacy map,
then zero. No combined private view key is returned to the requesting page.

The Monero LeakSwap panel lists saved addresses and heights for the selected
wallet and network after unlocking. The internal `loadMoneroCombinedContext`
accessor retrieves the validated counterparty context without the web page
having to retain it. The existing provider scan still takes counterparty keys.

This is durable local scan context, not a complete recovery backup or a swap
state machine. It does not store the owner's private spend key, the counterparty
private spend key, claim/refund signatures, or Algorand contract state. The
original owner wallet must remain in the vault; deleted wallets cannot be
recovered from these records. Preserve the owner's recovery phrase separately.
Clearing extension data or uninstalling the extension destroys this context.
Combined spending recovery still requires the separate appropriate key material.

Run focused checks with:

```sh
node --experimental-strip-types --no-warnings --test scripts/combinedAddressContext.test.mjs scripts/fundingProvider.test.mjs
npm run compile
```
