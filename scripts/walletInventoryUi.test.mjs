import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('returning to the dashboard refreshes externally saved wallets and cleans up listeners', async () => {
  const source = ts.createSourceFile(
    'App.tsx',
    readFileSync(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let effect;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.arguments[0]?.getText(source).includes('Unable to refresh Monero wallet inventory')
    )
      effect = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(effect);
  const listeners = new Map();
  let tick;
  let cleared = false;
  const events = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
    visibilityState: 'visible',
    setInterval: (callback, delay) => {
      assert.equal(delay, 5000);
      tick = callback;
      return 1;
    },
    clearInterval: (timer) => {
      assert.equal(timer, 1);
      cleared = true;
    },
  };
  let wallets = [{ id: 1 }],
    displayed;
  const api = {};
  runInNewContext(
    ts.transpileModule(`exports.subscribe = ${effect}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: api,
      window: events,
      document: events,
      console,
      getMoneroWalletState: async () => ({ wallets }),
      setMoneroWallets: (value) => {
        displayed = value;
      },
    },
  );
  const cleanup = api.subscribe();
  wallets = [{ id: 1 }, { id: 2, address: 'recovered' }];
  listeners.get('focus')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(displayed.length, 2);
  wallets = [{ id: 1 }, { id: 2 }, { id: 3 }];
  listeners.get('visibilitychange')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(displayed.length, 3);
  wallets = [...wallets, { id: 4, address: 'newly-recovered' }];
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(displayed.length, 4);
  events.visibilityState = 'hidden';
  wallets = [...wallets, { id: 5 }];
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(displayed.length, 4);
  cleanup();
  assert.equal(cleared, true);
  assert.equal(listeners.size, 0);
});
