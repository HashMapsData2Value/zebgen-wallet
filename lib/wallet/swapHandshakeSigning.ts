import { KeyContext, XHDWalletAPI } from '@algorandfoundation/xhd-wallet-api';
import { handshakeSigningBytes, type Handshake } from 'leakswap-utils/dist/swapHandshake.js';

export async function signCanonicalSwapHandshake(
  root: Uint8Array,
  message: Omit<Handshake, 'signature'>,
): Promise<Uint8Array> {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    Object.keys(message).sort().join(',') !== 'kind,payload'
  )
    throw new Error('Only structured LeakSwap messages can be signed.');
  const bytes = handshakeSigningBytes(message.kind, message.payload);
  const text = new TextDecoder().decode(bytes);
  if (
    ['TX', 'MX', 'Program', 'ProgData'].some((prefix) => text.startsWith(prefix)) ||
    !text.startsWith(
      message.kind === 'invite'
        ? '{"domain":"LeakSwap/Offer/v1","payload":'
        : '{"domain":"LeakSwap/Acceptance/v1","payload":',
    )
  ) {
    throw new Error('Only application-domain LeakSwap messages can be signed.');
  }
  const wallet = new XHDWalletAPI();
  return wallet.signAlgoTransaction(root, KeyContext.Address, 0, 0, bytes);
}
