import assert from 'node:assert/strict';
import test from 'node:test';
import { swapStatus } from '../lib/wallet/swapStatus.ts';

const snapshot = {
  role: 'ali',
  deadlineUnit: 'round',
  t0: 10000,
  t1: 17200,
  state: 'awaiting',
  funding: 'present',
  checkedAt: 9000,
  chainRound: 9000,
};

test('round status uses only a verified node round, never Unix chain time or wall clock', () => {
  const round = { ...snapshot, deadlineUnit: 'round', chainRound: 9000, chainTime: 9999999999 };
  assert.match(swapStatus(round, 9000).title, /Waiting/);
  assert.equal(swapStatus({ ...round, chainRound: 17200 }, 9000).title, 'Punish refund available');
  assert.equal(
    swapStatus({ ...round, chainRound: undefined }, 9000).title,
    'Chain round unavailable',
  );
  assert.equal(
    swapStatus({ ...round, chainRound: 10000 }, 0).title,
    swapStatus({ ...round, chainRound: 10000 }, 9000).title,
  );
});

test('funding and verification stages describe both positions without claiming an XMR scan', () => {
  for (const role of ['ali', 'xin']) {
    assert.match(
      swapStatus({ ...snapshot, role, funding: 'empty' }, 9000).title,
      /Waiting for ALGO funding/,
    );
    assert.match(swapStatus({ ...snapshot, role }, 9000).title, /Set Ready/);
    assert.match(swapStatus({ ...snapshot, role, funding: 'unknown' }, 9000).title, /not verified/);
  }
});

test('contract deadlines are inclusive for refunds and exclusive for timeout claims', () => {
  assert.match(
    swapStatus({ ...snapshot, chainRound: 10000 }, 9000).detail,
    /Leaky refund is allowed/,
  );
  assert.equal(
    swapStatus({ ...snapshot, role: 'xin', chainRound: 10001 }, 9000).title,
    'Leaky claim available',
  );
  assert.equal(
    swapStatus({ ...snapshot, role: 'xin', state: 'ready', chainRound: 9999 }, 9000).title,
    'Leaky claim available',
  );
  assert.equal(
    swapStatus({ ...snapshot, chainRound: 17200 }, 9000).title,
    'Punish refund available',
  );
  assert.equal(
    swapStatus({ ...snapshot, role: 'xin', state: 'ready', chainRound: 17200 }, 9000).title,
    'Claim window closed',
  );
});

test('stale data, missing chain rounds and absent contracts do not invent settlement outcomes', () => {
  assert.equal(swapStatus(snapshot, 9091).title, 'Status not verified');
  assert.equal(
    swapStatus({ ...snapshot, chainRound: undefined }, 9000).title,
    'Chain round unavailable',
  );
  assert.match(
    swapStatus({ ...snapshot, state: 'unavailable' }, 9000).detail,
    /Settlement history is needed/,
  );
  assert.equal(
    swapStatus({ ...snapshot, state: 'unknown', issue: 'Select the saved network.' }, 9000).detail,
    'Select the saved network.',
  );
  assert.equal(swapStatus({ ...snapshot, chainRound: 9999 }, 18000).title, 'Status not verified');
  assert.throws(
    () => swapStatus({ ...snapshot, deadlineUnit: undefined }, 9000),
    /Legacy timestamp/,
  );
});
