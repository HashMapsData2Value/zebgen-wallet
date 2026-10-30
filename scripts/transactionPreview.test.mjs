import assert from 'node:assert/strict';
import test from 'node:test';
import algosdk from 'algosdk';
import { requestsSwapReady } from '../lib/provider/transactionPreview.ts';

const sender = algosdk.generateAccount().addr;
const suggestedParams = {
  fee: 1000n,
  flatFee: true,
  firstValid: 1n,
  lastValid: 100n,
  genesisHash: new Uint8Array(32),
  genesisID: 'preview-test',
};

function request(signature = 'setReady(pay)void', overrides = {}) {
  const transaction = algosdk.makeApplicationCallTxnFromObject({
    sender,
    appIndex: 42n,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [algosdk.ABIMethod.fromSignature(signature).getSelector()],
    suggestedParams,
    ...overrides,
  });
  return {
    txns: [Buffer.from(algosdk.encodeUnsignedTransaction(transaction)).toString('base64')],
    indexesToSign: [0],
  };
}

test('recognizes a Set Ready request from actual selected transaction bytes', () => {
  assert.equal(requestsSwapReady(request()), true);
  assert.equal(requestsSwapReady(request('punishRefund(pay)void')), false);
  assert.equal(
    requestsSwapReady(
      request('setReady(pay)void', {
        onComplete: algosdk.OnApplicationComplete.DeleteApplicationOC,
      }),
    ),
    false,
  );
  const ready = request();
  assert.equal(requestsSwapReady({ txns: ['invalid', ...ready.txns], indexesToSign: [1] }), true);
  assert.equal(requestsSwapReady({ ...ready, indexesToSign: [] }), false);
  assert.equal(requestsSwapReady({ ...ready, indexesToSign: [0, 0] }), false);
  assert.equal(requestsSwapReady({ ...ready, indexesToSign: [1] }), false);
  assert.equal(requestsSwapReady({ txns: ['invalid'], indexesToSign: [0] }), false);
});
