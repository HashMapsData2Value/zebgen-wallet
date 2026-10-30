import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from '../../leakswap-all/leakswap-private/e2e-ui/node_modules/playwright/index.mjs';
import * as icons from 'lucide-react';

const hash = 'ab'.repeat(32);
const address = `4${'8'.repeat(94)}`;
const config = { network: 'regtest', daemon: { uri: 'http://localhost:18081' } };
const output = '/tmp/zebgen-outgoing-ux';

function component(name, states = [], dependencies = {}, globals = {}) {
  let index = 0;
  const api = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL(`../entrypoints/popup/${name}.tsx`, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(compiled, {
    ...globals,
    exports: api,
    console,
    require: (dependency) => {
      if (dependency in dependencies) return dependencies[dependency];
      if (dependency === 'react/jsx-runtime') return jsx;
      if (dependency === 'react')
        return {
          ...react,
          useState: (initial) => [
            index < states.length ? states[index++] : (index++, initial),
            () => {},
          ],
          useEffect() {},
          useRef: (value) => ({ current: value }),
        };
      if (dependency === 'lucide-react') return icons;
      if (dependency.endsWith('/formatAtomic'))
        return { formatAtomic: (value) => (Number(value) / 1e12).toString() };
      if (dependency.endsWith('/moneroActivity')) return { activityScope: () => ({}) };
      if (dependency.endsWith('/moneroBalanceCache')) return { balanceCheckpointKey: () => '' };
      if (dependency.endsWith('/addressValidation')) return { addressValidationError: () => null };
      if (dependency.endsWith('/networks')) return { networkLabel: (value) => value };
      if (dependency.startsWith('./')) return { default: () => null };
      return {};
    },
  });
  return api.default;
}

const Confirmation = component('MoneroConfirmation');
const styles = ['style.css', 'App.css']
  .map((name) => readFileSync(new URL(`../entrypoints/popup/${name}`, import.meta.url), 'utf8'))
  .join('\n');

test('funding scan timer updates and clears its interval on unmount', () => {
  let effect;
  let tick;
  let elapsed = 0;
  let cleared;
  let now = 1000;
  const Progress = component(
    'ScanApprovalProgress',
    [],
    {
      react: {
        useState: () => [
          0,
          (value) => {
            elapsed = value;
          },
        ],
        useEffect: (callback) => {
          effect = callback;
        },
      },
    },
    {
      Date: { now: () => now },
      window: {
        setInterval: (callback, interval) => {
          tick = callback;
          assert.equal(interval, 1000);
          return 42;
        },
        clearInterval: (timer) => {
          cleared = timer;
        },
      },
    },
  );
  Progress({ progress: null });
  const cleanup = effect();
  now = 4000;
  tick();
  assert.equal(elapsed, 3);
  cleanup();
  assert.equal(cleared, 42);
});

test('funding scan shows activity before and during block progress at narrow and desktop widths', async () => {
  const browser = await chromium.launch();
  const css = readFileSync(
    new URL('../entrypoints/popup/LeakSwapDeposit.css', import.meta.url),
    'utf8',
  );
  try {
    const page = await browser.newPage();
    for (const width of [320, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      for (const progress of [
        null,
        { scannedHeight: 1200, targetHeight: 2400 },
        { startHeight: 1000, scannedHeight: 1200, targetHeight: 2400 },
        { startHeight: 0, scannedHeight: 1200, targetHeight: 2400 },
        { startHeight: 2400, scannedHeight: 2400, targetHeight: 2400 },
      ]) {
        const Progress = component('ScanApprovalProgress', [37]);
        await page.setContent(
          `<style>${styles}\n${css}</style>${renderToStaticMarkup(react.createElement(Progress, { progress }))}`,
        );
        const status = page.getByRole('status');
        assert.equal(
          await status.getByRole('heading', { name: 'Checking Monero funding' }).isVisible(),
          true,
        );
        assert.equal(await status.locator('svg').isVisible(), true);
        assert.equal(await status.getByText('Elapsed: 37s').isVisible(), true);
        if (progress?.startHeight !== undefined) {
          const total = progress.targetHeight - progress.startHeight;
          const checked = progress.scannedHeight - progress.startHeight;
          const bar = status.getByRole('progressbar', { name: 'Monero blocks checked' });
          assert.equal(await bar.getAttribute('max'), String(total || 1));
          assert.equal(await bar.getAttribute('value'), String(total === 0 ? 1 : checked));
          assert.equal(
            await status
              .getByText(
                `${checked.toLocaleString()} of ${total.toLocaleString()} blocks checked; ${(total - checked).toLocaleString()} remaining.`,
                { exact: true },
              )
              .isVisible(),
            true,
          );
          assert.equal(
            await status
              .getByText(
                progress.startHeight === 0
                  ? /Checking from block 0/
                  : /Starting at this swap's restore height/,
              )
              .isVisible(),
            true,
          );
          assert.equal(
            await status.getByText(/does not resume a previous funding scan/).isVisible(),
            true,
          );
        }
        assert.equal(
          await status
            .getByText(progress ? /Scanned block/ : /connecting to the Monero node/)
            .isVisible(),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(
          await status
            .locator('svg')
            .evaluate((element) => getComputedStyle(element).animationName),
          'deposit-spin',
        );
      }
    }
  } finally {
    await browser.close();
  }
});

test('deposit preparation and sending show prominent progress without narrow-window overflow', async () => {
  const browser = await chromium.launch();
  const css = readFileSync(
    new URL('../entrypoints/popup/LeakSwapDeposit.css', import.meta.url),
    'utf8',
  );
  try {
    const page = await browser.newPage();
    for (const width of [320, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      for (const sending of [false, true]) {
        const review = sending
          ? { id: 'review', amountAtomic: '10000000000', feeAtomic: '10000000' }
          : null;
        const Deposit = component('LeakSwapDeposit', [review, '', true, null, false, null, 37]);
        await page.setContent(
          `<style>${styles}\n${css}</style>${renderToStaticMarkup(
            react.createElement(Deposit, {
              params: { appId: '774582554' },
              target: { config, sender: address, recipient: address, amountAtomic: '10000000000' },
            }),
          )}`,
        );
        const status = page.getByRole('status');
        assert.equal(
          await status
            .getByRole('heading', {
              name: sending ? 'Sending Monero deposit' : 'Preparing Monero deposit',
            })
            .isVisible(),
          true,
        );
        assert.equal(await status.getByText('Elapsed: 37s').isVisible(), true);
        assert.equal(await status.locator('svg').isVisible(), true);
        if (!sending) assert.equal(await status.getByText(/minute or longer/).isVisible(), true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(
          await status
            .locator('svg')
            .evaluate((element) => getComputedStyle(element).animationName),
          'none',
        );
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      }
    }
  } finally {
    await browser.close();
  }
});

test('outgoing screens prioritize status and amount, preserve disclosures and fit narrow viewports', async () => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const Form = component('TransactionBuilder');
    await page.setContent(
      `<style>${styles}</style>${renderToStaticMarkup(react.createElement(Form, { chain: 'monero', sender: address, config, walletId: 1, lockSecret: 'synthetic' }))}`,
    );
    assert.equal(
      await page.getByLabel('Wallet restore height', { exact: true }).isVisible(),
      false,
    );
    assert.equal(await page.getByText(/substantial data/).isVisible(), true);
    await page.getByText('Scan settings', { exact: true }).click();
    assert.equal(await page.getByLabel('Wallet restore height', { exact: true }).isVisible(), true);
    const scenarios = ['pool', 'confirmed', 'unknown'];
    for (const state of scenarios) {
      const status = { state, confirmations: state === 'confirmed' ? 12 : 0, block: '123' };
      const Activity = component(
        'MoneroActivity',
        [
          [
            {
              hash,
              amountAtomic: '20000000000',
              feeAtomic: '1000000000',
              createdAt: 123,
              state: 'submitted',
            },
          ],
          { [hash]: status },
          { [hash]: 'Status unavailable; last observation may be stale.' },
          null,
          0,
        ],
        {
          './MoneroConfirmation': { default: Confirmation },
        },
      );
      const Builder = component(
        'TransactionBuilder',
        [
          address,
          '0.02',
          '',
          '100',
          false,
          false,
          false,
          null,
          `Relayed ${hash} · amount 0.02 XMR · fee 0.001 XMR`,
          hash,
          null,
          null,
          false,
          null,
          '',
          status,
          null,
          0,
          '20000000000',
        ],
        {
          './MoneroConfirmation': { default: Confirmation },
        },
      );
      for (const [name, Component, props] of [
        ['activity', Activity, { address, config, lockSecret: 'synthetic' }],
        [
          'receipt',
          Builder,
          { chain: 'monero', sender: address, config, walletId: 1, lockSecret: 'synthetic' },
        ],
      ]) {
        const html = renderToStaticMarkup(react.createElement(Component, props));
        await page.setContent(
          `<style>${styles} body{margin:0;min-width:0}.app{box-sizing:border-box;width:100%;max-width:600px;margin:auto;padding:16px}</style><main class="app">${html}</main>`,
        );
        await page.getByText('Transaction details', { exact: true }).waitFor();
        assert.equal(await page.getByText(hash, { exact: false }).first().isVisible(), false);
        assert.equal(await page.getByText('0.02 XMR', { exact: true }).isVisible(), true);
        if (state !== 'confirmed')
          assert.equal(await page.getByText(/Do not send it again/).isVisible(), true);
        if (name === 'activity')
          assert.equal(await page.getByText(/Status unavailable/).isVisible(), true);
        for (const width of [360, 1100]) {
          await page.setViewportSize({ width, height: 800 });
          await page.screenshot({
            path: `${output}/${name}-${state}-${width}.png`,
            fullPage: true,
          });
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${name} ${state} overflows at ${width}`,
          );
        }
        await page.getByText('Transaction details', { exact: true }).click();
        assert.equal(await page.getByText(hash, { exact: false }).first().isVisible(), true);
        await page.getByText('About confirmations', { exact: true }).click();
        assert.equal(
          await page.getByText(/remains in Monero's Outgoing Activity/).isVisible(),
          true,
        );
      }
    }
  } finally {
    await browser.close();
  }
});
