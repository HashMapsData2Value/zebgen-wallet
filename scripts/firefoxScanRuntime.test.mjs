import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import webExt from 'web-ext-run';

async function probe(reportUrl) {
  const ensure = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  let ready;
  let statusRequested;
  let stopped;
  const readyPromise = new Promise((resolveReady) => {
    ready = resolveReady;
  });
  const statusPromise = new Promise((resolveStatus) => {
    statusRequested = resolveStatus;
  });
  const stopPromise = new Promise((resolveStop) => {
    stopped = resolveStop;
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'monero:scanHostReady') ready(sender);
    if (message.type === 'monero:scanDisplayStatus') {
      statusRequested();
      return Promise.resolve({ states: [] });
    }
    if (message.type === 'monero:scanStop') stopped(message);
    return false;
  });
  try {
    ensure(
      location.pathname === '/_generated_background_page.html',
      'Expected Firefox generated background page',
    );
    const tab = await browser.tabs.create({ url: browser.runtime.getURL('/scan.html') });
    const sender = await readyPromise;
    ensure(sender.tab?.id === tab.id, 'Scan readiness must come from the scan tab');
    await statusPromise;
    const acknowledgement = await browser.runtime.sendMessage({
      type: 'monero:hostRequest',
      action: 'start',
    });
    ensure(acknowledgement?.ok === true, 'Firefox background handshake was rejected');
    const state = {
      key: 'runtime-test',
      address: 'test-public-address',
      progress: { scannedHeight: 100, targetHeight: 200 },
    };
    await browser.runtime.sendMessage({ type: 'monero:scanDisplay', states: [state] });
    const view = browser.extension
      .getViews({ type: 'tab' })
      .find((candidate) => candidate.location.pathname === '/scan.html');
    ensure(view, 'Scan extension view is missing');
    const scanDocument = view.document;
    ensure(
      scanDocument.querySelector('#status').textContent === '1 active scan',
      'Scan progress was not rendered',
    );
    ensure(
      scanDocument.querySelector('main').textContent.includes('Block 100 / 200'),
      'Block progress was not rendered',
    );
    scanDocument.querySelector('.scan-row button').click();
    ensure((await stopPromise).key === state.key, 'Stop did not reach the Firefox background');
    await browser.runtime.sendMessage({
      type: 'monero:scanDisplay',
      states: [{ ...state, result: { ok: true } }],
    });
    ensure(
      scanDocument.querySelector('#status').textContent === 'All scans finished' &&
        scanDocument.querySelector('#stop').disabled,
      'Completed state was not rendered',
    );
    await fetch(reportUrl, {
      method: 'POST',
      body: JSON.stringify({ ok: true, backgroundUrl: location.href }),
    });
  } catch (error) {
    console.error(error);
    await fetch(reportUrl, {
      method: 'POST',
      body: JSON.stringify({ ok: false, error: `${String(error)}\n${error.stack ?? ''}` }),
    });
  }
}

test(
  'real Firefox background can handshake with the built scan page, display progress, and receive Stop',
  { timeout: 90000 },
  async () => {
    const source = resolve(process.env.ZEBGEN_TEST_EXTENSION ?? '.output-firefox-test/firefox-mv2');
    const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 2);
    const directory = await mkdtemp(join(tmpdir(), 'zebgen-firefox-scan-'));
    const token = randomUUID();
    let runner;
    let timer;
    let server;
    try {
      const result = new Promise((resolveResult, rejectResult) => {
        timer = setTimeout(
          () =>
            rejectResult(
              new Error(
                'Firefox scan runtime timed out: no successful handshake/status/Stop report',
              ),
            ),
          60000,
        );
        server = createServer(async (request, response) => {
          if (request.url !== `/${token}` || request.method !== 'POST') {
            response.writeHead(404).end();
            return;
          }
          try {
            let body = '';
            for await (const chunk of request) body += chunk;
            resolveResult(JSON.parse(body));
            response.end('ok');
          } catch (error) {
            rejectResult(error);
            response.writeHead(400).end();
          }
        });
      });
      result.catch(() => {});
      await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
      const reportUrl = `http://127.0.0.1:${server.address().port}/${token}`;
      await cp(source, directory, { recursive: true });
      manifest.background = { scripts: ['runtime-probe.js'] };
      manifest.permissions = ['tabs', 'http://127.0.0.1/*'];
      manifest.browser_specific_settings = { gecko: { id: 'scan-runtime-test@zebgen.test' } };
      delete manifest.content_scripts;
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(
        join(directory, 'runtime-probe.js'),
        `(${probe.toString()})(${JSON.stringify(reportUrl)});`,
      );
      runner = await webExt.cmd.run({
        sourceDir: directory,
        firefox:
          process.env.FIREFOX_BINARY ??
          (process.platform === 'darwin'
            ? '/Applications/Firefox.app/Contents/MacOS/firefox'
            : 'firefox'),
        args: ['-headless'],
        noReload: true,
        noInput: true,
      });
      const report = await result;
      assert.equal(report.ok, true, report.error);
      assert.match(
        report.backgroundUrl,
        /^moz-extension:\/\/[^/]+\/_generated_background_page\.html$/,
      );
    } finally {
      clearTimeout(timer);
      if (runner) await runner.exit();
      if (server) await new Promise((resolveClose) => server.close(resolveClose));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
