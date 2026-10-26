import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import getNextVersion from 'semantic-release/lib/get-next-version.js';

const config = JSON.parse(await readFile(new URL('../.releaserc.json', import.meta.url), 'utf8'));
const analyzer = config.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer')[1];
const logger = { log() {} };

test('Release publishes stable versions and main publishes beta versions', () => {
  assert.deepEqual(config.branches, ['Release', { name: 'main', prerelease: 'beta', channel: 'beta' }]);
  for (const [branch, expected] of [
    [{ name: 'Release', type: 'release', tags: [] }, '0.0.1'],
    [{ name: 'main', type: 'prerelease', prerelease: 'beta', channel: 'beta', tags: [] }, '0.0.1-beta.1'],
  ]) {
    assert.equal(getNextVersion({ branch, lastRelease: { version: '0.0.0', gitHead: 'baseline', channels: [null] }, nextRelease: { type: 'patch' }, commits: [], logger }), expected);
  }
});

test('pre-1.0 breaking changes produce minor rather than major releases', async () => {
  for (const [message, expected] of [
    ['fix: repair recovery', 'patch'],
    ['feat: add wallet capability', 'minor'],
    ['feat!: change API\n\nBREAKING CHANGE: old API removed', 'minor'],
    ['docs: update guide', null],
  ]) {
    assert.equal(await analyzeCommits(analyzer, { commits: [{ message, hash: 'test' }], logger, cwd: process.cwd() }), expected);
  }
});

test('landing page source and downloads use zebgen-wallet', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../site/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html + script, /HashMapsData2Value\/zebgen(?:[/'"]|$)/);
  assert.match(html, /https:\/\/github.com\/HashMapsData2Value\/zebgen-wallet/);
  assert.match(script, /repos\/HashMapsData2Value\/zebgen-wallet\/releases\/latest/);
  assert.match(script, /zebgen-wallet\/releases\/download\//);
});

test('downloads prefer stable builds and fall back to beta before the first stable release', async () => {
  const source = await readFile(new URL('../site/main.js', import.meta.url), 'utf8');
  for (const betaOnly of [false, true]) {
    const requests = [];
    const links = ['chrome', 'firefox'].map(browser => ({ dataset: { browserDownload: browser }, addEventListener() {} }));
    const release = { assets: links.map(link => ({
      name: `zebgen-0.0.1${betaOnly ? '-beta.1' : ''}-${link.dataset.browserDownload}.zip`,
      browser_download_url: `https://github.com/HashMapsData2Value/zebgen-wallet/releases/download/test/${link.dataset.browserDownload}.zip`,
    })) };
    const context = vm.createContext({
      document: { querySelectorAll: selector => selector.includes('data-browser-download') ? links : [] },
      URL, AbortSignal, console,
      fetch: async url => {
        requests.push(url);
        const missingStable = betaOnly && url.endsWith('/latest');
        return { status: missingStable ? 404 : 200, ok: !missingStable, json: async () => betaOnly ? [release] : release };
      },
    });
    vm.runInContext(source.slice(0, source.indexOf('if (browserDownloads.length)')), context);
    await vm.runInContext('resolveBrowserDownloads()', context);
    assert.equal(requests.length, betaOnly ? 2 : 1);
    for (const link of links) assert.equal(link.href, release.assets.find(asset => asset.name.endsWith(`-${link.dataset.browserDownload}.zip`)).browser_download_url);
  }
});