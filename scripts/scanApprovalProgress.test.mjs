import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

function render(progress, purpose = 'acceptance') {
  const api = {};
  const code = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/ScanApprovalProgress.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(code, {
    exports: api,
    require(name) {
      if (name === 'react') return { useState: () => [12, () => {}], useEffect: () => {} };
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'lucide-react') return { LoaderCircle: () => null };
      if (name.endsWith('.css')) return {};
      throw new Error(name);
    },
  });
  return renderToStaticMarkup(api.default({ progress, purpose }));
}

test('acceptance shows real range, checked blocks, remaining blocks and measured estimate', () => {
  const html = render({ startHeight: 1000, scannedHeight: 1100, targetHeight: 1400 });
  assert.match(html, /max="400" value="100"/);
  assert.match(html, /100 of 400 blocks checked; 300 remaining/);
  assert.match(html, /Estimated scan time remaining: 36s/);
  assert.match(html, /Saved coverage is reused/);
  assert.doesNotMatch(html, /does not resume/);
});

test('unknown range stays indeterminate and completed scan names final work', () => {
  assert.match(render(null), /Waiting for Monero scan range/);
  assert.doesNotMatch(render(null), /value=/);
  const complete = render({ startHeight: 100, scannedHeight: 200, targetHeight: 200 });
  assert.match(complete, /Block scan complete.*preliminary fee allowance check/);
  assert.doesNotMatch(complete, /preparing|trial deposit|fee estimate/);
  assert.doesNotMatch(complete, /Estimated scan time remaining/);
  assert.match(
    render({ startHeight: 100, scannedHeight: 200, targetHeight: 200 }, 'funding'),
    /does not resume a previous funding scan/,
  );
});

test('missing funding wallet is rejected before unlock and network-dependent acceptance', async () => {
  const api = {};
  const source = readFileSync(
    new URL('../entrypoints/popup/ExternalRequestApp.tsx', import.meta.url),
    'utf8',
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const values = [
    { type: 'acceptSwapInvite', origin: 'https://app.leakswap.com', params: { link: 'invite' } },
    null,
    null,
    null,
    true,
    'unlock',
    'pin',
    null,
    false,
    'unlocking',
    null,
    null,
    null,
  ];
  let stateIndex = 0;
  let message;
  let unlocked = false;
  runInNewContext(code, {
    exports: api,
    AbortController,
    require(name) {
      if (name === 'react')
        return {
          useState() {
            const index = stateIndex++;
            return [
              values[index],
              (value) => {
                if (index === 7) message = value;
              },
            ];
          },
          useEffect: () => {},
          useRef: () => ({ current: null }),
        };
      if (name === 'react/jsx-runtime') return jsx;
      if (name.endsWith('/connectionApproval'))
        return {
          connectedAccounts: async () => ({
            algoAddress: 'algo',
            moneroAddress: null,
            moneroWalletId: null,
          }),
          assertConnectionAccounts: async () => {},
        };
      if (name.endsWith('/algoWallet'))
        return {
          unlockWallet: async () => {
            unlocked = true;
            throw new Error('Must not unlock');
          },
        };
      return {};
    },
  });
  const tree = api.default({ requestId: 'request' });
  function findForm(element) {
    if (!element || typeof element !== 'object') return null;
    if (element.type === 'form') return element;
    const children = element.props?.children;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
      const found = findForm(child);
      if (found) return found;
    }
    return null;
  }
  await findForm(tree).props.onSubmit({ preventDefault() {} });
  assert.match(message, /No Monero funding wallet is connected/);
  assert.equal(unlocked, false);
});
