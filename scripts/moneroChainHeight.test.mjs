import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';

test('chain height loads before scanning, polls, reports failures and can be refreshed', async () => {
  const states = [];
  const effects = [];
  const timers = [];
  const logged = [];
  let stateIndex = 0;
  let probes = 0;
  let permissions = 0;
  let result = { ok: true, height: 17563 };
  const compiled = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/MoneroChainHeight.tsx', import.meta.url), 'utf8'),
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
    console: { error: (...args) => logged.push(args) },
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
      if (name === 'lucide-react') return { RefreshCw: () => null };
      if (name.endsWith('/hostPermissions'))
        return {
          ensureHostPermissions: async () => {
            permissions++;
          },
        };
      if (name.endsWith('/messages'))
        return {
          probeMoneroDaemonViaBackground: async () => {
            probes++;
            return result;
          },
        };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const config = { daemon: { uri: 'http://127.0.0.1:18081' } };
  const render = () => {
    stateIndex = 0;
    return api.default({ config });
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
  const status = () =>
    react.Children.toArray(
      find(render(), (element) => element.props.role === 'status').props.children,
    ).join('');
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  assert.match(status(), /Loading/);
  const cleanup = effects[0]();
  await settle();
  assert.equal(probes, 1);
  assert.equal(permissions, 0);
  assert.match(status(), /17,563/);
  assert.equal(timers[0].delay, 5000);
  result = { ok: true, height: 17564 };
  timers[0].callback();
  await settle();
  assert.match(status(), /17,564/);
  result = { ok: false, error: 'Node offline' };
  timers[0].callback();
  await settle();
  assert.match(status(), /Unavailable/);
  assert.equal(
    find(render(), (element) => element.props.role === 'alert').props.children,
    'Node offline',
  );
  assert.equal(logged.length, 1);
  find(
    render(),
    (element) => element.props['aria-label'] === 'Refresh chain height',
  ).props.onClick();
  await settle();
  assert.equal(permissions, 1);
  assert.equal(states[2], 1);
  result = { ok: true, height: 0 };
  timers[0].callback();
  await settle();
  assert.equal(status(), 'Current chain height: 0');
  cleanup();
  result = { ok: true, height: 99999 };
  timers[0].callback();
  await settle();
  assert.equal(status(), 'Current chain height: 0');
});
