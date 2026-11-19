import { Contract, TransactionBuilder, placeholderP2PKHUnlocker, type SpendableUtxo, type Artifact, type NetworkProvider } from 'cashscript';
import { hexToBin } from '@bitauth/libauth';
import artifactJson from '../../contracts/AjoCircleV3.json' with { type: 'json' };
import { addressToPkh, type Net } from '../../src/lib/ajo';
import { getProvider } from './chain';
import { DEFAULT_RETENTION_BPS, MAX_RETENTION_BPS } from '../../src/lib/retention';
import { addOnchainDiscoveryOutputs, onchainDiscoveryMarkerCost, onchainDiscoveryOutputCount } from '../../src/lib/onchain-discovery.js';

const artifact = artifactJson as unknown as Artifact;
const STATE_DUST = 1000n;
const RECEIPT_DUST = 1000n;
const CHANGE_DUST = 546n;
const STATE_PREFIX = '53';
const RECEIPT_PREFIX = '52';
const CASH_SCRIPT_INT_MAX = 0x7fffffffffffffffn;

export interface V3CircleParams {
  version: 3;
  name: string;
  network: Net;
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  retentionBps?: bigint;
  stateCategory: string;
}
export type V3CircleDraft = Omit<V3CircleParams, 'stateCategory'>;

const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
function validate(p: V3CircleDraft | V3CircleParams): void {
  if (p.network !== 'chipnet') throw new Error('AjoChain ACR v3 is Chipnet-only. Mainnet is not ready or authorized for this release.');
  if (p.version !== 3 || !p.name.trim()) throw new Error('Invalid v3 circle details');
  if (p.members.length < 2 || p.members.length > 5) throw new Error('A v3 circle needs 2–5 members');
  const members = p.members.map(a => hex(addressToPkh(a)));
  if (new Set(members).size !== members.length) throw new Error('Each member must have a unique BCH address');
  if (p.contribution < 1000n || p.contribution > CASH_SCRIPT_INT_MAX) throw new Error('Contribution must be between 1,000 sats and the CashScript integer limit');
  const retentionBps = p.retentionBps ?? DEFAULT_RETENTION_BPS;
  if (retentionBps < 0n || retentionBps > MAX_RETENTION_BPS) throw new Error('ACR retention must be between 0% and 50%');
  const gross = BigInt(p.members.length) * p.contribution;
  const retained = (gross / 10_000n) * retentionBps + ((gross % 10_000n) * retentionBps / 10_000n);
  if (p.maxFee < 0n || p.maxFee > CASH_SCRIPT_INT_MAX || p.maxFee > gross - retained - STATE_DUST) throw new Error('maxFee must leave at least 1000 sats for the recipient after ACR retention.');
  if ('stateCategory' in p && !/^[0-9a-f]{64}$/i.test(p.stateCategory)) throw new Error('Invalid v3 token category');
}
function feeEstimate(inputs: number, outputs: number) { return BigInt(10 + inputs * 150 + outputs * 100 + 100); }
function contractFor(p: V3CircleParams, provider: NetworkProvider): Contract {
  validate(p);
  const pkhs = p.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  return new Contract(artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4], BigInt(p.members.length),
    p.contribution, p.maxFee, p.retentionBps ?? DEFAULT_RETENTION_BPS, hexToBin(p.stateCategory).reverse(),
  ] as any, { provider, contractType: 'p2sh32' });
}
export function v3ReceiptCommitment(index: number, credit: bigint): string {
  if (!Number.isInteger(index) || index < 0 || index > 4 || credit < 0n || credit > CASH_SCRIPT_INT_MAX) throw new Error('Invalid member receipt data');
  return RECEIPT_PREFIX + index.toString(16).padStart(2, '0') + credit.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}
export function v3CreditFromCommitment(commitment: string): bigint {
  if (!/^52[0-4][0-9a-f][0-9a-f]{16}$/i.test(commitment)) throw new Error('Invalid member receipt commitment');
  const credit = BigInt('0x' + commitment.slice(4).match(/../g)!.reverse().join(''));
  if (credit > CASH_SCRIPT_INT_MAX) throw new Error('Member credit exceeds the CashScript integer limit');
  return credit;
}
function findState(utxos: SpendableUtxo[], category: string) {
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'minting' && /^53(?:00|01|02|03|04)$/.test(u.token.nft.commitment));
  if (matches.length !== 1) throw new Error(matches.length ? 'Multiple v3 state NFTs found; stop and investigate.' : 'V3 state NFT not found or has an invalid commitment.');
  if (matches[0].token!.amount !== 0n) throw new Error('V3 state NFT unexpectedly carries fungible tokens.');
  return matches[0];
}
function findReceipt(utxos: SpendableUtxo[], category: string, index: number) {
  const prefix = RECEIPT_PREFIX + index.toString(16).padStart(2, '0');
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'none' && u.token.nft.commitment.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `Duplicate receipt for member ${index + 1}; stop and investigate.` : `Missing receipt for member ${index + 1}; refresh the circle.`);
  if (matches[0].token!.amount !== 0n) throw new Error(`Member ${index + 1} receipt unexpectedly carries fungible tokens.`);
  v3CreditFromCommitment(matches[0].token!.nft!.commitment);
  return matches[0];
}

/** Reject unexpected category UTXOs at the covenant address instead of silently ignoring them. */
function assertV3UtxoSet(utxos: SpendableUtxo[], category: string, memberCount: number) {
  const categoryUtxos = utxos.filter(u => u.token?.category === category);
  if (categoryUtxos.length !== memberCount + 1) {
    throw new Error(`Invalid v3 circle token set: expected exactly ${memberCount + 1} state/receipt NFTs, found ${categoryUtxos.length}. Stop and investigate before spending.`);
  }
  const state = findState(utxos, category);
  if (!state) throw new Error('V3 state NFT not found.');
  const receipts = Array.from({ length: memberCount }, (_, index) => findReceipt(utxos, category, index));
  const knownOutpoints = new Set([state, ...receipts].map(u => `${u.txid}:${u.vout}`));
  if (categoryUtxos.some(u => !knownOutpoints.has(`${u.txid}:${u.vout}`))) {
    throw new Error('Unexpected CashToken output found at the v3 circle address. Stop and investigate.');
  }
}

function pickFunding(utxos: SpendableUtxo[], required: bigint) {
  const coin = [...utxos].filter(u => !u.token).sort((a,b) => a.satoshis > b.satoshis ? -1 : 1).find(u => u.satoshis >= required);
  if (!coin) throw new Error('No single BCH coin at this address can cover the amount and fee. Consolidate funds first.');
  return coin;
}

/** V3 genesis creates the state NFT and all member receipt NFTs in one inspected transaction. */
export async function planV3Genesis(draft: V3CircleDraft, walletAddress: string) {
  validate(draft);
  const provider = await getProvider(draft.network);
  const coins = (await provider.getUtxos(walletAddress)).filter(u => !u.token);
  const genesis = coins.find(u => u.vout === 0);
  if (!genesis) throw new Error('V3 creation needs a non-token BCH UTXO at vout 0 for its CashTokens category. That coin has no 3,000-satoshi minimum; total BCH must cover the state NFT, member receipts, markers and fees.');
  const params: V3CircleParams = { ...draft, retentionBps: draft.retentionBps ?? DEFAULT_RETENTION_BPS, stateCategory: genesis.txid };
  const contract = contractFor(params, provider);
  const discovery = { formatVersion: 1 as const, contractVersion: 3 as const, network: params.network, asset: 'BCH' as const, name: params.name, members: params.members, contribution: params.contribution, maxFee: params.maxFee, retentionBps: params.retentionBps ?? DEFAULT_RETENTION_BPS };
  const discoveryCost = onchainDiscoveryMarkerCost(discovery);
  const outputs = params.members.length + 2 + onchainDiscoveryOutputCount(discovery);
  const inputs: SpendableUtxo[] = [genesis];
  let total = genesis.satoshis;
  for (const coin of coins) {
    if (coin.txid === genesis.txid && coin.vout === genesis.vout) continue;
    if (total >= STATE_DUST + BigInt(params.members.length) * RECEIPT_DUST + discoveryCost + feeEstimate(inputs.length, outputs) + 250n + CHANGE_DUST) break;
    inputs.push(coin);
    total += coin.satoshis;
  }
  const fee = feeEstimate(inputs.length, outputs) + 250n;
  const change = total - STATE_DUST - BigInt(params.members.length) * RECEIPT_DUST - discoveryCost - fee;
  if (change < CHANGE_DUST) throw new Error('Not enough BCH to create the v3 state, member receipts, and change.');
  const builder = new TransactionBuilder({ provider });
  inputs.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: '5300' } } });
  for (let i = 0; i < params.members.length; i++) builder.addOutput({ to: contract.tokenAddress, amount: RECEIPT_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v3ReceiptCommitment(i, 0n) } } });
  addOnchainDiscoveryOutputs(builder, discovery);
  builder.addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Create v3 Ajo circle "${params.name}" and mint ${params.members.length} member receipts` });
  return { params, contract, wc, walletInputs: inputs.map((_, i) => i) };
}

/** Member-specific deposit: only the registered member's funding input is wallet-signed. */
export async function planV3Deposit(params: V3CircleParams, memberIndex: number, amount: bigint, walletAddress: string) {
  validate(params);
  if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= params.members.length) throw new Error('Invalid member index');
  if (amount <= 0n || amount > CASH_SCRIPT_INT_MAX) throw new Error('Deposit amount is outside the supported CashScript integer range');
  if (hex(addressToPkh(params.members[memberIndex])) !== hex(addressToPkh(walletAddress))) throw new Error('Connected wallet does not match this member slot.');
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertV3UtxoSet(all, params.stateCategory, params.members.length);
  const state = findState(all, params.stateCategory);
  if (!state) throw new Error('V3 state NFT not found.');
  const receipt = findReceipt(all, params.stateCategory, memberIndex);
  const fee = feeEstimate(3, 3);
  if (fee > params.maxFee) throw new Error('Estimated deposit fee exceeds this circle maxFee.');
  const funding = pickFunding((await provider.getUtxos(walletAddress)).filter(u => !u.token), amount + fee + CHANGE_DUST);
  const change = funding.satoshis - amount - fee;
  const oldCredit = v3CreditFromCommitment(receipt.token!.nft!.commitment);
  if (oldCredit + amount > CASH_SCRIPT_INT_MAX) throw new Error('This deposit would exceed the supported member-credit limit.');
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(receipt, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(funding, placeholderP2PKHUnlocker(walletAddress))
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis + amount, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } } })
    .addOutput({ to: contract.tokenAddress, amount: receipt.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v3ReceiptCommitment(memberIndex, oldCredit + amount) } } })
    .addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Add ${amount.toString()} sats to your AjoChain v3 member credit` });
  return { wc, walletInputs: [2], memberIndex, credited: amount, newCredit: oldCredit + amount };
}

/** Anyone can trigger a v3 payout; the covenant controls every output. */
export async function planV3Payout(params: V3CircleParams) {
  validate(params);
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertV3UtxoSet(all, params.stateCategory, params.members.length);
  const state = findState(all, params.stateCategory);
  if (!state) throw new Error('V3 state NFT not found.');
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2), 16);
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) throw new Error('Invalid v3 payout round.');
  const receipts = params.members.map((_, i) => findReceipt(all, params.stateCategory, i));
  for (let i = 0; i < receipts.length; i++) if (v3CreditFromCommitment(receipts[i].token!.nft!.commitment) < params.contribution) throw new Error(`Member ${i + 1} has insufficient credit; payout is blocked.`);
  const pot = BigInt(params.members.length) * params.contribution;
  const retentionBps = params.retentionBps ?? DEFAULT_RETENTION_BPS;
  const retained = (pot / 10_000n) * retentionBps + ((pot % 10_000n) * retentionBps / 10_000n);
  if (retained >= pot) throw new Error('ACR retention must leave a positive payout for the scheduled member.');
  if (state.satoshis - pot + retained < STATE_DUST) throw new Error('Payout would reduce the state reserve below 1,000 sats.');
  const make = (fee: bigint) => {
    const b = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.payout())
      .addInputs(receipts, contract.unlock.payout())
      .addOutput({ to: contract.tokenAddress, amount: state.satoshis - pot + retained, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: '53' + ((round + 1) % params.members.length).toString(16).padStart(2, '0') } } });
    receipts.forEach((receipt, i) => {
      const credit = v3CreditFromCommitment(receipt.token!.nft!.commitment);
      b.addOutput({ to: contract.tokenAddress, amount: receipt.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v3ReceiptCommitment(i, credit - params.contribution + (i === round ? retained : 0n)) } } });
    });
    b.addOutput({ to: params.members[round], amount: pot - retained - fee });
    return b;
  };
  const draft = make(1n).build();
  const fee = BigInt(Math.ceil(draft.length / 2)) + 10n;
  if (fee > params.maxFee) throw new Error(`Estimated BCH miner fee ${fee} sats exceeds this circle's maxFee ${params.maxFee} sats.`);
  const payout = pot - retained - fee;
  const builder = make(fee);
  return { builder, round, recipient: params.members[round], payout, grossPayout: pot, retained, retentionBps, fee };
}


/** Read and validate the complete v3 state before rendering balances or actions. */
export async function readV3Circle(params: V3CircleParams) {
  validate(params);
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const utxos = await contract.getUtxos();
  assertV3UtxoSet(utxos, params.stateCategory, params.members.length);
  const state = findState(utxos, params.stateCategory);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2), 16);
  if (round < 0 || round > params.members.length) throw new Error('Invalid v3 payout round.');
  const completed = round === params.members.length;
  const receipts = params.members.map((_, index) => findReceipt(utxos, params.stateCategory, index));
  const credits = receipts.map(receipt => v3CreditFromCommitment(receipt.token!.nft!.commitment));
  const totalCredits = credits.reduce((sum, credit) => sum + credit, 0n);
  if (state.satoshis < totalCredits + STATE_DUST) throw new Error('BCH state reserve is below the member-credit ledger. Stop and investigate before spending.');
  return {
    contract,
    utxos,
    round,
    stateSatoshis: state.satoshis,
    credits,
    ready: !completed && credits.every(credit => credit >= params.contribution),
    completed,
    recipient: completed ? null : params.members[round],
  };
}
