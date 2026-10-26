import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = ts.transpileModule(
  readFileSync(new URL('../entrypoints/popup/SwapRecoveryTools.tsx', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;

function fixture() {
  const states = [];
  let cursor = 0;
  const calls = [];
  const record = { appId: '42', algoAddress: 'PUBLIC_ALGO', context: { network: 'regtest' } };
  const state = { fail: false };
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    Error,
    console: { error: () => {} },
    require: (name) => {
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'react')
        return {
          useEffect: () => {},
          useState: (initial) => {
            const index = cursor++;
            if (!(index in states)) states[index] = initial;
            return [
              states[index],
              (value) => {
                states[index] = value;
              },
            ];
          },
        };
      if (name === 'lucide-react') return { Download: 'span', RefreshCw: 'span' };
      if (name === 'wxt/browser') return { browser: { storage: { local: {} } } };
      if (name.endsWith('/swapRecords'))
        return {
          listSwapRecords: async () => [record],
          listSignedTransactions: async () => [],
          swapRecordKey: () => 'record42',
          loadSettlementEvidence: async () => ({
            txId: 'A'.repeat(52),
            confirmedRound: '10',
            transaction: 'PRIVATE_RAW_EVIDENCE',
          }),
        };
      if (name.endsWith('/swapDiagnostics'))
        return { swapDiagnostics: () => ({ appId: '42', combinedAddress: 'PUBLIC_COMBINED' }) };
      if (name.endsWith('/recoverLeakSwap'))
        return {
          recoverLeakSwap: async (params, secret) => {
            calls.push({ params, secret });
            if (state.fail)
              throw new Error('History unavailable; provide a settlement transaction ID');
            return {
              combinedAddress: 'PUBLIC_COMBINED',
              settlementTxId: params.settlementTxId,
              walletId: 9,
            };
          },
        };
      throw new Error(name);
    },
  });
  const render = () => {
    cursor = 0;
    return api.default({ lockSecret: 'synthetic-secret' });
  };
  const elements = (tree) =>
    !tree || typeof tree !== 'object'
      ? []
      : [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)];
  const text = (tree) =>
    typeof tree === 'string'
      ? tree
      : !tree || typeof tree !== 'object'
        ? ''
        : [tree.props?.children].flat(Infinity).map(text).join('');
  const find = (predicate) => elements(render()).find(predicate);
  return { calls, state, find, text };
}

test('advanced wallet recovery loads retained identifiers, accepts manual tx reference and saves through verified recovery', async () => {
  const current = fixture();
  const button = (name) =>
    current.find((element) => element.type === 'button' && current.text(element).includes(name));
  await button('Load recovery records').props.onClick();
  current
    .find((element) => element.type === 'select')
    .props.onChange({ target: { value: 'record42' } });
  const report = current.find((element) => element.type === 'pre').props.children;
  assert.ok(report.includes('confirmedRound'));
  assert.ok(!report.includes('PRIVATE_RAW_EVIDENCE'));
  current
    .find((element) => element.type === 'input')
    .props.onChange({ target: { value: 'invalid' } });
  await button('Verify history').props.onClick();
  assert.equal(current.calls.length, 0);
  assert.match(
    current.text(current.find((element) => element.props?.role === 'alert')),
    /52-character/,
  );
  current
    .find((element) => element.type === 'input')
    .props.onChange({ target: { value: 'B'.repeat(52) } });
  await button('Verify history').props.onClick();
  assert.equal(current.calls[0].params.appId, '42');
  assert.equal(current.calls[0].params.settlementTxId, 'B'.repeat(52));
  assert.match(
    current.text(current.find((element) => element.props?.role === 'status')),
    /Recovered wallet saved/,
  );
});

test('history failure remains visible and retains the selected saved recovery record', async () => {
  const current = fixture();
  await current
    .find((element) => element.type === 'button' && current.text(element).includes('Load recovery'))
    .props.onClick();
  current
    .find((element) => element.type === 'select')
    .props.onChange({ target: { value: 'record42' } });
  current.state.fail = true;
  await current
    .find(
      (element) => element.type === 'button' && current.text(element).includes('Verify history'),
    )
    .props.onClick();
  assert.match(
    current.text(current.find((element) => element.props?.role === 'alert')),
    /History unavailable/,
  );
  assert.equal(current.find((element) => element.type === 'select').props.value, 'record42');
});

test('advanced recovery tools stay collapsed initially and fit narrow windows with expanded diagnostics', async () => {
  const { chromium } = await import(
    '../../leakswap-all/leakswap-private/e2e-ui/node_modules/playwright/index.mjs'
  );
  const browser = await chromium.launch();
  try {
    const current = fixture();
    await current
      .find(
        (element) => element.type === 'button' && current.text(element).includes('Load recovery'),
      )
      .props.onClick();
    current
      .find((element) => element.type === 'select')
      .props.onChange({ target: { value: 'record42' } });
    const html = renderToStaticMarkup(current.find((element) => element.type === 'details'));
    const css = readFileSync(new URL('../entrypoints/popup/App.css', import.meta.url), 'utf8');
    const page = await browser.newPage();
    for (const width of [320, 390, 1100]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.setContent(
        `<html><head><style>${css}</style></head><body><main style="padding:16px;max-width:700px;box-sizing:border-box">${html}</main></body></html>`,
      );
      assert.equal(
        await page.getByRole('button', { name: 'Export support report' }).isVisible(),
        false,
      );
      await page.locator('summary').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `/tmp/zebgen-swap-recovery-${width}.png`, fullPage: true });
    }
  } finally {
    await browser.close();
  }
});
