// In-browser demo circle. Runs the REAL compiled AjoCircle covenant against
// CashScript's MockNetworkProvider, which evaluates every transaction in the BCH VM.
// Nothing touches a real network; keys are deterministic throwaways.
import { MockNetworkProvider, TransactionBuilder, randomUtxo, type Contract } from 'cashscript';
import { secp256k1, hash160 } from '@bitauth/libauth';
import {
  circleContract, circleStatus, buildPayout, encodeRound, pkhToAddress,
  STATE_DUST, type CircleParams, type CircleStatus,
} from '../../src/lib/ajo';

export const DEMO_NAMES = ['Adaeze', 'Bisi', 'Chidi', 'Dayo', 'Efe'];
const DEMO_CATEGORY = 'a10c'.repeat(16);

function demoAddress(i: number) {
  const priv = new Uint8Array(32);
  priv[0] = 0xa1; priv[31] = i + 1;
  return pkhToAddress(hash160(secp256k1.derivePublicKeyCompressed(priv) as Uint8Array), 'chipnet');
}

export interface LogEntry { kind: 'ok' | 'bad' | 'info'; text: string; detail?: string }

export class DemoCircle {
  provider = new MockNetworkProvider();
  params: CircleParams = {
    name: 'Mama Nkechi’s Market Circle',
    network: 'chipnet',
    members: DEMO_NAMES.map((_, i) => demoAddress(i)),
    contribution: 100_000n, // 0.001 BCH (~₦ small change) per member per round
    maxFee: 10_000n,
    stateCategory: DEMO_CATEGORY,
  };
  contract: Contract = circleContract(this.params, this.provider);
  paidThisRound = new Set<number>();
  payouts: { round: number; amount: bigint; fee: bigint; txid: string }[] = [];
  log: LogEntry[] = [];
  status!: CircleStatus;

  constructor() {
    this.provider.addUtxo(this.contract.address, randomUtxo({
      satoshis: STATE_DUST,
      token: { category: DEMO_CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: encodeRound(0) } },
    }));
    // Head start: three members already paid in for round 1.
    [0, 1, 2].forEach((i) => this.addContribution(i, true));
    this.log.unshift({ kind: 'info', text: 'Circle started. State NFT locked in the contract, round 1 of 5.' });
  }

  async refresh() { this.status = circleStatus(this.params, await this.contract.getUtxos()); return this.status; }

  addContribution(i: number, silent = false) {
    this.provider.addUtxo(this.contract.address, randomUtxo({ satoshis: this.params.contribution }));
    this.paidThisRound.add(i);
    if (!silent) this.log.unshift({ kind: 'info', text: `${DEMO_NAMES[i]} paid in 0.001 BCH.` });
  }

  async payout() {
    const s = await this.refresh();
    const who = s.recipientIndex !== null ? DEMO_NAMES[s.recipientIndex] : '';
    const r = buildPayout(this.params, this.contract, await this.contract.getUtxos(), this.provider);
    const txid = (await r.builder.send()).txid;
    this.payouts.push({ round: r.round, amount: r.amount, fee: r.fee, txid });
    this.paidThisRound.clear();
    this.log.unshift({ kind: 'ok', text: `Covenant approved: pot sent to ${who}. Nobody signed.`, detail: `txid ${txid.slice(0, 16)}… · miner fee ${r.fee} sats` });
    await this.refresh();
  }

  /** Try to send this round's pot to someone else; the covenant must reject it. */
  async cheat() {
    const s = await this.refresh();
    if (!s.stateUtxo || s.recipientIndex === null) return;
    const thief = (s.recipientIndex + 1) % DEMO_NAMES.length;
    const tx = new TransactionBuilder({ provider: this.provider })
      .addInput(s.stateUtxo, this.contract.unlock.payout())
      .addInputs(s.contributionUtxos, this.contract.unlock.payout())
      .addOutput({ to: this.contract.tokenAddress, amount: STATE_DUST, token: { category: DEMO_CATEGORY, amount: 0n, nft: { capability: 'mutable', commitment: encodeRound(s.round! + 1) } } })
      .addOutput({ to: this.params.members[thief], amount: s.available - 8000n });
    try {
      await tx.send();
      this.log.unshift({ kind: 'bad', text: 'Unexpected: cheat accepted!?' });
    } catch (e: any) {
      const m = String(e?.message ?? e).match(/message: ([^.\n]+)/);
      this.log.unshift({
        kind: 'bad',
        text: `Blocked: ${DEMO_NAMES[thief]} tried to grab the pot out of turn.`,
        detail: `Contract said: “${m ? m[1] : 'require failed'}”`,
      });
    }
  }
}
