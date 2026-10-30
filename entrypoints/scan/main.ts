import { browser } from 'wxt/browser';
import './style.css';

type ScanState = {
  key: string;
  address: string;
  progress?: { scannedHeight: number; targetHeight: number };
  result?: { ok: boolean; error?: string };
};
let states: ScanState[] = [];
const status = document.querySelector<HTMLElement>('#status')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const scans = document.createElement('div');
scans.className = 'scan-list';
document.querySelector('main')!.append(scans);
function renderScans() {
  const active = states.filter((job) => !job.result).length;
  status.textContent = active
    ? `${active} active scan${active === 1 ? '' : 's'}`
    : states.length
      ? 'All scans finished'
      : 'Waiting for scan...';
  stop.disabled = active === 0;
  scans.replaceChildren(
    ...states.map((job) => {
      const row = document.createElement('section');
      row.className = 'scan-row';
      const address = document.createElement('p');
      address.className = 'scan-address';
      address.textContent = job.address;
      const progress = document.createElement('p');
      progress.textContent = job.result
        ? job.result.ok
          ? 'Scan complete'
          : (job.result.error ?? 'Scan failed')
        : job.progress
          ? `Block ${job.progress.scannedHeight.toLocaleString()} / ${job.progress.targetHeight.toLocaleString()}`
          : 'Starting scan...';
      row.append(address, progress);
      if (!job.result) {
        const button = document.createElement('button');
        button.textContent = 'Stop scan';
        button.addEventListener('click', () => stopScan(job.key));
        row.append(button);
      }
      return row;
    }),
  );
}
function stopScan(key: string) {
  void browser.runtime.sendMessage({ type: 'monero:scanStop', key }).catch(console.error);
}
document.querySelector('#stop')!.addEventListener('click', () => {
  for (const job of states) if (!job.result) stopScan(job.key);
});
stop.textContent = 'Stop all scans';
renderScans();
void navigator.locks
  .request('zebgen-monero-scan-host', { ifAvailable: true }, async (lock) => {
    if (!lock) {
      status.textContent = 'A scan tab is already open';
      return;
    }
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.tab ||
        (sender.url !== browser.runtime.getURL('/background.js') &&
          sender.url !==
            new URL('_generated_background_page.html', browser.runtime.getURL('/')).href)
      )
        return false;
      if (message?.type === 'monero:scanDisplay' && Array.isArray(message.states)) {
        states = message.states;
        renderScans();
        return false;
      }
      if (message?.type === 'monero:hostRequest') {
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
    setInterval(() => {
      void browser.runtime.sendMessage({ type: 'monero:scanHeartbeat' }).catch(console.error);
    }, 10000);
    await browser.runtime.sendMessage({ type: 'monero:scanHostReady' });
    const response = await browser.runtime.sendMessage({ type: 'monero:scanDisplayStatus' });
    states = response?.states ?? [];
    renderScans();
    await new Promise<void>(() => {});
  })
  .catch((error) => {
    console.error('Monero scan host failed', error);
    status.textContent = 'Scan host failed';
  });
