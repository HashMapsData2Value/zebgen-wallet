import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(granted = true) {
  const requested = [];
  const api = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../lib/network/hostPermissions.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    {
      exports: api,
      URL,
      require: () => ({
        browser: {
          permissions: {
            request: async (request) => {
              requested.push(request.origins);
              return granted;
            },
          },
        },
      }),
    },
  );
  return { api, requested };
}

test('plain http is only accepted for loopback and private-network nodes', () => {
  const { api } = load();
  for (const host of [
    'localhost',
    '127.0.0.1',
    '[::1]',
    '10.0.0.5',
    '172.16.9.1',
    '172.31.255.255',
    '192.168.1.20',
    'node.local',
  ]) {
    assert.equal(api.isPrivateNetworkHost(host), true, host);
  }
  for (const host of [
    'example.com',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '192.169.0.1',
    '11.0.0.1',
    '10.0.0.256',
    'localhost.evil.com',
    'evil.local.example.com',
  ]) {
    assert.equal(api.isPrivateNetworkHost(host), false, host);
  }
});

test('remote http nodes are refused before any permission prompt, https and private http proceed', async () => {
  const { api, requested } = load();
  await assert.rejects(
    api.ensureHostPermissions(['http://node.example.com:18081']),
    /Use https:\/\/ for node\.example\.com/,
  );
  assert.deepEqual(requested, []);
  await api.ensureHostPermissions([
    'https://node.example.com',
    'http://192.168.1.20:18081',
    'http://127.0.0.1:18081',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(requested)), [
    ['https://node.example.com/*', 'http://192.168.1.20/*'],
  ]);
});
