// WizardConnect wallet integration (dapp side).
// Pairing is handled by WizardConnect. The wallet supplies xpubs; AjoChain
// derives receive addresses locally and asks the wallet to sign transactions.
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { hash160, stringify } from '@bitauth/libauth';
import { pkhToAddress, type Net } from '../../src/lib/ajo';

export type WalletState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected';

type Listener = () => void;

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

  onChange(fn: Listener) { this.listeners.push(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

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
    this.error = null;
    this.receiveIndex = 0;
    this.state = 'connecting';
    const generation = ++this.generation;
    const icon = new URL('favicon.svg', location.href).toString();
    const mgr = new DappConnectionManager('AjoChain', icon);
    this.mgr = mgr;

    mgr.on('walletready', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.walletName = mgr.walletName;
      this.error = null;
      this.state = 'connected';
      this.emit();
    });
    mgr.on('reconnecting', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.state = 'reconnecting';
      this.emit();
    });
    mgr.on('disconnect', () => {
      if (!this.isCurrent(mgr, generation)) return;
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
    } catch (e) {
      if (this.isCurrent(mgr, generation)) {
        this.error = e instanceof Error ? e.message : 'Failed to start WizardConnect relay';
        this.mgr = null;
        this.relay = null;
        this.state = 'idle';
        this.cleanup(mgr, null);
      }
    }
    this.emit();
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
  async signAndBroadcast(wcObject: any, walletInputs: number[], prompt: string) {
    if (!this.mgr || this.state !== 'connected') throw new Error('Connect a wallet first');
    const mgr = this.mgr;
    const generation = this.generation;
    if (!wcObject?.transaction || !Array.isArray(wcObject?.sourceOutputs)) {
      throw new Error('CashScript returned an incomplete wallet-signing request');
    }

    // WizardConnect's relay uses JSON transport. Encode the entire CashScript
    // WcTransactionObject with Libauth stringify, then parse it back into the
    // extended-JSON representation expected by WizardConnect and Selene.
    // Serializing only the nested transaction/sourceOutputs fields as strings
    // produces an invalid signing request and can prevent wallet approval.
    const encodedRequest = JSON.parse(stringify({
      ...wcObject,
      broadcast: true,
      userPrompt: prompt,
    }));

    const res = await mgr.signTransaction({
      transaction: encodedRequest,
      inputPaths: walletInputs.map((i) => [i, 'receive', this.receiveIndex] as [number, string, number]),
    });
    if (!this.isCurrent(mgr, generation) || this.state !== 'connected') {
      throw new Error('Wallet connection changed before signing completed. Please reconnect and try again.');
    }
    if (res.error) throw new Error(res.error);
    return res.signedTransaction;
  }
}

export const wallet = new WizardWallet();
