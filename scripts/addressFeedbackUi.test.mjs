import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import algosdk from 'algosdk';
import * as validation from '../lib/wallet/addressValidation.ts';
import { formatAtomic } from '../lib/wallet/formatAtomic.ts';
import { base58xmr } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';

function render(component, props, recipient = '', states = {}) {
  const source = readFileSync(
    new URL(`../entrypoints/popup/${component}.tsx`, import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  let stateIndex = 0;
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    require: (name) => {
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'react')
        return {
          ...react,
          useEffect: () => {},
          useState: (initial) => {
            const index = stateIndex++;
            return [
              Object.hasOwn(states, index) ? states[index] : index === 0 ? recipient : initial,
              () => {},
            ];
          },
        };
      if (name === 'lucide-react')
        return new Proxy(
          {},
          { get: () => () => react.createElement('svg', { width: 18, height: 18 }) },
        );
      if (name.endsWith('/formatAtomic')) return { formatAtomic };
      if (name.endsWith('/addressValidation')) return validation;
      if (name.endsWith('/networks')) return { networkLabel: (value) => value };
      if (name.endsWith('/paymentUri')) return { paymentUri: (_chain, address) => address };
      if (name === 'qrcode.react')
        return {
          QRCodeSVG: () => react.createElement('svg', { 'aria-label': 'Receiving address' }),
        };
      if (name === './CopyValue')
        return { default: () => react.createElement('button', {}, 'Copy address') };
      if (
        [
          './LeakSwapPanel',
          './NetworkSettings',
          './RevealSeedPhrase',
          './AlgorandAddressCard',
          './ScanActivity',
          './MoneroChainHeight',
        ].includes(name)
      )
        return {
          default: () => react.createElement('div', { 'data-component': name.slice(2) }),
        };
      if (name.endsWith('/algoWallet')) return { getAlgoDerivationPath: () => 'test-path' };
      return {};
    },
  });
  return renderToStaticMarkup(react.createElement(api.default, props));
}

const payload = new Uint8Array([24, ...new Uint8Array(64).fill(7)]);
const xmr = base58xmr.encode(new Uint8Array([...payload, ...keccak_256(payload).slice(0, 4)]));
const algo = algosdk.generateAccount().addr.toString();
const props = (chain) =>
  chain === 'algorand'
    ? { chain, sender: algo, network: 'testnet' }
    : { chain, sender: xmr, config: { network: 'stagenet' } };

test('Monero send shows live scan activity during balance scans and transaction preparation', () => {
  for (const states of [{ 12: true }, { 6: true }]) {
    const html = render('TransactionBuilder', props('monero'), xmr, states);
    assert.match(html, /data-component="ScanActivity"/);
    assert.doesNotMatch(html, /Scanning unlocked balance\.\.\./);
  }
});

test('send fields stay neutral when empty, red for invalid and green for valid addresses', () => {
  for (const [chain, valid] of [
    ['algorand', algo],
    ['monero', xmr],
  ]) {
    const empty = render('TransactionBuilder', props(chain));
    assert.doesNotMatch(empty, /data-address-status=/);
    assert.match(empty, /type="submit" disabled=""/);
    const invalid = render('TransactionBuilder', props(chain), 'bad-address');
    assert.match(invalid, /data-address-status="invalid" aria-invalid="true"/);
    assert.match(invalid, /role="alert"/);
    assert.match(invalid, /type="submit" disabled=""/);
    const validHtml = render('TransactionBuilder', props(chain), valid);
    assert.match(validHtml, /data-address-status="valid" aria-invalid="false"/);
    assert.doesNotMatch(validHtml, /type="submit" disabled/);
  }
});

test('receive hides QR and copy for invalid or wrong-network addresses', () => {
  for (const [chain, address, network] of [
    ['algorand', algo, 'testnet'],
    ['monero', xmr, 'stagenet'],
  ]) {
    const html = render('Receive', { chain, address, network });
    assert.match(html, /data-address-status="valid"/);
    assert.match(html, /<svg/);
    assert.match(html, /Copy address/);
    const invalid = render('Receive', { chain, address: 'bad', network });
    assert.match(invalid, /data-address-status="invalid"/);
    assert.doesNotMatch(invalid, /<svg|Copy address/);
  }
  assert.match(
    render('Receive', { chain: 'monero', address: xmr, network: 'mainnet' }),
    /does not match/,
  );
});

test('amount feedback rejects excess, reserves fees and ignores unrelated balances', () => {
  for (const [chain, address, atomic, within, excess] of [
    ['algorand', algo, '2000000', '1.999', '2'],
    ['monero', xmr, '2000000000000', '1.9', '2.1'],
  ]) {
    const settings = props(chain);
    const key = JSON.stringify(
      chain === 'algorand'
        ? [chain, address, settings.network, settings.endpoint]
        : [chain, address, settings.walletId, settings.config, '0'],
    );
    const balance = { key, atomic };
    const invalid = render('TransactionBuilder', settings, address, { 1: excess, 11: balance });
    if (chain === 'monero') {
      assert.match(invalid, /Last verified unlocked balance/);
      assert.match(invalid, /Transaction review rechecks spendable funds and fees/);
      assert.doesNotMatch(invalid, /Insufficient funds|type="submit" disabled/);
      assert.match(invalid, /Update balance/);
      assert.doesNotMatch(invalid, /class="refresh-btn"[^>]*title="Scan unlocked balance"/);
      continue;
    }
    assert.match(invalid, /Insufficient funds/);
    assert.match(invalid, /type="submit" disabled/);
    assert.match(invalid, /tx-amount" data-address-status="invalid" aria-invalid="true"/);
    assert.doesNotMatch(
      render('TransactionBuilder', settings, address, { 1: within, 11: balance }),
      /Insufficient funds|type="submit" disabled/,
    );
    assert.doesNotMatch(
      render('TransactionBuilder', settings, address, { 1: excess }),
      /Insufficient funds/,
    );
    assert.doesNotMatch(
      render('TransactionBuilder', settings, address, {
        1: excess,
        11: { ...balance, key: 'old-network' },
      }),
      /Insufficient funds/,
    );
    assert.match(
      render('TransactionBuilder', settings, address, { 1: '2', 11: balance }),
      /Insufficient funds/,
    );
  }
});

test('unlocked wallet opens directly with one chain selector and no duplicate list', () => {
  const html = render('App', {}, 'algorand', { 1: false, 2: true, 4: true });
  assert.match(html, /aria-label="Wallet navigation"/);
  assert.match(html, /aria-pressed="true"><img[^>]+\/>Algorand/);
  assert.match(html, /Add Algorand address/);
  assert.doesNotMatch(html, /Select Wallet Type|aria-label="Wallet type"|aria-label="Back"/);
  const monero = render('App', {}, 'monero', { 1: false, 2: true, 4: true });
  assert.match(monero, /aria-pressed="true"><img[^>]+\/>Monero/);
  assert.doesNotMatch(html, /section-tabs|>Overview<|>Settings</);
  assert.match(html, /aria-label="Network settings"/);
  const swap = render('App', {}, 'leakswap', { 1: false, 2: true, 4: true });
  assert.match(swap, /aria-pressed="true"><svg[^>]*><\/svg>LeakSwap/);
  assert.equal((swap.match(/data-component="LeakSwapPanel"/g) ?? []).length, 1);
  assert.doesNotMatch(swap, /Add Algorand address|AlgorandAddressCard|NetworkSettings/);
  const account = render('App', {}, 'algorand', { 1: false, 2: true, 3: true, 4: true });
  assert.match(account, /algorand-address-selector/);
  assert.match(account, />Add Address</);
  assert.doesNotMatch(account, /Previous address|Next address/);
});

test('Algorand and Monero use identical mnemonic setup actions', () => {
  const common = { 1: false, 2: true, 4: true };
  const algoSetup = render('App', {}, 'algorand', common);
  const moneroSetup = render('App', {}, 'monero', { ...common, 25: 'add' });
  for (const html of [algoSetup, moneroSetup]) {
    assert.match(html, /class="choice-button"[^>]*>Generate mnemonic</);
    assert.match(html, /class="choice-button"[^>]*>Import mnemonic</);
    assert.doesNotMatch(html, /Generate new mnemonic|Input existing seedphrase/);
  }
  for (const [chain, states] of [
    ['algorand', { ...common, 8: 'existing' }],
    ['monero', { ...common, 24: 'import', 25: 'add' }],
  ]) {
    assert.match(render('App', {}, chain, states), />Encrypt and Save</);
  }
});

test('zero payments are allowed for ALGO but not XMR', () => {
  assert.doesNotMatch(
    render('TransactionBuilder', props('algorand'), algo, { 1: '0' }),
    /greater than zero|type="submit" disabled/,
  );
  assert.match(render('TransactionBuilder', props('monero'), xmr, { 1: '0' }), /greater than zero/);
});

test('review requires PIN and submitted receipt replaces the send form', () => {
  const review = { id: 'prepared', hash: 'hash', amountAtomic: '1000000', feeAtomic: '1000' };
  const html = render('TransactionBuilder', props('algorand'), algo, {
    1: '1',
    5: true,
    10: review,
  });
  assert.match(html, /transaction-approval-secret/);
  assert.match(html, /type="password"/);
  assert.match(html, /type="submit" disabled="">Confirm and Send/);
  const receipt = render('TransactionBuilder', props('algorand'), algo, {
    8: 'Submitted hash',
    9: 'hash',
    15: { state: 'confirmed', block: '42' },
  });
  assert.match(receipt, /Transaction confirmed/);
  assert.match(receipt, /Confirmed round/);
  assert.match(receipt, />42</);
  assert.doesNotMatch(receipt, /tx-recipient|transaction-approval-secret/);
  assert.match(receipt, /New transaction/);
});

test('Chromium renders green and red focused outlines with no mobile overflow', async () => {
  const require = createRequire(
    new URL('../../leakswap-all/leakswap-private/e2e-ui/package.json', import.meta.url),
  );
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const css = readFileSync(new URL('../entrypoints/popup/App.css', import.meta.url), 'utf8');
    for (const [recipient, expected] of [
      [algo, 'rgb(34, 197, 94)'],
      ['invalid', 'rgb(239, 68, 68)'],
    ]) {
      await page.setContent(
        `<style>${css}</style><main style="max-width:100%;padding:16px">${render('TransactionBuilder', props('algorand'), recipient)}</main>`,
      );
      const field = page.locator('#algorand-tx-recipient');
      await field.focus();
      assert.equal(
        await field.evaluate((element) => getComputedStyle(element).outlineColor),
        expected,
      );
      assert.equal(
        await field.evaluate((element) => getComputedStyle(element).outlineStyle),
        'solid',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    }
    const settings = props('algorand');
    const key = JSON.stringify(['algorand', algo, settings.network, settings.endpoint]);
    const markup = render('TransactionBuilder', settings, algo, {
      1: '3',
      11: { key, atomic: '2000000' },
    });
    for (const width of [390, 1100]) {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(
        `<style>${css}</style><main style="max-width:100%;padding:16px">${markup}</main>`,
      );
      const amount = page.locator('#algorand-tx-amount');
      await amount.focus();
      assert.equal(
        await amount.evaluate((element) => getComputedStyle(element).outlineColor),
        'rgb(239, 68, 68)',
      );
      assert.equal(
        await page.getByRole('button', { name: 'Review Transaction' }).isDisabled(),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    }
    await page.screenshot({ path: '/tmp/zebgen-address-feedback-mobile.png', fullPage: true });
    for (const width of [360, 390, 1100]) {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(
        `<style>body{margin:0}*{box-sizing:border-box}${css}</style>${render('App', {}, 'algorand', { 1: false, 2: true, 4: true })}`,
      );
      assert.equal(
        await page
          .getByRole('navigation', { name: 'Wallet navigation' })
          .getByRole('button')
          .count(),
        3,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(
        await page.getByRole('button', { name: 'Network settings', exact: true }).isVisible(),
        true,
      );
      await page.screenshot({ path: `/tmp/zebgen-navigation-${width}.png`, fullPage: true });
    }
  } finally {
    await browser.close();
  }
});
