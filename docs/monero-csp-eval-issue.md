# Known Issue: Real Monero Transactions Blocked by MV3 CSP (`eval`/`new Function`)

**Status:** Resolved by replacing `monero-ts` with
[`zebgen-monero-wasm`](https://github.com/HashMapsData2Value/zebgen-monero-wasm). Kept as a
historical record of the first of three `monero-ts` problems; see the
[README](../README.md#monero-why-zebgen-monero-wasm-instead-of-monero-ts) for the full story.
The original write-up follows unchanged.

## The issue

zebgen's background service worker cannot currently build or send a real Monero
transaction. Any call that ends up creating a real `monero-ts` wallet and
building a transaction (`monero:createTransaction` → `createMoneroTransaction()`
in [`lib/monero/moneroDaemon.ts`](../lib/monero/moneroDaemon.ts)) fails with:

```
Evaluating a string as JavaScript violates the following Content Security Policy directive
because 'unsafe-eval' is not an allowed source of script:
script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:*
```

This only happens once a real wallet is actually instantiated and used
(`monero.createWalletFull(...)` → `wallet.sync()` → `wallet.createTx()`). It does
**not** happen for pure key-generation (onboarding) or for read-only daemon
probing, because those code paths never load/execute the part of `monero-ts`
that trips this check.

### Why this only affects the background script

- zebgen's MV3 manifest CSP (declared in [`wxt.config.ts`](../wxt.config.ts))
  is: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`
  — `'wasm-unsafe-eval'` allows compiling/instantiating **WebAssembly**, but not
  plain JS `eval()` / `new Function(string)`.
- `monero-ts` normally runs the heavy wallet code (WASM + wallet logic) inside a
  dedicated Web Worker (`proxyToWorker: true`). MV3 **service workers cannot
  spawn nested Workers**, so zebgen explicitly sets `proxyToWorker: false`
  (see [`lib/monero/moneroDaemon.ts`](../lib/monero/moneroDaemon.ts)), which
  forces all of that same worker-bundled code to run in-thread, directly inside
  the background service worker — which is where the strict CSP is enforced.

## Why `monero-ts` needs `eval`/`new Function` here (root cause)

We traced this to the actual bundled code in
`node_modules/monero-ts/dist/monero.worker.js` (the bundle that
`proxyToWorker: false` still ends up executing in-thread). Two call sites use
`new Function(...)`:

1. **`GenUtils.isBrowser()`** — a utility that detects whether code is running
   in a browser:
   ```js
   let t = "function" == typeof importScripts,
       e = new Function("try {return this===window;}catch(e){return false;}")(),
       r = !!e && new Function("try {return window.nav...")();
   ```
2. **A bundler-injected "get global object" polyfill** (classic
   webpack/rollup helper for environments without `globalThis`):
   ```js
   r.g = function() {
     if ("object" == typeof globalThis) return globalThis;
     try { return this || new Function("return this")() }
     catch (t) { if ("object" == typeof window) return window }
   }()
   ```

**Neither of these actually needs dynamic code evaluation.** They are legacy
environment-sniffing shims from a bundler/build targeting older JS environments
that predate `globalThis` (standardized in ES2020). Modern equivalents exist
that need no string evaluation at all:
- `typeof window !== 'undefined'` instead of the `isBrowser()` `new Function` calls.
- `globalThis` directly instead of the `new Function("return this")()` fallback.

So this is **not a fundamental requirement of Monero wallet cryptography or
WASM** — it's an artifact of how `monero-ts`'s dependency bundle was built.

## Options going forward

1. **Patch `monero-ts`'s bundled output** (e.g. via `patch-package` or a Vite
   build-time string replace) to swap the two `new Function(...)` call sites
   above for their CSP-safe equivalents. No security tradeoff — we'd only be
   replacing environment detection, not removing any real functionality. This
   is the preferred long-term fix but requires maintaining a patch against a
   third-party dependency.
2. **Relax zebgen's CSP** to `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`.
   Simple, but a real security posture change to a production wallet extension
   (broadens what the background service worker is allowed to execute) — not
   something to do without explicit sign-off.
3. **Manual user workaround** (see below) — don't fix the code at all right
   now; have the person doing the swap perform the actual Monero *send* in an
   external wallet instead of inside zebgen.

## Manual workaround: what a user could do today

Because zebgen can still fully compute keys and addresses in-browser (only
*building/broadcasting a transaction* is blocked), a user hitting this bug
could route around it like this:

1. In zebgen, open the account/key view and **reveal the private spend key and
   private view key** for the relevant Monero account (or the combined wallet,
   once computed) — this is pure key material display, no transaction
   building involved, so it works fine today.
2. **Copy those keys into an external, full-featured Monero wallet** that has
   no browser-extension CSP restrictions — e.g. Feather Wallet, the official
   `monero-wallet-cli`/GUI, or a self-hosted `monero-wallet-rpc` instance —
   using its "restore from keys" / `generate_from_keys` import flow.
3. **Perform the actual send (or the final sweep) from that external wallet**,
   using the address zebgen displayed as the destination/source.
4. Continue using zebgen in-browser for everything else it *can* do purely
   client-side: generating accounts/addresses, computing the combined address
   with the counterparty, and signing/submitting the Algorand-side contract
   steps (deploy, fund, set ready, leaky claim).

This mirrors how some "signing-only"/watch-style wallets already expect a
companion full wallet for certain operations, so it's a reasonable stopgap —
but it does mean zebgen alone cannot yet complete a swap end-to-end without
that external hand-off, which should be fixed properly (option 1 or 2) before
relying on zebgen as a fully self-contained wallet.
