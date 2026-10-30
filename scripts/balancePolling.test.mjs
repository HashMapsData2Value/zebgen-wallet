import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import * as scanHeight from '../lib/monero/scanHeight.ts';

test('zero spendable does not hide confirmed locked change or imply a zero total', () => {
  const values = [
    '0',
    '17500',
    false,
    null,
    null,
    17563,
    17563,
    false,
    null,
    false,
    '17500',
    '399000000000',
    [],
    [{ height: 17573, amountAtomic: '399000000000' }],
    17563,
  ];
  const compiled = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/MoneroBalance.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    require(name) {
      if (name === 'react')
        return {
          useState: () => [values.shift(), () => {}],
          useRef: (initial) => ({ current: initial }),
          useEffect: () => {},
        };
      if (name === 'react/jsx-runtime') return jsx;
      if (name.endsWith('/moneroBalanceCache'))
        return {
          coverageCheckpointKey: () => 'coverage',
          balanceCheckpointKey: () => 'checkpoint',
          unscannedSpans: () => [],
        };
      if (name.endsWith('/formatAtomic'))
        return {
          formatAtomic: (value) => String(Number(value) / 1e12),
        };
      return {};
    },
  });
  const tree = api.default({
    address: 'fixture',
    walletId: 1,
    lockSecret: 'fixture',
    restoreHeight: 17500,
    config: { network: 'stagenet', daemon: { uri: 'https://daemon.invalid' } },
  });
  function text(element) {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element !== 'object') return String(element);
    return react.Children.toArray(element.props.children).map(text).join('');
  }
  const content = text(tree);
  assert.match(content, /Spendable 0 XMR/);
  assert.match(content, /Confirmed total: 0\.399 XMR/);
  assert.match(content, /Locked: 0\.399 XMR/);
  assert.match(content, /10 blocks remaining/);
  assert.equal(content.match(/Locked:/g).length, 1);
});

test('Monero polls every five seconds, scans only changed heights, and keeps manual refresh', async () => {
  const effects = [];
  const timers = [];
  const values = ['1', '17500', false, null, null];
  let scans = 0;
  let height = 17563;
  let release;
  let blocked = false;
  const compiled = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/MoneroBalance.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    console,
    Date,
    AbortController,
    window: {
      setInterval: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearInterval: () => {},
    },
    require: (name) => {
      if (name === 'react')
        return {
          useState: (initial) => [values.length ? values.shift() : initial, () => {}],
          useRef: (initial) => ({ current: initial }),
          useEffect: (callback) => effects.push(callback),
        };
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'lucide-react') return { RefreshCw: () => null };
      if (name === './ScanActivity') return { default: () => null };
      if (name.endsWith('/scanHeight')) return scanHeight;
      if (name.endsWith('/formatAtomic')) return { formatAtomic: (value) => value };
      if (name.endsWith('/moneroBalanceCache'))
        return {
          balanceCheckpointKey: () => 'checkpoint',
          coverageCheckpointKey: () => 'coverage',
          scanSpans: (value) => value,
          unscannedSpans: () => [],
          loadBalanceCheckpoint: async () => null,
          saveBalanceCheckpoint: async () => {},
        };
      if (name.endsWith('/hostPermissions')) return { ensureHostPermissions: async () => {} };
      if (name.endsWith('/moneroScanCheckpoint'))
        return { loadScanCheckpoint: async () => undefined };
      if (name.endsWith('/messages'))
        return {
          probeMoneroDaemonViaBackground: async () => ({ ok: true, height }),
          scanMoneroBalanceViaBackground: async () => {
            scans++;
            if (blocked)
              await new Promise((resolve) => {
                release = resolve;
              });
            return { ok: true, balanceAtomic: '1' };
          },
        };
      return {};
    },
  });
  const tree = api.default({
    address: 'address',
    restoreHeight: 17500,
    config: { daemon: { uri: 'http://127.0.0.1:18081' } },
    walletId: 1,
    lockSecret: 'test',
  });
  const cleanup = effects.filter((_, index) => index !== 0).map((effect) => effect());
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5000);
  await timers[0].callback();
  assert.equal(scans, 1);
  await timers[0].callback();
  assert.equal(scans, 1);
  height++;
  blocked = true;
  const pending = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await timers[0].callback();
  assert.equal(scans, 2);
  release();
  await pending;
  blocked = false;
  function findButton(element) {
    if (!react.isValidElement(element)) return null;
    if (element.props['aria-label'] === 'Scan unlocked balance') return element;
    for (const child of react.Children.toArray(element.props.children)) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  findButton(tree).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 3);
  for (const dispose of cleanup) dispose?.();
});

test('Stop, manual height apply, debounced typing and blank input preserve scan state', async () => {
  const states = [];
  const effects = [];
  const timeouts = new Map();
  let nextTimeout = 0;
  const refs = [];
  const requests = [];
  let stateIndex;
  let refIndex;
  const api = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/MoneroBalance.tsx', import.meta.url), 'utf8'),
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
    console,
    Date,
    AbortController,
    window: {
      setTimeout(callback, delay) {
        const handle = ++nextTimeout;
        timeouts.set(handle, { callback, delay });
        return handle;
      },
      clearTimeout(handle) {
        timeouts.delete(handle);
      },
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
                states[index] = value;
              },
            ];
          },
          useRef(initial) {
            const index = refIndex++;
            return (refs[index] ??= { current: initial });
          },
          useEffect(callback) {
            effects.push(callback);
          },
        };
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'lucide-react') return { RefreshCw: () => null };
      if (name === './ScanActivity') return { default: 'scan-activity' };
      if (name.endsWith('/scanHeight')) return scanHeight;
      if (name.endsWith('/formatAtomic')) return { formatAtomic: (value) => value };
      if (name.endsWith('/moneroBalanceCache'))
        return {
          balanceCheckpointKey: () => 'checkpoint',
          coverageCheckpointKey: () => 'coverage',
          scanSpans: (value) => value,
          unscannedSpans: () => [],
          loadBalanceCheckpoint: async () => null,
          saveBalanceCheckpoint: async () => {},
        };
      if (name.endsWith('/hostPermissions')) return { ensureHostPermissions: async () => {} };
      if (name.endsWith('/moneroScanCheckpoint'))
        return { loadScanCheckpoint: async () => undefined };
      if (name.endsWith('/messages'))
        return {
          probeMoneroDaemonViaBackground: async () => ({ ok: true, height: 17563 }),
          isMoneroScanActive: async () => false,
          scanMoneroBalanceViaBackground: (request, control) =>
            new Promise((resolve) => {
              requests.push({ request, control, resolve });
            }),
        };
      return {};
    },
  });
  const props = {
    address: 'address',
    restoreHeight: 0,
    config: { daemon: { uri: 'http://127.0.0.1:18081' } },
    walletId: 1,
    lockSecret: 'test',
  };
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    effects.length = 0;
    return api.default(props);
  };
  function find(element, predicate) {
    if (!react.isValidElement(element)) return null;
    if (predicate(element)) return element;
    for (const child of react.Children.toArray(element.props.children)) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  find(render(), (element) => element.type === 'details').props.onToggle({
    currentTarget: { open: true },
  });
  assert.equal(
    find(render(), (element) => element.props['aria-label'] === 'Scan unlocked balance'),
    null,
  );
  const explicitScan = find(
    render(),
    (element) => element.type === 'button' && element.props.children === 'Scan from this height',
  );
  assert.equal(explicitScan.props.disabled, false);
  explicitScan.props.onClick();
  await settle();
  assert.equal(requests[0].request.restoreHeight, 0);
  find(render(), (element) => element.type === 'scan-activity').props.onStop();
  assert.equal(requests[0].control.signal.aborted, true);
  const heightInput = find(render(), (element) => element.props.id === 'balance-restore-height');
  assert.equal(heightInput.props.disabled, false);
  heightInput.props.onChange({ target: { value: '17500' } });
  find(
    render(),
    (element) => element.type === 'button' && element.props.children === 'Scan from this height',
  ).props.onClick();
  render();
  effects[0]();
  await settle();
  assert.equal(requests[1].request.restoreHeight, 17500);
  requests[0].resolve({ ok: true, balanceAtomic: '999' });
  await settle();
  assert.equal(
    find(render(), (element) => element.props['aria-busy'] !== undefined).props['aria-busy'],
    true,
  );
  requests[1].resolve({
    ok: true,
    balanceAtomic: '42',
    lockedAtomic: '7',
    unlocks: [
      { height: 17563, amountAtomic: '2' },
      { height: 17570, amountAtomic: '4' },
      { height: null, amountAtomic: '1' },
    ],
    spans: [{ start: 17500, end: 17563 }],
  });
  await settle();
  assert.equal(states[0], '42');
  assert.equal(
    find(render(), (element) => element.props['aria-busy'] !== undefined).props['aria-busy'],
    false,
  );
  const savedStatus = find(render(), (element) => element.props.role === 'status').props.children;
  assert.match(savedStatus, /Last verified balance/);
  const coverageText = (element) => {
    if (!react.isValidElement(element)) return String(element ?? '');
    return react.Children.toArray(element.props.children).map(coverageText).join('');
  };
  const savedCoverage = coverageText(
    find(render(), (element) => element.props['aria-label'] === 'Monero scan coverage'),
  );
  const unlockText = coverageText(
    find(render(), (element) => element.props['aria-label'] === 'Monero unlock schedule'),
  );
  assert.match(unlockText, /2 XMR: unlocks at block 17,563 \(1 block remaining\)/);
  assert.match(unlockText, /4 XMR: unlocks at block 17,570 \(8 blocks remaining\)/);
  assert.match(unlockText, /1 XMR: Time-locked; no fixed unlock block/);
  assert.match(savedCoverage, /17,500 - 17,562/);
  assert.match(
    coverageText(
      find(render(), (element) => element.props['aria-label'] === 'Locked Monero balance'),
    ),
    /Locked: 7 XMR/,
  );
  const changeHeight = (value) =>
    find(render(), (element) => element.props.id === 'balance-restore-height').props.onChange({
      target: { value },
    });
  changeHeight('');
  render();
  assert.equal(effects.at(-1)(), undefined);
  assert.equal(timeouts.size, 0);
  assert.equal(states[0], '42');
  assert.equal(
    coverageText(
      find(render(), (element) => element.props['aria-label'] === 'Monero scan coverage'),
    ),
    savedCoverage,
  );
  assert.equal(
    find(render(), (element) => element.props.role === 'status').props.children,
    savedStatus,
  );
  assert.equal(
    find(
      render(),
      (element) => element.type === 'button' && element.props.children === 'Scan from this height',
    ).props.disabled,
    true,
  );
  assert.equal(
    find(render(), (element) => element.props.className === 'privacy-notice'),
    null,
  );
  changeHeight('17');
  assert.equal(
    coverageText(
      find(render(), (element) => element.props['aria-label'] === 'Monero unlock schedule'),
    ),
    unlockText,
  );
  render();
  const cancelFirst = effects.at(-1)();
  assert.equal(timeouts.size, 1);
  assert.equal([...timeouts.values()][0].delay, 3000);
  assert.equal(requests.length, 2);
  changeHeight('17520');
  cancelFirst();
  render();
  const cancelSecond = effects.at(-1)();
  assert.equal(timeouts.size, 1);
  assert.equal(requests.length, 2);
  const pendingTimer = [...timeouts.values()][0];
  pendingTimer.callback();
  cancelSecond();
  render();
  effects[0]();
  await settle();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].request.restoreHeight, 17520);
  requests[2].resolve({ ok: true, balanceAtomic: '42' });
  await settle();
});
