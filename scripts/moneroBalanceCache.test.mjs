import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

function load(name, dependencies = {}) {
  const exports = {};
  const compiled = ts.transpileModule(
    readFileSync(new URL(`../lib/wallet/${name}.ts`, import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  runInNewContext(compiled, {
    exports,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    Uint8Array,
    ArrayBuffer,
    require: (dependency) => {
      if (!(dependency in dependencies)) throw new Error(`Unexpected dependency: ${dependency}`);
      return dependencies[dependency];
    },
  });
  return exports;
}

const seedVault = load('seedVault');
test('unlock schedules validate block heights and survive encrypted persistence', async () => {
  const { api, reopen, key } = fixture();
  const unlocks = [
    { height: 1240, amountAtomic: '500000000000' },
    { height: 1247, amountAtomic: '200000000000' },
    { height: null, amountAtomic: '1' },
  ];
  await api.saveBalanceCheckpoint(key, { ...checkpoint, unlocks }, 'pin');
  const saved = await reopen().loadBalanceCheckpoint(key, 'pin');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.unlocks)), unlocks);
  for (const value of [
    [{ height: -1, amountAtomic: '1' }],
    [{ height: 1.5, amountAtomic: '1' }],
    [{ height: 4, amountAtomic: '-1' }],
    [{}],
    null,
  ]) {
    assert.throws(() => api.moneroUnlocks(value), /Invalid Monero unlock schedule/);
  }
});
const checkpoint = {
  balanceAtomic: '18446744073709551615',
  scannedHeight: 1234,
  scannedAt: 123456789,
};
const scope = [
  'regtest',
  'http://rpc-user:rpc-password@localhost:18081/rpc/?token=rpc-token#rpc-fragment',
  'wallet-address-secret',
  100,
];

function fixture() {
  const records = {};
  const storage = {
    get: async (key) => (Object.hasOwn(records, key) ? { [key]: records[key] } : {}),
    set: async (items) => {
      Object.assign(records, items);
    },
  };
  const reopen = () =>
    load('moneroBalanceCache', {
      './seedVault': seedVault,
      'wxt/browser': { browser: { storage: { local: storage } } },
    });
  const api = reopen();
  return { api, reopen, records, key: api.balanceCheckpointKey(...scope) };
}

async function envelope(value) {
  const encrypted = await seedVault.encryptSeed(
    new TextEncoder().encode(JSON.stringify(value)),
    'pin',
  );
  return {
    version: 1,
    ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
    salt: Array.from(encrypted.salt),
    iv: Array.from(encrypted.iv),
  };
}

test('real vault roundtrip survives reopening with private storage keys and allowlisted plaintext', async () => {
  const { api, reopen, records, key } = fixture();
  assert.equal(typeof key, 'string');
  for (const credential of ['rpc-user', 'rpc-password', 'rpc-token', 'rpc-fragment']) {
    assert.equal(key.includes(credential), false);
  }
  assert.equal(await api.loadBalanceCheckpoint(key, 'pin'), null);
  await api.saveBalanceCheckpoint(
    key,
    {
      ...checkpoint,
      address: scope[2],
      daemon: scope[1],
      privateSpendKey: 'spend-key-secret',
      lockSecret: 'pin-secret',
    },
    'pin',
  );
  const [storageKey] = Object.keys(records);
  assert.match(storageKey, /^moneroBalance:[0-9a-f]{64}$/);
  const serialized = JSON.stringify(records);
  for (const identity of [
    ...scope.slice(0, 3),
    'localhost',
    'rpc-user',
    'rpc-password',
    'rpc-token',
    'rpc-fragment',
    'balanceAtomic',
    'spend-key-secret',
    'pin-secret',
  ]) {
    assert.equal(serialized.includes(identity), false, `Leaked ${identity}`);
  }
  const saved = records[storageKey];
  const plaintext = await seedVault.decryptSeed(
    new Uint8Array(saved.ciphertext).buffer,
    'pin',
    new Uint8Array(saved.salt),
    new Uint8Array(saved.iv),
  );
  try {
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), checkpoint);
  } finally {
    plaintext.fill(0);
  }
  assert.deepEqual({ ...(await reopen().loadBalanceCheckpoint(key, 'pin')) }, checkpoint);
  await api.saveBalanceCheckpoint(
    key,
    { balanceAtomic: '0', scannedHeight: 0, scannedAt: 0 },
    'pin',
  );
  assert.deepEqual(
    { ...(await reopen().loadBalanceCheckpoint(key, 'pin')) },
    { balanceAtomic: '0', scannedHeight: 0, scannedAt: 0 },
  );
  assert.equal(Object.keys(records).length, 1);
});

test('scope separates wallet, network, daemon and restore height, but ignores daemon credentials', async () => {
  const { api, records, key } = fixture();
  await api.saveBalanceCheckpoint(key, checkpoint, 'pin');
  const sanitizedKey = api.balanceCheckpointKey(
    scope[0],
    'http://localhost:18081/rpc',
    scope[2],
    scope[3],
  );
  assert.equal(sanitizedKey, key);
  assert.deepEqual({ ...(await api.loadBalanceCheckpoint(sanitizedKey, 'pin')) }, checkpoint);
  for (const changed of [
    ['mainnet', scope[1], scope[2], scope[3]],
    [scope[0], scope[1], 'other-wallet', scope[3]],
    [scope[0], 'http://elsewhere:18081/rpc', scope[2], scope[3]],
    [scope[0], 'http://localhost:18082/rpc', scope[2], scope[3]],
    [scope[0], 'http://localhost:18081/other', scope[2], scope[3]],
    [scope[0], scope[1], scope[2], 101],
  ]) {
    const changedKey = api.balanceCheckpointKey(...changed);
    assert.equal(await api.loadBalanceCheckpoint(changedKey, 'pin'), null);
    await api.saveBalanceCheckpoint(changedKey, checkpoint, 'pin');
  }
  assert.equal(Object.keys(records).length, 7);
});

test('locked funds and disjoint coverage survive encrypted reopening and expose missing blocks', async () => {
  const { api, reopen } = fixture();
  const key = api.coverageCheckpointKey(...scope.slice(0, 3));
  const spans = [
    { start: 1000, end: 2000 },
    { start: 2500, end: 3000 },
  ];
  await api.saveBalanceCheckpoint(
    key,
    { ...checkpoint, scannedHeight: 3000, lockedAtomic: '7000000000000', spans },
    'pin',
  );
  const saved = await reopen().loadBalanceCheckpoint(key, 'pin');
  assert.equal(saved.lockedAtomic, '7000000000000');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.spans)), spans);
  assert.deepEqual(JSON.parse(JSON.stringify(api.unscannedSpans(saved.spans, 3000))), [
    { start: 0, end: 1000 },
    { start: 2000, end: 2500 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.unscannedSpans(saved.spans, 3500))), [
    { start: 0, end: 1000 },
    { start: 2000, end: 2500 },
    { start: 3000, end: 3500 },
  ]);
  for (const invalid of [
    [{ start: -1, end: 100 }],
    [{ start: 2000, end: 1000 }],
    [
      { start: 1, end: 200 },
      { start: 100, end: 300 },
    ],
  ]) {
    await assert.rejects(
      api.saveBalanceCheckpoint(key, { ...checkpoint, spans: invalid }, 'pin'),
      /Invalid Monero scan spans/,
    );
  }
  await assert.rejects(
    api.saveBalanceCheckpoint(key, { ...checkpoint, lockedAtomic: '-1' }, 'pin'),
    /locked balance/,
  );
});

test('wrong PIN and corrupted authenticated ciphertext reject without changing storage', async () => {
  const { api, reopen, records, key } = fixture();
  await api.saveBalanceCheckpoint(key, checkpoint, 'pin');
  const original = JSON.stringify(records);
  await assert.rejects(reopen().loadBalanceCheckpoint(key, 'wrong-pin'));
  assert.equal(JSON.stringify(records), original);
  const saved = Object.values(records)[0];
  saved.ciphertext[0] ^= 1;
  await assert.rejects(reopen().loadBalanceCheckpoint(key, 'pin'));
});

test('malformed envelopes reject before byte coercion or decryption', async () => {
  const { api, records, key } = fixture();
  await api.saveBalanceCheckpoint(key, checkpoint, 'pin');
  const [storageKey] = Object.keys(records);
  const valid = structuredClone(records[storageKey]);
  const malformed = [null, false, 0, '', [], {}, { ...valid, version: 2 }];
  for (const field of ['ciphertext', 'salt', 'iv']) {
    for (const bad of ['bytes', null, [], [0], [-1], [256], [1.5], ['1'], [NaN], [Infinity]]) {
      malformed.push({ ...valid, [field]: bad });
    }
    for (const badByte of [-1, 256, 1.5, '1', NaN, Infinity, undefined]) {
      const bytes = [...valid[field]];
      bytes[0] = badByte;
      malformed.push({ ...valid, [field]: bytes });
    }
    const sparse = [...valid[field]];
    delete sparse[0];
    malformed.push({ ...valid, [field]: sparse });
  }
  malformed.push({ ...valid, ciphertext: Array(15).fill(0) });
  malformed.push({ ...valid, salt: Array(17).fill(0) });
  malformed.push({ ...valid, iv: Array(13).fill(0) });
  for (const value of malformed) {
    records[storageKey] = value;
    await assert.rejects(
      api.loadBalanceCheckpoint(key, 'pin'),
      /Invalid saved Monero balance envelope/,
    );
  }
});

test('save and load validate checkpoint types, unsigned amounts and nonnegative safe integers', async () => {
  const { api, records, key } = fixture();
  await api.saveBalanceCheckpoint(key, checkpoint, 'pin');
  const [storageKey] = Object.keys(records);
  const invalid = [null, [], {}, false, 'checkpoint'];
  for (const balanceAtomic of [0, null, {}, '', '-1', '+1', '1.2', '1e3', ' 1', '1 ', 'NaN']) {
    invalid.push({ ...checkpoint, balanceAtomic });
  }
  for (const field of ['scannedHeight', 'scannedAt']) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      invalid.push({ ...checkpoint, [field]: value });
    }
  }
  for (const value of invalid) {
    const original = JSON.stringify(records);
    await assert.rejects(
      api.saveBalanceCheckpoint(key, value, 'pin'),
      /Invalid saved Monero balance checkpoint/,
    );
    assert.equal(JSON.stringify(records), original);
    records[storageKey] = await envelope(value);
    await assert.rejects(
      api.loadBalanceCheckpoint(key, 'pin'),
      /Invalid saved Monero balance checkpoint/,
    );
  }
  for (const field of ['scannedHeight', 'scannedAt']) {
    for (const value of [NaN, Infinity, -Infinity]) {
      await assert.rejects(
        api.saveBalanceCheckpoint(key, { ...checkpoint, [field]: value }, 'pin'),
        /Invalid saved Monero balance checkpoint/,
      );
    }
  }
  records[storageKey] = await envelope({ ...checkpoint, extraSecret: 'discard-me' });
  assert.deepEqual({ ...(await api.loadBalanceCheckpoint(key, 'pin')) }, checkpoint);
  records[storageKey] = await envelope(checkpoint);
  const encrypted = await seedVault.encryptSeed(new TextEncoder().encode('not-json'), 'pin');
  records[storageKey] = {
    ...records[storageKey],
    ciphertext: Array.from(new Uint8Array(encrypted.encryptedSeed)),
    salt: Array.from(encrypted.salt),
    iv: Array.from(encrypted.iv),
  };
  await assert.rejects(api.loadBalanceCheckpoint(key, 'pin'));
});
