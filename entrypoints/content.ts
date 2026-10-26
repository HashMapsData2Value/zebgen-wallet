import { browser } from 'wxt/browser';

import { PROVIDER_PAGE_MATCHES } from '../lib/provider/pageMatches';
import { validateProviderRequest } from '../lib/provider/fundingValidation';
import { isValidRequestId } from '../lib/provider/requestSafety';
import type {
  ZebgenBackgroundRequest,
  ZebgenBackgroundResponse,
  ZebgenPageRequest,
  ZebgenPageResponse,
} from '../lib/provider/types';

// Isolated-world relay between the page's `window.zebgen` provider (defined by
// the MAIN-world `zebgenInject` content script) and the privileged background
// script. Runs in the extension's isolated world, so it has runtime messaging
// access but cannot see or be seen by the page's own JS objects directly.
export default defineContentScript({
  matches: PROVIDER_PAGE_MATCHES,
  main() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) {
        return;
      }
      const data = event.data as ZebgenPageRequest | undefined;
      if (!data || data.source !== 'zebgen-page' || !isValidRequestId(data.id)) {
        return;
      }

      try {
        validateProviderRequest(data.type, data.params);
      } catch (error) {
        postResponse(data.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }

      const request: ZebgenBackgroundRequest = {
        channel: 'zebgen-provider',
        id: data.id,
        type: data.type,
        params: data.params,
        origin: window.location.origin,
      };

      browser.runtime.sendMessage(request).then(
        (response: ZebgenBackgroundResponse) => postResponse(data.id, response),
        (err: unknown) =>
          postResponse(data.id, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
      );
    });
  },
});

function postResponse(id: string, response: ZebgenBackgroundResponse) {
  const message: ZebgenPageResponse = {
    source: 'zebgen-content',
    id,
    ok: response.ok,
    result: response.result,
    error: response.error,
  };
  window.postMessage(message, window.location.origin);
}
