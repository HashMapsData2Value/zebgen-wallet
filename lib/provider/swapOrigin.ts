export const DEFAULT_SWAP_ORIGIN = 'https://app.leakswap.com';
export const BETA_SWAP_ORIGIN = 'https://beta.leakswap.com';

export function swapOrigin(value = DEFAULT_SWAP_ORIGIN): string {
  const url = new URL(value);
  if (
    value !== url.origin ||
    !(
      [DEFAULT_SWAP_ORIGIN, BETA_SWAP_ORIGIN].includes(url.origin) ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
  )
    throw new Error('Unsupported LeakSwap origin.');
  return url.origin;
}
