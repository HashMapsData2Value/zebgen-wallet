import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = ts.transpileModule(
  readFileSync(new URL('../entrypoints/popup/ConnectDisclosure.tsx', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
const api = {};
runInNewContext(compiled, { exports: api, require: () => jsx });
const render = (accounts) => renderToStaticMarkup(react.createElement(api.default, { accounts }));

test('connect discloses public addresses only and separate later view-key consent', () => {
  const html = render({ algoAddress: 'PUBLIC_ALGO', moneroAddress: 'PUBLIC_MONERO' });
  for (const text of [
    'PUBLIC_ALGO',
    'PUBLIC_MONERO',
    'does not share your mnemonic, private spend keys, or Monero private view key',
    'separately approved swap-sharing request',
    'does not authorize transactions',
    'Choose the wallets',
    'active wallets',
  ]) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /<select/);
});

test('connection review offers both stored wallet selectors and retains full reviewed addresses', () => {
  const html = renderToStaticMarkup(
    react.createElement(api.default, {
      accounts: { algoAddress: 'ALGO_TWO', moneroAddress: 'XMR_TWO', moneroWalletId: 2 },
      choices: {
        algo: [
          { id: 1, address: 'ALGO_ONE' },
          { id: 2, address: 'ALGO_TWO' },
        ],
        monero: [
          { id: 1, address: 'XMR_ONE' },
          { id: 2, address: 'XMR_TWO' },
        ],
      },
      onChange: () => {},
    }),
  );
  assert.match(html, /aria-label="Algorand wallet"/);
  assert.match(html, /aria-label="Monero wallet"/);
  for (const address of ['ALGO_ONE', 'ALGO_TWO', 'XMR_ONE', 'XMR_TWO'])
    assert.ok(html.includes(address));
  assert.match(html, /value="ALGO_TWO" selected/);
  assert.match(html, /value="2" selected/);
});

test('missing wallets offer create or import guidance instead of fabricated addresses', () => {
  const html = render({ algoAddress: null, moneroAddress: null });
  assert.match(html, /No ALGO account. Create or import one in Zebgen before swapping/);
  assert.match(html, /an ALGO sender does not need an existing Monero wallet/);
  assert.match(html, /To deposit XMR from Zebgen, create or import a funded Monero wallet/);
  assert.match(render(null), /Loading active accounts/);
  assert.doesNotMatch(render(null), /PUBLIC_ALGO|PUBLIC_MONERO/);
});

test('wallet selectors and full reviewed addresses fit narrow and desktop approval windows', async () => {
  const { chromium } = await import(
    '../../leakswap-all/leakswap-private/e2e-ui/node_modules/playwright/index.mjs'
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const algoAddress = 'A'.repeat(58);
    const moneroAddress = '4' + 'M'.repeat(94);
    const html = renderToStaticMarkup(
      react.createElement(api.default, {
        accounts: { algoAddress, moneroAddress, moneroWalletId: 2 },
        choices: {
          algo: [
            { id: 1, address: 'B'.repeat(58) },
            { id: 2, address: algoAddress },
          ],
          monero: [
            { id: 1, address: '8'.repeat(95) },
            { id: 2, address: moneroAddress },
          ],
        },
        onChange: () => {},
      }),
    );
    const css = readFileSync(new URL('../entrypoints/popup/App.css', import.meta.url), 'utf8');
    for (const width of [320, 390, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(
        `<html><head><style>${css}</style></head><body><main style="padding:16px;max-width:600px;box-sizing:border-box">${html}</main></body></html>`,
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByLabel('Algorand wallet', { exact: true }).selectOption('B'.repeat(58));
      await page.getByLabel('Monero wallet', { exact: true }).selectOption('1');
      assert.equal(await page.getByLabel('Monero wallet', { exact: true }).inputValue(), '1');
      assert.ok((await page.locator('dd').allTextContents()).includes(moneroAddress));
      await page.screenshot({ path: `/tmp/zebgen-connect-wallets-${width}.png`, fullPage: true });
    }
  } finally {
    await browser.close();
  }
});
