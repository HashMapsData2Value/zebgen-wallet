# ZebGen Wallet

Zebgen is an Algorand and Monero wallet created by HMD2V, currently focused on LeakSwap.

## Wallet navigation

Both chains have Overview, LeakSwap, and Settings sections. Overview contains
Send and Receive; LeakSwap opens the swap app and, for Monero, contains the
view-key sharing, address-combining, and combined-wallet recovery tools.
Private spend keys and recovery phrases are hidden from the overview. Monero
recovery details require reauthentication and are hidden when changing wallets.

LeakSwap's **Encrypted swap backup** exports dedicated random shares and recovery
records in a password-encrypted file. Keep an external copy and export again after
swap activity; the ordinary mnemonic cannot restore those random shares. Restore
is supported into an empty swap store and re-encrypts records with the destination
wallet password. Normal wallet mnemonics must be backed up separately. See
[Durable LeakSwap Records](docs/swap-persistence.md#encrypted-portable-backup).
Legacy agreements using normal Monero wallets are refused; swap operations no
longer fall back to normal-wallet key material, including in development builds.

Receive QR codes contain only public payment URIs: `monero:<address>` for
Monero and ARC-90 `algorand://<address>` for Algorand MainNet. Other Algorand
networks use `algorand://net:<network>/<address>`; scanners must support that
network selector, and a private LocalNet alias may not be recognized by other
wallets. The address copy button always copies the raw address. No secrets are
encoded in receiving QR codes.

Algorand balances refresh on account changes and every five seconds; superseded
requests cannot overwrite a newer result. Monero balances are scanned explicitly
from the chosen restore height, then poll for changed daemon heights every five
seconds. Balance scans show block progress and can be stopped; Stop aborts active
scan requests, pauses automatic rescans, and enables changing the restore height
before scanning again. Each completed batch is retained for resumption using the
incremental WASM API. Send review shows the prepared amount, fee, and
total debit; confirmation submits the retained signed transaction.

### Selected Chain And Endpoint

The network selection identifies the intended chain, not the endpoint's location.
A localhost node can serve public Mainnet, Testnet, or Stagenet. Monero's simulated
chain has a separate **Local Regtest** selection, despite using mainnet address
encoding. It is never labeled Mainnet in the wallet's regtest views.

Monero connection tests, scans, preparation, and broadcast verify the daemon's
reported network; mismatches fail before the operation. Algorand connection tests,
balances, and preparation check the reported genesis ID; broadcast also compares
the genesis ID and hash with the prepared transaction. Local simulated chains
require loopback endpoints. These checks detect configuration errors, not dishonest
nodes impersonating a chain. Offline Receive displays the selected chain, not a
claim of a verified live connection.

Incremental balance scanning, cancellation, and progress use the exact published
dependency `zebgen-monero-wasm@0.5.0`. No sibling WASM checkout is required to install
or build the extension. Transaction preparation is separate from cancellable
balance scans and still performs its own independent scan.

### Monero Scan Lifetime

Balance scans run in a separate inactive extension tab. Closing the popup or
locking the wallet UI detaches that viewer without stopping the scan. Reopening
the matching wallet reconnects to the active scan. Stop explicitly cancels the job.
Keep the scan tab open while work is in progress; closing it, browser shutdown,
tab discard, or extension reload can interrupt execution.

With the new `scanBalanceBatch` WASM API, each completed 100-block batch saves an
encrypted output ledger and cursor, scoped to the wallet, network, daemon, and
restore height. Locked outputs are retained and spent status is checked again on
completion. A changed chain anchor invalidates the checkpoint and restarts from
the chosen restore height. This avoids ordinary repeated historical scanning,
but reorgs, lost/corrupt storage, another endpoint, or a changed restore height can
require a rescan. Checkpoints are not an external backup.

The scan tab retains its scan credentials in memory until completion, even after
the wallet UI locks. They are not persisted in plaintext. After browser restart,
unlock and explicitly resume; the password and keys are not saved for unattended
restart. Transaction preparation still performs its own independent scan.

Restore heights are network-specific. Unrecognized legacy network metadata falls
back to block 0, never a different network's height. Imported mnemonics default to
previously funded: scan from block 0 or an explicit restore height. New or explicitly
unused wallets start near the selected daemon tip (20-block safety overlap).

## Installing a release build (testers)

This repository starts from a clean source snapshot tagged `v0.0.0`, without the
previous repository's Git history. Versions remain below 1.0 during testing.

Release-worthy [Conventional Commits](https://www.conventionalcommits.org/) on
`main` publish beta prereleases, for example `v0.0.1-beta.1`. To publish a stable
version, merge `main` into the case-sensitive `Release` branch. That publishes
`v0.0.1` without the beta suffix. Merge `Release` back into `main` after publishing
to synchronize release metadata. Fixes bump patch versions; features and breaking
changes bump minor versions. Production 1.0 requires deliberately changing the
pre-1.0 breaking-change release rule.

[GitHub Releases](https://github.com/HashMapsData2Value/zebgen-wallet/releases)
contain Chrome and Firefox ZIPs. The landing page's download buttons resolve the
latest stable release, or the newest published beta when no stable release exists.
All beta builds are also available on the releases page. To try a build:

1. Download the `zebgen-<version>-chrome.zip` (or `-firefox.zip`) asset
   from the latest release.
2. Unzip it.
3. **Chrome/Chromium**: open `chrome://extensions`, enable "Developer mode",
   click "Load unpacked", and select the unzipped folder.
4. **Firefox**: open `about:debugging#/runtime/this-firefox`, click
   "Load Temporary Add-on", and select the `manifest.json` inside the
   unzipped folder.

This extension is not published on the Chrome Web Store or Firefox AMO — it's
distributed this way for testers only. Release builds expose `window.zebgen`
only on `https://app.leakswap.com/*`. The LeakSwap homepage is hosted separately
at `https://leakswap.com`; `https://zebgen.com` is reserved for the extension's
landing/download page. DNS and hosting must be configured separately.

### Local development and browser tests

Install the npm dependencies before compiling or building:

```sh
npm ci
npm run compile
```

Protocol utilities come from the npm dependency `leakswap-utils` (`>=1.2.0`).
The range allows newer major versions too. Run `npm update leakswap-utils` to
resolve a newer release, validate it, and commit the updated lockfile; `npm ci`
reproduces the reviewed lockfile rather than silently updating dependencies.
No sibling checkout or Git submodule is required. Contract artifacts not shipped
in that package are pinned locally in `lib/contracts`; see its provenance notes.

`npm run dev` enables provider access on `http://localhost/*` and
`http://127.0.0.1/*`, in addition to the production swap domain. For local
browser tests, run `npm run build:e2e`; the test helpers load
`.output/chrome-mv3-e2e`. Normal `npm run build` release builds exclude local
pages. This restriction applies to dApp provider injection, not to the local
RPC nodes configured in Network Settings.

## Monero: why zebgen-monero-wasm instead of monero-ts

zebgen does all Monero cryptography (scanning for your funds, building and
signing transactions) inside the extension using
[`zebgen-monero-wasm`](https://github.com/HashMapsData2Value/zebgen-monero-wasm),
a small Rust wrapper around the [monero-oxide](https://github.com/monero-oxide/monero-oxide)
crates `monero-wallet` and `monero-daemon-rpc` (pinned to exactly `0.2.0`),
compiled to WebAssembly. Earlier versions used
[`monero-ts`](https://github.com/woodser/monero-ts). This section explains why we
switched, and what the new approach does and does not protect you from.

### What went wrong with monero-ts

`monero-ts` wraps Monero's own C++ wallet (`wallet2`), compiled to WebAssembly
with Emscripten. That WebAssembly ships as a **prebuilt file** inside the npm
package; `monero-ts`'s own build doesn't produce it. Using `monero-ts@0.11.10`
inside an MV3 extension, we hit three separate problems:

1. **It needs `eval`, which the extension's security policy forbids.** Bundled
   environment-detection code calls `new Function(...)`. MV3 extensions only
   allow WebAssembly (`'wasm-unsafe-eval'`), not JavaScript `eval`. The only
   ways around it were to loosen zebgen's security policy (unacceptable for a
   wallet) or patch `monero-ts`'s files, which we did with `patch-package`.
   Background: [`docs/monero-csp-eval-issue.md`](docs/monero-csp-eval-issue.md).
2. **Its network code breaks when bundled.** A `typeof require` check left
   `monero-ts`'s internal HTTP client undefined after Vite bundling, so every
   call to a Monero node crashed. Also patched.
3. **Scanning for funds crashes inside the prebuilt WebAssembly.** With both
   patches applied, `wallet.sync()` still failed every time with
   `Exception in thread pool` (sometimes `failed to parse address`). We
   reproduced the identical error in plain Node.js with no browser involved,
   so it isn't caused by the extension environment. Retries and smaller scan
   ranges didn't help, and the same error is reported upstream in
   [woodser/monero-ts#249](https://github.com/woodser/monero-ts/issues/249).
   Because it happens inside the prebuilt binary, we couldn't patch or
   debug it, and moving the code to an offscreen document or an Electron app
   wouldn't have changed anything.

The net result: zebgen could create keys and addresses, but could **not**
send Monero. The only workaround was exporting your private keys into a
separate wallet program, which defeats the point of a self-contained wallet.

### What zebgen does now

```
zebgen extension (keys never leave)              any Monero node you choose
┌─────────────────────────────────────┐         ┌──────────────────────────┐
│ private spend + view keys           │ blocks, │ - your own monerod       │
│ zebgen-monero-wasm (monero-oxide):  │◄────────┤ - a public/3rd-party node│
│   scan, pick coins, sign            │ decoys, │ - a hosted node API      │
│                                     │ fees    │                          │
│                                     ├────────►│ broadcasts the signed tx │
└─────────────────────────────────────┘ signed  └──────────────────────────┘
                                          tx only
```

- **Your keys never leave the extension.** zebgen downloads whole blocks and
  scans them locally, so the node never receives your view key (unlike "light
  wallet" servers). Ordinary Monero operations do not send private spend or
  view keys. RPC requests also include output key images for spent-status
  checks, decoy queries, and the finished signed transaction for broadcast.
  LeakSwap settlement deliberately discloses its swap spend share to the
  Algorand simulation node; this is separate from Monero scanning.
- **Built from source.** zebgen-monero-wasm is compiled from Rust source by its
  build script, which also fails if the generated JavaScript ever uses `eval`.
  There's no prebuilt binary to trust, no patches, and no Web Workers.
- **Smaller.** About 1.5 MB of WebAssembly, replacing `monero-ts` and its 46
  npm dependencies.
- **Nodes:** any node URL can be configured in Network Settings. zebgen asks
  for browser permission the first time it contacts a host other than
  `localhost`/`127.0.0.1`. Nodes running `--restricted-rpc` (the usual mode
  for public nodes) work, and so do username/password logins.
- **Send entire balance:** the Send XMR form can send everything except the
  fee in one transaction, e.g. to empty a recovered swap wallet.

### Limitations and trade-offs

- **monero-oxide is young.** It's a 0.x Rust reimplementation of Monero, not
  the reference `wallet2` code. The monero-oxide project publishes a
  third-party audit in its repository, but it has far less real-world use than
  `wallet2`.
- **Remote nodes learn sensitive wallet activity.** Balance scans and send
  preparation submit the wallet's output key images together to
  `is_key_image_spent`. A node can associate these with one client and recognize
  corresponding spends. It also sees the client's network address, requested
  block ranges, decoy queries and transactions submitted for relay. Private
  keys are not sent, but this is not a metadata-private remote-node design.
- **Prefer your own fully synchronized Monero node.** A remote node can lie
  about height, funding, spent status and fees, withhold data or transactions,
  and undermine privacy through the data used for decoy selection. Network
  labels returned by RPC are not independently verified consensus proofs.
  Local signing alone does not make remote-node data trustworthy, especially
  when cross-chain decisions depend on it. Our hosted nodes require the same
  trust assessment as anyone else's.
- **Tor helps with network privacy, not node honesty.** An independently
  operated node reached over Tor can reduce direct IP exposure, but still sees
  the RPC data above and can return dishonest responses. Zebgen has no built-in
  Tor or SOCKS transport: configure and verify a compatible browser/OS routing
  setup or a local gateway separately. Pasting an onion URL into Settings does
  not by itself establish Tor routing. Protect any gateway's RPC access and
  credentials, and do not assume a localhost URL proves its upstream is trusted.
- **The node may be able to tell you're using monero-oxide** from the way it
  requests data, even though the transactions themselves are built to look
  like ones from Monero's own wallet.
- **Scanning costs bandwidth.** zebgen downloads every block from the restore
  height onward. It records the chain height (minus a 20-block safety margin)
  when it generates a wallet and when it computes a swap's combined address,
  and pre-fills that in Send XMR, so only blocks since then are downloaded.
  Imported wallets have no recorded height: enter one at or before the wallet
  first received funds, because 0 on mainnet means downloading the whole chain.
  If the node can't be reached at creation time, no height is recorded.
- **Node logins:** monerod's built-in login (HTTP Digest) only works if the
  browser reuses the same network connection, which Chrome does. Over the
  internet, use HTTPS.
- Only RingCT outputs can be spent. Older, pre-RingCT outputs aren't
  supported; a new wallet won't have any.

### How it was checked

Against a local Monero regtest network:

- 200 random key sets produce identical public keys and addresses in
  zebgen-monero-wasm and zebgen's own TypeScript code, on all three networks.
- A full send (mine, scan, send 1 XMR, check change) was confirmed
  independently by Monero's own wallet (`monero-wallet-rpc`).
- zebgen's own "Send XMR" button sent and relayed a transaction from the
  extension, including through a `--restricted-rpc` port with a login.
