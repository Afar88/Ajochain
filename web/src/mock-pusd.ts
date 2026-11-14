// AjoChain test-only PUSD issuer. Creates a fixed-supply CashToken on Chipnet.
// The token is not official PUSD, has no backing, and cannot be minted again.
import {
  TransactionBuilder, placeholderP2PKHUnlocker,
  type SpendableUtxo,
} from 'cashscript';
import { encodeCashAddress } from '@bitauth/libauth';
import { addressToPkh, type Net } from '../../src/lib/ajo';
import { getProvider } from './chain';

export const MOCK_PUSD_NAME = 'AjoChain Test PUSD';
export const MOCK_PUSD_TICKER = 'tPUSD';
export const MOCK_PUSD_DECIMALS = 6;
export const MOCK_PUSD_SUPPLY = 1_000_000_000n; // 1,000 tPUSD at 6 decimals
export const MOCK_PUSD_STORAGE_KEY = 'ajo-mock-pusd-category';
const TOKEN_DUST = 1_000n;
const CHANGE_DUST = 546n;

function feeEstimate(inputs: number, outputs: number) {
  return BigInt(10 + inputs * 150 + outputs * 100 + 100);
}

function tokenAwareAddress(address: string) {
  const encoded = encodeCashAddress({
    prefix: 'bchtest',
    type: 'p2pkhWithTokens',
    payload: addressToPkh(address),
  });
  if (typeof encoded === 'string') throw new Error('Could not derive a Chipnet token-aware address.');
  return encoded.address;
}

/**
 * Step one: create a normal BCH transaction with the issuer's wallet address
 * as output zero. That output becomes the unique CashToken genesis anchor.
 */
export async function planMockPusdAnchor(walletAddress: string) {
  const provider = await getProvider('chipnet');
  const coins = (await provider.getUtxos(walletAddress))
    .filter(u => !u.token)
    .sort((a, b) => a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0);
  const inputs: SpendableUtxo[] = [];
  let total = 0n;
  for (const coin of coins) {
    inputs.push(coin);
    total += coin.satoshis;
    const fee = feeEstimate(inputs.length, 2);
    if (total >= TOKEN_DUST + fee + CHANGE_DUST) break;
  }
  const fee = feeEstimate(inputs.length, 2);
  const change = total - TOKEN_DUST - fee;
  if (!inputs.length || change < CHANGE_DUST) {
    throw new Error('Fund this Chipnet wallet with test BCH before creating tPUSD.');
  }
  const builder = new TransactionBuilder({ provider });
  inputs.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  // Output zero is intentional: the next transaction uses this outpoint to
  // define the immutable CashToken category ID.
  builder.addOutput({ to: walletAddress, amount: TOKEN_DUST });
  builder.addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: 'Prepare the Chipnet-only tPUSD token genesis anchor',
  });
  return { wc, walletInputs: inputs.map((_, i) => i) };
}

/**
 * Step two: spend anchor vout 0 and issue the entire fixed test supply.
 * CashTokens fungible supply is created at genesis; the NFT minting capability
 * is deliberately omitted, so no future token issuance authority exists.
 */
export async function planMockPusdGenesis(walletAddress: string, anchorTxid: string) {
  if (!/^[0-9a-f]{64}$/i.test(anchorTxid)) throw new Error('Invalid tPUSD genesis anchor transaction ID.');
  const provider = await getProvider('chipnet');
  const coins = await provider.getUtxos(walletAddress);
  const anchor = coins.find(u => u.txid.toLowerCase() === anchorTxid.toLowerCase() && u.vout === 0);
  if (!anchor || anchor.token || anchor.satoshis !== TOKEN_DUST) {
    throw new Error('The genesis anchor is not indexed yet. Wait a few seconds and retry the token issuance step.');
  }
  const feeCoins = coins.filter(u => !u.token && !(u.txid === anchor.txid && u.vout === anchor.vout))
    .sort((a, b) => a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0);
  const inputs: SpendableUtxo[] = [anchor];
  let total = anchor.satoshis;
  for (const coin of feeCoins) {
    inputs.push(coin);
    total += coin.satoshis;
    const fee = feeEstimate(inputs.length, 2);
    if (total >= TOKEN_DUST + fee + CHANGE_DUST) break;
  }
  const fee = feeEstimate(inputs.length, 2);
  const change = total - TOKEN_DUST - fee;
  if (inputs.length < 2 || change < CHANGE_DUST) {
    throw new Error('The token genesis needs the 1,000-sat anchor plus separate Chipnet BCH for its miner fee and change.');
  }
  const category = anchor.txid.toLowerCase();
  const builder = new TransactionBuilder({ provider });
  inputs.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({
    to: tokenAwareAddress(walletAddress),
    amount: TOKEN_DUST,
    token: { category, amount: MOCK_PUSD_SUPPLY },
  });
  builder.addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: 'Issue 1,000 fixed-supply tPUSD on Bitcoin Cash Chipnet (no real value)',
  });
  return { wc, walletInputs: inputs.map((_, i) => i), category, supply: MOCK_PUSD_SUPPLY };
}

export async function verifyMockPusdGenesis(walletAddress: string, category: string): Promise<boolean> {
  const provider = await getProvider('chipnet');
  const utxos = await provider.getUtxos(tokenAwareAddress(walletAddress));
  return utxos.some(u => u.token?.category.toLowerCase() === category.toLowerCase()
    && u.token.amount === MOCK_PUSD_SUPPLY && u.satoshis >= TOKEN_DUST && !u.token.nft);
}

export function saveMockPusdCategory(category: string) {
  if (!/^[0-9a-f]{64}$/i.test(category)) throw new Error('Invalid tPUSD category ID.');
  localStorage.setItem(MOCK_PUSD_STORAGE_KEY, category.toLowerCase());
}

export function getMockPusdCategory(): string | null {
  const value = localStorage.getItem(MOCK_PUSD_STORAGE_KEY);
  return value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}


/** Build a wallet-approved transfer of existing tPUSD. This never mints tokens. */
export async function planMockPusdTransfer(
  walletAddress: string,
  recipientAddress: string,
  category: string,
  amount: bigint,
) {
  if (!/^[0-9a-f]{64}$/i.test(category)) throw new Error('Invalid tPUSD category ID.');
  if (amount <= 0n || amount > MOCK_PUSD_SUPPLY) throw new Error('Enter a positive tPUSD amount within the fixed supply.');
  const provider = await getProvider('chipnet');
  // Validate and convert the recipient to a Chipnet CashTokens address.
  const recipient = tokenAwareAddress(recipientAddress);
  const sender = tokenAwareAddress(walletAddress);
  const tokenCoins = (await provider.getUtxos(sender))
    .filter(u => u.token?.category.toLowerCase() === category.toLowerCase() && !u.token.nft)
    .sort((a, b) => a.token!.amount > b.token!.amount ? -1 : a.token!.amount < b.token!.amount ? 1 : 0);
  const selectedTokens: SpendableUtxo[] = [];
  let selectedAmount = 0n;
  for (const coin of tokenCoins) {
    selectedTokens.push(coin);
    selectedAmount += coin.token!.amount;
    if (selectedAmount >= amount) break;
  }
  if (selectedAmount < amount) throw new Error('The connected wallet does not hold enough tPUSD for this transfer.');
  const tokenChange = selectedAmount - amount;
  const tokenOutputCount = tokenChange > 0n ? 2 : 1;
  const feeCoins = (await provider.getUtxos(walletAddress))
    .filter(u => !u.token && !selectedTokens.some(t => t.txid === u.txid && t.vout === u.vout))
    .sort((a, b) => a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0);
  const feeInputs: SpendableUtxo[] = [];
  let feeTotal = 0n;
  for (const coin of feeCoins) {
    feeInputs.push(coin);
    feeTotal += coin.satoshis;
    const fee = feeEstimate(selectedTokens.length + feeInputs.length, tokenOutputCount + 1);
    if (feeTotal >= fee + CHANGE_DUST) break;
  }
  const fee = feeEstimate(selectedTokens.length + feeInputs.length, tokenOutputCount + 1);
  const bchChange = feeTotal - fee;
  if (!feeInputs.length || bchChange < CHANGE_DUST) {
    throw new Error('The issuer wallet needs separate Chipnet BCH UTXOs to pay the transfer miner fee.');
  }
  const builder = new TransactionBuilder({ provider });
  selectedTokens.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  feeInputs.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({
    to: recipient,
    amount: TOKEN_DUST,
    token: { category: category.toLowerCase(), amount },
  });
  if (tokenChange > 0n) {
    builder.addOutput({
      to: sender,
      amount: TOKEN_DUST,
      token: { category: category.toLowerCase(), amount: tokenChange },
    });
  }
  builder.addOutput({ to: walletAddress, amount: bchChange });
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: `Send ${amount.toString()} tPUSD on Chipnet (existing supply only)`,
  });
  return { wc, walletInputs: selectedTokens.concat(feeInputs).map((_, i) => i), amount, tokenChange };
}
