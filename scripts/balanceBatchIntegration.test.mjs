import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function setup({
  failSave = false,
  failAfterPreparation = false,
  oldScanner = false,
  checkpointTransactions = false,
  omitTransactionCheckpoint = false,
} = {}) {
  const calls = [];
  const observations = [];
  const errors = [];
  let checkpoint;
  const preparations = [];
  const dependencies = {
    'zebgen-monero-wasm': {
      default: async () => ({}),
      daemonNetwork: async () => 'stagenet',
      daemonHeight: async () => 300,
      primaryAddress: () => 'test-address',
      publicKeyFromPrivate: () => 'test-public',
      transactionCheckpointVersion: checkpointTransactions ? () => 2 : undefined,
      createTransaction: async (...args) => {
        preparations.push(args);
        const saved = args[10] === undefined ? undefined : JSON.parse(args[10]);
        if (checkpointTransactions) assert.equal(saved.nextHeight, 300);
        return {
          hash: 'test-hash',
          txHex: 'test-transaction',
          amountAtomic: '10',
          feeAtomic: '1',
          balanceAtomic: '42',
          relayed: false,
          checkpoint:
            checkpointTransactions && !omitTransactionCheckpoint
              ? JSON.stringify({ ...saved, preparedDelta: true })
              : undefined,
        };
      },
      scanBalanceBatch: async (...args) => {
        const saved = args[6] === undefined ? undefined : JSON.parse(args[6]);
        calls.push(saved);
        const height = Math.min(300, (saved?.nextHeight ?? 100) + 100);
        return JSON.stringify({
          checkpoint: {
            version: oldScanner ? 1 : 2,
            nextHeight: height,
            spans: [{ start: 100, end: height }],
            outputs: [{ output: 'retained-output' }],
          },
          scannedHeight: height,
          targetHeight: 300,
          done: height === 300,
          balanceAtomic: height === 300 ? '42' : '0',
          lockedAtomic: height === 300 ? '7' : '0',
          unlocks: height === 300 ? [{ height: 305, amountAtomic: '7' }] : [],
        });
      },
    },
    'zebgen-monero-wasm/zebgen_monero_wasm_bg.wasm?url&no-inline': { default: 'test.wasm' },
    '../network/networks': { networkLabel: (network) => network },
    '../wallet/moneroVault': {
      unlockMoneroWallet: async () => ({
        address: 'test-address',
        privateSpendKey: 'test-spend',
        privateViewKey: 'test-view',
      }),
    },
    '../wallet/moneroBalanceCache': {
      balanceCheckpointKey: (...parts) => JSON.stringify(parts),
      coverageCheckpointKey: (...parts) => JSON.stringify(parts),
      scanSpans: (value) => value,
      moneroUnlocks: (value) => value,
      saveBalanceCheckpoint: async (...args) => observations.push(args),
    },
    '../wallet/moneroScanCheckpoint': {
      loadScanCheckpoint: async () => checkpoint,
      saveScanCheckpoint: async (_identity, value) => {
        if (failSave || (failAfterPreparation && preparations.length > 0))
          throw new Error('storage quota exceeded');
        checkpoint = value;
      },
    },
    '../wallet/db': { setMoneroScanRestoreHeight: async () => {} },
  };
  const source = readFileSync(
    new URL('../lib/monero/moneroDaemon.ts', import.meta.url),
    'utf8',
  ).replaceAll('import.meta.env.MODE', "'test'");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports,
    URL,
    console: { error: (...args) => errors.push(args) },
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  const request = {
    config: { network: 'stagenet', networkType: 2, daemon: { uri: 'https://node.invalid' } },
    walletId: 1,
    primaryAddress: 'test-address',
    lockSecret: 'test-secret',
    restoreHeight: 100,
  };
  return {
    scan: (control, override = {}) =>
      exports.scanMoneroBalance({ ...request, ...override }, control),
    prepare: (override = {}) =>
      exports.createMoneroTransaction({
        ...request,
        privateSpendKey: 'test-spend',
        privateViewKey: 'test-view',
        recipient: 'recipient',
        amountAtomic: '10',
        relay: false,
        ...override,
      }),
    preparations,
    calls,
    observations,
    errors,
    get checkpoint() {
      return checkpoint;
    },
  };
}

test('transaction preparation reuses encrypted coverage without a second balance scan and persists the returned delta', async () => {
  const harness = setup({ checkpointTransactions: true });
  await harness.scan();
  const result = await harness.prepare();
  assert.equal(result.ok, true);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.preparations.length, 1);
  assert.equal(harness.preparations[0][9], false);
  assert.equal(harness.checkpoint.preparedDelta, true);
});

test('missing builder checkpoint and failed durable refresh fail closed', async () => {
  const missing = setup({ checkpointTransactions: true, omitTransactionCheckpoint: true });
  assert.match((await missing.prepare()).error, /did not return.*checkpoint/);
  const failed = setup({ checkpointTransactions: true, failSave: true });
  assert.equal((await failed.prepare()).ok, false);
  assert.equal(failed.preparations.length, 0);
});

test('published scanner without transaction checkpoint capability keeps legacy call compatibility', async () => {
  const harness = setup();
  assert.equal((await harness.prepare()).ok, true);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.preparations[0][10], undefined);
});

test('checkpoint write failure after signing cannot relay and releases the preparation lock', async () => {
  const harness = setup({ checkpointTransactions: true, failAfterPreparation: true });
  await harness.scan();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await harness.prepare();
    assert.equal(result.ok, false);
    assert.match(result.error, /storage quota exceeded/);
  }
  assert.equal(harness.preparations.length, 2);
  assert.ok(harness.preparations.every((args) => args[9] === false));
});

test('direct relay is rejected before scanning or building with either scanner version', async () => {
  for (const checkpointTransactions of [false, true]) {
    const harness = setup({ checkpointTransactions });
    const result = await harness.prepare({ relay: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /without relay.*separately reviewed send/);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.preparations.length, 0);
  }
});

test('cancellation after durable progress resumes with retained outputs and saves only a complete balance', async () => {
  const harness = setup();
  const controller = new AbortController();
  const stopped = await harness.scan({
    signal: controller.signal,
    onProgress: (progress) => {
      assert.equal(harness.checkpoint.nextHeight, progress.scannedHeight);
      assert.equal(progress.scannedHeight, 200);
      assert.equal(progress.startHeight, 100);
      controller.abort();
    },
  });
  assert.equal(stopped.ok, false);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.observations.length, 0);
  assert.equal(harness.checkpoint.outputs[0].output, 'retained-output');
  const resumed = await harness.scan();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.balanceAtomic, '42');
  assert.equal(resumed.lockedAtomic, '7');
  assert.equal(resumed.unlocks[0].height, 305);
  assert.equal(resumed.unlocks[0].amountAtomic, '7');
  assert.equal(harness.observations[0][1].unlocks[0].height, 305);
  assert.equal(harness.calls[1].nextHeight, 200);
  assert.equal(harness.calls[1].outputs[0].output, 'retained-output');
  assert.equal(harness.observations.length, 1);
  assert.equal(harness.observations[0][1].scannedHeight, 300);
  assert.equal(harness.observations[0][1].resumable, true);
});

test('checkpoint write failure stops before progress, another batch, or a balance observation', async () => {
  const harness = setup({ failSave: true });
  let progress = 0;
  const result = await harness.scan({
    onProgress: () => {
      progress++;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /storage quota exceeded/);
  assert.equal(harness.calls.length, 1);
  assert.equal(progress, 0);
  assert.equal(harness.checkpoint, undefined);
  assert.equal(harness.observations.length, 0);
  assert.equal(harness.errors.length, 1);
});

test('different restore heights cannot overwrite the same wallet coverage concurrently', async () => {
  const harness = setup();
  let competing;
  const result = await harness.scan({
    onProgress: () => {
      competing ??= harness.scan(undefined, { restoreHeight: 250 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal((await competing).ok, false);
  assert.match((await competing).error, /already running/);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.observations.length, 1);
});

test('old WASM results do not misrepresent missing locked data as zero', async () => {
  const harness = setup({ oldScanner: true });
  const result = await harness.scan();
  assert.equal(result.ok, false);
  assert.match(result.error, /Update the Monero WASM scanner/);
  assert.equal(harness.checkpoint, undefined);
  assert.equal(harness.observations.length, 0);
});
