import algosdk from 'algosdk';
import { browser } from 'wxt/browser';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getNetworkSettings } from '../network/networkStore';
import { verifyAlgorandGenesis } from '../network/chainIdentity';
import { bytesToBase64, base64ToBytes } from '../provider/base64';
import { swapOrigin } from '../provider/swapOrigin.ts';
import type { ZebgenSavedLeakSwap, ZebgenSaveLeakSwapParams } from '../provider/types';
import { deriveActiveSeedAlgoAddressAtIndex } from './algoWallet';
import {
  getMoneroWalletState,
  loadMoneroCombinedContext,
  saveMoneroCombinedContext,
  unlockMoneroWallet,
} from './moneroVault';
import {
  computeCombinedAddressWithPrivateAndPublic,
  combinePrivateSpendKeys,
} from './moneroWallet';
import { scanMoneroFunding, type MoneroFundingControl } from '../monero/moneroDaemon';
import { loadAcceptedSwap, resolveSwapWalletId } from './swapHandshakeVault';
import { assertAgreementState } from 'leakswap-utils/dist/swapAgreement.js';
import {
  checkAgreementTransaction,
  checkAgreementEscrowPayment,
  checkAgreementSponsorPayment,
  assertSafeSigningRequest,
} from './swapAgreementTransactions';
import type { ZebgenSignAlgorandTransactionsParams } from '../provider/types';
import { agreementSponsorAddress, assertAgreementPrograms } from './swapAgreementArtifact';
import {
  listSignedTransactions,
  listSwapRecords,
  saveSignedTransactions,
  saveSwapRecord,
  swapRecordKey,
  type SignedTransactionRecord,
  type SwapRecord,
} from './swapRecords';
import { decryptSeed, encryptSeed } from './seedVault';
import {
  reserveAgreementUse,
  type AgreementUse,
  type AgreementUseIdentity,
} from './swapAgreementUse';
import { verifiedSwapSettlement } from './swapSettlement';
import { assertSwapFundingTime } from './swapTimingPolicy';
import { assertRoundDeadlines } from 'leakswap-utils/dist/swapTiming.js';

async function reserveUse(
  identity: AgreementUseIdentity,
  use: AgreementUse,
  secret: string,
): Promise<void> {
  await reserveAgreementUse(
    {
      withLock: async (action) => await navigator.locks.request('leakswap-agreement-use', action),
      read: async (key) => {
        const envelope = (await browser.storage.local.get(key))[key];
        if (envelope === undefined) return null;
        const encrypted = envelope as {
          version: number;
          ciphertext: number[];
          salt: number[];
          iv: number[];
        };
        const bytes = (value: unknown): value is number[] =>
          Array.isArray(value) &&
          value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
        if (
          !encrypted ||
          encrypted.version !== 1 ||
          !bytes(encrypted.ciphertext) ||
          encrypted.ciphertext.length < 16 ||
          !bytes(encrypted.salt) ||
          encrypted.salt.length !== 16 ||
          !bytes(encrypted.iv) ||
          encrypted.iv.length !== 12
        ) {
          throw new Error('Invalid encrypted agreement use record.');
        }
        const plaintext = await decryptSeed(
          new Uint8Array(encrypted.ciphertext).buffer,
          secret,
          new Uint8Array(encrypted.salt),
          new Uint8Array(encrypted.iv),
        );
        try {
          return JSON.parse(new TextDecoder().decode(plaintext));
        } finally {
          plaintext.fill(0);
        }
      },
      write: async (key, record) => {
        const plaintext = new TextEncoder().encode(JSON.stringify(record));
        try {
          const encrypted = await encryptSeed(plaintext, secret);
          await browser.storage.local.set({
            [key]: {
              version: 1,
              ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
              salt: Array.from(encrypted.salt),
              iv: Array.from(encrypted.iv),
            },
          });
        } finally {
          plaintext.fill(0);
        }
      },
      savedAppIds: async (binding) =>
        (await listSwapRecords(browser.storage.local, secret))
          .filter(
            (record) =>
              record.genesisHash === binding.genesisHash &&
              record.agreementDigest === binding.digest,
          )
          .map((record) => record.appId),
    },
    identity,
    use,
  );
}

async function chain() {
  const settings = await getNetworkSettings();
  const endpoint = settings.algorand.algod;
  const algod = new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port);
  const params = await algod.getTransactionParams().do();
  verifyAlgorandGenesis(settings.algorand.network, params.genesisID ?? '', endpoint.server);
  if (!params.genesisHash) throw new Error('Algod did not return its genesis hash.');
  return { settings, algod, genesisHash: bytesToBase64(params.genesisHash) };
}

export async function saveVerifiedLeakSwap(
  params: ZebgenSaveLeakSwapParams,
  secret: string,
  origin?: string,
): Promise<{ appId: string }> {
  if (!params.agreementDigest)
    throw new Error('A signed round-based agreement is required to save a swap.');
  const { settings, algod, genesisHash } = await chain();
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  const walletId = await resolveSwapWalletId(params.agreementDigest, secret);
  if (walletId === null) throw new Error('Open the original Monero wallet first.');
  const context = await loadMoneroCombinedContext(
    { walletId, network: settings.monero.network, combinedAddress: params.combinedAddress },
    secret,
  );
  if (!context) throw new Error('Compute and save the combined address before saving this swap.');
  const owner = await unlockMoneroWallet(secret, settings.monero.networkType, walletId);
  if (!owner) throw new Error('Original Monero wallet is unavailable.');
  if (params.settlementTxId) {
    const records = (await listSwapRecords(browser.storage.local, secret)).filter(
      (record) =>
        record.genesisHash === genesisHash &&
        record.appId === params.appId &&
        record.algoAddress === algoAddress &&
        record.context.walletId === walletId &&
        record.context.network === settings.monero.network &&
        record.context.combinedAddress === params.combinedAddress &&
        record.agreementDigest === params.agreementDigest,
    );
    if (records.length !== 1)
      throw new Error('A matching saved swap is required before recording settlement.');
    const pending = await algod.pendingTransactionInformation(params.settlementTxId).do();
    const settlement = verifiedSwapSettlement(
      pending.txn.txn,
      pending.confirmedRound ?? 0n,
      params.settlementTxId,
      records[0],
      owner.publicSpendKey,
    );
    await navigator.locks.request(swapRecordKey(records[0]), () =>
      saveSwapRecord(browser.storage.local, { ...records[0], settlement }, secret),
    );
    return { appId: params.appId };
  }
  const app = await algod.getApplicationByID(BigInt(params.appId)).do();
  const state = app.params?.globalState ?? [];
  const value = (name: string) => {
    const entry = state.find((entry) => new TextDecoder().decode(entry.key) === name);
    if (!entry) throw new Error(`Swap is missing ${name}.`);
    return entry.value;
  };
  const aliAddress = algosdk.encodeAddress(value('aliAlgoAddr').bytes);
  const xinAddress = algosdk.encodeAddress(value('xinAlgoAddr').bytes);
  const role = algoAddress === aliAddress ? 'ali' : algoAddress === xinAddress ? 'xin' : null;
  if (!role) throw new Error('This Algorand wallet is not a party to the swap.');
  if (
    bytesToHex(value(role === 'ali' ? 'aliXternalPK' : 'xinXternalPK').bytes) !==
      owner.publicSpendKey ||
    bytesToHex(value(role === 'ali' ? 'xinXternalPK' : 'aliXternalPK').bytes) !==
      context.counterpartyPublicSpendKey
  ) {
    throw new Error('On-chain Monero keys do not match the saved combined address.');
  }
  const agreement = await verifyAgreementApplication(
    params.agreementDigest,
    BigInt(params.appId),
    secret,
  );
  assertRoundDeadlines(agreement.offer.payload);
  const record: SwapRecord = {
    ...(origin ? { origin } : {}),
    version: 1,
    genesisHash,
    appId: params.appId,
    appAddress: algosdk.getApplicationAddress(BigInt(params.appId)).toString(),
    role,
    algoAddress,
    aliAddress,
    xinAddress,
    t0: Number(value('t0').uint),
    t1: Number(value('t1').uint),
    context,
    deadlineUnit: 'round',
    createdRound: agreement.offer.payload.createdRound,
  };
  if (params.agreementDigest) {
    if (agreement.offer.payload.algoGenesisHash !== genesisHash)
      throw new Error('Saved swap genesis does not match the agreement.');
    const counterpartyView =
      role === 'ali'
        ? agreement.acceptance.payload.xinPrivateViewKey
        : agreement.offer.payload.aliPrivateViewKey;
    if (context.counterpartyPrivateViewKey !== counterpartyView)
      throw new Error('Combined view key does not match the authenticated agreement.');
    record.context = {
      ...context,
      restoreHeight: Math.min(
        context.restoreHeight ?? 0,
        agreement.offer.payload.moneroRestoreHeight ?? 0,
      ),
    };
    await saveMoneroCombinedContext(record.context, secret);
    if (role === 'xin') {
      const escrow = await algod
        .accountInformation(algosdk.getApplicationAddress(BigInt(params.appId)))
        .do();
      if (escrow.amount < BigInt(agreement.offer.payload.algoAmount))
        throw new Error('Escrow balance is below the authenticated ALGO amount.');
    }
    record.agreementDigest = params.agreementDigest;
  }
  await navigator.locks.request(swapRecordKey(record), () =>
    saveSwapRecord(browser.storage.local, record, secret),
  );
  return { appId: params.appId };
}

const METHODS = [
  'setReady(pay)void',
  'leakyClaim(byte[],pay)void',
  'leakyRefund(byte[],pay)void',
  'punishRefund(pay)void',
];

export async function verifyAgreementApplication(digest: string, appId: bigint, secret: string) {
  const agreement = await loadAcceptedSwap(digest, secret);
  const { settings, algod, genesisHash } = await chain();
  assertRoundDeadlines(agreement.offer.payload);
  const app = await algod.getApplicationByID(appId).do();
  if (!app.params) throw new Error('Swap application is unavailable.');
  assertAgreementPrograms(app.params.approvalProgram, app.params.clearStateProgram);
  const globals = app.params?.globalState ?? [];
  const value = (name: string) => {
    const entry = globals.find((entry) => new TextDecoder().decode(entry.key) === name);
    if (!entry) throw new Error(`Swap is missing ${name}.`);
    return entry.value;
  };
  assertAgreementState(agreement, {
    deadlineUnit: agreement.offer.payload.deadlineUnit,
    genesisHash,
    moneroNetwork: settings.monero.network,
    aliAddress: algosdk.encodeAddress(value('aliAlgoAddr').bytes),
    xinAddress: algosdk.encodeAddress(value('xinAlgoAddr').bytes),
    aliPublicSpendKey: bytesToHex(value('aliXternalPK').bytes),
    xinPublicSpendKey: bytesToHex(value('xinXternalPK').bytes),
    t0: Number(value('t0').uint),
    t1: Number(value('t1').uint),
  });
  await reserveUse({ genesisHash, digest }, { appId: appId.toString() }, secret);
  return agreement;
}

export async function validateAgreementSigning(
  params: ZebgenSignAlgorandTransactionsParams,
  secret: string,
  control?: MoneroFundingControl,
): Promise<void> {
  const txns = params.txns.map((bytes) => algosdk.decodeUnsignedTransaction(base64ToBytes(bytes)));
  assertSafeSigningRequest(txns, params.indexesToSign);
  const records = await listSwapRecords(browser.storage.local, secret);
  const bindings = records.filter(
    (record) =>
      record.agreementDigest &&
      txns.some(
        (txn) =>
          bytesToBase64(txn.genesisHash ?? new Uint8Array()) === record.genesisHash &&
          (txn.applicationCall?.appIndex === BigInt(record.appId) ||
            txn.payment?.receiver.toString() === record.appAddress),
      ),
  );
  const digests = new Set(bindings.map((record) => record.agreementDigest!));
  if (
    digests.size > 1 ||
    (params.agreementDigest && digests.size && !digests.has(params.agreementDigest))
  )
    throw new Error('Conflicting saved agreement binding.');
  const digest = params.agreementDigest ?? bindings[0]?.agreementDigest;
  if (!digest) return;
  if ((params.addressIndex ?? 0) !== 0) throw new Error('Agreement signing requires account zero.');
  const agreement = await loadAcceptedSwap(digest, secret);
  const settings = await getNetworkSettings();
  for (const index of params.indexesToSign)
    checkAgreementTransaction(txns[index], agreement, settings.monero.network);
  const creates = txns.filter((txn) => txn.applicationCall?.appIndex === 0n);
  if (creates.length) {
    if (
      txns.length !== 1 ||
      creates[0].applicationCall?.onComplete !== algosdk.OnApplicationComplete.NoOpOC ||
      params.indexesToSign.length !== 1 ||
      params.indexesToSign[0] !== 0
    )
      throw new Error('Invalid agreement deployment.');
    assertAgreementPrograms(
      creates[0].applicationCall!.approvalProgram!,
      creates[0].applicationCall!.clearProgram!,
    );
    const { algod } = await chain();
    assertSwapFundingTime(agreement.offer.payload, Number((await algod.status().do()).lastRound));
    await reserveUse(
      { genesisHash: agreement.offer.payload.algoGenesisHash, digest },
      { deploymentTxId: creates[0].txID() },
      secret,
    );
    return;
  }
  const appIdText = params.agreementAppId ?? bindings[0]?.appId;
  if (!appIdText || !/^[1-9][0-9]*$/.test(appIdText))
    throw new Error('Agreement application ID is required.');
  const appId = BigInt(appIdText);
  if (bindings.some((record) => record.appId !== appIdText))
    throw new Error('Application ID conflicts with the saved agreement binding.');
  await verifyAgreementApplication(digest, appId, secret);
  const { algod } = await chain();
  const sponsor = agreementSponsorAddress(appId, agreement);
  const calls = txns.filter((txn) => txn.applicationCall);
  if (calls.length) {
    if (
      txns.length !== 2 ||
      calls.length !== 1 ||
      txns[1] !== calls[0] ||
      calls[0].applicationCall!.appIndex !== appId ||
      txns[0].sender.toString() !== sponsor ||
      !txns[0].payment ||
      txns[0].rekeyTo ||
      params.indexesToSign.length !== 1 ||
      params.indexesToSign[0] !== 1
    )
      throw new Error('Unexpected sponsored agreement group.');
    const selector = bytesToHex(calls[0].applicationCall!.appArgs[0]);
    if (
      !METHODS.some(
        (method) => bytesToHex(algosdk.ABIMethod.fromSignature(method).getSelector()) === selector,
      )
    )
      throw new Error('Unexpected agreement method.');
    const ready =
      selector === bytesToHex(algosdk.ABIMethod.fromSignature(METHODS[0]).getSelector());
    const claim =
      selector === bytesToHex(algosdk.ABIMethod.fromSignature(METHODS[1]).getSelector());
    const leaky =
      claim || selector === bytesToHex(algosdk.ABIMethod.fromSignature(METHODS[2]).getSelector());
    if (ready || claim) {
      const escrow = await algod.accountInformation(algosdk.getApplicationAddress(appId)).do();
      // Anyone can add ALGO to the escrow, and the contract pays out all of it, so only a shortfall blocks signing.
      if (escrow.amount < BigInt(agreement.offer.payload.algoAmount))
        throw new Error('Escrow balance is below the authenticated ALGO amount.');
    }
    if (leaky)
      throw new Error(
        'Agreement claim and refund must use settleLeakSwap; generic signing is disabled.',
      );
    if (ready) {
      const owner = agreement.offer.payload;
      const currentRound = Number((await algod.status().do()).lastRound);
      if (
        !Number.isSafeInteger(currentRound) ||
        currentRound < owner.createdRound! ||
        currentRound > owner.t0
      )
        throw new Error('Readiness deadline has passed or the node round is invalid.');
      const counterparty = agreement.acceptance.payload;
      const walletId = await resolveSwapWalletId(digest, secret);
      if (walletId === null) throw new Error('Original Monero wallet is unavailable.');
      const material = await unlockMoneroWallet(secret, settings.monero.networkType, walletId);
      if (!material || material.publicSpendKey !== owner.aliPublicSpendKey)
        throw new Error('Only Ali may set the agreement ready.');
      const combined = computeCombinedAddressWithPrivateAndPublic(
        material.privateSpendKey,
        owner.aliPrivateViewKey,
        counterparty.xinPrivateViewKey,
        counterparty.xinPublicSpendKey,
        settings.monero.networkType,
      );
      const funding = await scanMoneroFunding(
        settings.monero,
        combined.combinedPublicSpendKey,
        combinePrivateSpendKeys(owner.aliPrivateViewKey, counterparty.xinPrivateViewKey),
        owner.moneroRestoreHeight ?? 0,
        control,
      );
      if (BigInt(funding.matureAtomic) < BigInt(owner.xmrAmount))
        throw new Error('Mature Monero funding is below the authenticated amount.');
      const checkedRound = Number((await algod.status().do()).lastRound);
      if (
        !Number.isSafeInteger(checkedRound) ||
        checkedRound < currentRound ||
        checkedRound > owner.t0
      )
        throw new Error('Readiness deadline has passed or the node round is invalid.');
    }
  } else {
    if (txns.length !== 2 || txns.some((txn) => !txn.payment))
      throw new Error('Expected atomic escrow and sponsor funding.');
    checkAgreementEscrowPayment(txns[0], agreement, appId);
    checkAgreementSponsorPayment(txns[1], agreement, sponsor);
    const escrow = await algod.accountInformation(algosdk.getApplicationAddress(appId)).do();
    if (escrow.amount >= BigInt(agreement.offer.payload.algoAmount))
      throw new Error('Escrow is already funded. Check the chain before retrying.');
    const status = await algod.status().do();
    assertSwapFundingTime(agreement.offer.payload, Number(status.lastRound));
  }
}

export async function listVerifiedLeakSwaps(
  secret: string,
  origin?: string,
): Promise<{ swaps: ZebgenSavedLeakSwap[] }> {
  const requestedOrigin = origin === undefined ? undefined : swapOrigin(origin);
  const { settings, genesisHash, algod } = await chain();
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  const walletId = (await getMoneroWalletState()).activeWalletId;
  const records = (await listSwapRecords(browser.storage.local, secret)).filter(
    (record) =>
      (requestedOrigin === undefined || swapOrigin(record.origin) === requestedOrigin) &&
      record.genesisHash === genesisHash &&
      record.algoAddress === algoAddress &&
      (record.context.walletId === walletId || record.context.walletId < 0) &&
      record.context.network === settings.monero.network,
  );
  const journal = records.length ? await listSignedTransactions(browser.storage.local, secret) : [];
  const swaps: ZebgenSavedLeakSwap[] = [];
  for (const record of records) {
    const context = await loadMoneroCombinedContext(record.context, secret);
    const owner = await unlockMoneroWallet(
      secret,
      settings.monero.networkType,
      record.context.walletId,
    );
    if (!context || !owner)
      throw new Error('Saved swap original wallet or scan context is unavailable.');
    const combined = computeCombinedAddressWithPrivateAndPublic(
      owner.privateSpendKey,
      owner.privateViewKey,
      context.counterpartyPrivateViewKey,
      context.counterpartyPublicSpendKey,
      settings.monero.networkType,
    );
    const signedTransactions = journal
      .filter((entry) => entry.genesisHash === genesisHash && entry.sender === algoAddress)
      .flatMap((entry) => {
        const txn = algosdk.decodeUnsignedTransaction(base64ToBytes(entry.unsignedTransaction));
        if (
          txn.applicationCall?.appIndex !== BigInt(record.appId) &&
          txn.payment?.receiver.toString() !== record.appAddress
        )
          return [];
        const selector = txn.applicationCall?.appArgs[0];
        const method = METHODS.find(
          (signature) =>
            selector &&
            bytesToHex(algosdk.ABIMethod.fromSignature(signature).getSelector()) ===
              bytesToHex(selector),
        );
        return [{ txId: entry.txId, method: method?.split('(')[0] ?? null }];
      });
    if (!record.settlement) {
      for (const candidate of signedTransactions.filter((entry) =>
        ['leakyClaim', 'leakyRefund', 'punishRefund'].includes(entry.method ?? ''),
      )) {
        try {
          const pending = await algod.pendingTransactionInformation(candidate.txId).do();
          if (!pending.confirmedRound) continue;
          const settlement = verifiedSwapSettlement(
            pending.txn.txn,
            pending.confirmedRound,
            candidate.txId,
            record,
            owner.publicSpendKey,
          );
          await navigator.locks.request(swapRecordKey(record), () =>
            saveSwapRecord(browser.storage.local, { ...record, settlement }, secret),
          );
          record.settlement = settlement;
          break;
        } catch (error) {
          console.error('Unable to reconcile saved LeakSwap settlement', candidate.txId, error);
        }
      }
    }
    swaps.push({
      ...(record.origin ? { origin: record.origin } : {}),
      appId: record.appId,
      appAddress: record.appAddress,
      genesisHash,
      role: record.role,
      algoAddress,
      counterpartyAlgoAddress: record.role === 'ali' ? record.xinAddress : record.aliAddress,
      t0: record.t0,
      t1: record.t1,
      restoreHeight: context.restoreHeight,
      deadlineUnit: record.deadlineUnit,
      createdRound: record.createdRound,
      counterpartyPublicSpendKey: context.counterpartyPublicSpendKey,
      counterpartyPrivateViewKey: context.counterpartyPrivateViewKey,
      shareInfo: {
        address: owner.address,
        publicSpendKey: owner.publicSpendKey,
        privateViewKey: owner.privateViewKey,
      },
      combined,
      signedTransactions,
      ...(record.agreementDigest
        ? { agreement: await loadAcceptedSwap(record.agreementDigest, secret) }
        : {}),
      ...(record.settlement ? { settlement: record.settlement } : {}),
    });
  }
  return { swaps };
}

export async function journalSignedAlgorandTransactions(
  txns: Uint8Array[],
  origin: string,
  secret: string,
): Promise<void> {
  const records: SignedTransactionRecord[] = txns.map((bytes) => {
    const txn = algosdk.decodeUnsignedTransaction(bytes);
    if (!txn.genesisHash) throw new Error('Cannot journal a transaction without a genesis hash.');
    return {
      version: 1,
      genesisHash: bytesToBase64(txn.genesisHash),
      txId: txn.txID(),
      sender: txn.sender.toString(),
      origin,
      firstValid: txn.firstValid.toString(),
      lastValid: txn.lastValid.toString(),
      unsignedTransaction: bytesToBase64(bytes),
      signedAt: new Date().toISOString(),
    };
  });
  await saveSignedTransactions(browser.storage.local, records, secret);
}
