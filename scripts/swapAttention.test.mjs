import assert from 'node:assert/strict';
import test from 'node:test';
import {
  swapAttention,
  refundDecisionMargin,
  deadlineRemaining,
} from '../../leakswap-all/leakswap-protocol/leakswap-utils/src/swapAttention.ts';

test('round attention uses round margins and explicitly estimated countdowns', () => {
  assert.equal(refundDecisionMargin(10000, 12400, 'round'), 600);
  assert.equal(swapAttention('ali', 10000, 12400, 9399, 'awaiting', 'round').priority, 1);
  assert.equal(
    swapAttention('ali', 10000, 12400, 9400, 'awaiting', 'round').title,
    'Refund decision due',
  );
  assert.match(
    deadlineRemaining(11200, 10000, 'round'),
    /1200 rounds remaining.*54-60 min estimated/,
  );
});

test('preset margins and custom heuristic match decision guidance', () => {
  assert.equal(refundDecisionMargin(10000, 12400, 'round'), 600);
  assert.equal(refundDecisionMargin(10000, 17200, 'round'), 1200);
  assert.equal(refundDecisionMargin(10000, 38800, 'round'), 2400);
  assert.equal(refundDecisionMargin(10000, 11200, 'round'), 300);
  assert.throws(() => refundDecisionMargin(10000, 17200), /Only round/);
});

test('decision and deadline boundaries preserve inclusive refund and exclusive final claim', () => {
  assert.equal(swapAttention('ali', 10000, 17200, 8799, 'awaiting', 'round').priority, 1);
  assert.equal(
    swapAttention('ali', 10000, 17200, 8800, 'awaiting', 'round').title,
    'Refund decision due',
  );
  assert.equal(
    swapAttention('ali', 10000, 17200, 10000, 'awaiting', 'round').title,
    'Refund decision due',
  );
  assert.equal(
    swapAttention('ali', 10000, 17200, 10001, 'awaiting', 'round').title,
    'Xin can claim',
  );
  assert.equal(
    swapAttention('xin', 10000, 17200, 17199, 'ready', 'round').title,
    'Claim needs attention',
  );
  assert.equal(
    swapAttention('xin', 10000, 17200, 17200, 'ready', 'round').title,
    'Claim window may have closed',
  );
});

test('unknown or unavailable apps never assert refund eligibility or confirmed settlement', () => {
  for (const now of [0, 8200, 10000, 20000]) {
    assert.match(swapAttention('ali', 10000, 17200, now, 'unknown', 'round').title, /Verify|Check/);
    assert.equal(swapAttention('ali', 10000, 17200, now, 'unavailable', 'round').priority, 0);
  }
});

test('ready suppresses premature refund prompts and countdowns handle subminute deadlines', () => {
  assert.equal(swapAttention('ali', 10000, 17200, 9000, 'ready', 'round').title, 'Xin can claim');
  assert.equal(swapAttention('xin', 10000, 17200, 9000, 'ready', 'round').priority, 3);
  assert.match(deadlineRemaining(10000, 9999, 'round'), /1 rounds remaining/);
  assert.equal(deadlineRemaining(10000, 10000, 'round'), 'deadline round reached');
  assert.throws(() => deadlineRemaining(10000, 10000), /Only round/);
});
