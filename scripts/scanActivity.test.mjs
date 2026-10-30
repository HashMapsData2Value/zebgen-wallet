import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

test('scan activity updates elapsed time each second without claiming a completed-block percentage', () => {
  let elapsed = 0;
  let now = 1000;
  let tick;
  let cleanup;
  let cleared = false;
  const api = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/ScanActivity.tsx', import.meta.url), 'utf8'),
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
    Date: { now: () => now },
    window: {
      setInterval(callback, interval) {
        assert.equal(interval, 1000);
        tick = callback;
        return 42;
      },
      clearInterval(timer) {
        assert.equal(timer, 42);
        cleared = true;
      },
    },
    require(name) {
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'lucide-react') return { Square: () => null };
      if (name === 'react')
        return {
          useState: () => [
            elapsed,
            (value) => {
              elapsed = value;
            },
          ],
          useEffect: (effect) => {
            cleanup ??= effect();
          },
        };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const render = (props) => renderToStaticMarkup(api.default(props));
  assert.match(render({ restoreHeight: 0 }), /00:00 elapsed/);
  now += 65000;
  tick();
  const active = render({ restoreHeight: 17500, targetHeight: 17563 });
  assert.match(active, /01:05 elapsed/);
  assert.match(active, /17,500 to 17,562/);
  assert.match(
    active,
    /<progress aria-label="Monero balance scan in progress" max="63"><\/progress>/,
  );
  const progressing = render({
    restoreHeight: 17500,
    targetHeight: 17563,
    scannedHeight: 17520,
    onStop: () => {},
  });
  assert.match(progressing, /20 \/ 63 blocks scanned/);
  assert.match(progressing, /value="20"/);
  assert.match(progressing, /aria-label="Stop scan"/);
  cleanup();
  assert.equal(cleared, true);
});
