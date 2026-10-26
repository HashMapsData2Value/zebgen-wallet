import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { encryptSeed, decryptSeed } from '../lib/wallet/seedVault.ts';

function load(path, dependencies) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unmapped dependency ${name}`);
      return dependencies[name];
    },
    crypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    AbortController,
    console,
  });
  return exports;
}

test('scan checkpoint encrypts output state, survives reopening and rejects other passwords and identities', async () => {
  const values = {};
  const dependencies = {
    'wxt/browser': {
      browser: {
        storage: {
          local: {
            get: async (key) => ({ [key]: values[key] }),
            set: async (record) => Object.assign(values, record),
          },
        },
      },
    },
    './seedVault': { encryptSeed, decryptSeed },
  };
  const api = load('../lib/wallet/moneroScanCheckpoint.ts', dependencies);
  const checkpoint = { version: 1, nextHeight: 1234, outputs: [{ output: 'sensitive-output' }] };
  await api.saveScanCheckpoint('mainnet-address-100', checkpoint, 'long-test-password');
  assert.ok(!JSON.stringify(values).includes('sensitive-output'));
  const reopened = load('../lib/wallet/moneroScanCheckpoint.ts', dependencies);
  assert.equal(
    JSON.stringify(await reopened.loadScanCheckpoint('mainnet-address-100', 'long-test-password')),
    JSON.stringify(checkpoint),
  );
  await assert.rejects(reopened.loadScanCheckpoint('mainnet-address-100', 'wrong-password'));
  assert.equal(
    await reopened.loadScanCheckpoint('stagenet-address-100', 'long-test-password'),
    undefined,
  );
  const originalKey = await api.scanCheckpointStorageKey('mainnet-address-100');
  values[await api.scanCheckpointStorageKey('stagenet-address-100')] = values[originalKey];
  await assert.rejects(
    reopened.loadScanCheckpoint('stagenet-address-100', 'long-test-password'),
    /identity mismatch/,
  );
});

test('reattaching viewers shares one job, replays progress and explicit stop cancels it', async () => {
  let calls = 0;
  let control;
  let finish;
  const events = [];
  const { ScanJobs } = load('../lib/monero/scanJobs.ts', {
    '../wallet/moneroBalanceCache': {
      balanceCheckpointKey: (...parts) => JSON.stringify(parts),
    },
  });
  const jobs = new ScanJobs(
    async (_request, options) => {
      calls++;
      control = options;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    (key, event) => events.push({ key, event }),
  );
  const request = {
    config: { network: 'mainnet', daemon: { uri: 'https://node.invalid' } },
    primaryAddress: 'address',
    restoreHeight: 100,
  };
  jobs.start(request);
  control.onProgress({ scannedHeight: 200, targetHeight: 1000 });
  jobs.start(request);
  assert.equal(calls, 1);
  assert.equal(events.length, 2);
  assert.equal(events[1].event.progress.scannedHeight, 200);
  assert.equal(control.signal.aborted, false);
  jobs.stop(events[0].key);
  assert.equal(control.signal.aborted, true);
  finish({ ok: false, error: 'stopped' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.active, false);
});

test('different addresses run independently and one completion never completes the other', async () => {
  const controls = new Map();
  const finishes = new Map();
  const { ScanJobs, scanJobKey } = load('../lib/monero/scanJobs.ts', {
    '../wallet/moneroBalanceCache': { balanceCheckpointKey: (...parts) => JSON.stringify(parts) },
  });
  const jobs = new ScanJobs(
    (request, control) => {
      controls.set(request.primaryAddress, control);
      return new Promise((resolve) => finishes.set(request.primaryAddress, resolve));
    },
    () => {},
  );
  const first = {
    config: { network: 'mainnet', daemon: { uri: 'https://node.invalid' } },
    primaryAddress: 'first',
    restoreHeight: 0,
  };
  const second = { ...first, primaryAddress: 'second' };
  jobs.start(first);
  jobs.start(second);
  assert.equal(jobs.states.length, 2);
  assert.equal(controls.get('first').signal.aborted, false);
  finishes.get('first')({ ok: true, balanceAtomic: '0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.isActive(scanJobKey(first)), false);
  assert.equal(jobs.isActive(scanJobKey(second)), true);
  assert.equal(jobs.active, true);
  jobs.start(first);
  assert.equal(jobs.states.find((job) => job.address === 'first').result, undefined);
  jobs.stop(scanJobKey(first));
  assert.equal(controls.get('second').signal.aborted, false);
  finishes.get('first')({ ok: false, error: 'stopped' });
  finishes.get('second')({ ok: true, balanceAtomic: '0' });
});
