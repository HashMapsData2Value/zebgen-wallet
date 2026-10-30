import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile(
  'App.tsx',
  readFileSync(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let startupEffect;
let setupCondition;
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'useEffect' &&
    node.arguments[0]?.getText(source).includes('async function loadState()')
  )
    startupEffect = node.arguments[0].getText(source);
  if (
    ts.isConditionalExpression(node) &&
    node.whenTrue.getText(source).includes('<h2>Create Wallet Password or PIN</h2>')
  )
    setupCondition = node.condition.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(startupEffect);
assert.ok(setupCondition);

for (const failingRead of ['getWalletLockState', 'getSignedInState', 'getMoneroWalletState']) {
  test(`startup blocks PIN creation when ${failingRead} fails and logs the exception`, async () => {
    const failure = new Error('IndexedDB connection closed');
    const state = { isLoading: true, isLockConfigured: false, walletLoadError: null };
    const logs = [];
    const context = {
      exports: {},
      Error,
      console: { error: (...args) => logs.push(args) },
      getWalletLockState: async () => ({ isConfigured: true }),
      getSignedInState: async () => ({ isSignedIn: true, algoAddress: 'EXISTING' }),
      getMoneroWalletState: async () => ({ wallets: [], activeWalletId: null }),
      setIsLoading: (value) => {
        state.isLoading = value;
      },
      setIsLockConfigured: (value) => {
        state.isLockConfigured = value;
      },
      setWalletLoadError: (value) => {
        state.walletLoadError = value;
      },
      setIsSignedIn() {},
      setMoneroWallets() {},
      setActiveMoneroWalletId() {},
      setAlgoAddress() {},
      setAddressIndex() {},
      setIsUnlocked() {},
      setSelectedWalletType() {},
      setSessionLockSecret() {},
    };
    context[failingRead] = async () => {
      throw failure;
    };
    runInNewContext(
      ts.transpileModule(`exports.start = ${startupEffect}`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context,
    );
    const cleanup = context.exports.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.isLoading, false);
    assert.equal(state.walletLoadError, failure.message);
    assert.equal(logs[0][1], failure);
    assert.equal(runInNewContext(setupCondition, state), false);
    cleanup();
  });
}

test('PIN setup requires a successful empty-wallet read', () => {
  assert.equal(
    runInNewContext(setupCondition, {
      isLoading: false,
      isLockConfigured: false,
      walletLoadError: null,
    }),
    true,
  );
  assert.equal(
    runInNewContext(setupCondition, {
      isLoading: false,
      isLockConfigured: true,
      walletLoadError: null,
    }),
    false,
  );
});
