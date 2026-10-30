import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const api = {};
runInNewContext(
  ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/MoneroConfirmation.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    },
  ).outputText,
  { exports: api, require: () => jsx },
);

test('receipt distinguishes pool wait, regtest mining, normal maturity and unknown outcomes', () => {
  const render = (network, status) =>
    renderToStaticMarkup(react.createElement(api.default, { network, status }));
  assert.match(render('regtest', { state: 'pool' }), /Waiting for a miner/);
  assert.match(render('regtest', { state: 'pool' }), /Waiting alone will not confirm/);
  assert.doesNotMatch(render('regtest', { state: 'pool' }), /20 minutes/);
  assert.match(render('mainnet', { state: 'pool' }), /20 minutes on average/);
  assert.match(render('mainnet', { state: 'confirmed', confirmations: 3 }), /3 confirmations/);
  assert.match(render('mainnet', { state: 'unknown' }), /unknown status is not a failed payment/);
});
