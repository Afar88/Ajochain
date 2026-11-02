// AjoChain shared library: used by the unit tests and by the web app.
import {
  Contract,
  TransactionBuilder,
  type NetworkProvider,
  type Utxo,
  type SpendableUtxo,
  type Artifact,
} from 'cashscript';
import {
  decodeCashAddress,
  encodeCashAddress,
  hexToBin,
  binToHex,
} from '@bitauth/libauth';
import artifactJson from '../../contracts/AjoCircle.json' with { type: 'json' };

export const artifact = artifactJson as unknown as Artifact;

export const MAX_MEMBERS = 5;
export const MIN_MEMBERS = 2;
/** BCH kept on the state UTXO (it never moves out of the circle). */
export const STATE_DUST = 1000n;
/** Default cap on the miner fee taken from the pot per payout. */
export const DEFAULT_MAX_FEE = 10_000n;
export const EMPTY_PKH = new Uint8Array(20);

export type Net = 'chipnet' | 'mainnet';

export interface CircleParams {
  name: string;
  network: Net;
  /** Member P2PKH cash addresses, in payout order. */
  members: string[];
  /** Contribution per member per round, in sats. */
  contribution: bigint;
  /** Max miner fee per payout, in sats (deducted from the pot). */
  maxFee: bigint;
  /** 32-byte hex category of the circle-state NFT (txid of the genesis outpoint, vout 0). */
  stateCategory: string;
}

/** Extract the 20-byte public key hash from a P2PKH cash address. */
export function addressToPkh(address: string): Uint8Array {
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === 'string') throw new Error(`Invalid address: ${address} (${decoded})`);
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    throw new Error(`Members must use regular (P2PKH) addresses: ${address}`);
  }
  return decoded.payload;
}

export function pkhToAddress(pkh: Uint8Array, network: Net): string {
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const r = encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh });
  return typeof r === 'string' ? r : r.address;
}

export function validateParams(p: CircleParams): void {
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('Circle name is required');
  if (p.network !== 'chipnet' && p.network !== 'mainnet') throw new Error('Invalid network');
  if (!Array.isArray(p.members)) throw new Error('Members must be an array');
  if (p.members.length < MIN_MEMBERS || p.members.length > MAX_MEMBERS) {
    throw new Error(`A circle needs ${MIN_MEMBERS}-${MAX_MEMBERS} members`);
  }
  p.members.forEach(addressToPkh);
  if (p.contribution < 1000n) throw new Error('Contribution must be at least 1000 sats');
  if (p.maxFee < 0n) throw new Error('maxFee must be >= 0');
  if (p.maxFee >= BigInt(p.members.length) * p.contribution) {
    throw new Error('maxFee must be less than the circle pot');
  }
  if (!/^[0-9a-f]{64}$/i.test(p.stateCategory)) throw new Error('stateCategory must be 32-byte hex');
}

export function constructorArgs(p: CircleParams) {
  const pkhs = p.members.map(addressToPkh);
  while (pkhs.length < MAX_MEMBERS) pkhs.push(EMPTY_PKH);
  return [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4],
    BigInt(p.members.length),
    p.contribution,
    p.maxFee,
    // NFT categories are shown as txids (big-endian); the VM compares the raw
    // (little-endian) bytes, so reverse before passing it to the contract.
    hexToBin(p.stateCategory).reverse(),
  ] as const;
}

export function circleContract(p: CircleParams, provider: NetworkProvider): Contract {
  validateParams(p);
  return new Contract(artifact, constructorArgs(p) as any, { provider, contractType: 'p2sh32' });
}

export function pot(p: CircleParams): bigint {
  return BigInt(p.members.length) * p.contribution;
}

export function isStateUtxo(u: Utxo, p: CircleParams): boolean {
  return !!u.token && u.token.category === p.stateCategory && u.token.nft?.capability === 'mutable';
}

export function decodeRound(commitment: string): number {
  if (!commitment) return 0;
  return parseInt(commitment.slice(0, 2), 16);
}

export function encodeRound(round: number): string {
  return round.toString(16).padStart(2, '0');
}

export interface CircleStatus {
  round: number | null; // null = state NFT not found (circle not started)
  completed: boolean;
  recipientIndex: number | null;
  recipient: string | null;
  available: bigint; // BCH in contribution UTXOs
  pot: bigint;
  ready: boolean;
  stateUtxo?: SpendableUtxo;
  contributionUtxos: SpendableUtxo[];
}

export function circleStatus(p: CircleParams, utxos: SpendableUtxo[]): CircleStatus {
  const stateUtxo = utxos.find((u) => isStateUtxo(u, p));
  const contributionUtxos = utxos.filter((u) => !u.token);
  const available = contributionUtxos.reduce((s, u) => s + u.satoshis, 0n);
  const round = stateUtxo ? decodeRound(stateUtxo.token!.nft!.commitment) : null;
  const completed = round !== null && round >= p.members.length;
  const recipientIndex = round !== null && !completed ? round : null;
  const P = pot(p);
  return {
    round,
    completed,
    recipientIndex,
    recipient: recipientIndex !== null ? p.members[recipientIndex] : null,
    available,
    pot: P,
    ready: !!stateUtxo && !completed && available >= P,
    stateUtxo,
    contributionUtxos,
  };
}

/**
 * Build the keyless payout transaction. Nobody signs: the covenant itself decides
 * where the money may go. The fee is capped by maxFee; any sub-dust surplus is
 * included in the recipient's payout instead of being consumed as extra fee.
 */
export function buildPayout(
  p: CircleParams,
  contract: Contract,
  utxos: SpendableUtxo[],
  provider: NetworkProvider,
  feeRate = 1.0,
): { builder: TransactionBuilder; fee: bigint; recipient: string; amount: bigint; round: number } {
  const s = circleStatus(p, utxos);
  if (!s.stateUtxo) throw new Error('Circle not started: state NFT not found at the circle address');
  if (s.completed) throw new Error('Circle completed: every member has been paid');
  if (!s.ready) throw new Error(`Pot not full yet: ${s.available} of ${s.pot} sats`);

  const round = s.round!;
  const P = s.pot;
  // Use the largest contribution UTXOs first, stopping once the pot is covered.
  // This keeps the tx small (fee <= maxFee) and leaves early contributions untouched.
  const sorted = [...s.contributionUtxos].sort((a, b) => (b.satoshis > a.satoshis ? 1 : b.satoshis < a.satoshis ? -1 : 0));
  const picked: SpendableUtxo[] = [];
  let pickedSum = 0n;
  for (const u of sorted) {
    if (pickedSum >= P) break;
    picked.push(u);
    pickedSum += u.satoshis;
  }
  const surplus = pickedSum - P;

  const make = (fee: bigint) => {
    const b = new TransactionBuilder({ provider });
    b.addInput(s.stateUtxo!, contract.unlock.payout());
    b.addInputs(picked, contract.unlock.payout());
    b.addOutput({
      to: contract.tokenAddress,
      amount: s.stateUtxo!.satoshis,
      token: {
        category: p.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: encodeRound(round + 1) },
      },
    });
    // If surplus is too small to create a dust-safe change output, pay it to
    // the recipient rather than silently adding it to the miner fee.
    const recipientAmount = (surplus < 1000n ? pickedSum : P) - fee;
    b.addOutput({ to: s.recipient!, amount: recipientAmount });
    if (surplus >= 1000n) b.addOutput({ to: contract.address, amount: surplus });
    return b;
  };

  // Two-pass fee estimation: build with a placeholder fee, measure, rebuild.
  const placeholder = pot(p) - 1000n < 200_000n ? pot(p) - 1000n : 200_000n;
  const draft = make(placeholder).build();
  const size = BigInt(draft.length / 2);
  const fee = BigInt(Math.ceil(Number(size) * feeRate)) + 10n;
  if (fee > p.maxFee) {
    throw new Error(`Fee ${fee} exceeds the circle's maxFee ${p.maxFee}; too many small contribution UTXOs`);
  }
  const amount = (surplus < 1000n ? pickedSum : P) - fee;
  return { builder: make(fee), fee, recipient: s.recipient!, amount, round };
}

/** Encode circle params into a shareable string (URL hash). */
export function encodeCircle(p: CircleParams): string {
  const json = JSON.stringify({
    n: p.name, net: p.network, m: p.members, c: p.contribution.toString(),
    f: p.maxFee.toString(), k: p.stateCategory,
  });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCircle(s: string): CircleParams {
  if (typeof s !== 'string' || !s || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error('Invalid circle link encoding');
  }
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  let o: any;
  try {
    o = JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch {
    throw new Error('Invalid circle link data');
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Invalid circle link data');
  if (typeof o.n !== 'string' || (o.net !== 'chipnet' && o.net !== 'mainnet')) {
    throw new Error('Invalid circle details');
  }
  if (!Array.isArray(o.m) || !o.m.every((m: unknown) => typeof m === 'string')) {
    throw new Error('Invalid circle members');
  }
  let contribution: bigint;
  let maxFee: bigint;
  try {
    if (typeof o.c !== 'string' || !/^[0-9]+$/.test(o.c)) throw new Error();
    if (typeof o.f !== 'string' || !/^[0-9]+$/.test(o.f)) throw new Error();
    contribution = BigInt(o.c);
    maxFee = BigInt(o.f);
  } catch {
    throw new Error('Invalid circle amounts');
  }
  const params: CircleParams = {
    name: o.n, network: o.net, members: o.m, contribution,
    maxFee, stateCategory: o.k,
  };
  validateParams(params);
  return params;
}

export { binToHex, hexToBin };
