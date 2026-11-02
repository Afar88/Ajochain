// PUSD circle transaction helpers. Experimental: do not use with mainnet funds.
import {
  Contract, TransactionBuilder,
  type NetworkProvider, type SpendableUtxo, type Artifact,
} from 'cashscript';
import { hexToBin, encodeCashAddress } from '@bitauth/libauth';
import pusdArtifactJson from '../../contracts/AjoCirclePUSD.json' with { type: 'json' };
import { addressToPkh, type CircleParams, type Net, EMPTY_PKH } from './ajo';

export const PUSD_CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
export const PUSD_DUST = 1000n;
export const PUSD_DEFAULT_RESERVE = 20_000n;
export type PusdParams = CircleParams & { pusdCategory?: string };

export interface PusdCircleParams {
  name: string;
  network: Net;
  members: string[];
  contribution: bigint; // PUSD base units per member per round
  stateCategory: string;
  pusdCategory?: string;
}

export function validatePusdParams(p: PusdCircleParams): void {
  if (!p.name.trim()) throw new Error('Circle name is required');
  if (p.network !== 'chipnet' && p.network !== 'mainnet') throw new Error('Invalid network');
  if (p.members.length < 2 || p.members.length > 5) throw new Error('A PUSD circle needs 2–5 members');
  p.members.forEach(addressToPkh);
  if (p.contribution <= 0n) throw new Error('PUSD contribution must be positive');
  if (!/^[0-9a-f]{64}$/i.test(p.stateCategory)) throw new Error('stateCategory must be 32-byte hex');
  const category = p.pusdCategory ?? PUSD_CATEGORY;
  if (!/^[0-9a-f]{64}$/i.test(category)) throw new Error('PUSD category must be 32-byte hex');
  if (category.toLowerCase() === p.stateCategory.toLowerCase()) throw new Error('State and PUSD categories must differ');
}

export function pusdConstructorArgs(p: PusdCircleParams) {
  validatePusdParams(p);
  const pkhs = p.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(EMPTY_PKH);
  return [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4],
    BigInt(p.members.length), p.contribution,
    hexToBin(p.stateCategory).reverse(),
    hexToBin(p.pusdCategory ?? PUSD_CATEGORY).reverse(),
  ] as const;
}

export function pusdContract(p: PusdCircleParams, provider: NetworkProvider): Contract {
  return new Contract(pusdArtifactJson as unknown as Artifact, pusdConstructorArgs(p) as any, {
    provider, contractType: 'p2sh32',
  });
}

export function isPusdUtxo(u: SpendableUtxo, category = PUSD_CATEGORY): boolean {
  return !!u.token && u.token.category.toLowerCase() === category.toLowerCase() && u.token.amount > 0n;
}

export function isPusdStateUtxo(u: SpendableUtxo, stateCategory: string): boolean {
  return !!u.token && u.token.category.toLowerCase() === stateCategory.toLowerCase()
    && u.token.amount === 0n && u.token.nft?.capability === 'mutable';
}

export interface PusdStatus {
  round: number | null;
  completed: boolean;
  available: bigint;
  required: bigint;
  ready: boolean;
  stateUtxo?: SpendableUtxo;
  tokenUtxos: SpendableUtxo[];
  reserveUtxos: SpendableUtxo[];
}

export function pusdStatus(p: PusdCircleParams, utxos: SpendableUtxo[]): PusdStatus {
  validatePusdParams(p);
  const category = p.pusdCategory ?? PUSD_CATEGORY;
  const stateUtxo = utxos.find(u => isPusdStateUtxo(u, p.stateCategory));
  const tokenUtxos = utxos.filter(u => isPusdUtxo(u, category));
  const reserveUtxos = utxos.filter(u => !u.token && u.satoshis >= PUSD_DUST);
  const available = tokenUtxos.reduce((sum,u) => sum + (u.token?.amount ?? 0n), 0n);
  const round = stateUtxo?.token?.nft?.commitment ? parseInt(stateUtxo.token.nft.commitment.slice(0,2),16) : stateUtxo ? 0 : null;
  const completed = round !== null && round >= p.members.length;
  const required = BigInt(p.members.length) * p.contribution;
  return { round, completed, available, required, ready: !!stateUtxo && !completed && available >= required && reserveUtxos.length > 0, stateUtxo, tokenUtxos, reserveUtxos };
}

/**
 * Build a permissionless PUSD payout. The token-bearing input BCH backing is
 * preserved in the recipient/surplus outputs; only the token-free reserve pays
 * the miner fee. Caller must provide all relevant circle UTXOs from the provider.
 */
export function buildPusdPayout(
  p: PusdCircleParams,
  contract: Contract,
  utxos: SpendableUtxo[],
  provider: NetworkProvider,
  feeRate = 1,
): { builder: TransactionBuilder; fee: bigint; recipient: string; tokenAmount: bigint; round: number } {
  const s = pusdStatus(p, utxos);
  if (!s.stateUtxo) throw new Error('PUSD circle not started: state NFT not found');
  if (s.completed) throw new Error('PUSD circle is complete');
  if (s.available < s.required) throw new Error(`PUSD pot not full: ${s.available} of ${s.required} base units`);
  if (!s.reserveUtxos.length) throw new Error('A token-free BCH fee reserve is required');
  const round = s.round ?? 0;
  const category = p.pusdCategory ?? PUSD_CATEGORY;
  const tokenInputs = s.tokenUtxos;
  const tokenBacking = tokenInputs.reduce((sum,u)=>sum+u.satoshis,0n);
  const tokenTotal = s.available;
  const surplus = tokenTotal - s.required;
  const recipientPkh = addressToPkh(p.members[round]);
  const recipientAddress = encodeCashAddress({ prefix: p.network === 'mainnet' ? 'bitcoincash' : 'bchtest', type: 'p2pkhWithTokens', payload: recipientPkh });
  if (typeof recipientAddress === 'string') throw new Error('Could not derive token-aware recipient address');
  const reserve = [...s.reserveUtxos].sort((a,b)=>a.satoshis>b.satoshis?-1:a.satoshis<b.satoshis?1:0)[0];
  const reserveChangeIndex = surplus > 0n ? 3 : 2;
  const make = (change: bigint) => {
    const b = new TransactionBuilder({ provider });
    b.addInput(s.stateUtxo!, contract.unlock.payout());
    b.addInputs(tokenInputs, contract.unlock.payout());
    b.addInput(reserve, contract.unlock.payout());
    b.addOutput({to:contract.tokenAddress,amount:s.stateUtxo!.satoshis,token:{category:p.stateCategory,amount:0n,nft:{capability:'mutable',commitment:(round+1).toString(16).padStart(2,'0')}}});
    const recipientBacking = surplus > 0n ? tokenBacking - PUSD_DUST : tokenBacking;
    if (recipientBacking < PUSD_DUST) throw new Error('PUSD token inputs do not carry enough BCH dust backing');
    b.addOutput({to:recipientAddress.address,amount:recipientBacking,token:{category,amount:s.required}});
    if (surplus > 0n) b.addOutput({to:contract.tokenAddress,amount:PUSD_DUST,token:{category,amount:surplus}});
    b.addOutput({to:contract.address,amount:change});
    return b;
  };
  // First construct with minimum-valid reserve change to measure serialized size.
  const draft = make(PUSD_DUST).build();
  const fee = BigInt(Math.ceil((draft.length / 2) * feeRate)) + 10n;
  const change = reserve.satoshis - fee;
  if (change < PUSD_DUST) throw new Error('BCH fee reserve is too small for this payout');
  return {builder:make(change),fee,recipient:p.members[round],tokenAmount:s.required,round};
}
