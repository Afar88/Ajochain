import {
  Contract,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  placeholderPublicKey,
  placeholderSignature,
  type Artifact,
  type NetworkProvider,
  type SpendableUtxo,
} from 'cashscript';
import { hexToBin } from '@bitauth/libauth';
import artifactJson from '../../contracts/AjoCircleV2Fee.json' with { type: 'json' };
import {
  addressToPkh,
  assertNewBchContribution,
  treasuryAddressToPkh,
  type Net,
} from '../../src/lib/ajo';
import { getProvider } from './chain';

const artifact = artifactJson as unknown as Artifact;
const STATE_DUST = 1_000n;
const RECEIPT_DUST = 1_000n;
const CHANGE_DUST = 546n;
const CASH_SCRIPT_INT_MAX = 0x7fffffffffffffffn;

export interface V2FeeCircleParams {
  version: 2;
  covenant: 'fee-v1';
  name: string;
  network: Net;
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  stateCategory: string;
  initiator: string;
  treasury: string;
}
export type V2FeeCircleDraft = Omit<V2FeeCircleParams, 'stateCategory'>;

const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
const feeEstimate = (memberCount: number) => 6_000n + BigInt(memberCount) * 500n;
const genesisFeeEstimate = (inputs: number, outputs: number) => BigInt(10 + inputs * 150 + outputs * 100 + 100);

function validate(p: V2FeeCircleDraft | V2FeeCircleParams): void {
  if (p.version !== 2 || p.covenant !== 'fee-v1' || !p.name.trim()) throw new Error('Invalid V2 fee-circle details');
  if (p.network !== 'chipnet') throw new Error('The V2 fee covenant is Chipnet-only.');
  if (p.members.length < 2 || p.members.length > 5) throw new Error('A V2 fee circle needs 2–5 members');
  const members = p.members.map(a => hex(treasuryAddressToPkh(a, p.network)));
  if (new Set(members).size !== members.length) throw new Error('Each member must have a unique BCH address');
  assertNewBchContribution(p.contribution);
  if (p.contribution > CASH_SCRIPT_INT_MAX) throw new Error('Contribution exceeds the CashScript integer limit');
  if (p.maxFee < 1_000n || p.maxFee > CASH_SCRIPT_INT_MAX) throw new Error('Maximum miner fee must be at least 1,000 sats and within the CashScript integer limit');
  const pot = BigInt(p.members.length) * p.contribution;
  const projectFee = pot / 100n;
  if (projectFee < 546n) throw new Error('The 1% project fee must be at least 546 sats to remain dust-safe');
  if (p.maxFee > pot - projectFee - 546n) throw new Error('Maximum miner fee must leave a dust-safe payout after the 1% project fee');
  const estimate = feeEstimate(p.members.length);
  if (p.maxFee < estimate) throw new Error(`This V2 fee version needs maxFee of at least ${estimate.toString()} sats for its conservative transaction estimate.`);
  treasuryAddressToPkh(p.initiator, p.network);
  treasuryAddressToPkh(p.treasury, p.network);
}

function contractFor(p: V2FeeCircleParams, provider: NetworkProvider): Contract {
  validate(p);
  const pkhs = p.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  return new Contract(artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4],
    BigInt(p.members.length), p.contribution, p.maxFee,
    hexToBin(p.stateCategory).reverse(),
    addressToPkh(p.initiator),
    treasuryAddressToPkh(p.treasury, p.network),
  ] as any, { provider, contractType: 'p2sh32' });
}

export function v2FeeStateCommitment(round: number, hasPaid: boolean): string {
  if (!Number.isInteger(round) || round < 0 || round > 4) throw new Error('Invalid V2 fee state round');
  return '54' + round.toString(16).padStart(2, '0') + (hasPaid ? '01' : '00');
}

export function v2FeeReceiptCommitment(index: number, credit: bigint): string {
  if (!Number.isInteger(index) || index < 0 || index > 4 || credit < 0n || credit > CASH_SCRIPT_INT_MAX) throw new Error('Invalid V2 member receipt data');
  return '52' + index.toString(16).padStart(2, '0') + credit.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}

export function v2FeeCreditFromCommitment(commitment: string): bigint {
  if (!/^52[0-4][0-9a-f][0-9a-f]{16}$/i.test(commitment)) throw new Error('Invalid V2 member receipt commitment');
  const credit = BigInt('0x' + commitment.slice(4).match(/../g)!.reverse().join(''));
  if (credit > CASH_SCRIPT_INT_MAX) throw new Error('Member credit exceeds the CashScript integer limit');
  return credit;
}

function findState(utxos: SpendableUtxo[], category: string) {
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'minting' && /^54[0-4][01]$/.test(u.token.nft.commitment));
  if (matches.length !== 1) throw new Error(matches.length ? 'Multiple V2 fee state NFTs found; stop and investigate.' : 'V2 fee state NFT not found or has an invalid commitment.');
  if (matches[0].token!.amount !== 0n) throw new Error('V2 fee state NFT unexpectedly carries fungible tokens.');
  return matches[0];
}

function findReceipt(utxos: SpendableUtxo[], category: string, index: number) {
  const prefix = '52' + index.toString(16).padStart(2, '0');
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'none' && u.token.nft.commitment.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `Duplicate receipt for member ${index + 1}; stop and investigate.` : `Missing receipt for member ${index + 1}; refresh the circle.`);
  if (matches[0].token!.amount !== 0n) throw new Error(`Member ${index + 1} receipt unexpectedly carries fungible tokens.`);
  v2FeeCreditFromCommitment(matches[0].token!.nft!.commitment);
  return matches[0];
}

function assertUtxoSet(utxos: SpendableUtxo[], category: string, memberCount: number) {
  const categoryUtxos = utxos.filter(u => u.token?.category === category);
  if (categoryUtxos.length !== memberCount + 1) throw new Error(`Invalid V2 fee token set: expected ${memberCount + 1} state/receipt NFTs, found ${categoryUtxos.length}. Stop and investigate.`);
  const state = findState(utxos, category);
  const receipts = Array.from({ length: memberCount }, (_, index) => findReceipt(utxos, category, index));
  const known = new Set([state, ...receipts].map(u => `${u.txid}:${u.vout}`));
  if (categoryUtxos.some(u => !known.has(`${u.txid}:${u.vout}`))) throw new Error('Unexpected CashToken output found at the V2 fee circle address. Stop and investigate.');
}

function pickFunding(utxos: SpendableUtxo[], required: bigint) {
  const coin = [...utxos].filter(u => !u.token).sort((a, b) => a.satoshis > b.satoshis ? -1 : 1).find(u => u.satoshis >= required);
  if (!coin) throw new Error('No single BCH coin can cover this action and its fee reserve. Consolidate funds first.');
  return coin;
}

/** Genesis creates a new 0x54 state NFT and one immutable receipt per member. */
export async function planV2FeeGenesis(draft: V2FeeCircleDraft, walletAddress: string) {
  const paramsBase = { ...draft, initiator: walletAddress };
  validate({ ...paramsBase, stateCategory: '00'.repeat(32) });
  const provider = await getProvider(draft.network);
  const coins = (await provider.getUtxos(walletAddress)).filter(u => !u.token);
  const genesis = coins.find(u => u.vout === 0 && u.satoshis >= 3_000n);
  if (!genesis) throw new Error('V2 fee creation needs a non-token BCH UTXO at vout 0 for its CashTokens category. Check wallet funding before sending more BCH.');
  const params: V2FeeCircleParams = { ...paramsBase, stateCategory: genesis.txid };
  const contract = contractFor(params, provider);
  const outputs = params.members.length + 2;
  const inputs: SpendableUtxo[] = [genesis];
  let total = genesis.satoshis;
  for (const coin of coins) {
    if (coin.txid === genesis.txid && coin.vout === genesis.vout) continue;
    if (total >= STATE_DUST + BigInt(params.members.length) * RECEIPT_DUST + genesisFeeEstimate(inputs.length, outputs) + CHANGE_DUST) break;
    inputs.push(coin);
    total += coin.satoshis;
  }
  const fee = genesisFeeEstimate(inputs.length, outputs);
  const change = total - STATE_DUST - BigInt(params.members.length) * RECEIPT_DUST - fee;
  if (change < CHANGE_DUST) throw new Error('Not enough BCH to create the V2 fee state, receipts, and change.');
  const builder = new TransactionBuilder({ provider });
  inputs.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: v2FeeStateCommitment(0, false) } } });
  for (let i = 0; i < params.members.length; i++) builder.addOutput({ to: contract.tokenAddress, amount: RECEIPT_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2FeeReceiptCommitment(i, 0n) } } });
  builder.addOutput({ to: walletAddress, amount: change });
  return { params, contract, wc: builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Create V2 fee circle "${params.name}" and mint ${params.members.length} member receipts` }), walletInputs: inputs.map((_, i) => i) };
}

/** Member-specific deposit preserves the 0x54 state and increments only that member's receipt. */
export async function planV2FeeDeposit(params: V2FeeCircleParams, memberIndex: number, amount: bigint, walletAddress: string) {
  validate(params);
  if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= params.members.length) throw new Error('Invalid member index');
  if (amount <= 0n || amount > CASH_SCRIPT_INT_MAX) throw new Error('Deposit amount is outside the supported CashScript integer range');
  if (hex(addressToPkh(params.members[memberIndex])) !== hex(addressToPkh(walletAddress))) throw new Error('Connected wallet does not match this member slot.');
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertUtxoSet(all, params.stateCategory, params.members.length);
  const state = findState(all, params.stateCategory);
  const receipt = findReceipt(all, params.stateCategory, memberIndex);
  const fee = feeEstimate(params.members.length);
  if (fee > params.maxFee) throw new Error('The configured maxFee is too low for a safe V2 member deposit.');
  const funding = pickFunding((await provider.getUtxos(walletAddress)).filter(u => !u.token), amount + fee + CHANGE_DUST);
  const oldCredit = v2FeeCreditFromCommitment(receipt.token!.nft!.commitment);
  if (oldCredit + amount > CASH_SCRIPT_INT_MAX) throw new Error('This deposit would exceed the supported member-credit limit.');
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(receipt, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(funding, placeholderP2PKHUnlocker(walletAddress))
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis + amount, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } } })
    .addOutput({ to: contract.tokenAddress, amount: receipt.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2FeeReceiptCommitment(memberIndex, oldCredit + amount) } } })
    .addOutput({ to: walletAddress, amount: funding.satoshis - amount - fee });
  return { wc: builder.generateWcTransactionObject({ broadcast: false, userPrompt: 'Add credit to your V2 member receipt' }), walletInputs: [2], memberIndex, credited: amount, newCredit: oldCredit + amount };
}

/** Anyone can trigger a payout; the covenant enforces the 1% treasury output and miner-fee ceiling. */
export async function planV2FeePayout(params: V2FeeCircleParams) {
  validate(params);
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertUtxoSet(all, params.stateCategory, params.members.length);
  const state = findState(all, params.stateCategory);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const hasPaid = state.token!.nft!.commitment.slice(4) === '01';
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) throw new Error('Invalid V2 fee payout round.');
  const receipts = params.members.map((_, i) => findReceipt(all, params.stateCategory, i));
  const credits = receipts.map(u => v2FeeCreditFromCommitment(u.token!.nft!.commitment));
  if (credits.some(c => c < params.contribution)) throw new Error('Payout is blocked until every member has one full contribution in their own receipt.');
  const pot = BigInt(params.members.length) * params.contribution;
  const projectFee = pot / 100n;
  const minerFee = feeEstimate(params.members.length);
  if (minerFee > params.maxFee) throw new Error('Estimated miner fee exceeds this circle maxFee.');
  if (state.satoshis - pot < STATE_DUST) throw new Error('Payout would reduce the state reserve below 1,000 sats.');
  const recipientAmount = pot - projectFee - minerFee;
  if (projectFee < 546n || recipientAmount < CHANGE_DUST) throw new Error('The payout fee split would create a dust output.');
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis - pot, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: v2FeeStateCommitment((round + 1) % params.members.length, true) } } });
  receipts.forEach((receipt, i) => {
    const credit = credits[i];
    builder.addOutput({ to: contract.tokenAddress, amount: receipt.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2FeeReceiptCommitment(i, credit - params.contribution) } } });
  });
  builder.addOutput({ to: params.treasury, amount: projectFee });
  builder.addOutput({ to: params.members[round], amount: recipientAmount });
  return { builder, round, recipient: params.members[round], gross: pot, projectFee, minerFee, payout: recipientAmount, hasPaid };
}

/** Initiator-only cancellation refunds every member's exact receipt credit and attached BCH. */
export async function planV2FeeCancel(params: V2FeeCircleParams, walletAddress: string) {
  validate(params);
  if (hex(addressToPkh(walletAddress)) !== hex(addressToPkh(params.initiator))) throw new Error('Only the circle initiator can cancel before the first payout.');
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertUtxoSet(all, params.stateCategory, params.members.length);
  const state = findState(all, params.stateCategory);
  const stateCommitment = state.token!.nft!.commitment;
  const round = Number.parseInt(stateCommitment.slice(2, 4), 16);
  const hasPaid = stateCommitment.slice(4) === '01';
  if (hasPaid) throw new Error('Cancellation is permanently disabled after the first payout.');
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) throw new Error('Invalid V2 fee state round.');
  const receipts = params.members.map((_, i) => findReceipt(all, params.stateCategory, i));
  const credits = receipts.map(u => v2FeeCreditFromCommitment(u.token!.nft!.commitment));
  if (state.satoshis !== credits.reduce((sum, credit) => sum + credit, STATE_DUST)) throw new Error('State BCH does not match the exact member-credit total. Stop and investigate.');
  const minerFee = feeEstimate(params.members.length);
  if (minerFee > params.maxFee) throw new Error('Estimated cancellation miner fee exceeds this circle maxFee.');
  const requiredFunding = minerFee - STATE_DUST + CHANGE_DUST;
  const funding = pickFunding((await provider.getUtxos(walletAddress)).filter(u => !u.token), requiredFunding);
  const change = funding.satoshis + STATE_DUST - minerFee;
  if (change < CHANGE_DUST) throw new Error('The initiator fee input cannot fund a dust-safe cancellation.');
  const builder = new TransactionBuilder({ provider });
  const pk = placeholderPublicKey();
  const sig = placeholderSignature();
  const contractUnlocker = contract.unlock.cancel(pk, sig);
  builder.addInput(state, contractUnlocker);
  builder.addInputs(receipts, contractUnlocker);
  builder.addInput(funding, placeholderP2PKHUnlocker(walletAddress));
  receipts.forEach((receipt, i) => builder.addOutput({ to: params.members[i], amount: receipt.satoshis + credits[i] }));
  builder.addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Cancel V2 circle "${params.name}" and refund every member` });
  return { wc, walletInputs: Array.from({ length: params.members.length + 2 }, (_, i) => i), minerFee, refunds: credits };
}

/** Read and validate the complete V2 fee state before showing balances or actions. */
export async function readV2FeeCircle(params: V2FeeCircleParams) {
  validate(params);
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const utxos = await contract.getUtxos();
  assertUtxoSet(utxos, params.stateCategory, params.members.length);
  const state = findState(utxos, params.stateCategory);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const hasPaid = state.token!.nft!.commitment.slice(4) === '01';
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) throw new Error('Invalid V2 fee payout round.');
  const receipts = params.members.map((_, i) => findReceipt(utxos, params.stateCategory, i));
  const credits = receipts.map(u => v2FeeCreditFromCommitment(u.token!.nft!.commitment));
  return {
    contract,
    utxos,
    round,
    hasPaid,
    stateSatoshis: state.satoshis,
    credits,
    ready: credits.every(c => c >= params.contribution),
    recipient: params.members[round],
  };
}
