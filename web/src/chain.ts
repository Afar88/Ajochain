// Live-network helpers: Electrum provider, genesis (start a circle) and contribute
// transactions that the connected WizardConnect wallet signs.
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type SpendableUtxo,
  type Contract,
} from 'cashscript';
import { circleContract, STATE_DUST, encodeRound, type CircleParams, type Net } from '../../src/lib/ajo';

const providers: Partial<Record<Net, ElectrumNetworkProvider>> = {};
export function provider(net: Net): ElectrumNetworkProvider {
  if (!providers[net]) {
    // Optional override, e.g. localStorage.setItem('ajo-electrum-chipnet', 'chipnet.imaginary.cash')
    const host = typeof localStorage !== 'undefined' ? localStorage.getItem(`ajo-electrum-${net}`) : null;
    providers[net] = host ? new ElectrumNetworkProvider(net, { hostname: host }) : new ElectrumNetworkProvider(net);
  }
  return providers[net]!;
}

export function explorerTx(net: Net, txid: string) {
  return net === 'chipnet'
    ? `https://chipnet.imaginary.cash/tx/${txid}`
    : `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
}

/** Rough fee estimate for P2PKH-funded txs (placeholder unlockers are empty when built). */
function estimateFee(nIn: number, nOut: number) {
  return BigInt(10 + nIn * 150 + nOut * 100 + 100);
}

/**
 * Plan the genesis transaction that starts a circle.
 * The state NFT's category = txid of the wallet UTXO spent at input 0, which must be
 * an output with index 0 (CashTokens genesis rule). So the category, and therefore
 * the circle address, is known before anything is signed.
 */
export async function planGenesis(base: Omit<CircleParams, 'stateCategory'>, walletAddress: string) {
  const prov = provider(base.network);
  const utxos = (await prov.getUtxos(walletAddress)).filter((u) => !u.token);
  const genesisUtxo = utxos.find((u) => u.vout === 0 && u.satoshis >= 3000n);
  if (!genesisUtxo) {
    throw new Error('Your wallet needs a coin sitting at output #0 of a transaction (≥3000 sats). Send yourself a small amount (e.g. 0.0001 BCH) to your receive address #0 and try again.');
  }
  const params: CircleParams = { ...base, stateCategory: genesisUtxo.txid };
  const contract = circleContract(params, prov);

  const inputs: SpendableUtxo[] = [genesisUtxo];
  let total = genesisUtxo.satoshis;
  for (const u of utxos) {
    if (total >= STATE_DUST + estimateFee(inputs.length, 2) + 546n) break;
    if (u === genesisUtxo) continue;
    inputs.push(u); total += u.satoshis;
  }
  const fee = estimateFee(inputs.length, 2);
  const change = total - STATE_DUST - fee;
  if (change < 0n) throw new Error('Not enough BCH in wallet to start the circle');

  const b = new TransactionBuilder({ provider: prov });
  for (const u of inputs) b.addInput(u, placeholderP2PKHUnlocker(walletAddress));
  b.addOutput({
    to: contract.tokenAddress,
    amount: STATE_DUST,
    token: { category: genesisUtxo.txid, amount: 0n, nft: { capability: 'mutable', commitment: encodeRound(0) } },
  });
  if (change >= 546n) b.addOutput({ to: walletAddress, amount: change });
  const wc = b.generateWcTransactionObject({ broadcast: true, userPrompt: `Start Ajo circle "${base.name}"` });
  return { params, contract, wc, walletInputs: inputs.map((_, i) => i) };
}

/** Plan a contribution from the connected wallet to the circle address. */
export async function planContribution(params: CircleParams, contract: Contract, walletAddress: string) {
  const prov = provider(params.network);
  const utxos = (await prov.getUtxos(walletAddress)).filter((u) => !u.token)
    .sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1));
  const inputs: SpendableUtxo[] = [];
  let total = 0n;
  for (const u of utxos) {
    if (total >= params.contribution + estimateFee(inputs.length, 2) + 546n) break;
    inputs.push(u); total += u.satoshis;
  }
  const fee = estimateFee(inputs.length, 2);
  const change = total - params.contribution - fee;
  if (change < 0n) throw new Error('Not enough BCH in your wallet for this contribution');
  const b = new TransactionBuilder({ provider: prov });
  for (const u of inputs) b.addInput(u, placeholderP2PKHUnlocker(walletAddress));
  b.addOutput({ to: contract.address, amount: params.contribution });
  if (change >= 546n) b.addOutput({ to: walletAddress, amount: change });
  const wc = b.generateWcTransactionObject({ broadcast: true, userPrompt: `Ajo contribution to "${params.name}"` });
  return { wc, walletInputs: inputs.map((_, i) => i) };
}
