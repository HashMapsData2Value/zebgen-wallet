import { browser } from 'wxt/browser';

import type {
  MoneroDaemonProbeResult,
  ScanMoneroBalanceRequest,
  ScanMoneroBalanceResult,
} from '../monero/moneroDaemon';
import type { MoneroNetworkConfig } from './networks';
import type { PrepareTransactionRequest, TransactionResponse } from '../wallet/transactionService';
import type { TransactionStatus, TransactionStatusRequest } from '../wallet/transactionStatus';

// Messages exchanged between the popup and the background service worker. The
// popup uses `import type` only, so no heavy background/monero code leaks into
// the popup bundle.

export interface ProbeMoneroDaemonMessage {
  type: 'monero:probeDaemon';
  config: MoneroNetworkConfig;
}

export interface ScanMoneroBalanceMessage {
  type: 'monero:scanBalance';
  request: ScanMoneroBalanceRequest;
}

export type BackgroundMessage =
  | ProbeMoneroDaemonMessage
  | ScanMoneroBalanceMessage
  | { type: 'wallet:transactionStatus'; request: TransactionStatusRequest }
  | { type: 'wallet:prepareTransaction'; request: PrepareTransactionRequest }
  | { type: 'wallet:submitTransaction'; id: string; lockSecret: string }
  | { type: 'wallet:discardTransactions' };

export function prepareTransactionViaBackground(
  request: PrepareTransactionRequest,
): Promise<TransactionResponse> {
  return browser.runtime.sendMessage({ type: 'wallet:prepareTransaction', request });
}

export function submitTransactionViaBackground(
  id: string,
  lockSecret: string,
): Promise<TransactionResponse> {
  return browser.runtime.sendMessage({ type: 'wallet:submitTransaction', id, lockSecret });
}

export function discardTransactionsViaBackground(): Promise<unknown> {
  return browser.runtime.sendMessage({ type: 'wallet:discardTransactions' });
}

export function transactionStatusViaBackground(
  request: TransactionStatusRequest,
): Promise<{ ok: true; status: TransactionStatus } | { ok: false; error: string }> {
  return browser.runtime.sendMessage({ type: 'wallet:transactionStatus', request });
}

export interface BalanceScanControl {
  signal?: AbortSignal;
  detachSignal?: AbortSignal;
  onProgress?: (progress: {
    scannedHeight: number;
    targetHeight: number;
    spans?: { start: number; end: number }[];
  }) => void;
}

export async function isMoneroScanActive(key: string): Promise<boolean> {
  const response = await browser.runtime.sendMessage({ type: 'monero:scanStatus', key });
  return response?.active === true;
}

export async function scanMoneroBalanceViaBackground(
  request: ScanMoneroBalanceRequest,
  control?: BalanceScanControl,
): Promise<ScanMoneroBalanceResult> {
  control?.signal?.throwIfAborted();
  const port = browser.runtime.connect({ name: 'monero:balanceScan' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const heartbeat = globalThis.setInterval(() => {
      try {
        port.postMessage({ type: 'keepalive' });
      } catch (error) {
        finish(undefined, error);
      }
    }, 10000);
    const finish = (result?: ScanMoneroBalanceResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.clearInterval(heartbeat);
      control?.signal?.removeEventListener('abort', abort);
      control?.detachSignal?.removeEventListener('abort', detach);
      port.disconnect();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => {
      if (control?.signal?.reason === 'detach') {
        detach();
        return;
      }
      try {
        port.postMessage({ type: 'stop' });
      } catch (error) {
        console.error('Unable to stop Monero scan', error);
      } finally {
        finish(undefined, new DOMException('Scan stopped.', 'AbortError'));
      }
    };
    const detach = () => finish(undefined, new DOMException('Scan viewer closed.', 'AbortError'));
    port.onDisconnect.addListener(() => {
      const reason = browser.runtime.lastError?.message;
      const error = new Error(
        reason
          ? `Scan connection closed: ${reason} Reload the Zebgen extension and reopen the wallet.`
          : 'Scan connection closed. Reopen the wallet and try again.',
      );
      if (!settled) console.error('Monero balance scan disconnected', error);
      finish(undefined, error);
    });
    port.onMessage.addListener((message) => {
      if (settled) return;
      if (message.type === 'progress') {
        try {
          control?.onProgress?.(message.progress);
        } catch (error) {
          finish(undefined, error);
        }
      } else if (message.type === 'result') finish(message.result);
    });
    control?.signal?.addEventListener('abort', abort, { once: true });
    control?.detachSignal?.addEventListener('abort', detach, { once: true });
    if (control?.detachSignal?.aborted) {
      detach();
      return;
    }
    if (control?.signal?.aborted) {
      abort();
      return;
    }
    try {
      port.postMessage({ request });
    } catch (error) {
      finish(undefined, error);
    }
  });
}
export type ProbeMoneroDaemonResponse = MoneroDaemonProbeResult;

export async function probeMoneroDaemonViaBackground(
  config: MoneroNetworkConfig,
): Promise<ProbeMoneroDaemonResponse> {
  const message: ProbeMoneroDaemonMessage = { type: 'monero:probeDaemon', config };
  return browser.runtime.sendMessage(message);
}
