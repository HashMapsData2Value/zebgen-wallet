import { createAlgodClient } from '../algorand/algodClient';
import type { AlgodEndpoint, MoneroNetworkConfig } from '../network/networks';

export type TransactionStatusRequest = { hash: string } & (
  { chain: 'algorand'; endpoint: AlgodEndpoint } | { chain: 'monero'; config: MoneroNetworkConfig });

export interface TransactionStatus {
  state: 'pending' | 'unknown' | 'pool' | 'confirmed' | 'rejected';
  block?: string;
  confirmations?: number;
  detail?: string;
}

export async function readTransactionStatus(request: TransactionStatusRequest): Promise<TransactionStatus> {
  if (request.chain === 'algorand') {
    const pending = await createAlgodClient(request.endpoint).pendingTransactionInformation(request.hash).do();
    if (pending.confirmedRound && pending.confirmedRound > 0n) return { state: 'confirmed', block: pending.confirmedRound.toString() };
    if (pending.poolError) return { state: 'rejected', detail: pending.poolError };
    return { state: 'pending' };
  }
  if (!/^[0-9a-f]{64}$/i.test(request.hash)) throw new Error('Invalid Monero transaction hash.');
  const daemon = request.config.daemon;
  const url = new URL(daemon.uri);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/get_transactions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (daemon.username) headers.Authorization = `Basic ${btoa(`${daemon.username}:${daemon.password ?? ''}`)}`;
  const response = await fetch(url, {
    method: 'POST', headers, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ txs_hashes: [request.hash], decode_as_json: false, prune: true })
  });
  if (!response.ok) throw new Error(`Transaction status unavailable (HTTP ${response.status}).`);
  const result = await response.json() as { status?: string; txs?: { tx_hash: string; in_pool: boolean; block_height?: number; confirmations?: number }[] };
  if (result.status !== 'OK') throw new Error('Daemon could not check transaction status.');
  const transaction = result.txs?.find(entry => entry.tx_hash === request.hash);
  if (!transaction) return { state: 'unknown', detail: 'Not found by this daemon; relay outcome remains unknown.' };
  if (transaction.in_pool) return { state: 'pool', confirmations: 0 };
  if (transaction.in_pool !== false) throw new Error('Daemon returned an invalid pool status.');
  if (!Number.isSafeInteger(transaction.block_height) || transaction.block_height! < 0) throw new Error('Daemon returned an invalid block height.');
  if (transaction.confirmations !== undefined && (!Number.isSafeInteger(transaction.confirmations) || transaction.confirmations < 0)) {
    throw new Error('Daemon returned invalid confirmations.');
  }
  return { state: 'confirmed', block: String(transaction.block_height), confirmations: transaction.confirmations };
}