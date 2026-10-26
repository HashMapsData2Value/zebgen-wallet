import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import * as timingPolicy from '../lib/wallet/swapTimingPolicy.ts';
import { walletRestoreHeight } from '../lib/monero/scanHeight.ts';

function load(path, dependencies = {}, globals = {}) {
  const api = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  runInNewContext(code, {
    exports: api,
    TextDecoder,
    console: { error() {} },
    ...globals,
    require: (name) => {
      if (name in dependencies) return dependencies[name];
      if (name === 'lucide-react') return { LoaderCircle: () => null };
      if (name.endsWith('.css')) return {};
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return api;
}
const validation = load('../lib/provider/fundingValidation.ts');
const transactions = { SPONSOR_FUNDING_MICROALGOS: 209000n };
const params = { agreementDigest: 'ab'.repeat(32), appId: '42' };

test('deposit payload accepts only an authenticated identity, never page-selected payment fields', () => {
  validation.validateProviderRequest('depositLeakSwapMonero', params);
  for (const invalid of [
    null,
    [],
    {},
    { ...params, recipient: 'attacker' },
    { ...params, amountAtomic: '1' },
    { ...params, moneroWalletId: -1 },
    { ...params, appId: '0' },
    { ...params, appId: '01' },
    { ...params, appId: '18446744073709551616' },
    { ...params, agreementDigest: 'bad' },
  ]) {
    assert.throws(() => validation.validateProviderRequest('depositLeakSwapMonero', invalid));
  }
});

function vault() {
  const offer = {
    deadlineUnit: 'round',
    createdRound: 100,
    algoAmount: '5000000',
    xmrAmount: '100000000001',
    t0: 2500,
    t1: 4900,
    algoGenesisHash: 'genesis',
    moneroNetwork: 'regtest',
    aliAlgoAddress: 'ali',
    aliPublicSpendKey: 'ali-spend',
    aliPrivateViewKey: 'ali-view',
  };
  const xin = {
    xinAlgoAddress: 'xin',
    xinPublicSpendKey: 'xin-spend',
    xinPrivateViewKey: 'xin-view',
  };
  const state = {
    role: 'xin',
    walletId: 7,
    ready: 0n,
    balance: 5000000n,
    sponsorBalance: 209000n,
    round: 100,
    verifyFailure: false,
    programs: true,
    shareMismatch: false,
    fundingShare: false,
    binding: true,
  };
  state.wallet = { restoreHeight: 12, restoreNetwork: 'regtest', scanRestoreHeights: {} };
  const calls = [];
  const material = {
    publicSpendKey: 'xin-spend',
    privateSpendKey: 'xin-secret',
    privateViewKey: 'xin-view',
    address: 'share',
  };
  class Algodv2 {
    getTransactionParams() {
      return { do: async () => ({ genesisHash: new Uint8Array([1]), genesisID: 'regtest' }) };
    }
    getApplicationByID(appId) {
      assert.equal(appId, 42n);
      return {
        do: async () => ({
          params: {
            globalState: [
              ...Object.entries({
                aliAlgoAddr: 'ali',
                xinAlgoAddr: 'xin',
                aliXternalPK: 'ali-spend',
                xinXternalPK: 'xin-spend',
              }).map(([key, bytes]) => ({ key: new TextEncoder().encode(key), value: { bytes } })),
              ...Object.entries({ t0: offer.t0, t1: offer.t1, aliReady: state.ready }).map(
                ([key, uint]) => ({ key: new TextEncoder().encode(key), value: { uint } }),
              ),
            ],
          },
        }),
      };
    }
    accountInformation(address) {
      return {
        do: async () => ({ amount: address === 'sponsor' ? state.sponsorBalance : state.balance }),
      };
    }
    status() {
      return { do: async () => ({ lastRound: BigInt(state.round) }) };
    }
    block() {
      throw new Error('Round-based deposits must not read timestamps.');
    }
  }
  const api = load('../lib/wallet/leakSwapDeposit.ts', {
    algosdk: {
      default: { Algodv2, encodeAddress: (value) => value, getApplicationAddress: () => 'escrow' },
    },
    '@noble/hashes/utils.js': { bytesToHex: (value) => value },
    '../network/networkStore': {
      getNetworkSettings: async () => ({
        algorand: { network: 'localnet', algod: { server: 'local' } },
        monero: { network: 'regtest', networkType: 'stagenet', daemon: { uri: 'daemon' } },
      }),
    },
    '../network/chainIdentity': { verifyAlgorandGenesis: () => calls.push('genesis') },
    '../provider/base64': { bytesToBase64: () => 'genesis' },
    '../provider/fundingValidation': validation,
    './algoWallet': {
      deriveActiveSeedAlgoAddressAtIndex: async () => ({ algoAddress: state.role }),
    },
    './swapRecordVault': {
      verifyAgreementApplication: async () => {
        calls.push('verified');
        if (state.verifyFailure) throw new Error('Invalid agreement');
        return { offer: { payload: offer }, acceptance: { payload: xin } };
      },
    },
    './swapAgreementArtifact': {
      assertAgreementPrograms: () => {
        if (!state.programs) throw new Error('Wrong programs');
      },
      agreementSponsorAddress: () => 'sponsor',
    },
    './swapAgreementTransactions': transactions,
    './swapTimingPolicy': timingPolicy,
    '../monero/scanHeight': { walletRestoreHeight },
    'leakswap-utils/dist/swapAgreement.js': {
      assertAgreementState: (_agreement, current) => {
        assert.equal(current.genesisHash, offer.algoGenesisHash);
        if (!state.binding) throw new Error('Wrong state');
      },
      assertAgreementFunding: (_agreement, balance) => {
        if (balance !== BigInt(offer.algoAmount)) throw new Error('Unfunded');
      },
    },
    './swapHandshakeVault': { resolveSwapWalletId: async () => -9 },
    './moneroVault': {
      getMoneroWalletState: async () => ({
        activeWalletId: state.walletId,
        wallets: [{ id: state.walletId, ...state.wallet }],
      }),
      unlockMoneroWallet: async (_secret, _network, id) =>
        id === -9
          ? { ...material, publicSpendKey: state.shareMismatch ? 'wrong' : material.publicSpendKey }
          : {
              ...material,
              publicSpendKey: state.fundingShare ? 'xin-spend' : 'funding-spend',
              address: 'funding-address',
            },
    },
    './moneroWallet': {
      computeCombinedAddressWithPrivateAndPublic: (...args) => {
        assert.deepEqual(args, ['xin-secret', 'xin-view', 'ali-view', 'ali-spend', 'stagenet']);
        return { combinedAddress: 'derived-combined' };
      },
    },
  });
  return { api, state, calls, offer };
}

test('wallet derives exact target from verified agreement and funds from normal active wallet, not its negative share', async () => {
  const fixture = vault();
  const target = await fixture.api.resolveLeakSwapDeposit(params, 'pin');
  assert.equal(target.recipient, 'derived-combined');
  assert.equal(target.amountAtomic, '100000000001');
  assert.equal(target.walletId, 7);
  assert.equal(target.sender, 'funding-address');
  assert.equal(target.restoreHeight, 12);
  assert.equal(target.binding.genesisHash, 'genesis');
  assert.equal(target.binding.appId, params.appId);
  assert.equal(target.binding.agreementDigest, params.agreementDigest);
  assert.deepEqual(fixture.calls, ['verified', 'genesis']);
  fixture.api.assertSameDepositTarget(target, target);
  assert.throws(() => fixture.api.assertSameDepositTarget(target, { ...target, walletId: 8 }));
});

test('deposit ignores a restore height belonging to a different network', async () => {
  const fixture = vault();
  fixture.state.wallet = { restoreHeight: 3500000, restoreNetwork: 'mainnet' };
  const target = await fixture.api.resolveLeakSwapDeposit(params, 'pin');
  assert.equal(target.restoreHeight, 0);
});

test('deposit prefers saved coverage height for the selected network', async () => {
  const fixture = vault();
  fixture.state.wallet = {
    restoreHeight: 3500000,
    restoreNetwork: 'mainnet',
    scanRestoreHeights: { regtest: 34 },
  };
  const target = await fixture.api.resolveLeakSwapDeposit(params, 'pin');
  assert.equal(target.restoreHeight, 34);
});

for (const [name, change] of [
  ['Ali role', { role: 'ali' }],
  ['unverified agreement', { verifyFailure: true }],
  ['wrong program', { programs: false }],
  ['wrong contract state', { binding: false }],
  ['unfunded contract', { balance: 0n }],
  ['unfunded fee sponsor', { sponsorBalance: 0n }],
  ['partly funded fee sponsor', { sponsorBalance: 208999n }],
  ['already ready', { ready: 1n }],
  ['expired deadline', { round: 2500 }],
  ['negative funding share', { walletId: -2 }],
  ['wrong saved share', { shareMismatch: true }],
  ['legacy share as funding', { fundingShare: true }],
])
  test(`deposit refuses ${name}`, async () => {
    const fixture = vault();
    Object.assign(fixture.state, change);
    await assert.rejects(fixture.api.resolveLeakSwapDeposit(params, 'pin'));
  });

test('deposit still works when someone adds extra ALGO to the escrow', async () => {
  const fixture = vault();
  fixture.state.balance = 5000001n;
  const target = await fixture.api.resolveLeakSwapDeposit(params, 'pin');
  assert.equal(target.binding.appId, params.appId);
});

test('deposit rejects insufficient remaining time on chain and a short signed claim window', async () => {
  const fixture = vault();
  fixture.state.round = fixture.offer.t0 - 1199;
  await assert.rejects(
    fixture.api.resolveLeakSwapDeposit(params, 'pin'),
    /60 minutes.*deposit deadline/,
  );
  fixture.state.round = fixture.offer.t0 - 1200;
  await fixture.api.resolveLeakSwapDeposit(params, 'pin');
  fixture.offer.t1 = fixture.offer.t0 + 1199;
  await assert.rejects(
    fixture.api.resolveLeakSwapDeposit(params, 'pin'),
    /claim window.*60 minutes/,
  );
});

function panel() {
  const states = [];
  const refs = [];
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  const calls = { prepare: 0, submit: 0, complete: 0, cancel: 0, discard: 0, verified: 0 };
  const control = {
    uncertain: false,
    changed: false,
    wrongAmount: false,
    disconnected: false,
    expired: false,
    existing: false,
  };
  const target = {
    sender: 'funding',
    recipient: 'combined',
    walletId: 7,
    amountAtomic: '100000000001',
    restoreHeight: 0,
    config: { network: 'regtest', daemon: { uri: 'daemon' } },
  };
  const reviewed = {
    id: 'prepared',
    hash: 'hash',
    amountAtomic: target.amountAtomic,
    feeAtomic: '50',
  };
  const api = load(
    '../entrypoints/popup/LeakSwapDeposit.tsx',
    {
      react: {
        useState: (initial) => {
          const index = stateIndex++;
          if (!(index in states)) states[index] = initial;
          return [
            states[index],
            (value) => {
              states[index] = value;
            },
          ];
        },
        useRef: (initial) => {
          const index = refIndex++;
          return (refs[index] ??= { current: initial });
        },
        useEffect: (callback) => effects.push(callback),
      },
      'react/jsx-runtime': jsx,
      '../../lib/provider/connectionApproval': {
        assertConnectionAccounts: async () => {
          if (control.disconnected) throw new Error('Accounts changed');
        },
      },
      '../../lib/wallet/leakSwapDeposit': {
        resolveLeakSwapDeposit: async () => {
          calls.verified++;
          return control.changed ? { ...target, walletId: 8 } : target;
        },
        assertSameDepositTarget: (expected, current) => assert.deepEqual(current, expected),
      },
      '../../lib/network/hostPermissions': { ensureHostPermissions: async () => {} },
      '../../lib/wallet/formatAtomic': { formatAtomic: (value) => String(value) },
      './CopyValue': { default: () => null },
      '../../lib/network/messages': {
        prepareTransactionViaBackground: async (request) => {
          calls.prepare++;
          assert.equal(request.recipient, target.recipient);
          assert.equal(request.walletId, 7);
          assert.equal(request.sweep, false);
          assert.equal(request.deposit, target);
          if (control.existing)
            return {
              ok: false,
              code: 'deposit-exists',
              uncertain: true,
              error:
                'Deposit attempt unknown: saved-hash. Do not deposit again. Check outgoing activity.',
            };
          return {
            ok: true,
            review: {
              ...reviewed,
              amountAtomic: control.wrongAmount ? '1' : reviewed.amountAtomic,
            },
          };
        },
        submitTransactionViaBackground: async (id, password) => {
          calls.submit++;
          assert.equal(id, reviewed.id);
          assert.equal(password, 'fresh-pin');
          if (control.expired)
            return { ok: false, code: 'review-expired', error: 'Review expired' };
          return control.uncertain
            ? { ok: false, uncertain: true, error: 'Relay outcome unknown' }
            : { ok: true, review: reviewed };
        },
        discardTransactionsViaBackground: async () => {
          calls.discard++;
        },
      },
    },
    { window: { addEventListener() {}, removeEventListener() {} } },
  );
  const props = {
    params,
    target,
    origin: 'https://site',
    accounts: {},
    secret: 'unlock-pin',
    onComplete: async (result) => {
      calls.complete++;
      assert.equal(result.transactionHash, 'hash');
    },
    onCancel: async () => {
      calls.cancel++;
    },
  };
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    return api.default(props);
  };
  const find = (element, predicate) => {
    if (!element || typeof element !== 'object') return undefined;
    if (predicate(element)) return element;
    for (const child of [element.props?.children].flat(Infinity)) {
      const found = find(child, predicate);
      if (found) return found;
    }
  };
  render();
  const cleanups = effects
    .map((effect) => effect())
    .filter((cleanup) => typeof cleanup === 'function');
  const stop = () => cleanups.forEach((cleanup) => cleanup());
  const text = (element) =>
    typeof element === 'string'
      ? element
      : element?.props
        ? [element.props.children].flat(Infinity).map(text).join(' ')
        : '';
  return {
    calls,
    control,
    stop,
    text: () => text(render()),
    button: (label) =>
      find(render(), (element) => element.type === 'button' && element.props.children === label),
    enter: () =>
      find(render(), (element) => element.type === 'input').props.onChange({
        target: { value: 'fresh-pin' },
      }),
    send: () =>
      find(render(), (element) => element.type === 'form').props.onSubmit({ preventDefault() {} }),
  };
}

test('deposit requires explicit preparation, visible fee review and separate password-confirmed Send', async () => {
  const fixture = panel();
  assert.equal(fixture.calls.prepare, 0);
  assert.equal(fixture.calls.submit, 0);
  await fixture.button('Review deposit and fee').props.onClick();
  assert.equal(fixture.calls.prepare, 1);
  assert.equal(fixture.calls.submit, 0);
  assert.equal(fixture.calls.complete, 0);
  assert.match(
    fixture.text(),
    /Funding wallet.*funding.*Swap deposit address.*combined.*Amount.*100000000001.*Transaction fee.*50.*Total.*100000000051/,
  );
  await fixture.send();
  assert.equal(fixture.calls.submit, 0);
  fixture.enter();
  await fixture.send();
  assert.equal(fixture.calls.submit, 1);
  assert.equal(fixture.calls.complete, 1);
  assert.equal(fixture.calls.verified, 2);
  assert.equal(fixture.button('Review deposit and fee'), undefined);
});

test('cancel discards prepared payment without send or success; unmount also discards', async () => {
  const fixture = panel();
  await fixture.button('Review deposit and fee').props.onClick();
  await fixture.button('Cancel').props.onClick();
  fixture.stop();
  assert.equal(fixture.calls.submit, 0);
  assert.equal(fixture.calls.complete, 0);
  assert.equal(fixture.calls.cancel, 1);
  assert.equal(fixture.calls.discard, 2);
});

test('uncertain relay never resolves success and cannot retry within this approval', async () => {
  const fixture = panel();
  fixture.control.uncertain = true;
  await fixture.button('Review deposit and fee').props.onClick();
  fixture.enter();
  await fixture.send();
  assert.equal(fixture.calls.submit, 1);
  assert.equal(fixture.calls.complete, 0);
  assert.equal(fixture.button('Review deposit and fee'), undefined);
  assert.equal(fixture.button('Send deposit'), undefined);
});

test('expired or cancelled background review clears the form and allows fresh preparation', async () => {
  const fixture = panel();
  await fixture.button('Review deposit and fee').props.onClick();
  fixture.control.expired = true;
  fixture.enter();
  await fixture.send();
  assert.equal(fixture.button('Send deposit'), undefined);
  assert.ok(fixture.button('Review deposit and fee'));
  fixture.control.expired = false;
  await fixture.button('Review deposit and fee').props.onClick();
  fixture.enter();
  await fixture.send();
  assert.equal(fixture.calls.prepare, 2);
  assert.equal(fixture.calls.complete, 1);
});

test('reopened approval shows existing attempt hash and guidance without allowing a new deposit', async () => {
  const fixture = panel();
  fixture.control.existing = true;
  await fixture.button('Review deposit and fee').props.onClick();
  assert.match(fixture.text(), /saved-hash.*Do not deposit again.*outgoing activity/);
  assert.equal(fixture.button('Review deposit and fee'), undefined);
  assert.equal(fixture.button('Send deposit'), undefined);
  assert.equal(fixture.calls.submit, 0);
});

for (const field of ['changed', 'disconnected', 'wrongAmount'])
  test(`deposit blocks send when ${field}`, async () => {
    const fixture = panel();
    if (field === 'wrongAmount') fixture.control[field] = true;
    await fixture.button('Review deposit and fee').props.onClick();
    if (field !== 'wrongAmount') {
      fixture.control[field] = true;
      fixture.enter();
      await fixture.send();
    }
    assert.equal(fixture.calls.submit, 0);
    assert.equal(fixture.calls.complete, 0);
  });
