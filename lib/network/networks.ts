import { MoneroNetworkType } from '../wallet/moneroWallet';

// This module is intentionally free of heavy dependencies (no WebAssembly, no
// algosdk) so it can be imported anywhere — popup, background, or content —
// without bloating a bundle or breaking the MV3 popup.

export type AlgorandNetworkId = 'mainnet' | 'testnet' | 'localnet';
export type MoneroNetworkId = 'mainnet' | 'testnet' | 'stagenet' | 'regtest';

export interface AlgodEndpoint {
  server: string;
  port: number | '';
  token: string;
}

export interface IndexerEndpoint {
  server: string;
  port: number | '';
  token: string;
}

export interface AlgorandNetworkConfig {
  network: AlgorandNetworkId;
  algod: AlgodEndpoint;
  indexer: IndexerEndpoint;
}

export interface MoneroDaemonEndpoint {
  uri: string;
  username?: string;
  password?: string;
}

export interface MoneroNetworkConfig {
  network: MoneroNetworkId;
  networkType: MoneroNetworkType;
  daemon: MoneroDaemonEndpoint;
}

export interface NetworkSettings {
  algorand: AlgorandNetworkConfig;
  monero: MoneroNetworkConfig;
}

// AlgoKit LocalNet uses a token made of 64 'a' characters for both algod and
// indexer.
const ALGO_LOCALNET_TOKEN = 'a'.repeat(64);

export const ALGORAND_NETWORK_IDS: AlgorandNetworkId[] = ['mainnet', 'testnet', 'localnet'];
export const MONERO_NETWORK_IDS: MoneroNetworkId[] = ['mainnet', 'stagenet', 'regtest'];

// Per-network accent colors used for the network badge and address framing.
export const NETWORK_COLORS: Record<string, string> = {
  mainnet: '#a78bfa',
  testnet: '#eab308',
  localnet: '#ffffff',
  stagenet: '#eab308',
  regtest: '#ffffff',
};

export function networkColor(network: string): string {
  return NETWORK_COLORS[network] ?? '#8b5cf6';
}

export function networkLabel(network: string): string {
  if (network === 'regtest') return 'Local Regtest';
  return network.charAt(0).toUpperCase() + network.slice(1);
}

export const ALGORAND_PRESETS: Record<AlgorandNetworkId, AlgorandNetworkConfig> = {
  mainnet: {
    network: 'mainnet',
    algod: { server: 'https://mainnet-api.algonode.cloud', port: '', token: '' },
    indexer: { server: 'https://mainnet-idx.algonode.cloud', port: '', token: '' },
  },
  testnet: {
    network: 'testnet',
    algod: { server: 'https://testnet-api.algonode.cloud', port: '', token: '' },
    indexer: { server: 'https://testnet-idx.algonode.cloud', port: '', token: '' },
  },
  localnet: {
    network: 'localnet',
    algod: { server: 'http://localhost', port: 4001, token: ALGO_LOCALNET_TOKEN },
    indexer: { server: 'http://localhost', port: 8980, token: ALGO_LOCALNET_TOKEN },
  },
};

// Endpoint location does not identify its chain. Regtest uses mainnet address
// encoding but is a separate simulated chain, verified through daemon RPC.
export const MONERO_PRESETS: Record<MoneroNetworkId, MoneroNetworkConfig> = {
  regtest: {
    network: 'regtest',
    networkType: MoneroNetworkType.MAINNET,
    daemon: { uri: 'http://127.0.0.1:18081' },
  },
  mainnet: {
    network: 'mainnet',
    networkType: MoneroNetworkType.MAINNET,
    daemon: { uri: 'https://xmr.nodely.dev:18089' },
  },
  testnet: {
    network: 'testnet',
    networkType: MoneroNetworkType.TESTNET,
    daemon: { uri: 'http://127.0.0.1:28081' },
  },
  stagenet: {
    network: 'stagenet',
    networkType: MoneroNetworkType.STAGENET,
    daemon: { uri: 'https://xmr.nodely.dev:38089' },
  },
};

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  algorand: ALGORAND_PRESETS.testnet,
  monero: MONERO_PRESETS.stagenet,
};

export function cloneAlgorandPreset(network: AlgorandNetworkId): AlgorandNetworkConfig {
  return structuredClone(ALGORAND_PRESETS[network]);
}

export function cloneMoneroPreset(network: MoneroNetworkId): MoneroNetworkConfig {
  return structuredClone(MONERO_PRESETS[network]);
}
