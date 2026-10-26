import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';

test('activity reloads storage, polls read-only receipts, cleans up and ignores late responses', async () => {
  const states = [];
  let effects = [];
  const timers = [];
  const listeners = new Set();
  const logs = [];
  let stateIndex = 0;
  let loads = 0;
  let requests = 0;
  let fail = false;
  let release;
  let blocked = false;
  const saved = {
    hash: 'a'.repeat(64),
    amountAtomic: '10',
    feeAtomic: '1',
    createdAt: 123,
    state: 'unknown',
  };
  const api = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/MoneroActivity.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(compiled, {
    exports: api,
    console: { error: (...args) => logs.push(args) },
    window: {
      setInterval: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearInterval() {},
    },
    require: (name) => {
      if (name === 'react')
        return {
          useState(initial) {
            const index = stateIndex++;
            if (!(index in states)) states[index] = initial;
            return [
              states[index],
              (value) => {
                states[index] = typeof value === 'function' ? value(states[index]) : value;
              },
            ];
          },
          useEffect: (callback) => effects.push(callback),
        };
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'wxt/browser')
        return {
          browser: {
            storage: {
              local: {},
              onChanged: {
                addListener: (listener) => listeners.add(listener),
                removeListener: (listener) => listeners.delete(listener),
              },
            },
          },
        };
      if (name === 'lucide-react') return { RefreshCw: () => null };
      if (name === './CopyValue') return { default: () => null };
      if (name === './MoneroConfirmation') return { default: () => null };
      if (name.endsWith('/formatAtomic')) return { formatAtomic: (value) => value };
      if (name.endsWith('/moneroActivity'))
        return {
          MONERO_ACTIVITY_PREFIX: 'activity:',
          activityScope: (address, config) => ({
            address,
            network: config.network,
            daemon: config.daemon.uri,
          }),
          loadMoneroActivity: async () => {
            loads++;
            return [saved];
          },
        };
      if (name.endsWith('/messages'))
        return {
          transactionStatusViaBackground: async (request) => {
            requests++;
            assert.equal(request.hash, saved.hash);
            if (blocked)
              await new Promise((resolve) => {
                release = resolve;
              });
            if (fail) throw new Error('offline');
            return { ok: true, status: { state: 'pool', confirmations: 0 } };
          },
        };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const props = {
    address: 'sender',
    config: { network: 'regtest', daemon: { uri: 'http://localhost/' } },
    lockSecret: 'pin',
  };
  const render = () => {
    stateIndex = 0;
    effects = [];
    return api.default(props);
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  render();
  const stopLoading = effects[0]();
  await settle();
  const tree = render();
  function text(element) {
    if (!react.isValidElement(element)) return typeof element === 'string' ? element : '';
    return react.Children.toArray(element.props.children).map(text).join(' ');
  }
  assert.match(text(tree), new RegExp(saved.hash));
  const stopPolling = effects[1]();
  await settle();
  assert.equal(requests, 1);
  assert.equal(timers[0].delay, 10000);
  assert.match(api.activityStatusLabel(saved, states[1][saved.hash]), /pool.*0 confirmations/);
  for (const listener of listeners) listener({ unrelated: {} }, 'local');
  assert.equal(loads, 1);
  for (const listener of listeners) listener({ 'activity:new': {} }, 'local');
  await settle();
  assert.equal(loads, 2);
  fail = true;
  await timers[0].callback();
  assert.match(states[2][saved.hash], /stale/);
  assert.equal(logs.length, 1);
  assert.equal(states[1][saved.hash].state, 'pool');
  fail = false;
  blocked = true;
  const pending = timers[0].callback();
  await settle();
  stopPolling();
  const before = states[1];
  release();
  await pending;
  assert.equal(states[1], before);
  stopLoading();
  assert.equal(listeners.size, 0);
  assert.match(api.activityStatusLabel(saved, { state: 'unknown' }), /Unknown/);
  assert.match(
    api.activityStatusLabel(saved, { state: 'confirmed', block: '123', confirmations: 3 }),
    /123.*3 confirmations/,
  );
  assert.match(api.activityStatusLabel({ ...saved, state: 'relaying' }), /outcome not yet known/);
});
