import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(path, dependencies, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
    AbortController,
    URL,
    console,
    ...globals,
  });
  return exports;
}

for (const backgroundPath of ['/background.js', '/_generated_background_page.html']) {
  test(`scan tab accepts ${backgroundPath} without wallet dependencies and rejects other senders`, async () => {
    const origin = backgroundPath.endsWith('.html')
      ? 'moz-extension://test'
      : 'chrome-extension://test';
    const elements = new Map();
    function element() {
      return {
        textContent: '',
        disabled: false,
        children: [],
        append(...children) {
          this.children.push(...children);
        },
        replaceChildren(...children) {
          this.children = children;
        },
        addEventListener(_type, handler) {
          this.click = handler;
        },
      };
    }
    for (const selector of ['#status', '#stop', 'main']) elements.set(selector, element());
    const messages = [];
    let listener;
    load(
      '../entrypoints/scan/main.ts',
      {
        'wxt/browser': {
          browser: {
            runtime: {
              id: 'test',
              getURL: (path) => `${origin}${path}`,
              sendMessage: async (message) => {
                messages.push(message);
                return { states: [] };
              },
              onMessage: {
                addListener: (handler) => {
                  listener = handler;
                },
              },
            },
          },
        },
        './style.css': {},
      },
      {
        document: { querySelector: (selector) => elements.get(selector), createElement: element },
        navigator: { locks: { request: async (_name, _options, handler) => handler({}) } },
        setInterval: () => 0,
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundSender = { id: 'test', url: `${origin}${backgroundPath}` };
    const display = (states, sender = backgroundSender) =>
      listener({ type: 'monero:scanDisplay', states }, sender, () => {});
    const status = elements.get('#status');
    const first = { key: 'first', address: 'first' };
    const second = { key: 'second', address: 'second' };
    display([first], { id: 'test', url: `${origin}/popup.html` });
    display([first], { ...backgroundSender, tab: { id: 1 } });
    display([first], { ...backgroundSender, id: 'other-extension' });
    assert.equal(status.textContent, 'Waiting for scan...');
    let acknowledgement;
    listener({ type: 'monero:hostRequest', action: 'start' }, backgroundSender, (response) => {
      acknowledgement = response;
    });
    assert.equal(acknowledgement?.ok, true);
    display([first]);
    assert.equal(status.textContent, '1 active scan');
    display([{ ...first, result: { ok: true } }]);
    assert.equal(status.textContent, 'All scans finished');
    display([first, second]);
    assert.equal(status.textContent, '2 active scans');
    display([{ ...first, result: { ok: true } }, second]);
    assert.equal(status.textContent, '1 active scan');
    const rows = elements.get('main').children[0].children;
    assert.equal(rows[0].children[1].textContent, 'Scan complete');
    assert.equal(rows[1].children[1].textContent, 'Starting scan...');
    rows[1].children[2].click();
    assert.equal(messages.at(-1).type, 'monero:scanStop');
    assert.equal(messages.at(-1).key, 'second');
    display([
      { ...first, result: { ok: true } },
      { ...second, result: { ok: false, error: 'stopped' } },
    ]);
    assert.equal(elements.get('#stop').disabled, true);
    assert.ok(
      messages.every(
        (message) => !JSON.stringify(message).match(/lockSecret|privateSpendKey|privateViewKey/),
      ),
    );
  });
}
