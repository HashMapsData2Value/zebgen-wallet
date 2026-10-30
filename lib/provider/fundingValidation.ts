import type { ZebgenScanCombinedMoneroFundingParams } from './types';

const REQUEST_TYPES = new Set([
  'connect',
  'getAlgorandAddress',
  'getMoneroShareInfo',
  'computeCombinedMoneroAddress',
  'scanCombinedMoneroFunding',
  'signAlgorandTransactions',
  'computeMoneroLeakySignature',
  'saveLeakSwap',
  'listLeakSwaps',
  'depositLeakSwapMonero',
  'recoverLeakSwapMonero',
  'settleLeakSwap',
  'createSwapInvite',
  'acceptSwapInvite',
  'confirmSwapAcceptance',
]);

export function validateProviderRequest(type: unknown, params: unknown): void {
  if (typeof type !== 'string' || !REQUEST_TYPES.has(type)) {
    throw new Error('Unsupported Zebgen request type.');
  }
  if (type === 'scanCombinedMoneroFunding') validateFundingParams(params);
  if (type === 'settleLeakSwap') {
    const input = params as Record<string, unknown> | null;
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'action,agreementDigest,appId' ||
      typeof input.agreementDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.agreementDigest) ||
      typeof input.appId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(input.appId) ||
      BigInt(input.appId) > 0xffffffffffffffffn ||
      !['claim', 'refund'].includes(input.action as string)
    ) {
      throw new Error('Invalid LeakSwap settlement identity.');
    }
  }
  if (type === 'recoverLeakSwapMonero') {
    const input = params as Record<string, unknown> | null;
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['appId', 'settlementTxId', 'inspectOnly'].includes(key)) ||
      typeof input.appId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(input.appId) ||
      BigInt(input.appId) > 0xffffffffffffffffn ||
      (input.inspectOnly !== undefined && typeof input.inspectOnly !== 'boolean') ||
      (input.settlementTxId !== undefined &&
        (typeof input.settlementTxId !== 'string' || !/^[A-Z2-7]{52}$/.test(input.settlementTxId)))
    ) {
      throw new Error('Invalid LeakSwap recovery identity.');
    }
  }
  if (type === 'depositLeakSwapMonero') {
    const input = params as Record<string, unknown> | null;
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'agreementDigest,appId' ||
      typeof input.agreementDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.agreementDigest) ||
      typeof input.appId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(input.appId) ||
      BigInt(input.appId) > 0xffffffffffffffffn
    )
      throw new Error('Invalid LeakSwap deposit identity.');
  }
  if (
    [
      'signAlgorandTransactions',
      'saveLeakSwap',
      'getMoneroShareInfo',
      'computeCombinedMoneroAddress',
      'scanCombinedMoneroFunding',
      'computeMoneroLeakySignature',
    ].includes(type)
  ) {
    const input = params as { agreementDigest?: unknown; agreementAppId?: unknown } | null;
    if (
      input?.agreementDigest !== undefined &&
      (typeof input.agreementDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.agreementDigest))
    )
      throw new Error('Invalid agreement digest.');
    if (
      input?.agreementAppId !== undefined &&
      (!input.agreementDigest ||
        typeof input.agreementAppId !== 'string' ||
        !/^[1-9][0-9]*$/.test(input.agreementAppId) ||
        BigInt(input.agreementAppId) > 0xffffffffffffffffn)
    )
      throw new Error('Invalid agreement application ID.');
  }
  if (type === 'createSwapInvite') {
    const input = params as Record<string, unknown> | null;
    if (input && input.deadlineUnit !== 'round')
      throw new Error(
        'Legacy timestamp invitations are no longer supported for new swaps. Request round-based terms.',
      );
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'algoAmount,deadlineUnit,t0,t1,xmrAmount' ||
      ![input.algoAmount, input.xmrAmount].every(
        (amount) =>
          typeof amount === 'string' &&
          /^[1-9][0-9]{0,19}$/.test(amount) &&
          BigInt(amount) <= 0xffffffffffffffffn,
      ) ||
      !Number.isSafeInteger(input.t0) ||
      (input.t0 as number) <= 0 ||
      !Number.isSafeInteger(input.t1) ||
      (input.t1 as number) <= (input.t0 as number) ||
      (input.t1 as number) > 8640000000000
    )
      throw new Error('Invalid swap invite terms.');
  }
  if (type === 'acceptSwapInvite' || type === 'confirmSwapAcceptance') {
    const input = params as { link?: unknown } | null;
    if (
      !input ||
      Object.keys(input).join(',') !== 'link' ||
      typeof input.link !== 'string' ||
      input.link.length > 12512
    )
      throw new Error('Invalid swap invite link.');
  }
  if (type === 'saveLeakSwap') {
    const settlementTxId = (params as { settlementTxId?: unknown } | null)?.settlementTxId;
    if (
      settlementTxId !== undefined &&
      (typeof settlementTxId !== 'string' || !/^[A-Z2-7]{52}$/.test(settlementTxId))
    )
      throw new Error('Invalid settlement transaction ID.');
    const input = params as { appId?: unknown; combinedAddress?: unknown } | null;
    if (
      !input ||
      typeof input.appId !== 'string' ||
      !/^[1-9][0-9]*$/.test(input.appId) ||
      BigInt(input.appId) > 0xffffffffffffffffn ||
      typeof input.combinedAddress !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(input.combinedAddress)
    )
      throw new Error('Invalid swap identity.');
  }
}

export function fundingRestoreHeight(
  explicit: number | undefined,
  remembered: number | undefined,
): number {
  const height = explicit ?? remembered ?? 0;
  if (!Number.isInteger(height) || height < 0 || height > 0xffffffff) {
    throw new Error('Restore height must be a u32 integer.');
  }
  return height;
}

export function validateFundingParams(
  params: unknown,
): asserts params is ZebgenScanCombinedMoneroFundingParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Funding scan parameters are required.');
  }
  const input = params as Record<string, unknown>;
  for (const field of ['counterpartyPrivateViewKey', 'counterpartyPublicSpendKey']) {
    if (typeof input[field] !== 'string' || !/^[0-9a-f]{64}$/i.test(input[field])) {
      throw new Error(`${field} must be a 32-byte hex key.`);
    }
  }
  if (
    input.moneroWalletId !== undefined &&
    (!Number.isSafeInteger(input.moneroWalletId) ||
      ((input.moneroWalletId as number) < 0 && !input.agreementDigest))
  ) {
    throw new Error('Monero wallet ID must be a non-negative safe integer.');
  }
  if (input.restoreHeight !== undefined) {
    if (typeof input.restoreHeight !== 'number')
      throw new Error('Restore height must be a u32 integer.');
    fundingRestoreHeight(input.restoreHeight, undefined);
  }
}
