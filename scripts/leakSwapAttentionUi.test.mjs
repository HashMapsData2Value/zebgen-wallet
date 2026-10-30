import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import * as status from '../lib/wallet/swapStatus.ts';
import { formatAtomic } from '../lib/wallet/formatAtomic.ts';
import * as icons from 'lucide-react';
import { formatRoundDeadline } from 'leakswap-utils/dist/swapTiming.js';

const compiled = ts.transpileModule(
  readFileSync(new URL('../entrypoints/popup/LeakSwapPanel.tsx', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;

function render(swaps, now = 9000, { loading = false, error = null, shares = [], onRecover } = {}) {
  const values = [loading, error, swaps, shares, now, 0];
  const api = {};
  runInNewContext(compiled, {
    exports: api,
    require: (name) => {
      if (name === 'react')
        return { ...react, useState: () => [values.shift(), () => {}], useEffect: () => {} };
      if (name === 'react/jsx-runtime') return jsx;
      if (name === './SwapRecoveryTools') return { default: () => null };
      if (name === './SwapBackupTools') return { default: () => null };
      if (name === 'leakswap-utils/dist/swapTiming.js') return { formatRoundDeadline };
      if (name.endsWith('/swapStatus')) return status;
      if (name.endsWith('/formatAtomic')) return { formatAtomic };
      if (name.endsWith('.png'))
        return {
          default: `data:image/png;base64,${readFileSync(new URL(`../assets/${name.split('/').at(-1)}`, import.meta.url)).toString('base64')}`,
        };
      if (name === 'lucide-react') return icons;
      return {};
    },
  });
  return renderToStaticMarkup(react.createElement(api.default, { onRecover }));
}

const swap = (appId, role, state, checkedAt = 9000) => ({
  appId,
  role,
  state,
  checkedAt,
  t0: 10000,
  t1: 17200,
  genesisHash: 'test-genesis',
  funding: 'present',
  escrowAtomic: '5000000',
  moneroNetwork: 'stagenet',
  deadlineUnit: 'round',
  chainRound: 9000,
});

test('wallet lists urgent swaps first with one New Swap action and no developer tools', () => {
  const html = render([
    swap('1', 'ali', 'ready'),
    swap('2', 'ali', 'awaiting'),
    swap('3', 'xin', 'unavailable'),
  ]);
  assert.ok(html.indexOf('Swap 2') < html.indexOf('Swap 1'));
  assert.ok(html.indexOf('Swap 1') < html.indexOf('Swap 3'));
  assert.match(html, /Active swaps \(2\)/);
  assert.match(html, /Set Ready/);
  assert.match(html, /https:\/\/app.leakswap.com\/swap\/2/);
  assert.match(html, /New Swap/);
  assert.match(html, /5 ALGO/);
  assert.ok(html.indexOf('<strong>Algorand') < html.indexOf('<strong>Monero'));
  assert.doesNotMatch(
    html,
    /Private view key|Public spend key|Combine Addresses|Recover Combined Wallet|Saved combined addresses|Advanced/,
  );
});

test('stale readiness becomes an unverified urgent check rather than a refund instruction', () => {
  const html = render([swap('1', 'ali', 'awaiting', 8000)]);
  assert.match(html, /Status not verified/);
  assert.doesNotMatch(html, /Leaky refund is allowed/);
  assert.match(html, /Refresh the chain status/);
});

test('unavailable applications do not count as urgent active swaps or confirmed settlement', () => {
  const html = render([swap('1', 'xin', 'unavailable')]);
  assert.match(html, /Active swaps \(0\)/);
  assert.match(html, /<summary>Archived swaps \(1\)<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[ =>])/);
  assert.match(html, /Settlement history is needed/);
  assert.doesNotMatch(html, /Swap completed|Swap refunded/);
  const stale = render([swap('1', 'xin', 'unavailable', 8000)]);
  assert.match(stale, /Archived swaps \(1\)/);
  assert.match(stale, /Status not verified/);
});

test('empty, loading and failure states do not invent saved swaps', () => {
  assert.match(render([]), /No saved swaps yet/);
  assert.match(render([], 9000, { loading: true }), /Loading swaps/);
  assert.match(render([], 9000, { error: 'Storage unavailable' }), /Storage unavailable/);
  assert.doesNotMatch(render([], 9000, { error: 'Storage unavailable' }), /No saved swaps yet/);
});

test('swap rows show live role-specific claim and punish-refund states', () => {
  assert.match(
    render([{ ...swap('1', 'xin', 'ready'), chainRound: 9000 }]),
    /Leaky claim available/,
  );
  assert.match(
    render([{ ...swap('1', 'ali', 'ready'), chainRound: 9000 }]),
    /Waiting for Xin to claim/,
  );
  assert.match(
    render([{ ...swap('1', 'ali', 'ready'), chainRound: 17200 }]),
    /Punish refund available/,
  );
  assert.match(
    render([{ ...swap('1', 'xin', 'awaiting'), funding: 'empty' }]),
    /Waiting for ALGO funding/,
  );
});

test('swap rows use node rounds, not wall-clock time, and fail closed without a round', () => {
  const ready = swap('1', 'xin', 'awaiting');
  assert.match(render([{ ...ready, chainRound: ready.t0 }]), /Waiting for deposit verification/);
  assert.match(render([{ ...ready, chainRound: ready.t0 + 1 }]), /Leaky claim available/);
  assert.match(render([{ ...ready, chainRound: ready.t1 }]), /Claim window closed/);
  const unverified = render([{ ...ready, chainRound: undefined }]);
  assert.match(unverified, /Chain round unavailable/);
  assert.doesNotMatch(unverified, /Leaky claim available|Punish refund available/);
});

test('dedicated share inventory presents bindings and recovery, not receive or send wallets', () => {
  const html = render([], 9000, {
    onRecover: () => {},
    shares: [
      {
        walletId: -41,
        digest: 'ab'.repeat(32),
        algoAddress: 'A'.repeat(58),
        genesisHash: 'B'.repeat(43) + '=',
        network: 'regtest',
        createdAt: '2026-10-17T00:00:00.000Z',
      },
    ],
  });
  assert.match(html, /LeakSwap key shares \(1\)/);
  assert.match(html, /Offer digest/);
  assert.match(html, /Algorand identity/);
  assert.match(html, /Recover combined wallet/);
  assert.doesNotMatch(html, /Receive|Send XMR|Private view key|Private spend key|QRCode/);
});

test('swap list fits mobile and desktop with actual brand assets', async () => {
  const require = createRequire(
    new URL('../../leakswap-all/leakswap-private/e2e-ui/package.json', import.meta.url),
  );
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const css = readFileSync(new URL('../entrypoints/popup/App.css', import.meta.url), 'utf8');
    for (const width of [360, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      const html = render([
        swap('12345678901234567890', 'ali', 'awaiting'),
        swap('2', 'xin', 'ready'),
        swap('3', 'xin', 'unavailable'),
      ]);
      await page.setContent(
        `<style>*{box-sizing:border-box}body{margin:0;background:#14111d;color:#f6f0ff;font-family:Verdana,sans-serif}${css}</style><main class="popup-root ${width > 400 ? 'full-root' : ''}">${html}</main>`,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(
        await page
          .locator('.swap-pair img')
          .evaluateAll((images) =>
            images.every((image) => image.complete && image.naturalWidth > 0),
          ),
        true,
      );
      assert.equal(await page.getByRole('link', { name: 'New Swap' }).count(), 1);
      const archived = page.getByRole('heading', { name: 'Swap 3', exact: true });
      assert.equal(await archived.isVisible(), false);
      assert.equal(
        await page.getByRole('heading', { name: 'Swap 2', exact: true }).isVisible(),
        true,
      );
      await page.getByText('Archived swaps (1)', { exact: true }).click();
      assert.equal(await archived.isVisible(), true);
      assert.equal(
        await page.getByText('Contract no longer available', { exact: true }).isVisible(),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.getByText('Archived swaps (1)', { exact: true }).click();
      assert.equal(await archived.isVisible(), false);
      await page.screenshot({ path: `/tmp/zebgen-swaps-${width}.png`, fullPage: true });
    }
  } finally {
    await browser.close();
  }
});
