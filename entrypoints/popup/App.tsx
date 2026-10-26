import './App.css';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { browser } from 'wxt/browser';
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  LockKeyhole,
  Maximize2,
  Plus,
  Settings,
} from 'lucide-react';

import algorandLogo from '../../assets/algorand_logo.png';
import moneroLogo from '../../assets/monero_logo.png';

import {
  createWalletLock,
  deriveActiveSeedAlgoAddressAtIndex,
  getAlgoDerivationPath,
  getSignedInState,
  getWalletLockState,
  importAlgoMnemonic,
  listAlgoWallets,
  selectAlgoWallet,
  unlockWallet,
} from '../../lib/wallet/algoWallet';
import {
  computeCombinedAddressFromPublicKeys,
  computeCombinedAddressWithPrivateAndPublic,
  generateMoneroKeyMaterial,
  getMoneroKeyMaterialFromPrivateSpendKey,
  type MoneroKeyMaterial,
} from '../../lib/wallet/moneroWallet';
import {
  getMoneroWalletState,
  listMoneroCombinedContexts,
  loadMoneroCombinedContext,
  saveMoneroWallet,
  unlockMoneroWallet,
  type MoneroWalletSummary,
} from '../../lib/wallet/moneroVault';
import {
  moneroMnemonicToPrivateKey,
  privateKeyToMoneroMnemonic,
} from '../../lib/wallet/moneroMnemonic';
import {
  cloneAlgorandPreset,
  cloneMoneroPreset,
  type AlgorandNetworkId,
  type MoneroNetworkId,
  type NetworkSettings,
} from '../../lib/network/networks';
import { getNetworkSettings, saveNetworkSettings } from '../../lib/network/networkStore';
import { currentRestoreHeight, generatedWalletRestoreHeights } from '../../lib/monero/restoreHeight';
import { sanitizeBlockHeight, walletRestoreHeight } from '../../lib/monero/scanHeight';
import { recoverCombinedWallet } from '../../lib/wallet/combinedRecovery';
import type { CombinedAddressContext } from '../../lib/wallet/combinedAddressContext';
import AlgorandAddressCard from './AlgorandAddressCard';
import MoneroAddressCard from './MoneroAddressCard';
import MoneroActivity from './MoneroActivity';
import MoneroKeyList from './MoneroKeyList';
import NetworkSettingsPanel from './NetworkSettings';
import RevealSeedPhrase from './RevealSeedPhrase';
import TransactionBuilder from './TransactionBuilder';
import LeakSwapPanel from './LeakSwapPanel';
import MoneroRecovery from './MoneroRecovery';
import Receive from './Receive';
import CopyValue from './CopyValue';
import { discardTransactionsViaBackground } from '../../lib/network/messages';
import { getAlgoBalance } from '../../lib/algorand/algodClient';

const IDLE_LOCK_MS = 10 * 60 * 1000;

interface AppProps {
  variant?: 'popup' | 'full';
}

function App({ variant = 'popup' }: AppProps) {
  const [selectedWalletType, setSelectedWalletType] = useState<'algorand' | 'monero' | 'leakswap'>(
    'algorand',
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isLockConfigured, setIsLockConfigured] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [algoAddress, setAlgoAddress] = useState<string | null>(null);
  const [addressIndex, setAddressIndex] = useState(0);
  const [lastAddressIndex, setLastAddressIndex] = useState(0);
  const [mnemonicMode, setMnemonicMode] = useState<'generate' | 'existing' | null>(null);
  const [generatedMnemonic, setGeneratedMnemonic] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [setupSecret, setSetupSecret] = useState('');
  const [setupSecretConfirm, setSetupSecretConfirm] = useState('');
  const [unlockSecret, setUnlockSecret] = useState('');
  const [sessionLockSecret, setSessionLockSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSettingLock, setIsSettingLock] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isDerivingAddress, setIsDerivingAddress] = useState(false);
  const [algorandView, setAlgorandView] = useState<
    'wallet' | 'add' | 'transaction' | 'receive' | 'settings'
  >('wallet');
  const [moneroWallets, setMoneroWallets] = useState<MoneroWalletSummary[]>([]);
  const [activeMoneroWalletId, setActiveMoneroWalletId] = useState<number | null>(null);
  const [moneroMaterial, setMoneroMaterial] = useState<MoneroKeyMaterial | null>(null);
  const [moneroSetupMode, setMoneroSetupMode] = useState<'generate' | 'import' | null>(null);
  const [moneroView, setMoneroView] = useState<
    'wallet' | 'add' | 'combine' | 'recover' | 'settings' | 'transaction' | 'receive'
  >('wallet');
  const [importedPrivateSpendKey, setImportedPrivateSpendKey] = useState('');
  const [moneroHistory, setMoneroHistory] = useState<'unused' | 'used'>('used');
  const [moneroScanStart, setMoneroScanStart] = useState<'' | 'full' | 'height'>('');
  const [importRestoreHeight, setImportRestoreHeight] = useState('0');
  const [counterpartyPrivateSpendKey, setCounterpartyPrivateSpendKey] = useState('');
  const [recoveredMaterial, setRecoveredMaterial] = useState<MoneroKeyMaterial | null>(null);
  const [recoveryContexts, setRecoveryContexts] = useState<CombinedAddressContext[]>([]);
  const [recoveryAddress, setRecoveryAddress] = useState('');
  const [isLoadingRecovery, setIsLoadingRecovery] = useState(false);
  const [counterpartyPrivateViewKey, setCounterpartyPrivateViewKey] = useState('');
  const [counterpartyPublicSpendKey, setCounterpartyPublicSpendKey] = useState('');
  const [publicSpendKeyA, setPublicSpendKeyA] = useState('');
  const [publicViewKeyA, setPublicViewKeyA] = useState('');
  const [publicSpendKeyB, setPublicSpendKeyB] = useState('');
  const [publicViewKeyB, setPublicViewKeyB] = useState('');
  const [combinedAddressFromPriv, setCombinedAddressFromPriv] = useState('');
  const [combinedAddressFromPublic, setCombinedAddressFromPublic] = useState('');
  const [networkSettings, setNetworkSettings] = useState<NetworkSettings | null>(null);
  const [algoWallets, setAlgoWallets] = useState<
    Awaited<ReturnType<typeof listAlgoWallets>>['wallets']
  >([]);
  const [activeAlgoSeedId, setActiveAlgoSeedId] = useState<number | null>(null);
  const [algoBalances, setAlgoBalances] = useState<Record<string, string>>({});

  async function refreshAlgoInventory() {
    const inventory = await listAlgoWallets();
    setAlgoWallets(inventory.wallets);
    setActiveAlgoSeedId(inventory.activeSeedId);
    const wallet = inventory.wallets.find((item) => item.id === inventory.activeSeedId);
    setLastAddressIndex(wallet ? Math.max(...Object.keys(wallet.addresses).map(Number)) : 0);
  }

  useEffect(() => {
    void refreshAlgoInventory().catch((failure) =>
      console.error('Unable to load Algorand wallets', failure),
    );
  }, []);

  useEffect(() => {
    if (!isUnlocked || !networkSettings || selectedWalletType !== 'algorand') return;
    let active = true;
    const wallet = algoWallets.find((item) => item.id === activeAlgoSeedId);
    setAlgoBalances({});
    async function refresh() {
      for (const address of Object.values(wallet?.addresses ?? {})) {
        if (!active) return;
        const result = await getAlgoBalance(
          networkSettings!.algorand.algod,
          address,
          networkSettings!.algorand.network,
        );
        if (active)
          setAlgoBalances((values) => ({
            ...values,
            [address]:
              result.ok && result.algos !== undefined
                ? `${result.algos.toLocaleString(undefined, { maximumFractionDigits: 6 })} ALGO`
                : 'Unavailable',
          }));
      }
    }
    void refresh().catch((failure) => console.error('Unable to load account balances', failure));
    return () => {
      active = false;
    };
  }, [activeAlgoSeedId, algoWallets, isUnlocked, networkSettings, selectedWalletType]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      getMoneroWalletState()
        .then((state) => {
          if (active) setMoneroWallets(state.wallets);
        })
        .catch((error) => console.error('Unable to refresh Monero wallet inventory', error));
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    const inventoryTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(inventoryTimer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadState() {
      try {
        const lockState = await getWalletLockState();
        const [state, moneroState] = await Promise.all([
          getSignedInState(),
          getMoneroWalletState(),
        ]);
        if (!isMounted) {
          return;
        }
        setIsLockConfigured(lockState.isConfigured);
        setIsSignedIn(state.isSignedIn);
        setMoneroWallets(moneroState.wallets);
        setActiveMoneroWalletId(moneroState.activeWalletId);
        setAlgoAddress(state.algoAddress);
        setAddressIndex(0);
        setIsUnlocked(false);
        setSelectedWalletType('algorand');
        setSessionLockSecret(null);
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load wallet state.');
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadState();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    getNetworkSettings().then((loaded) => {
      if (isMounted) {
        setNetworkSettings(loaded);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  async function updateNetworkSettings(next: NetworkSettings) {
    setNetworkSettings(next);
    await saveNetworkSettings(next);
  }

  useEffect(() => {
    let isMounted = true;
    setRecoveryContexts([]);
    setRecoveryAddress('');
    setRecoveredMaterial(null);
    if (moneroView !== 'recover' || !sessionLockSecret || !networkSettings) {
      setIsLoadingRecovery(false);
      return;
    }
    setIsLoadingRecovery(true);
    listMoneroCombinedContexts(
      activeMoneroWalletId,
      networkSettings.monero.network,
      sessionLockSecret,
    )
      .then((contexts) => {
        if (!isMounted) return;
        setRecoveryContexts(contexts);
        setRecoveryAddress(contexts.length === 1 ? contexts[0].combinedAddress : '');
      })
      .catch((err) => {
        console.error('Unable to load recovery contexts', err);
        if (isMounted) setError(err instanceof Error ? err.message : 'Unable to load saved swaps.');
      })
      .finally(() => {
        if (isMounted) setIsLoadingRecovery(false);
      });
    return () => {
      isMounted = false;
    };
  }, [moneroView, activeMoneroWalletId, networkSettings, sessionLockSecret]);

  async function switchAlgorandNetwork(network: AlgorandNetworkId) {
    if (!networkSettings) {
      return;
    }
    await updateNetworkSettings({
      ...networkSettings,
      algorand: cloneAlgorandPreset(network),
    });
  }

  async function switchMoneroNetwork(network: MoneroNetworkId) {
    if (!networkSettings) {
      return;
    }
    const next = {
      ...networkSettings,
      monero: cloneMoneroPreset(network),
    };
    await updateNetworkSettings(next);
    if (moneroMaterial) {
      setMoneroMaterial(
        getMoneroKeyMaterialFromPrivateSpendKey(
          moneroMaterial.privateSpendKey,
          next.monero.networkType,
        ),
      );
    }
  }

  const addressPreview = useMemo(() => {
    if (!algoAddress) {
      return '';
    }
    return `${algoAddress.slice(0, 10)}...${algoAddress.slice(-8)}`;
  }, [algoAddress]);

  const normalizedMnemonic = useMemo(() => {
    const sourceMnemonic = mnemonicMode === 'generate' ? generatedMnemonic : mnemonic;
    return sourceMnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  }, [generatedMnemonic, mnemonic, mnemonicMode]);

  const mnemonicValidationState = useMemo(() => {
    if (mnemonicMode === 'existing' && !normalizedMnemonic) {
      return 'invalid' as const;
    }
    if (!normalizedMnemonic) {
      return 'empty' as const;
    }
    return bip39.validateMnemonic(normalizedMnemonic, wordlist)
      ? ('valid' as const)
      : ('invalid' as const);
  }, [normalizedMnemonic]);

  const generatedMoneroMnemonic = useMemo(
    () => (moneroMaterial ? privateKeyToMoneroMnemonic(moneroMaterial.privateSpendKey) : ''),
    [moneroMaterial],
  );

  const activeMoneroWalletIndex = moneroWallets.findIndex(
    (wallet) => wallet.id === activeMoneroWalletId,
  );

  async function onImportMnemonic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      if (!sessionLockSecret) {
        throw new Error('Unlock with your password or PIN first.');
      }
      if (!normalizedMnemonic) {
        throw new Error('Choose or enter a mnemonic first.');
      }
      const imported = await importAlgoMnemonic(normalizedMnemonic, sessionLockSecret);
      setIsSignedIn(true);
      setIsUnlocked(true);
      setAlgoAddress(imported.algoAddress);
      setAddressIndex(0);
      setMnemonic('');
      setGeneratedMnemonic('');
      setMnemonicMode(null);
      setAlgorandView('wallet');
      await refreshAlgoInventory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to import mnemonic.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onCreateLock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSettingLock(true);

    try {
      if (setupSecret !== setupSecretConfirm) {
        throw new Error('Password or PIN confirmation does not match.');
      }

      await createWalletLock(setupSecret);
      setIsLockConfigured(true);
      setIsUnlocked(true);
      setSessionLockSecret(setupSecret);
      setSetupSecret('');
      setSetupSecretConfirm('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create wallet lock.');
    } finally {
      setIsSettingLock(false);
    }
  }

  async function onUnlockWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsUnlocking(true);

    try {
      const unlocked = await unlockWallet(unlockSecret);
      setAlgoAddress(unlocked.algoAddress);
      setAddressIndex(0);
      setIsUnlocked(true);
      setSelectedWalletType('algorand');
      setAlgorandView('wallet');
      setSessionLockSecret(unlockSecret);
      setUnlockSecret('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlock wallet.');
    } finally {
      setIsUnlocking(false);
    }
  }

  function onLockWallet() {
    discardTransactionsViaBackground().catch((failure) =>
      console.error('Unable to discard prepared transaction on lock', failure),
    );
    setIsUnlocked(false);
    setUnlockSecret('');
    setSessionLockSecret(null);
    setAddressIndex(0);
    setSelectedWalletType('algorand');
    setMoneroMaterial(null);
    setRecoveredMaterial(null);
  }

  // The full-tab dashboard otherwise keeps the password in memory until it is closed.
  useEffect(() => {
    if (!isUnlocked) return;
    let timer = window.setTimeout(onLockWallet, IDLE_LOCK_MS);
    const restart = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onLockWallet, IDLE_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    events.forEach((name) => window.addEventListener(name, restart));
    return () => {
      window.clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, restart));
    };
  }, [isUnlocked]);

  async function onSelectMonero() {
    setError(null);
    try {
      if (!sessionLockSecret || !networkSettings) {
        throw new Error('Wallet or network settings are not ready.');
      }
      const material = await unlockMoneroWallet(
        sessionLockSecret,
        networkSettings.monero.networkType,
        activeMoneroWalletId ?? undefined,
      );
      setMoneroMaterial(material);
      setMoneroView(material ? 'wallet' : 'add');
      setMoneroSetupMode(null);
      setSelectedWalletType('monero');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open Monero wallet.');
    }
  }

  function onSelectMoneroSetupMode(mode: 'generate' | 'import') {
    setError(null);
    setMoneroSetupMode(mode);
    setImportedPrivateSpendKey('');
    setMoneroHistory('used');
    setMoneroScanStart('');
    setImportRestoreHeight('0');
    setMoneroMaterial(
      mode === 'generate' ? generateMoneroKeyMaterial(networkSettings?.monero.networkType) : null,
    );
  }

  async function onSaveMoneroWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      if (!sessionLockSecret || !networkSettings) {
        throw new Error('Unlock with your password or PIN first.');
      }
      const importedValue = importedPrivateSpendKey.trim();
      const material =
        moneroSetupMode === 'import'
          ? getMoneroKeyMaterialFromPrivateSpendKey(
              importedValue.includes(' ')
                ? moneroMnemonicToPrivateKey(importedValue)
                : importedValue,
              networkSettings.monero.networkType,
            )
          : moneroMaterial;
      if (!material) {
        throw new Error('Generate or import Monero key material first.');
      }
      // A freshly generated wallet can't have funds from before now; an imported one might.
      const useCurrentHeight = moneroSetupMode === 'generate' || moneroHistory === 'unused';
      if (!useCurrentHeight && !moneroScanStart) throw new Error('Choose a scan start height, or full history if you do not know it.');
      const restoreHeight = useCurrentHeight
        ? await currentRestoreHeight(networkSettings.monero)
        : moneroScanStart === 'full'
          ? 0
          : Number(importRestoreHeight);
      if (restoreHeight === undefined)
        throw new Error(
          'Unable to determine the current block height. Check the selected node before saving an unused address.',
        );
      if (
        (!useCurrentHeight && moneroScanStart === 'height' && !/^\d+$/.test(importRestoreHeight)) ||
        !Number.isSafeInteger(restoreHeight) ||
        restoreHeight < 0 ||
        restoreHeight > 0xffffffff
      )
        throw new Error('Enter a valid restore height.');
      const activeWalletId = await saveMoneroWallet(
        material,
        sessionLockSecret,
        restoreHeight,
        true,
        networkSettings.monero.network,
        moneroSetupMode === 'generate'
          ? await generatedWalletRestoreHeights(networkSettings.monero, restoreHeight)
          : undefined,
      );
      const moneroState = await getMoneroWalletState();
      setMoneroMaterial(material);
      setMoneroWallets(moneroState.wallets);
      setActiveMoneroWalletId(activeWalletId);
      setMoneroView('wallet');
      setMoneroSetupMode(null);
      setImportedPrivateSpendKey('');
      setCombinedAddressFromPriv('');
      setCombinedAddressFromPublic('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to encrypt and save Monero wallet.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function onComputeCombinedFromPrivateAndPublic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!moneroMaterial) {
      setError('Generate Monero key material first.');
      return;
    }

    try {
      const combined = computeCombinedAddressWithPrivateAndPublic(
        moneroMaterial.privateSpendKey,
        moneroMaterial.privateViewKey,
        counterpartyPrivateViewKey.trim(),
        counterpartyPublicSpendKey.trim(),
      );
      setCombinedAddressFromPriv(combined.combinedAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to compute combined Monero address.');
    }
  }

  function onComputeCombinedFromPublic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      const combined = computeCombinedAddressFromPublicKeys(
        publicSpendKeyA.trim(),
        publicViewKeyA.trim(),
        publicSpendKeyB.trim(),
        publicViewKeyB.trim(),
      );
      setCombinedAddressFromPublic(combined.combinedAddress);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to compute combined Monero address from public keys.',
      );
    }
  }

  async function onRecoverCombinedWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setRecoveredMaterial(null);
    if (!sessionLockSecret || !networkSettings) {
      setError('Open your Monero wallet first.');
      return;
    }
    setIsSubmitting(true);
    try {
      const context = recoveryContexts.find((saved) => saved.combinedAddress === recoveryAddress);
      if (!context || isLoadingRecovery) throw new Error('Select a saved combined address first.');
      const owner = await unlockMoneroWallet(
        sessionLockSecret,
        networkSettings.monero.networkType,
        context.walletId,
      );
      if (!owner) throw new Error('Original swap key material is unavailable.');
      setRecoveredMaterial(
        recoverCombinedWallet(
          owner,
          counterpartyPrivateSpendKey.trim(),
          context,
          networkSettings.monero.networkType,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to recover the combined wallet.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onSaveRecoveredWallet() {
    if (!recoveredMaterial || !sessionLockSecret) {
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const selected = recoveryContexts.find(
        (saved) => saved.combinedAddress === recoveredMaterial.address,
      );
      if (!selected) throw new Error('Select a saved combined address first.');
      const context = await loadMoneroCombinedContext(selected, sessionLockSecret);
      if (!context) throw new Error('Saved swap context is no longer available.');
      const activeWalletId = await saveMoneroWallet(
        recoveredMaterial,
        sessionLockSecret,
        context.restoreHeight,
        true,
        context.network,
      );
      const moneroState = await getMoneroWalletState();
      setMoneroMaterial(recoveredMaterial);
      setMoneroWallets(moneroState.wallets);
      setActiveMoneroWalletId(activeWalletId);
      setRecoveredMaterial(null);
      setCounterpartyPrivateSpendKey('');
      setMoneroView('wallet');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to encrypt and save recovered wallet.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onSelectMoneroWallet(walletId: number) {
    if (!sessionLockSecret || !networkSettings) {
      return;
    }
    setError(null);
    setRecoveredMaterial(null);
    setCombinedAddressFromPriv('');
    setCombinedAddressFromPublic('');
    try {
      const material = await unlockMoneroWallet(
        sessionLockSecret,
        networkSettings.monero.networkType,
        walletId,
      );
      setMoneroMaterial(material);
      setActiveMoneroWalletId(walletId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open Monero address.');
    }
  }

  async function onBack() {
    setError(null);
    if (
      selectedWalletType === 'leakswap' &&
      (moneroView === 'combine' || moneroView === 'recover')
    ) {
      setMoneroView('wallet');
      setRecoveredMaterial(null);
      return;
    }
    if (selectedWalletType === 'algorand' && algorandView !== 'wallet') {
      setMnemonicMode(null);
      setMnemonic('');
      setGeneratedMnemonic('');
      setAlgorandView('wallet');
      return;
    }
    if (selectedWalletType === 'monero' && moneroView === 'add' && moneroSetupMode !== null) {
      setMoneroSetupMode(null);
      setMoneroMaterial(null);
      return;
    }
    if (selectedWalletType === 'monero' && moneroView === 'add' && moneroWallets.length > 0) {
      setMoneroView('wallet');
      await onSelectMoneroWallet(activeMoneroWalletId ?? moneroWallets[0].id);
      return;
    }
    if (selectedWalletType === 'monero' && moneroView === 'add') {
      setSelectedWalletType('algorand');
      setAlgorandView('wallet');
      return;
    }
    if (selectedWalletType === 'monero' && moneroView !== 'wallet') {
      setMoneroView('wallet');
      setRecoveredMaterial(null);
      return;
    }
    if (selectedWalletType === 'algorand' && mnemonicMode !== null) {
      setMnemonicMode(null);
      return;
    }
  }

  async function onSelectAddressIndex(nextIndex: number) {
    if (!sessionLockSecret) {
      setError('Unlock with your password or PIN first.');
      return;
    }

    if (nextIndex < 0) {
      return;
    }

    setError(null);
    setIsDerivingAddress(true);
    try {
      const derived = await deriveActiveSeedAlgoAddressAtIndex(sessionLockSecret, nextIndex);
      setAlgoAddress(derived.algoAddress);
      setAddressIndex(derived.addressIndex);
      setLastAddressIndex((current) => Math.max(current, derived.addressIndex));
      await refreshAlgoInventory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to derive address at index.');
    } finally {
      setIsDerivingAddress(false);
    }
  }

  function onSelectMnemonicMode(mode: 'generate' | 'existing') {
    setError(null);
    setMnemonicMode(mode);
    if (mode === 'generate') {
      setMnemonic('');
      setGeneratedMnemonic((current) => current || bip39.generateMnemonic(wordlist, 256));
    } else {
      setGeneratedMnemonic('');
    }
  }

  function onGenerateNewMnemonic() {
    setError(null);
    setGeneratedMnemonic(bip39.generateMnemonic(wordlist, 256));
  }

  return (
    <main className={variant === 'full' ? 'popup-root full-root' : 'popup-root'}>
      <div className="app-header">
        <div className="app-header-leading">
          {isUnlocked &&
          (selectedWalletType === 'algorand'
            ? algorandView !== 'wallet' || mnemonicMode !== null
            : selectedWalletType === 'leakswap'
              ? moneroView === 'combine' || moneroView === 'recover'
              : moneroView !== 'wallet') ? (
            <button
              type="button"
              className="icon-btn"
              onClick={onBack}
              title="Back"
              aria-label="Back"
            >
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <h1>Zebgen Wallet</h1>
        </div>
        <div className="header-actions">
          {isUnlocked && selectedWalletType !== 'leakswap' ? (
            <button
              type="button"
              className="icon-btn"
              title="Network settings"
              aria-label="Network settings"
              onClick={() => {
                if (selectedWalletType === 'algorand') setAlgorandView('settings');
                else setMoneroView('settings');
              }}
            >
              <Settings size={18} />
            </button>
          ) : null}
          {isUnlocked ? (
            <button
              type="button"
              className="icon-btn"
              onClick={onLockWallet}
              title="Lock wallet"
              aria-label="Lock wallet"
            >
              <LockKeyhole size={18} />
            </button>
          ) : null}
          {variant === 'popup' ? (
            <button
              type="button"
              className="icon-btn"
              title="Open in full window"
              aria-label="Open in full window"
              onClick={() => {
                browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
                window.close();
              }}
            >
              <Maximize2 size={18} />
            </button>
          ) : null}
        </div>
      </div>

      {isUnlocked ? (
        <nav className="chain-tabs" aria-label="Wallet navigation">
          <button
            type="button"
            aria-pressed={selectedWalletType === 'algorand'}
            onClick={() => {
              setError(null);
              setSelectedWalletType('algorand');
              setAlgorandView('wallet');
              setMoneroView('wallet');
              setRecoveredMaterial(null);
            }}
          >
            <img src={algorandLogo} alt="" />
            Algorand
          </button>
          <button
            type="button"
            aria-pressed={selectedWalletType === 'monero'}
            onClick={() => {
              setAlgorandView('wallet');
              setRecoveredMaterial(null);
              onSelectMonero();
            }}
          >
            <img src={moneroLogo} alt="" />
            Monero
          </button>
          <button
            type="button"
            aria-pressed={selectedWalletType === 'leakswap'}
            onClick={() => {
              setError(null);
              setRecoveredMaterial(null);
              setMoneroView('wallet');
              setSelectedWalletType('leakswap');
            }}
          >
            <ArrowLeftRight size={18} />
            LeakSwap
          </button>
        </nav>
      ) : null}

      {isUnlocked &&
      selectedWalletType === 'monero' &&
      moneroWallets.length > 0 &&
      moneroView !== 'add' ? (
        <div className="account-selector">
          <label htmlFor="monero-wallet-selector">Wallet</label>
          <select
            id="monero-wallet-selector"
            value={activeMoneroWalletId ?? ''}
            onChange={(event) => onSelectMoneroWallet(Number(event.target.value))}
          >
            {moneroWallets.map((wallet, index) => (
              <option key={wallet.id} value={wallet.id}>
                Wallet {index + 1} · {wallet.address.slice(0, 6)}...{wallet.address.slice(-6)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {isUnlocked && selectedWalletType === 'algorand' && isSignedIn && algorandView !== 'add' ? (
        <div>
          <div className="account-selector">
            <label htmlFor="algorand-wallet-selector">Wallet</label>
            <select
              id="algorand-wallet-selector"
              value={activeAlgoSeedId ?? ''}
              disabled={isDerivingAddress}
              onChange={async (event) => {
                if (!sessionLockSecret) return;
                setIsDerivingAddress(true);
                setError(null);
                try {
                  const address = await selectAlgoWallet(
                    Number(event.target.value),
                    sessionLockSecret,
                  );
                  setAlgoAddress(address);
                  setAddressIndex(0);
                  setAlgorandView('wallet');
                  await refreshAlgoInventory();
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : 'Unable to select wallet.');
                } finally {
                  setIsDerivingAddress(false);
                }
              }}
            >
              {algoWallets.map((wallet, index) => (
                <option key={wallet.id} value={wallet.id}>
                  Wallet {index + 1} · {wallet.address.slice(0, 6)}...{wallet.address.slice(-6)}
                </option>
              ))}
            </select>
          </div>
          <div className="account-selector">
            <label htmlFor="algorand-address-selector">Address</label>
            <select
              id="algorand-address-selector"
              value={addressIndex}
              disabled={isDerivingAddress}
              onChange={(event) => onSelectAddressIndex(Number(event.target.value))}
            >
              {Object.entries(
                algoWallets.find((wallet) => wallet.id === activeAlgoSeedId)?.addresses ?? {},
              ).map(([index, address]) => (
                <option key={index} value={index}>
                  {Number(index) + 1} · {address.slice(0, 4)}...{address.slice(-4)} ·{' '}
                  {algoBalances[address] ?? 'Loading...'}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {isLoading ? <p>Loading wallet state...</p> : null}

      {!isLoading && !isLockConfigured ? (
        <section className="card">
          <h2>Create Wallet Password or PIN</h2>
          <p className="hint">This one credential unlocks access to all mnemonic operations.</p>

          <form className="import-form" onSubmit={onCreateLock}>
            <label htmlFor="setup-secret">Password or PIN</label>
            <input
              id="setup-secret"
              type="password"
              value={setupSecret}
              onChange={(event) => setSetupSecret(event.target.value)}
              placeholder="Create wallet password or PIN"
              required
            />

            <label htmlFor="setup-secret-confirm">Confirm</label>
            <input
              id="setup-secret-confirm"
              type="password"
              value={setupSecretConfirm}
              onChange={(event) => setSetupSecretConfirm(event.target.value)}
              placeholder="Confirm password or PIN"
              required
            />

            <button type="submit" disabled={isSettingLock}>
              {isSettingLock ? 'Saving...' : 'Set Wallet Lock'}
            </button>
          </form>
        </section>
      ) : null}

      {!isLoading && isLockConfigured && !isUnlocked ? (
        <section className="card">
          <h2>Unlock Wallet</h2>
          <p className="hint">Enter your password or PIN to access mnemonic and wallet data.</p>

          <form className="import-form" onSubmit={onUnlockWallet}>
            <label htmlFor="unlock-secret">Password or PIN</label>
            <input
              id="unlock-secret"
              type="password"
              value={unlockSecret}
              onChange={(event) => setUnlockSecret(event.target.value)}
              placeholder="Enter your password or PIN"
              required
            />

            <button type="submit" disabled={isUnlocking}>
              {isUnlocking ? 'Unlocking...' : 'Unlock'}
            </button>
          </form>
        </section>
      ) : null}

      {!isLoading &&
      isLockConfigured &&
      isUnlocked &&
      selectedWalletType === 'algorand' &&
      isSignedIn &&
      algorandView === 'wallet' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={algorandLogo} alt="" />
            Algorand Address
          </h2>
          {networkSettings ? (
            <>
              <AlgorandAddressCard
                address={algoAddress}
                addressPreview={addressPreview}
                addressIndex={addressIndex}
                derivationPath={getAlgoDerivationPath(addressIndex)}
                settings={networkSettings}
                onChangeNetwork={switchAlgorandNetwork}
                onOpenSettings={() => setAlgorandView('settings')}
              />
            </>
          ) : (
            <p className="hint">Loading network...</p>
          )}
          <div className="wallet-action-grid primary-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => setAlgorandView('transaction')}
            >
              <ArrowUpRight size={18} />
              Send ALGO
            </button>
            <button className="secondary" type="button" onClick={() => setAlgorandView('receive')}>
              <ArrowDownLeft size={18} />
              Receive
            </button>
          </div>
          <div className="wallet-action-grid">
            <button
              className="secondary"
              type="button"
              disabled={isDerivingAddress}
              onClick={() => onSelectAddressIndex(lastAddressIndex + 1)}
            >
              <Plus size={18} />
              {isDerivingAddress ? 'Adding Address...' : 'Add Address'}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={isDerivingAddress}
              onClick={() => {
                setMnemonicMode(null);
                setMnemonic('');
                setGeneratedMnemonic('');
                setAlgorandView('add');
              }}
            >
              <Plus size={18} />
              Add wallet
            </button>
          </div>
        </section>
      ) : null}

      {isUnlocked &&
      selectedWalletType === 'algorand' &&
      isSignedIn &&
      algorandView === 'receive' &&
      algoAddress &&
      networkSettings ? (
        <Receive
          chain="algorand"
          address={algoAddress}
          network={networkSettings.algorand.network}
        />
      ) : null}
      {isUnlocked && selectedWalletType === 'algorand' && algorandView === 'settings' ? (
        <section>
          <h2>Algorand settings</h2>
          {networkSettings ? (
            <NetworkSettingsPanel
              chain="algorand"
              settings={networkSettings}
              onChange={updateNetworkSettings}
            />
          ) : null}
          <h2>Monero network settings</h2>
          {networkSettings ? (
            <NetworkSettingsPanel
              chain="monero"
              settings={networkSettings}
              onChange={updateNetworkSettings}
            />
          ) : null}
          <RevealSeedPhrase />
        </section>
      ) : null}

      {!isLoading &&
      isUnlocked &&
      selectedWalletType === 'algorand' &&
      isSignedIn &&
      algorandView === 'transaction' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={algorandLogo} alt="" />
            Send ALGO
          </h2>
          {networkSettings && sessionLockSecret && algoAddress ? (
            <TransactionBuilder
              key={`${algoAddress}-${networkSettings.algorand.network}`}
              chain="algorand"
              sender={algoAddress}
              addressIndex={addressIndex}
              lockSecret={sessionLockSecret}
              endpoint={networkSettings.algorand.algod}
              network={networkSettings.algorand.network}
            />
          ) : (
            <p className="hint">Loading transaction builder...</p>
          )}
        </section>
      ) : null}

      {!isLoading &&
      isLockConfigured &&
      isUnlocked &&
      selectedWalletType === 'algorand' &&
      ((!isSignedIn && algorandView === 'wallet') || algorandView === 'add') ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={algorandLogo} alt="" />
            Add Algorand address?
          </h2>
          <p className="hint">
            Generate a new 24-word Algorand mnemonic or import an existing mnemonic.
          </p>

          <form className="import-form" onSubmit={onImportMnemonic}>
            {mnemonicMode === null ? (
              <div className="seed-choice-group" role="group" aria-label="Mnemonic source">
                <button
                  type="button"
                  className="choice-button"
                  onClick={() => onSelectMnemonicMode('generate')}
                >
                  Generate mnemonic
                </button>
                <button
                  type="button"
                  className="choice-button"
                  onClick={() => onSelectMnemonicMode('existing')}
                >
                  Import mnemonic
                </button>
              </div>
            ) : null}

            {mnemonicMode === 'existing' ? (
              <>
                <label htmlFor="mnemonic">Mnemonic</label>
                <textarea
                  id="mnemonic"
                  className={`mnemonic-input mnemonic-${mnemonicValidationState}`}
                  value={mnemonic}
                  onChange={(event) => setMnemonic(event.target.value)}
                  placeholder="Enter your 24 word mnemonic"
                  rows={4}
                  required
                />
              </>
            ) : null}

            {mnemonicMode === 'generate' ? (
              <>
                <label htmlFor="generated-mnemonic">Recovery mnemonic</label>
                <p className="seed-warning">
                  Write down these 24 words in order and keep them somewhere safe offline. They
                  recover your Algorand wallet. Never share them.
                </p>
                <textarea
                  id="generated-mnemonic"
                  className="mnemonic-input mnemonic-valid"
                  value={generatedMnemonic}
                  rows={4}
                  readOnly
                />
                <button type="button" className="secondary" onClick={onGenerateNewMnemonic}>
                  Regenerate mnemonic
                </button>
              </>
            ) : null}

            {mnemonicMode !== null ? (
              <button type="submit" disabled={isSubmitting || mnemonicValidationState !== 'valid'}>
                {isSubmitting ? 'Encrypting...' : 'Encrypt and Save'}
              </button>
            ) : null}
          </form>
        </section>
      ) : null}

      {!isLoading &&
      isLockConfigured &&
      isUnlocked &&
      selectedWalletType === 'monero' &&
      moneroView === 'add' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={moneroLogo} alt="" />
            Add Monero address?
          </h2>
          <p className="hint">
            Generate a new 25-word Monero mnemonic or import an existing mnemonic or private spend
            key.
          </p>
          {moneroSetupMode === null ? (
            <div className="seed-choice-group" role="group" aria-label="Monero key source">
              <button
                type="button"
                className="choice-button"
                onClick={() => onSelectMoneroSetupMode('generate')}
              >
                Generate mnemonic
              </button>
              <button
                type="button"
                className="choice-button"
                onClick={() => onSelectMoneroSetupMode('import')}
              >
                Import mnemonic
              </button>
            </div>
          ) : (
            <form className="import-form" onSubmit={onSaveMoneroWallet}>
              {moneroSetupMode === 'import' ? (
                <>
                  <label htmlFor="monero-private-spend-key">Mnemonic or private spend key</label>
                  <textarea
                    id="monero-private-spend-key"
                    className="mnemonic-input"
                    value={importedPrivateSpendKey}
                    onChange={(event) => setImportedPrivateSpendKey(event.target.value)}
                    placeholder="Enter a 25-word Monero mnemonic or 64 hexadecimal characters"
                    autoComplete="off"
                    rows={4}
                    required
                  />
                  <label htmlFor="monero-address-history">Address history</label>
                  <select
                    id="monero-address-history"
                    value={moneroHistory}
                    onChange={(event) => setMoneroHistory(event.target.value as 'unused' | 'used')}
                  >
                    <option value="used">Has received funds before</option>
                    <option value="unused">Never used</option>
                  </select>
                  {moneroHistory === 'used' ? (
                    <>
                      <label htmlFor="monero-scan-start">Where should scanning start?</label>
                      <select
                        id="monero-scan-start"
                        required
                        value={moneroScanStart}
                        onChange={(event) =>
                          setMoneroScanStart(event.target.value as '' | 'full' | 'height')
                        }
                      >
                        <option value="" disabled>Choose a scan start</option>
                        <option value="full">I don't know: scan full history (block 0)</option>
                        <option value="height">Specific block height</option>
                      </select>
                      {moneroScanStart === 'height' ? (
                        <>
                          <label htmlFor="monero-import-height">Scan start block height</label>
                          <input
                            id="monero-import-height"
                            inputMode="numeric"
                            required
                            value={importRestoreHeight}
                            onChange={(event) =>
                              setImportRestoreHeight(sanitizeBlockHeight(event.target.value))
                            }
                          />
                        </>
                      ) : null}
                      <p className="hint">Use a block height from before this wallet first received funds on the selected network. A later height can miss deposits. If unsure, choose full history.</p>
                    </>
                  ) : null}
                </>
              ) : null}
              {moneroSetupMode === 'generate' && moneroMaterial ? (
                <>
                  <label htmlFor="generated-monero-mnemonic">Recovery mnemonic</label>
                  <textarea
                    id="generated-monero-mnemonic"
                    className="mnemonic-input mnemonic-valid"
                    value={generatedMoneroMnemonic}
                    rows={4}
                    readOnly
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => onSelectMoneroSetupMode('generate')}
                  >
                    Regenerate mnemonic
                  </button>
                  <p className="seed-warning">
                    Store these 25 words offline. They recover this Monero address and its private
                    spend key.
                  </p>
                </>
              ) : null}
              <button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Encrypting...' : 'Encrypt and Save'}
              </button>
            </form>
          )}
        </section>
      ) : null}

      {!isLoading &&
      isUnlocked &&
      selectedWalletType === 'monero' &&
      moneroWallets.length > 0 &&
      moneroView === 'wallet' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={moneroLogo} alt="" />
            Monero Address
          </h2>
          {networkSettings && moneroMaterial ? (
            <MoneroAddressCard
              material={moneroMaterial}
              walletId={activeMoneroWalletId!}
              lockSecret={sessionLockSecret!}
              restoreHeight={walletRestoreHeight(
                moneroWallets[activeMoneroWalletIndex],
                networkSettings.monero.network,
              )}
              settings={networkSettings}
              onChangeNetwork={switchMoneroNetwork}
              onOpenSettings={() => setMoneroView('settings')}
              addressPosition={activeMoneroWalletIndex}
              addressCount={moneroWallets.length}
              onPrev={() => onSelectMoneroWallet(moneroWallets[activeMoneroWalletIndex - 1].id)}
              onNext={() => onSelectMoneroWallet(moneroWallets[activeMoneroWalletIndex + 1].id)}
            />
          ) : (
            <p className="hint">Loading Monero wallet...</p>
          )}
          <div className="wallet-action-grid primary-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setMoneroView('transaction')}
            >
              <ArrowUpRight size={18} />
              Send XMR
            </button>
            <button type="button" className="secondary" onClick={() => setMoneroView('receive')}>
              <ArrowDownLeft size={18} />
              Receive
            </button>
          </div>
          {networkSettings && moneroMaterial && sessionLockSecret ? (
            <MoneroActivity
              key={JSON.stringify([moneroMaterial.address, networkSettings.monero])}
              address={moneroMaterial.address}
              config={networkSettings.monero}
              lockSecret={sessionLockSecret}
            />
          ) : null}
          <div className="wallet-action-grid">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setMoneroSetupMode(null);
                setMoneroView('add');
              }}
            >
              <Plus size={18} />
              Add Address
            </button>
          </div>
        </section>
      ) : null}

      {isUnlocked &&
      selectedWalletType === 'leakswap' &&
      moneroView !== 'combine' &&
      moneroView !== 'recover' ? (
        <LeakSwapPanel
          key={`${networkSettings?.algorand.network}-${networkSettings?.algorand.algod.server}`}
          lockSecret={sessionLockSecret}
          onRecover={() => setMoneroView('recover')}
        />
      ) : null}
      {isUnlocked &&
      selectedWalletType === 'monero' &&
      moneroMaterial &&
      networkSettings &&
      moneroView === 'receive' ? (
        <Receive
          chain="monero"
          address={moneroMaterial.address}
          network={networkSettings.monero.network}
        />
      ) : null}

      {!isLoading &&
      isUnlocked &&
      selectedWalletType === 'monero' &&
      moneroView === 'transaction' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={moneroLogo} alt="" />
            Send XMR
          </h2>
          {networkSettings &&
          moneroMaterial &&
          sessionLockSecret &&
          activeMoneroWalletId !== null ? (
            <TransactionBuilder
              key={moneroMaterial.address}
              chain="monero"
              sender={moneroMaterial.address}
              config={networkSettings.monero}
              walletId={activeMoneroWalletId}
              lockSecret={sessionLockSecret}
              defaultRestoreHeight={walletRestoreHeight(
                moneroWallets[activeMoneroWalletIndex],
                networkSettings.monero.network,
              )}
            />
          ) : (
            <p className="hint">Loading transaction builder...</p>
          )}
        </section>
      ) : null}

      {!isLoading && isUnlocked && selectedWalletType === 'monero' && moneroView === 'settings' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={moneroLogo} alt="" />
            Monero Network Settings
          </h2>
          {networkSettings ? (
            <NetworkSettingsPanel
              chain="monero"
              settings={networkSettings}
              onChange={updateNetworkSettings}
            />
          ) : (
            <p className="hint">Loading network settings...</p>
          )}
          {moneroMaterial ? (
            <MoneroRecovery key={moneroMaterial.address} material={moneroMaterial} />
          ) : null}
        </section>
      ) : null}

      {!isLoading && isUnlocked && selectedWalletType === 'leakswap' && moneroView === 'combine' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={moneroLogo} alt="" />
            Combine Addresses
          </h2>
          <form className="import-form flow-panel" onSubmit={onComputeCombinedFromPrivateAndPublic}>
            <h3>Use your saved key</h3>
            <label htmlFor="counterparty-private-view">Counterparty private view key</label>
            <input
              id="counterparty-private-view"
              value={counterpartyPrivateViewKey}
              onChange={(event) => setCounterpartyPrivateViewKey(event.target.value)}
              required
            />
            <label htmlFor="counterparty-public-spend">Counterparty public spend key</label>
            <input
              id="counterparty-public-spend"
              value={counterpartyPublicSpendKey}
              onChange={(event) => setCounterpartyPublicSpendKey(event.target.value)}
              required
            />
            <button type="submit" disabled={!moneroMaterial}>
              Combine
            </button>
            {combinedAddressFromPriv ? (
              <div className="receive-address">
                <code>{combinedAddressFromPriv}</code>
                <CopyValue value={combinedAddressFromPriv} label="combined address" />
              </div>
            ) : null}
          </form>
          <form className="import-form flow-panel" onSubmit={onComputeCombinedFromPublic}>
            <h3>Use two public key pairs</h3>
            <label htmlFor="pub-spend-a">Public spend key A</label>
            <input
              id="pub-spend-a"
              value={publicSpendKeyA}
              onChange={(event) => setPublicSpendKeyA(event.target.value)}
              required
            />
            <label htmlFor="pub-view-a">Public view key A</label>
            <input
              id="pub-view-a"
              value={publicViewKeyA}
              onChange={(event) => setPublicViewKeyA(event.target.value)}
              required
            />
            <label htmlFor="pub-spend-b">Public spend key B</label>
            <input
              id="pub-spend-b"
              value={publicSpendKeyB}
              onChange={(event) => setPublicSpendKeyB(event.target.value)}
              required
            />
            <label htmlFor="pub-view-b">Public view key B</label>
            <input
              id="pub-view-b"
              value={publicViewKeyB}
              onChange={(event) => setPublicViewKeyB(event.target.value)}
              required
            />
            <button type="submit">Combine Public Keys</button>
            {combinedAddressFromPublic ? (
              <div className="receive-address">
                <code>{combinedAddressFromPublic}</code>
                <CopyValue value={combinedAddressFromPublic} label="combined address" />
              </div>
            ) : null}
          </form>
        </section>
      ) : null}

      {!isLoading && isUnlocked && selectedWalletType === 'leakswap' && moneroView === 'recover' ? (
        <section className="card">
          <h2 className="chain-title">
            <img className="chain-logo" src={moneroLogo} alt="" />
            Recover Combined Wallet
          </h2>
          <p className="hint">
            Add the counterparty's leaked private spend key to your saved key to gain full spend and
            view control of the combined address.
          </p>
          <form className="import-form" onSubmit={onRecoverCombinedWallet}>
            <label htmlFor="recovery-combined-address">Combined address</label>
            <select
              id="recovery-combined-address"
              value={recoveryAddress}
              disabled={isLoadingRecovery || isSubmitting}
              onChange={(event) => {
                setRecoveryAddress(event.target.value);
                setRecoveredMaterial(null);
                setError(null);
              }}
            >
              <option value="">{isLoadingRecovery ? 'Loading...' : 'Select saved address'}</option>
              {recoveryContexts.map((context) => (
                <option key={context.combinedAddress} value={context.combinedAddress}>
                  {context.combinedAddress}
                </option>
              ))}
            </select>
            {!isLoadingRecovery && recoveryContexts.length === 0 ? (
              <p className="error">No saved swap context for this wallet and network.</p>
            ) : null}
            <label htmlFor="counterparty-private-spend">Counterparty private spend key</label>
            <input
              id="counterparty-private-spend"
              value={counterpartyPrivateSpendKey}
              onChange={(event) => {
                setCounterpartyPrivateSpendKey(event.target.value);
                setRecoveredMaterial(null);
                setError(null);
              }}
              placeholder="64 hexadecimal characters"
              autoComplete="off"
              disabled={isSubmitting}
              required
            />
            <button type="submit" disabled={isLoadingRecovery || !recoveryAddress || isSubmitting}>
              Recover Full Key Material
            </button>
          </form>
          {recoveredMaterial ? (
            <div className="flow-panel">
              <MoneroKeyList material={recoveredMaterial} />
              <button type="button" onClick={onSaveRecoveredWallet} disabled={isSubmitting}>
                {isSubmitting ? 'Encrypting...' : 'Encrypt and Save Recovered Wallet'}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}

export default App;
