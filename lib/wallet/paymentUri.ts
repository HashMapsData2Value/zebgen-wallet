export function paymentUri(chain: 'algorand' | 'monero', address: string, network: string): string {
  if (chain === 'monero') return `monero:${address}`;
  return network === 'mainnet'
    ? `algorand://${address}`
    : `algorand://net:${encodeURIComponent(network)}/${address}`;
}
