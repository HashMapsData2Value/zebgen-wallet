import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function setup(postError) {
  const api = {};
  const messages = [];
  let receive;
  let disconnect;
  let disconnected = 0;
  let heartbeat;
  let timerCleared = false;
  const runtime = {
    connect(options) {
      assert.equal(options.name, 'monero:balanceScan');
      return port;
    },
  };
  const port = {
    onMessage: {
      addListener(listener) {
        receive = listener;
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnect = listener;
      },
    },
    postMessage(message) {
      if (postError) throw postError;
      messages.push(message);
    },
    disconnect() {
      disconnected++;
      disconnect?.();
    },
  };
  const source = ts.transpileModule(
    readFileSync(new URL('../lib/network/messages.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  runInNewContext(source, {
    exports: api,
    DOMException,
    Error,
    console,
    setInterval(callback, milliseconds) {
      assert.equal(milliseconds, 10000);
      heartbeat = callback;
      return 1;
    },
    clearInterval(timer) {
      assert.equal(timer, 1);
      timerCleared = true;
    },
    require: () => ({ browser: { runtime } }),
  });
  return {
    api,
    messages,
    runtime,
    heartbeat: () => heartbeat(),
    get timerCleared() {
      return timerCleared;
    },
    receive: (message) => receive(message),
    disconnect: () => disconnect(),
    get disconnected() {
      return disconnected;
    },
  };
}

test('balance bridge disconnects immediately on Stop and ignores later progress', async () => {
  const harness = setup();
  const controller = new AbortController();
  let updates = 0;
  const result = harness.api.scanMoneroBalanceViaBackground(
    { restoreHeight: 0 },
    {
      signal: controller.signal,
      onProgress: () => {
        updates++;
      },
    },
  );
  assert.equal(harness.messages[0].request.restoreHeight, 0);
  harness.receive({ type: 'progress', progress: { scannedHeight: 100, targetHeight: 1000 } });
  assert.equal(updates, 1);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(harness.disconnected, 1);
  assert.equal(harness.timerCleared, true);
  harness.receive({ type: 'progress', progress: { scannedHeight: 200, targetHeight: 1000 } });
  assert.equal(updates, 1);
});

test('popup detach disconnects its viewer without sending Stop', async () => {
  const harness = setup();
  const controller = new AbortController();
  const result = harness.api.scanMoneroBalanceViaBackground(
    { restoreHeight: 0 },
    { signal: controller.signal },
  );
  controller.abort('detach');
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(harness.disconnected, 1);
  assert.equal(
    harness.messages.some((message) => message.type === 'stop'),
    false,
  );
});

test('balance bridge returns final result and surfaces unexpected disconnects', async () => {
  const harness = setup();
  const pending = harness.api.scanMoneroBalanceViaBackground({ restoreHeight: 100 });
  harness.receive({ type: 'result', result: { ok: true, balanceAtomic: '42' } });
  assert.equal((await pending).balanceAtomic, '42');
  assert.equal(harness.disconnected, 1);
  const dropped = setup();
  const interrupted = dropped.api.scanMoneroBalanceViaBackground({ restoreHeight: 0 });
  dropped.disconnect();
  await assert.rejects(interrupted, /Scan connection closed/);
});

test('quiet scans send keepalives and clean up the timer after completion', async () => {
  const harness = setup();
  const pending = harness.api.scanMoneroBalanceViaBackground({ restoreHeight: 0 });
  for (let count = 0; count < 4; count++) harness.heartbeat();
  assert.equal(harness.messages.filter((message) => message.type === 'keepalive').length, 4);
  harness.receive({ type: 'result', result: { ok: true, balanceAtomic: '0' } });
  await pending;
  assert.equal(harness.timerCleared, true);
});

test('disconnect reports Chrome runtime errors instead of hiding the reason', async () => {
  const harness = setup();
  const pending = harness.api.scanMoneroBalanceViaBackground({ restoreHeight: 0 });
  harness.runtime.lastError = {
    message: 'Could not establish connection. Receiving end does not exist.',
  };
  harness.disconnect();
  await assert.rejects(pending, /Receiving end does not exist.*Reload the Zebgen extension/);
  assert.equal(harness.timerCleared, true);
});

test('startup failures disconnect the port and clear the heartbeat', async () => {
  const harness = setup(new Error('Attempting to use a disconnected port object'));
  await assert.rejects(
    harness.api.scanMoneroBalanceViaBackground({ restoreHeight: 0 }),
    /disconnected port object/,
  );
  assert.equal(harness.disconnected, 1);
  assert.equal(harness.timerCleared, true);
});
