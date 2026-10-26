import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import * as scanHeight from '../lib/monero/scanHeight.ts';

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
const now = 1_800_000_000_000;
const checkpoint = {
  balanceAtomic: '4200000000000',
  scannedHeight: 17563,
  scannedAt: now - 60_000,
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function findAll(element, predicate) {
  if (!react.isValidElement(element)) return [];
  return [
    ...(predicate(element) ? [element] : []),
    ...react.Children.toArray(element.props.children).flatMap((child) => findAll(child, predicate)),
  ];
}

function text(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return '';
  if (typeof element !== 'object') return String(element);
  return react.Children.toArray(element.props.children).map(text).join('');
}

function harness(options = {}) {
  const states = [];
  const refs = [];
  const effects = [];
  const timers = new Map();
  const loads = [];
  const saves = [];
  const probes = [];
  const scans = [];
  const permissions = [];
  const errors = [];
  const lateState = [];
  let stateIndex;
  let refIndex;
  let effectIndex;
  let timerId = 0;
  let dirty = false;
  let disposed = false;
  let tree;
  let tip = options.tip ?? checkpoint.scannedHeight;
  let savedCheckpoint;
  let props = {
    address: 'fixture-address',
    walletId: 1,
    lockSecret: 'fixture-only-unlock',
    restoreHeight: 17500,
    config: { network: 'stagenet', daemon: { uri: 'https://daemon.invalid' } },
    ...options.props,
  };
  const keyFor = (network, daemon, address, height) =>
    JSON.stringify([network, daemon, address, height]);
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    AbortController,
    Error,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    console: { error: (...args) => errors.push(args) },
    window: {
      setInterval(callback, delay) {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearInterval(id) {
        timers.delete(id);
      },
    },
    require(name) {
      if (name === 'react')
        return {
          useState(initial) {
            const index = stateIndex++;
            if (!(index in states))
              states[index] = typeof initial === 'function' ? initial() : initial;
            return [
              states[index],
              (value) => {
                if (disposed) lateState.push({ index, value });
                const next = typeof value === 'function' ? value(states[index]) : value;
                if (!Object.is(states[index], next)) {
                  states[index] = next;
                  dirty = true;
                }
              },
            ];
          },
          useRef(initial) {
            const index = refIndex++;
            return (refs[index] ??= { current: initial });
          },
          useEffect(callback, dependencies) {
            const index = effectIndex++;
            const previous = effects[index];
            const changed =
              !previous ||
              !dependencies ||
              dependencies.some(
                (value, offset) => !Object.is(value, previous.dependencies?.[offset]),
              );
            effects[index] = { dependencies, cleanup: previous?.cleanup, callback, changed };
          },
        };
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'lucide-react') return { RefreshCw: () => null };
      if (name === './ScanActivity') return { default: 'scan-activity' };
      if (name === './MoneroChainHeight') return { default: 'chain-height' };
      if (name.endsWith('/scanHeight')) return scanHeight;
      if (name.endsWith('/formatAtomic'))
        return {
          formatAtomic(value, decimals) {
            assert.equal(decimals, 12);
            return `${BigInt(value) / 1_000_000_000_000n}.${String(BigInt(value) % 1_000_000_000_000n).padStart(12, '0')}`;
          },
        };
      if (name.endsWith('/moneroBalanceCache'))
        return {
          balanceCheckpointKey: keyFor,
          async loadBalanceCheckpoint(...args) {
            loads.push(args);
            return options.load
              ? options.load(...args)
              : (savedCheckpoint ??
                  (options.checkpoint === undefined ? checkpoint : options.checkpoint));
          },
          async saveBalanceCheckpoint(...args) {
            saves.push(args);
          },
        };
      if (name.endsWith('/hostPermissions'))
        return {
          async ensureHostPermissions(...args) {
            permissions.push(args);
          },
        };
      if (name.endsWith('/messages'))
        return {
          async isMoneroScanActive() {
            return options.activeScan === true;
          },
          async probeMoneroDaemonViaBackground(config) {
            probes.push(config);
            return { ok: true, height: tip };
          },
          async scanMoneroBalanceViaBackground(request, control) {
            scans.push({ request, control });
            if (options.scan) return options.scan(request, control);
            savedCheckpoint = {
              balanceAtomic: '7300000000000',
              scannedHeight: tip,
              scannedAt: now,
              resumable: true,
            };
            return { ok: true, balanceAtomic: '7300000000000' };
          },
        };
      throw new Error(`Unexpected component dependency: ${name}`);
    },
  });

  function render(changes = {}) {
    assert.equal(disposed, false);
    props = { ...props, ...changes };
    stateIndex = 0;
    refIndex = 0;
    effectIndex = 0;
    dirty = false;
    tree = api.default(props);
    const changed = effects.filter((effect) => effect.changed);
    for (const effect of changed) effect.cleanup?.();
    for (const effect of changed) {
      effect.changed = false;
      effect.cleanup = effect.callback();
    }
    return tree;
  }

  async function settle() {
    for (let turn = 0; turn < 8; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (dirty && !disposed) render();
    }
    assert.equal(dirty && !disposed, false, 'component updates should settle');
  }

  return {
    loads,
    saves,
    probes,
    scans,
    permissions,
    errors,
    lateState,
    timers,
    render,
    settle,
    key: () =>
      keyFor(
        props.config.network,
        props.config.daemon.uri,
        props.address,
        Number(props.restoreHeight),
      ),
    get tree() {
      return tree;
    },
    amount: () => text(findAll(tree, (element) => element.props.className === 'balance-amount')[0]),
    statuses: () => findAll(tree, (element) => element.props.role === 'status').map(text),
    alerts: () => findAll(tree, (element) => element.props.role === 'alert').map(text),
    setTip(height) {
      tip = height;
    },
    async poll() {
      assert.equal(timers.size, 1, 'exactly one balance poll should be active');
      const timer = [...timers.values()][0];
      assert.equal(timer.delay, 5000);
      await timer.callback();
      await settle();
    },
    unmount() {
      for (const effect of effects) effect.cleanup?.();
      disposed = true;
    },
  };
}

test('mount restores encrypted-vault checkpoint balance, verification time and height; unchanged tip never scans', async (context) => {
  const view = harness();
  context.after(() => view.unmount());
  view.render();
  await view.settle();
  assert.deepEqual(view.loads, [[view.key(), 'fixture-only-unlock']]);
  assert.equal(view.amount(), '4.200000000000 XMR');
  assert.deepEqual(view.statuses(), [
    `Last verified unlocked balance · block 17563 · ${new Date(checkpoint.scannedAt).toLocaleString()}`,
  ]);
  assert.equal(view.probes.length, 1);
  await view.poll();
  assert.equal(view.probes.length, 2);
  assert.equal(view.scans.length, 0);
  assert.equal(view.permissions.length, 0);
  assert.equal(view.saves.length, 0);
});

for (const trigger of ['mount', 'poll']) {
  test(`newer tip at ${trigger} scans without requesting permissions and saves the new checkpoint`, async (context) => {
    const view = harness({ tip: trigger === 'mount' ? 17564 : 17563 });
    context.after(() => view.unmount());
    view.render();
    await view.settle();
    if (trigger === 'poll') {
      view.setTip(17564);
      await view.poll();
    }
    assert.equal(view.scans.length, 1);
    assert.deepEqual(plain(view.scans[0].request), {
      config: { network: 'stagenet', daemon: { uri: 'https://daemon.invalid' } },
      primaryAddress: 'fixture-address',
      walletId: 1,
      lockSecret: 'fixture-only-unlock',
      restoreHeight: 17500,
    });
    assert.equal(view.scans[0].control.signal.aborted, false);
    assert.equal(view.permissions.length, 0, 'automatic scan must use scan(false)');
    assert.equal(view.saves.length, 0, 'the scan host owns durable checkpoint writes');
    assert.equal(view.amount(), '7.300000000000 XMR');
    assert.deepEqual(view.statuses(), [
      `Last verified unlocked balance · block 17564 · ${new Date(now).toLocaleString()}`,
    ]);
    await view.poll();
    assert.equal(view.scans.length, 1, 'saved tip must suppress redundant scans');
  });
}

test('no cache and exactly 5000 blocks of history automatically scans and saves', async (context) => {
  const view = harness({ checkpoint: null, tip: 22500 });
  context.after(() => view.unmount());
  view.render();
  await view.settle();
  assert.equal(view.scans.length, 1);
  assert.equal(view.scans[0].request.restoreHeight, 17500);
  assert.equal(view.permissions.length, 0);
  assert.equal(view.saves.length, 0);
  assert.equal(view.amount(), '7.300000000000 XMR');
  assert.equal(view.alerts().length, 0);
});

for (const cached of [true, false]) {
  test(`more than 5000 history blocks never auto-downloads on mount (${cached ? 'cached total retained' : 'no cache'})`, async (context) => {
    const view = harness({ checkpoint: cached ? checkpoint : null, tip: 22501 });
    context.after(() => view.unmount());
    view.render();
    await view.settle();
    assert.equal(view.scans.length, 0);
    assert.equal(view.permissions.length, 0);
    assert.equal(view.saves.length, 0);
    assert.equal(view.amount(), cached ? '4.200000000000 XMR' : 'Balance not checked');
    assert.ok(view.statuses().includes('Scan required. Refresh to allow the history download.'));
    if (cached) {
      assert.ok(view.statuses()[0].includes('block 17563'));
      await view.poll();
      assert.equal(view.scans.length, 0);
      assert.equal(view.amount(), '4.200000000000 XMR');
      assert.ok(
        view
          .statuses()
          .includes(
            'New blocks available. Refresh to download the missing history; the saved balance may be stale.',
          ),
      );
    }
  });
}

test('polling a newer tip beyond 5000 history blocks retains cached total and requests explicit refresh', async (context) => {
  const view = harness();
  context.after(() => view.unmount());
  view.render();
  await view.settle();
  view.setTip(22501);
  await view.poll();
  assert.equal(view.scans.length, 0);
  assert.equal(view.saves.length, 0);
  assert.equal(view.amount(), '4.200000000000 XMR');
  assert.ok(
    view
      .statuses()
      .includes(
        'New blocks available. Refresh to download the missing history; the saved balance may be stale.',
      ),
  );
});

test('reopening attaches to an active long scan without starting a duplicate download', async (context) => {
  const pending = deferred();
  const view = harness({
    activeScan: true,
    checkpoint: null,
    tip: 3_000_000,
    scan: () => pending.promise,
  });
  context.after(() => view.unmount());
  view.render();
  await view.settle();
  assert.equal(view.scans.length, 1);
  assert.equal(view.tree.props['aria-busy'], true);
  assert.equal(view.permissions.length, 0);
});

test('unmount before delayed cache read resolves prevents probes, scans and state updates', async () => {
  const cacheRead = deferred();
  const view = harness({ load: () => cacheRead.promise, tip: 17564 });
  view.render();
  assert.equal(view.loads.length, 1);
  view.unmount();
  cacheRead.resolve(checkpoint);
  await view.settle();
  assert.equal(view.probes.length, 0);
  assert.equal(view.scans.length, 0);
  assert.equal(view.saves.length, 0);
  assert.equal(view.timers.size, 0);
  assert.deepEqual(view.lateState, []);
});

for (const change of ['wallet', 'unlock secret', 'checkpoint key']) {
  test(`${change} change aborts prior scan and ignores its late progress and result`, async (context) => {
    const pendingScan = deferred();
    const view = harness({ tip: 17564, scan: () => pendingScan.promise });
    context.after(() => view.unmount());
    view.render();
    await view.settle();
    assert.equal(view.scans.length, 1);
    const prior = view.scans[0];
    view.setTip(checkpoint.scannedHeight);
    if (change === 'wallet') view.render({ address: 'other-fixture-address', walletId: 2 });
    if (change === 'unlock secret') view.render({ lockSecret: 'other-fixture-unlock' });
    if (change === 'checkpoint key') {
      findAll(
        view.tree,
        (element) => element.props.id === 'balance-restore-height',
      )[0].props.onChange({ target: { value: '17501' } });
      view.render();
    }
    assert.equal(prior.control.signal.aborted, true);
    assert.equal(prior.control.signal.reason, 'detach');
    await view.settle();
    assert.equal(view.loads.length, 2);
    assert.notDeepEqual(view.loads[0], view.loads[1]);
    const activityBefore = findAll(view.tree, (element) => element.type === 'scan-activity')[0]
      .props;
    prior.control.onProgress({ scannedHeight: 99999, targetHeight: 100000 });
    await view.settle();
    const activityAfter = findAll(view.tree, (element) => element.type === 'scan-activity')[0]
      .props;
    assert.equal(activityAfter.scannedHeight, activityBefore.scannedHeight);
    assert.equal(activityAfter.targetHeight, activityBefore.targetHeight);
    pendingScan.resolve({ ok: true, balanceAtomic: '999000000000000' });
    await view.settle();
    assert.equal(view.scans.length, 1);
    assert.equal(view.saves.length, 0);
    assert.equal(view.amount(), '4.200000000000 XMR');
    assert.equal(view.tree.props['aria-busy'], false);
    assert.equal(findAll(view.tree, (element) => element.type === 'scan-activity').length, 0);
    assert.deepEqual(view.alerts(), []);
    assert.equal(view.errors.length, 0);
    assert.ok(view.statuses()[0].includes('block 17563'));
  });
}

test('failed automatic scan preserves last verified balance, height and time and logs the failure', async (context) => {
  const view = harness({
    tip: 17564,
    scan: async () => ({ ok: false, error: 'fixture scan failure' }),
  });
  context.after(() => view.unmount());
  view.render();
  await view.settle();
  assert.equal(view.scans.length, 1);
  assert.equal(view.saves.length, 0);
  assert.equal(view.amount(), '4.200000000000 XMR');
  assert.deepEqual(view.statuses(), [
    `Last verified unlocked balance · block 17563 · ${new Date(checkpoint.scannedAt).toLocaleString()}`,
  ]);
  assert.deepEqual(view.alerts(), ['fixture scan failure']);
  assert.equal(view.tree.props['aria-busy'], false);
  assert.equal(view.errors.length, 1);
  assert.equal(view.errors[0][0], 'Monero balance scan failed');
  assert.equal(view.errors[0][1].message, 'fixture scan failure');
  assert.ok(view.errors[0][1].stack);
});
