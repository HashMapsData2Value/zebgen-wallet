import { readFileSync, mkdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import algosdk from 'algosdk';
import { chromium } from '../../leakswap-all/leakswap-private/e2e-ui/node_modules/playwright/index.mjs';

const root = new URL('../', import.meta.url);
const networks = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('lib/network/networks.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: networks,
    require: () => ({ MoneroNetworkType: { MAINNET: 0, TESTNET: 1, STAGENET: 2 } }),
  },
);
const address = algosdk.encodeAddress(new Uint8Array(32));
const settings = {
  algorand: {
    network: 'testnet',
    algod: { server: 'https://testnet-api.algonode.cloud', port: '', token: '' },
  },
};
const appStates = { 1: false, 2: true, 3: true, 4: true, 5: address, 40: settings };
const cache = new Map();
function loadComponent(name) {
  if (cache.has(name)) return cache.get(name);
  const source = readFileSync(new URL(`entrypoints/popup/${name}.tsx`, root), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const api = {};
  let stateIndex = 0;
  runInNewContext(compiled, {
    exports: api,
    require: (dependency) => {
      if (dependency === 'react/jsx-runtime') return jsx;
      if (dependency === 'react')
        return {
          ...react,
          useEffect: () => {},
          useState: (initial) => {
            const index = stateIndex++;
            const value =
              name === 'App' && Object.hasOwn(appStates, index)
                ? appStates[index]
                : name === 'AlgorandAddressCard' && index === 0
                  ? { algos: 0 }
                  : initial;
            return [value, () => {}];
          },
        };
      if (dependency === 'lucide-react') return icons;
      if (dependency.endsWith('.png'))
        return {
          default: `data:image/png;base64,${readFileSync(new URL(`assets/${dependency.split('/').pop()}`, root)).toString('base64')}`,
        };
      if (dependency.endsWith('/networks')) return networks;
      if (dependency.endsWith('/algoWallet'))
        return { getAlgoDerivationPath: () => "m/44'/283'/0'/0/0" };
      if (['./AlgorandAddressCard', './NetworkBadge', './CopyValue'].includes(dependency))
        return loadComponent(dependency.slice(2));
      return {};
    },
  });
  cache.set(name, api);
  return api;
}
const markup = renderToStaticMarkup(react.createElement(loadComponent('App').default));
if (!markup.includes('0 ALGO') || !markup.includes('Send ALGO'))
  throw new Error('Wallet fixture did not render the funded-wallet layout');
const css =
  readFileSync(new URL('entrypoints/popup/style.css', root), 'utf8') +
  readFileSync(new URL('entrypoints/popup/App.css', root), 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 440, height: 700 },
    deviceScaleFactor: 2,
  });
  await page.setContent(`<html><head><style>${css}</style></head><body>${markup}</body></html>`);
  await page
    .locator('img')
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  mkdirSync(new URL('site/assets/', root), { recursive: true });
  await page
    .locator('main')
    .screenshot({ path: new URL('site/assets/wallet-preview.png', root).pathname });
  console.log('Captured real wallet components with synthetic TestNet data.');
} finally {
  await browser.close();
}
