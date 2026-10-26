import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { RefreshCw } from 'lucide-react';
import type { MoneroNetworkConfig } from '../../lib/network/networks';
import { transactionStatusViaBackground } from '../../lib/network/messages';
import { activityScope, loadMoneroActivity, MONERO_ACTIVITY_PREFIX, type MoneroActivity as Activity } from '../../lib/wallet/moneroActivity';
import type { TransactionStatus } from '../../lib/wallet/transactionStatus';
import { formatAtomic } from '../../lib/wallet/formatAtomic';
import CopyValue from './CopyValue';
import MoneroConfirmation from './MoneroConfirmation';

export function activityStatusLabel(activity: Activity, receipt?: TransactionStatus): string {
  if (receipt?.state === 'confirmed') return `Confirmed in block ${receipt.block}${receipt.confirmations === undefined ? ' (confirmation count unavailable)' : ` (${receipt.confirmations} confirmations)`}`;
  if (receipt?.state === 'pool') return 'In transaction pool (0 confirmations)';
  if (receipt?.state === 'unknown') return 'Unknown: not found by this daemon';
  if (activity.state === 'submitted') return 'Submitted; confirmation not yet checked';
  if (activity.state === 'relaying') return 'Relay started; outcome not yet known';
  return 'Unknown relay outcome';
}

export default function MoneroActivity({ address, config, lockSecret }: {
  address: string; config: MoneroNetworkConfig; lockSecret: string;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [receipts, setReceipts] = useState<Record<string, TransactionStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const scopeKey = JSON.stringify(activityScope(address, config));
  const configKey = JSON.stringify(config);

  useEffect(() => {
    let active = true;
    let busy = false;
    let dirty = false;
    setActivities([]);
    setReceipts({});
    setErrors({});
    async function load() {
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const saved = await loadMoneroActivity(browser.storage.local, activityScope(address, config), lockSecret);
        if (active) { setActivities(saved); setError(null); }
      } catch (failure) {
        console.error('Unable to load outgoing Monero activity', failure);
        if (active) setError('Outgoing activity could not be decrypted or loaded.');
      } finally {
        busy = false;
        if (active && dirty) { dirty = false; void load(); }
      }
    }
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.keys(changes).some(key => key.startsWith(MONERO_ACTIVITY_PREFIX))) void load();
    };
    browser.storage.onChanged.addListener(changed);
    void load();
    return () => { active = false; browser.storage.onChanged.removeListener(changed); };
  }, [scopeKey, lockSecret, refresh]);

  useEffect(() => {
    let active = true;
    let busy = false;
    async function check() {
      if (busy || !activities.length) return;
      busy = true;
      try {
        for (const activity of activities) {
          if (!active) break;
          try {
            const response = await transactionStatusViaBackground({ chain: 'monero', config, hash: activity.hash });
            if (!response.ok) throw new Error(response.error);
            if (active) {
              setReceipts(previous => ({ ...previous, [activity.hash]: response.status }));
              setErrors(previous => ({ ...previous, [activity.hash]: '' }));
            }
          } catch (failure) {
            console.error('Outgoing Monero status lookup failed', failure);
            if (active) setErrors(previous => ({ ...previous, [activity.hash]: 'Status unavailable; last observation may be stale.' }));
          }
        }
      } finally { busy = false; }
    }
    void check();
    const timer = window.setInterval(check, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [activities, configKey, refresh]);

  return <div className="monero-outgoing-activity">
    <h3>Outgoing Activity <button type="button" className="refresh-btn" title="Refresh outgoing activity" aria-label="Refresh outgoing activity" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button></h3>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {!error && !activities.length ? <p className="hint">No outgoing activity for this wallet and daemon.</p> : null}
    {activities.map(activity => <div className="transaction-result" key={activity.hash} role="status">
      <h4>{formatAtomic(activity.amountAtomic, 12)} XMR</h4>
      <p>{activityStatusLabel(activity, receipts[activity.hash])}</p>
      <MoneroConfirmation network={config.network} status={receipts[activity.hash]} />
      {errors[activity.hash] ? <p className="error">{errors[activity.hash]}</p> : null}
      <details>
        <summary>Transaction details</summary>
        <dl>
          <dt>Sent</dt><dd>{new Date(activity.createdAt).toLocaleString()}</dd>
          <dt>Network fee</dt><dd>{formatAtomic(activity.feeAtomic, 12)} XMR</dd>
          <dt>Transaction hash</dt><dd><code style={{ overflowWrap: 'anywhere' }}>{activity.hash}</code><CopyValue label="Transaction hash" value={activity.hash} /></dd>
        </dl>
      </details>
    </div>)}
  </div>;
}