import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalOffer,
  handshakeSigningBytes,
  offerDigest,
  verifyHandshake,
  decodeHandshake,
  parseHandshakeLink,
} from '../../leakswap-all/leakswap-protocol/leakswap-utils/src/swapHandshake.ts';
import {
  assertRoundFundingTime,
  minutesToRounds,
  estimateRoundDuration,
  roundDeadlineRemaining,
} from '../../leakswap-all/leakswap-protocol/leakswap-utils/src/swapTiming.ts';

const legacy = {
  offerId: 'ab'.repeat(16),
  createdAt: 100,
  algoGenesisHash: 'A'.repeat(43) + '=',
  moneroNetwork: 'regtest',
  algoAmount: '1',
  xmrAmount: '1',
  t0: 200,
  t1: 300,
  aliAlgoAddress: 'A'.repeat(58),
  aliPublicSpendKey: 'cd'.repeat(32),
  aliPrivateViewKey: 'ef'.repeat(32),
};
const round = {
  ...legacy,
  createdAt: 1900000000,
  deadlineUnit: 'round',
  createdRound: 100,
  t0: 1300,
  t1: 2500,
};

test('legacy timestamp offers cannot be signed', () => {
  assert.throws(() => handshakeSigningBytes('invite', legacy), /Legacy timestamp/);
});

test('checksum-valid legacy links are clearly rejected without numeric migration', async () => {
  for (const payload of [legacy, { ...legacy, deadlineUnit: 'timestamp' }]) {
    const message = { kind: 'invite', payload, signature: '00'.repeat(64) };
    const body = `v1.invite.${Buffer.from(JSON.stringify(message)).toString('base64url')}`;
    const checksum = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
    ).toString('hex');
    const encoded = `${body}.${checksum}`;
    await assert.rejects(decodeHandshake(encoded), /Legacy timestamp swaps are not supported/);
    await assert.rejects(
      parseHandshakeLink(`https://app.leakswap.com/swap#invite=${encoded}`),
      /Legacy timestamp swaps are not supported/,
    );
    assert.equal(payload.t0, 200);
  }
});

test('round metadata is paired, validated and signature-bound', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const signature = Buffer.from(
    await crypto.subtle.sign('Ed25519', keys.privateKey, handshakeSigningBytes('invite', round)),
  ).toString('hex');
  await verifyHandshake({ kind: 'invite', payload: round, signature }, publicKey);
  const altered = { ...round, createdRound: 101 };
  assert.notEqual(await offerDigest(round), await offerDigest(altered));
  await assert.rejects(
    verifyHandshake({ kind: 'invite', payload: altered, signature }, publicKey),
    /invalid/,
  );
  for (const invalid of [
    { ...legacy, deadlineUnit: 'round' },
    { ...legacy, createdRound: 100 },
    { ...round, deadlineUnit: 'timestamp' },
    { ...round, createdRound: undefined },
    { ...round, createdRound: 0 },
    { ...round, createdRound: 1.5 },
    { ...round, createdRound: round.t0 },
  ])
    assert.throws(() => canonicalOffer(invalid));
  assert.deepEqual(canonicalOffer(Object.fromEntries(Object.entries(round).reverse())), round);
});

test('only node rounds control funding, independent of clock jumps', () => {
  const original = Date.now;
  try {
    for (const clock of [0, 1, 9999999999999]) {
      Date.now = () => clock;
      assert.doesNotThrow(() => assertRoundFundingTime(round, 100));
      assert.throws(() => assertRoundFundingTime(round, 101), /1200 rounds/);
    }
  } finally {
    Date.now = original;
  }
  for (const current of [undefined, NaN, Infinity, 0, -1, 1.5, 99, '100'])
    assert.throws(() => assertRoundFundingTime(round, current), /node round/);
  assert.throws(() => assertRoundFundingTime(legacy, 100), /Legacy timestamp/);
});

test('presets use 20 rounds per minute and displays estimate 2.7-3 seconds per round', () => {
  assert.equal(minutesToRounds(60), 1200);
  assert.deepEqual(estimateRoundDuration(1200), { minSeconds: 3240, maxSeconds: 3600 });
  assert.match(roundDeadlineRemaining(1300, 100), /1200 rounds remaining.*54-60 min estimated/);
  assert.match(roundDeadlineRemaining(100, 1300), /1200 rounds past/);
  assert.equal(roundDeadlineRemaining(100, 100), 'deadline round reached');
});
