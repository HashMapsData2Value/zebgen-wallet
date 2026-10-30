import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

function markup(mode) {
  const values = [mode, '', '', '', null, false, '', ''];
  const api = {};
  const code = ts.transpileModule(
    readFileSync(new URL('../entrypoints/popup/SwapBackupTools.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(code, {
    exports: api,
    require: (name) => {
      if (name === 'react') return { ...react, useState: () => [values.shift(), () => {}] };
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'lucide-react') return icons;
      return {};
    },
  });
  return renderToStaticMarkup(react.createElement(api.default, { onRestore() {} }));
}

test('backup controls expose password confirmation and file restore without plaintext key fields', () => {
  const exported = markup('export');
  assert.match(exported, /Confirm backup password/);
  assert.match(exported, /minLength="12"/);
  assert.match(exported, /Export encrypted backup/);
  const restored = markup('restore');
  assert.match(restored, /type="file"/);
  assert.match(restored, /empty swap store/);
  assert.doesNotMatch(exported + restored, /privateSpendKey|privateViewKey|textarea/);
});

test('backup export and restore fit mobile and desktop layouts', async () => {
  const require = createRequire(
    new URL('../../leakswap-all/leakswap-private/e2e-ui/package.json', import.meta.url),
  );
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const css = readFileSync(new URL('../entrypoints/popup/App.css', import.meta.url), 'utf8');
    for (const mode of ['export', 'restore']) {
      for (const width of [360, 1100]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.setContent(
          `<style>${css} main { max-width: 700px; margin: auto; padding: 16px; }</style><main>${markup(mode)}</main>`,
        );
        await page.locator('summary').click();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: `/tmp/zebgen-swap-backup-${mode}-${width}.png`,
          fullPage: true,
        });
      }
    }
  } finally {
    await browser.close();
  }
});
