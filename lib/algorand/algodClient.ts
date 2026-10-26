import algosdk from 'algosdk';

import type { AlgodEndpoint, IndexerEndpoint } from '../network/networks';
import type { AlgorandNetworkId } from '../network/networks';
import { verifyAlgorandGenesis } from '../network/chainIdentity';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAlgodClient(endpoint: AlgodEndpoint): algosdk.Algodv2 {
  return new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port === '' ? '' : endpoint.port);
}

export function createIndexerClient(endpoint: IndexerEndpoint): algosdk.Indexer {
  return new algosdk.Indexer(endpoint.token, endpoint.server, endpoint.port === '' ? '' : endpoint.port);
}

export interface AlgodProbeResult {
  ok: boolean;
  lastRound?: number;
  error?: string;
  network?: string;
  genesisId?: string;
}

export async function probeAlgod(endpoint: AlgodEndpoint, network?: AlgorandNetworkId): Promise<AlgodProbeResult> {
  try {
    const client = createAlgodClient(endpoint);
    const params = await client.getTransactionParams().do();
    if (network) verifyAlgorandGenesis(network, params.genesisID ?? '', endpoint.server);
    const status = await client.status().do();
    return { ok: true, lastRound: Number(status.lastRound), network, genesisId: params.genesisID };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface IndexerProbeResult {
  ok: boolean;
  round?: number;
  version?: string;
  error?: string;
}

export async function probeIndexer(endpoint: IndexerEndpoint): Promise<IndexerProbeResult> {
  try {
    const health = await createIndexerClient(endpoint).makeHealthCheck().do();
    return { ok: true, round: Number(health.round), version: health.version };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface BalanceResult {
  ok: boolean;
  algos?: number;
  spendableAtomic?: string;
  error?: string;
}

export async function getAlgoBalance(
  endpoint: AlgodEndpoint,
  address: string,
  network?: AlgorandNetworkId
): Promise<BalanceResult> {
  try {
    if (network) {
      const params = await createAlgodClient(endpoint).getTransactionParams().do();
      verifyAlgorandGenesis(network, params.genesisID ?? '', endpoint.server);
    }
    const info = await createAlgodClient(endpoint).accountInformation(address).do();
    const available = info.amount > info.minBalance ? info.amount - info.minBalance : 0n;
    return { ok: true, algos: Number(info.amount) / 1e6, spendableAtomic: available.toString() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
