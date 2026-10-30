import {
  privateKeyToMoneroMnemonic,
  moneroMnemonicToPrivateKey,
} from '../lib/wallet/moneroMnemonic.ts';

// Reference seeds produced by monero-ts 0.11.10 `createWalletKeys(...).getSeed()` (English).
const vectors = [
  {
    spendKey: '0000000000000000000000000000000000000000000000000000000000000000',
    seed: 'abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey abbey',
  },
  {
    spendKey: 'e6c5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d00',
    seed: 'ladder adjust remedy safety lazy jigsaw neutral pamphlet tonic emotion magically actress auburn onion foxes safety lazy jigsaw neutral pamphlet tonic skater lifestyle likewise adjust',
  },
];

let failed = false;
for (const { spendKey, seed } of vectors) {
  const decoded = moneroMnemonicToPrivateKey(seed);
  const encoded = privateKeyToMoneroMnemonic(spendKey);
  const ok = decoded === spendKey && encoded === seed;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${spendKey}`, ok ? '' : { decoded, encoded });
}
process.exit(failed ? 1 : 0);
