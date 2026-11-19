// PUSD v3 member-credit and ACR transaction planners. Chipnet-only.
import {
  Contract, TransactionBuilder, placeholderP2PKHUnlocker,
  type SpendableUtxo, type Artifact,
} from 'cashscript';
import { encodeCashAddress, hexToBin } from '@bitauth/libauth';
import artifactJson from '../../contracts/AjoCirclePUSDV3.json' with { type: 'json' };
import { addressToPkh, type Net } from '../../src/lib/ajo';
import { configuredPusdCategory } from '../../src/lib/pusd';
import { DEFAULT_RETENTION_BPS, MAX_RETENTION_BPS } from '../../src/lib/retention';
import { getProvider } from './chain';
import { addOnchainDiscoveryOutputs, onchainDiscoveryMarkerCost, onchainDiscoveryOutputCount } from '../../src/lib/onchain-discovery.js';

const artifact = artifactJson as unknown as Artifact;
const DUST = 1_000n;
const CHANGE_DUST = 546n;
const CASH_INT_MAX = 0x7fffffffffffffffn;
const DEFAULT_FEE_RESERVE = 20_000n;

export interface PusdV3Params {
  version: 3;
  name: string;
  network: Net;
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  retentionBps?: bigint;
  stateCategory: string;
  pusdCategory?: string;
}
export type PusdV3Draft = Omit<PusdV3Params, 'stateCategory'>;

const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
const categoryFor = (p: PusdV3Draft | PusdV3Params) => (p.pusdCategory ?? configuredPusdCategory(p.network)).toLowerCase();

function validate(p: PusdV3Draft | PusdV3Params): void {
  if (p.version !== 3 || !p.name.trim()) throw new Error('Invalid PUSD v3 circle details');
  if (p.network !== 'chipnet') throw new Error('PUSD ACR v3 is Chipnet-only pending independent wallet and security review');
  if (p.members.length < 2 || p.members.length > 5) throw new Error('A PUSD v3 circle needs 2–5 members');
  const memberIds = p.members.map(a => hex(addressToPkh(a)));
  if (new Set(memberIds).size !== memberIds.length) throw new Error('Every member must have a unique address');
  if (p.contribution <= 0n || p.contribution > CASH_INT_MAX / BigInt(p.members.length)) throw new Error('PUSD contribution is outside the supported integer range');
  const rate = p.retentionBps ?? DEFAULT_RETENTION_BPS;
  if (rate < 0n || rate > MAX_RETENTION_BPS) throw new Error('ACR retention must be between 0% and 50%');
  const gross = BigInt(p.members.length) * p.contribution;
  const retained = (gross / 10_000n) * rate + ((gross % 10_000n) * rate / 10_000n);
  if (retained <= 0n || retained >= gross) throw new Error('PUSD contribution must be large enough to produce a positive retained amount and payout');
  if (p.maxFee < 5_000n || p.maxFee > CASH_INT_MAX || p.maxFee > 100_000_000n) throw new Error('PUSD BCH fee cap and reserve top-up must be between 5,000 and 100,000,000 sats.');
  const category = categoryFor(p);
  if (!/^[0-9a-f]{64}$/.test(category)) throw new Error('PUSD category must be 32-byte hex');
  if ('stateCategory' in p) {
    if (!/^[0-9a-f]{64}$/i.test(p.stateCategory)) throw new Error('Invalid circle token category');
    if (p.stateCategory.toLowerCase() === category) throw new Error('Circle and PUSD token categories must differ');
  }
}
function feeEstimate(inputs: number, outputs: number) { return BigInt(10 + inputs * 150 + outputs * 100 + 100); }
function receiptCommitment(index: number, credit: bigint) {
  if (!Number.isInteger(index) || index < 0 || index > 4 || credit < 0n || credit > CASH_INT_MAX) throw new Error('Invalid PUSD v3 member credit');
  return '52' + index.toString(16).padStart(2, '0') + credit.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}
function creditFrom(commitment: string) {
  if (!/^52[0-4][0-9a-f][0-9a-f]{16}$/i.test(commitment)) throw new Error('Invalid PUSD v3 member receipt');
  const value = BigInt('0x' + commitment.slice(4).match(/../g)!.reverse().join(''));
  if (value > CASH_INT_MAX) throw new Error('PUSD member credit exceeds the supported integer range');
  return value;
}
function tokenAddress(memberAddress: string, network: Net) {
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const result = encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: addressToPkh(memberAddress) });
  if (typeof result === 'string') throw new Error('Could not derive the member PUSD address');
  return result.address;
}
function findState(utxos: SpendableUtxo[], category: string) {
  const matches = utxos.filter(u => u.token?.category.toLowerCase() === category.toLowerCase()
    && u.token.nft?.capability === 'minting' && /^53(?:00|01|02|03|04)(?:00|01)$/.test(u.token.nft.commitment));
  if (matches.length !== 1) throw new Error(matches.length ? 'Duplicate PUSD v3 state NFT; stop and investigate.' : 'PUSD v3 state NFT not found.');
  if (matches[0].token!.amount !== 0n) throw new Error('PUSD v3 state NFT cannot carry fungible tokens.');
  return matches[0];
}
function findReceipt(utxos: SpendableUtxo[], category: string, index: number) {
  const prefix = '52' + index.toString(16).padStart(2, '0');
  const matches = utxos.filter(u => u.token?.category.toLowerCase() === category.toLowerCase()
    && u.token.nft?.capability === 'none' && u.token.nft.commitment.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `Duplicate PUSD v3 receipt for member ${index + 1}.` : `Missing PUSD v3 receipt for member ${index + 1}.`);
  if (matches[0].token!.amount !== 0n) throw new Error('PUSD v3 receipt cannot carry fungible tokens.');
  creditFrom(matches[0].token!.nft!.commitment);
  return matches[0];
}
function findPool(utxos: SpendableUtxo[], category: string, required: boolean) {
  const matches = utxos.filter(u => u.token?.category.toLowerCase() === category.toLowerCase() && u.token.amount > 0n && !u.token.nft);
  if (!required && matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error('Expected exactly one PUSD v3 member-credit pool UTXO.');
  return matches[0];
}
function assertStateSet(utxos: SpendableUtxo[], p: PusdV3Params) {
  const state = findState(utxos, p.stateCategory);
  const receipts = p.members.map((_, i) => findReceipt(utxos, p.stateCategory, i));
  const circleTokens = utxos.filter(u => u.token?.category.toLowerCase() === p.stateCategory.toLowerCase());
  if (circleTokens.length !== p.members.length + 1) throw new Error('Unexpected circle-category token at the PUSD v3 address.');
  const poolFlag = state.token!.nft!.commitment.slice(4);
  const pool = findPool(utxos, categoryFor(p), poolFlag === '01');
  if (poolFlag === '00' && pool) throw new Error('Unexpected PUSD pool before the first member deposit.');
  if (poolFlag !== '00' && poolFlag !== '01') throw new Error('Invalid PUSD v3 pool initialization flag.');
  const pools = utxos.filter(u => u.token?.category.toLowerCase() === categoryFor(p));
  if (pools.length !== (pool ? 1 : 0)) throw new Error('Unexpected or duplicate PUSD token output at the circle address.');
  const receiptTotal = receipts.reduce((sum, receipt) => sum + creditFrom(receipt.token!.nft!.commitment), 0n);
  if (pool && pool.token!.amount !== receiptTotal) throw new Error('PUSD pool amount does not equal the sum of member receipt credits.');
  if (!pool && receiptTotal !== 0n) throw new Error('Member receipts show credit but the PUSD pool is missing.');
  return { state, receipts, pool };
}
function selectExactTokenInputs(utxos: SpendableUtxo[], amount: bigint): SpendableUtxo[] {
  const candidates = utxos.filter(u => u.token?.amount && u.token.amount > 0n && !u.token.nft);
  // Bounded subset-sum avoids silently spending more tokens than the member credit.
  let states = new Map<bigint, SpendableUtxo[]>([[0n, []]]);
  for (const coin of candidates) {
    const next = new Map(states);
    for (const [sum, chosen] of states) {
      const candidate = sum + coin.token!.amount;
      if (candidate <= amount && !next.has(candidate)) next.set(candidate, [...chosen, coin]);
    }
    states = next;
    if (states.has(amount)) return states.get(amount)!;
    if (states.size > 5_000) break;
  }
  throw new Error('Could not select PUSD UTXOs that exactly match this contribution. Consolidate the member token balance and retry.');
}

export async function planPusdV3Genesis(draft: PusdV3Draft, walletAddress: string, reserveSats = DEFAULT_FEE_RESERVE) {
  validate(draft);
  const provider = await getProvider(draft.network);
  const coins = (await provider.getUtxos(walletAddress)).filter(u => !u.token).sort((a,b) => a.satoshis > b.satoshis ? -1 : 1);
  const genesis = coins.find(u => u.vout === 0);
  if (!genesis) throw new Error('PUSD v3 creation needs a non-token BCH output #0 for the circle token category. That coin has no 3,000-satoshi minimum; total BCH must cover state/receipt outputs, reserve, markers and fees.');
  const params: PusdV3Params = { ...draft, retentionBps: draft.retentionBps ?? DEFAULT_RETENTION_BPS, stateCategory: genesis.txid, pusdCategory: categoryFor(draft) };
  const pkhs = params.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  const contract = new Contract(artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4], BigInt(params.members.length),
    params.contribution, params.maxFee, params.retentionBps,
    hexToBin(params.stateCategory).reverse(), hexToBin(params.pusdCategory!).reverse(),
  ] as any, { provider, contractType: 'p2sh32' });
  const discovery = { formatVersion: 1 as const, contractVersion: 3 as const, network: params.network, asset: 'PUSD' as const, name: params.name, members: params.members, contribution: params.contribution, maxFee: params.maxFee, retentionBps: params.retentionBps ?? DEFAULT_RETENTION_BPS, pusdCategory: params.pusdCategory! };
  const discoveryCost = onchainDiscoveryMarkerCost(discovery);
  const outputCount = params.members.length + 3 + onchainDiscoveryOutputCount(discovery);
  const inputs: SpendableUtxo[] = [genesis];
  let total = genesis.satoshis;
  for (const coin of coins) {
    if (coin.txid === genesis.txid && coin.vout === genesis.vout) continue;
    if (total >= DUST + BigInt(params.members.length) * DUST + reserveSats + discoveryCost + feeEstimate(inputs.length, outputCount) + 250n + CHANGE_DUST) break;
    inputs.push(coin); total += coin.satoshis;
  }
  const fee = feeEstimate(inputs.length, outputCount) + 250n;
  const change = total - DUST - BigInt(params.members.length) * DUST - reserveSats - discoveryCost - fee;
  if (change < CHANGE_DUST) throw new Error('Not enough BCH for PUSD v3 state, member receipts, reserve and change.');
  const b = new TransactionBuilder({ provider });
  inputs.forEach(u => b.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  b.addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: '530000' } } });
  for (let i = 0; i < params.members.length; i++) b.addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(i, 0n) } } });
  b.addOutput({ to: contract.address, amount: reserveSats });
  addOnchainDiscoveryOutputs(b, discovery);
  b.addOutput({ to: walletAddress, amount: change });
  const wc = b.generateWcTransactionObject({ broadcast: false, userPrompt: `Create PUSD ACR v3 circle "${params.name}" with 20% default retention` });
  return { params, contract, wc, walletInputs: inputs.map((_, i) => i), reserveSats };
}

export async function planPusdV3Deposit(params: PusdV3Params, memberIndex: number, amount: bigint, walletAddress: string) {
  validate(params);
  if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= params.members.length) throw new Error('Invalid PUSD v3 member index');
  if (hex(addressToPkh(walletAddress)) !== hex(addressToPkh(params.members[memberIndex]))) throw new Error('Connected wallet does not match this registered member.');
  if (amount <= 0n || amount > CASH_INT_MAX) throw new Error('Invalid PUSD contribution amount');
  const provider = await getProvider(params.network);
  const pkhs = params.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  const contract = new Contract(artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4], BigInt(params.members.length),
    params.contribution, params.maxFee, params.retentionBps ?? DEFAULT_RETENTION_BPS,
    hexToBin(params.stateCategory).reverse(), hexToBin(categoryFor(params)).reverse(),
  ] as any, { provider, contractType: 'p2sh32' });
  const all = await contract.getUtxos();
  const { state, receipts, pool } = assertStateSet(all, params);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  if (round < 0 || round >= params.members.length) throw new Error('PUSD v3 circle is complete or has invalid round state.');
  const hasPool = !!pool;
  const walletUtxos = await provider.getUtxos(walletAddress);
  const tokenInputs = selectExactTokenInputs(walletUtxos, amount);
  const tokenBacking = tokenInputs.reduce((sum, u) => sum + u.satoshis, 0n);
  if (tokenBacking < DUST) throw new Error('Selected PUSD inputs do not carry enough BCH dust backing.');
  const placeholderFee = params.maxFee;
  const reserve = walletUtxos.filter(u => !u.token && u.satoshis >= 2n * params.maxFee + CHANGE_DUST)
    .sort((a,b) => a.satoshis < b.satoshis ? -1 : 1)[0];
  if (!reserve) throw new Error('A separate BCH input must cover the reserve top-up, a fee-estimation placeholder, and member change.');
  const oldCredit = creditFrom(receipts[memberIndex].token!.nft!.commitment);
  if (oldCredit > CASH_INT_MAX - amount) throw new Error('PUSD member credit would overflow.');
  const make = (fee: bigint) => {
    const b = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), amount, hasPool))
      .addInput(receipts[memberIndex], contract.unlock.addCredit(BigInt(memberIndex), amount, hasPool));
    if (pool) b.addInput(pool, contract.unlock.addCredit(BigInt(memberIndex), amount, true));
    tokenInputs.forEach(u => b.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
    b.addInput(reserve, placeholderP2PKHUnlocker(walletAddress));
    b.addOutput({ to: contract.tokenAddress, amount: state.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: '53' + state.token!.nft!.commitment.slice(2, 4) + '01' } } });
    b.addOutput({ to: contract.tokenAddress, amount: receipts[memberIndex].satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(memberIndex, oldCredit + amount) } } });
    b.addOutput({ to: contract.tokenAddress, amount: (pool?.satoshis ?? 0n) + tokenBacking, token: { category: categoryFor(params), amount: (pool?.token?.amount ?? 0n) + amount } });
    b.addOutput({ to: contract.address, amount: params.maxFee });
    b.addOutput({ to: walletAddress, amount: reserve.satoshis - params.maxFee - fee });
    return b;
  };
  const draft = make(placeholderFee).build();
  const fee = BigInt(Math.ceil(draft.length / 2)) + 10n;
  if (fee > params.maxFee || reserve.satoshis < params.maxFee + fee + CHANGE_DUST) {
    throw new Error('The actual serialized PUSD deposit fee exceeds the configured cap or the selected BCH input cannot cover the reserve top-up and change.');
  }
  const builder = make(fee);
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Add ${amount.toString()} PUSD to your ACR v3 member credit and top up the circle BCH fee reserve` });
  return { wc, walletInputs: Array.from({ length: tokenInputs.length + 1 }, (_, i) => (pool ? 3 : 2) + i), credited: amount, newCredit: oldCredit + amount, fee };
}

export async function planPusdV3Payout(params: PusdV3Params) {
  validate(params);
  const provider = await getProvider(params.network);
  const pkhs = params.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  const contract = new Contract(artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4], BigInt(params.members.length),
    params.contribution, params.maxFee, params.retentionBps ?? DEFAULT_RETENTION_BPS,
    hexToBin(params.stateCategory).reverse(), hexToBin(categoryFor(params)).reverse(),
  ] as any, { provider, contractType: 'p2sh32' });
  const all = await contract.getUtxos();
  const { state, receipts, pool } = assertStateSet(all, params);
  if (!pool) throw new Error('No PUSD member-credit pool exists yet.');
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  if (round < 0 || round > params.members.length) throw new Error('PUSD v3 circle has invalid round state.');
  const completed = round === params.members.length;
  const credits = receipts.map(r => creditFrom(r.token!.nft!.commitment));
  if (credits.some(credit => credit < params.contribution)) throw new Error('Payout blocked: every member must independently cover one full contribution.');
  const totalCredits = credits.reduce((sum, credit) => sum + credit, 0n);
  if (totalCredits !== pool.token!.amount) throw new Error('PUSD pool and member receipt totals do not reconcile. Stop and investigate.');
  const grossPayout = BigInt(params.members.length) * params.contribution;
  const retentionBps = params.retentionBps ?? DEFAULT_RETENTION_BPS;
  const retained = (grossPayout / 10_000n) * retentionBps + ((grossPayout % 10_000n) * retentionBps / 10_000n);
  if (retained <= 0n || retained >= grossPayout) throw new Error('ACR retention leaves no valid PUSD payout at this contribution size.');
  if (pool.satoshis < 2n * DUST) throw new Error('PUSD pool does not contain enough BCH backing for recipient and rollover outputs.');
  const reserve = all.filter(u => !u.token && u.satoshis >= DUST + params.maxFee)
    .sort((a,b) => a.satoshis > b.satoshis ? -1 : 1)[0];
  if (!reserve) throw new Error('PUSD circle fee reserve is insufficient for payout.');
  const estimatedFee = feeEstimate(params.members.length + 3, params.members.length + 4);
  if (estimatedFee > params.maxFee || reserve.satoshis - estimatedFee < DUST) throw new Error('PUSD payout fee exceeds the configured reserve or maxFee.');
  const recipientTokenAmount = grossPayout - retained;
  const poolAfter = totalCredits - grossPayout + retained;
  if (poolAfter <= 0n) throw new Error('ACR rollover pool must remain positive.');
  const make = (fee: bigint) => {
    const b = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.payout())
      .addInputs(receipts, contract.unlock.payout())
      .addInput(pool, contract.unlock.payout())
      .addInput(reserve, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: state.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: '53' + ((round + 1) % params.members.length).toString(16).padStart(2, '0') + '01' } } });
    receipts.forEach((r, i) => {
      const next = credits[i] - params.contribution + (i === round ? retained : 0n);
      b.addOutput({ to: contract.tokenAddress, amount: r.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(i, next) } } });
    });
    b.addOutput({ to: tokenAddress(params.members[round], params.network), amount: DUST, token: { category: categoryFor(params), amount: recipientTokenAmount } });
    b.addOutput({ to: contract.tokenAddress, amount: pool.satoshis - DUST, token: { category: categoryFor(params), amount: poolAfter } });
    b.addOutput({ to: contract.address, amount: reserve.satoshis - fee });
    return b;
  };
  const draft = make(params.maxFee).build();
  const fee = BigInt(Math.ceil(draft.length / 2)) + 10n;
  if (fee > params.maxFee || reserve.satoshis - fee < DUST) throw new Error('PUSD payout fee exceeds the configured maxFee or available BCH reserve.');
  const builder = make(fee);
  return { builder, round, recipient: params.members[round], grossPayout, retained, retentionBps, payout: recipientTokenAmount, fee, credits: receipts.map((_, i) => credits[i] - params.contribution + (i === round ? retained : 0n)) };
}


export async function readPusdV3Circle(params: PusdV3Params) {
  validate(params);
  const provider = await getProvider(params.network);
  const pkhs = params.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  const contract = new Contract(artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4], BigInt(params.members.length),
    params.contribution, params.maxFee, params.retentionBps ?? DEFAULT_RETENTION_BPS,
    hexToBin(params.stateCategory).reverse(), hexToBin(categoryFor(params)).reverse(),
  ] as any, { provider, contractType: 'p2sh32' });
  const utxos = await contract.getUtxos();
  const { state, receipts, pool } = assertStateSet(utxos, params);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  if (round < 0 || round > params.members.length) throw new Error('PUSD v3 circle has invalid round state.');
  const completed = round === params.members.length;
  const credits = receipts.map(r => creditFrom(r.token!.nft!.commitment));
  const totalCredits = credits.reduce((sum, credit) => sum + credit, 0n);
  if (pool && pool.token!.amount !== totalCredits) throw new Error('PUSD pool and member receipts do not reconcile.');
  const ready = !completed && !!pool && totalCredits === pool.token!.amount && credits.every(credit => credit >= params.contribution);
  return { contract, utxos, state, receipts, pool, round, credits, totalCredits, ready, completed, recipient: completed ? null : params.members[round] };
}
