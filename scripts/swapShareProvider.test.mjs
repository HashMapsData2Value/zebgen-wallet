import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as validation from '../lib/provider/fundingValidation.ts';
import * as requestSafety from '../lib/provider/requestSafety.ts';

const require = createRequire(import.meta.url);
function compile(source, modules) {
  const api = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
  } }).outputText, { exports: api, require: name => modules[name] ?? require(name),
    crypto, Uint8Array, TextEncoder, TextDecoder, console });
  return api;
}
const monero = compile(readFileSync(new URL('../lib/wallet/moneroWallet.ts', import.meta.url), 'utf8'), {});
const signing = compile(readFileSync(new URL('../lib/wallet/leakySign.ts', import.meta.url), 'utf8'), {});
const digest = 'ab'.repeat(32);

function harness() {
  const material = monero.generateMoneroKeyMaterial();
  const counterparty = monero.generateMoneroKeyMaterial();
  const algoAddress = algosdk.generateAccount().addr.toString();
  const saved = new Map();
  const scans = [];
  const unlocked = [];
  const agreement = { offer: { payload: { aliAlgoAddress: algoAddress, aliPublicSpendKey: material.publicSpendKey,
    aliPrivateViewKey: material.privateViewKey, moneroRestoreHeight: 100 } }, acceptance: { payload: {
    xinPublicSpendKey: counterparty.publicSpendKey, xinPrivateViewKey: counterparty.privateViewKey
  } } };
  const wallet = {
    getMoneroWalletState: async () => { throw new Error('provider must resolve the share rather than the active wallet'); },
    unlockMoneroWallet: async (_secret, _network, walletId) => { assert.equal(walletId, -41); unlocked.push(walletId); return material; },
    loadMoneroCombinedContext: async binding => saved.get(binding.combinedAddress) ?? null,
    saveMoneroCombinedContext: async context => { assert.equal(context.walletId, -41); saved.set(context.combinedAddress, context); }
  };
  const modules = {
    '../../lib/wallet/swapRecordVault': { verifyAgreementApplication: async (actualDigest, appId) => { assert.equal(actualDigest, digest); assert.equal(appId, 123n); } },
    '../../lib/monero/restoreHeight': { currentRestoreHeight: async () => 100, swapAddressHeight: async () => undefined, rememberSwapAddressHeight: async () => {} },
    '../../lib/monero/moneroDaemon': { scanMoneroFunding: async (_network, spend, view, height) => { scans.push({ spend, view, height }); return { matureAtomic: '10', spentStatusKnown: false }; } },
    '../../lib/provider/fundingValidation': validation,
    '../../lib/provider/requestSafety': requestSafety,
    '../../lib/network/networkStore': { getNetworkSettings: async () => ({ monero: { network: 'regtest', networkType: 0 } }) },
    '../../lib/provider/base64': {},
    '../../lib/provider/transactionPreview': {},
    '../../lib/wallet/algoWallet': { deriveActiveSeedAlgoAddressAtIndex: async () => ({ algoAddress }) },
    '../../lib/wallet/leakySign': signing,
    '../../lib/wallet/moneroVault': wallet,
    '../../lib/wallet/moneroWallet': monero,
    '../../lib/wallet/swapHandshakeVault': {
      loadAcceptedSwap: async actualDigest => { assert.equal(actualDigest, digest); return agreement; },
      resolveSwapWalletId: async actualDigest => { assert.equal(actualDigest, digest); return -41; }
    },
    'leakswap-utils/dist/swapHandshake.js': {},
    './SwapFeeDisclosure': {}, './ConnectDisclosure': {}, './LeakSwapDeposit': {},
    '../../lib/wallet/leakSwapDeposit': {},
    '../../lib/wallet/settleLeakSwap': { settleLeakSwap: async (params, secret, origin) => {
      assert.deepEqual(params, { agreementDigest: digest, appId: '123', action: 'claim' });
      assert.equal(secret, 'synthetic-password'); assert.equal(origin, 'https://app.leakswap.com');
      return { txId: 'receipt-only', confirmedRound: '42' };
    } },
    '../../lib/wallet/recoverLeakSwap': {},
    '../../lib/provider/connectionApproval': { assertConnectionAccounts: async () => {} },
    '../../lib/provider/connectionSelection': {},
    'wxt/browser': { browser: {} }
  };
  const source = readFileSync(new URL('../entrypoints/popup/ExternalRequestApp.tsx', import.meta.url), 'utf8')
    .replace('async function computeResult(', 'export async function computeResult(');
  const api = compile(source, modules);
  return { material, counterparty, saved, scans, unlocked,
    invoke: (type, params) => api.computeResult({ type, params, origin: 'https://app.leakswap.com' }, 'synthetic-password') };
}

test('share provider uses the explicit agreement share and delegates settlement without exporting a signature', async () => {
  const vault = harness();
  const params = { agreementDigest: digest, counterpartyPublicSpendKey: vault.counterparty.publicSpendKey,
    counterpartyPrivateViewKey: vault.counterparty.privateViewKey };
  const info = await vault.invoke('getMoneroShareInfo', { agreementDigest: digest });
  assert.equal(info.publicSpendKey, vault.material.publicSpendKey);
  assert.equal(info.privateSpendKey, undefined);
  const combined = await vault.invoke('computeCombinedMoneroAddress', params);
  assert.equal(vault.saved.get(combined.combinedAddress).walletId, -41);
  const scan = await vault.invoke('scanCombinedMoneroFunding', params);
  assert.equal(scan.combinedAddress, combined.combinedAddress);
  assert.equal(vault.scans[0].view, monero.combinePrivateSpendKeys(vault.material.privateViewKey, vault.counterparty.privateViewKey));
  assert.equal(vault.scans[0].height, 100);
  const result = await vault.invoke('settleLeakSwap', { agreementDigest: digest, appId: '123', action: 'claim' });
  assert.deepEqual(result, { txId: 'receipt-only', confirmedRound: '42' });
  assert.equal(vault.unlocked.length, 3);
  assert.ok(!JSON.stringify([info, combined, scan, result]).includes(vault.material.privateSpendKey));
});

test('share provider rejects substituted counterparty keys and arbitrary leaky messages before key use', async () => {
  const vault = harness();
  const other = monero.generateMoneroKeyMaterial();
  for (const type of ['computeCombinedMoneroAddress', 'scanCombinedMoneroFunding']) {
    await assert.rejects(vault.invoke(type, { agreementDigest: digest, counterpartyPublicSpendKey: other.publicSpendKey,
      counterpartyPrivateViewKey: vault.counterparty.privateViewKey }), /Counterparty keys do not match/);
  }
  await assert.rejects(vault.invoke('computeMoneroLeakySignature', { agreementDigest: digest, messageHex: '00'.repeat(32) }), /signatures are not exported/);
  await assert.rejects(vault.invoke('computeMoneroLeakySignature', { agreementDigest: digest, agreementAppId: '123', messageHex: '00'.repeat(32) }), /signatures are not exported/);
  assert.equal(vault.unlocked.length, 0);
});