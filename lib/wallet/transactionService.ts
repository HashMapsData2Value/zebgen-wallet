import * as moneroWasm from 'zebgen-monero-wasm';
import { browser } from 'wxt/browser';
import {
  createMoneroTransaction,
  initializeMoneroWasm,
  verifyMoneroNetwork,
} from '../monero/moneroDaemon';
import type { AlgodEndpoint, AlgorandNetworkId, MoneroNetworkConfig } from '../network/networks';
import { prepareAlgoPayment, submitAlgoPayment, unlockWallet } from './algoWallet';
import { unlockMoneroWallet } from './moneroVault';
import { activityScope, saveMoneroActivity, type MoneroActivity } from './moneroActivity';
import {
  resolveLeakSwapDeposit,
  assertSameDepositTarget,
  type LeakSwapDepositTarget,
} from './leakSwapDeposit';
import {
  loadDepositAttempt,
  reserveDepositAttempt,
  updateDepositAttempt,
  type DepositAttempt,
} from './depositAttempt';
import type {
  ZebgenDepositLeakSwapMoneroParams,
  ZebgenDepositLeakSwapMoneroResult,
} from '../provider/types';

export type PrepareTransactionRequest = {
  primaryAddress: string;
  recipient: string;
  amountAtomic: string;
  lockSecret: string;
} & (
  | {
      chain: 'algorand';
      addressIndex: number;
      endpoint: AlgodEndpoint;
      network: AlgorandNetworkId;
      note?: string;
    }
  | {
      chain: 'monero';
      walletId: number;
      config: MoneroNetworkConfig;
      restoreHeight: number;
      sweep: boolean;
      deposit?: LeakSwapDepositTarget;
    }
);

export interface TransactionReview {
  id: string;
  hash: string;
  amountAtomic: string;
  feeAtomic: string;
  expiresAt: number;
}

export type TransactionResponse =
  | { ok: true; review: TransactionReview }
  | {
      ok: false;
      error: string;
      uncertain?: boolean;
      code?: 'review-expired' | 'deposit-exists';
      attempt?: DepositAttempt;
      review?: TransactionReview;
    };

type PreparedTransaction = { review: TransactionReview; owner: string; submitting: boolean } & (
  | { chain: 'algorand'; endpoint: AlgodEndpoint; signed: Uint8Array }
  | {
      chain: 'monero';
      address: string;
      config: MoneroNetworkConfig;
      txHex: string;
      deposit?: LeakSwapDepositTarget;
    }
);

const preparedTransactions = new Map<string, PreparedTransaction>();
const generations = new Map<string, number>();
const EXPIRY_MS = 10 * 60 * 1000;
const depositReceipts = new Map<
  string,
  { binding: ZebgenDepositLeakSwapMoneroParams; result: ZebgenDepositLeakSwapMoneroResult }
>();

export function isSubmittedDepositResult(
  params: ZebgenDepositLeakSwapMoneroParams,
  result: ZebgenDepositLeakSwapMoneroResult,
): boolean {
  const receipt = result && depositReceipts.get(result.transactionHash);
  return Boolean(
    receipt &&
      receipt.binding.agreementDigest === params.agreementDigest &&
      receipt.binding.appId === params.appId &&
      receipt.result.amountAtomic === result.amountAtomic &&
      receipt.result.feeAtomic === result.feeAtomic,
  );
}

function existingDeposit(attempt: DepositAttempt): TransactionResponse {
  return {
    ok: false,
    code: 'deposit-exists',
    uncertain: true,
    attempt,
    error: `Deposit attempt ${attempt.state}: ${attempt.hash}. Do not deposit again. Check outgoing activity and the swap deposit before continuing.`,
  };
}

function pruneExpired() {
  for (const [id, transaction] of preparedTransactions) {
    if (!transaction.submitting && transaction.review.expiresAt <= Date.now())
      preparedTransactions.delete(id);
  }
}

export function discardPreparedTransactions(owner: string) {
  generations.set(owner, (generations.get(owner) ?? 0) + 1);
  for (const [id, transaction] of preparedTransactions) {
    if (transaction.owner === owner && !transaction.submitting) preparedTransactions.delete(id);
  }
}

type RelayFunction = (
  url: string,
  username: string | undefined,
  password: string | undefined,
  txHex: string,
) => Promise<string>;

function relayFunction(): RelayFunction {
  const relay = (moneroWasm as unknown as { relayTransaction?: RelayFunction }).relayTransaction;
  if (!relay)
    throw new Error('The installed Monero WASM library needs the relayTransaction update.');
  return relay;
}

export async function prepareTransaction(
  owner: string,
  request: PrepareTransactionRequest,
): Promise<TransactionResponse> {
  pruneExpired();
  if (
    [...preparedTransactions.values()].some(
      (transaction) => transaction.owner === owner && transaction.submitting,
    )
  ) {
    return { ok: false, error: 'A transaction is already being broadcast.' };
  }
  discardPreparedTransactions(owner);
  const generation = generations.get(owner);
  try {
    let prepared: PreparedTransaction;
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + EXPIRY_MS;
    if (request.chain === 'algorand') {
      const transaction = await prepareAlgoPayment(
        request.lockSecret,
        request.addressIndex,
        request.recipient,
        BigInt(request.amountAtomic),
        request.endpoint,
        request.note,
        request.network,
      );
      if (transaction.sender !== request.primaryAddress)
        throw new Error('Sender account changed. Prepare the transaction again.');
      prepared = {
        chain: 'algorand',
        owner,
        submitting: false,
        endpoint: request.endpoint,
        signed: transaction.signed,
        review: {
          id,
          hash: transaction.txId,
          amountAtomic: request.amountAtomic,
          feeAtomic: transaction.feeMicroAlgos.toString(),
          expiresAt,
        },
      };
    } else {
      if (request.walletId < 0)
        throw new Error('LeakSwap key shares cannot be used as payment wallets.');
      if (request.deposit) {
        const { agreementDigest, appId } = request.deposit.binding;
        const current = await resolveLeakSwapDeposit(
          { agreementDigest, appId },
          request.lockSecret,
        );
        assertSameDepositTarget(request.deposit, current);
        if (
          request.sweep ||
          request.primaryAddress !== current.sender ||
          request.recipient !== current.recipient ||
          request.amountAtomic !== current.amountAtomic ||
          request.walletId !== current.walletId ||
          JSON.stringify(request.config) !== JSON.stringify(current.config) ||
          request.restoreHeight !== current.restoreHeight
        ) {
          throw new Error('Deposit payment does not match its verified agreement.');
        }
        const existing = await loadDepositAttempt(
          browser.storage.local,
          current.binding,
          request.lockSecret,
        );
        if (existing) return existingDeposit(existing);
      }
      relayFunction();
      const material = await unlockMoneroWallet(
        request.lockSecret,
        request.config.networkType,
        request.walletId,
      );
      if (!material || material.address !== request.primaryAddress)
        throw new Error('Sender wallet changed. Prepare the transaction again.');
      const transaction = await createMoneroTransaction({
        ...request,
        privateSpendKey: material.privateSpendKey,
        privateViewKey: material.privateViewKey,
        relay: false,
      });
      if (
        !transaction.ok ||
        !transaction.txHex ||
        !transaction.hash ||
        !transaction.amountAtomic ||
        !transaction.feeAtomic
      ) {
        throw new Error(transaction.error ?? 'Unable to prepare Monero transaction.');
      }
      prepared = {
        chain: 'monero',
        address: request.primaryAddress,
        owner,
        submitting: false,
        config: request.config,
        txHex: transaction.txHex,
        deposit: request.deposit,
        review: {
          id,
          hash: transaction.hash,
          amountAtomic: transaction.amountAtomic,
          feeAtomic: transaction.feeAtomic,
          expiresAt,
        },
      };
      if (request.deposit && transaction.amountAtomic !== request.deposit.amountAtomic)
        throw new Error('Prepared deposit amount does not match the agreement.');
    }
    if (generations.get(owner) !== generation)
      throw new Error('Transaction preparation was cancelled.');
    prepared.review.expiresAt = Date.now() + EXPIRY_MS;
    preparedTransactions.set(id, prepared);
    return { ok: true, review: prepared.review };
  } catch (error) {
    console.error('Transaction preparation failed', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function submitPreparedTransaction(
  owner: string,
  id: string,
  lockSecret: string,
): Promise<TransactionResponse> {
  pruneExpired();
  const transaction = preparedTransactions.get(id);
  if (!transaction || transaction.owner !== owner)
    return {
      ok: false,
      code: 'review-expired',
      error: 'Transaction expired or was cancelled. Review it again.',
    };
  if (transaction.submitting)
    return { ok: false, error: 'Transaction is already being broadcast.' };
  transaction.submitting = true;
  let activity: MoneroActivity | undefined;
  let relayAttempted = false;
  let depositAttempt: DepositAttempt | undefined;
  try {
    await unlockWallet(lockSecret);
    if (
      preparedTransactions.get(id) !== transaction ||
      transaction.review.expiresAt <= Date.now()
    ) {
      preparedTransactions.delete(id);
      return {
        ok: false,
        code: 'review-expired',
        error: 'Transaction expired or was cancelled. Review it again.',
      };
    }
    let hash: string;
    if (transaction.chain === 'algorand') {
      hash = await submitAlgoPayment(transaction.endpoint, transaction.signed);
    } else {
      await initializeMoneroWasm();
      await verifyMoneroNetwork(transaction.config);
      const daemon = transaction.config.daemon;
      const relay = relayFunction();
      if (transaction.deposit) {
        const { agreementDigest, appId } = transaction.deposit.binding;
        const current = await resolveLeakSwapDeposit({ agreementDigest, appId }, lockSecret);
        assertSameDepositTarget(transaction.deposit, current);
      }
      activity = {
        ...activityScope(transaction.address, transaction.config),
        hash: transaction.review.hash,
        amountAtomic: transaction.review.amountAtomic,
        feeAtomic: transaction.review.feeAtomic,
        createdAt: Date.now(),
        state: 'relaying',
      };
      await saveMoneroActivity(browser.storage.local, activity, lockSecret);
      if (transaction.deposit) {
        if (transaction.review.expiresAt <= Date.now()) {
          preparedTransactions.delete(id);
          return {
            ok: false,
            code: 'review-expired',
            error: 'Transaction expired. Review it again.',
          };
        }
        const attempt: DepositAttempt = {
          binding: transaction.deposit.binding,
          hash: transaction.review.hash,
          amountAtomic: transaction.review.amountAtomic,
          feeAtomic: transaction.review.feeAtomic,
          state: 'relaying',
        };
        const existing = await reserveDepositAttempt(browser.storage.local, attempt, lockSecret);
        if (existing) {
          preparedTransactions.delete(id);
          return existingDeposit(existing);
        }
        depositAttempt = attempt;
      }
      relayAttempted = true;
      hash = await relay(
        daemon.uri,
        daemon.username || undefined,
        daemon.password || undefined,
        transaction.txHex,
      );
    }
    if (hash !== transaction.review.hash)
      throw new Error(
        'Daemon returned an unexpected transaction hash. Check the reviewed transaction before retrying.',
      );
    if (activity)
      await saveMoneroActivity(
        browser.storage.local,
        { ...activity, state: 'submitted' },
        lockSecret,
      );
    if (depositAttempt) {
      await updateDepositAttempt(
        browser.storage.local,
        { ...depositAttempt, state: 'submitted' },
        lockSecret,
      );
      depositReceipts.set(transaction.review.hash, {
        binding: depositAttempt.binding,
        result: {
          transactionHash: transaction.review.hash,
          amountAtomic: transaction.review.amountAtomic,
          feeAtomic: transaction.review.feeAtomic,
        },
      });
    }
    preparedTransactions.delete(id);
    return { ok: true, review: transaction.review };
  } catch (error) {
    console.error('Transaction broadcast failed', error);
    if (relayAttempted && activity) {
      preparedTransactions.delete(id);
      try {
        await saveMoneroActivity(
          browser.storage.local,
          { ...activity, state: 'unknown' },
          lockSecret,
        );
      } catch (storageError) {
        console.error('Unable to persist uncertain Monero relay outcome', storageError);
      }
      if (depositAttempt) {
        try {
          await updateDepositAttempt(
            browser.storage.local,
            { ...depositAttempt, state: 'unknown' },
            lockSecret,
          );
        } catch (storageError) {
          console.error('Unable to persist uncertain deposit outcome', storageError);
        }
      }
      return {
        ok: false,
        uncertain: true,
        review: transaction.review,
        error: `Relay outcome unknown: ${transaction.review.hash}. Check outgoing activity before creating another payment.`,
      };
    }
    transaction.submitting = false;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
