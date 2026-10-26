import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as requestSafety from '../lib/provider/requestSafety.ts';

const compile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

function fixture() {
  const storage = { 'zebgen:approvedOrigins': ['https://legacy.example'] };
  const state = {
    algoAddress: 'ALGO_A',
    moneroId: 1,
    moneroAddress: 'XMR_A',
    depositRelayed: false,
    popupError: null,
  };
  let popupOpened;
  let popupSignal = new Promise((resolve) => {
    popupOpened = resolve;
  });
  const removedListeners = new Set();
  const browser = {
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (values) => Object.assign(storage, values),
      },
    },
    runtime: { id: 'test', getURL: (path) => `chrome-extension://test${path}` },
    windows: {
      create: async (options) => {
        if (state.popupError) throw state.popupError;
        popupOpened(options);
        return { id: 1 };
      },
      remove: async () => {},
      onRemoved: {
        addListener: (listener) => removedListeners.add(listener),
        removeListener: (listener) => removedListeners.delete(listener),
      },
    },
  };
  const approval = {};
  runInNewContext(compile('../lib/provider/connectionApproval.ts'), {
    exports: approval,
    require: (name) => {
      if (name === 'wxt/browser') return { browser };
      if (name.endsWith('/algoWallet'))
        return { getSignedInState: async () => ({ algoAddress: state.algoAddress }) };
      if (name.endsWith('/moneroVault'))
        return {
          getMoneroWalletState: async () => ({
            activeWalletId: state.moneroId,
            wallets:
              state.moneroId === null ? [] : [{ id: state.moneroId, address: state.moneroAddress }],
          }),
        };
      throw new Error(name);
    },
  });
  const background = {};
  runInNewContext(
    compile('../entrypoints/background.ts') +
      '\nexports.request = (request, sender = { id: "test", url: request.origin + "/swap", origin: request.origin, tab: { id: 1 } }) => handleProviderRequest(request, sender); exports.pending = handlePendingRequestMessage;',
    {
      exports: background,
      defineBackground: () => {},
      console,
      require: (name) => {
        if (name === 'wxt/browser') return { browser };
        if (name.endsWith('/connectionApproval')) return approval;
        if (name.endsWith('/connectionSelection'))
          return {
            activateConnectionSelection: async (accounts) => {
              if (
                !approval.sameConnectionAccounts(
                  accounts,
                  await approval.activeConnectionAccounts(),
                )
              )
                throw new Error('Selected wallets unavailable');
            },
          };
        if (name.endsWith('/fundingValidation')) return { validateProviderRequest: () => {} };
        if (name.endsWith('/requestSafety')) return requestSafety;
        if (name.endsWith('/transactionService'))
          return { isSubmittedDepositResult: () => state.depositRelayed };
        if (name.endsWith('/originApproval'))
          return {
            isOriginApproved: async (origin) => storage['zebgen:approvedOrigins'].includes(origin),
            approveOrigin: async () => {},
          };
        return {};
      },
    },
  );
  return {
    approval,
    background,
    state,
    storage,
    removedListeners,
    opened: () => popupSignal,
    nextPopup: () => {
      popupSignal = new Promise((resolve) => {
        popupOpened = resolve;
      });
    },
  };
}

test('forged provider origins fail before approval or account lookup', async () => {
  const { background } = fixture();
  const response = await background.request(
    { id: crypto.randomUUID(), type: 'connect', origin: 'https://app.leakswap.com' },
    {
      id: 'test',
      url: 'https://attacker.example/',
      origin: 'https://attacker.example',
      tab: { id: 1 },
    },
  );
  assert.equal(response.ok, false);
  assert.match(response.error, /origin does not match/);
});

test('invite acceptance reports popup creation failure and removes its pending request', async () => {
  const { approval, background, state } = fixture();
  const origin = 'https://app.leakswap.com';
  await approval.approveConnection(origin, await approval.activeConnectionAccounts());
  state.popupError = new Error('Firefox could not create the approval window');
  const response = await background.request({
    id: '00000001-0000-4000-8000-000000000000',
    type: 'acceptSwapInvite',
    origin,
    params: { link: 'invite' },
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /Firefox could not create/);
  const pending = await background.pending({
    action: 'get',
    id: '00000001-0000-4000-8000-000000000000',
  });
  assert.equal(pending.ok, false);
});

test('deposit receipt survives account change after relay, but an unrecorded result cannot bypass validation', async () => {
  for (const relayed of [true, false]) {
    const current = fixture();
    const origin = 'https://site.example';
    await current.approval.approveConnection(
      origin,
      await current.approval.activeConnectionAccounts(),
    );
    const response = current.background.request({
      id: '00000002-0000-4000-8000-000000000000',
      type: 'depositLeakSwapMonero',
      origin,
      params: { agreementDigest: 'ab'.repeat(32), appId: '42' },
    });
    await current.opened();
    current.state.depositRelayed = relayed;
    current.state.moneroId = 2;
    const receipt = { transactionHash: 'a'.repeat(64), amountAtomic: '10', feeAtomic: '1' };
    await current.background.pending({
      action: 'resolve',
      id: '00000002-0000-4000-8000-000000000000',
      ok: true,
      result: receipt,
    });
    const result = await response;
    assert.equal(result.ok, relayed);
    if (relayed) {
      assert.equal(result.result.transactionHash, receipt.transactionHash);
      assert.equal(result.result.accountStatus, 'changed');
    }
  }
});

test('every deposit opens fresh approval; closing its window rejects without sending and cleans up', async () => {
  const fixtureState = fixture();
  const { approval, background, removedListeners } = fixtureState;
  const origin = 'https://site.example';
  await approval.approveConnection(origin, await approval.activeConnectionAccounts());
  for (const id of [
    '00000010-0000-4000-8000-000000000000',
    '00000011-0000-4000-8000-000000000000',
  ]) {
    fixtureState.nextPopup();
    const response = background.request({
      id,
      type: 'depositLeakSwapMonero',
      origin,
      params: { agreementDigest: 'ab'.repeat(32), appId: '42' },
    });
    await fixtureState.opened();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(removedListeners.size, 1);
    for (const listener of removedListeners) listener(1);
    const result = await response;
    assert.equal(result.ok, false);
    assert.match(result.error, /window closed/);
    assert.equal(removedListeners.size, 0);
  }
});

test('every connect prompts for consent, including unchanged previously approved accounts', async () => {
  const fixtureState = fixture();
  const { approval, background, state } = fixtureState;
  const origin = 'https://site.example';
  await approval.approveConnection(origin, await approval.activeConnectionAccounts());
  const reconnect = background.request({
    id: '00000003-0000-4000-8000-000000000000',
    type: 'connect',
    origin,
  });
  await fixtureState.opened();
  await background.pending({
    action: 'resolve',
    id: '00000003-0000-4000-8000-000000000000',
    ok: true,
    result: await approval.activeConnectionAccounts(),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await reconnect)), {
    ok: true,
    result: { algoAddress: 'ALGO_A', moneroAddress: 'XMR_A' },
  });
  fixtureState.nextPopup();
  state.algoAddress = 'ALGO_B';
  const pending = background.request({
    id: '00000004-0000-4000-8000-000000000000',
    type: 'connect',
    origin,
  });
  await fixtureState.opened();
  await background.pending({
    action: 'resolve',
    id: '00000004-0000-4000-8000-000000000000',
    ok: false,
    error: 'Rejected',
  });
  assert.equal((await pending).ok, false);
  await assert.rejects(approval.assertConnectionAccounts(origin, {}), /Connect again/);
});

test('every signing request opens a new approval prompt', async () => {
  const fixtureState = fixture();
  const { approval, background } = fixtureState;
  const origin = 'https://site.example';
  const accounts = await approval.activeConnectionAccounts();
  await approval.approveConnection(origin, accounts);
  for (const id of [
    '00000030-0000-4000-8000-000000000000',
    '00000031-0000-4000-8000-000000000000',
  ]) {
    fixtureState.nextPopup();
    const pending = background.request({
      id,
      type: 'signAlgorandTransactions',
      params: {},
      origin,
    });
    await fixtureState.opened();
    await background.pending({ action: 'resolve', id, ok: true, result: { signedTxns: [id] } });
    assert.equal((await pending).ok, true);
  }
});

test('legacy origin consent and non-connect approvals cannot silently create a cached connection', async () => {
  const fixtureState = fixture();
  const { background, approval } = fixtureState;
  const origin = 'https://legacy.example';
  assert.equal(await approval.connectedAccounts(origin), null);
  assert.equal(
    (
      await background.request({
        id: '00000005-0000-4000-8000-000000000000',
        type: 'signAlgorandTransactions',
        params: {},
        origin,
      })
    ).ok,
    false,
  );
  const pending = background.request({
    id: '00000006-0000-4000-8000-000000000000',
    type: 'connect',
    origin,
  });
  await fixtureState.opened();
  const accounts = await approval.activeConnectionAccounts();
  await background.pending({
    action: 'resolve',
    id: '00000006-0000-4000-8000-000000000000',
    ok: true,
    result: accounts,
  });
  const result = (await pending).result;
  assert.deepEqual(Object.keys(result).sort(), ['algoAddress', 'moneroAddress']);
  fixtureState.nextPopup();
  const retry = background.request({
    id: '00000007-0000-4000-8000-000000000000',
    type: 'connect',
    origin,
  });
  await fixtureState.opened();
  await background.pending({
    action: 'resolve',
    id: '00000007-0000-4000-8000-000000000000',
    ok: false,
    error: 'Rejected',
  });
  assert.equal((await retry).ok, false);
});

test('account overrides, other origins, removed wallets and stale consent fail closed', async () => {
  const { approval, state } = fixture();
  const origin = 'https://site.example';
  const accounts = await approval.activeConnectionAccounts();
  await approval.approveConnection(origin, accounts);
  await approval.assertConnectionAccounts(origin, { addressIndex: 0, moneroWalletId: 1 });
  await assert.rejects(
    approval.assertConnectionAccounts(origin, { addressIndex: 1 }),
    /other than/,
  );
  await assert.rejects(
    approval.assertConnectionAccounts(origin, { moneroWalletId: 2 }),
    /other than/,
  );
  await assert.rejects(
    approval.assertConnectionAccounts('https://other.example', {}),
    /No account connection is approved/,
  );
  state.moneroId = 2;
  await assert.rejects(approval.approveConnection(origin, accounts), /Active accounts changed/);
  await assert.rejects(approval.assertConnectionAccounts(origin, {}), /Connect again/);
  state.moneroId = null;
  await assert.rejects(approval.assertConnectionAccounts(origin, {}), /Connect again/);
});

test('missing accounts remain null, with no generated or invented addresses', async () => {
  const { approval, state } = fixture();
  state.algoAddress = null;
  state.moneroId = null;
  const accounts = await approval.activeConnectionAccounts();
  await approval.approveConnection('https://empty.example', accounts);
  assert.deepEqual(JSON.parse(JSON.stringify(approval.publicConnectionAccounts(accounts))), {
    algoAddress: null,
    moneroAddress: null,
  });
});

test('reconnecting different active accounts cannot replace an open operation request binding', async () => {
  const fixtureState = fixture();
  const { approval, background, state } = fixtureState;
  const origin = 'https://site.example';
  await approval.approveConnection(origin, await approval.activeConnectionAccounts());
  const pending = background.request({
    id: '00000020-0000-4000-8000-000000000000',
    type: 'signAlgorandTransactions',
    params: {},
    origin,
  });
  await fixtureState.opened();
  state.algoAddress = 'ALGO_B';
  await approval.approveConnection(origin, await approval.activeConnectionAccounts());
  const response = await background.pending({
    action: 'resolve',
    id: '00000020-0000-4000-8000-000000000000',
    ok: true,
    result: { signedTxns: ['must-not-return'] },
  });
  assert.equal(response.ok, false);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.result, undefined);
});
test('malformed and duplicate request ids never open an approval window', async () => {
  const { approval, background } = fixture();
  const origin = 'https://app.leakswap.com';
  await approval.approveConnection(origin, await approval.activeConnectionAccounts());
  for (const id of ['x&zebgenRequestId=1', 'accept-invite', '']) {
    const response = await background.request({
      id,
      type: 'acceptSwapInvite',
      origin,
      params: { link: 'invite' },
    });
    assert.match(response.error, /Invalid or duplicate request id/);
  }
});

test('concurrent duplicate ids cannot replace a request before its approval opens', async () => {
  const current = fixture();
  const origin = 'https://app.leakswap.com';
  await current.approval.approveConnection(
    origin,
    await current.approval.activeConnectionAccounts(),
  );
  const request = { id: crypto.randomUUID(), type: 'signAlgorandTransactions', origin, params: {} };
  const first = current.background.request(request);
  const duplicate = await current.background.request(request);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /duplicate request id/);
  await current.opened();
  await current.background.pending({
    action: 'resolve',
    id: request.id,
    ok: false,
    error: 'Rejected',
  });
  assert.equal((await first).error, 'Rejected');
});

test('closing any approval cancels its request and releases the reserved id', async () => {
  for (const type of ['connect', 'signAlgorandTransactions', 'acceptSwapInvite']) {
    const current = fixture();
    const origin = 'https://app.leakswap.com';
    await current.approval.approveConnection(
      origin,
      await current.approval.activeConnectionAccounts(),
    );
    const request = { id: crypto.randomUUID(), type, origin, params: {} };
    const first = current.background.request(request);
    await current.opened();
    await new Promise((resolve) => setImmediate(resolve));
    for (const listener of current.removedListeners) listener(1);
    assert.match((await first).error, /Request cancelled/);
    assert.equal(current.removedListeners.size, 0);
    assert.equal((await current.background.pending({ action: 'get', id: request.id })).ok, false);
    current.state.popupError = new Error('Retry reached window creation');
    assert.match(
      (await current.background.request(request)).error,
      /Retry reached window creation/,
    );
  }
});

test('confirmed wallet-owned settlement returns only receipt even after account change', async () => {
  const current = fixture();
  const origin = 'https://app.leakswap.com';
  await current.approval.approveConnection(
    origin,
    await current.approval.activeConnectionAccounts(),
  );
  const id = crypto.randomUUID();
  const response = current.background.request({
    id,
    type: 'settleLeakSwap',
    origin,
    params: { agreementDigest: 'ab'.repeat(32), appId: '42', action: 'claim' },
  });
  await current.opened();
  current.state.algoAddress = 'CHANGED';
  await current.background.pending({
    action: 'resolve',
    id,
    ok: true,
    result: { txId: 'A'.repeat(52), confirmedRound: '42', signatureHex: 'must-not-cross-provider' },
  });
  const receipt = await response;
  assert.equal(receipt.ok, true);
  assert.deepEqual(Object.keys(receipt.result).sort(), ['confirmedRound', 'txId']);
});
