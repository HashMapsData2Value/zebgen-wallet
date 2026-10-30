import assert from 'node:assert/strict';
import { test } from 'node:test';
import { swapOrigin, BETA_SWAP_ORIGIN, DEFAULT_SWAP_ORIGIN } from '../lib/provider/swapOrigin.ts';

test('swap origins retain beta and production, allow local testing and default legacy records to production', () => {
  assert.equal(swapOrigin(), DEFAULT_SWAP_ORIGIN);
  for (const origin of [
    BETA_SWAP_ORIGIN,
    DEFAULT_SWAP_ORIGIN,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])
    assert.equal(swapOrigin(origin), origin);
  for (const origin of [
    'https://evil.example',
    'https://beta.leakswap.com.evil.example',
    'https://beta.leakswap.com/swap',
    'https://user:pass@beta.leakswap.com',
    'javascript:alert(1)',
    'http://beta.leakswap.com',
  ])
    assert.throws(() => swapOrigin(origin));
});
