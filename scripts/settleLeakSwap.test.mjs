import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import algosdk from 'algosdk';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { leakySign } from '../lib/wallet/leakySign.ts';
import { assertSafeSigningRequest, checkAgreementTransaction } from '../lib/wallet/swapAgreementTransactions.ts';
import { validateProviderRequest } from '../lib/provider/fundingValidation.ts';
import * as roundTiming from 'leakswap-utils/dist/swapTiming.js';
import { artifactApi, canonical, programs } from './helpers/swapAgreementArtifact.mjs';

test('settlement accepts only the authenticated identity and action, not page-selected transaction fields', () => {
  const params = { agreementDigest: 'ab'.repeat(32), appId: '42', action: 'claim' };
  validateProviderRequest('settleLeakSwap', params);
  for (const invalid of [null, [], {}, { ...params, signatureHex: '00' }, { ...params, receiver: 'attacker' },
    { ...params, action: 'punish' }, { ...params, agreementDigest: '' }, { ...params, appId: '0' },
    { ...params, appId: '01' }, { ...params, appId: '18446744073709551616' }]) {
    assert.throws(() => validateProviderRequest('settleLeakSwap', invalid));
  }
});

function fixture(action = 'claim', legacyDeadlines = false) {
  const party = algosdk.generateAccount();
  const other = algosdk.generateAccount();
  const genesisHash = new Uint8Array(32).fill(1);
  const now = 100000;
  const state = { action, minFee: 1000n, balance: 5000000n, sponsorBalance: 209000n, ready: 1n, round: legacyDeadlines ? 9000000 : now, timestamp: now,
    ...programs(canonical),
    t0: now + 3600, t1: now + 7200, wrongParty: false, wrongKey: false, wrongNetwork: false,
    verifyFailure: false, simulationFailure: false, simulationError: false, submitError: false, journalError: false, cancelAfterSimulation: false };
  const controller = new AbortController();
  let clock = now * 1000;
  class TestDate extends Date { static now() { return clock; } }
  const calls = [];
  const errors = [];
  const publicKey = '02'.repeat(32);
  const agreement = { offer: { payload: { deadlineUnit: 'round', createdRound: 100, aliAlgoAddress: action === 'refund' ? party.addr.toString() : other.addr.toString(),
    aliPublicSpendKey: publicKey, algoGenesisHash: Buffer.from(genesisHash).toString('base64'), algoAmount: '5000000' } },
    acceptance: { payload: { xinAlgoAddress: action === 'claim' ? party.addr.toString() : other.addr.toString(), xinPublicSpendKey: publicKey } } };
  if (legacyDeadlines) {
    delete agreement.offer.payload.deadlineUnit;
    delete agreement.offer.payload.createdRound;
  }
  const sponsor = new algosdk.LogicSigAccount(new Uint8Array([6, 129, 1]));
  let group;
  const algod = {
    getTransactionParams: () => ({ do: async () => ({ genesisHash: state.wrongNetwork ? new Uint8Array(32) : genesisHash,
      genesisID: 'mock', fee: 1000n, minFee: state.minFee, firstValid: 1n, lastValid: 100n }) }),
    getApplicationByID: () => ({ do: async () => ({ params: { globalState: [{ key: new TextEncoder().encode('aliReady'), value: { uint: state.ready } }] } }) }),
    status: () => ({ do: async () => ({ lastRound: BigInt(state.round) }) }),
    block: round => {
      assert.equal(legacyDeadlines, true, 'Round settlement must not read timestamps.');
      assert.equal(round, state.round);
      return { do: async () => {
        if (state.blockError) throw new Error('Block unavailable');
        return { block: { header: { timestamp: state.timestamp } } };
      } };
    },
    accountInformation: address => ({ do: async () => ({ amount: address.toString() === sponsor.address().toString() ? state.sponsorBalance : state.balance }) }),
    simulateTransactions: request => ({ do: async () => {
      calls.push('simulate'); group = request.txnGroups[0].txns;
      if (state.cancelAfterSimulation) controller.abort();
      if (state.expireAfterSimulation) {
        if (legacyDeadlines) state.timestamp = state.t0 + 1;
        else state.round = state.t0 + 1;
      }
      if (state.clockJumpAfterSimulation) clock = 9999999999999;
      if (state.simulationError) throw new Error(state.nodeMessage ?? 'node request rejected');
      return { txnGroups: [{ ...(state.simulationFailure ? { failureMessage: state.nodeMessage ?? 'rejected', failedAt: [1] } : {}) }] };
    } }),
    sendRawTransaction: blobs => ({ do: async () => { calls.push('broadcast'); assert.equal(blobs.length, 2); if (state.submitError) throw new Error('lost response'); } }),
  };
  const settings = { algorand: { network: 'localnet', algod: { server: 'local' } }, monero: { network: 'regtest', networkType: 'stagenet' } };
  const api = {};
  const dependencies = {
    algosdk: { ...algosdk, Algodv2: function () { return algod; }, waitForConfirmation: async () => { calls.push('confirm'); return { confirmedRound: 2n }; } },
    '@noble/hashes/utils.js': { bytesToHex, hexToBytes },
    '../network/networkStore': { getNetworkSettings: async () => settings },
    '../network/chainIdentity': { verifyAlgorandGenesis: () => {} },
    '../provider/base64': { bytesToBase64: bytes => Buffer.from(bytes).toString('base64') },
    '../provider/fundingValidation': { validateProviderRequest },
    '../provider/connectionApproval': { assertConnectionAccounts: async () => {} },
    './algoWallet': { deriveActiveSeedAlgoAddressAtIndex: async () => ({ algoAddress: (state.wrongParty ? other : party).addr.toString() }),
      signRawTransactions: async (_secret, index, bytes) => { calls.push('algo-sign'); assert.equal(index, 0); return bytes.map(bytes => algosdk.decodeUnsignedTransaction(bytes).signTxn(party.sk)); } },
    './swapHandshakeVault': { resolveSwapWalletId: async () => -1 },
    './moneroVault': { unlockMoneroWallet: async () => ({ publicSpendKey: state.wrongKey ? 'bad' : publicKey, privateSpendKey: '01' + '00'.repeat(31) }) },
    './swapRecordVault': { verifyAgreementApplication: async () => {
      calls.push('verify'); if (state.verifyFailure) throw new Error('Wrong application');
      artifactApi.assertAgreementPrograms(state.approvalProgram, state.clearStateProgram);
      Object.assign(agreement.offer.payload, { t0: state.t0, t1: state.t1 }); return agreement;
    }, journalSignedAlgorandTransactions: async () => { calls.push('journal'); if (state.journalError) throw new Error('Storage unavailable'); } },
    './swapAgreementArtifact': { agreementSponsorLogicSig: () => sponsor },
    './swapAgreementTransactions': { assertSafeSigningRequest, checkAgreementTransaction },
    './leakySign': { leakySign: (...args) => { calls.push('leaky-sign'); return leakySign(...args); } },
    'leakswap-utils/dist/swapTiming.js': roundTiming,
  };
  const code = ts.transpileModule(readFileSync(new URL('../lib/wallet/settleLeakSwap.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, { exports: api, Uint8Array, TextDecoder, Date: TestDate, console: { error: (...args) => errors.push(args) },
    navigator: { locks: { request: async (_name, action) => action() } },
    require: name => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; },
  });
  return { state, calls, errors, group: () => group, run: () => api.settleLeakSwap({ agreementDigest: 'ab'.repeat(32), appId: '42', action }, 'secret', 'https://app.leakswap.com', controller.signal) };
}

for (const action of ['claim', 'refund']) test(`wallet owns ${action} construction, signing and broadcast; returns only receipt`, async () => {
  const current = fixture(action);
  if (action === 'refund') current.state.ready = 0n;
  const result = await current.run();
  assert.deepEqual(Object.keys(result).sort(), ['confirmedRound', 'txId']);
  assert.equal(result.confirmedRound, '2');
  assert.deepEqual(current.calls, ['verify', 'leaky-sign', 'journal', 'simulate', 'algo-sign', 'broadcast', 'confirm']);
  const [sponsor, call] = current.group();
  assert.ok(sponsor.lsig);
  assert.equal(call.sig, undefined);
  assert.equal(call.txn.applicationCall.onComplete, algosdk.OnApplicationComplete.DeleteApplicationOC);
  assert.equal(call.txn.fee, action === 'claim' ? 8000n : 5000n);
  assert.equal(result.txId, call.txn.txID());
});

for (const [name, change] of [
  ['wrong party', { wrongParty: true }], ['wrong application', { verifyFailure: true }],
  ['wrong key', { wrongKey: true }], ['wrong network', { wrongNetwork: true }],
  ['escrow shortfall', { balance: 4999999n }], ['sponsor shortfall', { sponsorBalance: 106999n }],
  ['not ready', { ready: 0n }], ['final deadline', { t1: 1 }],
]) test(`local preflight rejects ${name} before generating a revealing signature`, async () => {
  const current = fixture(); Object.assign(current.state, change);
  await assert.rejects(current.run());
  assert.equal(current.calls.includes('leaky-sign'), false);
  assert.equal(current.calls.includes('simulate'), false);
  assert.equal(current.calls.includes('broadcast'), false);
});

for (const field of ['simulationFailure', 'simulationError']) test(`${field} surfaces node reason while blocking Algorand signing and broadcast`, async () => {
  const current = fixture(); current.state[field] = true;
  await assert.rejects(current.run(), error => /revealing signature/.test(error.message) &&
    (field === 'simulationFailure' ? /Node: rejected.*Failure path \(zero-based\): 1/.test(error.message) : /Node: node request rejected/.test(error.message)));
  assert.equal(current.calls.includes('algo-sign'), false);
  assert.equal(current.calls.includes('broadcast'), false);
  assert.equal(current.errors.length, 1);
  const [label, details, exception] = current.errors[0];
  assert.equal(details.txId, current.group()[1].txn.txID());
  assert.equal(details.appId, '42');
  assert.equal(details.action, 'claim');
  if (field === 'simulationFailure') {
    assert.equal(label, 'Settlement simulation rejected');
    assert.equal(details.failureMessage, 'rejected');
    assert.deepEqual(Array.from(details.failedAt), [1]);
    assert.equal(exception, undefined);
  } else {
    assert.equal(label, 'Settlement simulation request failed');
    assert.match(exception.stack, /node request rejected/);
  }
  assert.equal(JSON.stringify(current.errors).includes(Buffer.from(current.group()[1].txn.applicationCall.appArgs[1]).toString('hex')), false);
});

for (const field of ['simulationFailure', 'simulationError']) test(`${field} redacts encoded payloads and bounds displayed node text`, async () => {
  const current = fixture();
  current.state[field] = true;
  const hexPayload = 'ab'.repeat(64);
  const base64Payload = Buffer.alloc(128, 1).toString('base64');
  current.state.nodeMessage = `assert failed pc=975\n${hexPayload} ${base64Payload} ${'node detail '.repeat(200)}`;
  await assert.rejects(current.run(), error => {
    assert.match(error.message, /Node: assert failed pc=975/);
    assert.match(error.message, /\[redacted data\]/);
    assert.equal(error.message.includes(hexPayload), false);
    assert.equal(error.message.includes(base64Payload), false);
    assert.equal(error.message.includes('\n'), false);
    assert.ok(error.message.length < 1600);
    assert.match(error.message, /Reference: [A-Z2-7]{52}/);
    return true;
  });
  assert.equal(current.calls.includes('algo-sign'), false);
  assert.equal(current.calls.includes('broadcast'), false);
});

test('claim fee is eight times the node minimum transaction fee', async () => {
  const current = fixture(); current.state.minFee = 2000n;
  await current.run();
  assert.equal(current.group()[1].txn.fee, 16000n);
  assert.equal(current.group()[0].txn.fee, 0n);
});

test('dynamic claim fee increases the required sponsor reserve', async () => {
  const current = fixture(); current.state.minFee = 2000n; current.state.sponsorBalance = 108000n;
  await assert.rejects(current.run(), /underfunded by 8000 microALGO/);
  assert.equal(current.calls.includes('leaky-sign'), false);
});

for (const minFee of [undefined, 0n, -1n, 1000]) test(`invalid node minimum fee ${minFee} fails before disclosure`, async () => {
  const current = fixture(); current.state.minFee = minFee;
  await assert.rejects(current.run(), /minimum transaction fee is unavailable/);
  assert.equal(current.calls.includes('leaky-sign'), false);
});

test('dynamic claim fee cannot bypass the signing fee safety ceiling', async () => {
  const current = fixture(); current.state.minFee = 3000n;
  await assert.rejects(current.run(), /unusually high fee/);
  assert.equal(current.calls.includes('leaky-sign'), false);
});

test('legacy sponsor balance requires an explicit 1000 microALGO top-up before key disclosure', async () => {
  const current = fixture(); current.state.sponsorBalance = 107000n;
  await assert.rejects(current.run(), /underfunded by 1000 microALGO.*Top up sponsor.*No swap key was disclosed/);
  assert.equal(current.calls.includes('leaky-sign'), false);
  assert.equal(current.calls.includes('simulate'), false);
});

test('claim accepts an exactly funded 108000 microALGO sponsor', async () => {
  const current = fixture(); current.state.sponsorBalance = 108000n;
  assert.equal((await current.run()).confirmedRound, '2');
});

test('node transaction dumps are excluded from the displayed rejection', async () => {
  const current = fixture(); current.state.simulationFailure = true;
  current.state.nodeMessage = 'group fee 0.0A too small (needs 1mA more) []transactions.SignedTxnWithAD{private dump}';
  await assert.rejects(current.run(), error => /needs 1mA more/.test(error.message) && !/private dump|SignedTxnWithAD/.test(error.message));
});

test('storage failure blocks simulation and broadcasting', async () => {
  const current = fixture(); current.state.journalError = true;
  await assert.rejects(current.run(), /Storage unavailable/);
  assert.equal(current.calls.includes('simulate'), false);
  assert.equal(current.calls.includes('broadcast'), false);
});

test('uncertain relay returns a transaction reference, never signed bytes or signature', async () => {
  const current = fixture(); current.state.submitError = true;
  await assert.rejects(current.run(), /confirmation is uncertain\. Node: lost response.*[A-Z2-7]{52}/);
  assert.equal(current.errors[0][0], 'Settlement submission or confirmation failed');
  assert.match(current.errors[0][2].stack, /lost response/);
});

test('closing approval during simulation prevents signing and broadcast', async () => {
  const current = fixture(); current.state.cancelAfterSimulation = true;
  await assert.rejects(current.run(), /Settlement cancelled/);
  assert.equal(current.calls.includes('algo-sign'), false);
  assert.equal(current.calls.includes('broadcast'), false);
});

for (const change of [{ ready: 1n }, { ready: 0n, t0: 99999 }]) test('refund preflight rejects readiness or expiry before key disclosure', async () => {
  const current = fixture('refund'); Object.assign(current.state, change);
  await assert.rejects(current.run(), /readiness or deadline|deadline passed during approval/);
  assert.equal(current.calls.includes('leaky-sign'), false);
});

test('unsolicited escrow dust does not prevent wallet-owned settlement', async () => {
  const current = fixture(); current.state.balance++;
  assert.equal((await current.run()).confirmedRound, '2');
});

test('refund deadline crossing during simulation prevents signing and broadcast', async () => {
  const current = fixture('refund'); current.state.ready = 0n; current.state.expireAfterSimulation = true;
  await assert.rejects(current.run(), /deadline passed during approval/);
  assert.equal(current.calls.includes('algo-sign'), false);
  assert.equal(current.calls.includes('broadcast'), false);
});

test('a wall clock jump during simulation cannot expire a round-based refund', async () => {
  const current = fixture('refund'); current.state.ready = 0n; current.state.clockJumpAfterSimulation = true;
  assert.equal((await current.run()).confirmedRound, '2');
});

for (const action of ['claim', 'refund']) test(`legacy timestamp ${action} is rejected before disclosure`, async () => {
  const current = fixture(action, true);
  if (action === 'refund') { current.state.ready = 0n; current.state.timestamp = current.state.t0; }
  current.state.clockJumpAfterSimulation = true;
  await assert.rejects(current.run(), /Legacy timestamp/);
  assert.deepEqual(current.calls, ['verify']);
});

test('legacy claim after t0 is still unsupported', async () => {
  const current = fixture('claim', true);
  current.state.ready = 0n;
  current.state.timestamp = current.state.t0 + 1;
  await assert.rejects(current.run(), /Legacy timestamp/);
});

for (const [name, action, change] of [
  ['premature claim at t0', 'claim', state => { state.ready = 0n; state.timestamp = state.t0; }],
  ['expired claim at t1', 'claim', state => { state.timestamp = state.t1; }],
  ['expired refund after t0', 'refund', state => { state.ready = 0n; state.timestamp = state.t0 + 1; }],
  ['ready refund', 'refund', () => {}],
  ['unavailable timestamp', 'claim', state => { state.timestamp = undefined; }],
  ['invalid timestamp', 'claim', state => { state.timestamp = NaN; }],
  ['unavailable block', 'claim', state => { state.blockError = true; }],
  ['round programs with timestamp offer', 'claim', state => Object.assign(state, programs(canonical))],
  ['modified approval', 'claim', state => { state.approvalProgram[0] ^= 1; }],
  ['modified clear', 'claim', state => { state.clearStateProgram[0] ^= 1; }],
]) test(`legacy ${name} fails before leakySign`, async () => {
  const current = fixture(action, true);
  change(current.state);
  await assert.rejects(current.run());
  assert.equal(current.calls.includes('leaky-sign'), false);
  assert.equal(current.calls.includes('simulate'), false);
  assert.equal(current.calls.includes('algo-sign'), false);
});

test('unsupported programs with round metadata fail before leakySign', async () => {
  const current = fixture();
  current.state.approvalProgram[0] ^= 1;
  await assert.rejects(current.run(), /supported LeakSwap protocol/);
  assert.equal(current.calls.includes('leaky-sign'), false);
});

test('legacy refund is rejected before simulation', async () => {
  const current = fixture('refund', true);
  current.state.ready = 0n;
  current.state.expireAfterSimulation = true;
  await assert.rejects(current.run(), /Legacy timestamp/);
  assert.equal(current.calls.includes('simulate'), false);
  assert.equal(current.calls.includes('algo-sign'), false);
  assert.equal(current.calls.includes('broadcast'), false);
});
