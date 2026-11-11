// WizardConnect wallet integration (dapp side).
// Pairing is handled by WizardConnect. The wallet supplies xpubs; AjoChain
// derives receive addresses locally and asks the wallet to sign transactions.
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { binToHex, decodeTransactionBCH, encodeTransaction, encodeTransactionOutputs, hash160, hexToBin } from '@bitauth/libauth';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import { pkhToAddress, type Net } from '../../src/lib/ajo';
import { getProvider } from './chain';

export type WalletState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected';

type Listener = () => void;

const PATHS_STORAGE_KEY = 'ajochain:wizardconnect-paths:v1';
const RECEIVE_INDEX_STORAGE_KEY = 'ajochain:wizardconnect-receive-index:v1';

function restorePublicPaths(mgr: DappConnectionManager) {
  try {
    const raw = localStorage.getItem(PATHS_STORAGE_KEY);
    if (!raw) return;
    const paths: unknown = JSON.parse(raw);
    if (!Array.isArray(paths)) throw new Error('Invalid cached WizardConnect paths');
    mgr.restoreSessionPaths(paths);
  } catch {
    // Never let stale/corrupt public derivation data block a fresh connection.
    try { localStorage.removeItem(PATHS_STORAGE_KEY); } catch { /* best effort */ }
  }
}

function savePublicPaths(mgr: DappConnectionManager) {
  try {
    const paths = mgr.getSessionPaths();
    if (Array.isArray(paths) && paths.length) localStorage.setItem(PATHS_STORAGE_KEY, JSON.stringify(paths));
  } catch { /* public path caching is an enhancement, not a connection requirement */ }
}

function loadReceiveIndex() {
  try {
    const value = Number(localStorage.getItem(RECEIVE_INDEX_STORAGE_KEY));
    return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
  } catch { return 0; }
}

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


/**
 * Verify that the wallet returned a valid serialization of the transaction
 * AjoChain asked it to sign. Unlocking scripts may change; transaction intent
 * (version, locktime, input outpoints/order/sequence, and every output) may not.
 * This is a dapp-side integrity check, not a substitute for covenant validation.
 */
export function verifySignedTransaction(signedHex: string, expected: any) {
  if (typeof signedHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(signedHex)) {
    throw new Error('Wallet returned malformed transaction hex.');
  }
  const decoded = decodeTransactionBCH(hexToBin(signedHex));
  if (typeof decoded === 'string') {
    throw new Error(`Wallet returned an invalid BCH transaction: ${decoded}`);
  }
  if (!expected || !Array.isArray(expected.inputs) || !Array.isArray(expected.outputs)) {
    throw new Error('Original transaction is incomplete; refusing to broadcast.');
  }
  if (decoded.version !== expected.version || decoded.locktime !== expected.locktime) {
    throw new Error('Wallet changed transaction version or locktime; refusing to broadcast.');
  }
  if (decoded.inputs.length !== expected.inputs.length) {
    throw new Error('Wallet changed transaction inputs; refusing to broadcast.');
  }
  for (let i = 0; i < expected.inputs.length; i++) {
    const actual = decoded.inputs[i];
    const planned = expected.inputs[i];
    if (binToHex(actual.outpointTransactionHash) !== binToHex(planned.outpointTransactionHash) ||
        actual.outpointIndex !== planned.outpointIndex ||
        actual.sequenceNumber !== planned.sequenceNumber) {
      throw new Error(`Wallet changed transaction input ${i}; refusing to broadcast.`);
    }
  }
  if (binToHex(encodeTransactionOutputs(decoded.outputs)) !==
      binToHex(encodeTransactionOutputs(expected.outputs))) {
    throw new Error('Wallet changed transaction outputs or CashTokens; refusing to broadcast.');
  }
  return decoded;
}

class WizardWallet {
  state: WalletState = 'idle';
  uri: string | null = null;
  qrUri: string | null = null;
  walletName: string | null = null;
  /** Receive-address index selected by matching Selene's displayed address. */
  receiveIndex = loadReceiveIndex();
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
    // Restore public xpub paths before the relay handshake so cached addresses
    // remain derivable during a page reload. These paths cannot sign or spend.
    restorePublicPaths(mgr);
    this.mgr = mgr;

    mgr.on('walletready', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.clearConnectionWatchdog();
      this.walletName = mgr.walletName;
      savePublicPaths(mgr);
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
      this.receiveIndex = loadReceiveIndex();
      this.state = 'disconnected';
      // A dropped mobile/background relay is not the user's request to forget
      // this wallet. Preserve the encrypted WizardConnect session so it can
      // be resumed when the browser returns to the foreground.
      this.cleanup(mgr, relay, false);
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
      this.connectionWatchdog = setTimeout(() => {
        if (!this.isCurrent(mgr, generation) || this.state !== 'connecting') return;
        this.error = existing
          ? 'Your saved Selene session has not responded. Retry the saved session or start a fresh pairing.'
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
    try {
      localStorage.removeItem(PATHS_STORAGE_KEY);
      localStorage.removeItem(RECEIVE_INDEX_STORAGE_KEY);
    } catch { /* best effort */ }
    this.error = null;
    this.state = 'idle';
    this.emit();
    this.connect();
  }

  /** Resume a stored WizardConnect session after reload or mobile app switching. */
  tryResume() {
    if (this.state !== 'idle' && this.state !== 'disconnected') return;
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
      try {
        localStorage.removeItem(PATHS_STORAGE_KEY);
        localStorage.removeItem(RECEIVE_INDEX_STORAGE_KEY);
      } catch { /* best effort */ }
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
        try { localStorage.setItem(RECEIVE_INDEX_STORAGE_KEY, String(i)); } catch { /* best effort */ }
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
    verifySignedTransaction(signedTransaction, wcObject?.transaction);
    const provider = await getProvider(network);
    return provider.sendRawTransaction(signedTransaction);
  }
}

export const wallet = new WizardWallet();
