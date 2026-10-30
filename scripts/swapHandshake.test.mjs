import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromSeed, KeyContext, XHDWalletAPI, Encoding } from '@algorandfoundation/xhd-wallet-api';
import { signCanonicalSwapHandshake } from '../lib/wallet/swapHandshakeSigning.ts';
import {
  buildHandshakeUrl,
  parseHandshakeLink,
  encodeHandshake,
  decodeHandshake,
  handshakeSigningBytes,
  offerDigest,
  verifyHandshake,
} from 'leakswap-utils/dist/swapHandshake.js';

const offer = {
  offerId: 'ab'.repeat(16),
  createdAt: 100,
  algoGenesisHash: 'A'.repeat(43) + '=',
  deadlineUnit: 'round',
  createdRound: 100,
  moneroNetwork: 'regtest',
  algoAmount: '10000000',
  xmrAmount: '1000000000000',
  t0: 200,
  t1: 300,
  aliAlgoAddress: 'A'.repeat(58),
  aliPublicSpendKey: 'cd'.repeat(32),
  aliPrivateViewKey: 'ef'.repeat(32),
};
const unsigned = { kind: 'invite', payload: offer, signature: '00'.repeat(64) };

async function hostileHandshakeValue(bytes, kind = 'invite') {
  const body = `v1.${kind}.${Buffer.from(bytes).toString('base64url')}`;
  const checksum = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
  ).toString('hex');
  return `${body}.${checksum}`;
}

test('checksummed hostile links reject oversized, invalid UTF-8, invalid JSON and noncanonical payloads', async (context) => {
  const cases = [
    ['oversized payload', Buffer.from(JSON.stringify({ ...unsigned, padding: 'x'.repeat(12000) }))],
    [
      'invalid UTF-8 inside JSON',
      Buffer.concat([Buffer.from('{"payload":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
    ],
    ['invalid JSON', Buffer.from('{"kind":"invite",}')],
    ['null envelope', Buffer.from('null')],
    ['array envelope', Buffer.from('[]')],
    ['noncanonical JSON whitespace', Buffer.from(JSON.stringify(unsigned, null, 2))],
  ];
  for (const [label, bytes] of cases) {
    await context.test(label, async () => {
      const value = await hostileHandshakeValue(bytes);
      if (label === 'oversized payload') assert.ok(value.length > 12000 + 512);
      await assert.rejects(decodeHandshake(value), /Incomplete or damaged/);
      await assert.rejects(
        parseHandshakeLink(`https://app.leakswap.com/swap#invite=${value}`),
        /Incomplete or damaged/,
      );
    });
  }
  const invalidBase64Body = 'v1.invite.A';
  const checksum = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invalidBase64Body)),
  ).toString('hex');
  await assert.rejects(
    parseHandshakeLink(`https://app.leakswap.com/swap#invite=${invalidBase64Body}.${checksum}`),
    /Incomplete or damaged/,
  );
});

test('checksummed invite and acceptance links reject malformed public spend keys', async (context) => {
  const acceptance = {
    kind: 'accept',
    payload: {
      offerDigest: await offerDigest(offer),
      xinAlgoAddress: 'B'.repeat(58),
      xinPublicSpendKey: '01'.repeat(32),
      xinPrivateViewKey: '02'.repeat(32),
    },
    signature: unsigned.signature,
  };
  for (const message of [unsigned, acceptance]) {
    const field = message.kind === 'invite' ? 'aliPublicSpendKey' : 'xinPublicSpendKey';
    for (const [label, key] of [
      ['short', 'ab'.repeat(31)],
      ['long', 'ab'.repeat(33)],
      ['nonhex', 'gg'.repeat(32)],
      ['uppercase', 'AB'.repeat(32)],
      ['nonstring', Array(32).fill(1)],
    ]) {
      await context.test(`${message.kind}: ${label}`, async () => {
        const hostile = { ...message, payload: { ...message.payload, [field]: key } };
        const value = await hostileHandshakeValue(
          Buffer.from(JSON.stringify(hostile)),
          message.kind,
        );
        await assert.rejects(
          parseHandshakeLink(`https://app.leakswap.com/swap#${message.kind}=${value}`),
          /Incomplete or damaged/,
        );
      });
    }
  }
});

test('checksummed links reject unknown envelope and payload fields instead of silently dropping them', async (context) => {
  const acceptance = {
    kind: 'accept',
    payload: {
      offerDigest: await offerDigest(offer),
      xinAlgoAddress: 'B'.repeat(58),
      xinPublicSpendKey: '01'.repeat(32),
      xinPrivateViewKey: '02'.repeat(32),
    },
    signature: unsigned.signature,
  };
  for (const message of [unsigned, acceptance]) {
    for (const [label, hostile] of [
      ['envelope', { ...message, extra: true }],
      ['payload', { ...message, payload: { ...message.payload, extra: true } }],
      [
        'prototype-named payload field',
        { ...message, payload: { ...message.payload, ['__proto__']: { extra: true } } },
      ],
    ]) {
      await context.test(`${message.kind}: ${label}`, async () => {
        const value = await hostileHandshakeValue(
          Buffer.from(JSON.stringify(hostile)),
          message.kind,
        );
        await assert.rejects(
          parseHandshakeLink(`https://app.leakswap.com/swap#${message.kind}=${value}`),
          /Incomplete or damaged/,
        );
      });
    }
  }
});

test('well-formed links cannot authenticate with a wrong signer or a checksummed deadline alteration', async () => {
  const root = fromSeed(Buffer.alloc(64, 13));
  const otherRoot = fromSeed(Buffer.alloc(64, 14));
  try {
    const wallet = new XHDWalletAPI();
    const publicKey = await wallet.keyGen(root, KeyContext.Address, 0, 0);
    const otherPublicKey = await wallet.keyGen(otherRoot, KeyContext.Address, 0, 0);
    assert.notDeepEqual(publicKey, otherPublicKey);
    const acceptance = {
      kind: 'accept',
      payload: {
        offerDigest: await offerDigest(offer),
        xinAlgoAddress: 'B'.repeat(58),
        xinPublicSpendKey: '01'.repeat(32),
        xinPrivateViewKey: '02'.repeat(32),
      },
    };
    for (const message of [{ kind: 'invite', payload: offer }, acceptance]) {
      const signature = Buffer.from(await signCanonicalSwapHandshake(root, message)).toString(
        'hex',
      );
      const signed = { ...message, signature };
      const parsed = await parseHandshakeLink(
        await buildHandshakeUrl('https://app.leakswap.com', signed),
      );
      await verifyHandshake(parsed, publicKey);
      await assert.rejects(
        verifyHandshake(parsed, otherPublicKey),
        /Swap authentication signature is invalid/,
      );
      for (const length of [0, 31, 33])
        await assert.rejects(verifyHandshake(parsed, new Uint8Array(length)));
      if (message.kind === 'invite') {
        for (const field of ['createdRound', 't0', 't1']) {
          const tampered = { ...signed, payload: { ...offer, [field]: offer[field] + 1 } };
          const tamperedLink = await buildHandshakeUrl('https://app.leakswap.com', tampered);
          const decoded = await parseHandshakeLink(tamperedLink);
          assert.equal(decoded.payload[field], offer[field] + 1);
          assert.notEqual(await offerDigest(decoded.payload), await offerDigest(offer));
          await assert.rejects(
            verifyHandshake(decoded, publicKey),
            /Swap authentication signature is invalid/,
          );
        }
      }
    }
  } finally {
    root.fill(0);
    otherRoot.fill(0);
  }
});

test('timestamp invitations fail closed even with a valid link checksum', async () => {
  const { deadlineUnit, createdRound, ...legacyOffer } = offer;
  assert.throws(
    () => handshakeSigningBytes('invite', legacyOffer),
    /Legacy timestamp swaps are not supported/,
  );
  const value = await hostileHandshakeValue(
    Buffer.from(JSON.stringify({ ...unsigned, payload: legacyOffer })),
  );
  await assert.rejects(decodeHandshake(value), /Legacy timestamp swaps are not supported/);
  await assert.rejects(
    parseHandshakeLink(`https://app.leakswap.com/swap#invite=${value}`),
    /Legacy timestamp swaps are not supported/,
  );
});

test('restore height is canonical, authenticated, bounded and optional for round-based offers', async () => {
  assert.equal(
    JSON.parse(new TextDecoder().decode(handshakeSigningBytes('invite', offer))).payload
      .moneroRestoreHeight,
    undefined,
  );
  const payload = { ...offer, moneroRestoreHeight: 15000 };
  const signed = { ...unsigned, payload };
  assert.deepEqual(await decodeHandshake(await encodeHandshake(signed)), signed);
  assert.deepEqual(
    handshakeSigningBytes('invite', Object.fromEntries(Object.entries(payload).reverse())),
    handshakeSigningBytes('invite', payload),
  );
  assert.notEqual(
    await offerDigest(payload),
    await offerDigest({ ...payload, moneroRestoreHeight: 15001 }),
  );
  for (const moneroRestoreHeight of [-1, 0.5, 0x100000000, '15000', null, undefined]) {
    assert.throws(() => handshakeSigningBytes('invite', { ...offer, moneroRestoreHeight }));
  }
  const root = fromSeed(Buffer.alloc(64, 11));
  try {
    const publicKey = await new XHDWalletAPI().keyGen(root, KeyContext.Address, 0, 0);
    const signature = Buffer.from(
      await signCanonicalSwapHandshake(root, { kind: 'invite', payload }),
    ).toString('hex');
    await verifyHandshake({ ...signed, signature }, publicKey);
    await assert.rejects(
      verifyHandshake(
        { ...signed, signature, payload: { ...payload, moneroRestoreHeight: 15001 } },
        publicKey,
      ),
      /invalid/,
    );
    await assert.rejects(verifyHandshake({ ...unsigned, signature }, publicKey), /invalid/);
  } finally {
    root.fill(0);
  }
});

test('checksummed links round-trip and all partial envelope prefixes fail closed', async () => {
  const value = await encodeHandshake(unsigned);
  assert.deepEqual(await decodeHandshake(value), unsigned);
  const url = await buildHandshakeUrl('https://app.leakswap.com', unsigned);
  assert.deepEqual(await parseHandshakeLink(url), unsigned);
  for (let length = 0; length < value.length; length++)
    await assert.rejects(decodeHandshake(value.slice(0, length)), /Incomplete or damaged/);
  await assert.rejects(
    parseHandshakeLink('https://app.leakswap.com/swap'),
    /Incomplete or damaged/,
  );
  await assert.rejects(parseHandshakeLink(url + '&invite=duplicate'), /Incomplete or damaged/);
  await assert.rejects(
    decodeHandshake(value.replace('v1.invite', 'v1.accept')),
    /Incomplete or damaged/,
  );
});

test('canonical fields bind amounts, networks and identity, and reject raw bytes or domain overrides', async () => {
  const reversed = Object.fromEntries(Object.entries(offer).reverse());
  assert.deepEqual(
    handshakeSigningBytes('invite', reversed),
    handshakeSigningBytes('invite', offer),
  );
  assert.notEqual(await offerDigest(offer), await offerDigest({ ...offer, algoAmount: '1' }));
  for (const payload of [
    'TX',
    new Uint8Array([84, 88]),
    { ...offer, domain: 'TX' },
    { ...offer, algoAmount: '1e7' },
    { ...offer, t1: 1 },
  ]) {
    assert.throws(() => handshakeSigningBytes('invite', payload));
  }
  for (const prefix of ['TX', 'MX', 'mx', 'Program', 'ProgData'])
    assert.equal(
      new TextDecoder().decode(handshakeSigningBytes('invite', offer)).startsWith(prefix),
      false,
    );
});

test('real XHD data signatures verify only over the exact application-domain bytes', async () => {
  const root = fromSeed(Buffer.alloc(64, 7));
  try {
    const wallet = new XHDWalletAPI();
    const publicKey = await wallet.keyGen(root, KeyContext.Address, 0, 0);
    const bytes = handshakeSigningBytes('invite', offer);
    const signature = await wallet.signData(root, KeyContext.Address, 0, 0, bytes, {
      encoding: Encoding.NONE,
      schema: { type: 'object', properties: { 0: { const: 123 } }, required: ['0'] },
    });
    const signed = { ...unsigned, signature: Buffer.from(signature).toString('hex') };
    assert.deepEqual(
      Buffer.from(await signCanonicalSwapHandshake(root, { kind: 'invite', payload: offer })),
      Buffer.from(signature),
    );
    await verifyHandshake(signed, publicKey);
    await assert.rejects(
      verifyHandshake({ ...signed, payload: { ...offer, xmrAmount: '1' } }, publicKey),
      /invalid/,
    );
    const acceptance = {
      kind: 'accept',
      payload: {
        offerDigest: await offerDigest(offer),
        xinAlgoAddress: 'B'.repeat(58),
        xinPublicSpendKey: '01'.repeat(32),
        xinPrivateViewKey: '02'.repeat(32),
      },
      signature: signed.signature,
    };
    await assert.rejects(verifyHandshake(acceptance, publicKey), /invalid/);
    const acceptanceBytes = handshakeSigningBytes('accept', acceptance.payload);
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        Array.from(acceptanceBytes, (byte, index) => [String(index), { const: byte }]),
      ),
      required: Array.from(acceptanceBytes, (_, index) => String(index)),
    };
    const acceptanceSignature = await wallet.signData(
      root,
      KeyContext.Address,
      0,
      0,
      acceptanceBytes,
      { encoding: Encoding.NONE, schema },
    );
    await verifyHandshake(
      { ...acceptance, signature: Buffer.from(acceptanceSignature).toString('hex') },
      publicKey,
    );
    assert.deepEqual(
      Buffer.from(
        await signCanonicalSwapHandshake(root, { kind: 'accept', payload: acceptance.payload }),
      ),
      Buffer.from(acceptanceSignature),
    );
    await assert.rejects(
      signCanonicalSwapHandshake(root, { kind: 'invite', payload: new Uint8Array([84, 88]) }),
    );
    for (const prefix of ['TX', 'MX', 'Program', 'ProgData']) {
      await assert.rejects(
        wallet.signData(
          root,
          KeyContext.Address,
          0,
          0,
          new TextEncoder().encode(prefix + 'payload'),
          { encoding: Encoding.NONE, schema: {} },
        ),
      );
    }
    const prefixedBytes = new Uint8Array([...new TextEncoder().encode('TX'), ...acceptanceBytes]);
    await assert.rejects(
      crypto.subtle
        .verify(
          'Ed25519',
          await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']),
          acceptanceSignature,
          prefixedBytes,
        )
        .then((valid) => assert.equal(valid, true)),
    );
  } finally {
    root.fill(0);
  }
});

test('manual handshake signer never invokes Ajv-backed signData and rejects arbitrary signing inputs', async () => {
  const root = fromSeed(Buffer.alloc(64, 9));
  const originalSignData = XHDWalletAPI.prototype.signData;
  XHDWalletAPI.prototype.signData = () => {
    throw new Error('Ajv-backed signing must not be invoked.');
  };
  try {
    const wallet = new XHDWalletAPI();
    const publicKey = await wallet.keyGen(root, KeyContext.Address, 0, 0);
    const signature = await signCanonicalSwapHandshake(root, { kind: 'invite', payload: offer });
    await verifyHandshake(
      { ...unsigned, signature: Buffer.from(signature).toString('hex') },
      publicKey,
    );
    const acceptance = {
      offerDigest: await offerDigest(offer),
      xinAlgoAddress: 'B'.repeat(58),
      xinPublicSpendKey: '01'.repeat(32),
      xinPrivateViewKey: '02'.repeat(32),
    };
    const acceptedSignature = await signCanonicalSwapHandshake(root, {
      kind: 'accept',
      payload: acceptance,
    });
    await verifyHandshake(
      {
        kind: 'accept',
        payload: acceptance,
        signature: Buffer.from(acceptedSignature).toString('hex'),
      },
      publicKey,
    );
    for (const input of [
      null,
      'TX',
      new Uint8Array([84, 88]),
      { kind: 'TX', payload: offer },
      { kind: 'invite', payload: offer, domain: 'MX' },
      { kind: 'invite', payload: { ...offer, bytes: 'TX' } },
      { kind: 'invite', payload: { ...offer, algoAmount: '0' } },
      { kind: 'invite', payload: { ...offer, t1: 1 } },
    ]) {
      await assert.rejects(signCanonicalSwapHandshake(root, input));
    }
    const key = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
    for (const prefix of ['TX', 'MX', 'Program', 'ProgData']) {
      const prefixed = new TextEncoder().encode(
        prefix + new TextDecoder().decode(handshakeSigningBytes('invite', offer)),
      );
      assert.equal(await crypto.subtle.verify('Ed25519', key, signature, prefixed), false);
    }
  } finally {
    XHDWalletAPI.prototype.signData = originalSignData;
    root.fill(0);
  }
});
