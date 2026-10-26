import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('Workers uploads the built site including generated logo assets', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.assets.directory, './site-dist');
  assert.equal(config.name, 'zebgen');
});

test('website builds from source and brand assets without installed packages', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'zebgen-site-build-'));
  const root = new URL('../', import.meta.url);
  try {
    for (const folder of ['site/assets', 'scripts', 'assets/brand', 'public/icon']) {
      await mkdir(path.join(directory, folder), { recursive: true });
    }
    for (const file of [
      'scripts/build-site.mjs', 'site/index.html', 'site/style.css', 'site/wallet-theme.css', 'site/main.js',
      'assets/algorand_logo.png', 'assets/monero_logo.png', 'public/icon/128.png',
      'assets/brand/zebgen-mark-violet-128.png', 'assets/brand/zebgen-mark-luminous.svg',
      'assets/brand/zebgen-mark-violet.svg', 'assets/brand/zebgen-mark-violet-32.png',
      'site/assets/wallet-preview.png',
      'site/assets/chrome.svg', 'site/assets/firefox.svg',
    ]) {
      await cp(new URL(file, root), path.join(directory, file));
    }
    execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: directory });
    const output = path.join(directory, 'site-dist');
    assert.deepEqual((await readdir(output)).sort(), ['assets', 'favicon-32.png', 'favicon.svg', 'index.html', 'main.js', 'style.css', 'wallet-theme.css']);
    const theme = await readFile(path.join(output, 'wallet-theme.css'), 'utf8');
    assert.ok(theme.includes('background: #04020b'));
    assert.ok(theme.includes("font-family: 'Space Grotesk'"));
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    assert.ok(html.includes('href="/favicon.svg?v=2"'));
    assert.ok(html.includes('href="/favicon-32.png?v=2"'));
    assert.ok((await readFile(path.join(output, 'favicon.svg'), 'utf8')).includes('#be9dff'));
    for (const asset of ['zebgen.png', 'algorand.png', 'monero.png', 'wallet-preview.png']) {
      assert.ok((await readFile(path.join(output, 'assets', asset))).length > 0);
      assert.ok(html.includes(`/assets/${asset}`));
    }
    assert.ok(html.includes('https://github.com/HashMapsData2Value/zebgen-wallet/releases'));
    assert.ok(html.includes('https://leakswap.com'));
    assert.ok(html.includes('Nodes are graciously hosted by'));
    assert.ok(html.includes('href="https://nodely.io" target="_blank" rel="noopener noreferrer">Nodely.io</a>, but you are free to use your own.'));
    for (const faucet of ['https://lora.algokit.io/testnet/fund', 'https://faucet-stagenet.xmr.nodely.dev/']) {
      assert.ok(html.includes(`href="${faucet}" target="_blank" rel="noopener noreferrer"`));
    }
    assert.deepEqual(await readFile(path.join(output, 'assets/zebgen.png')), await readFile(new URL('assets/brand/zebgen-mark-violet-128.png', root)));
    assert.ok(!/ZebGen|Zebgen/.test(html));
    assert.ok(theme.includes('zebgen-luminescence'));
    assert.ok(theme.includes("font-family: 'Jersey 20'"));
    for (const token of ['USDC', 'GOLD$', 'SILVER$']) assert.ok(html.includes(token));
    assert.ok(theme.includes('@keyframes pair-left'));
    assert.ok(theme.includes('@keyframes pair-right'));
    assert.ok(theme.includes('prefers-reduced-motion: reduce'));
    assert.ok(!html.includes('chrome.google.com/webstore'));
    execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: directory });
    assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), html);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
