import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(
  new URL('../../leakswap-all/leakswap-private/e2e-ui/package.json', import.meta.url),
);
const { chromium } = require('playwright');

test(
  'scan tab alone keeps background execution alive beyond the MV3 idle window with every wallet viewer closed',
  { timeout: 90000 },
  async () => {
    let requests = 0;
    let firstRequest;
    const receivedFirstRequest = new Promise((resolve) => {
      firstRequest = resolve;
    });
    const timers = new Set();
    const proxy = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(`http://127.0.0.1:18081${request.url}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.concat(chunks),
        });
        const body = await upstream.text();
        requests++;
        firstRequest();
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
            response.end(body);
          },
          requests <= 2 ? 18000 : 0,
        );
        timers.add(timer);
      } catch (error) {
        response.writeHead(502);
        response.end(String(error));
      }
    });
    await new Promise((resolveListen) => proxy.listen(0, '127.0.0.1', resolveListen));
    let context;
    const profile = await mkdtemp(resolve(tmpdir(), 'zebgen-scan-connection-'));
    try {
      const extension = resolve(process.env.ZEBGEN_TEST_EXTENSION ?? '.output/chrome-mv3');
      context = await chromium.launchPersistentContext(profile, {
        headless: false,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker');
      const page = await context.newPage();
      await page.goto(worker.url().replace(/background.js$/, 'dashboard.html'));
      const source = ts.transpileModule(
        readFileSync(new URL('../lib/network/messages.ts', import.meta.url), 'utf8'),
        {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        },
      ).outputText;
      const requestSource = `{
      config: { network: 'regtest', networkType: 0, daemon: { uri: 'http://127.0.0.1:${proxy.address().port}' } },
      restoreHeight: 17500, walletId: 1, primaryAddress: 'test', lockSecret: 'test'
    }`;
      const hostOpened = context.waitForEvent('page');
      await page.evaluate(`(() => {
      const exports = {};
      const require = () => ({ browser: chrome });
      ${source}
      void exports.scanMoneroBalanceViaBackground(${requestSource}).catch(() => {});
    })()`);
      const host = await hostOpened;
      host.on('console', (message) => console.log('scan display:', message.type(), message.text()));
      host.on('pageerror', (error) => console.error('scan display error:', error));
      await host.waitForURL('**/scan.html');
      await receivedFirstRequest;
      await page.close();
      const viewerClosedAt = Date.now();
      for (const otherPage of context.pages()) {
        if (otherPage !== host) await otherPage.close();
      }
      assert.equal(host.isClosed(), false);
      for (const width of [360, 1180]) {
        await host.setViewportSize({ width, height: 740 });
        assert.equal(await host.locator('h1').innerText(), 'Scanning Monero Blocks...');
        assert.match(await host.locator('.description').innerText(), /Keep this tab open/);
        assert.equal(
          await host
            .locator('.brand img')
            .evaluate((image) => image.complete && image.naturalWidth > 0),
          true,
        );
        assert.equal(
          await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await host.screenshot({ path: resolve(tmpdir(), `zebgen-scan-host-${width}.png`) });
      }
      await host
        .getByText('Set a wallet password or PIN first.', { exact: true })
        .waitFor({ state: 'visible', timeout: 65000 })
        .catch(async (error) => {
          console.error('scan lifetime diagnostic', {
            requests,
            display: await host.locator('main').innerText(),
            background: await host.evaluate(() =>
              chrome.runtime.sendMessage({ type: 'monero:scanDisplayStatus' }),
            ),
          });
          throw error;
        });
      assert.ok(
        Date.now() - viewerClosedAt >= 35000,
        'background execution must reach the unlock step more than 35 seconds after all wallet viewers closed',
      );
      assert.deepEqual(context.pages(), [host], 'only the scan display may remain open');
      assert.equal(await host.locator('#status').innerText(), 'All scans finished');
      assert.equal(
        requests,
        2,
        'one job must finish daemon verification without a viewer or restart',
      );
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
      for (const timer of timers) clearTimeout(timer);
      proxy.closeAllConnections();
      await new Promise((resolveClose) => proxy.close(resolveClose));
    }
  },
);
