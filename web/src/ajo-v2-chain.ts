import { Contract, TransactionBuilder, placeholderP2PKHUnlocker, type SpendableUtxo, type Artifact, type NetworkProvider } from 'cashscript';
import { hexToBin } from '@bitauth/libauth';
import artifactJson from '../../contracts/AjoCircleV2.json' with { type: 'json' };
import { addressToPkh, type Net } from '../../src/lib/ajo';
import { getProvider } from './chain';

const artifact = artifactJson as unknown as Artifact;
const STATE_DUST = 1000n;
const RECEIPT_DUST = 1000n;
const CHANGE_DUST = 546n;
const STATE_PREFIX = '53';
const RECEIPT_PREFIX = '52';
const CASH_SCRIPT_INT_MAX = 0x7fffffffffffffffn;

export interface V2CircleParams {
  version: 2;
  name: string;
  network: Net;
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  stateCategory: string;
}
export type V2CircleDraft = Omit<V2CircleParams, 'stateCategory'>;

const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
function validate(p: V2CircleDraft | V2CircleParams): void {
  if (p.version !== 2 || !p.name.trim()) throw new Error('Invalid v2 circle details');
  if (p.members.length < 2 || p.members.length > 5) throw new Error('A v2 circle needs 2–5 members');
  const members = p.members.map(a => hex(addressToPkh(a)));
  if (new Set(members).size !== members.length) throw new Error('Each member must have a unique BCH address');
  if (p.contribution < 1000n || p.contribution > CASH_SCRIPT_INT_MAX) throw new Error('Contribution must be between 1,000 sats and the CashScript integer limit');
  if (p.maxFee < 0n || p.maxFee > CASH_SCRIPT_INT_MAX || p.maxFee > BigInt(p.members.length) * p.contribution - STATE_DUST) throw new Error('maxFee must leave at least 1000 sats for the recipient');
  if ('stateCategory' in p && !/^[0-9a-f]{64}$/i.test(p.stateCategory)) throw new Error('Invalid v2 token category');
}
function feeEstimate(inputs: number, outputs: number) { return BigInt(10 + inputs * 150 + outputs * 100 + 100); }
function contractFor(p: V2CircleParams, provider: NetworkProvider): Contract {
  validate(p);
  const pkhs = p.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  return new Contract(artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4], BigInt(p.members.length),
    p.contribution, p.maxFee, hexToBin(p.stateCategory).reverse(),
  ] as any, { provider, contractType: 'p2sh32' });
}
export function v2ReceiptCommitment(index: number, credit: bigint): string {
  if (!Number.isInteger(index) || index < 0 || index > 4 || credit < 0n || credit > CASH_SCRIPT_INT_MAX) throw new Error('Invalid member receipt data');
  return RECEIPT_PREFIX + index.toString(16).padStart(2, '0') + credit.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}
export function v2CreditFromCommitment(commitment: string): bigint {
  if (!/^52[0-4][0-9a-f][0-9a-f]{16}$/i.test(commitment)) throw new Error('Invalid member receipt commitment');
  const credit = BigInt('0x' + commitment.slice(4).match(/../g)!.reverse().join(''));
  if (credit > CASH_SCRIPT_INT_MAX) throw new Error('Member credit exceeds the CashScript integer limit');
  return credit;
}
function findState(utxos: SpendableUtxo[], category: string) {
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'minting' && /^53[0-4]$/.test(u.token.nft.commitment));
  if (matches.length !== 1) throw new Error(matches.length ? 'Multiple v2 state NFTs found; stop and investigate.' : 'V2 state NFT not found or has an invalid commitment.');
  if (matches[0].token!.amount !== 0n) throw new Error('V2 state NFT unexpectedly carries fungible tokens.');
  return matches[0];
}
function findReceipt(utxos: SpendableUtxo[], category: string, index: number) {
  const prefix = RECEIPT_PREFIX + index.toString(16).padStart(2, '0');
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'none' && u.token.nft.commitment.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `Duplicate receipt for member ${index + 1}; stop and investigate.` : `Missing receipt for member ${index + 1}; refresh the circle.`);
  v2CreditFromCommitment(matches[0].token!.nft!.commitment);
  return matches[0];
}
function pickFunding(utxos: SpendableUtxo[], required: bigint) {
  const coin = [...utxos].filter(u => !u.token).sort((a,b) => a.satoshis > b.satoshis ? -1 : 1).find(u => u.satoshis >= required);
  if (!coin) throw new Error('No single BCH coin at this address can cover the amount and fee. Consolidate funds first.');
  return coin;
}

/** V2 genesis creates the state NFT and all member receipt NFTs in one inspected transaction. */
export async function planV2Genesis(draft: V2CircleDraft, walletAddress: string) {
  validate(draft);
  const provider = await getProvider(draft.network);
  const coins = (await provider.getUtxos(walletAddress)).filter(u => !u.token);
  const genesis = coins.find(u => u.vout === 0 && u.satoshis >= 3000n);
  if (!genesis) throw new Error('V2 creation needs a non-token BCH UTXO at vout 0 for its CashTokens category. Check wallet funding; do not send more BCH until this is confirmed.');
  const params: V2CircleParams = { ...draft, stateCategory: genesis.txid };
  const contract = contractFor(params, provider);
  const outputs = params.members.length + 2;
  const inputs: SpendableUtxo[] = [genesis];
  let total = genesis.satoshis;
  for (const coin of coins) {
    if (coin.txid === genesis.txid && coin.vout === genesis.vout) continue;
    if (total >= STATE_DUST + BigInt(params.members.length) * RECEIPT_DUST + feeEstimate(inputs.length, outputs) + CHANGE_DUST) break;
    inputs.push(coin);
    total += coin.satoshis;
  }
  const fee = feeEstimate(inputs.length, outputs);
  const change = total - STATE_DUST - BigInt(params.members.length) * RECEIPT_DUST - fee;
  if (change < CHANGE_DUST) throw new Error('Not enough BCH to create the v2 state, member receipts, and change.');
  const builder = new TransactionBuilder({ provider });
  inputs.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: '5300' } } });
  for (let i = 0; i < params.members.length; i++) builder.addOutput({ to: contract.tokenAddress, amount: RECEIPT_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2ReceiptCommitment(i, 0n) } } });
  builder.addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Create v2 Ajo circle "${params.name}" and mint ${params.members.length} member receipts` });
  return { params, contract, wc, walletInputs: inputs.map((_, i) => i) };
}

/** Member-specific deposit: only the registered member's funding input is wallet-signed. */
export async function planV2Deposit(params: V2CircleParams, memberIndex: number, amount: bigint, walletAddress: string) {
  validate(params);
  if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= params.members.length) throw new Error('Invalid member index');
  if (amount <= 0n || amount > CASH_SCRIPT_INT_MAX) throw new Error('Deposit amount is outside the supported CashScript integer range');
  if (hex(addressToPkh(params.members[memberIndex])) !== hex(addressToPkh(walletAddress))) throw new Error('Connected wallet does not match this member slot.');
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  const state = findState(all, params.stateCategory);
  if (!state) throw new Error('V2 state NFT not found.');
  const receipt = findReceipt(all, params.stateCategory, memberIndex);
  const fee = feeEstimate(3, 3);
  if (fee > params.maxFee) throw new Error('Estimated deposit fee exceeds this circle maxFee.');
  const funding = pickFunding((await provider.getUtxos(walletAddress)).filter(u => !u.token), amount + fee + CHANGE_DUST);
  const change = funding.satoshis - amount - fee;
  const oldCredit = v2CreditFromCommitment(receipt.token!.nft!.commitment);
  if (oldCredit + amount > CASH_SCRIPT_INT_MAX) throw new Error('This deposit would exceed the supported member-credit limit.');
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(receipt, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(funding, placeholderP2PKHUnlocker(walletAddress))
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis + amount, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } } })
    .addOutput({ to: contract.tokenAddress, amount: receipt.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2ReceiptCommitment(memberIndex, oldCredit + amount) } } })
    .addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Add ${amount.toString()} sats to your AjoChain v2 member credit` });
  return { wc, walletInputs: [2], memberIndex, credited: amount, newCredit: oldCredit + amount };
}

/** Anyone can trigger a v2 payout; the covenant controls every output. */
export async function planV2Payout(params: V2CircleParams) {
  validate(params);
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  const state = findState(all, params.stateCategory);
  if (!state) throw new Error('V2 state NFT not found.');
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2), 16);
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) throw new Error('Invalid v2 payout round.');
  const receipts = params.members.map((_, i) => findReceipt(all, params.stateCategory, i));
  for (let i = 0; i < receipts.length; i++) if (v2CreditFromCommitment(receipts[i].token!.nft!.commitment) < params.contribution) throw new Error(`Member ${i + 1} has insufficient credit; payout is blocked.`);
  const pot = BigInt(params.members.length) * params.contribution;
  if (state.satoshis - pot < STATE_DUST) throw new Error('Payout would reduce the state reserve below 1,000 sats.');
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis - pot, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: '53' + ((round + 1) % params.members.length).toString(16).padStart(2, '0') } } });
  receipts.forEach((receipt, i) => {
    const credit = v2CreditFromCommitment(receipt.token!.nft!.commitment);
    builder.addOutput({ to: contract.tokenAddress, amount: receipt.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2ReceiptCommitment(i, credit - params.contribution) } } });
  });
  const payout = pot - params.maxFee;
  builder.addOutput({ to: params.members[round], amount: payout });
  return { builder, round, recipient: params.members[round], payout, fee: params.maxFee };
}


/** Read and validate the complete v2 state before rendering balances or actions. */
export async function readV2Circle(params: V2CircleParams) {
  validate(params);
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const utxos = await contract.getUtxos();
  const state = findState(utxos, params.stateCategory);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2), 16);
  if (round < 0 || round >= params.members.length) throw new Error('Invalid v2 payout round.');
  const receipts = params.members.map((_, index) => findReceipt(utxos, params.stateCategory, index));
  const credits = receipts.map(receipt => v2CreditFromCommitment(receipt.token!.nft!.commitment));
  return {
    contract,
    utxos,
    round,
    stateSatoshis: state.satoshis,
    credits,
    ready: credits.every(credit => credit >= params.contribution),
    recipient: params.members[round],
  };
}
