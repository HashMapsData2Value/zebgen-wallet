import algosdk from 'algosdk';
import { browser } from 'wxt/browser';
import { getNetworkSettings } from '../network/networkStore';
import { verifyAlgorandGenesis } from '../network/chainIdentity';
import { base64ToBytes, bytesToBase64 } from '../provider/base64';
import { deriveActiveSeedAlgoAddressAtIndex } from './algoWallet';
import {
  listSwapRecords,
  loadSettlementEvidence,
  saveSettlementEvidence,
  swapRecordKey,
  type SettlementEvidence,
} from './swapRecords';
import {
  getMoneroWalletState,
  loadMoneroCombinedContext,
  saveMoneroWallet,
  unlockMoneroWallet,
} from './moneroVault';
import { recoverCombinedWallet } from './combinedRecovery';
import { recoverSettlementScalar } from './settlementRecovery';
import { verifiedSwapSettlement } from './swapSettlement';

export interface RecoverLeakSwapParams {
  appId: string;
  settlementTxId?: string;
}
export interface RecoverLeakSwapResult {
  combinedAddress: string;
  settlementTxId: string;
  walletId: number;
}

export async function recoverLeakSwap(
  params: RecoverLeakSwapParams,
  secret: string,
): Promise<RecoverLeakSwapResult> {
  const settings = await getNetworkSettings();
  const endpoint = settings.algorand.algod;
  const algod = new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port);
  const chain = await algod.getTransactionParams().do();
  verifyAlgorandGenesis(settings.algorand.network, chain.genesisID ?? '', endpoint.server);
  if (!chain.genesisHash) throw new Error('Unable to verify Algorand genesis.');
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  const records = (await listSwapRecords(browser.storage.local, secret)).filter(
    (record) =>
      record.appId === params.appId &&
      record.genesisHash === bytesToBase64(chain.genesisHash!) &&
      record.algoAddress === algoAddress &&
      record.context.network === settings.monero.network,
  );
  if (records.length !== 1)
    throw new Error(
      'Open the original Algorand account and load its saved swap before recovering.',
    );
  const record = records[0];
  const context = await loadMoneroCombinedContext(record.context, secret);
  if (!context) throw new Error('Original combined address context is unavailable.');
  const owner = await unlockMoneroWallet(secret, settings.monero.networkType, context.walletId);
  if (!owner) throw new Error('Original Monero wallet is unavailable.');
  const method: 'leakyClaim' | 'leakyRefund' = record.role === 'ali' ? 'leakyClaim' : 'leakyRefund';
  const binding = {
    appId: record.appId,
    genesisHash: base64ToBytes(record.genesisHash),
    sender: record.role === 'ali' ? record.xinAddress : record.aliAddress,
    publicSpendKey: context.counterpartyPublicSpendKey,
    method,
  };
  let found: ({ scalar: string } & SettlementEvidence) | undefined;
  let unavailableReason: string | undefined;
  function inspectSettlement(transaction: algosdk.Transaction, round: bigint) {
    try {
      const settlement = verifiedSwapSettlement(
        transaction,
        round,
        transaction.txID(),
        record,
        owner!.publicSpendKey,
      );
      if (settlement.kind === 'punish') {
        unavailableReason = `Confirmed Punish Refund (${settlement.txId}). No Monero recovery share was revealed; this settlement cannot recover the combined wallet. Retrying your PIN will not change this.`;
      } else if (
        (record.role === 'ali' && settlement.kind === 'refund') ||
        (record.role === 'xin' && settlement.kind === 'claim')
      ) {
        unavailableReason = `Confirmed ${settlement.kind === 'refund' ? 'Leaky Refund' : 'Leaky Claim'} (${settlement.txId}). This reveals your own share, not your counterparty's. Only ${record.role === 'ali' ? 'Xin' : 'Ali'} can recover the combined Monero wallet from this settlement. Your PIN was accepted; retrying it will not change the settlement.`;
      }
    } catch {
      return;
    }
  }
  const savedEvidence = await loadSettlementEvidence(browser.storage.local, record, secret);
  const cached =
    savedEvidence && (!params.settlementTxId || params.settlementTxId === savedEvidence.txId)
      ? savedEvidence
      : null;
  if (cached) {
    const transaction = algosdk.decodeUnsignedTransaction(base64ToBytes(cached.transaction));
    if (transaction.txID() !== cached.txId)
      throw new Error('Saved settlement transaction ID mismatch.');
    found = {
      ...cached,
      scalar: recoverSettlementScalar(transaction, BigInt(cached.confirmedRound), binding),
    };
  }
  let ids: string[];
  if (found) ids = [];
  else if (params.settlementTxId) ids = [params.settlementTxId];
  else {
    const indexerEndpoint = settings.algorand.indexer;
    const indexer = new algosdk.Indexer(
      indexerEndpoint.token,
      indexerEndpoint.server,
      indexerEndpoint.port,
    );
    ids = [];
    let next: string | undefined;
    try {
      do {
        let query = indexer
          .searchForTransactions()
          .applicationID(BigInt(record.appId))
          .txType('appl')
          .limit(100);
        if (next) query = query.nextToken(next);
        const page = await query.do();
        for (const transaction of page.transactions) if (transaction.id) ids.push(transaction.id);
        next = page.nextToken;
        if (ids.length > 1000) throw new Error('Too many history entries.');
      } while (next);
    } catch (error) {
      console.error('LeakSwap settlement history lookup failed', error);
      if (settings.algorand.network !== 'localnet')
        throw new Error(
          'History lookup unavailable. Paste the confirmed claim/refund transaction ID and try again.',
        );
      const status = await algod.status().do();
      const lastRound = status.lastRound;
      const firstRound = lastRound > 2048n ? lastRound - 2047n : 0n;
      for (let round = lastRound; round >= firstRound && !found; round--) {
        const { block } = await algod.block(round).do();
        for (const entry of block.payset) {
          const storedTransaction = entry.signedTxn.signedTxn.txn;
          if (
            !storedTransaction.applicationCall ||
            storedTransaction.applicationCall.appIndex !== BigInt(record.appId)
          )
            continue;
          const encoded = new Map(storedTransaction.toEncodingData());
          if (!storedTransaction.genesisHash) encoded.set('gh', block.header.genesisHash);
          if (entry.hasGenesisID) encoded.set('gen', block.header.genesisID);
          const transaction = algosdk.Transaction.fromEncodingData(encoded);
          inspectSettlement(transaction, round);
          try {
            found = {
              scalar: recoverSettlementScalar(transaction, round, binding),
              txId: transaction.txID(),
              confirmedRound: round.toString(),
              transaction: bytesToBase64(algosdk.encodeUnsignedTransaction(transaction)),
            };
            break;
          } catch {
            continue;
          }
        }
      }
    }
  }
  for (const txId of ids) {
    if (found) break;
    let pending;
    try {
      pending = await algod.pendingTransactionInformation(txId).do();
    } catch (error) {
      if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 404)
        throw error;
      const indexerEndpoint = settings.algorand.indexer;
      const indexer = new algosdk.Indexer(
        indexerEndpoint.token,
        indexerEndpoint.server,
        indexerEndpoint.port,
      );
      const historical = await indexer.lookupTransactionByID(txId).do();
      const round = historical.transaction.confirmedRound;
      if (!round || historical.transaction.id !== txId)
        throw new Error('History did not return the requested confirmed settlement.');
      const { block } = await algod.block(round).do();
      if (bytesToBase64(block.header.genesisHash) !== record.genesisHash)
        throw new Error('Settlement block network mismatch.');
      for (const entry of block.payset) {
        const storedTransaction = entry.signedTxn.signedTxn.txn;
        const encoded = new Map(storedTransaction.toEncodingData());
        if (!storedTransaction.genesisHash) encoded.set('gh', block.header.genesisHash);
        if (entry.hasGenesisID) encoded.set('gen', block.header.genesisID);
        const transaction = algosdk.Transaction.fromEncodingData(encoded);
        if (transaction.txID() === txId) {
          pending = { txn: { txn: transaction }, confirmedRound: round };
          break;
        }
      }
      if (!pending) throw new Error('Confirmed settlement was not found in its reported block.');
    }
    inspectSettlement(pending.txn.txn, pending.confirmedRound ?? 0n);
    if (params.settlementTxId && unavailableReason) throw new Error(unavailableReason);
    try {
      const scalar = recoverSettlementScalar(
        pending.txn.txn,
        pending.confirmedRound ?? 0n,
        binding,
      );
      if (pending.txn.txn.txID() !== txId) throw new Error('Transaction ID mismatch.');
      found = {
        scalar,
        txId,
        confirmedRound: pending.confirmedRound!.toString(),
        transaction: bytesToBase64(algosdk.encodeUnsignedTransaction(pending.txn.txn)),
      };
      break;
    } catch (error) {
      if (params.settlementTxId) throw error;
    }
  }
  if (!found)
    throw new Error(
      unavailableReason ??
        `No confirmed ${method} found. Deletion alone does not prove a recoverable settlement. If the indexer is behind, paste the settlement transaction ID.`,
    );
  const evidence = {
    txId: found.txId,
    confirmedRound: found.confirmedRound,
    transaction: found.transaction,
  };
  await navigator.locks.request(`settlement-evidence:${swapRecordKey(record)}`, () =>
    saveSettlementEvidence(browser.storage.local, record, evidence, secret),
  );
  const material = recoverCombinedWallet(owner, found.scalar, context, settings.monero.networkType);
  const walletId = await navigator.locks.request(
    `recover-leakswap:${settings.monero.network}:${material.address}`,
    async () => {
      const existing = (await getMoneroWalletState()).wallets.find(
        (wallet) => wallet.address === material.address,
      );
      return (
        existing?.id ??
        (await saveMoneroWallet(
          material,
          secret,
          context.restoreHeight ?? 0,
          false,
          context.network,
        ))
      );
    },
  );
  return { combinedAddress: material.address, settlementTxId: found.txId, walletId };
}
