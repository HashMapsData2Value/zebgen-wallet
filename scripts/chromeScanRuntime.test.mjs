import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

function probe() {
  globalThis.runtimeProbe = { ready: null, statusRequests: 0, stops: [] };
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'test:scanProbe') sendResponse(globalThis.runtimeProbe);
    if (message.type === 'monero:scanHostReady') {
      globalThis.runtimeProbe.ready = { tabId: sender.tab?.id, url: sender.url };
    }
    if (message.type === 'monero:scanDisplayStatus') {
      globalThis.runtimeProbe.statusRequests += 1;
      sendResponse({ states: [] });
    }
    if (message.type === 'monero:scanStop') {
      globalThis.runtimeProbe.stops.push(message.key);
    }
    return false;
  });
}

test(
  'real Chrome service worker can handshake with the built scan page, display progress, and receive Stop',
  { timeout: 90000 },
  async (contextTest) => {
    const source = resolve(process.env.ZEBGEN_TEST_CHROME_EXTENSION ?? '.output/chrome-mv3');
    const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background?.service_worker, 'background.js');
    const directory = await mkdtemp(join(tmpdir(), 'zebgen-chrome-scan-'));
    const extension = join(directory, 'extension');
    const errors = [];
    let context;
    try {
      await cp(source, extension, { recursive: true });
      delete manifest.content_scripts;
      await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(extension, 'background.js'), `(${probe.toString()})();`);
      context = await chromium.launchPersistentContext(join(directory, 'profile'), {
        channel: 'chromium',
        headless: true,
        timeout: 20000,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      context.setDefaultTimeout(15000);
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 15000 }));
      assert.match(worker.url(), /^chrome-extension:\/\/[^/]+\/background\.js$/);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
      const scanUrl = `chrome-extension://${new URL(worker.url()).host}/scan.html`;
      await page.goto(scanUrl);
      await page.waitForFunction(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'test:scanProbe' });
        return response?.ready && response.statusRequests > 0;
      });
      const readiness = await worker.evaluate(() => globalThis.runtimeProbe);
      assert.equal(readiness.ready?.url, scanUrl);
      assert.equal(typeof readiness.ready?.tabId, 'number');
      assert.ok(readiness.statusRequests >= 1);
      const acknowledgement = await worker.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'monero:hostRequest', action: 'start' }),
      );
      assert.equal(acknowledgement?.ok, true, 'Chrome service worker handshake was rejected');
      const state = {
        key: 'runtime-test',
        address: 'test-public-address',
        progress: { scannedHeight: 100, targetHeight: 200 },
      };
      await worker.evaluate(
        (scanState) =>
          chrome.runtime.sendMessage({ type: 'monero:scanDisplay', states: [scanState] }),
        state,
      );
      await page.getByText('Block 100 / 200', { exact: true }).waitFor();
      assert.equal(await page.locator('#status').textContent(), '1 active scan');
      await page.getByRole('button', { name: 'Stop scan', exact: true }).click();
      await page.waitForFunction(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'test:scanProbe' });
        return response.stops.length === 1;
      });
      assert.deepEqual(await worker.evaluate(() => globalThis.runtimeProbe.stops), [state.key]);
      await page.getByRole('button', { name: 'Stop all scans', exact: true }).click();
      await page.waitForFunction(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'test:scanProbe' });
        return response.stops.length === 2;
      });
      assert.deepEqual(await worker.evaluate(() => globalThis.runtimeProbe.stops), [
        state.key,
        state.key,
      ]);
      await worker.evaluate(
        (scanState) =>
          chrome.runtime.sendMessage({
            type: 'monero:scanDisplay',
            states: [{ ...scanState, result: { ok: true } }],
          }),
        state,
      );
      await page.getByText('All scans finished', { exact: true }).waitFor();
      assert.equal(await page.locator('#stop').isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Stop scan', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      if (errors.length) contextTest.diagnostic(errors.join('\n'));
      try {
        if (context) await context.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);
