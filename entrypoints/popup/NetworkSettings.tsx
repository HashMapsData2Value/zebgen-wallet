import { useState } from 'react';

import { probeAlgod, probeIndexer } from '../../lib/algorand/algodClient';
import { ensureHostPermissions } from '../../lib/network/hostPermissions';
import { probeMoneroDaemonViaBackground } from '../../lib/network/messages';
import {
  ALGORAND_NETWORK_IDS,
  MONERO_NETWORK_IDS,
  cloneAlgorandPreset,
  cloneMoneroPreset,
  networkColor,
  networkLabel,
  type AlgorandNetworkId,
  type MoneroNetworkId,
  type NetworkSettings,
} from '../../lib/network/networks';

type ProbeState = { status: 'idle' | 'testing' | 'ok' | 'error'; message?: string };

const IDLE: ProbeState = { status: 'idle' };

interface NetworkSettingsPanelProps {
  chain: 'algorand' | 'monero';
  settings: NetworkSettings;
  onChange: (next: NetworkSettings) => void;
}

function NetworkSettingsPanel({ chain, settings, onChange }: NetworkSettingsPanelProps) {
  const [algodProbe, setAlgodProbe] = useState<ProbeState>(IDLE);
  const [indexerProbe, setIndexerProbe] = useState<ProbeState>(IDLE);
  const [daemonProbe, setDaemonProbe] = useState<ProbeState>(IDLE);

  function update(mutate: (draft: NetworkSettings) => void) {
    const next = structuredClone(settings);
    mutate(next);
    onChange(next);
  }

  function onSelectAlgorandNetwork(network: AlgorandNetworkId) {
    update((draft) => {
      draft.algorand = cloneAlgorandPreset(network);
    });
    setAlgodProbe(IDLE);
    setIndexerProbe(IDLE);
  }

  function onSelectMoneroNetwork(network: MoneroNetworkId) {
    update((draft) => {
      draft.monero = cloneMoneroPreset(network);
    });
    setDaemonProbe(IDLE);
  }

  function parsePort(value: string): number | '' {
    if (value.trim() === '') {
      return '';
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : '';
  }

  async function onTestAlgod() {
    setAlgodProbe({ status: 'testing' });
    try {
      await ensureHostPermissions([settings.algorand.algod.server]);
    } catch (err) {
      setAlgodProbe({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const result = await probeAlgod(settings.algorand.algod, settings.algorand.network);
    setAlgodProbe(
      result.ok
        ? { status: 'ok', message: `${networkLabel(result.network ?? '')} · ${result.genesisId} · last round ${result.lastRound}` }
        : { status: 'error', message: result.error ?? 'Connection failed.' }
    );
  }

  async function onTestIndexer() {
    setIndexerProbe({ status: 'testing' });
    try {
      await ensureHostPermissions([settings.algorand.indexer.server]);
    } catch (err) {
      setIndexerProbe({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const result = await probeIndexer(settings.algorand.indexer);
    setIndexerProbe(
      result.ok
        ? { status: 'ok', message: `Connected · round ${result.round}` }
        : { status: 'error', message: result.error ?? 'Connection failed.' }
    );
  }

  async function onTestDaemon() {
    setDaemonProbe({ status: 'testing' });
    try {
      await ensureHostPermissions([settings.monero.daemon.uri]);
      const result = await probeMoneroDaemonViaBackground(settings.monero);
      setDaemonProbe(
        result.ok
          ? { status: 'ok', message: `${networkLabel(result.network ?? '')} · height ${result.height}` }
          : { status: 'error', message: result.error ?? 'Connection failed.' }
      );
    } catch (err) {
      setDaemonProbe({
        status: 'error',
        message: err instanceof Error ? err.message : 'Connection failed.',
      });
    }
  }

  const { algorand, monero } = settings;

  function tabStyle(active: boolean, id: string) {
    if (!active) {
      return undefined;
    }
    const color = networkColor(id);
    return { borderColor: color, color, boxShadow: `0 0 0 1px ${color}, 0 0 12px ${color}55` };
  }

  if (chain === 'algorand') {
    return (
      <section className="card net-section">
        <h3 className="net-heading">Algorand Network</h3>
        <div className="net-tabs" role="group" aria-label="Algorand network">
          {ALGORAND_NETWORK_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`choice-button net-tab${algorand.network === id ? ' net-tab-active' : ''}`}
              style={tabStyle(algorand.network === id, id)}
              onClick={() => onSelectAlgorandNetwork(id)}
            >
              {id}
            </button>
          ))}
        </div>

        <p className="net-subheading">Algod daemon</p>
        <label className="net-label">Server</label>
        <input
          value={algorand.algod.server}
          onChange={(event) => update((draft) => void (draft.algorand.algod.server = event.target.value))}
          placeholder="https://host or http://localhost"
        />
        <div className="net-row">
          <div className="net-col">
            <label className="net-label">Port</label>
            <input
              value={algorand.algod.port === '' ? '' : String(algorand.algod.port)}
              onChange={(event) => update((draft) => void (draft.algorand.algod.port = parsePort(event.target.value)))}
              placeholder="4001"
              inputMode="numeric"
            />
          </div>
          <div className="net-col">
            <label className="net-label">Token</label>
            <input
              value={algorand.algod.token}
              onChange={(event) => update((draft) => void (draft.algorand.algod.token = event.target.value))}
              placeholder="API token"
            />
          </div>
        </div>
        <button type="button" className="secondary" onClick={onTestAlgod} disabled={algodProbe.status === 'testing'}>
          {algodProbe.status === 'testing' ? 'Testing...' : 'Test Algod'}
        </button>
        {algodProbe.status === 'ok' ? <p className="probe-ok">{algodProbe.message}</p> : null}
        {algodProbe.status === 'error' ? <p className="probe-error">{algodProbe.message}</p> : null}

        <p className="net-subheading">Indexer</p>
        <label className="net-label">Server</label>
        <input
          value={algorand.indexer.server}
          onChange={(event) => update((draft) => void (draft.algorand.indexer.server = event.target.value))}
          placeholder="https://host or http://localhost"
        />
        <div className="net-row">
          <div className="net-col">
            <label className="net-label">Port</label>
            <input
              value={algorand.indexer.port === '' ? '' : String(algorand.indexer.port)}
              onChange={(event) => update((draft) => void (draft.algorand.indexer.port = parsePort(event.target.value)))}
              placeholder="8980"
              inputMode="numeric"
            />
          </div>
          <div className="net-col">
            <label className="net-label">Token</label>
            <input
              value={algorand.indexer.token}
              onChange={(event) => update((draft) => void (draft.algorand.indexer.token = event.target.value))}
              placeholder="API token"
            />
          </div>
        </div>
        <button type="button" className="secondary" onClick={onTestIndexer} disabled={indexerProbe.status === 'testing'}>
          {indexerProbe.status === 'testing' ? 'Testing...' : 'Test Indexer'}
        </button>
        {indexerProbe.status === 'ok' ? <p className="probe-ok">{indexerProbe.message}</p> : null}
        {indexerProbe.status === 'error' ? <p className="probe-error">{indexerProbe.message}</p> : null}
      </section>
    );
  }

  return (
    <section className="card net-section">
      <h3 className="net-heading">Monero Network</h3>
      <div className="net-tabs" role="group" aria-label="Monero network">
        {MONERO_NETWORK_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`choice-button net-tab${monero.network === id ? ' net-tab-active' : ''}`}
            style={tabStyle(monero.network === id, id)}
            onClick={() => onSelectMoneroNetwork(id)}
          >
            {networkLabel(id)}
          </button>
        ))}
      </div>

      {monero.network === 'regtest' ? <p className="privacy-notice">Local simulated chain. Test coins only. Addresses use mainnet encoding.</p> : null}
      <p className="net-subheading">Daemon RPC</p>
      <p className="hint net-hint">
        Connect to your own local Monero node, or use the node provided with the wallet. Routing
        over Tor or I2P is not available in-extension — run your browser or node through Tor if you
        need that.
      </p>
      <label className="net-label">URI</label>
      <input
        value={monero.daemon.uri}
        onChange={(event) => update((draft) => void (draft.monero.daemon.uri = event.target.value))}
        placeholder="http://127.0.0.1:18081"
      />

      <div className="net-row">
        <div className="net-col">
          <label className="net-label">Username (optional)</label>
          <input
            value={monero.daemon.username ?? ''}
            onChange={(event) => update((draft) => void (draft.monero.daemon.username = event.target.value))}
            placeholder="rpc user"
          />
        </div>
        <div className="net-col">
          <label className="net-label">Password (optional)</label>
          <input
            type="password"
            value={monero.daemon.password ?? ''}
            onChange={(event) => update((draft) => void (draft.monero.daemon.password = event.target.value))}
            placeholder="rpc password"
          />
        </div>
      </div>
      <button type="button" className="secondary" onClick={onTestDaemon} disabled={daemonProbe.status === 'testing'}>
        {daemonProbe.status === 'testing' ? 'Testing...' : 'Test Daemon'}
      </button>
      {daemonProbe.status === 'ok' ? <p className="probe-ok">{daemonProbe.message}</p> : null}
      {daemonProbe.status === 'error' ? <p className="probe-error">{daemonProbe.message}</p> : null}
    </section>
  );
}

export default NetworkSettingsPanel;
