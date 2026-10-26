import { browser } from 'wxt/browser';

import { probeMoneroDaemon, scanMoneroBalance } from '../lib/monero/moneroDaemon';
import type { BackgroundMessage } from '../lib/network/messages';
import { approveOrigin, isOriginApproved } from '../lib/provider/originApproval';
import {
  approveConnection,
  assertConnectionAccounts,
  connectedAccounts,
  publicConnectionAccounts,
  type ConnectionAccounts,
} from '../lib/provider/connectionApproval';
import { activateConnectionSelection } from '../lib/provider/connectionSelection';
import { validateProviderRequest } from '../lib/provider/fundingValidation';
import {
  assertAgreementBound,
  assertProviderSender,
  isValidRequestId,
} from '../lib/provider/requestSafety';
import type {
  PendingRequestMessage,
  PendingZebgenRequest,
  ZebgenBackgroundRequest,
  ZebgenBackgroundResponse,
  ZebgenDepositLeakSwapMoneroParams,
  ZebgenDepositLeakSwapMoneroResult,
} from '../lib/provider/types';
import {
  discardPreparedTransactions,
  prepareTransaction,
  submitPreparedTransaction,
  isSubmittedDepositResult,
} from '../lib/wallet/transactionService';
import { readTransactionStatus } from '../lib/wallet/transactionStatus';
import { ScanJobs, scanJobKey } from '../lib/monero/scanJobs';

// Requests parked while an approval popup window is open, waiting on the
// user. Module-level state is fine here: an in-flight async onMessage
// listener keeps the MV3 service worker alive until sendResponse fires.
const pendingRequests = new Map<
  string,
  PendingZebgenRequest & { connectionAccounts?: ConnectionAccounts }
>();
const pendingResolvers = new Map<string, (response: ZebgenBackgroundResponse) => void>();
const activeRequestIds = new Set<string>();

export default defineBackground(() => {
  const viewers = new Map<string, Set<{ postMessage: (message: unknown) => void }>>();
  const jobs = new ScanJobs(scanMoneroBalance, (key, event) => {
    for (const viewer of viewers.get(key) ?? []) {
      try {
        viewer.postMessage(event);
      } catch {
        viewers.get(key)?.delete(viewer);
      }
    }
    void browser.runtime.sendMessage({ type: 'monero:scanDisplay', states: jobs.states })
      .catch((error) => console.error('Scan display notification failed', error));
  });
  let hostReady: (() => void) | undefined;
  let openingHost: Promise<void> | undefined;
  async function sendHost(message: unknown): Promise<void> {
    try {
      const response = await browser.runtime.sendMessage(message);
      if (response?.ok) return;
    } catch {
      /* A scan host is opened below when no receiver exists. */
    }
    if (!openingHost) {
      openingHost = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          hostReady = undefined;
          reject(new Error('Monero scan tab did not start.'));
        }, 30000);
        hostReady = () => {
          clearTimeout(timer);
          resolve();
        };
        void browser.tabs
          .create({ url: browser.runtime.getURL('/scan.html'), active: false })
          .catch(reject);
      }).finally(() => {
        openingHost = undefined;
      });
    }
    await openingHost;
    const response = await browser.runtime.sendMessage(message);
    if (!response?.ok) throw new Error('Monero scan tab is unavailable.');
  }
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'monero:balanceScan') return;
    const sender = port.sender;
    if (sender?.id !== browser.runtime.id ||
      !(['/popup.html', '/dashboard.html'] as const).some((path) =>
        sender.url?.split(/[?#]/)[0] === browser.runtime.getURL(path))) {
      port.disconnect();
      return;
    }
    let key: string | undefined;
    let started = false;
    let stopRequested = false;
    port.onDisconnect.addListener(() => {
      if (key) {
        viewers.get(key)?.delete(port);
        if (!viewers.get(key)?.size) viewers.delete(key);
      }
    });
    port.onMessage.addListener((message) => {
      if (message?.type === 'keepalive') return;
      if (message?.type === 'stop') {
        stopRequested = true;
        if (key) jobs.stop(key);
        return;
      }
      if (started) return;
      started = true;
      key = scanJobKey(message.request);
      const subscribers = viewers.get(key) ?? new Set();
      subscribers.add(port);
      viewers.set(key, subscribers);
      void sendHost({ type: 'monero:hostRequest', action: 'start' })
        .then(async () => {
          if (stopRequested) return;
          jobs.start(message.request);
          await browser.runtime.sendMessage({ type: 'monero:scanDisplay', states: jobs.states });
        })
        .catch((error) => {
          console.error('Balance scan connection failed', error);
          try {
            port.postMessage({ type: 'result', result: errorResponse(error) });
          } catch {
            /* Viewer closed. */
          }
        });
    });
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const internalSender =
      sender.id === browser.runtime.id &&
      Boolean(sender.url?.startsWith(browser.runtime.getURL('/')));
    if (internalSender && sender.url?.split(/[?#]/)[0] === browser.runtime.getURL('/scan.html')) {
      if (message?.type === 'monero:scanHostReady') {
        hostReady?.();
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === 'monero:scanHeartbeat') {
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === 'monero:scanStop') {
        if (typeof message.key === 'string') jobs.stop(message.key);
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === 'monero:scanDisplayStatus') {
        sendResponse({ states: jobs.states });
        return false;
      }
      return false;
    }
    if (isProviderRequest(message)) {
      handleProviderRequest(message, sender)
        .then(sendResponse)
        .catch((error) => {
          console.error('Zebgen provider request failed', error);
          sendResponse(errorResponse(error));
        });
      return true;
    }
    if (isPendingRequestMessage(message)) {
      if (!internalSender) return false;
      handlePendingRequestMessage(message).then(sendResponse);
      return true;
    }

    const backgroundMessage = message as BackgroundMessage;
    if (!internalSender) {
      return false;
    }
    const owner = `${sender.documentId ?? sender.tab?.id ?? 'popup'}:${sender.url}`;
    if (message?.type === 'monero:scanStatus') {
      sendResponse({ active: jobs.isActive(message.key) });
      return false;
    }
    if (backgroundMessage?.type === 'wallet:transactionStatus') {
      readTransactionStatus(backgroundMessage.request)
        .then((status) => sendResponse({ ok: true, status }))
        .catch((error) => {
          console.error('Transaction status lookup failed', error);
          sendResponse(errorResponse(error));
        });
      return true;
    }
    if (backgroundMessage?.type === 'wallet:prepareTransaction') {
      prepareTransaction(owner, backgroundMessage.request)
        .then(sendResponse)
        .catch((error) => sendResponse(errorResponse(error)));
      return true;
    }
    if (backgroundMessage?.type === 'wallet:submitTransaction') {
      submitPreparedTransaction(owner, backgroundMessage.id, backgroundMessage.lockSecret)
        .then(sendResponse)
        .catch((error) => sendResponse(errorResponse(error)));
      return true;
    }
    if (backgroundMessage?.type === 'wallet:discardTransactions') {
      discardPreparedTransactions(owner);
      sendResponse({ ok: true });
      return false;
    }
    if (backgroundMessage?.type === 'monero:scanBalance') {
      scanMoneroBalance(backgroundMessage.request)
        .then(sendResponse)
        .catch((error) => sendResponse(errorResponse(error)));
      return true;
    }
    if (backgroundMessage?.type === 'monero:probeDaemon') {
      probeMoneroDaemon(backgroundMessage.config)
        .then(sendResponse)
        .catch((err) => sendResponse(errorResponse(err)));
      // Keep the message channel open for the async response.
      return true;
    }
    return false;
  });
});

function isProviderRequest(message: unknown): message is ZebgenBackgroundRequest {
  return Boolean(message) && (message as ZebgenBackgroundRequest).channel === 'zebgen-provider';
}

function isPendingRequestMessage(message: unknown): message is PendingRequestMessage {
  return Boolean(message) && (message as PendingRequestMessage).channel === 'zebgen-pending';
}

function errorResponse(err: unknown) {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

async function handleProviderRequest(
  request: ZebgenBackgroundRequest,
  sender: Parameters<typeof assertProviderSender>[1],
): Promise<ZebgenBackgroundResponse> {
  try {
    assertProviderSender(request.origin, sender, browser.runtime.id);
  } catch (error) {
    return errorResponse(error);
  }
  if (!isValidRequestId(request.id) || activeRequestIds.has(request.id)) {
    return errorResponse(new Error('Invalid or duplicate request id.'));
  }
  activeRequestIds.add(request.id);
  try {
    validateProviderRequest(request.type, request.params);
    assertAgreementBound(request.type, request.params);
    if (request.type !== 'connect') {
      await assertConnectionAccounts(request.origin, request.params);
    }
    return await openApprovalWindow(request);
  } catch (error) {
    console.error('Zebgen provider request failed', error);
    return errorResponse(error);
  } finally {
    activeRequestIds.delete(request.id);
  }
}

async function openApprovalWindow(
  request: ZebgenBackgroundRequest,
): Promise<ZebgenBackgroundResponse> {
  const pending: PendingZebgenRequest & { connectionAccounts?: ConnectionAccounts } = {
    id: request.id,
    type: request.type,
    params: request.params,
    origin: request.origin,
    createdAt: Date.now(),
    connectionAccounts:
      request.type === 'connect'
        ? undefined
        : ((await connectedAccounts(request.origin)) ?? undefined),
  };
  pendingRequests.set(request.id, pending);

  const responsePromise = new Promise<ZebgenBackgroundResponse>((resolve) => {
    pendingResolvers.set(request.id, resolve);
  });

  const popupUrl = browser.runtime.getURL(`/popup.html?zebgenRequestId=${request.id}`);
  let win;
  try {
    win = await browser.windows.create({ url: popupUrl, type: 'popup', width: 380, height: 640 });
  } catch (error) {
    pendingRequests.delete(request.id);
    pendingResolvers.delete(request.id);
    console.error('Zebgen approval window could not be opened', error);
    return errorResponse(error);
  }

  const onApprovalClosed = (windowId: number) => {
    if (windowId === win?.id)
      pendingResolvers.get(request.id)?.({
        ok: false,
        error:
          request.type === 'depositLeakSwapMonero'
            ? 'Deposit window closed. Check outgoing activity before retrying if Send was pressed.'
            : 'Approval window closed. Request cancelled.',
      });
  };
  browser.windows.onRemoved.addListener(onApprovalClosed);
  const response = await responsePromise;
  browser.windows.onRemoved.removeListener(onApprovalClosed);
  pendingRequests.delete(request.id);
  pendingResolvers.delete(request.id);
  if (win?.id !== undefined) {
    browser.windows.remove(win.id).catch(() => undefined);
  }
  return response;
}

async function handlePendingRequestMessage(message: PendingRequestMessage): Promise<unknown> {
  if (message.action === 'get') {
    const pending = pendingRequests.get(message.id);
    if (!pending) {
      return { ok: false, error: 'This request is no longer available.' };
    }
    return { ok: true, request: pending, originApproved: await isOriginApproved(pending.origin) };
  }

  // action === 'resolve'
  const pending = pendingRequests.get(message.id);
  let result = message.result;
  try {
    if (message.ok && pending) {
      if (pending.type === 'connect') {
        const accounts = message.result as ConnectionAccounts;
        await activateConnectionSelection(accounts);
        await approveConnection(pending.origin, accounts);
        result = publicConnectionAccounts(accounts);
        await approveOrigin(pending.origin);
      } else if (pending.type === 'settleLeakSwap') {
        const receipt = result as { txId?: unknown; confirmedRound?: unknown } | undefined;
        if (
          !receipt ||
          typeof receipt.txId !== 'string' ||
          !/^[A-Z2-7]{52}$/.test(receipt.txId) ||
          typeof receipt.confirmedRound !== 'string' ||
          !/^[1-9][0-9]*$/.test(receipt.confirmedRound)
        ) {
          throw new Error('Invalid settlement receipt.');
        }
        result = { txId: receipt.txId, confirmedRound: receipt.confirmedRound };
        try {
          await assertConnectionAccounts(
            pending.origin,
            pending.params,
            pending.connectionAccounts,
          );
        } catch (error) {
          console.error('Accounts changed after settlement; preserving confirmed receipt', error);
        }
      } else if (pending.type === 'depositLeakSwapMonero') {
        if (
          !isSubmittedDepositResult(
            pending.params as ZebgenDepositLeakSwapMoneroParams,
            result as ZebgenDepositLeakSwapMoneroResult,
          )
        ) {
          throw new Error(
            'No matching submitted deposit receipt is available. Check outgoing activity before depositing again.',
          );
        }
        try {
          await assertConnectionAccounts(
            pending.origin,
            pending.params,
            pending.connectionAccounts,
          );
        } catch (error) {
          console.error('Accounts changed after deposit relay; preserving receipt', error);
          result = { ...(result as ZebgenDepositLeakSwapMoneroResult), accountStatus: 'changed' };
        }
      } else {
        await assertConnectionAccounts(pending.origin, pending.params, pending.connectionAccounts);
      }
    }
  } catch (error) {
    const failure = errorResponse(error);
    pendingResolvers.get(message.id)?.(failure);
    return failure;
  }
  pendingResolvers.get(message.id)?.({ ok: message.ok, result, error: message.error });
  return { ok: true };
}
