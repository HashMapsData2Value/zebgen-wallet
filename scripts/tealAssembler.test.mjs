import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import algosdk from 'algosdk';
import { assembleTeal } from '../lib/wallet/tealAssembler.ts';

const template = readFileSync(
  new URL('../lib/contracts/FeeSponsorLSig.teal', import.meta.url),
  'utf8',
);
const { vectors } = JSON.parse(
  readFileSync(new URL('./sponsorVectors.json', import.meta.url), 'utf8'),
);
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const fill = (appId, ali, xin) =>
  template
    .replace(/\bTMPL_APP_ID\b/g, appId)
    .replace(/\bTMPL_ALI_ADDR\b/g, `0x${hex(algosdk.decodeAddress(ali).publicKey)}`)
    .replace(/\bTMPL_XIN_ADDR\b/g, `0x${hex(algosdk.decodeAddress(xin).publicKey)}`);

test('local assembly reproduces algod\u2019s compiled sponsor program and address for every app-id width', () => {
  assert.ok(vectors.length >= 10);
  for (const vector of vectors) {
    const program = assembleTeal(fill(vector.appId, vector.aliAddress, vector.xinAddress));
    assert.equal(hex(program), vector.programHex, `program for app ${vector.appId}`);
    assert.equal(
      new algosdk.LogicSigAccount(program).address().toString(),
      vector.sponsorAddress,
      `address for app ${vector.appId}`,
    );
  }
});

test('changing the app, either party or the template changes the sponsor address', () => {
  const [first] = vectors;
  const base = new algosdk.LogicSigAccount(
    assembleTeal(fill(first.appId, first.aliAddress, first.xinAddress)),
  )
    .address()
    .toString();
  const other = algosdk.generateAccount().addr.toString();
  for (const source of [
    fill('2', first.aliAddress, first.xinAddress),
    fill(first.appId, other, first.xinAddress),
    fill(first.appId, first.aliAddress, other),
    fill(first.appId, first.xinAddress, first.aliAddress),
    fill(first.appId, first.aliAddress, first.xinAddress).replace('txn Fee', 'txn Amount'),
  ]) {
    assert.notEqual(new algosdk.LogicSigAccount(assembleTeal(source)).address().toString(), base);
  }
});

test('anything the assembler does not know is rejected instead of guessed', () => {
  const header = '#pragma version 10\n#pragma typetrack false\n';
  for (const bad of [
    'callsub x',
    'txn Sender',
    'pushint -1',
    'pushint 18446744073709551616',
    'pushbytes 0xabc',
    'bz nowhere',
    'int 1',
    'L:\nL:',
    'dig 256',
    'intc 256',
    'intcblock',
    'back:\nb back',
    'TMPL_APP_ID',
  ]) {
    assert.throws(() => assembleTeal(header + bad + '\n'), undefined, bad);
  }
  assert.throws(() => assembleTeal('pushint 1\n'), /version/);
  assert.throws(() => assembleTeal('#pragma version 9\npushint 1\n'), /version 10/);
});
