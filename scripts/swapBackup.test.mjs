import assert from 'node:assert/strict';
import test from 'node:test';
import { exportSwapBackup, restoreSwapBackup } from '../lib/wallet/swapBackup.ts';
import { encryptSeed, decryptSeed } from '../lib/wallet/seedVault.ts';
import { MAX_SWAP_BACKUP_BYTES } from '../lib/wallet/swapBackup.ts';

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: { request: async (_name, action) => action() } },
});
const password = 'disposable-backup-password';
const sourceSecret = 'source-wallet-password';
const destinationSecret = 'different-wallet-password';
function storage(data = {}) {
  return {
    data,
    writes: 0,
    async get(key) {
      return structuredClone(key === null ? data : { [key]: data[key] });
    },
    async set(items) {
      this.writes++;
      Object.assign(data, structuredClone(items));
    },
  };
}
async function encrypted(value, secret = sourceSecret) {
  const result = await encryptSeed(new TextEncoder().encode(JSON.stringify(value)), secret);
  return {
    version: 1,
    ciphertext: Array.from(new Uint8Array(result.encryptedSeed)),
    salt: Array.from(result.salt),
    iv: Array.from(result.iv),
  };
}
async function fixture() {
  const share = {
    version: 1,
    walletId: -41,
    privateSpendKey: 'ab'.repeat(32),
    digest: 'cd'.repeat(32),
  };
  const data = {
    'leakswapShare:-41': await encrypted(share),
    'leakswapHandshake:fixture': await encrypted({ version: 1, walletId: -41 }),
    ['leakswapSingleUseKey:' + 'ef'.repeat(32)]: share.digest,
    networkSettings: { secret: 'never-export-this' },
  };
  return { source: storage(data), share };
}

test('encrypted backup restores shares and dependencies under a different wallet password', async () => {
  const { source, share } = await fixture();
  const text = await exportSwapBackup(source, sourceSecret, password);
  assert.ok(!text.includes(share.privateSpendKey));
  assert.ok(!text.includes('never-export-this'));
  const target = storage();
  assert.equal(await restoreSwapBackup(target, text, password, destinationSecret), 3);
  const record = target.data['leakswapShare:-41'];
  const bytes = await decryptSeed(
    new Uint8Array(record.ciphertext).buffer,
    destinationSecret,
    new Uint8Array(record.salt),
    new Uint8Array(record.iv),
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), share);
  bytes.fill(0);
  await assert.rejects(
    decryptSeed(
      new Uint8Array(record.ciphertext).buffer,
      sourceSecret,
      new Uint8Array(record.salt),
      new Uint8Array(record.iv),
    ),
  );
  assert.equal(target.writes, 1);
  await assert.rejects(
    restoreSwapBackup(target, text, password, destinationSecret),
    /empty swap store/,
  );
  assert.equal(target.writes, 1);
});

test('wrong passwords, corruption and unsupported files never write records', async () => {
  const { source } = await fixture();
  const text = await exportSwapBackup(source, sourceSecret, password);
  const target = storage();
  await assert.rejects(restoreSwapBackup(target, text, 'wrong', destinationSecret));
  const corrupt = JSON.parse(text);
  corrupt.envelope.ciphertext[0] ^= 1;
  await assert.rejects(
    restoreSwapBackup(target, JSON.stringify(corrupt), password, destinationSecret),
  );
  await assert.rejects(restoreSwapBackup(target, '{}', password, destinationSecret), /Unsupported/);
  assert.equal(target.writes, 0);
  await assert.rejects(exportSwapBackup(source, sourceSecret, 'short'), /12 characters/);
  await assert.rejects(exportSwapBackup(source, 'wrong', password));
});

test('restore rejects duplicate, unsupported, oversized and invalid entries before any write', async () => {
  const target = storage();
  const wrap = async (entries) =>
    JSON.stringify({
      format: 'zebgen-swap-backup',
      version: 1,
      kdf: 'PBKDF2-SHA256-600000',
      envelope: await encrypted({ format: 'zebgen-swap-backup', version: 1, entries }, password),
    });
  const share = ['leakswapShare:-41', { version: 1 }];
  for (const entries of [
    [share, share],
    [share, ['networkSettings', { version: 1 }]],
    [share, ['leakswapRecord:bad', null]],
  ]) {
    await assert.rejects(
      restoreSwapBackup(target, await wrap(entries), password, destinationSecret),
    );
  }
  await assert.rejects(
    restoreSwapBackup(target, ' '.repeat(MAX_SWAP_BACKUP_BYTES + 1), password, destinationSecret),
    /too large/,
  );
  assert.equal(target.writes, 0);
});

test('backup preserves unversioned deposit attempts, activity and settlement evidence', async () => {
  const { source } = await fixture();
  const payment = { hash: 'ab'.repeat(32), amountAtomic: '1', feeAtomic: '2', state: 'unknown' };
  source.data['leakSwapDepositAttempt:fixture'] = await encrypted(payment);
  source.data['moneroOutgoingActivity:fixture'] = await encrypted(payment);
  source.data['leakswapSettlementEvidence:fixture'] = await encrypted({
    txId: 'A'.repeat(52),
    confirmedRound: '1',
    transaction: 'AQ==',
  });
  const target = storage();
  assert.equal(
    await restoreSwapBackup(
      target,
      await exportSwapBackup(source, sourceSecret, password),
      password,
      destinationSecret,
    ),
    6,
  );
});
