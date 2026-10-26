// Shared types for the page-facing Zebgen wallet provider (`window.zebgen`).
// Messages cross two boundaries:
//   page <---postMessage---> content script <---runtime messaging---> background
// Keep every payload JSON-serializable (no class instances, bigint, etc.).

export type ZebgenRequestType =
  | 'connect'
  | 'getAlgorandAddress'
  | 'getMoneroShareInfo'
  | 'computeCombinedMoneroAddress'
  | 'scanCombinedMoneroFunding'
  | 'saveLeakSwap'
  | 'depositLeakSwapMonero'
  | 'settleLeakSwap'
  | 'recoverLeakSwapMonero'
  | 'listLeakSwaps'
  | 'createSwapInvite'
  | 'acceptSwapInvite'
  | 'confirmSwapAcceptance'
  | 'signAlgorandTransactions'
  | 'computeMoneroLeakySignature';

export interface ZebgenConnectResult {
  algoAddress: string | null;
  moneroAddress: string | null;
}

export interface ZebgenSaveLeakSwapParams {
  settlementTxId?: string;
  agreementDigest?: string;
  appId: string;
  combinedAddress: string;
}

export interface ZebgenDepositLeakSwapMoneroParams {
  agreementDigest: string;
  appId: string;
}

export interface ZebgenDepositLeakSwapMoneroResult {
  transactionHash: string;
  amountAtomic: string;
  feeAtomic: string;
  accountStatus?: 'changed';
}

export interface ZebgenSavedLeakSwap {
  deadlineUnit: 'round';
  createdRound: number;
  settlement?: { kind: 'claim' | 'refund' | 'punish'; txId: string; confirmedRound: string };
  agreement?: import('leakswap-utils/dist/swapAgreement.js').SwapAgreement;
  appId: string;
  appAddress: string;
  genesisHash: string;
  role: 'ali' | 'xin';
  algoAddress: string;
  counterpartyAlgoAddress: string;
  t0: number;
  t1: number;
  restoreHeight: number;
  counterpartyPublicSpendKey: string;
  counterpartyPrivateViewKey: string;
  shareInfo: ZebgenGetMoneroShareInfoResult;
  combined: ZebgenComputeCombinedMoneroAddressResult;
  signedTransactions: { txId: string; method: string | null }[];
}

export interface ZebgenGetAlgorandAddressParams {
  addressIndex?: number;
}

export interface ZebgenGetAlgorandAddressResult {
  algoAddress: string;
  addressIndex: number;
}

export interface ZebgenGetMoneroShareInfoParams {
  agreementDigest?: string;
  moneroWalletId?: number;
}

export interface ZebgenGetMoneroShareInfoResult {
  address: string;
  publicSpendKey: string;
  privateViewKey: string;
}

export interface ZebgenComputeCombinedMoneroAddressParams {
  agreementDigest?: string;
  moneroWalletId?: number;
  counterpartyPrivateViewKey: string;
  counterpartyPublicSpendKey: string;
}

export interface ZebgenComputeCombinedMoneroAddressResult {
  combinedAddress: string;
  combinedPublicSpendKey: string;
  combinedPublicViewKey: string;
}

export interface ZebgenScanCombinedMoneroFundingParams extends ZebgenComputeCombinedMoneroAddressParams {
  restoreHeight?: number;
}

export interface ZebgenScanCombinedMoneroFundingResult {
  combinedAddress: string;
  receivedAtomic: string;
  matureAtomic: string;
  lockedAtomic: string;
  scannedHeight: number;
  spentStatusKnown: false;
}

// Generic Algorand transaction signing primitive. `txns` is the *entire*
// atomic group (base64 of `algosdk.encodeUnsignedTransaction`, in group
// order); `indexesToSign` names which of those transactions the caller wants
// this wallet to sign (all assumed to belong to the same `addressIndex`).
// The page is responsible for submitting the signed group to the network -
// zebgen only ever signs, it never broadcasts on the page's behalf.
export interface ZebgenSignAlgorandTransactionsParams {
  agreementDigest?: string;
  agreementAppId?: string;
  addressIndex?: number;
  txns: string[];
  indexesToSign: number[];
}

export interface ZebgenSignAlgorandTransactionsResult {
  // Base64-encoded signed transaction bytes, one per entry of
  // `indexesToSign`, in the same order.
  signedTxns: string[];
}

// Produces the LeakSwap protocol's "leaky" signature over an arbitrary
// message (in practice, the LeakSwap contract's application address) using
// the active Monero wallet's private spend key. Submitting this signature
// on-chain deliberately discloses that private key, so this is the most
// sensitive operation the wallet can perform - it must always go through
// the popup approval flow, never a fast path.
export interface ZebgenComputeMoneroLeakySignatureParams {
  agreementDigest?: string;
  agreementAppId?: string;
  moneroWalletId?: number;
  messageHex: string;
}

export interface ZebgenComputeMoneroLeakySignatureResult {
  signatureHex: string;
}

// Page -> content script (window.postMessage)
export interface ZebgenPageRequest {
  source: 'zebgen-page';
  id: string;
  type: ZebgenRequestType;
  params: unknown;
}

export interface ZebgenPageResponse {
  source: 'zebgen-content';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// Content script -> background (runtime messaging)
export interface ZebgenBackgroundRequest {
  channel: 'zebgen-provider';
  id: string;
  type: ZebgenRequestType;
  params: unknown;
  origin: string;
}

export interface ZebgenBackgroundResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// A request parked in the background service worker while an approval popup
// window is open, waiting on the user.
export interface PendingZebgenRequest {
  id: string;
  type: ZebgenRequestType;
  params: unknown;
  origin: string;
  createdAt: number;
}

// Background <-> popup approval window messages.
export interface GetPendingRequestMessage {
  channel: 'zebgen-pending';
  action: 'get';
  id: string;
}

export interface ResolvePendingRequestMessage {
  channel: 'zebgen-pending';
  action: 'resolve';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type PendingRequestMessage = GetPendingRequestMessage | ResolvePendingRequestMessage;

export interface GetPendingRequestResponse {
  ok: boolean;
  request?: PendingZebgenRequest;
  originApproved?: boolean;
  error?: string;
}
