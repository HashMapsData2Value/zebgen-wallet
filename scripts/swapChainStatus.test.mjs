import assert from 'node:assert/strict';
import test from 'node:test';
import algosdk from 'algosdk';
import { readSwapChainStatus } from '../lib/wallet/swapChainStatus.ts';

const ali = algosdk.generateAccount();
const xin = algosdk.generateAccount();
const record = {
  appId: '123',
  appAddress: algosdk.getApplicationAddress(123n).toString(),
  role: 'ali',
  genesisHash: 'saved-genesis',
  aliAddress: ali.addr.toString(),
  xinAddress: xin.addr.toString(),
  t0: 10000,
  t1: 17200,
  context: { network: 'stagenet' },
};
const uint = (key, value) => ({
  key: new TextEncoder().encode(key),
  value: { type: 2, uint: BigInt(value), bytes: new Uint8Array() },
});
const address = (key, value) => ({
  key: new TextEncoder().encode(key),
  value: { type: 1, uint: 0n, bytes: value.publicKey },
});
const globals = (ready) => [
  uint('t0', 10000),
  uint('t1', 17200),
  uint('aliReady', ready),
  address('aliAlgoAddr', ali.addr),
  address('xinAlgoAddr', xin.addr),
];
const calls = [];
function node({
  ready = 0,
  amount = 5000000n,
  appError,
  accountError,
  state = globals(ready),
} = {}) {
  return {
    getApplicationByID: (appId) => ({
      do: async () => {
        calls.push(['app', appId]);
        if (appError) throw appError;
        return { params: { globalState: state } };
      },
    }),
    accountInformation: (account) => ({
      do: async () => {
        calls.push(['account', account]);
        if (accountError) throw accountError;
        return { amount };
      },
    }),
  };
}
const read = (client, overrides = {}) =>
  readSwapChainStatus({ ...record, ...overrides }, client, 'saved-genesis', 9000, 9000);

test('reads matching contract readiness and exact escrow balances', async () => {
  const funded = await read(node());
  assert.equal(funded.state, 'awaiting');
  assert.equal(funded.funding, 'present');
  assert.equal(funded.escrowAtomic, '5000000');
  assert.equal((await read(node({ ready: 1 }))).state, 'ready');
  assert.equal((await read(node({ amount: 0n }))).funding, 'empty');
  assert.equal((await read(node({ accountError: { status: 404 } }))).funding, 'empty');
});

test('only a matching-network application 404 counts as unavailable', async () => {
  assert.equal((await read(node({ appError: { status: 404 } }))).state, 'unavailable');
  const before = calls.length;
  const mismatch = await readSwapChainStatus(record, node(), 'different-genesis', 9000, 9000);
  assert.equal(mismatch.state, 'unknown');
  assert.match(mismatch.issue, /another Algorand network/);
  assert.equal(calls.length, before);
  assert.equal((await read(null)).state, 'unknown');
});

test('changed parties, deadlines, readiness and escrow identities are rejected', async () => {
  for (const state of [
    globals(0).filter((entry) => new TextDecoder().decode(entry.key) !== 't0'),
    [uint('t0', 9999), ...globals(0).slice(1)],
    globals(2),
    [...globals(0).slice(0, 3), address('aliAlgoAddr', xin.addr), address('xinAlgoAddr', xin.addr)],
  ]) {
    const result = await read(node({ state }));
    assert.equal(result.state, 'unknown');
    assert.match(result.issue, /do not match/);
  }
  const changed = await read(node(), { appAddress: ali.addr.toString() });
  assert.equal(changed.state, 'unknown');
  assert.match(changed.issue, /escrow address/);
});

test('RPC errors remain unknown instead of pretending funds are absent or settled', async () => {
  const original = console.error;
  const failures = [];
  console.error = (...args) => failures.push(args);
  try {
    const failure = new Error('Node unreachable');
    assert.equal((await read(node({ appError: failure }))).state, 'unknown');
    const escrow = await read(node({ accountError: failure }));
    assert.equal(escrow.state, 'awaiting');
    assert.equal(escrow.funding, 'unknown');
    assert.equal(escrow.escrowAtomic, undefined);
    assert.equal(failures.length, 2);
    assert.equal(failures[0][1], failure);
  } finally {
    console.error = original;
  }
});
