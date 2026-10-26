import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assembleTeal } from '../lib/wallet/tealAssembler.ts';

const artifactPath = '../contracts/';
const moduleUrl = new URL('../lib/wallet/swapAgreementArtifact.ts', import.meta.url);
const canonical = JSON.parse(
  readFileSync(new URL(`${artifactPath}LeakSwap.arc56.json`, moduleUrl), 'utf8'),
);
const template = readFileSync(new URL(`${artifactPath}FeeSponsorLSig.teal`, moduleUrl), 'utf8');
const compiled = ts.transpileModule(readFileSync(moduleUrl, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const api = {};
const modules = {
  algosdk,
  './tealAssembler': { assembleTeal },
  '@noble/hashes/utils.js': { bytesToHex },
  [`${artifactPath}LeakSwap.arc56.json`]: canonical,
  [`${artifactPath}FeeSponsorLSig.teal?raw`]: template,
  '../provider/base64': {
    bytesToBase64: (bytes) => Buffer.from(bytes).toString('base64'),
    base64ToBytes: (text) => new Uint8Array(Buffer.from(text, 'base64')),
  },
};
runInNewContext(compiled, {
  exports: api,
  Uint8Array,
  TextEncoder,
  require: (name) => {
    assert.ok(name in modules, `Unexpected import: ${name}`);
    return modules[name];
  },
});

test('deployment supports only canonical round programs, not legacy or modified programs', () => {
  const approvalSource = Buffer.from(canonical.source.approval, 'base64').toString();
  assert.match(approvalSource, /global Round/);
  assert.doesNotMatch(approvalSource, /global LatestTimestamp/);
  const approval = Buffer.from(canonical.byteCode.approval, 'base64');
  const clear = Buffer.from(canonical.byteCode.clear, 'base64');
  const treasury = algosdk.decodeAddress(
    'KMRBWAK47LNYSDWH2FW3Q7BLZFXKHXURZG3SVUONHBHG5MPBNB2PIZKZBA',
  ).publicKey;
  const treasuryOffset = approval.indexOf(treasury);
  assert.ok(treasuryOffset >= 0, 'Canonical approval must contain the fixed platform treasury');
  assert.doesNotThrow(() => api.assertAgreementPrograms(approval, clear));
  const otherTreasury = Buffer.from(approval);
  otherTreasury[treasuryOffset] ^= 1;
  for (const unsupported of [
    new Uint8Array([10, 129, 1, 67]),
    approval.subarray(0, treasuryOffset),
    otherTreasury,
  ]) {
    assert.throws(
      () => api.assertAgreementPrograms(unsupported, clear),
      /supported LeakSwap protocol/,
    );
  }
  assert.throws(
    () => api.assertAgreementPrograms(approval, new Uint8Array([10])),
    /supported LeakSwap protocol/,
  );
});

test('wallet sponsor template matches the canonical protocol artifact', () => {
  const { templateSha256 } = JSON.parse(
    readFileSync(new URL('./sponsorVectors.json', import.meta.url), 'utf8'),
  );
  assert.match(templateSha256, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(template).digest('hex'), templateSha256);
});

test('wallet derives exact sponsor bytes and addresses locally without a node compiler', () => {
  const { vectors } = JSON.parse(
    readFileSync(new URL('./sponsorVectors.json', import.meta.url), 'utf8'),
  );
  for (const vector of vectors) {
    const agreement = {
      offer: { payload: { aliAlgoAddress: vector.aliAddress } },
      acceptance: { payload: { xinAlgoAddress: vector.xinAddress } },
    };
    const sponsor = api.agreementSponsorLogicSig(BigInt(vector.appId), agreement);
    assert.equal(Buffer.from(sponsor.lsig.logic).toString('hex'), vector.programHex);
    assert.equal(
      api.agreementSponsorAddress(BigInt(vector.appId), agreement),
      vector.sponsorAddress,
    );
  }
});
