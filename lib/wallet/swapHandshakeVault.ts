import algosdk from 'algosdk';
import { verifySwapAgreement, type SwapAgreement } from 'leakswap-utils/dist/swapAgreement.js';
import { browser } from 'wxt/browser';
import {
  canonicalOffer,
  buildHandshakeUrl,
  offerDigest,
  parseHandshakeLink,
  verifyHandshake,
  type SignedOffer,
  type SignedAcceptance,
} from 'leakswap-utils/dist/swapHandshake.js';
import { getNetworkSettings } from '../network/networkStore';
import { verifyAlgorandGenesis } from '../network/chainIdentity';
import { bytesToBase64 } from '../provider/base64';
import { deriveActiveSeedAlgoAddressAtIndex, signSwapHandshake } from './algoWallet';
import { encryptSeed, decryptSeed } from './seedVault';
import { reserveSwapKey } from './swapKeyUse';
import { currentRestoreHeight } from '../monero/restoreHeight';
import {
  generateMoneroKeyMaterial,
  computeCombinedAddressWithPrivateAndPublic,
} from './moneroWallet';
import { assertSwapAffordability } from './swapAffordability';
import type { MoneroFundingControl } from '../monero/moneroDaemon';
import { findSwapShare, storeSwapShare, unlockSwapShare } from './swapShareVault';
import { assertUsablePublicSpendKey } from './spendKeyValidation';
import { assertSwapFundingTime } from './swapTimingPolicy';

export interface SwapInviteTerms {
  algoAmount: string;
  xmrAmount: string;
  t0: number;
  t1: number;
  deadlineUnit: 'round';
}

export function validateInviteTerms(value: unknown): asserts value is SwapInviteTerms {
  const terms = value as SwapInviteTerms | null;
  if (terms && terms.deadlineUnit !== 'round')
    throw new Error(
      'Legacy timestamp invitations are no longer supported for new swaps. Request round-based terms.',
    );
  if (
    !terms ||
    typeof terms !== 'object' ||
    Array.isArray(terms) ||
    Object.keys(terms).sort().join(',') !== 'algoAmount,deadlineUnit,t0,t1,xmrAmount' ||
    ![terms.algoAmount, terms.xmrAmount].every(
      (amount) =>
        typeof amount === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(amount) &&
        BigInt(amount) <= 0xffffffffffffffffn,
    ) ||
    !Number.isSafeInteger(terms.t0) ||
    terms.t0 <= 0 ||
    !Number.isSafeInteger(terms.t1) ||
    terms.t1 <= terms.t0 ||
    terms.t1 > 8640000000000
  )
    throw new Error('Invalid swap invite terms.');
}

async function ownIdentity(secret: string) {
  const settings = await getNetworkSettings();
  const endpoint = settings.algorand.algod;
  const algod = new algosdk.Algodv2(endpoint.token, endpoint.server, endpoint.port);
  const params = await algod.getTransactionParams().do();
  verifyAlgorandGenesis(settings.algorand.network, params.genesisID ?? '', endpoint.server);
  if (!params.genesisHash) throw new Error('Algod genesis hash is unavailable.');
  const { algoAddress } = await deriveActiveSeedAlgoAddressAtIndex(secret, 0);
  return { settings, algod, algoAddress, genesisHash: bytesToBase64(params.genesisHash) };
}

export async function resolveSwapWalletId(
  digest: string | undefined,
  secret: string,
  walletId?: number,
): Promise<number> {
  if (digest) {
    await loadAcceptedSwap(digest, secret);
    const owner = await ownIdentity(secret);
    const resolved = await findSwapShare(
      {
        digest,
        genesisHash: owner.genesisHash,
        algoAddress: owner.algoAddress,
        network: owner.settings.monero.network,
      },
      secret,
    );
    if (resolved === null || (walletId !== undefined && walletId !== resolved))
      throw new Error('Swap key selection conflicts with the agreement.');
    return resolved;
  }
  throw new Error('An agreement digest is required for a dedicated swap share.');
}

async function persist(key: string, value: unknown, secret: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  try {
    const encrypted = await encryptSeed(bytes, secret);
    await browser.storage.local.set({
      [key]: {
        version: 1,
        ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
        salt: Array.from(encrypted.salt),
        iv: Array.from(encrypted.iv),
      },
    });
  } finally {
    bytes.fill(0);
  }
}

export async function createSwapInvite(terms: SwapInviteTerms, secret: string) {
  validateInviteTerms(terms);
  const owner = await ownIdentity(secret);
  const material = generateMoneroKeyMaterial(owner.settings.monero.networkType);
  const moneroRestoreHeight = (await currentRestoreHeight(owner.settings.monero)) ?? 0;
  const createdRound = Number((await owner.algod.status().do()).lastRound);
  assertSwapFundingTime({ ...terms, createdRound }, createdRound);
  const payload = canonicalOffer({
    ...terms,
    offerId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
    moneroRestoreHeight,
    createdRound,
    createdAt: Math.floor(Date.now() / 1000),
    algoGenesisHash: owner.genesisHash,
    moneroNetwork: owner.settings.monero.network,
    aliAlgoAddress: owner.algoAddress,
    aliPublicSpendKey: material.publicSpendKey,
    aliPrivateViewKey: material.privateViewKey,
  });
  const digest = await offerDigest(payload);
  const walletId = await storeSwapShare(
    {
      digest,
      genesisHash: owner.genesisHash,
      algoAddress: owner.algoAddress,
      network: owner.settings.monero.network,
    },
    material,
    secret,
  );
  await reserveKeys(material.publicSpendKey, digest, secret);
  const signature = await signSwapHandshake(secret, { kind: 'invite', payload });
  const offer: SignedOffer = { kind: 'invite', payload, signature };
  await persist(
    `leakswapHandshake:${owner.genesisHash}:${owner.algoAddress}:${payload.offerId}:invite`,
    { version: 1, walletId, offer },
    secret,
  );
  return {
    offer,
    offerDigest: digest,
    link: await buildHandshakeUrl('https://app.leakswap.com', offer),
  };
}

export async function acceptSwapInvite(
  link: string,
  secret: string,
  control?: MoneroFundingControl,
) {
  const offer = await parseHandshakeLink(link);
  if (offer.kind !== 'invite') throw new Error('Expected a swap invite link.');
  await verifyHandshake(offer, algosdk.decodeAddress(offer.payload.aliAlgoAddress).publicKey);
  assertUsablePublicSpendKey(offer.payload.aliPublicSpendKey, 'The ALGO holder’s');
  const owner = await ownIdentity(secret);
  assertSwapFundingTime(offer.payload, Number((await owner.algod.status().do()).lastRound));
  if (
    owner.genesisHash !== offer.payload.algoGenesisHash ||
    owner.settings.monero.network !== offer.payload.moneroNetwork
  )
    throw new Error('Invite networks do not match the wallet networks.');
  if (owner.algoAddress === offer.payload.aliAlgoAddress)
    throw new Error('Use Xin’s wallet to accept this offer.');
  const digest = await offerDigest(offer.payload);
  const savedKey = `leakswapHandshake:${owner.genesisHash}:${owner.algoAddress}:${offer.payload.offerId}:accept`;
  const saved =
    (await browser.storage.local.get(savedKey))[savedKey] !== undefined
      ? await loadAcceptedSwap(digest, secret)
      : null;
  const candidate = saved
    ? await unlockSwapShare(
        await resolveSwapWalletId(digest, secret),
        secret,
        owner.settings.monero.network,
      )
    : generateMoneroKeyMaterial(owner.settings.monero.networkType);
  const combined = computeCombinedAddressWithPrivateAndPublic(
    candidate.privateSpendKey,
    candidate.privateViewKey,
    offer.payload.aliPrivateViewKey,
    offer.payload.aliPublicSpendKey,
    owner.settings.monero.networkType,
  );
  await assertSwapAffordability(owner.settings.monero, offer.payload.xmrAmount, secret, control);
  assertSwapFundingTime(offer.payload, Number((await owner.algod.status().do()).lastRound));
  if (saved) {
    return {
      ...saved,
      link: await buildHandshakeUrl('https://app.leakswap.com', saved.acceptance),
    };
  }
  const walletId = await storeSwapShare(
    {
      digest,
      genesisHash: owner.genesisHash,
      algoAddress: owner.algoAddress,
      network: owner.settings.monero.network,
    },
    candidate,
    secret,
  );
  const material = await unlockSwapShare(walletId, secret, owner.settings.monero.network);
  const payload = {
    offerDigest: digest,
    xinAlgoAddress: owner.algoAddress,
    xinPublicSpendKey: material.publicSpendKey,
    xinPrivateViewKey: material.privateViewKey,
  };
  await reserveKeys(material.publicSpendKey, payload.offerDigest, secret);
  const signature = await signSwapHandshake(secret, { kind: 'accept', payload });
  const acceptance: SignedAcceptance = { kind: 'accept', payload, signature };
  await persist(
    `leakswapHandshake:${owner.genesisHash}:${owner.algoAddress}:${offer.payload.offerId}:accept`,
    { version: 1, walletId, offer, acceptance },
    secret,
  );
  return {
    offer,
    acceptance,
    link: await buildHandshakeUrl('https://app.leakswap.com', acceptance),
  };
}

export async function confirmSwapAcceptance(link: string, secret: string) {
  const acceptance = await parseHandshakeLink(link);
  if (acceptance.kind !== 'accept') throw new Error('Expected a swap acceptance link.');
  await verifyHandshake(
    acceptance,
    algosdk.decodeAddress(acceptance.payload.xinAlgoAddress).publicKey,
  );
  assertUsablePublicSpendKey(acceptance.payload.xinPublicSpendKey, 'The XMR holder’s');
  const owner = await ownIdentity(secret);
  if (owner.algoAddress === acceptance.payload.xinAlgoAddress)
    throw new Error('Use Ali’s wallet to confirm the acceptance.');
  const prefix = `leakswapHandshake:${owner.genesisHash}:${owner.algoAddress}:`;
  const entries = await browser.storage.local.get(null);
  for (const key of Object.keys(entries).filter(
    (key) => key.startsWith(prefix) && key.endsWith(':invite'),
  )) {
    const envelope = entries[key] as {
      version: number;
      ciphertext: number[];
      salt: number[];
      iv: number[];
    };
    if (envelope.version !== 1) throw new Error('Unsupported stored handshake version.');
    const plaintext = await decryptSeed(
      new Uint8Array(envelope.ciphertext).buffer,
      secret,
      new Uint8Array(envelope.salt),
      new Uint8Array(envelope.iv),
    );
    try {
      const record = JSON.parse(new TextDecoder().decode(plaintext)) as {
        version: number;
        walletId: number;
        offer: SignedOffer;
      };
      if (record.version !== 1) continue;
      const offer = record.offer;
      if ((await offerDigest(offer.payload)) !== acceptance.payload.offerDigest) continue;
      const material = await unlockSwapShare(
        record.walletId,
        secret,
        owner.settings.monero.network,
      );
      await verifyHandshake(offer, algosdk.decodeAddress(owner.algoAddress).publicKey);
      if (
        key !== `${prefix}${offer.payload.offerId}:invite` ||
        offer.payload.aliAlgoAddress !== owner.algoAddress ||
        offer.payload.algoGenesisHash !== owner.genesisHash ||
        offer.payload.moneroNetwork !== owner.settings.monero.network ||
        offer.payload.aliPublicSpendKey !== material.publicSpendKey ||
        offer.payload.aliPrivateViewKey !== material.privateViewKey
      ) {
        throw new Error('Saved offer no longer matches the active wallets and networks.');
      }
      assertSwapFundingTime(offer.payload, Number((await owner.algod.status().do()).lastRound));
      await persist(
        `${prefix}${offer.payload.offerId}:accepted`,
        { version: 1, walletId: record.walletId, offer, acceptance },
        secret,
      );
      return { offer, acceptance };
    } finally {
      plaintext.fill(0);
    }
  }
  throw new Error('No matching saved offer for this acceptance and the active wallets.');
}

export async function loadAcceptedSwap(digest: string, secret: string): Promise<SwapAgreement> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid agreement digest.');
  const owner = await ownIdentity(secret);
  const prefix = `leakswapHandshake:${owner.genesisHash}:${owner.algoAddress}:`;
  const entries = await browser.storage.local.get(null);
  for (const key of Object.keys(entries).filter(
    (key) => key.startsWith(prefix) && (key.endsWith(':accept') || key.endsWith(':accepted')),
  )) {
    const envelope = entries[key] as {
      version: number;
      ciphertext: number[];
      salt: number[];
      iv: number[];
    };
    if (!envelope || envelope.version !== 1) throw new Error('Invalid saved agreement.');
    const plaintext = await decryptSeed(
      new Uint8Array(envelope.ciphertext).buffer,
      secret,
      new Uint8Array(envelope.salt),
      new Uint8Array(envelope.iv),
    );
    try {
      const record = JSON.parse(new TextDecoder().decode(plaintext)) as SwapAgreement & {
        version: number;
        walletId: number;
      };
      if (record.version !== 1 || (await offerDigest(record.offer.payload)) !== digest) continue;
      const material = await unlockSwapShare(
        record.walletId,
        secret,
        owner.settings.monero.network,
      );
      if (
        (await findSwapShare(
          {
            digest,
            genesisHash: owner.genesisHash,
            algoAddress: owner.algoAddress,
            network: owner.settings.monero.network,
          },
          secret,
        )) !== record.walletId
      )
        throw new Error('Share does not match the saved agreement.');
      await verifySwapAgreement(
        record,
        algosdk.decodeAddress(record.offer.payload.aliAlgoAddress).publicKey,
        algosdk.decodeAddress(record.acceptance.payload.xinAlgoAddress).publicKey,
      );
      const ali = owner.algoAddress === record.offer.payload.aliAlgoAddress;
      const publicSpendKey = ali
        ? record.offer.payload.aliPublicSpendKey
        : record.acceptance.payload.xinPublicSpendKey;
      const privateViewKey = ali
        ? record.offer.payload.aliPrivateViewKey
        : record.acceptance.payload.xinPrivateViewKey;
      if (
        (!ali && owner.algoAddress !== record.acceptance.payload.xinAlgoAddress) ||
        record.offer.payload.algoGenesisHash !== owner.genesisHash ||
        record.offer.payload.moneroNetwork !== owner.settings.monero.network ||
        publicSpendKey !== material.publicSpendKey ||
        privateViewKey !== material.privateViewKey ||
        key !== `${prefix}${record.offer.payload.offerId}:${ali ? 'accepted' : 'accept'}`
      )
        throw new Error('Agreement does not match the active wallets and networks.');
      await reserveKeys(material.publicSpendKey, digest, secret);
      return { offer: record.offer, acceptance: record.acceptance };
    } finally {
      plaintext.fill(0);
    }
  }
  throw new Error('No accepted agreement saved for the active wallets.');
}

async function reserveKeys(publicSpendKey: string, digest: string, secret: string): Promise<void> {
  await navigator.locks.request('leakswap-single-use-keys', async () => {
    const entries = await browser.storage.local.get(null);
    for (const key of Object.keys(entries).filter((key) => key.startsWith('leakswapHandshake:'))) {
      const encrypted = entries[key] as { ciphertext: number[]; salt: number[]; iv: number[] };
      const plaintext = await decryptSeed(
        new Uint8Array(encrypted.ciphertext).buffer,
        secret,
        new Uint8Array(encrypted.salt),
        new Uint8Array(encrypted.iv),
      );
      try {
        const record = JSON.parse(new TextDecoder().decode(plaintext)) as {
          offer: SignedOffer;
          acceptance?: SignedAcceptance;
        };
        if (
          (record.offer.payload.aliPublicSpendKey === publicSpendKey ||
            record.acceptance?.payload.xinPublicSpendKey === publicSpendKey) &&
          (await offerDigest(record.offer.payload)) !== digest
        )
          throw new Error(
            'These Monero keys have already been used for another offer. Select a fresh dedicated Monero wallet in Zebgen.',
          );
      } finally {
        plaintext.fill(0);
      }
    }
    await reserveSwapKey(browser.storage.local, publicSpendKey, digest);
  });
}
