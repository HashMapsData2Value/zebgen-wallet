import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import algosdk from 'algosdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assembleTeal } from '../../lib/wallet/tealAssembler.ts';

const moduleUrl = new URL('../../lib/wallet/swapAgreementArtifact.ts', import.meta.url);
export const canonical = JSON.parse(readFileSync(new URL('../contracts/LeakSwap.arc56.json', moduleUrl), 'utf8'));
export const template = readFileSync(new URL('../contracts/FeeSponsorLSig.teal', moduleUrl), 'utf8');
const modules = {
  algosdk,
  '@noble/hashes/utils.js': { bytesToHex },
  './tealAssembler': { assembleTeal },
  '../contracts/LeakSwap.arc56.json': canonical,
  '../contracts/FeeSponsorLSig.teal?raw': template,
  '../provider/base64': { bytesToBase64: bytes => Buffer.from(bytes).toString('base64') },
};
export const artifactApi = {};
runInNewContext(ts.transpileModule(readFileSync(moduleUrl, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, {
  exports: artifactApi, Uint8Array, TextEncoder,
  require: name => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  },
});

export function programs(artifact) {
  return {
    approvalProgram: new Uint8Array(Buffer.from(artifact.byteCode.approval, 'base64')),
    clearStateProgram: new Uint8Array(Buffer.from(artifact.byteCode.clear, 'base64')),
  };
}