// WizardConnect wallet integration (dapp side).
// Pairing: we open an encrypted relay session and show its wiz:// URI as a QR.
// The user scans it with a WizardConnect-capable BCH wallet. After `wallet_ready`
// we get the wallet's xpubs, derive receive address #0, and can ask the wallet to
// sign (and broadcast) transactions we build with CashScript.
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { hash160 } from '@bitauth/libauth';
import { pkhToAddress, type Net } from '../../src/lib/ajo';

export type WalletState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

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

  onChange(fn: Listener) { this.listeners.push(fn); }
  private emit() { this.listeners.forEach((f) => f()); }

  connect(existing?: { privateKey: string; secret: string; walletPublicKey: string }) {
    // A reconnecting manager owns its retry loop; never create a second relay.
    if (this.state === 'connecting' || this.state === 'reconnecting' || this.state === 'connected') return;
    this.error = null;
    this.state = 'connecting';
    const icon = new URL('favicon.svg', location.href).toString();
    const mgr = new DappConnectionManager('AjoChain', icon);
    this.mgr = mgr;
    mgr.on('walletready', () => {
      this.walletName = mgr.walletName;
      this.state = 'connected';
      this.emit();
    });
    mgr.on('reconnecting', () => { this.state = 'reconnecting'; this.emit(); });
    mgr.on('disconnect', () => {
      mgr.clearStoredSession();
      this.relay?.cleanup();
      this.relay = null;
      this.state = 'disconnected';
      this.walletName = null;
      this.emit();
    });
    try {
      const relay = initiateDappRelay((payload) => mgr.updateConnection(payload.client, payload.status), {
        existingCredentials: existing,
      });
      this.relay = relay;
      if (!existing) { this.uri = relay.uri; this.qrUri = relay.qrUri; }
      mgr.attachRelay(relay);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to start WizardConnect relay';
      this.state = 'idle';
    }
    this.emit();
  }

  /** Resume a stored session after page reload, if any. */
  tryResume() {
    const s = loadSession();
    if (s?.walletPublicKey) {
      this.walletName = s.walletName ?? null;
      this.connect({ privateKey: s.privateKey, secret: s.secret, walletPublicKey: s.walletPublicKey });
    }
  }

  async disconnect() {
    try { await this.mgr?.sendDisconnect().catch(() => {}); } finally {
      this.relay?.cleanup();
      this.mgr?.clearStoredSession();
      this.mgr?.destroy();
      this.mgr = null; this.relay = null;
      this.uri = null; this.qrUri = null; this.walletName = null;
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
    const target = address.trim().toLowerCase();
    if (!target) return null;
    for (let i = 0; i <= maxIndex; i++) {
      const pk = this.mgr?.getPubkey(0, BigInt(i));
      if (!pk) return null;
      if (pkhToAddress(hash160(pk), network).toLowerCase() === target) {
        this.receiveIndex = i;
        this.emit();
        return i;
      }
    }
    return null;
  }

  /**
   * Ask the wallet to sign a CashScript-built transaction object
   * (from TransactionBuilder.generateWcTransactionObject) and broadcast it.
   * `walletInputs` = indices of inputs owned by receive address #0.
   */
  async signAndBroadcast(wcObject: any, walletInputs: number[], prompt: string) {
    if (!this.mgr || this.state !== 'connected') throw new Error('Connect a wallet first');
    const res = await this.mgr.signTransaction({
      transaction: { ...wcObject, broadcast: true, userPrompt: prompt },
      inputPaths: walletInputs.map((i) => [i, 'receive', this.receiveIndex] as [number, string, number]),
    });
    if (res.error) throw new Error(res.error);
    return res.signedTransaction;
  }
}

export const wallet = new WizardWallet();
