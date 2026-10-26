import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '../../leakswap-all/leakswap-private/e2e-ui/node_modules/playwright/index.mjs';

test('Algo-only wallet can select and persist Stagenet without creating a Monero wallet', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'zebgen-algo-only-network-'));
  const extension = resolve(process.env.ZEBGEN_TEST_EXTENSION ?? '.output/chrome-mv3');
  const secret = 'disposable-network-test-only';
  const errors = [];
  let context;
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html`);
    return page;
  }
  async function settings(page) {
    await page.locator('.header-actions').getByRole('button', { name: 'Network settings', exact: true }).click();
  }
  async function assertNetworks(page, monero) {
    await page.getByRole('group', { name: 'Algorand network', exact: true })
      .locator('button.net-tab-active').filter({ hasText: /^testnet$/ }).waitFor();
    await page.getByRole('group', { name: 'Monero network', exact: true })
      .locator('button.net-tab-active').filter({ hasText: new RegExp(`^${monero}$`, 'i') }).waitFor();
  }
  try {
    let page = await launch();
    await page.locator('#setup-secret').fill(secret);
    await page.locator('#setup-secret-confirm').fill(secret);
    await page.getByRole('button', { name: 'Set Wallet Lock', exact: true }).click();
    await page.getByRole('button', { name: 'Generate mnemonic', exact: true }).click();
    await page.getByRole('button', { name: 'Encrypt and Save', exact: true }).click();
    await page.locator('p.address[title]').waitFor();
    await settings(page);
    await assertNetworks(page, 'mainnet');
    await page.getByRole('group', { name: 'Monero network', exact: true })
      .getByRole('button', { name: /^stagenet$/i }).click();
    await assertNetworks(page, 'stagenet');
    for (const width of [360, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(profile, `settings-${width}.png`), fullPage: true });
    }
    await context.close();
    page = await launch();
    await page.locator('#unlock-secret').fill(secret);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.locator('p.address[title]').waitFor();
    await settings(page);
    await assertNetworks(page, 'stagenet');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('navigation', { name: 'Wallet navigation' })
      .getByRole('button', { name: 'Monero', exact: true }).click();
    await page.getByRole('button', { name: 'Generate mnemonic', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send XMR', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(`Algo-only network screenshots: ${profile}`);
  } finally {
    await context?.close();
  }
});