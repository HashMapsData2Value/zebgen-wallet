import { networkLabel, type AlgorandNetworkId } from './networks';

export function verifyAlgorandGenesis(selected: AlgorandNetworkId, genesisId: string, server: string): string {
  const actual = genesisId === 'mainnet-v1.0' ? 'mainnet' : genesisId === 'testnet-v1.0' ? 'testnet' :
    /^(devnet|sandnet|dockernet|localnet|wallet-ux-localnet)(-|$)/.test(genesisId) ? 'localnet' : 'unknown';
  if (actual !== selected) throw new Error(`Network mismatch: selected ${networkLabel(selected)}, Algod reports ${genesisId || 'an unknown chain'}.`);
  if (actual === 'localnet' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(server).hostname)) {
    throw new Error('Localnet requires a loopback Algod endpoint.');
  }
  return actual;
}