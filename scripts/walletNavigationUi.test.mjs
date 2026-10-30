import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '../../leakswap-all/leakswap-private/e2e-ui/node_modules/playwright/index.mjs';

test('wallet navigation preserves multiple Algorand mnemonics and their addresses', async () => {
  const extension = resolve(process.env.ZEBGEN_TEST_EXTENSION ?? '.output/chrome-mv3');
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(
    manifest.background?.service_worker,
    'Navigation requires a Chromium service worker build',
  );
  const profile = await mkdtemp(join(tmpdir(), 'zebgen-navigation-'));
  const output = join(profile, 'screenshots');
  await mkdir(output);
  const secret = 'disposable-navigation-only';
  const errors = [];
  let context;
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html`);
    return page;
  }
  async function capture(page, name) {
    for (const width of [360, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        name,
      );
      await page.screenshot({ path: join(output, `${name}-${width}.png`), fullPage: true });
    }
  }
  async function addWallet(page) {
    await page.getByRole('button', { name: 'Generate mnemonic', exact: true }).click();
    await page.getByRole('button', { name: 'Encrypt and Save', exact: true }).click();
    await page.locator('p.address[title]').waitFor();
    return page.locator('p.address[title]').getAttribute('title');
  }
  try {
    let page = await launch();
    await page.locator('#setup-secret').fill(secret);
    await page.locator('#setup-secret-confirm').fill(secret);
    await page.getByRole('button', { name: 'Set Wallet Lock', exact: true }).click();
    const first = await addWallet(page);
    await page.getByRole('button', { name: 'Add Address', exact: true }).click();
    await page.locator('#algorand-address-selector').selectOption('1');
    const secondAddress = await page.locator('p.address[title]').getAttribute('title');
    assert.notEqual(secondAddress, first);
    assert.match(
      await page.locator('#algorand-address-selector').innerText(),
      new RegExp(secondAddress.slice(0, 4)),
    );
    await capture(page, 'algorand-addresses');
    await page.getByRole('button', { name: 'Add wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Import mnemonic', exact: true }).click();
    await page.locator('#mnemonic').fill('not a valid mnemonic');
    assert.equal(
      await page.getByRole('button', { name: 'Encrypt and Save', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await page.locator('p.address[title]').getAttribute('title'), secondAddress);
    await page.getByRole('button', { name: 'Add wallet', exact: true }).click();
    const second = await addWallet(page);
    assert.notEqual(first, second);
    const walletOptions = page.locator('#algorand-wallet-selector option');
    assert.equal(await walletOptions.count(), 2);
    const firstId = await walletOptions.first().getAttribute('value');
    await page.locator('#algorand-wallet-selector').selectOption(firstId);
    await page.getByText(`${first.slice(0, 10)}...${first.slice(-8)}`, { exact: true }).waitFor();
    assert.equal(await page.locator('#algorand-address-selector option').count(), 2);
    await page.locator('#algorand-address-selector').selectOption('1');
    await page.getByRole('button', { name: 'Send ALGO', exact: true }).click();
    await capture(page, 'algorand-send');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await capture(page, 'algorand-receive');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page
      .locator('.header-actions')
      .getByRole('button', { name: 'Network settings', exact: true })
      .click();
    await capture(page, 'algorand-settings');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Wallet navigation' })
      .getByRole('button', { name: 'Monero', exact: true })
      .click();
    await capture(page, 'monero-setup');
    await addWallet(page);
    await capture(page, 'monero-wallet');
    await page.getByRole('button', { name: 'Send XMR', exact: true }).click();
    await capture(page, 'monero-send');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await capture(page, 'monero-receive');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page
      .locator('.header-actions')
      .getByRole('button', { name: 'Network settings', exact: true })
      .click();
    await capture(page, 'monero-settings');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Add Address', exact: true }).click();
    await page.getByRole('button', { name: 'Import mnemonic', exact: true }).click();
    await capture(page, 'monero-import');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Wallet navigation' })
      .getByRole('button', { name: 'LeakSwap', exact: true })
      .click();
    await capture(page, 'leakswap');
    const newSwap = page.getByRole('link', { name: 'New Swap' });
    assert.equal(await newSwap.getAttribute('href'), 'https://app.leakswap.com/swap');
    assert.equal(
      await newSwap.evaluate((element) => getComputedStyle(element).borderTopColor),
      'rgb(212, 39, 39)',
    );
    await page.getByRole('button', { name: 'Recover combined wallet', exact: true }).click();
    await capture(page, 'leakswap-recovery');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await context.close();
    page = await launch();
    await page.locator('#unlock-secret').fill(secret);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.locator('#algorand-wallet-selector').waitFor();
    assert.equal(await page.locator('#algorand-wallet-selector option').count(), 2);
    assert.equal(await page.locator('#algorand-address-selector option').count(), 2);
    await page.locator('#algorand-address-selector').selectOption('1');
    await page
      .getByText(`${secondAddress.slice(0, 10)}...${secondAddress.slice(-8)}`, { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    console.log(`Navigation screenshots: ${output}`);
  } finally {
    await context?.close();
  }
});
