import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('scan display cannot invoke privileged background APIs or open scan-start ports', () => {
  let messageListener;
  let connectListener;
  const calls = [];
  const runtime = {
    id: 'test',
    getURL: (path) => `chrome-extension://test${path}`,
    onConnect: {
      addListener: (listener) => {
        connectListener = listener;
      },
    },
    onMessage: {
      addListener: (listener) => {
        messageListener = listener;
      },
    },
  };
  class ScanJobs {
    states = [];
    stop(key) {
      calls.push(['stop', key]);
    }
  }
  const compiled = ts.transpileModule(
    readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(compiled, {
    exports: {},
    defineBackground: (setup) => setup(),
    console,
    require: (name) => {
      if (name === 'wxt/browser') return { browser: { runtime } };
      if (name === '../lib/monero/scanJobs') return { ScanJobs };
      return new Proxy(
        {},
        {
          get:
            (_target, property) =>
            (...args) => {
              calls.push([property, ...args]);
              throw new Error(`Unexpected privileged call: ${String(property)}`);
            },
        },
      );
    },
  });
  const denied = [
    { type: 'wallet:prepareTransaction', request: {} },
    { type: 'wallet:submitTransaction', id: 'test', lockSecret: 'test' },
    { type: 'monero:scanBalance', request: {} },
    { type: 'monero:scanEvent', key: 'test', event: { type: 'result', result: { ok: true } } },
    { channel: 'zebgen-pending', type: 'anything' },
    { channel: 'zebgen-provider', type: 'connect' },
  ];
  for (const suffix of ['', '?test', '#test']) {
    const sender = { id: 'test', url: `chrome-extension://test/scan.html${suffix}` };
    for (const message of denied) {
      assert.equal(
        messageListener(message, sender, () => assert.fail('Denied request responded')),
        false,
      );
    }
    let disconnected = false;
    connectListener({
      name: 'monero:balanceScan',
      sender,
      disconnect: () => {
        disconnected = true;
      },
    });
    assert.equal(disconnected, true);
  }
  assert.equal(calls.length, 0);
  messageListener(
    { type: 'monero:scanStop', key: 'test' },
    { id: 'test', url: 'chrome-extension://test/scan.html' },
    () => {},
  );
  assert.deepEqual(calls, [['stop', 'test']]);
});
