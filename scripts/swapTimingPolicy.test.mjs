import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSwapFundingTime,
  MIN_DEPOSIT_WINDOW_ROUNDS,
  MIN_CLAIM_WINDOW_ROUNDS,
} from '../lib/wallet/swapTimingPolicy.ts';

const now = 100000;
const terms = {
  deadlineUnit: 'round',
  createdRound: now - 100,
  t0: now + MIN_DEPOSIT_WINDOW_ROUNDS,
  t1: now + MIN_DEPOSIT_WINDOW_ROUNDS + MIN_CLAIM_WINDOW_ROUNDS,
};

test('funding permits exactly the minimum windows and longer windows', () => {
  assert.equal(MIN_DEPOSIT_WINDOW_ROUNDS, 1200);
  assert.equal(MIN_CLAIM_WINDOW_ROUNDS, 1200);
  assert.doesNotThrow(() => assertSwapFundingTime(terms, now));
  assert.doesNotThrow(() =>
    assertSwapFundingTime({ ...terms, t0: terms.t0 + 1, t1: terms.t1 + 2 }, now),
  );
});

test('funding rejects short, expired and elapsed deposit windows', () => {
  for (const t0 of [now - 1, now, now + 1, terms.t0 - 1]) {
    assert.throws(
      () => assertSwapFundingTime({ ...terms, t0 }, now),
      /60 minutes.*deposit deadline/,
    );
  }
  assert.throws(() => assertSwapFundingTime(terms, now + 1), /60 minutes.*deposit deadline/);
});

test('funding rejects short, reversed and equal claim windows', () => {
  for (const t1 of [terms.t0 - 1, terms.t0, terms.t1 - 1]) {
    assert.throws(
      () => assertSwapFundingTime({ ...terms, t1 }, now),
      /claim window.*60 minutes|Invalid round/,
    );
  }
});

test('funding fails closed on malformed rounds', () => {
  for (const value of [NaN, Infinity, 0, -1, 1.5, '1900000000', undefined]) {
    assert.throws(() => assertSwapFundingTime({ ...terms, t0: value }, now), /Invalid round/);
    assert.throws(() => assertSwapFundingTime({ ...terms, t1: value }, now), /Invalid round/);
    assert.throws(
      () => assertSwapFundingTime(terms, value === undefined ? NaN : value),
      /node round/,
    );
  }
});
