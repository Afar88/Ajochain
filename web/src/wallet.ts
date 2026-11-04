// WizardConnect wallet integration (dapp side).
// Pairing is handled by WizardConnect. The wallet supplies xpubs; AjoChain
// derives receive addresses locally and asks the wallet to sign transactions.
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { binToHex, encodeTransaction, hash160 } from '@bitauth/libauth';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import { pkhToAddress, type Net } from '../../src/lib/ajo';
import { getProvider } from './chain';

export type WalletState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected';

type Listener = () => void;

/**
 * Convert CashScript's native transaction object to WizardConnect's canonical
 * relay representation. Transactions travel as raw hex; source outputs use
 * WizardConnect's serializer (hex byte arrays and extended-JSON BigInts).
 */
export function buildWizardSignRequest(
  wcObject: any,
  walletInputs: number[],
  receiveIndex: number,
  prompt: string,
) {
  const transaction = wcObject?.transaction;
  const sourceOutputs = wcObject?.sourceOutputs;
  if (!Array.isArray(transaction?.inputs) || !Array.isArray(transaction?.outputs) ||
      !Array.isArray(sourceOutputs) || sourceOutputs.length !== transaction.inputs.length) {
    throw new Error('CashScript returned an incomplete wallet-signing request (transaction/source-output count mismatch).');
  }

  const inputPaths = walletInputs.map((inputIndex) => {
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= transaction.inputs.length) {
      throw new Error(`Invalid wallet signing input index: ${inputIndex}`);
    }
    return [inputIndex, 'receive', receiveIndex] as [number, string, number];
  });
  if (new Set(walletInputs).size !== walletInputs.length) {
    throw new Error('Wallet signing request contains duplicate input indexes.');
  }

  const relaySourceOutputs = transaction.inputs.map((input: unknown, index: number) =>
    sourceOutputToRelay({ ...(input as object), ...sourceOutputs[index] }),
  );

  return {
    transaction: {
      transaction: binToHex(encodeTransaction(transaction)),
      sourceOutputs: relaySourceOutputs,
      broadcast: false,
      userPrompt: prompt,
    },
    inputPaths,
  };
}

class WizardWallet {
  state: WalletState = 'idle';
  uri: string | null = null;
  qrUri: string | null = null;
  walletName: string | null = null;
  /** Receive-address index selected by matching Selene's displayed address. */
  receiveIndex = 0;
  error: string | null = null;
  private mgr: DappConnectionManager | null = null;
  private relay: DappRelayResult | null = null;
  private listeners: Listener[] = [];
  // Invalidates callbacks from managers that have been replaced or disconnected.
  private generation = 0;
  private connectionWatchdog: ReturnType<typeof setTimeout> | null = null;

  onChange(fn: Listener) { this.listeners.push(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  private clearConnectionWatchdog() {
    if (this.connectionWatchdog) clearTimeout(this.connectionWatchdog);
    this.connectionWatchdog = null;
  }

  private isCurrent(mgr: DappConnectionManager, generation: number) {
    return this.mgr === mgr && this.generation === generation;
  }

  private cleanup(mgr: DappConnectionManager | null, relay: DappRelayResult | null, clearSession = true) {
    try { relay?.cleanup(); } catch { /* cleanup must not block local disconnect */ }
    if (clearSession) {
      try { mgr?.clearStoredSession(); } catch { /* best effort */ }
    }
    try { mgr?.destroy(); } catch { /* best effort */ }
  }

  connect(existing?: { privateKey: string; secret: string; walletPublicKey: string }) {
    // Do not create overlapping relays/managers. A reconnecting manager owns its retry loop.
    if (this.state === 'connecting' || this.state === 'reconnecting' ||
        this.state === 'connected' || this.state === 'disconnecting') return;
    this.clearConnectionWatchdog();
    this.error = null;
    this.receiveIndex = 0;
    this.state = 'connecting';
    const generation = ++this.generation;
    const icon = new URL('favicon.svg', location.href).toString();
    const mgr = new DappConnectionManager('AjoChain', icon);
    this.mgr = mgr;

    mgr.on('walletready', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.clearConnectionWatchdog();
      this.walletName = mgr.walletName;
      this.error = null;
      this.state = 'connected';
      this.emit();
    });
    mgr.on('reconnecting', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.error = null;
      this.state = 'reconnecting';
      this.emit();
    });
    mgr.on('disconnect', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.clearConnectionWatchdog();
      const relay = this.relay;
      this.generation++;
      this.mgr = null;
      this.relay = null;
      this.uri = null;
      this.qrUri = null;
      this.walletName = null;
      this.receiveIndex = 0;
      this.state = 'disconnected';
      this.cleanup(mgr, relay);
      this.emit();
    });

    try {
      const relay = initiateDappRelay((payload) => {
        if (this.isCurrent(mgr, generation)) mgr.updateConnection(payload.client, payload.status);
      }, { existingCredentials: existing });
      if (!this.isCurrent(mgr, generation)) {
        this.cleanup(mgr, relay);
        return;
      }
      this.relay = relay;
      if (!existing) { this.uri = relay.uri; this.qrUri = relay.qrUri; }
      mgr.attachRelay(relay);
      // Give slow mobile wallet handoffs time, but surface a recovery action
      // instead of leaving the UI in an endless "Connecting…" state.
      this.connectionWatchdog = setTimeout(() => {
        if (!this.isCurrent(mgr, generation) || this.state !== 'connecting') return;
        this.error = existing
          ? 'Your saved Selene session has not responded. Start a fresh pairing to reconnect.'
          : 'Still waiting for Selene. Keep AjoChain open, or start a fresh pairing.';
        this.emit();
      }, 20000);
    } catch (e) {
      if (this.isCurrent(mgr, generation)) {
        this.clearConnectionWatchdog();
        this.error = e instanceof Error ? e.message : 'Failed to start WizardConnect relay';
        this.mgr = null;
        this.relay = null;
        this.state = 'idle';
        this.cleanup(mgr, null);
      }
    }
    this.emit();
  }

  /** Discard a stalled/stale pairing and create a fresh WizardConnect relay. */
  startFreshPairing() {
    if (this.state === 'connected' || this.state === 'disconnecting') return;
    const mgr = this.mgr;
    const relay = this.relay;
    this.generation++;
    this.mgr = null;
    this.relay = null;
    this.clearConnectionWatchdog();
    this.cleanup(mgr, relay, true);
    this.uri = null;
    this.qrUri = null;
    this.walletName = null;
    this.receiveIndex = 0;
    this.error = null;
    this.state = 'idle';
    this.emit();
    this.connect();
  }

  /** Resume a stored WizardConnect session after page reload, if one exists. */
  tryResume() {
    if (this.state !== 'idle') return;
    try {
      const s = loadSession();
      if (s?.walletPublicKey) {
        this.walletName = s.walletName ?? null;
        this.connect({ privateKey: s.privateKey, secret: s.secret, walletPublicKey: s.walletPublicKey });
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Could not restore the saved wallet session';
      this.state = 'idle';
      this.emit();
    }
  }

  async disconnect() {
    if (this.state === 'disconnecting') return;
    const mgr = this.mgr;
    const relay = this.relay;
    this.clearConnectionWatchdog();
    // Invalidate all manager/relay callbacks before awaiting the remote disconnect.
    this.generation++;
    this.mgr = null;
    this.relay = null;
    this.state = 'disconnecting';
    this.emit();
    try {
      await mgr?.sendDisconnect();
    } catch {
      // Local cleanup still completes if the wallet is offline or the relay has expired.
    } finally {
      this.cleanup(mgr, relay);
      this.uri = null;
      this.qrUri = null;
      this.walletName = null;
      this.receiveIndex = 0;
      this.error = null;
      this.state = 'idle';
      this.emit();
    }
  }

  /** WizardConnect receive address at the currently selected BIP32 address index. */
  address(network: Net): string | null {
    const pk = this.mgr?.getPubkey(0, BigInt(this.receiveIndex));
    if (!pk) return null;
    return pkhToAddress(hash160(pk), network);
  }

  /** Match a Selene receive address against the xpub supplied by WizardConnect. */
  matchReceiveAddress(address: string, network: Net, maxIndex = 50): number | null {
    if (this.state !== 'connected' || !this.mgr) throw new Error('Connect your Selene wallet first');
    const target = address.trim().toLowerCase();
    if (!target) return null;
    for (let i = 0; i <= maxIndex; i++) {
      const pk = this.mgr.getPubkey(0, BigInt(i));
      if (!pk) return null;
      if (pkhToAddress(hash160(pk), network).toLowerCase() === target) {
        this.receiveIndex = i;
        this.emit();
        return i;
      }
    }
    return null;
  }

  /** Ask the connected wallet to sign and broadcast a CashScript-built transaction. */
  async signAndBroadcast(wcObject: any, walletInputs: number[], prompt: string, network: Net) {
    if (!this.mgr || this.state !== 'connected') throw new Error('Connect a wallet first');
    const mgr = this.mgr;
    const generation = this.generation;
    const request = buildWizardSignRequest(wcObject, walletInputs, this.receiveIndex, prompt);
    const res = await mgr.signTransaction(request);
    if (!this.isCurrent(mgr, generation) || this.state !== 'connected') {
      throw new Error('Wallet connection changed before signing completed. Please reconnect and try again.');
    }
    if (res.error) throw new Error(res.error);
    const signedTransaction = res.signedTransaction;
    if (typeof signedTransaction !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(signedTransaction)) {
      throw new Error('Selene did not return a valid signed transaction. The transaction was not broadcast.');
    }
    // WizardConnect returns a signed transaction; broadcasting is the dapp's responsibility.
    const provider = await getProvider(network);
    return provider.sendRawTransaction(signedTransaction);
  }
}

export const wallet = new WizardWallet();
