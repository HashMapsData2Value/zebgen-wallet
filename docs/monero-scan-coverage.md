# Monero Balance And Scan Coverage

The normal wallet shows spendable and mined-but-locked XMR separately. Both totals
exclude outputs reported spent by the selected daemon. Incoming mempool payments
are not included. Unlocking depends on chain height and transaction timelocks, not
elapsed wall-clock time; stagenet may advance slowly.

Locked amounts are grouped by unlock block. Each group shows its block height
and the number of blocks remaining relative to the last verified balance tip,
not an elapsed-time estimate. The unlock height is the later of the output's
confirmation maturity block and its additional block timelock. Groups exclude
spent outputs. Time-based timelocks are shown without a fixed unlock block.
Saved balances retain their schedule; stopped or ongoing scans show the last
verified values rather than an unverified countdown.

Scanned block spans are persisted with the encrypted output ledger per wallet,
network and daemon. Clearing or changing the height input does not erase this
ledger. Input changes apply after three seconds of inactivity; the scan button
applies immediately. Large missing ranges still require explicit confirmation via
the scan button before downloading history.

Spans use exclusive end heights internally. The UI shows inclusive block numbers.
For example, spans `[1000, 2000)` and `[2500, 3000)` leave blocks 2000 through 2499
unscanned. Requesting a scan from 1000 downloads that gap and any new blocks,
without downloading covered intervals again. Totals include all known unspent
outputs in the ledger, including earlier spans when requesting a higher start.
The UI lists unscanned ranges because those ranges may contain missing payments.

Each batch saves outputs and coverage before publishing progress. Saved span-end
hashes are checked against the daemon. A changed anchor conservatively discards
coverage and outputs before scanning again; an in-operation change rejects the
batch. This trusts the daemon and is not independent consensus verification.
Concurrent scans of the same wallet/network/daemon are rejected to avoid lost
checkpoint updates. Transaction construction retains its independent scan.

## Scanner Dependency

The wallet pins `zebgen-monero-wasm` 0.7.0, which includes unlock schedules in the
optional `unlocks` field: `{ height, amountAtomic }` groups (`height: null` for
time-based locks). Older saved balances show that unlock details are unavailable
until refreshed, rather than guessing. For local integration validation of
scanner changes:

```sh
cd ../zebgen-monero-wasm
./scripts/build.sh
cd ../zebgen
ZEBGEN_MONERO_WASM_DIR=../zebgen-monero-wasm/pkg ZEBGEN_BUILD_OUT_DIR=.output-scan-validation npm run build:firefox
```

The override is explicit and leaves the installed registry package and lockfile
unchanged. It is not used by normal release builds.
