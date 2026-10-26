import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import algosdk from 'algosdk';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { assembleTeal } from '../lib/wallet/tealAssembler.ts';
import { leakySign } from '../lib/wallet/leakySign.ts';
import { validateProviderRequest } from '../lib/provider/fundingValidation.ts';
import { assertSafeSigningRequest, checkAgreementTransaction } from '../lib/wallet/swapAgreementTransactions.ts';
import { assertAgreementState } from 'leakswap-utils/dist/swapAgreement.js';

const algod = new algosdk.Algodv2('a'.repeat(64), 'http://127.0.0.1', 4001);
const kmd = new algosdk.Kmd('a'.repeat(64), 'http://127.0.0.1', 4002);
const artifact = JSON.parse(readFileSync(new URL('../lib/contracts/LeakSwap.arc56.json', import.meta.url), 'utf8'));
const template = readFileSync(new URL('../lib/contracts/FeeSponsorLSig.teal', import.meta.url), 'utf8');
const code = ts.transpileModule(readFileSync(new URL('../lib/wallet/settleLeakSwap.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const wallets = await kmd.listWallets();
const wallet = wallets.wallets.find(wallet => wallet.name === 'unencrypted-default-wallet');
assert.ok(wallet, 'LocalNet dispenser wallet required');
const { wallet_handle_token: handle } = await kmd.initWalletHandle(wallet.id, '');
try {
  const { addresses } = await kmd.listKeys(handle);
  const balances = await Promise.all(addresses.map(async address => ({ address, amount: (await algod.accountInformation(address).do()).amount })));
  const dispenserAddress = balances.sort((left, right) => left.amount > right.amount ? -1 : 1)[0].address;
  const { private_key: dispenserKey } = await kmd.exportKey(handle, '', dispenserAddress);
  const pay = async (sender, sk, receiver, amount) => {
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender, receiver, amount,
      suggestedParams: await algod.getTransactionParams().do() });
    await algod.sendRawTransaction(txn.signTxn(sk)).do();
    await algosdk.waitForConfirmation(algod, txn.txID(), 4);
  };
  for (const action of ['claim', 'refund']) {
    const ali = algosdk.generateAccount();
    const xin = algosdk.generateAccount();
    await pay(dispenserAddress, dispenserKey, ali.addr, 10000000n);
    const timestamp = Number((await algod.block((await algod.status().do()).lastRound).do()).block.header.timestamp);
    const t0 = Math.max(timestamp, Math.floor(Date.now() / 1000)) + 3600;
    const t1 = t0 + 3600;
    const aliScalar = new Uint8Array(32); aliScalar[0] = 11;
    const xinScalar = new Uint8Array(32); xinScalar[0] = 22;
    const aliKey = ed25519.Point.BASE.multiply(11n).toBytes();
    const xinKey = ed25519.Point.BASE.multiply(22n).toBytes();
    const params = await algod.getTransactionParams().do();
    const agreement = { offer: { payload: { aliAlgoAddress: ali.addr.toString(), aliPublicSpendKey: bytesToHex(aliKey),
      t0, t1, algoAmount: '5000000', moneroNetwork: 'regtest', algoGenesisHash: Buffer.from(params.genesisHash).toString('base64') } },
      acceptance: { payload: { xinAlgoAddress: xin.addr.toString(), xinPublicSpendKey: bytesToHex(xinKey) } } };
    const signer = async (group, indexes) => indexes.map(index => group[index].signTxn(ali.sk));
    const composer = new algosdk.AtomicTransactionComposer();
    composer.addMethodCall({ appID: 0n, sender: ali.addr, suggestedParams: params,
      method: algosdk.ABIMethod.fromSignature('createApplication(byte[],account,byte[],uint64,uint64)void'),
      methodArgs: [aliKey, xin.addr, xinKey, BigInt(t0), BigInt(t1)],
      approvalProgram: new Uint8Array(Buffer.from(artifact.byteCode.approval, 'base64')),
      clearProgram: new Uint8Array(Buffer.from(artifact.byteCode.clear, 'base64')),
      numGlobalInts: 3, numGlobalByteSlices: 4, numLocalInts: 0, numLocalByteSlices: 0, signer });
    const deployed = await composer.execute(algod, 4);
    const appId = (await algod.pendingTransactionInformation(deployed.txIDs[0]).do()).applicationIndex;
    assert.ok(appId);
    const values = { TMPL_APP_ID: appId.toString(), TMPL_ALI_ADDR: `0x${bytesToHex(ali.addr.publicKey)}`, TMPL_XIN_ADDR: `0x${bytesToHex(xin.addr.publicKey)}` };
    const sponsor = new algosdk.LogicSigAccount(assembleTeal(template.replace(/\bTMPL_(?:APP_ID|ALI_ADDR|XIN_ADDR)\b/g, token => values[token])));
    await pay(ali.addr, ali.sk, algosdk.getApplicationAddress(appId), 5000000n);
    await pay(ali.addr, ali.sk, sponsor.address(), 209000n);
    if (action === 'claim') {
      const ready = new algosdk.AtomicTransactionComposer();
      const suggestedParams = await algod.getTransactionParams().do();
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: sponsor.address(), receiver: ali.addr, amount: 102000n,
        suggestedParams: { ...suggestedParams, flatFee: true, fee: 0n } });
      ready.addMethodCall({ appID: appId, sender: ali.addr, method: algosdk.ABIMethod.fromSignature('setReady(pay)void'),
        methodArgs: [{ txn, signer: async (group, indexes) => indexes.map(index => algosdk.signLogicSigTransactionObject(group[index], sponsor).blob) }],
        suggestedParams: { ...suggestedParams, flatFee: true, fee: 2000n }, signer });
      await ready.execute(algod, 4);
    }
    const owner = action === 'claim' ? xin : ali;
    const scalar = action === 'claim' ? xinScalar : aliScalar;
    const settings = { algorand: { network: 'localnet', algod: { server: 'http://127.0.0.1', port: 4001, token: 'a'.repeat(64) } },
      monero: { network: 'regtest', networkType: 'stagenet' } };
    const modules = {
      algosdk, '@noble/hashes/utils.js': { hexToBytes },
      '../network/networkStore': { getNetworkSettings: async () => settings },
      '../network/chainIdentity': { verifyAlgorandGenesis: () => {} },
      '../provider/base64': { bytesToBase64: bytes => Buffer.from(bytes).toString('base64') },
      '../provider/fundingValidation': { validateProviderRequest },
      '../provider/connectionApproval': { assertConnectionAccounts: async () => {} },
      './algoWallet': { deriveActiveSeedAlgoAddressAtIndex: async () => ({ algoAddress: owner.addr.toString() }),
        signRawTransactions: async (_secret, _index, bytes) => bytes.map(bytes => algosdk.decodeUnsignedTransaction(bytes).signTxn(owner.sk)) },
      './swapHandshakeVault': { resolveSwapWalletId: async () => -1 },
      './moneroVault': { unlockMoneroWallet: async () => ({ publicSpendKey: bytesToHex(action === 'claim' ? xinKey : aliKey), privateSpendKey: bytesToHex(scalar) }) },
      './swapRecordVault': { journalSignedAlgorandTransactions: async () => {}, verifyAgreementApplication: async (_digest, actualId) => {
        assert.equal(actualId, appId);
        const app = await algod.getApplicationByID(appId).do();
        assert.equal(Buffer.from(app.params.approvalProgram).toString('base64'), artifact.byteCode.approval);
        assert.equal(Buffer.from(app.params.clearStateProgram).toString('base64'), artifact.byteCode.clear);
        const value = name => app.params.globalState.find(entry => new TextDecoder().decode(entry.key) === name).value;
        assertAgreementState(agreement, { genesisHash: agreement.offer.payload.algoGenesisHash, moneroNetwork: 'regtest',
          aliAddress: algosdk.encodeAddress(value('aliAlgoAddr').bytes), xinAddress: algosdk.encodeAddress(value('xinAlgoAddr').bytes),
          aliPublicSpendKey: bytesToHex(value('aliXternalPK').bytes), xinPublicSpendKey: bytesToHex(value('xinXternalPK').bytes),
          t0: Number(value('t0').uint), t1: Number(value('t1').uint) });
        return agreement;
      } },
      './swapAgreementArtifact': { agreementSponsorLogicSig: () => sponsor },
      './swapAgreementTransactions': { assertSafeSigningRequest, checkAgreementTransaction }, './leakySign': { leakySign },
    };
    const api = {};
    runInNewContext(code, { exports: api, Uint8Array, TextDecoder, Date, console,
      navigator: { locks: { request: async (_key, action) => action() } }, require: name => {
        if (!(name in modules)) throw new Error(name); return modules[name];
      } });
    const result = await api.settleLeakSwap({ agreementDigest: 'ab'.repeat(32), appId: appId.toString(), action }, 'disposable', 'https://app.leakswap.com');
    assert.deepEqual(Object.keys(result).sort(), ['confirmedRound', 'txId']);
    assert.ok(BigInt(result.confirmedRound) > 0n);
    assert.equal((await algod.accountInformation(algosdk.getApplicationAddress(appId)).do()).amount, 0n);
    assert.equal((await algod.accountInformation(sponsor.address()).do()).amount, 0n);
    await assert.rejects(algod.getApplicationByID(appId).do());
    console.log(`PASS real LocalNet wallet-owned ${action}: app ${appId}, transaction ${result.txId}, confirmed ${result.confirmedRound}`);
  }
} finally {
  await kmd.releaseWalletHandle(handle);
}