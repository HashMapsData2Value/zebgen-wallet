import initMoneroWasm, {
  createTransaction,
  daemonHeight,
  primaryAddress,
  publicKeyFromPrivate,
  scanBalanceBatch,
  sweepTransaction,
} from 'zebgen-monero-wasm';
import moneroWasmUrl from 'zebgen-monero-wasm/zebgen_monero_wasm_bg.wasm?url&no-inline';
import * as moneroWasm from 'zebgen-monero-wasm';

import { networkLabel, type MoneroNetworkConfig } from '../network/networks';
import { unlockMoneroWallet } from '../wallet/moneroVault';
import {
  balanceCheckpointKey,
  coverageCheckpointKey,
  saveBalanceCheckpoint,
  scanSpans,
  moneroUnlocks,
  type MoneroUnlock,
  type ScanSpan,
} from '../wallet/moneroBalanceCache';
import { loadScanCheckpoint, saveScanCheckpoint } from '../wallet/moneroScanCheckpoint';
import { setMoneroScanRestoreHeight } from '../wallet/db';

let wasmReady: Promise<unknown> | undefined;
let diagnosticMemory: WebAssembly.Memory | undefined;
function loadMoneroWasm(): Promise<unknown> {
  // Explicit URL: the bundled service worker has no usable import.meta.url.
  wasmReady ??= initMoneroWasm({ module_or_path: moneroWasmUrl }).then((module) => {
    if (import.meta.env.MODE === 'e2e') {
      (
        moneroWasm as unknown as { setDiagnosticsEnabled?: (enabled: boolean) => void }
      ).setDiagnosticsEnabled?.(true);
      diagnosticMemory = module.memory;
    }
    return module;
  });
  return wasmReady;
}

export const initializeMoneroWasm = loadMoneroWasm;

export interface MoneroFundingResult {
  receivedAtomic: string;
  matureAtomic: string;
  lockedAtomic: string;
  scannedHeight: number;
  spentStatusKnown: false;
}

export interface MoneroFundingControl {
  signal?: AbortSignal;
  onProgress?: (progress: {
    scannedHeight: number;
    targetHeight: number;
    startHeight?: number;
    spans?: ScanSpan[];
  }) => void;
}

export async function scanMoneroFunding(
  config: MoneroNetworkConfig,
  publicSpendKey: string,
  privateViewKey: string,
  restoreHeight: number,
  control?: MoneroFundingControl,
): Promise<MoneroFundingResult> {
  if (!Number.isInteger(restoreHeight) || restoreHeight < 0 || restoreHeight > 0xffffffff) {
    throw new Error('Restore height must be a u32 integer.');
  }
  await verifyMoneroNetwork(config);
  control?.signal?.throwIfAborted();
  const scan = (
    moneroWasm as unknown as {
      scanFunding?: (
        url: string,
        user: string | undefined,
        pass: string | undefined,
        publicSpendKey: string,
        privateViewKey: string,
        restoreHeight: number,
        control?: MoneroFundingControl,
      ) => Promise<MoneroFundingResult>;
    }
  ).scanFunding;
  if (!scan)
    throw new Error('The Monero WASM library needs the scanFunding update to check funding.');
  control?.signal?.throwIfAborted();
  if (control?.onProgress) {
    const targetHeight = await daemonHeight(...daemonConnection(config));
    control.signal?.throwIfAborted();
    control.onProgress({ scannedHeight: restoreHeight, targetHeight, startHeight: restoreHeight });
  }
  const result = await scan(
    ...daemonConnection(config),
    publicSpendKey,
    privateViewKey,
    restoreHeight,
    control
      ? {
          ...control,
          onProgress: (progress) =>
            control.onProgress?.({ ...progress, startHeight: restoreHeight }),
        }
      : undefined,
  );
  return {
    receivedAtomic: result.receivedAtomic,
    matureAtomic: result.matureAtomic,
    lockedAtomic: result.lockedAtomic,
    scannedHeight: result.scannedHeight,
    spentStatusKnown: false,
  };
}

export async function verifyMoneroNetwork(config: MoneroNetworkConfig): Promise<string> {
  await loadMoneroWasm();
  const detect = (
    moneroWasm as unknown as {
      daemonNetwork?: (url: string, username?: string, password?: string) => Promise<string>;
    }
  ).daemonNetwork;
  if (!detect)
    throw new Error(
      'The Monero WASM library needs the daemonNetwork update to verify the connected chain.',
    );
  const actual = await detect(...daemonConnection(config));
  if (actual !== config.network)
    throw new Error(
      `Network mismatch: selected ${networkLabel(config.network)}, daemon reports ${networkLabel(actual)}. Select the matching network in Settings.`,
    );
  if (
    actual === 'regtest' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.daemon.uri).hostname)
  ) {
    throw new Error('Local Regtest requires a loopback daemon endpoint.');
  }
  return actual;
}

function daemonConnection(
  config: MoneroNetworkConfig,
): [string, string | undefined, string | undefined] {
  return [
    config.daemon.uri,
    config.daemon.username || undefined,
    config.daemon.password || undefined,
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MoneroDaemonProbeResult {
  ok: boolean;
  height?: number;
  error?: string;
  network?: string;
}

export interface ScanMoneroBalanceRequest {
  config: MoneroNetworkConfig;
  walletId: number;
  lockSecret: string;
  primaryAddress: string;
  restoreHeight: number;
}

export interface ScanMoneroBalanceResult {
  ok: boolean;
  balanceAtomic?: string;
  lockedAtomic?: string;
  unlocks?: MoneroUnlock[];
  spans?: ScanSpan[];
  error?: string;
}

const activeBalanceScans = new Set<string>();

export async function scanMoneroBalance(
  request: ScanMoneroBalanceRequest,
  control?: MoneroFundingControl,
): Promise<ScanMoneroBalanceResult> {
  const identity = coverageCheckpointKey(
    request.config.network,
    request.config.daemon.uri,
    request.primaryAddress,
  );
  let acquired = false;
  try {
    if (activeBalanceScans.has(identity))
      throw new Error(
        'A scan for this wallet is already running. Stop it before changing the scan range.',
      );
    activeBalanceScans.add(identity);
    acquired = true;
    control?.signal?.throwIfAborted();
    await verifyMoneroNetwork(request.config);
    control?.signal?.throwIfAborted();
    if (diagnosticMemory)
      console.log('[monero-wasm] balance memory before scan:', diagnosticMemory.buffer.byteLength);
    if (
      !Number.isSafeInteger(request.restoreHeight) ||
      request.restoreHeight < 0 ||
      request.restoreHeight > 0xffffffff
    ) {
      throw new Error('Restore height must be a non-negative integer.');
    }
    const material = await unlockMoneroWallet(
      request.lockSecret,
      request.config.networkType,
      request.walletId,
    );
    control?.signal?.throwIfAborted();
    if (!material || material.address !== request.primaryAddress)
      throw new Error('Wallet address changed. Refresh the wallet and try again.');
    const currentHeight = await daemonHeight(...daemonConnection(request.config));
    if (request.restoreHeight > currentHeight)
      throw new Error('Restore height is beyond the daemon height.');
    if (request.walletId >= 0)
      await setMoneroScanRestoreHeight(
        request.walletId,
        request.config.network,
        request.restoreHeight,
      );
    await loadMoneroWasm();
    let checkpoint = await loadScanCheckpoint(identity, request.lockSecret);
    checkpoint ??= await loadScanCheckpoint(
      balanceCheckpointKey(
        request.config.network,
        request.config.daemon.uri,
        request.primaryAddress,
        request.restoreHeight,
      ),
      request.lockSecret,
    );
    let balanceAtomic = '0';
    let lockedAtomic = '0';
    let unlocks: MoneroUnlock[] | undefined;
    let spans: ScanSpan[] = [];
    for (;;) {
      control?.signal?.throwIfAborted();
      const result = JSON.parse(
        await scanBalanceBatch(
          ...daemonConnection(request.config),
          material.privateSpendKey,
          material.privateViewKey,
          request.restoreHeight,
          checkpoint === undefined ? undefined : JSON.stringify(checkpoint),
          { signal: control?.signal },
        ),
      );
      if (result.checkpoint?.version !== 2 || typeof result.lockedAtomic !== 'string')
        throw new Error(
          'Update the Monero WASM scanner to use locked balances and scanned block spans.',
        );
      if (
        !Number.isSafeInteger(result.scannedHeight) ||
        !Number.isSafeInteger(result.targetHeight) ||
        typeof result.done !== 'boolean' ||
        typeof result.balanceAtomic !== 'string' ||
        !/^\d+$/.test(result.balanceAtomic) ||
        typeof result.lockedAtomic !== 'string' ||
        !/^\d+$/.test(result.lockedAtomic)
      )
        throw new Error('Invalid Monero scan batch result.');
      spans = scanSpans(result.checkpoint.spans);
      unlocks = result.unlocks === undefined ? undefined : moneroUnlocks(result.unlocks);
      await saveScanCheckpoint(identity, result.checkpoint, request.lockSecret);
      checkpoint = result.checkpoint;
      control?.onProgress?.({
        scannedHeight: result.scannedHeight,
        targetHeight: result.targetHeight,
        startHeight: request.restoreHeight,
        spans,
      });
      if (result.done) {
        balanceAtomic = result.balanceAtomic;
        lockedAtomic = result.lockedAtomic;
        await saveBalanceCheckpoint(
          identity,
          {
            balanceAtomic,
            lockedAtomic,
            unlocks,
            spans,
            scannedHeight: result.scannedHeight,
            scannedAt: Date.now(),
            resumable: true,
          },
          request.lockSecret,
        );
        break;
      }
    }
    control?.signal?.throwIfAborted();
    if (diagnosticMemory)
      console.log('[monero-wasm] balance memory after scan:', diagnosticMemory.buffer.byteLength);
    return { ok: true, balanceAtomic, lockedAtomic, spans, unlocks };
  } catch (error) {
    console.error('scanMoneroBalance failed', error);
    return { ok: false, error: errorMessage(error) };
  } finally {
    if (acquired) activeBalanceScans.delete(identity);
  }
}

export interface CreateMoneroTransactionRequest {
  config: MoneroNetworkConfig;
  walletId?: number;
  lockSecret?: string;
  primaryAddress: string;
  privateSpendKey: string;
  privateViewKey: string;
  recipient: string;
  // Ignored when `sweep` is true.
  amountAtomic: string;
  // Send the whole unlocked balance minus the fee.
  sweep?: boolean;
  restoreHeight: number;
  relay: boolean;
}

export interface CreateMoneroTransactionResult {
  ok: boolean;
  hash?: string;
  feeAtomic?: string;
  amountAtomic?: string;
  balanceAtomic?: string;
  relayed?: boolean;
  error?: string;
  txHex?: string;
}

interface PreparedMoneroTransaction {
  hash: string;
  feeAtomic: string;
  amountAtomic: string;
  balanceAtomic: string;
  relayed: boolean;
  txHex: string;
  checkpoint?: string;
}

export async function probeMoneroDaemon(
  config: MoneroNetworkConfig,
): Promise<MoneroDaemonProbeResult> {
  try {
    const network = await verifyMoneroNetwork(config);
    const height = await daemonHeight(...daemonConnection(config));
    return { ok: true, height, network };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function createMoneroTransaction(
  request: CreateMoneroTransactionRequest,
): Promise<CreateMoneroTransactionResult> {
  if (request.relay) {
    return {
      ok: false,
      error:
        'Prepare the transaction without relay, then use the separately reviewed send operation.',
    };
  }
  if (!Number.isInteger(request.restoreHeight) || request.restoreHeight < 0) {
    return { ok: false, error: 'Restore height must be a non-negative integer.' };
  }

  let checkpointIdentity: string | undefined;
  try {
    await verifyMoneroNetwork(request.config);
    const amountAtomic = request.sweep ? 0n : BigInt(request.amountAtomic);
    if (!request.sweep && amountAtomic <= 0n) {
      return { ok: false, error: 'Amount must be greater than zero.' };
    }
    await loadMoneroWasm();

    const derivedAddress = primaryAddress(
      request.config.networkType,
      publicKeyFromPrivate(request.privateSpendKey),
      request.privateViewKey,
    );
    if (derivedAddress !== request.primaryAddress) {
      return { ok: false, error: 'Wallet keys do not match the wallet address.' };
    }

    const checkpointApi = moneroWasm as unknown as { transactionCheckpointVersion?: () => number };
    let checkpoint: unknown;
    if (checkpointApi.transactionCheckpointVersion?.() === 2) {
      if (request.walletId === undefined || !request.lockSecret)
        throw new Error(
          'Wallet identity and unlock secret are required for cached transaction preparation.',
        );
      const identity = coverageCheckpointKey(
        request.config.network,
        request.config.daemon.uri,
        request.primaryAddress,
      );
      if (!(await loadScanCheckpoint(identity, request.lockSecret))) {
        const refreshed = await scanMoneroBalance({
          config: request.config,
          walletId: request.walletId,
          lockSecret: request.lockSecret,
          primaryAddress: request.primaryAddress,
          restoreHeight: request.restoreHeight,
        });
        if (!refreshed.ok)
          throw new Error(refreshed.error ?? 'Unable to refresh spendable outputs.');
      }
      if (activeBalanceScans.has(identity))
        throw new Error('A scan for this wallet is already running. Try again when it finishes.');
      activeBalanceScans.add(identity);
      checkpointIdentity = identity;
      checkpoint = await loadScanCheckpoint(identity, request.lockSecret);
      if (!checkpoint) throw new Error('Missing spendable output checkpoint after refresh.');
    }

    const wallet = [
      ...daemonConnection(request.config),
      request.config.networkType,
      request.privateSpendKey,
      request.privateViewKey,
      request.restoreHeight,
      request.recipient,
    ] as const;
    const transaction: PreparedMoneroTransaction = request.sweep
      ? await (sweepTransaction as (...args: unknown[]) => Promise<PreparedMoneroTransaction>)(
          ...wallet,
          request.relay,
          checkpoint === undefined ? undefined : JSON.stringify(checkpoint),
        )
      : await (createTransaction as (...args: unknown[]) => Promise<PreparedMoneroTransaction>)(
          ...wallet,
          amountAtomic.toString(),
          request.relay,
          checkpoint === undefined ? undefined : JSON.stringify(checkpoint),
        );
    if (checkpointIdentity && request.lockSecret) {
      if (!transaction.checkpoint)
        throw new Error('Transaction builder did not return its updated scan checkpoint.');
      await saveScanCheckpoint(
        checkpointIdentity,
        JSON.parse(transaction.checkpoint),
        request.lockSecret,
      );
    }
    return {
      ok: true,
      hash: transaction.hash,
      feeAtomic: transaction.feeAtomic,
      amountAtomic: transaction.amountAtomic,
      balanceAtomic: transaction.balanceAtomic,
      relayed: transaction.relayed,
      txHex: transaction.txHex,
    };
  } catch (err) {
    console.error('createMoneroTransaction failed', err);
    return { ok: false, error: errorMessage(err) };
  } finally {
    if (checkpointIdentity) activeBalanceScans.delete(checkpointIdentity);
  }
}
