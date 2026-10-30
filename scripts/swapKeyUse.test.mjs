import assert from 'node:assert/strict';
import test from 'node:test';
import { reserveSwapKey } from '../lib/wallet/swapKeyUse.ts';

test('a spend key is permanently bound to one offer across retries and restarts', async () => {
  const data = {};
  const storage = {
    get: async (key) => ({ [key]: data[key] }),
    set: async (value) => Object.assign(data, JSON.parse(JSON.stringify(value))),
  };
  await reserveSwapKey(storage, '01'.repeat(32), '02'.repeat(32));
  await reserveSwapKey(storage, '01'.repeat(32), '02'.repeat(32));
  await assert.rejects(
    reserveSwapKey(storage, '01'.repeat(32), '03'.repeat(32)),
    /already reserved/,
  );
  await reserveSwapKey(storage, '04'.repeat(32), '03'.repeat(32));
  assert.equal(Object.keys(data).length, 2);
  assert.equal(JSON.stringify(data).includes('01'.repeat(32)), false);
});
