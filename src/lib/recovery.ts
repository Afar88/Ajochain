// Read-only verification of a Classic (V1) AjoCircle's on-chain state.
// Nothing here signs, spends or migrates funds. It turns the contract's UTXO set into
// a report the UI can show, and flags anything that would make recovery unsafe.
import type { Utxo } from 'cashscript';
import { pot, STATE_DUST, type CircleParams } from './ajo.js';

export type RecoveryIssueCode =
  | 'missing_state'
  | 'duplicate_state'
  | 'immutable_state'
  | 'wrong_category'
  | 'invalid_commitment'
  | 'state_value_low'
  | 'invalid_balance'
  | 'completed';

export interface RecoveryIssue {
  code: RecoveryIssueCode;
  message: string;
  outpoint?: string;
}

export interface ClassicRecoveryReport {
  /** true when the state NFT is present, unique, mutable and its round is valid. */
  stateVerified: boolean;
  stateOutpoint: string | null;
  round: number | null;
  memberCount: number;
  /** Sats held in plain (token-free) contribution UTXOs. */
  contributionBalance: bigint;
  /** Sats held by the state UTXO itself (dust carried by the NFT). */
  stateValue: bigint;
  pot: bigint;
  /** Scheduled payout possible right now under contract rules. */
  payoutPossible: boolean;
  /** Sats still missing before the current round can pay out. */
  shortfall: bigint;
  /** Unanimous cancel needs a signature from every one of these addresses. */
  cancelSigners: string[];
  issues: RecoveryIssue[];
}

const op = (u: Utxo) => `${u.txid}:${u.vout}`;

export function verifyClassicCircle(p: CircleParams, utxos: Utxo[]): ClassicRecoveryReport {
  const issues: RecoveryIssue[] = [];
  const N = p.members.length;
  const P = pot(p);

  const tokenUtxos = utxos.filter((u) => !!u.token);
  const rightCategory = tokenUtxos.filter((u) => u.token!.category === p.stateCategory);
  for (const u of tokenUtxos.filter((u) => u.token!.category !== p.stateCategory)) {
    issues.push({ code: 'wrong_category', outpoint: op(u), message: `Token UTXO ${op(u)} has category ${u.token!.category}, not this circle's state category. It is ignored and cannot be used by payout().` });
  }
  const mutable = rightCategory.filter((u) => u.token!.nft?.capability === 'mutable');
  for (const u of rightCategory.filter((u) => u.token!.nft?.capability !== 'mutable')) {
    issues.push({ code: 'immutable_state', outpoint: op(u), message: `UTXO ${op(u)} carries the circle category but is not a mutable NFT, so the contract will not accept it as state.` });
  }
  if (mutable.length === 0) issues.push({ code: 'missing_state', message: 'The circle-state NFT is not at the contract address. Either the circle never started, the genesis is unconfirmed, or the NFT was moved by a unanimous cancel.' });
  if (mutable.length > 1) issues.push({ code: 'duplicate_state', message: `Found ${mutable.length} state NFTs of this category; expected exactly one.` });

  const state = mutable.length === 1 ? mutable[0] : null;
  let round: number | null = null;
  if (state) {
    const c = state.token!.nft!.commitment ?? '';
    if (!/^[0-9a-f]{2}$/i.test(c)) {
      issues.push({ code: 'invalid_commitment', outpoint: op(state), message: `State commitment "${c}" is not a single round byte.` });
    } else {
      round = parseInt(c, 16);
      if (round > 0x7f) { issues.push({ code: 'invalid_commitment', outpoint: op(state), message: `Round byte 0x${c} decodes as negative in script; payout() would fail.` }); round = null; }
      else if (round >= N) issues.push({ code: 'completed', outpoint: op(state), message: `Round ${round} means all ${N} payouts are done.` });
    }
    if (state.satoshis < STATE_DUST) issues.push({ code: 'state_value_low', outpoint: op(state), message: `State UTXO holds ${state.satoshis} sats, below the ${STATE_DUST} dust value the app expects.` });
  }

  const plain = utxos.filter((u) => !u.token);
  for (const u of plain) {
    if (typeof u.satoshis !== 'bigint' || u.satoshis <= 0n) issues.push({ code: 'invalid_balance', outpoint: op(u), message: `UTXO ${op(u)} reports an invalid value (${String(u.satoshis)}).` });
  }
  const contributionBalance = plain.reduce((s, u) => (typeof u.satoshis === 'bigint' && u.satoshis > 0n ? s + u.satoshis : s), 0n);

  const blocking = issues.some((i) => i.code !== 'wrong_category' && i.code !== 'state_value_low');
  const stateVerified = !!state && round !== null && !blocking;
  const payoutPossible = stateVerified && contributionBalance >= P;
  return {
    stateVerified,
    stateOutpoint: state ? op(state) : null,
    round,
    memberCount: N,
    contributionBalance,
    stateValue: state ? state.satoshis : 0n,
    pot: P,
    payoutPossible,
    shortfall: payoutPossible || !stateVerified ? 0n : P - contributionBalance,
    cancelSigners: [...p.members],
    issues,
  };
}
